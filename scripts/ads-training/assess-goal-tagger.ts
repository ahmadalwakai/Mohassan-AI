/** Frozen, goal-only assessment. Reads predictions; never runs a model or selects candidates. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkGoal, compareGoal, type Goal } from './goal.js';
import { goalToPointer, pointerToGoal, repairGoalPointer } from './pointer.js';

type ObjectValue = Record<string, unknown>;
export interface GoalTaggerCriteria {
  schemaVersion: 1; id: string; frozenAt: string; frozenBeforePredictions: true;
  languages: string[]; minimumIndependentCasesPerLanguage: number;
  minimumRawExactAccuracy: number; minimumAcceptedPrecision: number;
  datasetSha256: string; checkpointSha256: string;
  sourceFiles: { path: string; sha256: string }[]; scope: 'ads.goal.v2';
  minimumAcceptedCoverage?: number;
  minimumAcceptedCasesPerLanguage?: number;
  acceptance?: { method: 'minimum_decision_probability_v1'; thresholds: Record<string, number>; calibrationSha256: string };
}
export interface AssessmentPaths {
  criteria: string; dataset: string; answers: string; provenance: string; checkpoint: string;
}
const FIELDS = ['intent', 'url', 'service', 'locations', 'budget', 'goal'] as const;
const REQUIRED_SOURCES = [
  'scripts/ads-training/goal.ts', 'scripts/ads-training/pointer.ts',
  'scripts/ads-training/assess-goal-tagger.ts', 'docs/ADS-GOAL-LABELING-GUIDE.md',
  'packages/execution-pipeline/execution_pipeline/goal_tagger.py',
];
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const canonical = (value: unknown): string => JSON.stringify(Array.isArray(value) ? value.map(item => JSON.parse(canonical(item)))
  : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonical(value[key]))])) : value) ?? 'null';
const ratio = (count: number, total: number) => total ? count / total : null;
const timestamp = (value: unknown) => typeof value === 'string' ? Date.parse(value) : NaN;
const expectedGoal = (row: ObjectValue) => row.expected ?? row.output;

function criteriaIssues(value: unknown): string[] {
  if (!object(value)) return ['criteria:not_an_object'];
  const issues: string[] = [];
  if (value.schemaVersion !== 1 || value.scope !== 'ads.goal.v2' || value.frozenBeforePredictions !== true
    || typeof value.id !== 'string' || !value.id || !Number.isFinite(timestamp(value.frozenAt))) issues.push('criteria:invalid_identity_or_freeze');
  if (!Array.isArray(value.languages) || !value.languages.length || value.languages.some(language => typeof language !== 'string' || !language)
    || new Set(value.languages).size !== value.languages.length) issues.push('criteria:invalid_languages');
  if (!Number.isInteger(value.minimumIndependentCasesPerLanguage) || Number(value.minimumIndependentCasesPerLanguage) < 1) issues.push('criteria:invalid_minimum_rows');
  for (const field of ['minimumRawExactAccuracy', 'minimumAcceptedPrecision']) {
    if (typeof value[field] !== 'number' || !Number.isFinite(value[field]) || value[field] <= 0 || value[field] > 1) issues.push(`criteria:invalid_${field}`);
  }
  if (value.minimumAcceptedCoverage !== undefined && (typeof value.minimumAcceptedCoverage !== 'number'
    || !Number.isFinite(value.minimumAcceptedCoverage) || value.minimumAcceptedCoverage <= 0 || value.minimumAcceptedCoverage > 1)) issues.push('criteria:invalid_minimumAcceptedCoverage');
  if (value.minimumAcceptedCasesPerLanguage !== undefined && (!Number.isInteger(value.minimumAcceptedCasesPerLanguage)
    || Number(value.minimumAcceptedCasesPerLanguage) < 1)) issues.push('criteria:invalid_minimumAcceptedCasesPerLanguage');
  if (value.acceptance !== undefined) {
    const policy = value.acceptance;
    if (!object(policy) || policy.method !== 'minimum_decision_probability_v1' || !digest(policy.calibrationSha256)
      || !object(policy.thresholds) || !Array.isArray(value.languages)
      || value.languages.some(language => typeof language !== 'string' || !object(policy.thresholds)
        || typeof policy.thresholds[language] !== 'number' || !Number.isFinite(policy.thresholds[language])
        || Number(policy.thresholds[language]) < 0 || Number(policy.thresholds[language]) > 1)) issues.push('criteria:invalid_acceptance');
  }
  if (!digest(value.datasetSha256) || !digest(value.checkpointSha256)) issues.push('criteria:invalid_input_hashes');
  if (!Array.isArray(value.sourceFiles) || value.sourceFiles.some(source => !object(source) || typeof source.path !== 'string' || !source.path || !digest(source.sha256))) {
    issues.push('criteria:invalid_source_hashes');
  } else {
    const paths = value.sourceFiles.map(source => resolve((source as { path: string }).path));
    if (new Set(paths).size !== paths.length) issues.push('criteria:duplicate_source_paths');
    for (const path of REQUIRED_SOURCES) if (!paths.includes(resolve(path))) issues.push(`criteria:missing_source:${path}`);
  }
  return issues;
}

interface BoundRow { id: string; language: string; category: string; message: string; expected: Goal; answer: string; finished: boolean; confidence: unknown; confidenceMethod: unknown }
function bindRows(dataset: unknown[], answers: unknown[], languages: string[]) {
  const issues: string[] = [], source = new Map<string, ObjectValue>(), predictions = new Map<string, ObjectValue>();
  const messages = new Set<string>();
  dataset.forEach((item, index) => {
    if (!object(item) || typeof item.id !== 'string' || !item.id) { issues.push(`dataset:invalid_id:${index}`); return; }
    if (source.has(item.id)) issues.push(`dataset:duplicate_id:${item.id}`);
    source.set(item.id, item);
    if (item.capability !== 'ads.goal.v2' || item.split !== 'test_independent' || item.trainingAllowed !== false
      || typeof item.language !== 'string' || !languages.includes(item.language)
      || typeof item.category !== 'string' || !item.category || !object(item.input) || typeof item.input.message !== 'string') {
      issues.push(`dataset:invalid_metadata:${item.id}`); return;
    }
    if (messages.has(item.input.message)) issues.push(`dataset:duplicate_message:${item.id}`);
    messages.add(item.input.message);
    const expected = expectedGoal(item);
    if (!object(expected) || FIELDS.some(field => !Object.hasOwn(expected, field))
      || (item.expected !== undefined && item.output !== undefined && canonical(item.expected) !== canonical(item.output))) {
      issues.push(`dataset:invalid_expected:${item.id}`); return;
    }
    try {
      if (checkGoal(item.input.message, expected).length || goalToPointer(item.input.message, expected as unknown as Goal) === null) issues.push(`dataset:invalid_label:${item.id}`);
    } catch { issues.push(`dataset:invalid_label:${item.id}`); }
  });
  answers.forEach((item, index) => {
    if (!object(item) || typeof item.id !== 'string' || !item.id) { issues.push(`answers:invalid_id:${index}`); return; }
    if (predictions.has(item.id)) issues.push(`answers:duplicate_id:${item.id}`);
    predictions.set(item.id, item);
    if (!source.has(item.id)) issues.push(`answers:unexpected_id:${item.id}`);
  });
  const rows: BoundRow[] = [];
  for (const [id, original] of source) {
    const answer = predictions.get(id);
    if (!answer) { issues.push(`answers:missing_id:${id}`); continue; }
    if (answer.capability !== original.capability || answer.language !== original.language || answer.category !== original.category
      || (original.source !== undefined && answer.source !== original.source)
      || canonical(answer.input) !== canonical(original.input) || canonical(answer.expected) !== canonical(expectedGoal(original))) issues.push(`answers:metadata_mismatch:${id}`);
    if (typeof answer.answer_text !== 'string' || typeof answer.finished !== 'boolean') issues.push(`answers:invalid_prediction:${id}`);
    if (object(original.input) && typeof original.input.message === 'string' && object(expectedGoal(original))) {
      rows.push({ id, language: String(original.language), category: String(original.category), message: original.input.message,
        expected: expectedGoal(original) as unknown as Goal, answer: typeof answer.answer_text === 'string' ? answer.answer_text : '', finished: answer.finished === true,
        confidence: answer.confidence, confidenceMethod: answer.confidenceMethod });
    }
  }
  return { issues, rows };
}

function metrics(rows: BoundRow[], acceptance?: GoalTaggerCriteria['acceptance']) {
  let rawExact = 0, repairedExact = 0, accepted = 0, acceptedCorrect = 0, incomplete = 0, rawMalformed = 0, repairedMalformed = 0;
  const rawFields = Object.fromEntries(FIELDS.map(field => [field, 0])) as Record<typeof FIELDS[number], number>;
  const repairedFields = { ...rawFields }, refusalReasons: Record<string, number> = {};
  const refuse = (reason: string) => { refusalReasons[reason] = (refusalReasons[reason] ?? 0) + 1; };
  for (const row of rows) {
    if (!row.finished) { incomplete++; refuse('INCOMPLETE'); continue; }
    // The existing, frozen repair sees only the input and prediction, never the expected label.
    const raw = pointerToGoal(row.message, row.answer);
    const repaired = pointerToGoal(row.message, repairGoalPointer(row.message, row.answer));
    if (!raw) rawMalformed++;
    if (!repaired) repairedMalformed++;
    const rawComparison = raw ? compareGoal(row.expected, raw) : null;
    const repairedComparison = repaired ? compareGoal(row.expected, repaired) : null;
    if (rawComparison?.exact) rawExact++;
    if (repairedComparison?.exact) repairedExact++;
    for (const field of FIELDS) {
      if (rawComparison?.fields[field]) rawFields[field]++;
      if (repairedComparison?.fields[field]) repairedFields[field]++;
    }
    const issues = repaired ? checkGoal(row.message, repaired) : ['BAD_POINTER_OR_JSON'];
    if (acceptance) {
      if (row.confidenceMethod !== acceptance.method || typeof row.confidence !== 'number'
        || !Number.isFinite(row.confidence) || row.confidence < 0 || row.confidence > 1) issues.push('INVALID_CONFIDENCE');
      else if (row.confidence < acceptance.thresholds[row.language]!) issues.push('LOW_CONFIDENCE');
    }
    if (!issues.length) { accepted++; if (repairedComparison?.exact) acceptedCorrect++; }
    else issues.forEach(refuse);
  }
  const fieldReport = (fields: typeof rawFields) => Object.fromEntries(FIELDS.map(field => [field, { correct: fields[field], total: rows.length, accuracy: ratio(fields[field], rows.length) }]));
  return { rows: rows.length, rawExact, rawExactAccuracy: ratio(rawExact, rows.length), repairedExact, repairedExactAccuracy: ratio(repairedExact, rows.length),
    accepted, acceptedCorrect, acceptedWrong: accepted - acceptedCorrect, acceptedCoverage: ratio(accepted, rows.length), acceptedPrecision: ratio(acceptedCorrect, accepted),
    incomplete, rawMalformed, repairedMalformed, refusalReasons, fields: { raw: fieldReport(rawFields), repaired: fieldReport(repairedFields) } };
}

/** Pure scoring with exact metadata binding; malformed or incomplete answers stay in the denominator. */
export function assessGoalRows(dataset: unknown[], answers: unknown[], criteria: Pick<GoalTaggerCriteria,
  'languages' | 'minimumIndependentCasesPerLanguage' | 'minimumRawExactAccuracy' | 'minimumAcceptedPrecision'
  | 'minimumAcceptedCoverage' | 'minimumAcceptedCasesPerLanguage' | 'acceptance'>) {
  const bound = bindRows(dataset, answers, criteria.languages);
  if (bound.issues.length) return { status: 'unverifiable' as const, inputIntegrity: { status: 'failed', issues: bound.issues }, failures: [] as string[], metrics: null };
  const byLanguage = Object.fromEntries(criteria.languages.map(language => [language, metrics(bound.rows.filter(row => row.language === language), criteria.acceptance)]));
  const categories = [...new Set(bound.rows.map(row => row.category))].sort();
  const byCategory = Object.fromEntries(categories.map(category => [category, metrics(bound.rows.filter(row => row.category === category), criteria.acceptance)]));
  const byLanguageAndCategory = Object.fromEntries(criteria.languages.map(language => [language,
    Object.fromEntries(categories.map(category => [category, metrics(bound.rows.filter(row => row.language === language && row.category === category), criteria.acceptance)]))]));
  const failures: string[] = [];
  for (const [language, result] of Object.entries(byLanguage)) {
    if (result.rows < criteria.minimumIndependentCasesPerLanguage) failures.push(`${language}:too_few_independent_cases`);
    if (result.rawExactAccuracy === null || result.rawExactAccuracy < criteria.minimumRawExactAccuracy) failures.push(`${language}:raw_exact_below_threshold`);
    if (result.acceptedPrecision === null || result.acceptedPrecision < criteria.minimumAcceptedPrecision) failures.push(`${language}:accepted_precision_below_threshold`);
    if (criteria.minimumAcceptedCoverage !== undefined && (result.acceptedCoverage === null || result.acceptedCoverage < criteria.minimumAcceptedCoverage)) failures.push(`${language}:accepted_coverage_below_threshold`);
    if (criteria.minimumAcceptedCasesPerLanguage !== undefined && result.accepted < criteria.minimumAcceptedCasesPerLanguage) failures.push(`${language}:too_few_accepted_cases`);
  }
  return { status: failures.length ? 'failed' as const : 'passed' as const, inputIntegrity: { status: 'passed', issues: [] as string[] }, failures,
    metrics: { overall: metrics(bound.rows, criteria.acceptance), byLanguage, byCategory, byLanguageAndCategory } };
}

