import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assessRows, main, siteReviewSelection, type AssessmentRow, type ReadinessCriteria, type SandboxEvidence } from '../scripts/ads-training/assess-bilingual.js';
import { goalToPointer } from '../scripts/ads-training/pointer.js';
import type { Goal } from '../scripts/ads-training/goal.js';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const criteria: ReadinessCriteria = {
  schemaVersion: 1, id: 'unit-fixture-only', frozenAt: '2026-11-15T01:00:00Z', frozenBeforePredictions: true, languages: ['ar', 'en'],
  ads: { minimumIndependentCasesPerLanguage: 1, minimumRawExactAccuracy: .95, minimumAcceptedPrecision: .99, independentDatasetSha256: 'fixture' },
  code: { minimumEvaluatedCases: 2, minimumBehavioralAccuracyPerLanguage: .95, minimumBehavioralAccuracyPerFamily: .9, requiredFamilies: ['add'], maximumKnownBadAccepted: 0 },
  site: { semanticReviewRequired: true },
};
function goalRow(language: 'en' | 'ar', id: string = language): AssessmentRow {
  const message = language === 'ar' ? 'أنشئ حملة في الرياض' : 'make ads in York';
  const expected: Goal = { intent: 'create_campaign', url: null, service: null, locations: [language === 'ar' ? 'الرياض' : 'York'], budget: null, goal: null };
  return { id, split: 'test_independent', capability: 'ads.goal.v2', language, family: 'goal', input: { message }, expected,
    answer_text: goalToPointer(message, expected)!, finished: true, metadataVerified: true, independent: true };
}
function codeRow(language: string, id: string): AssessmentRow {
  return { id, split: 'code_test', capability: 'code.implement.v1', language, family: 'add', input: { functionName: 'sum', signature: 'sum(a: number, b: number): number', probes: [{ args: [1, 2], expected: 3 }] }, expected: 'unused exact target',
    answer_text: 'export function sum(a: number, b: number): number { return a + b; }', finished: true, metadataVerified: true, independent: false };
}
function codeEvidence(rows: AssessmentRow[], succeeds = true): SandboxEvidence {
  const candidates = rows.map(row => ({ id: row.id, content: row.answer_text, functionName: String(row.input.functionName), signature: String(row.input.signature), probes: row.input.probes as unknown[], language: row.language, family: row.family }));
  return { candidates, jobSha256: 'fixture-job', receipt: { available: true, jobSha256: 'fixture-job',
    receipts: [{ candidateIds: rows.map(row => row.id), isolationVerified: true, network: 'denied', timedOut: false, exitCode: 0, snapshotHash: 'fixture-snapshot' }],
    results: Object.fromEntries(rows.map(row => [row.id, { candidateSha256: digest(row.answer_text), loaded: true, exported: true, passed: succeeds ? 1 : 0, total: 1, success: succeeds, error: null }])) } };
}

