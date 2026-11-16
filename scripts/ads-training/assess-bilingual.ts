/** Read-only prediction assessment. Never executes generated code or selects a candidate using labels.
 * npx tsx scripts/ads-training/assess-bilingual.ts --answers-dir <dir> --metadata-dir <dataset>
 *   --metadata-dir <independent-dataset> --output <report.json> [--code-job <json> --code-receipts <json>]
 *   [--known-bad-job <json> --known-bad-receipts <json>] [--provenance <json>]
 * Metadata directories are read ONLY for JSONL filenames present in the answers directory, never train/validation.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkGoal, compareGoal, type Goal } from './goal.js';
import { checkSiteAds, type SiteAds, type SiteInput } from './site.js';
import { GOAL_POINTER_CAPABILITY, SITE_POINTER_CAPABILITY, pointerToGoal, pointerToSite, repairGoalPointer } from './pointer.js';

type Status = 'passed' | 'failed' | 'partial';
type ObjectValue = Record<string, unknown>;
export interface ReadinessCriteria {
  schemaVersion: number; id: string; frozenAt: string; frozenBeforePredictions: boolean; languages: string[];
  ads: { minimumIndependentCasesPerLanguage: number; minimumRawExactAccuracy: number; minimumAcceptedPrecision: number; independentDatasetSha256: string };
  code: { minimumEvaluatedCases: number; minimumBehavioralAccuracyPerLanguage: number; minimumBehavioralAccuracyPerFamily: number; requiredFamilies: string[]; maximumKnownBadAccepted: number };
  site: { semanticReviewRequired: boolean; minimumReviewedCasesPerLanguage?: number; minimumSemanticSuccessRate?: number; minimumAcceptedSemanticPrecision?: number };
}
export interface AssessmentRow {
  id: string; split: string; capability: string; language: string; family: string;
  input: ObjectValue; expected: unknown; answer_text: string; finished: boolean;
  metadataVerified: boolean; independent: boolean;
  answerFile?: string;
}
export interface Candidate { id: string; content: string; functionName: string; signature?: string; probes: unknown[]; language?: string; family?: string }
export interface VerificationResult { success?: boolean; loaded?: boolean; exported?: boolean; passed?: number; total?: number; error?: unknown; candidateSha256?: string }
export interface SandboxEvidence {
  jobSha256: string;
  candidates: Candidate[];
  receipt: { available?: boolean; jobSha256?: string; receipts?: { candidateIds?: string[]; network?: string; isolationVerified?: boolean; timedOut?: boolean; exitCode?: number; snapshotHash?: string }[]; results?: Record<string, VerificationResult> };
}
export interface AssessmentEvidence {
  code?: SandboxEvidence; knownBad?: SandboxEvidence;
  provenance?: { status: Status; reasons: string[]; checkpointSha256?: string };
  inputIssues?: string[];
  siteReview?: { integrityVerified: boolean; independent: boolean; reviewType: string; reviewer: string; records: {
    id: string; language: string; complete: boolean; relevant: boolean; wholeSentences: boolean; notNavigation: boolean; claimsGrounded: boolean; notes: string;
  }[] };
}
const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const canonical = (value: unknown): string => JSON.stringify(sort(value));
const sort = (value: unknown): unknown => Array.isArray(value) ? value.map(sort) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sort((value as ObjectValue)[key])])) : value;
const ratio = (count: number, total: number) => total ? count / total : null;
const object = (value: unknown): value is ObjectValue => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const json = (text: string): unknown => { try { return JSON.parse(text); } catch { return null; } };
const status = (failures: string[], missing: string[]): Status => failures.length ? 'failed' : missing.length ? 'partial' : 'passed';

function goalMetrics(rows: AssessmentRow[]) {
  let rawExact = 0, repairedExact = 0, accepted = 0, acceptedCorrect = 0, incomplete = 0, malformed = 0;
  const refusalReasons: Record<string, number> = {};
  for (const row of rows) {
    // Only the first, designated answer is used. Candidate arrays are deliberately unsupported.
    if (!row.finished) { incomplete++; refusalReasons.INCOMPLETE = (refusalReasons.INCOMPLETE ?? 0) + 1; continue; }
    const message = String(row.input.message ?? '');
    const raw = row.capability === GOAL_POINTER_CAPABILITY ? pointerToGoal(message, row.answer_text) : json(row.answer_text) as Goal | null;
    const repaired = row.capability === GOAL_POINTER_CAPABILITY ? pointerToGoal(message, repairGoalPointer(message, row.answer_text)) : raw;
    const exact = (value: unknown) => object(value) && object(row.expected) && compareGoal(row.expected as unknown as Goal, value as unknown as Goal).exact;
    if (exact(raw)) rawExact++;
    if (exact(repaired)) repairedExact++;
    const issues = repaired === null ? ['BAD_POINTER_OR_JSON'] : checkGoal(message, repaired);
    if (repaired === null) malformed++;
    if (!issues.length) { accepted++; if (exact(repaired)) acceptedCorrect++; }
    else for (const issue of issues) refusalReasons[issue] = (refusalReasons[issue] ?? 0) + 1;
  }
  return { rows: rows.length, rawExact, rawExactAccuracy: ratio(rawExact, rows.length), repairedExact,
    repairedExactAccuracy: ratio(repairedExact, rows.length), accepted, acceptedCorrect, acceptedWrong: accepted - acceptedCorrect,
    acceptedCoverage: ratio(accepted, rows.length), acceptedPrecision: ratio(acceptedCorrect, accepted),
    incomplete, malformed, refusalReasons };
}

function siteMetrics(rows: AssessmentRow[]) {
  let accepted = 0, incomplete = 0, headlineMatches = 0, headlineTotal = 0;
  const refusalReasons: Record<string, number> = {};
  for (const row of rows) {
    if (!row.finished) { incomplete++; refusalReasons.INCOMPLETE = (refusalReasons.INCOMPLETE ?? 0) + 1; continue; }
    const input = row.input as unknown as SiteInput;
    const value = row.capability === SITE_POINTER_CAPABILITY ? pointerToSite(input, row.answer_text) : json(row.answer_text);
    const issues = value === null ? ['BAD_POINTER_OR_JSON'] : checkSiteAds(input, value);
    if (issues.length) { for (const issue of issues) refusalReasons[issue] = (refusalReasons[issue] ?? 0) + 1; continue; }
    accepted++;
    const answer = value as SiteAds;
    const expected = row.expected as Partial<SiteAds> | null;
    const teacher = new Set((expected?.headlines ?? []).map(text => text.toLowerCase()));
    headlineTotal += answer.headlines.length;
    headlineMatches += answer.headlines.filter(text => teacher.has(text.toLowerCase())).length;
  }
  return { rows: rows.length, accepted, structuralGroundingAcceptance: ratio(accepted, rows.length), incomplete,
    teacherHeadlineOverlap: ratio(headlineMatches, headlineTotal), refusalReasons,
    semanticAccuracy: null, semanticReview: 'unverified',
    limitation: 'Acceptance checks syntax, limits and source grounding. Teacher overlap is not semantic relevance or advertising quality.' };
}

/** Selection depends only on case identity, never the output or its correctness. */
export function siteReviewSelection(rows: AssessmentRow[], languages: string[], count: number) {
  return Object.fromEntries(languages.map(language => [language, rows.filter(row => row.language === language && /^ads\.site\.v[12]$/.test(row.capability))
    .sort((a, b) => hash(a.id).localeCompare(hash(b.id))).slice(0, count).map(row => row.id)]));
}
function semanticSiteAssessment(rows: AssessmentRow[], criteria: ReadinessCriteria, evidence: AssessmentEvidence['siteReview']) {
  const count = criteria.site.minimumReviewedCasesPerLanguage ?? 20;
  const selectedIds = siteReviewSelection(rows, criteria.languages, count);
  const failures: string[] = [], missing: string[] = [];
  const trusted = evidence?.integrityVerified && evidence.independent && ['independent_machine', 'independent_human'].includes(evidence.reviewType) && Boolean(evidence.reviewer);
  if (!trusted) missing.push('independent_bound_semantic_review_missing');
  const byLanguage = Object.fromEntries(criteria.languages.map(language => {
    const selected = selectedIds[language]!;
    let reviewed = 0, accepted = 0, semanticallyValid = 0, wrongAccepted = 0;
    if (selected.length < count) missing.push(`${language}:too_few_site_cases`);
    for (const id of selected) {
      const row = rows.find(item => item.id === id)!;
      const reviews = trusted ? evidence.records.filter(item => item.id === id && item.language === language) : [];
      if (reviews.length !== 1) continue;
      const review = reviews[0]!;
      reviewed++;
      const actualAccepted = siteMetrics([row]).accepted === 1;
      if (actualAccepted) {
        accepted++;
        if (review.complete === true && review.relevant === true && review.wholeSentences === true && review.notNavigation === true && review.claimsGrounded === true) semanticallyValid++;
        else wrongAccepted++;
      }
    }
    if (reviewed < selected.length) missing.push(`${language}:site_review_incomplete`);
    const successRate = ratio(semanticallyValid, selected.length), precision = ratio(semanticallyValid, accepted);
    if (selected.length >= count && reviewed === selected.length) {
      if (successRate! < (criteria.site.minimumSemanticSuccessRate ?? .90)) failures.push(`${language}:site_semantic_success_below_threshold`);
      if (precision === null || precision < (criteria.site.minimumAcceptedSemanticPrecision ?? 1)) failures.push(`${language}:accepted_site_semantic_precision_below_threshold`);
    }
    return [language, { selected: selected.length, reviewed, accepted, semanticallyValid, wrongAccepted, semanticSuccessRate: successRate, acceptedSemanticPrecision: precision }];
  }));
  return { status: status(failures, missing), failures, missing, selectedIds, semanticByLanguage: byLanguage,
    semanticReview: trusted ? evidence!.reviewType : 'unverified', reviewer: trusted ? evidence!.reviewer : null,
    humanReviewed: trusted && evidence!.reviewType === 'independent_human' };
}

