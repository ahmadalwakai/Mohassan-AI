import { describe, expect, it } from 'vitest';
import {
  assertPublishedBaseline, type BranchReportCandidate, type BranchReportRun, renderBranchReport,
} from '../scripts/agent-capability-bench/by-branch-report.js';
import { compareCapabilityCases } from '../scripts/agent-capability-bench/by-branch-statistics.js';
import { capabilityBaselineCommit, type CapabilityCase } from '../scripts/agent-capability-bench/corpus.js';
import { type CapabilityScore, summarizeCapability } from '../scripts/agent-capability-bench/score.js';

const strata: Array<[CapabilityCase['area'], CapabilityCase['language'], number, number]> = [
  ['small-talk', 'en', 4, 50], ['factual', 'ar', 171, 425], ['factual', 'en', 32, 90], ['follow-up', 'en', 0, 95],
  ['comparison', 'ar', 20, 35], ['comparison', 'en', 20, 35], ['calculation', 'en', 0, 110], ['coding', 'en', 0, 85],
  ['clarification', 'ar', 0, 2], ['clarification', 'en', 0, 15], ['refusal', 'ar', 0, 138], ['refusal', 'en', 0, 120],
];
const baselineScores = strata.flatMap(([area, language, passed, total]) =>
  Array.from({ length: total }, (_, index): CapabilityScore => ({
    id: `private-test-case-${area}-${language}-${index}`, area, language, variety: 'unspecified',
    passed: index < passed, stage: null, failures: [], turns: [], latencyMs: null, setupMs: 0, completedWithFailure: false,
  })));
const hash = (character: string) => character.repeat(64);
const baseline: BranchReportRun = {
  receipt: {
    startedAt: '2026-11-25T01:00:00.000Z', finishedAt: '2026-11-25T01:01:00.000Z',
    runtime: { node: 'v24.22.3', platform: 'linux', architecture: 'x64', timeZone: 'Europe/London' },
    source: {
      gitCommit: capabilityBaselineCommit, trackedWorktreeClean: true, worktreeClean: false,
      baselineVerified: true, lockfileSha256: hash('a'), harnessSha256: { 'observe.ts': hash('b') },
    },
    payloadSha256: hash('c'), manifestSha256: hash('d'), summary: summarizeCapability(baselineScores),
  },
  receiptSha256: hash('e'),
  commands: ['cd /work/baseline', 'node --import tsx collect-paired-outcomes.ts --baseline true'],
};
const baseCommit = 'f'.repeat(40);
const candidateCommit = 'c'.repeat(40);
const mergeCommit = 'd'.repeat(40);
const setupCandidate = (branch: string, pr: number, change: (score: CapabilityScore) => boolean): BranchReportCandidate => {
  const scores = baselineScores.map(score => ({ ...score, passed: change(score) }));
  return {
    branch, pr, flags: { FEATURE_FLAG: '1' }, candidateCommit, mergeCommit,
    run: { ...baseline, receipt: {
      ...baseline.receipt, source: { ...baseline.receipt.source, gitCommit: mergeCommit }, summary: summarizeCapability(scores),
    }, commands: ['FEATURE_FLAG=1 node --import tsx collect-paired-outcomes.ts'] },
    comparison: compareCapabilityCases(baselineScores, scores),
  };
};

describe('v2 branch report', () => {
  it('requires the paired baseline to match published counts, including area-language strata', () => {
    expect(() => assertPublishedBaseline(baseline.receipt)).not.toThrow();
    const { summary } = baseline.receipt;
    const badReceipt = { ...baseline.receipt, summary: { ...summary, byAreaAndLanguage: {
      ...summary.byAreaAndLanguage, 'factual/ar': { ...summary.byAreaAndLanguage['factual/ar'], passed: 172 },
    } } };
    expect(() => assertPublishedBaseline(badReceipt)).toThrow('does not match the published v2 baseline');
  });

  it('ranks paired results, rejects group losses, and flags the shared development source', () => {
    const clean = setupCandidate('feat/gain', 123, score => score.area === 'small-talk' || score.passed);
    const regressed = setupCandidate('feat/regressed', 124, score => score.area === 'factual'
      || (score.area !== 'comparison' && score.passed));
    const exposed = setupCandidate('e2e/follow-up-end-to-end', 51, score => score.area === 'follow-up' || score.passed);
    const report = renderBranchReport({
      baseCommit, baseline, commands: ['git fetch origin'], candidates: [clean, exposed, regressed], absentBranches: [],
    });
    const ranking = report.slice(report.indexOf('## Ranking'), report.indexOf('## Recommended merge set'));
    expect(ranking).toContain('| 1 | [#124]');
    expect(ranking).toContain('| 2 | [#51]');
    expect(ranking).toContain('| 3 | [#123]');
    expect(ranking).toContain('McNemar p | Holm p');
    expect(report).toContain('Recommend `feat/gain`');
    expect(report).toContain('had a significant overall gain and significant losses in `comparison`');
    expect(report).toContain('met the statistical rule. The recommendation is provisional');
    expect(report).toContain('| `comparison` | 40/70 | 0/70 |');
    expect(report).toContain('FEATURE_FLAG=1 node --import tsx');
    expect(report).toContain(mergeCommit);
    expect(report).toContain('Receipt SHA-256');
    expect(report).not.toContain('private-test-case');
  });

  it('distinguishes a weak positive delta, a flat delta, an uncovered area and an unavailable branch', () => {
    const weak = setupCandidate('feat/weak', 123, score => score.passed || score.id === 'private-test-case-small-talk-en-4');
    weak.v1 = {
      comparison: 'v1 development baseline', overall: 10, areas: { 'small-talk': 5, memory: 3, comparison: 2 },
      stackedComparison: { comparison: 'enabled PR #122', overall: 9, areas: {} },
    };
    const skipped: BranchReportCandidate = {
      branch: 'feat/skipped', pr: 124, flags: {}, candidateCommit, failure: 'Setup preflight failed before sealed evaluation.',
      v1: { comparison: 'v1 development baseline', overall: 10, areas: {} },
    };
    const report = renderBranchReport({
      baseCommit, baseline, commands: [], candidates: [weak, skipped], absentBranches: ['integration/wave-1'],
      checks: [{ command: 'npm test -- tests/agent-capability-by-branch-report.test.ts', result: 'Exit 0' }],
    });
    expect(report).toContain('gain below the significance threshold');
    expect(report).toContain('0 passes, 0.00 pp · no gain');
    expect(report).toContain('No v2 cases in this area');
    expect(report).toContain('No completed v2 result');
    expect(report).toContain('enabled PR #122');
    expect(report).toContain('Setup preflight failed before sealed evaluation.');
    expect(report).toContain('`integration/wave-1` was absent from origin');
    expect(report).toContain('## Verification');
    expect(report).not.toContain('Recommend `feat/weak`');
  });

  it('adjusts a nominally significant gain for the frozen family even if another run is unavailable', () => {
    const gains = new Set(baselineScores.filter(score => score.area === 'small-talk' && !score.passed)
      .slice(0, 6).map(score => score.id));
    const borderline = setupCandidate('feat/borderline', 123, score => score.passed || gains.has(score.id));
    const unavailable: BranchReportCandidate = { branch: 'feat/unavailable', flags: {}, candidateCommit };
    const report = renderBranchReport({
      baseCommit, baseline, commands: [], candidates: [borderline, unavailable], absentBranches: [],
    });
    expect(report).toContain('| 6 | 0 | 0.03125 | 0.0625 |');
    expect(report).not.toContain('Recommend `feat/borderline`');
  });
});
