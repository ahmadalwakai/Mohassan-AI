import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
// @ts-expect-error The standalone Node entry point has no TypeScript declaration.
import { adaptObserver, combinedOrder, experimentPlan, extractSummaries, flagValues, inspectMerge, pendingExperiments } from '../scripts/agent-capability-bench/by-branch.mjs';

it('reports clean merge trees and conflict paths without changing the current checkout', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'capability-merge-test-'));
  onTestFinished(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', [
    '-c', 'user.name=Capability test', '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null', ...args,
  ], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const shared = join(cwd, 'shared file.txt');
  const commit = (name: string, content: string) => {
    writeFileSync(join(cwd, name), content);
    git('add', '--', name);
    git('commit', '-m', content);
    return git('rev-parse', 'HEAD');
  };

  git('init', '-b', 'base');
  commit('shared file.txt', 'base');
  git('switch', '-c', 'left');
  const left = commit('shared file.txt', 'left');
  git('switch', '-c', 'right', 'base');
  const right = commit('shared file.txt', 'right');
  git('switch', '-c', 'disjoint', 'base');
  const disjoint = commit('new.txt', 'new');
  writeFileSync(shared, 'uncommitted');

  const clean = inspectMerge(cwd, left, disjoint);
  expect(clean.files).toEqual([]);
  expect(git('show', `${clean.tree}:shared file.txt`)).toBe('left');
  expect(git('show', `${clean.tree}:new.txt`)).toBe('new');

  const conflict = inspectMerge(cwd, left, right);
  expect(conflict.files).toEqual(['shared file.txt']);
  expect(conflict.command).toEqual(['git', 'merge-tree', '--write-tree', '--name-only', '--no-messages', left, right]);
  expect(git('rev-parse', 'HEAD')).toBe(disjoint);
  expect(readFileSync(shared, 'utf8')).toBe('uncommitted');
});

it('prioritizes the largest pairwise-compatible group and retains excluded candidates for cumulative attempts', () => {
  const branches = ['first', 'second', 'third', 'fourth'].map(branch => ({ branch }));
  const conflicts = branches.slice(1).map(({ branch }) => ({ first: 'first', second: branch }));
  expect(combinedOrder(branches, conflicts).map(({ branch }: { branch: string }) => branch)).toEqual([
    'second', 'third', 'fourth', 'first',
  ]);
  expect(combinedOrder(branches.slice(0, 2), conflicts.slice(0, 1))).toEqual(branches.slice(0, 2));
});

const compiler = { pr: 24, branch: 'feat/plan-compiler', flag: 'MOHASSAN_PLAN_COMPILER', off: 'off', on: 'on' };
const feedback = { pr: 30, branch: 'feat/feedback-loop' };
const browser = { pr: 34, branch: 'feat/browser-hands-2', flag: 'CommandChatConfig.browserHands', off: 'unset', on: 'on', adapter: 'browser' };

it('schedules development off before a single enabled holdout and skips an unavailable off setting', () => {
  const plan: { name: string; setting: string; sealed: boolean; branches: object[] }[] = experimentPlan([compiler, feedback, browser], [compiler, feedback]);
  expect(plan.map(({ name, setting, sealed }) => [name, setting, sealed])).toEqual([
    ['baseline', 'off', true],
    ['pr-24-off', 'off', false],
    ['pr-24-on', 'on', true],
    ['pr-30-on', 'on', true],
    ['pr-34-off', 'off', false],
    ['pr-34-on', 'on', true],
    ['combined', 'on', true],
  ]);
  expect(plan.at(-1)?.branches).toEqual([compiler, feedback]);
  expect(experimentPlan([compiler], []).some(({ name }: { name: string }) => name === 'combined')).toBe(false);
});

it('records exact environment and controller flag values for each configuration', () => {
  expect(flagValues([compiler, feedback, browser], 'off')).toEqual({
    MOHASSAN_PLAN_COMPILER: 'off', 'CommandChatConfig.browserHands': 'unset',
  });
  expect(flagValues([compiler, feedback, browser], 'on')).toEqual({
    MOHASSAN_PLAN_COMPILER: 'on', 'CommandChatConfig.browserHands': 'on',
  });
  expect(flagValues([feedback], 'on')).toEqual({});
});

it('preserves successful and failed holdout attempts when extending the measurement', () => {
  const baseline = { name: 'baseline', commit: 'base', sealed: true, setting: 'off', branches: [] };
  const compilerOn = { name: 'pr-24-on', commit: 'compiler-merge', sealed: true, setting: 'on', branches: [compiler] };
  const browserOff = { name: 'pr-34-off', commit: 'browser-merge', sealed: false, setting: 'off', branches: [browser] };
  const browserOn = { ...browserOff, name: 'pr-34-on', sealed: true, setting: 'on' };
  const combined = { name: 'combined-new', commit: 'combined-merge', sealed: true, setting: 'on', branches: [compiler, browser] };
  const existing = [
    { name: 'baseline', commit: 'base', sealed: true, flags: {}, exitCode: 0 },
    { name: 'pr-24-on', commit: 'compiler-merge', sealed: true, flags: { MOHASSAN_PLAN_COMPILER: 'on' }, exitCode: 1 },
    { name: 'combined', commit: 'older-combined-merge', sealed: true, flags: { MOHASSAN_PLAN_COMPILER: 'on' }, exitCode: 0 },
  ];

  expect(pendingExperiments([baseline, compilerOn, browserOff, browserOn, combined], existing))
    .toEqual([browserOff, browserOn, combined]);
});