function verifiedCandidate(candidate: Candidate, evidence: SandboxEvidence): { evaluated: boolean; passed: boolean; reason?: string } {
  if (evidence.receipt.jobSha256 !== evidence.jobSha256) return { evaluated: false, passed: false, reason: 'unbound_job_receipt' };
  const result = evidence.receipt.results?.[candidate.id];
  if (!result || result.candidateSha256 !== hash(candidate.content)) return { evaluated: false, passed: false, reason: 'missing_or_unbound_candidate_result' };
  if (result.success === false && ['outside_bounded_expression_grammar', 'signature_mismatch'].includes(String(result.error))) return { evaluated: true, passed: false };
  const receipts = evidence.receipt.receipts?.filter(receipt => receipt.candidateIds?.includes(candidate.id)) ?? [];
  if (!evidence.receipt.available || receipts.length !== 1 || !receipts[0]!.isolationVerified || receipts[0]!.network !== 'denied'
    || receipts[0]!.timedOut || receipts[0]!.exitCode !== 0 || !receipts[0]!.snapshotHash) return { evaluated: false, passed: false, reason: 'sandbox_receipt_missing_or_invalid' };
  const passed = result.success === true && result.loaded === true && result.exported === true && !result.error
    && result.total === candidate.probes.length && result.total > 0 && result.passed === result.total;
  return { evaluated: true, passed };
}

