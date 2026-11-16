import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assessGoalRows, assessGoalTaggerFiles, main, type AssessmentPaths, type GoalTaggerCriteria } from '../scripts/ads-training/assess-goal-tagger.js';
import { goalToPointer } from '../scripts/ads-training/pointer.js';
import { type Goal } from '../scripts/ads-training/goal.js';

const threshold = { languages: ['en', 'ar'], minimumIndependentCasesPerLanguage: 1, minimumRawExactAccuracy: 0.95, minimumAcceptedPrecision: 0.99 };
const acceptance = { method: 'minimum_decision_probability_v1' as const, thresholds: { en: 0.9, ar: 0.8 },
  calibrationSha256: '1'.repeat(64) };
const goal = (value: Partial<Goal> = {}): Goal => ({ intent: 'create_campaign', url: null, service: null, locations: [], budget: null, goal: null, ...value });
function example(id: string, language: string, message: string, expected = goal(), category = 'plain') {
  return { id, language, category, source: 'independent_machine_authored', capability: 'ads.goal.v2', split: 'test_independent',
    trainingAllowed: false, input: { message }, expected, output: expected };
}
const examples = () => [example('en1', 'en', 'Create a Google Ads campaign.'), example('ar1', 'ar', 'أريد حملة إعلانية جديدة.')];
const predictions = (rows: ReturnType<typeof examples>) => rows.map(row => ({ id: row.id, language: row.language, category: row.category,
  source: row.source, capability: row.capability, split: 'goal_independent', input: row.input, expected: row.expected,
  answer_text: goalToPointer(row.input.message, row.expected)!, finished: true }));
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'goal-tagger-assessment-'));
  directories.push(directory);
  const paths: AssessmentPaths = Object.fromEntries(['criteria', 'dataset', 'answers', 'provenance', 'checkpoint'].map(name =>
    [name, join(directory, name + (['dataset', 'answers'].includes(name) ? '.jsonl' : name === 'checkpoint' ? '.pt' : '.json'))])) as unknown as AssessmentPaths;
  const rows = examples();
  writeFileSync(paths.dataset, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  writeFileSync(paths.answers, predictions(rows).map(row => JSON.stringify(row)).join('\n') + '\n');
  writeFileSync(paths.checkpoint, 'dummy checkpoint bytes: no model execution');
  const sourceFiles = ['scripts/ads-training/goal.ts', 'scripts/ads-training/pointer.ts', 'scripts/ads-training/assess-goal-tagger.ts',
    'docs/ADS-GOAL-LABELING-GUIDE.md', 'packages/execution-pipeline/execution_pipeline/goal_tagger.py'].map(path => ({ path, sha256: hash(readFileSync(path)) }));
  const criteria: GoalTaggerCriteria = { schemaVersion: 1, id: 'test-frozen', scope: 'ads.goal.v2', frozenAt: '2020-01-01T00:00:00Z',
    frozenBeforePredictions: true, ...threshold, datasetSha256: hash(readFileSync(paths.dataset)), checkpointSha256: hash(readFileSync(paths.checkpoint)), sourceFiles };
  const provenance = { schemaVersion: 1, checkpointSha256Before: criteria.checkpointSha256, checkpointSha256After: criteria.checkpointSha256,
    datasetSha256: criteria.datasetSha256, answersSha256: hash(readFileSync(paths.answers)), criteriaSha256: '',
    predictionsStartedAt: '2020-01-01T00:01:00Z', predictionsFinishedAt: '2020-01-01T00:02:00Z' };
  const freeze = () => {
    writeFileSync(paths.criteria, JSON.stringify(criteria));
    provenance.criteriaSha256 = hash(readFileSync(paths.criteria));
    writeFileSync(paths.criteria.replace('.json', '.sha256'), provenance.criteriaSha256);
    writeFileSync(paths.provenance, JSON.stringify(provenance));
  };
  freeze();
  return { directory, paths, criteria, provenance, freeze };
}

function calibratedFixture() {
  const test = fixture(), calibrationPath = join(test.directory, 'calibration.json');
  const calibration = { schemaVersion: 1, method: acceptance.method, thresholds: { ...acceptance.thresholds },
    calibratedAt: '2019-12-31T23:00:00Z', usesFinalTest: false, datasetSha256: '2'.repeat(64),
    checkpointSha256: test.criteria.checkpointSha256 };
  const answers = predictions(examples()).map(answer => ({ ...answer, confidence: 0.99, confidenceMethod: acceptance.method }));
  writeFileSync(test.paths.answers, answers.map(answer => JSON.stringify(answer)).join('\n') + '\n');
  test.provenance.answersSha256 = hash(readFileSync(test.paths.answers));
  const freezeCalibration = () => {
    writeFileSync(calibrationPath, JSON.stringify(calibration));
    const sha256 = hash(readFileSync(calibrationPath));
    test.criteria.sourceFiles = test.criteria.sourceFiles.filter(source => source.path !== calibrationPath);
    test.criteria.sourceFiles.push({ path: calibrationPath, sha256 });
    test.criteria.acceptance = { ...acceptance, calibrationSha256: sha256 };
    test.freeze();
  };
  freezeCalibration();
  return { ...test, calibration, calibrationPath, freezeCalibration };
}