it('rejects recorded experiments with a different revision, partition or flag value', () => {
  const experiment = { name: 'pr-24-on', commit: 'compiler-merge', sealed: true, setting: 'on', branches: [compiler] };
  const existing = { name: experiment.name, commit: experiment.commit, sealed: true, flags: { MOHASSAN_PLAN_COMPILER: 'on' } };
  for (const mismatch of [
    { commit: 'other-merge' },
    { sealed: false },
    { flags: { MOHASSAN_PLAN_COMPILER: 'off' } },
  ]) {
    expect(() => pendingExperiments([experiment], [{ ...existing, ...mismatch }]))
      .toThrow('Recorded run pr-24-on does not match the pinned experiment.');
  }
});

const observer = readFileSync(new URL('../scripts/agent-capability-bench/observe.ts', import.meta.url), 'utf8');

it('leaves the recorded observer untouched for direct settings and changes only the browser config when on', () => {
  expect(adaptObserver(observer, [compiler], 'on')).toBe(observer);
  expect(adaptObserver(observer, [browser], 'off')).toBe(observer);
  const on = adaptObserver(observer, [browser], 'on');
  expect(on).not.toBe(observer);
  expect(on.replace("browserHands: 'on', ", '')).toBe(observer);
});

it('wires truth, review, memory and desktop clarification without changing fixture ports', () => {
  const branches = ['truth', 'review', 'memory', 'clarification'].map(adapter => ({ adapter }));
  const adapted = adaptObserver(observer, branches, 'on');
  expect(adapted).toMatch(/truthEnabled: process\.env\.MOHASSAN_JUDGE_TRUTH === '1'/);
  expect(adapted).toMatch(/import \{ conversationReviewForJudge \} from '\.\.\/\.\.\/apps\/server\/src\/assistant\/review\/publication\.js'/);
  expect(adapted).toMatch(/conversationReviewForJudge\(input, verdict, applied\);\s+return verdict;/);
  expect(adapted).toMatch(/await memoryMigration\(database\.db\);\s+await migrateStructuredMemory\(database\.db\);/);
  expect(adapted).toMatch(/parse: text => clarifyDesktopFile\(text, parseDesktopCommand\), describe: describeDesktopCommand/);
  expect(adapted).toContain("...web, tools, recordExperiences: false, models: { fast: [], deep: [], vision: '' }, fetch: refuseFetch,");
  expect(adaptObserver(observer, branches, 'off')).toBe(adapted);
  for (const invalid of ['', observer + observer]) {
    expect(() => adaptObserver(invalid, [browser], 'on')).toThrow(/frozen observer no longer matches/);
  }
});

it('sets the deliberation controller flag and reuses the case-local memory evidence reader', () => {
  const deliberation = {
    branch: 'feat/deliberation-core', adapter: 'deliberation', flag: 'CommandChatConfig.deliberationEnabled',
    off: 'false', on: 'true',
  };
  const off = adaptObserver(observer, [deliberation], 'off');
  const on = adaptObserver(observer, [deliberation], 'on');
  expect(off).toContain('deliberationEnabled: false, deliberationMemoryHit: createMemoryHitReader(memory)');
  expect(on).toContain('deliberationEnabled: true, deliberationMemoryHit: createMemoryHitReader(memory)');
  expect(on.replace('deliberationEnabled: true', 'deliberationEnabled: false')).toBe(off);
  expect(flagValues([deliberation], 'off')).toEqual({ 'CommandChatConfig.deliberationEnabled': 'false' });
  expect(flagValues([deliberation], 'on')).toEqual({ 'CommandChatConfig.deliberationEnabled': 'true' });
});

function result(sealed = true, adapted = false) {
  const expected = {
    commit: 'scratch-commit', sealed, adapted, lockfileSha256: 'locked',
    manifest: {
      baselineCommit: 'product-base',
      development: { sha256: 'development-hash', caseCount: 2, arabicCount: 1 },
      sealed: { sha256: 'sealed-hash', caseCount: 2, arabicCount: 1 },
    },
  };
  const summary = { overall: { passed: 1, total: 2 }, byLanguage: { ar: { passed: 1, total: 1 } } };
  const report = {
    schemaVersion: 1,
    source: { gitCommit: expected.commit, lockfileSha256: expected.lockfileSha256, worktreeClean: !adapted },
    manifest: structuredClone(expected.manifest),
    sealedIncluded: sealed,
    splits: [
      { name: 'development', summary: structuredClone(summary) },
      ...(sealed ? [{ name: 'sealed', summary: structuredClone(summary) }] : []),
    ],
  };
  return { report, expected, summary };
}

it('extracts only the summaries for the planned splits and accepts known observer instrumentation', () => {
  const accepted = result(true, true);
  expect(extractSummaries(accepted.report, accepted.expected)).toEqual({
    development: accepted.summary, sealed: accepted.summary,
  });
  const developmentOnly = result(false);
  expect(extractSummaries(developmentOnly.report, developmentOnly.expected)).toEqual({
    development: developmentOnly.summary,
  });
});

it('rejects reports from a different commit, lockfile, instrumentation or corpus partition', () => {
  const { report, expected } = result();
  const changes: ((other: typeof report) => void)[] = [
    other => { other.source.gitCommit = 'another-commit'; },
    other => { other.source.lockfileSha256 = 'another-lockfile'; },
    other => { other.source.worktreeClean = false; },
    other => { other.sealedIncluded = false; },
    other => { other.splits.pop(); },
    other => { other.manifest.baselineCommit = 'another-baseline'; },
    other => { other.manifest.sealed.sha256 = 'another-holdout'; },
    other => { other.splits[1].summary.overall.total = 1; },
    other => { other.splits[1].summary.byLanguage.ar.total = 0; },
  ];
  for (const change of changes) {
    const other = structuredClone(report);
    change(other);
    expect(() => extractSummaries(other, expected)).toThrow(/Runner report does not match/);
  }
});