function codeMetrics(rows: AssessmentRow[], evidence?: SandboxEvidence) {
  let passed = 0, evaluated = 0, incomplete = 0;
  const reasons: Record<string, number> = {};
  for (const row of rows) {
    if (!row.finished) { incomplete++; evaluated++; reasons.INCOMPLETE = (reasons.INCOMPLETE ?? 0) + 1; continue; }
    const candidates = evidence?.candidates.filter(candidate => candidate.id === row.id) ?? [];
    const candidate = candidates[0];
    if (!evidence || candidates.length !== 1 || !candidate || !row.metadataVerified || candidate.content !== row.answer_text
      || candidate.functionName !== row.input.functionName || typeof row.input.signature !== 'string' || candidate.signature !== row.input.signature
      || canonical(candidate.probes) !== canonical(row.input.probes)) {
      reasons.MISSING_OR_MISMATCHED_JOB = (reasons.MISSING_OR_MISMATCHED_JOB ?? 0) + 1; continue;
    }
    const result = verifiedCandidate(candidate, evidence);
    if (result.evaluated) evaluated++;
    if (result.passed) passed++;
    if (result.reason) reasons[result.reason] = (reasons[result.reason] ?? 0) + 1;
  }
  return { rows: rows.length, evaluated, missingEvidence: rows.length - evaluated, passed,
    behavioralAccuracy: ratio(passed, rows.length), incomplete, reasons };
}

