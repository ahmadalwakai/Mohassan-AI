import type { Candidate, V1DevelopmentDelta } from './by-branch-candidates.js';
import type { compareCapabilityCases } from './by-branch-statistics.js';
import type { PairedOutcomeReceipt } from './collect-paired-outcomes.js';
import { capabilityAreas, capabilityBaselineCommit } from './corpus.js';

type Comparison = Pick<ReturnType<typeof compareCapabilityCases>, 'overall' | 'byArea' | 'byLanguage'>;
type ComparisonGroup = Comparison['overall'];
type Receipt = Pick<PairedOutcomeReceipt,
  'source' | 'runtime' | 'startedAt' | 'finishedAt' | 'manifestSha256' | 'payloadSha256' | 'summary'>;
type SummaryGroup = Receipt['summary']['overall'];

export interface BranchReportRun {
  receipt: Receipt;
  receiptSha256: string;
  commands: readonly string[];
}

export interface BranchReportCandidate extends Pick<Candidate, 'branch' | 'flags' | 'stackedOn' | 'v1'> {
  pr?: number;
  adapter?: string;
  candidateCommit: string;
  mergeCommit?: string;
  run?: BranchReportRun;
  comparison?: Comparison;
  failure?: string;
  commands?: readonly string[];
}

export interface BranchReportStudy {
  baseCommit: string;
  commands: readonly string[];
  checks?: readonly { command: string; result: string }[];
  baseline: BranchReportRun;
  candidates: readonly BranchReportCandidate[];
  absentBranches: readonly string[];
}

const github = 'https://github.com/ahmadalwakai/Mohassan-AI';
const alpha = 0.05;
const logAlpha = Math.log10(alpha);
const publishedAreas = {
  'small-talk': [4, 50], factual: [203, 515], 'follow-up': [0, 95], comparison: [40, 70],
  calculation: [0, 110], coding: [0, 85], clarification: [0, 17], refusal: [0, 258],
};

export function assertPublishedBaseline(receipt: Receipt) {
  const { overall, byArea, byLanguage, byAreaAndLanguage } = receipt.summary;
  const agrees = (group: SummaryGroup | undefined, [passed, total]: number[]) =>
    group?.passed === passed && group?.total === total;
  const groupsAgree = (groups: Record<string, SummaryGroup>, expected: Record<string, number[]>) =>
    Object.keys(groups).length === Object.keys(expected).length
    && Object.entries(expected).every(([label, counts]) => agrees(groups[label], counts));
  if (receipt.source.gitCommit !== capabilityBaselineCommit || !receipt.source.baselineVerified
    || !receipt.source.trackedWorktreeClean || !agrees(overall, [247, 1200])
    || !groupsAgree(byArea, publishedAreas) || !groupsAgree(byLanguage, { ar: [191, 600], en: [56, 600] })
    || !groupsAgree(byAreaAndLanguage, {
      'small-talk/en': [4, 50], 'factual/ar': [171, 425], 'factual/en': [32, 90], 'follow-up/en': [0, 95],
      'comparison/ar': [20, 35], 'comparison/en': [20, 35], 'calculation/en': [0, 110], 'coding/en': [0, 85],
      'clarification/ar': [0, 2], 'clarification/en': [0, 15], 'refusal/ar': [0, 138], 'refusal/en': [0, 120],
    })) {
    throw new Error('The paired baseline does not match the published v2 baseline pass counts.');
  }
}

function holm(groups: readonly ComparisonGroup[], familySize: number) {
  const sorted = [...groups].sort((left, right) => left.log10PValue - right.log10PValue);
  const adjusted = new Map<ComparisonGroup, number>();
  let running = -Infinity;
  for (const [index, group] of sorted.entries()) {
    running = Math.max(running, Math.min(0, group.log10PValue + Math.log10(familySize - index)));
    adjusted.set(group, running);
  }
  return adjusted;
}