describe('Bilingual readiness assessment with independent evidence', () => {
  it('separates raw model accuracy from deterministic repair and refuses unfinished correct-looking output', () => {
    const ar = goalRow('ar'), en = goalRow('en');
    en.input.message = 'ads for shop.uk in York';
    en.expected = { ...(en.expected as Goal), url: 'shop.uk' };
    en.answer_text = 'intent create_campaign; url 2; locations 5';
    const report = assessRows([ar, en], criteria);
    expect(report.components.ads.byLanguage.en).toMatchObject({ rawExact: 0, repairedExact: 1, accepted: 1, acceptedWrong: 0 });
    expect(report.components.ads.status).toBe('failed');
    ar.finished = false;
    const incomplete = assessRows([ar], criteria).components.ads.byLanguage.ar;
    expect(incomplete).toMatchObject({ rawExact: 0, repairedExact: 0, accepted: 0, incomplete: 1 });
  });

  it('measures accepted wrong answers instead of calling a checker pass accuracy', () => {
    const row = goalRow('en');
    row.answer_text = 'intent create_campaign'; // Well formed, but it loses the explicit city.
    const result = assessRows([row], criteria).components.ads.byLanguage.en;
    expect(result).toMatchObject({ rawExact: 0, accepted: 1, acceptedWrong: 1, acceptedPrecision: 0 });
  });

  it('does not pool familiar generated tests into the independent gate', () => {
    const rows = Array.from({ length: 20 }, (_, index) => ({ ...goalRow('en', `generated-${index}`), independent: false, split: 'template_test' }));
    const report = assessRows(rows, criteria);
    expect(report.components.ads.byLanguage.en.rows).toBe(0);
    expect(report.components.ads.observationsBySplit.template_test.en.rawExactAccuracy).toBe(1);
    expect(report.components.ads.status).toBe('partial');
  });

  it('requires candidate-content binding, isolated sandbox receipts and matching probes', () => {
    const rows = [codeRow('ar', 'ar-code'), codeRow('en', 'en-code')];
    const evidence = codeEvidence(rows), bugs = codeEvidence([codeRow('en', 'known-bad')], false);
    const report = assessRows(rows, criteria, { code: evidence, knownBad: bugs });
    expect(report.components.code.status).toBe('passed');
    evidence.receipt.results!['ar-code']!.candidateSha256 = digest('some other function');
    expect(assessRows(rows, criteria, { code: evidence, knownBad: bugs }).components.code.status).toBe('partial');
    evidence.receipt.results!['ar-code']!.candidateSha256 = digest(rows[0]!.answer_text);
    evidence.receipt.receipts![0]!.network = 'allowed';
    expect(assessRows(rows, criteria, { code: evidence, knownBad: bugs }).components.code.overall.evaluated).toBe(0);
  });

  it('fails known bad acceptance and refuses unfinished code even with a successful receipt', () => {
    const rows = [codeRow('ar', 'ar-code'), codeRow('en', 'en-code')];
    rows[0]!.finished = false;
    const report = assessRows(rows, criteria, { code: codeEvidence(rows), knownBad: codeEvidence([codeRow('en', 'bad')], true) });
    expect(report.components.code.overall).toMatchObject({ passed: 1, incomplete: 1 });
    expect(report.components.code.failures).toContain('known_bad_candidate_accepted');
    expect(report.components.code.status).toBe('failed');
  });

  it('never promotes absent provenance or a structural site result to readiness', () => {
    const report = assessRows([goalRow('ar'), goalRow('en')], criteria);
    expect(report.components.ads.status).toBe('passed');
    expect(report.components.provenance.status).toBe('partial');
    expect(report.components.site.semanticReview).toBe('unverified');
    expect(report.productionReady).toBe(false);
  });

  it('uses output-independent site sampling and accepts a bound machine review without claiming production readiness', () => {
    const rows: AssessmentRow[] = ['ar', 'en'].map(language => {
      const input = { site: 'review.example', title: 'Roof Works', text: 'Roof Repair\nGutter Cleaning\nTile Replacement\nOur team repairs damaged roofs for homes across the city.\nWe inspect every roof before discussing the work with the owner.' };
      const output = { business: null, headlines: ['Roof Repair', 'Gutter Cleaning', 'Tile Replacement'], descriptions: ['Our team repairs damaged roofs for homes across the city.', 'We inspect every roof before discussing the work with the owner.'], keywords: ['Roof Repair', 'Gutter Cleaning'] };
      return { id: `site-${language}`, language, family: 'site', split: 'site_test', capability: 'ads.site.v1', input, expected: output,
        answer_text: JSON.stringify(output), finished: true, metadataVerified: true, independent: true };
    });
    const siteCriteria = { ...criteria, site: { semanticReviewRequired: true, minimumReviewedCasesPerLanguage: 1, minimumSemanticSuccessRate: .9, minimumAcceptedSemanticPrecision: 1 } };
    expect(siteReviewSelection(rows, ['ar', 'en'], 1)).toEqual(siteReviewSelection(rows.map(row => ({ ...row, answer_text: 'different output' })), ['ar', 'en'], 1));
    const review = { integrityVerified: true, independent: true, reviewType: 'independent_machine', reviewer: 'fixture reviewer',
      records: rows.map(row => ({ id: row.id, language: row.language, complete: true, relevant: true, wholeSentences: true, notNavigation: true, claimsGrounded: true, notes: 'Fixture assessment only.' })) };
    const result = assessRows(rows, siteCriteria, { siteReview: review });
    expect(result.components.site.status).toBe('passed');
    expect(result.components.site.humanReviewed).toBe(false);
    expect(result.productionReady).toBe(false);
    review.records[0]!.relevant = false;
    expect(assessRows(rows, siteCriteria, { siteReview: review }).components.site.status).toBe('failed');
    review.integrityVerified = false;
    expect(assessRows(rows, siteCriteria, { siteReview: review }).components.site.status).toBe('partial');
  });

  it('joins predictions to frozen metadata and refuses changed criteria or report overwrites', () => {
    const directory = mkdtempSync(join(tmpdir(), 'bilingual-assessment-'));
    try {
      const answers = join(directory, 'answers'), metadata = join(directory, 'metadata');
      mkdirSync(answers); mkdirSync(metadata);
      const rows = [goalRow('ar'), goalRow('en')];
      const dataset = rows.map(row => JSON.stringify({ id: row.id, split: row.split, capability: row.capability, language: row.language, input: row.input, output: row.expected })).join('\n') + '\n';
      const predictions = rows.map(row => JSON.stringify({ id: row.id, capability: row.capability, input: row.input, expected: row.expected, answer_text: row.answer_text, finished: row.finished })).join('\n') + '\n';
      writeFileSync(join(metadata, 'goal_independent.jsonl'), dataset);
      writeFileSync(join(answers, 'goal_independent.jsonl'), predictions);
      const criteriaPath = join(directory, 'criteria.json');
      const frozen = JSON.stringify({ ...criteria, ads: { ...criteria.ads, independentDatasetSha256: digest(dataset) } });
      writeFileSync(criteriaPath, frozen); writeFileSync(join(directory, 'criteria.sha256'), digest(frozen));
      const output = join(directory, 'report.json');
      const args = ['--answers-dir', answers, '--metadata-dir', metadata, '--criteria', criteriaPath, '--output', output];
      main(args);
      const report = JSON.parse(readFileSync(output, 'utf8'));
      expect(report.components.ads.status).toBe('passed');
      expect(report.productionReady).toBe(false);
      expect(() => main(args)).toThrow();
      writeFileSync(criteriaPath, frozen + ' ');
      expect(() => main([...args.slice(0, -1), join(directory, 'changed.json')])).toThrow('Frozen criteria digest');
    } finally {
      const target = resolve(directory), root = resolve(tmpdir());
      if (!target.startsWith(`${root}${sep}`) || !basename(target).startsWith('bilingual-assessment-')) throw new Error('Refusing cleanup outside the test temporary directory');
      rmSync(target, { recursive: true, force: true });
    }
  });
});