export function assessRows(rows: AssessmentRow[], criteria: ReadinessCriteria, evidence: AssessmentEvidence = {}) {
  const inputIssues = [...(evidence.inputIssues ?? [])];
  if (new Set(rows.map(row => row.id)).size !== rows.length) inputIssues.push('duplicate_answer_ids');
  const unknownLanguages = rows.filter(row => !criteria.languages.includes(row.language)).length;
  const unverifiedMetadata = rows.filter(row => !row.metadataVerified).length;
  if (unknownLanguages) inputIssues.push(`unknown_language_rows:${unknownLanguages}`);
  if (unverifiedMetadata) inputIssues.push(`unverified_metadata_rows:${unverifiedMetadata}`);
  const goals = rows.filter(row => /^ads\.goal\.v[12]$/.test(row.capability));
  const sites = rows.filter(row => /^ads\.site\.v[12]$/.test(row.capability));
  const code = rows.filter(row => /^code\.(?:implement|repair)\.v1$/.test(row.capability));
  if (goals.length + sites.length + code.length !== rows.length) inputIssues.push('unknown_capability_rows');
  const independent = goals.filter(row => row.independent && row.metadataVerified);
  const adsFailures: string[] = [], adsMissing: string[] = [];
  const adsByLanguage = Object.fromEntries(criteria.languages.map(language => {
    const result = goalMetrics(independent.filter(row => row.language === language));
    if (result.rows < criteria.ads.minimumIndependentCasesPerLanguage) adsMissing.push(`${language}:too_few_independent_cases`);
    else {
      if (result.rawExactAccuracy! < criteria.ads.minimumRawExactAccuracy) adsFailures.push(`${language}:raw_exact_below_threshold`);
      if (result.acceptedPrecision === null) adsFailures.push(`${language}:no_accepted_answers`);
      else if (result.acceptedPrecision < criteria.ads.minimumAcceptedPrecision) adsFailures.push(`${language}:accepted_precision_below_threshold`);
    }
    return [language, result];
  }));
  const codeFailures: string[] = [], codeMissing: string[] = [];
  const codeOverall = codeMetrics(code, evidence.code);
  if (codeOverall.rows < criteria.code.minimumEvaluatedCases) codeMissing.push('too_few_code_cases');
  if (codeOverall.missingEvidence) codeMissing.push('missing_code_evidence');
  const codeByLanguage = Object.fromEntries(criteria.languages.map(language => {
    const result = codeMetrics(code.filter(row => row.language === language), evidence.code);
    if (!result.rows) codeMissing.push(`${language}:no_code_cases`);
    else if (!result.missingEvidence && result.behavioralAccuracy! < criteria.code.minimumBehavioralAccuracyPerLanguage) codeFailures.push(`${language}:behavior_below_threshold`);
    return [language, result];
  }));
  const codeByFamily = Object.fromEntries(criteria.code.requiredFamilies.map(family => {
    const result = codeMetrics(code.filter(row => row.family === family), evidence.code);
    if (!result.rows) codeMissing.push(`${family}:no_code_cases`);
    else if (!result.missingEvidence && result.behavioralAccuracy! < criteria.code.minimumBehavioralAccuracyPerFamily) codeFailures.push(`${family}:behavior_below_threshold`);
    return [family, result];
  }));
  const bad = evidence.knownBad?.candidates ?? [];
  const badResults = evidence.knownBad ? bad.map(candidate => verifiedCandidate(candidate, evidence.knownBad!)) : [];
  const knownBad = { cases: bad.length, evaluated: badResults.filter(result => result.evaluated).length, accepted: badResults.filter(result => result.passed).length };
  if (!knownBad.cases || knownBad.evaluated !== knownBad.cases) codeMissing.push('known_bad_evidence_missing');
  if (knownBad.accepted > criteria.code.maximumKnownBadAccepted) codeFailures.push('known_bad_candidate_accepted');
  const provenance = evidence.provenance ?? { status: 'partial' as const, reasons: ['no_bound_local_scratch_generation_manifest'] };
  const components = {
    inputIntegrity: { status: inputIssues.length ? 'partial' as const : 'passed' as const, reasons: inputIssues },
    ads: { status: status(adsFailures, adsMissing), failures: adsFailures, missing: adsMissing, byLanguage: adsByLanguage,
      observationsBySplit: Object.fromEntries([...new Set(goals.map(row => row.split))].map(split => [split,
        Object.fromEntries([...new Set(goals.filter(row => row.split === split).map(row => row.language))].map(language =>
          [language, goalMetrics(goals.filter(row => row.split === split && row.language === language))]))])) },
    code: { status: status(codeFailures, codeMissing), failures: codeFailures, missing: codeMissing, overall: codeOverall,
      byLanguage: codeByLanguage, byFamily: codeByFamily, knownBad, scope: 'Eight bounded TypeScript families, not general programming competence.' },
    site: { ...semanticSiteAssessment(sites, criteria, evidence.siteReview),
      byLanguage: Object.fromEntries([...new Set(sites.map(row => row.language))].map(language => [language, siteMetrics(sites.filter(row => row.language === language))])),
      semanticReviewRequired: criteria.site.semanticReviewRequired },
    provenance,
  };
  const statuses = Object.values(components).map(component => component.status);
  return { schemaVersion: 1, criteriaId: criteria.id, assessedAt: new Date().toISOString(), rows: rows.length,
    status: statuses.includes('failed') ? 'failed' : statuses.includes('partial') ? 'partial' : 'passed',
    localExperimentalReady: statuses.every(item => item === 'passed'), productionReady: false,
    productionIntegration: { status: 'unverified', reason: 'This assessment does not verify deployed end-to-end runtime behavior.' }, components,
    method: { candidateSelection: 'single designated answer, no label-based selection', incompleteAnswersRefused: true,
      codeExecutedByAssessor: false, independentAssessmentHumanReviewed: false, thresholdsChanged: false } };
}