const percentage = (proportion: number) => `${(100 * proportion).toFixed(1)}%`;
const interval = (bounds: [number, number] | null) => bounds?.map(percentage).join('–') ?? '—';
const signed = (delta: number) => delta > 0 ? `+${delta}` : String(delta);
const deltaPp = (delta: number) => delta === 0 ? '0.00 pp' : `${delta > 0 ? '+' : ''}${(100 * delta).toFixed(2)} pp`;
const passCount = (row: Pick<SummaryGroup, 'passed' | 'total'>) => `${row.passed}/${row.total}`;
const candidateCount = (group: ComparisonGroup) => `${group.candidatePassed}/${group.total}`;
const branch = (candidate: BranchReportCandidate) => `\`${candidate.branch}\``;
const pr = (number: number) => `[#${number}](${github}/pull/${number})`;
const candidateLabel = (candidate: BranchReportCandidate) => candidate.pr
  ? `${pr(candidate.pr)} ${branch(candidate)}` : branch(candidate);
const languageLabel = (code: string) => ({ ar: 'Arabic', en: 'English' })[code as 'ar' | 'en'] ?? code;
const cell = (value: string) => value.replaceAll('|', '\\|').replaceAll(/\r?\n/gu, ' ');
const code = (value: string) => `\`${value}\``;

function pValue(log10P: number) {
  if (log10P >= -3) return String(Number((10 ** log10P).toPrecision(4)));
  const exponent = Math.floor(log10P);
  return `${Number((10 ** (log10P - exponent)).toPrecision(4))}e${exponent}`;
}

function commandBlock(commands: readonly string[]) {
  return ['```bash', ...commands, '```', ''];
}

function subgroupEntries(comparison: Comparison) {
  return [
    ...Object.entries(comparison.byLanguage).map(([key, group]) => [languageLabel(key), group] as const),
    ...Object.entries(comparison.byArea).map(([key, group]) => [code(key), group] as const),
  ];
}

function historicalRows(candidate: BranchReportCandidate, subgroupAdjusted: ReadonlyMap<ComparisonGroup, number>,
  overallAdjusted: ReadonlyMap<ComparisonGroup, number>, measuredAreas: ReadonlySet<string>) {
  const rows: string[] = [];
  const historical = candidate.v1;
  if (!historical) return rows;
  function add(historicalDelta: V1DevelopmentDelta) {
    const gains = [['overall', historicalDelta.overall] as const, ...Object.entries(historicalDelta.areas)];
    for (const [area, v1Delta] of gains) {
      if (v1Delta === undefined || v1Delta <= 0) continue;
      const group = area === 'overall' ? candidate.comparison?.overall : candidate.comparison?.byArea[area];
      let finding = 'No completed v2 result';
      if (area !== 'overall' && !measuredAreas.has(area)) {
        finding = 'No v2 cases in this area';
      } else if (group) {
        const adjusted = (area === 'overall' ? overallAdjusted : subgroupAdjusted).get(group)!;
        const delta = `${signed(group.deltaCount)} passes, ${deltaPp(group.deltaRate)}`;
        if (group.deltaCount <= 0) finding = `${delta} · no gain`;
        else if (adjusted <= logAlpha) finding = `${delta} · significant gain`;
        else finding = `${delta} · gain below the significance threshold`;
      }
      rows.push(`| ${candidateLabel(candidate)} | ${code(area)} | +${v1Delta} | ${cell(historicalDelta.comparison)} | ${finding} |`);
    }
  }
  add(historical);
  if (historical.stackedComparison) add(historical.stackedComparison);
  return rows;
}

function runProvenance(label: string, run: BranchReportRun) {
  const { source, runtime, startedAt, finishedAt } = run.receipt;
  return [
    `### ${label}`, '',
    `Evaluation HEAD ${code(source.gitCommit)}. ${runtime.platform} ${runtime.architecture}, Node.js ${code(runtime.node)}, timezone ${code(runtime.timeZone)}. Started ${code(startedAt)} and finished ${code(finishedAt)}.`, '',
    `- Lockfile SHA-256 ${code(source.lockfileSha256)}`,
    `- Receipt SHA-256 ${code(run.receiptSha256)}`,
    ...Object.entries(source.harnessSha256).sort(([left], [right]) => left.localeCompare(right))
      .map(([file, sha]) => `- ${code(file)} SHA-256 ${code(sha)}`),
    '',
    ...commandBlock(run.commands),
  ];
}

