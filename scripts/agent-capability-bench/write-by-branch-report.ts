import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { assertPublishedBaseline, type BranchReportCandidate, renderBranchReport } from './by-branch-report.js';
import { compareCapabilityCases } from './by-branch-statistics.js';
import type { PairedOutcomeReceipt } from './collect-paired-outcomes.js';
import type { FrozenLane, FrozenStudy, LaneRecord, MeasureOptions } from './measure-by-branch.js';

type Comparison = ReturnType<typeof compareCapabilityCases>;
type Source = PairedOutcomeReceipt['source'];
type Runtime = PairedOutcomeReceipt['runtime'];
type PreflightReceipt = { schemaVersion: number; partition: string; source: Source; runtime: Runtime };
type Result = { receipt: PairedOutcomeReceipt; receiptSha256: string; commands: string[] };
type Release = { manifestSha256: string; payloadSha256: string };
const canonicalHarness = ['collect-paired-outcomes.ts', 'corpus.ts', 'score.ts', 'v2/mapping.ts', 'v2/sealed.ts', 'v2/manifest.json'];
const collector = 'scripts/agent-capability-bench/collect-paired-outcomes.ts';
const digest = (content: Buffer) => createHash('sha256').update(content).digest('hex');
const isDigest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const readJson = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, 'utf8')) as T;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

async function readReleaseManifest(): Promise<Release> {
  const manifest = await readFile(new URL('./v2/manifest.json', import.meta.url));
  const parsed = JSON.parse(manifest.toString('utf8')) as { sealed: { sha256: string } };
  return { manifestSha256: digest(manifest), payloadSha256: parsed.sealed.sha256 };
}

function assertFrozenSource(receipt: PairedOutcomeReceipt, preflight: PreflightReceipt, lane: FrozenLane,
  study: FrozenStudy, release: Release, baseline?: PairedOutcomeReceipt) {
  const { source, runtime } = receipt;
  const { harnessSha256 } = source;
  const observer = lane.candidate?.adapter ? 'by-branch-observe.ts' : 'observe.ts';
  if (source.gitCommit !== lane.mergeCommit || source.trackedWorktreeClean !== true
    || source.baselineVerified !== !lane.candidate || !isDigest(source.lockfileSha256)
    || !canonicalHarness.every(name => isDigest(harnessSha256[name])) || !isDigest(harnessSha256[observer])
    || harnessSha256['collect-paired-outcomes.ts'] !== study.collectorHashes[collector]
    || harnessSha256['v2/manifest.json'] !== release.manifestSha256) {
    throw new Error(`Invalid frozen source provenance for ${lane.name}.`);
  }
  if (preflight.schemaVersion !== 1 || preflight.partition !== 'setup-preflight'
    || preflight.source.gitCommit !== source.gitCommit || preflight.source.trackedWorktreeClean !== true
    || preflight.source.lockfileSha256 !== source.lockfileSha256
    || !isDeepStrictEqual(preflight.source.harnessSha256, harnessSha256) || !isDeepStrictEqual(preflight.runtime, runtime)) {
    throw new Error(`Preflight and sealed provenance differ for ${lane.name}.`);
  }
  if (baseline && (!isDeepStrictEqual(runtime, baseline.runtime)
    || !canonicalHarness.every(name => harnessSha256[name] === baseline.source.harnessSha256[name])
    || (observer === 'observe.ts' && harnessSha256[observer] !== baseline.source.harnessSha256[observer]))) {
    throw new Error(`Canonical harness or runtime differs from baseline for ${lane.name}.`);
  }
}

async function loadLane(directory: string, lane: FrozenLane, study: FrozenStudy, release: Release,
  baseline?: PairedOutcomeReceipt): Promise<Result | { failure: string; commands: string[] }> {
  const attempted = await stat(join(directory, 'attempts', `${lane.commit}.attempt`))
    .then(result => result.isFile()).catch(error => { if (missing(error)) return false; throw error; });
  const receipts = join(directory, 'receipts');
  const record = await readJson<LaneRecord>(join(receipts, `${lane.name}.json`))
    .catch(error => { if (missing(error)) return undefined; throw error; });
  if (!record) {
    throw new Error(`The study is still in progress. No terminal record for ${lane.name}.`);
  }
  if (record.failure) {
    const attemptStatus = attempted ? 'A sealed attempt was reserved.' : 'No sealed attempt was reserved.';
    return { failure: `Measurement stopped during ${record.failure}. ${attemptStatus}`, commands: record.commands };
  }
  const path = join(receipts, `${lane.name}.paired.json`);
  const [bytes, metadata, preflight] = await Promise.all([
    readFile(path), stat(path), readJson<PreflightReceipt>(join(receipts, `${lane.name}.preflight.json`)),
  ]);
  const receiptSha256 = digest(bytes);
  if (!attempted || !metadata.isFile() || (metadata.mode & 0o077) !== 0 || record.receiptSha256 !== receiptSha256) {
    throw new Error(`Sealed receipt custody verification failed for ${lane.name}.`);
  }
  let receipt: PairedOutcomeReceipt;
  try { receipt = JSON.parse(bytes.toString('utf8')) as PairedOutcomeReceipt; }
  catch { throw new Error(`Sealed receipt JSON is invalid for ${lane.name}.`); }
  if (receipt.schemaVersion !== 1 || receipt.partition !== 'v2-sealed' || receipt.outcomes.length !== 1200
    || receipt.payloadSha256 !== release.payloadSha256 || receipt.manifestSha256 !== release.manifestSha256) {
    throw new Error(`Sealed release provenance differs from the pinned manifest for ${lane.name}.`);
  }
  assertFrozenSource(receipt, preflight, lane, study, release, baseline);
  return { receipt, receiptSha256, commands: record.commands };
}