function readJson(path: string): ObjectValue { const value = json(readFileSync(path, 'utf8')); if (!object(value)) throw new Error(`Expected JSON object: ${path}`); return value; }
function readLines(path: string): ObjectValue[] {
  return readFileSync(path, 'utf8').split(/\r?\n/).filter(line => line.trim()).map((line, index) => {
    const value = json(line); if (!object(value)) throw new Error(`Malformed JSONL at ${basename(path)}:${index + 1}`); return value;
  });
}
function sandboxEvidence(jobPath?: string, receiptPath?: string): SandboxEvidence | undefined {
  if (!jobPath || !receiptPath) return undefined;
  const jobText = readFileSync(jobPath, 'utf8'), job = json(jobText);
  if (!object(job) || !Array.isArray(job.candidates)) throw new Error('Invalid sandbox job');
  return { candidates: job.candidates as Candidate[], jobSha256: hash(jobText), receipt: readJson(receiptPath) as SandboxEvidence['receipt'] };
}

function inspectProvenance(path: string | undefined, answerHashes: Record<string, string>, datasetHashes: Record<string, string>) {
  if (!path) return { status: 'partial' as const, reasons: ['no_generation_provenance_manifest'] };
  const value = readJson(path), reasons: string[] = [], failure: string[] = [];
  const checkpoint = value.checkpointSha256;
  if (typeof checkpoint !== 'string' || !/^[a-f\d]{64}$/.test(checkpoint)) reasons.push('checkpoint_hash_missing');
  if (value.checkpointHashBeforeGeneration !== checkpoint || value.checkpointHashAfterGeneration !== checkpoint) reasons.push('checkpoint_not_pinned_before_and_after_generation');
  if (value.externalModelFallback === true || value.externalPretrainedWeights === true) failure.push('external_model_or_pretrained_weights_used');
  if (value.externalModelFallback !== false || value.externalPretrainedWeights !== false || value.initialization !== 'random' || value.localGeneration !== true) reasons.push('local_scratch_lineage_unverified');
  for (const [group, hashes] of [['answerFiles', answerHashes], ['datasetFiles', datasetHashes]] as const) {
    const recorded = value[group];
    if (!object(recorded) || Object.entries(hashes).some(([name, digest]) => recorded[name] !== digest)) reasons.push(`${group}_hash_mismatch_or_missing`);
  }
  const sources = value.lineageEvidence;
  if (!Array.isArray(sources) || !sources.length) reasons.push('lineage_evidence_missing');
  else for (const item of sources) {
    if (!object(item) || typeof item.path !== 'string' || typeof item.sha256 !== 'string') { reasons.push('lineage_evidence_invalid'); continue; }
    const sourcePath = isAbsolute(item.path) ? item.path : resolve(item.path);
    if (!existsSync(sourcePath) || hash(readFileSync(sourcePath)) !== item.sha256) reasons.push('lineage_evidence_hash_mismatch');
  }
  return { status: status(failure, reasons), reasons: [...failure, ...reasons], checkpointSha256: typeof checkpoint === 'string' ? checkpoint : undefined };
}