/** Read and hash every input, including checkpoint and frozen code, before and after scoring. */
export function assessGoalTaggerFiles(paths: AssessmentPaths) {
  const snapshots = new Map<string, string>(), issues: string[] = [];
  const read = (path: string) => { const bytes = readFileSync(path); snapshots.set(resolve(path), sha(bytes)); return bytes; };
  const criteriaBytes = read(paths.criteria), rawCriteria: unknown = JSON.parse(criteriaBytes.toString('utf8'));
  issues.push(...criteriaIssues(rawCriteria));
  const criteriaDigestPath = paths.criteria.replace(/\.json$/i, '.sha256');
  if (criteriaDigestPath === paths.criteria) issues.push('criteria:json_extension_required');
  else if (read(criteriaDigestPath).toString('utf8').trim() !== sha(criteriaBytes)) issues.push('criteria:digest_mismatch');
  const datasetBytes = read(paths.dataset), answerBytes = read(paths.answers), checkpointBytes = read(paths.checkpoint);
  const provenance: unknown = JSON.parse(read(paths.provenance).toString('utf8'));
  const actual = { criteriaSha256: sha(criteriaBytes), datasetSha256: sha(datasetBytes), answersSha256: sha(answerBytes), checkpointSha256: sha(checkpointBytes) };
  const validCriteria = criteriaIssues(rawCriteria).length === 0;
  if (validCriteria) {
    const criteria = rawCriteria as unknown as GoalTaggerCriteria;
    if (actual.datasetSha256 !== criteria.datasetSha256) issues.push('dataset:frozen_hash_mismatch');
    if (actual.checkpointSha256 !== criteria.checkpointSha256) issues.push('checkpoint:frozen_hash_mismatch');
    for (const source of criteria.sourceFiles) if (sha(read(source.path)) !== source.sha256) issues.push(`source:hash_mismatch:${source.path}`);
    if (criteria.acceptance) {
      const source = criteria.sourceFiles.find(file => file.sha256 === criteria.acceptance!.calibrationSha256);
      if (!source) issues.push('acceptance:missing_frozen_calibration');
      else {
        try {
          const calibration = JSON.parse(read(source.path).toString('utf8'));
          if (calibration.method !== criteria.acceptance.method || canonical(calibration.thresholds) !== canonical(criteria.acceptance.thresholds)
            || calibration.checkpointSha256 !== criteria.checkpointSha256 || calibration.usesFinalTest !== false
            || calibration.datasetSha256 === criteria.datasetSha256 || !digest(calibration.datasetSha256)
            || !Number.isFinite(timestamp(calibration.calibratedAt)) || timestamp(calibration.calibratedAt) > timestamp(criteria.frozenAt)) {
            issues.push('acceptance:calibration_mismatch');
          }
        } catch { issues.push('acceptance:invalid_calibration'); }
      }
    }
    if (!object(provenance) || provenance.schemaVersion !== 1) issues.push('provenance:invalid_schema');
    else {
      for (const key of ['criteriaSha256', 'datasetSha256', 'answersSha256'] as const) if (provenance[key] !== actual[key]) issues.push(`provenance:${key}_mismatch`);
      for (const key of ['checkpointSha256Before', 'checkpointSha256After']) if (provenance[key] !== actual.checkpointSha256) issues.push(`provenance:${key}_mismatch`);
      const start = timestamp(provenance.predictionsStartedAt), finish = timestamp(provenance.predictionsFinishedAt), frozen = timestamp(criteria.frozenAt);
      if (!Number.isFinite(start) || !Number.isFinite(finish) || frozen > start || start > finish || finish > Date.now()) issues.push('provenance:invalid_prediction_timeline');
    }
  }
  const parseRows = (bytes: Buffer): unknown[] => bytes.toString('utf8').split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
  const assessment = validCriteria ? assessGoalRows(parseRows(datasetBytes), parseRows(answerBytes), rawCriteria as unknown as GoalTaggerCriteria) : null;
  for (const [path, before] of snapshots) if (sha(readFileSync(path)) !== before) issues.push(`integrity:file_changed_during_assessment:${path}`);
  const checkpointSha256AtAssessmentEnd = sha(readFileSync(paths.checkpoint));
  if (checkpointSha256AtAssessmentEnd !== actual.checkpointSha256) issues.push('checkpoint:changed_during_assessment');
  if (assessment) issues.push(...assessment.inputIntegrity.issues);
  const finalStatus = issues.length ? 'unverifiable' : assessment!.status;
  return { schemaVersion: 1, assessedAt: new Date().toISOString(), scope: 'ads.goal.v2', status: finalStatus,
    meetsGoalExtractionCriteria: finalStatus === 'passed', productionReady: false,
    limitation: 'Goal extraction only. This does not verify ad creation, application integration, programming, or general language understanding.',
    inputIntegrity: { status: issues.length ? 'failed' : 'passed', issues: [...new Set(issues)] }, failures: assessment?.failures ?? [],
    metrics: issues.length ? null : assessment?.metrics ?? null, criteria: rawCriteria,
    integrity: { ...actual, files: Object.fromEntries(snapshots), checkpointSha256AtAssessmentEnd },
    method: { singleDesignatedAnswer: true, checkpointSelection: 'frozen_before_predictions', repair: 'existing_frozen_input_only_repair',
      incompleteAnswersAreFailures: true, fieldDenominator: 'all_cases_in_group', labelsUsedToChooseAnswers: false } };
}

export function main(args = process.argv.slice(2)) {
  const required = ['criteria', 'dataset', 'answers', 'provenance', 'checkpoint', 'output'];
  const values: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]?.replace(/^--/, ''), value = args[index + 1];
    if (!name || !required.includes(name) || values[name] || !value || value.startsWith('--')) throw new Error(`Invalid or duplicate CLI option: ${args[index]}`);
    values[name] = value;
  }
  for (const name of required) if (!values[name]) throw new Error(`Required: --${name}`);
  const report = assessGoalTaggerFiles(values as unknown as AssessmentPaths);
  writeFileSync(values.output!, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ status: report.status, output: resolve(values.output!), metrics: report.metrics?.byLanguage, inputIntegrity: report.inputIntegrity }));
  return report;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === pathToFileURL(fileURLToPath(import.meta.url)).href) main();