function reconcileSummary(receipt: PairedOutcomeReceipt, comparison: Comparison, side: 'baseline' | 'candidate') {
  function agrees(summary: { total: number; passed: number } | undefined, group: Comparison['overall']) {
    return summary?.total === group.total && summary.passed === (side === 'baseline' ? group.baselinePassed : group.candidatePassed);
  }
  function groupsAgree(summary: PairedOutcomeReceipt['summary']['byArea'], groups: Comparison['byArea']) {
    return Object.keys(summary).length === Object.keys(groups).length
      && Object.entries(groups).every(([key, group]) => agrees(summary[key], group));
  }
  if (!agrees(receipt.summary.overall, comparison.overall)
    || !groupsAgree(receipt.summary.byArea, comparison.byArea)
    || !groupsAgree(receipt.summary.byLanguage, comparison.byLanguage)) {
    throw new Error(`The aggregate ${side} receipt differs from its paired outcomes.`);
  }
}

async function retainFile(path: string, content: string, mode: number) {
  try {
    await writeFile(path, content, { flag: 'wx', mode });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = await stat(path);
    if (!existing.isFile() || (existing.mode & 0o777 & ~mode) !== 0 || await readFile(path, 'utf8') !== content) {
      throw new Error(`Output exists with different content or permissions: ${path}`);
    }
  }
}

export async function writeStudyReport(options: MeasureOptions, invocation?: string) {
  if (options.mode !== 'report' || !options.output) throw new Error('Use report mode with an output path.');
  const { directory, output } = options;
  const [study, release, checks] = await Promise.all([
    readJson<FrozenStudy>(join(directory, 'study.json')), readReleaseManifest(),
    options.checks ? readJson<Array<{ command: string; result: string }>>(options.checks) : undefined,
  ]);
  const baselineLane = study.lanes.find(lane => !lane.candidate);
  if (!baselineLane) throw new Error('The frozen study does not include a baseline lane.');
  const baseline = await loadLane(directory, baselineLane, study, release);
  if ('failure' in baseline) throw new Error(`A complete paired baseline is required. ${baseline.failure}`);
  assertPublishedBaseline(baseline.receipt);
  reconcileSummary(baseline.receipt, compareCapabilityCases(baseline.receipt.outcomes, baseline.receipt.outcomes), 'baseline');
  const comparisons = [];
  const candidates: BranchReportCandidate[] = [];
  for (const lane of study.lanes) {
    if (!lane.candidate) continue;
    const entry = { ...lane.candidate, candidateCommit: lane.commit, mergeCommit: lane.mergeCommit };
    const result = await loadLane(directory, lane, study, release, baseline.receipt);
    if ('failure' in result) {
      candidates.push({ ...entry, ...result });
      continue;
    }
    const comparison = compareCapabilityCases(baseline.receipt.outcomes, result.receipt.outcomes);
    reconcileSummary(result.receipt, comparison, 'candidate');
    reconcileSummary(baseline.receipt, comparison, 'baseline');
    const { caseDeltas, ...aggregateComparison } = comparison;
    candidates.push({ ...entry, run: result, comparison: aggregateComparison });
    comparisons.push({ branch: lane.candidate.branch, candidateCommit: lane.commit, mergeCommit: lane.mergeCommit,
      receiptSha256: result.receiptSha256, caseDeltas });
  }
  const paired = { schemaVersion: 1, baseCommit: study.baseCommit, baselineReceiptSha256: baseline.receiptSha256, comparisons };
  const report = renderBranchReport({
    ...study, checks, baseline, candidates, commands: [...study.commands, ...(invocation ? [invocation] : [])],
  });
  await retainFile(join(directory, 'paired-comparisons.json'), `${JSON.stringify(paired, null, 2)}\n`, 0o600);
  await retainFile(output, report, 0o644);
  console.log('Aggregate branch comparison report written.');
}