export function renderBranchReport(study: BranchReportStudy) {
  assertPublishedBaseline(study.baseline.receipt);
  const { baseline, candidates } = study;
  const { manifestSha256, payloadSha256, summary } = baseline.receipt;
  const measured = candidates.flatMap(candidate => candidate.run && candidate.comparison
    ? [{ ...candidate, run: candidate.run, comparison: candidate.comparison }] : []);
  measured.sort((left, right) => right.comparison.overall.deltaCount - left.comparison.overall.deltaCount
    || left.branch.localeCompare(right.branch));
  const measuredAreas = new Set(Object.keys(summary.byArea));
  const overallAdjusted = holm(measured.map(({ comparison }) => comparison.overall), candidates.length);
  const subgroupAdjusted = holm(measured.flatMap(({ comparison }) => subgroupEntries(comparison).map(([, group]) => group)),
    candidates.length * (measuredAreas.size + Object.keys(summary.byLanguage).length));
  const significant = (group: ComparisonGroup, adjusted: ReadonlyMap<ComparisonGroup, number>) =>
    adjusted.get(group)! <= logAlpha;
  const statisticallyEligible = measured.filter(({ comparison }) => comparison.overall.deltaCount > 0
    && significant(comparison.overall, overallAdjusted)
    && subgroupEntries(comparison).every(([, group]) => group.deltaCount >= 0 || !significant(group, subgroupAdjusted)));
  const recommended = statisticallyEligible.filter(candidate => candidate.pr !== 51);
  const excludedForLoss = measured.filter(({ comparison }) => comparison.overall.deltaCount > 0
    && significant(comparison.overall, overallAdjusted) && !statisticallyEligible.some(candidate => candidate.comparison === comparison));
  const n = summary.overall.total.toLocaleString('en-GB');
  const rows = [
    '# Mohassan capability benchmark v2 by branch — 25 November 2026', '',
    `The study measured ${measured.length} of ${candidates.length} available candidates on the same ${n} sealed cases. The release draws from public human-written datasets. The paired baseline replay at ${code(baseline.receipt.source.gitCommit)} matched the published v2 pass counts overall and in every area and language group. The candidates were measured separately on scratch merges with the measurement branch based on ${code(study.baseCommit)}. [V2 release audit](CAPABILITY-BENCH-V2-2026-11-25.md) · [V2 data and mapping](CAPABILITY-BENCH-V2-DATA.md)`, '',
    '## Ranking', '',
    `The baseline passed **${passCount(summary.overall)} (${percentage(summary.overall.passed / summary.overall.total)})**, with a Wilson 95% interval of ${interval(summary.overall.wilson95)}. Deltas are against that baseline. Equal deltas share a rank.`, '',
    '| Rank | Candidate | V2 passed | Wilson 95% CI | Delta passes | Delta rate | Newly passing | Newly failing | McNemar p | Holm p |',
    '| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...measured.map(({ comparison, ...candidate }) => {
      const group = comparison.overall;
      const rank = measured.findIndex(row => row.comparison.overall.deltaCount === group.deltaCount) + 1;
      return `| ${rank} | ${candidateLabel(candidate)} | ${candidateCount(group)} | ${interval(group.candidateWilson95)} | ${signed(group.deltaCount)} | ${deltaPp(group.deltaRate)} | ${group.newlyPassing} | ${group.newlyFailing} | ${pValue(group.log10PValue)} | ${pValue(overallAdjusted.get(group)!)} |`;
    }),
    '',
    '## Recommended merge set', '',
    'The recommendation rule was fixed before sealed evaluation. A candidate qualifies with a positive overall delta at Holm-adjusted p ≤ 0.05 and no negative area or language delta at subgroup Holm-adjusted p ≤ 0.05. Holm correction is applied separately to all frozen candidates overall and to the family of candidate-by-area and candidate-by-language tests. An unavailable result occupies its planned place in each applicable family with p = 1 for correction only.', '',
  ];
  if (recommended.length) {
    rows.push(...recommended.map(candidate => {
      const group = candidate.comparison.overall;
      const stack = candidate.stackedOn ? ' with its measured parent' : '';
      const links = [candidate.pr, candidate.stackedOn].filter((number): number is number => number !== undefined).map(pr).join(' · ');
      return `- Recommend ${branch(candidate)}${stack}. ${signed(group.deltaCount)} passing cases (${deltaPp(group.deltaRate)}), overall Holm p = ${pValue(overallAdjusted.get(group)!)}.${links ? ` ${links}` : ''}`;
    }), '', 'The measured configuration for each recommendation includes its listed flags and inherited commits. Joint effects of separately measured candidates are unverified.', '');
  } else {
    rows.push('**Recommendation.** No measured candidate qualified for an independent merge recommendation.', '');
  }
  for (const candidate of statisticallyEligible.filter(candidate => candidate.pr === 51)) {
    rows.push(`${branch(candidate)} met the statistical rule. The recommendation is provisional pending evaluation on data outside the shared CANARD development source. ${pr(51)} · ${pr(35)}`, '');
  }
  for (const candidate of excludedForLoss) {
    const losses = subgroupEntries(candidate.comparison).filter(([, group]) => group.deltaCount < 0 && significant(group, subgroupAdjusted))
      .map(([label, group]) => `${label} (${signed(group.deltaCount)} passes, Holm p = ${pValue(subgroupAdjusted.get(group)!)})`).join(', ');
    rows.push(`${branch(candidate)} had a significant overall gain and significant losses in ${losses}.${candidate.pr ? ` ${pr(candidate.pr)}` : ''}`, '');
  }
  rows.push(
    '## V1 development gains and v2 evidence', '',
    'The table includes each reported positive v1 development delta, including gains in individual areas of a branch with a flat overall result. V2 evidence is always against the common product baseline. V1 comparisons against a stacked parent have a different reference, and v1 and v2 use different cases and area weights. “No gain” indicates a zero or negative v2 pass-count delta. A positive v2 delta with adjusted p > 0.05 is labelled below the significance threshold. [V1 branch audit](https://github.com/ahmadalwakai/Mohassan-AI/pull/41)', '',
    '| Candidate | Group | V1 delta passes | V1 comparison | V2 result vs product baseline |',
    '| --- | --- | ---: | --- | --- |',
    ...candidates.flatMap(candidate => historicalRows(candidate, subgroupAdjusted, overallAdjusted, measuredAreas)), '',
    '## Shared source datasets', '',
    'The seal is a separately sampled, pinned release. The branches below had prior exposure to some upstream datasets. Exact overlap with the sealed cases remains unverified.', '',
    `- ${code('e2e/follow-up-end-to-end')} inherits PR #35, which used the byte-identical official CANARD test file for its retrospective development and holdout evaluation. V2 also uses that source for follow-up cases. [PR #51](${github}/pull/51) · [PR #35 freeze manifest](${github}/blob/2d171b0dce3ab9eac4721aee0a6b6d0f436d2a64/scripts/conversation-state/decision-eval-freeze.json) · [V2 source pins](../scripts/agent-capability-bench/v2/sources.ts)`,
    `- ${code('feat/scratch-classifiers')} uses first-party linear classifiers trained from zero initialization on human-labelled data. Its data card records CLINC150 at the same pin as v2, the official CANARD test split and MASSIVE v1.0. V2 uses MASSIVE v1.1. Official test splits were used for classifier evaluation after fitting and selection. [PR #47 data card](${github}/blob/76b1a9325a5ef4edda84816cc6523aa06026121e/packages/scratch-classifiers/DATA-CARD.md) · [Model card](${github}/blob/76b1a9325a5ef4edda84816cc6523aa06026121e/packages/scratch-classifiers/MODEL-CARD.md)`,
    `- ${code('e2e/refusal-generalization')} uses CLINC150 at the same pin as v2 and Arabic MASSIVE v1.0. The official test splits were used for classifier evaluation after fitting and calibration. [PR #57 training README](${github}/blob/f1ea533a3a33302b621b9e416c543941ccabbc53/scripts/refusal-classifier/README.md)`, '',
    '## Area and language results', '',
    'Each table uses the same paired cases within the group. Wilson 95% intervals describe each pass proportion. Exact two-sided McNemar p-values use the counts of cases that switched from fail to pass and pass to fail. The per-case paired difference is +1, −1 or 0 for a gain, a loss or an unchanged outcome. Receipts with per-case differences stay in the private measurement workspace.', '',
    `Areas without v2 cases are ${capabilityAreas.filter(area => !measuredAreas.has(area)).map(code).join(', ')}. Arabic and English have different area and source mixes. [V2 coverage and interpretation](CAPABILITY-BENCH-V2-2026-11-25.md#coverage-and-interpretation)`, '',
    '| Baseline group | Passed | Wilson 95% CI |',
    '| --- | ---: | ---: |',
    ...Object.entries(summary.byLanguage).map(([label, group]) => `| ${languageLabel(label)} | ${passCount(group)} | ${interval(group.wilson95)} |`),
    ...Object.entries(summary.byArea).map(([label, group]) => `| ${code(label)} | ${passCount(group)} | ${interval(group.wilson95)} |`), '',
  );
  for (const candidate of measured) {
    const title = candidate.pr ? `#${candidate.pr} ${candidate.branch}` : candidate.branch;
    rows.push(
      '<details>', `<summary>${title}</summary>`, '',
      '| Group | Baseline passed | Candidate passed | Candidate Wilson 95% CI | Delta passes | Delta rate | Newly passing | Newly failing | McNemar p | Holm p |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
      ...subgroupEntries(candidate.comparison).map(([label, group]) =>
        `| ${label} | ${group.baselinePassed}/${group.total} | ${candidateCount(group)} | ${interval(group.candidateWilson95)} | ${signed(group.deltaCount)} | ${deltaPp(group.deltaRate)} | ${group.newlyPassing} | ${group.newlyFailing} | ${pValue(group.log10PValue)} | ${pValue(subgroupAdjusted.get(group)!)} |`),
      '', '</details>', '',
    );
  }
  const unavailable = candidates.filter(candidate => !candidate.run || !candidate.comparison);
  if (unavailable.length || study.absentBranches.length) {
    rows.push('## Unavailable candidates', '',
      ...unavailable.map(candidate => `- ${candidateLabel(candidate)} at ${code(candidate.candidateCommit)}. ${candidate.failure ?? 'No complete sealed receipt.'}`),
      ...study.absentBranches.map(name => `- ${code(name)} was absent from origin when tips were frozen.`), '');
  }
  rows.push(
    '## Frozen settings and execution', '',
    `- Sealed payload SHA-256 ${code(payloadSha256)}`,
    `- Manifest SHA-256 ${code(manifestSha256)}`, '',
    '| Candidate | Origin tip | Scratch merge | Stacked parent | Flags on | Harness adapter |',
    '| --- | --- | --- | --- | --- | --- |',
    ...candidates.map(candidate => {
      const flags = Object.entries(candidate.flags).map(([name, value]) => code(`${name}=${value}`)).join(' ');
      return `| ${candidateLabel(candidate)} | ${code(candidate.candidateCommit)} | ${candidate.mergeCommit ? code(candidate.mergeCommit) : '—'} | ${candidate.stackedOn ? pr(candidate.stackedOn) : '—'} | ${flags || 'Defaults'} | ${candidate.adapter ? code(candidate.adapter) : '—'} |`;
    }), '',
    ...commandBlock(study.commands),
    ...runProvenance('Baseline replay', baseline),
  );
  for (const candidate of candidates) {
    if (candidate.commands?.length) rows.push(`### ${candidate.branch} preparation`, '', ...commandBlock(candidate.commands));
    if (candidate.run) rows.push(...runProvenance(candidate.branch, candidate.run));
  }
  if (study.checks?.length) {
    rows.push('## Verification', '', '| Check | Result |', '| --- | --- |',
      ...study.checks.map(({ command, result }) => `| ${cell(code(command))} | ${cell(result)} |`), '');
  }
  return rows.join('\n');
}