describe('goal tagger assessment', () => {
  it('accepts bound perfect answers per language and reports extraction scope only', () => {
    const { paths } = fixture();
    const report = assessGoalTaggerFiles(paths);
    expect(report.status).toBe('passed');
    expect(report.meetsGoalExtractionCriteria).toBe(true);
    expect(report.productionReady).toBe(false);
    expect(report.metrics?.byLanguage.ar?.rawExactAccuracy).toBe(1);
    expect(report.metrics?.byLanguage.en?.acceptedPrecision).toBe(1);
    expect(report.integrity.checkpointSha256AtAssessmentEnd).toBe(report.integrity.checkpointSha256);
  });

  it('retains incomplete and malformed answers in every field denominator', () => {
    const rows = [examples()[0]!, example('en2', 'en', 'Please create a new campaign.'), example('en3', 'en', 'Make new Google ads.'), examples()[1]!];
    const answers = predictions(rows);
    answers[1]!.finished = false;
    answers[2]!.answer_text = 'invalid pointer';
    const report = assessGoalRows(rows, answers, threshold);
    expect(report.status).toBe('failed');
    const en = report.metrics!.byLanguage.en!;
    expect(en.rows).toBe(3);
    expect(en.incomplete).toBe(1);
    expect(en.rawMalformed).toBe(1);
    expect(en.rawExactAccuracy).toBe(1 / 3);
    expect(en.fields.raw.intent).toEqual({ correct: 1, total: 3, accuracy: 1 / 3 });
    expect(en.acceptedPrecision).toBe(1);
  });

  it('reports raw, frozen repair, and incorrectly accepted answers separately', () => {
    const rows = [example('en1', 'en', 'Create ads for example.com.', goal({ url: 'example.com' }), 'missing_url'), examples()[1]!];
    const answers = predictions(rows);
    answers[0]!.answer_text = 'intent create_campaign';
    const report = assessGoalRows(rows, answers, threshold);
    expect(report.metrics!.byLanguage.en!.rawExact).toBe(0);
    expect(report.metrics!.byLanguage.en!.repairedExact).toBe(1);
    expect(report.status).toBe('failed');
    expect(report.metrics!.byCategory.missing_url!.fields.raw.url.accuracy).toBe(0);
    const omitted = [example('en1', 'en', 'Create ads for pottery workshop.', goal({ service: 'pottery workshop' })), examples()[1]!];
    const wrong = predictions(omitted);
    wrong[0]!.answer_text = 'intent create_campaign';
    expect(assessGoalRows(omitted, wrong, threshold).metrics!.byLanguage.en!.acceptedWrong).toBe(1);
  });

  it('does not use later candidates to rescue a wrong designated answer', () => {
    const rows = examples(), answers = predictions(rows);
    const enhanced = answers.map(answer => ({ ...answer, candidates: [{ text: answer.answer_text }], answer_text: 'malformed' }));
    expect(assessGoalRows(rows, enhanced, threshold).metrics!.overall.rawExact).toBe(0);
  });

  it.each(['input', 'expected', 'language', 'category', 'capability', 'source'])('rejects altered %s prediction metadata', field => {
    const rows = examples(), answers: Record<string, unknown>[] = predictions(rows);
    answers[0]![field] = field === 'input' ? { message: 'Different request' } : field === 'expected' ? goal({ intent: 'other' }) : 'different';
    const report = assessGoalRows(rows, answers, threshold);
    expect(report.status).toBe('unverifiable');
    expect(report.metrics).toBeNull();
    expect(report.inputIntegrity.issues).toContain('answers:metadata_mismatch:en1');
  });

  it('detects duplicate, missing and unexpected prediction IDs without inflating the score', () => {
    const rows = examples(), answers = predictions(rows);
    const report = assessGoalRows(rows, [answers[0], answers[0], { ...answers[1], id: 'unknown' }], threshold);
    expect(report.inputIntegrity.issues).toEqual(expect.arrayContaining(['answers:duplicate_id:en1', 'answers:missing_id:ar1', 'answers:unexpected_id:unknown']));
    expect(report.metrics).toBeNull();
  });

  it('rejects duplicate source IDs/messages and contradictory source labels', () => {
    const rows = examples();
    const report = assessGoalRows([...rows, rows[0]!, { ...rows[1]!, id: 'other', output: goal({ intent: 'other' }) }], predictions(rows), threshold);
    expect(report.inputIntegrity.issues).toEqual(expect.arrayContaining(['dataset:duplicate_id:en1', 'dataset:duplicate_message:en1', 'dataset:invalid_expected:other']));
  });

  it('fails the minimum independent case count even with perfect predictions', () => {
    const rows = examples();
    expect(assessGoalRows(rows, predictions(rows), { ...threshold, minimumIndependentCasesPerLanguage: 100 }).failures)
      .toEqual(expect.arrayContaining(['ar:too_few_independent_cases', 'en:too_few_independent_cases']));
  });

  it('uses confidence only for acceptance and preserves raw errors and field denominators', () => {
    const rows = [
      example('en1', 'en', 'Create a campaign for violin tuition.', goal({ service: 'violin tuition' })),
      example('en2', 'en', 'Advertise custom lamps.', goal({ service: 'custom lamps' })),
      example('en3', 'en', 'Create a fresh campaign.'),
      examples()[1]!,
    ];
    const answers = predictions(rows).map(answer => ({ ...answer, confidence: 0.99, confidenceMethod: acceptance.method }));
    answers[0]!.confidence = 0.2; // A correct prediction can be refused.
    answers[1]!.answer_text = 'intent create_campaign'; // A confidently omitted service stays wrong.
    answers[2]!.confidence = acceptance.thresholds.en; // The boundary is accepted.
    const ungated = assessGoalRows(rows, answers, threshold);
    const gated = assessGoalRows(rows, answers, { ...threshold, acceptance });
    const before = ungated.metrics!.byLanguage.en!, after = gated.metrics!.byLanguage.en!;
    expect(after.rawExactAccuracy).toBe(2 / 3);
    expect(after.rawExact).toBe(before.rawExact);
    expect(after.repairedExact).toBe(before.repairedExact);
    expect(after.fields).toEqual(before.fields);
    expect(after.accepted).toBe(2);
    expect(after.acceptedCorrect).toBe(1);
    expect(after.acceptedWrong).toBe(1);
    expect(after.acceptedPrecision).toBe(0.5);
    expect(after.refusalReasons).toEqual({ LOW_CONFIDENCE: 1 });
    expect(gated.failures).toContain('en:accepted_precision_below_threshold');
  });

  it.each([undefined, null, '0.99', -0.1, 1.01, NaN, Infinity])('refuses invalid or missing confidence %s without changing exactness', confidence => {
    const rows = examples();
    const answers = predictions(rows).map(answer => ({ ...answer, confidence, confidenceMethod: acceptance.method }));
    const report = assessGoalRows(rows, answers, { ...threshold, acceptance });
    expect(report.metrics!.overall.rawExactAccuracy).toBe(1);
    expect(report.metrics!.overall.repairedExactAccuracy).toBe(1);
    expect(report.metrics!.overall.accepted).toBe(0);
    expect(report.metrics!.overall.acceptedPrecision).toBeNull();
    expect(report.metrics!.overall.refusalReasons).toEqual({ INVALID_CONFIDENCE: 2 });
  });

  it.each([undefined, 'another_method'])('refuses confidence from unbound method %s', confidenceMethod => {
    const rows = examples();
    const answers = predictions(rows).map(answer => ({ ...answer, confidence: 1, confidenceMethod }));
    const report = assessGoalRows(rows, answers, { ...threshold, acceptance });
    expect(report.metrics!.overall.accepted).toBe(0);
    expect(report.metrics!.overall.refusalReasons).toEqual({ INVALID_CONFIDENCE: 2 });
  });

  it('applies each language threshold independently', () => {
    const rows = examples();
    const answers = predictions(rows).map(answer => ({ ...answer, confidence: 0.85, confidenceMethod: acceptance.method }));
    const report = assessGoalRows(rows, answers, { ...threshold, acceptance });
    expect(report.metrics!.byLanguage.en!.accepted).toBe(0);
    expect(report.metrics!.byLanguage.ar!.accepted).toBe(1);
    expect(report.metrics!.byLanguage.en!.rawExactAccuracy).toBe(1);
    expect(report.metrics!.byLanguage.ar!.rawExactAccuracy).toBe(1);
  });

  it('fails perfect accepted precision when coverage or accepted case count is insufficient', () => {
    const rows = [examples()[0]!, example('en2', 'en', 'Launch a new campaign.'), examples()[1]!];
    const answers = predictions(rows).map(answer => ({ ...answer, confidence: 0.99, confidenceMethod: acceptance.method }));
    answers[1]!.confidence = 0.1;
    const report = assessGoalRows(rows, answers, { ...threshold, acceptance,
      minimumAcceptedCoverage: 0.8, minimumAcceptedCasesPerLanguage: 2 });
    expect(report.metrics!.byLanguage.en!.acceptedPrecision).toBe(1);
    expect(report.metrics!.byLanguage.en!.acceptedCoverage).toBe(0.5);
    expect(report.metrics!.byLanguage.ar!.acceptedCoverage).toBe(1);
    expect(report.failures).toEqual(expect.arrayContaining([
      'en:accepted_coverage_below_threshold', 'en:too_few_accepted_cases', 'ar:too_few_accepted_cases',
    ]));
    expect(report.failures).not.toContain('ar:accepted_coverage_below_threshold');
    expect(report.status).toBe('failed');
  });

  it.each(['dataset', 'answers', 'checkpoint'] as const)('rejects changed %s bytes despite otherwise perfect predictions', name => {
    const { paths } = fixture();
    writeFileSync(paths[name], readFileSync(paths[name]).toString('utf8') + '\n');
    const report = assessGoalTaggerFiles(paths);
    expect(report.status).toBe('unverifiable');
    expect(report.metrics).toBeNull();
    expect(report.meetsGoalExtractionCriteria).toBe(false);
  });

  it('rejects a criteria digest mismatch and missing frozen inference source', () => {
    const test = fixture();
    writeFileSync(test.paths.criteria.replace('.json', '.sha256'), '0'.repeat(64));
    expect(assessGoalTaggerFiles(test.paths).inputIntegrity.issues).toContain('criteria:digest_mismatch');
    test.criteria.sourceFiles = test.criteria.sourceFiles.filter(source => !source.path.endsWith('goal_tagger.py'));
    test.freeze();
    expect(assessGoalTaggerFiles(test.paths).status).toBe('unverifiable');
  });

  it('rejects source changes and inconsistent checkpoint provenance', () => {
    const test = fixture();
    test.criteria.sourceFiles[0]!.sha256 = '0'.repeat(64);
    test.provenance.checkpointSha256After = '0'.repeat(64);
    test.freeze();
    expect(assessGoalTaggerFiles(test.paths).inputIntegrity.issues).toEqual(expect.arrayContaining([
      'source:hash_mismatch:scripts/ads-training/goal.ts', 'provenance:checkpointSha256After_mismatch',
    ]));
  });

  it('accepts an earlier development calibration bound to the checkpoint and frozen source bytes', () => {
    const test = calibratedFixture();
    const report = assessGoalTaggerFiles(test.paths);
    expect(report.status).toBe('passed');
    expect(report.integrity.files[test.calibrationPath]).toBe(test.criteria.acceptance!.calibrationSha256);
  });

  it('requires the calibration report in the frozen source manifest', () => {
    const test = calibratedFixture();
    test.criteria.sourceFiles = test.criteria.sourceFiles.filter(source => source.path !== test.calibrationPath);
    test.freeze();
    const report = assessGoalTaggerFiles(test.paths);
    expect(report.status).toBe('unverifiable');
    expect(report.inputIntegrity.issues).toContain('acceptance:missing_frozen_calibration');
  });

  it.each(['thresholds', 'checkpoint', 'final_test', 'same_dataset', 'late_calibration'] as const)(
    'refuses correctly hashed calibration with inconsistent %s provenance', mismatch => {
      const test = calibratedFixture();
      if (mismatch === 'thresholds') test.calibration.thresholds.en = 0.95;
      if (mismatch === 'checkpoint') test.calibration.checkpointSha256 = '3'.repeat(64);
      if (mismatch === 'final_test') test.calibration.usesFinalTest = true;
      if (mismatch === 'same_dataset') test.calibration.datasetSha256 = test.criteria.datasetSha256;
      if (mismatch === 'late_calibration') test.calibration.calibratedAt = '2020-01-01T00:00:01Z';
      test.freezeCalibration();
      const report = assessGoalTaggerFiles(test.paths);
      expect(report.status).toBe('unverifiable');
      expect(report.metrics).toBeNull();
      expect(report.inputIntegrity.issues).toContain('acceptance:calibration_mismatch');
    },
  );

  it('rejects predictions begun before criteria were frozen', () => {
    const test = fixture();
    test.provenance.predictionsStartedAt = '2019-12-31T23:59:59Z';
    test.freeze();
    expect(assessGoalTaggerFiles(test.paths).inputIntegrity.issues).toContain('provenance:invalid_prediction_timeline');
  });

  it('writes an immutable CLI report and refuses overwriting it', () => {
    const { paths, directory } = fixture(), output = join(directory, 'report.json');
    const args = Object.entries({ ...paths, output }).flatMap(([name, value]) => [`--${name}`, value]);
    expect(main(args).status).toBe('passed');
    expect(() => main(args)).toThrow(/EEXIST/);
  });
});