function readSiteReview(path: string | undefined, hashes: Record<string, string>, requiredFiles: string[]): AssessmentEvidence['siteReview'] {
  if (!path) return undefined;
  const value = readJson(path);
  const recorded = value.answerFiles;
  const integrityVerified = object(recorded) && requiredFiles.length > 0
    && requiredFiles.every(file => recorded[file] === hashes[file])
    && Object.entries(recorded).every(([file, digest]) => hashes[file] === digest);
  return { integrityVerified, independent: value.independent === true, reviewType: String(value.reviewType), reviewer: String(value.reviewer ?? ''),
    records: Array.isArray(value.records) ? value.records as NonNullable<AssessmentEvidence['siteReview']>['records'] : [] };
}

export function main(args = process.argv.slice(2)): void {
  const values = (flag: string) => args.flatMap((arg, index) => arg === flag ? [args[index + 1] ?? ''] : []);
  const one = (flag: string) => values(flag)[0];
  const answersDir = one('--answers-dir'), metadataDirs = values('--metadata-dir'), output = one('--output');
  if (!answersDir || !output || !metadataDirs.length) throw new Error('Required: --answers-dir, --metadata-dir (repeatable), --output');
  const criteriaPath = one('--criteria') ?? 'artifacts/model-readiness-20261115/criteria.json';
  const criteriaText = readFileSync(criteriaPath, 'utf8'), criteria = JSON.parse(criteriaText) as ReadinessCriteria;
  if (criteria.schemaVersion !== 1 || !criteria.frozenBeforePredictions || !criteria.languages?.length) throw new Error('Criteria must be explicitly frozen');
  const digestPath = criteriaPath.replace(/\.json$/i, '.sha256');
  if (digestPath === criteriaPath || !existsSync(digestPath) || readFileSync(digestPath, 'utf8').trim() !== hash(criteriaText)) throw new Error('Frozen criteria digest missing or mismatched');
  const files = readdirSync(answersDir).filter(file => file.endsWith('.jsonl')).sort();
  const rows: AssessmentRow[] = [], inputIssues: string[] = [], answerHashes: Record<string, string> = {}, datasetHashes: Record<string, string> = {};
  for (const file of files) {
    if (/^(?:train|validation)(?:\.|_)/i.test(file)) throw new Error('Training/validation files are not final assessment inputs');
    const answerPath = join(answersDir, file);
    answerHashes[file] = hash(readFileSync(answerPath));
    const metadataPaths = metadataDirs.map(dir => join(dir, file)).filter(existsSync);
    if (metadataPaths.length !== 1) { inputIssues.push(`${file}:metadata_file_missing_or_ambiguous`); continue; }
    const metadataPath = metadataPaths[0]!, metadataText = readFileSync(metadataPath, 'utf8');
    const digest = hash(metadataText); datasetHashes[file] = digest;
    const metadata = readLines(metadataPath), answers = readLines(answerPath);
    const metadataById = new Map(metadata.map(row => [row.id, row]));
    if (metadataById.size !== metadata.length) throw new Error(`${file}:duplicate_metadata_ids`);
    const answerIds = new Set(answers.map(row => row.id));
    if (answerIds.size !== answers.length) inputIssues.push(`${file}:duplicate_predictions`);
    if (answers.length !== metadata.length || metadata.some(row => !answerIds.has(row.id))) inputIssues.push(`${file}:missing_or_extra_predictions`);
    for (const answer of answers) {
      const original = metadataById.get(answer.id);
      if (!original || typeof original.id !== 'string' || !object(original.input)) { inputIssues.push(`${file}:unknown_prediction_id`); continue; }
      const expected = original.output ?? original.expected;
      const verified = canonical(answer.input) === canonical(original.input) && canonical(answer.expected) === canonical(expected)
        && answer.capability === original.capability;
      if (typeof answer.answer_text !== 'string' || typeof answer.finished !== 'boolean') inputIssues.push(`${file}:missing_answer_or_completion_status`);
      rows.push({ id: original.id, split: String(original.split ?? basename(file, '.jsonl')), capability: String(original.capability),
        language: String(original.language ?? original.input.language ?? 'unspecified'), family: String(original.family ?? original.input.family ?? 'unspecified'),
        input: original.input, expected, answer_text: typeof answer.answer_text === 'string' ? answer.answer_text : '', finished: answer.finished === true,
        metadataVerified: verified, independent: digest === criteria.ads.independentDatasetSha256, answerFile: file });
    }
  }
  const report = assessRows(rows, criteria, { inputIssues,
    code: sandboxEvidence(one('--code-job'), one('--code-receipts')),
    knownBad: sandboxEvidence(one('--known-bad-job'), one('--known-bad-receipts')),
    provenance: inspectProvenance(one('--provenance'), answerHashes, datasetHashes),
    siteReview: readSiteReview(one('--site-review'), answerHashes, [...new Set(rows.filter(row => /^ads\.site\./.test(row.capability)).map(row => row.answerFile!))]) });
  writeFileSync(output, JSON.stringify({ ...report, criteria: { path: resolve(criteriaPath), sha256: hash(criteriaText), frozenAt: criteria.frozenAt },
    integrity: { answerFiles: answerHashes, datasetFiles: datasetHashes, evaluatorSha256: hash(readFileSync(fileURLToPathSelf())) } }, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ status: report.status, productionReady: report.productionReady, output: resolve(output), rows: rows.length }));
}
function fileURLToPathSelf() { return new URL(import.meta.url); }
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main();
