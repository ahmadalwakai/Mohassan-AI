import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error The standalone Node script has no TypeScript declaration.
import { alternativePairs, comparePulls, conflictingFiles, git, inspectPull, migrationCollisions, parseNumstat, parseRemoteRefs, suggestOrder } from '../scripts/pr-merge-map.mjs';

let repo: string;
let base: string;

function write(path: string, content: string) {
  const target = join(repo, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function commit(message: string) {
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', message]);
  return git(repo, ['rev-parse', 'HEAD']).trim();
}

function branch(number: number, name: string, changes: Record<string, string>, from = base) {
  git(repo, ['switch', '-qc', name, from]);
  for (const [path, contents] of Object.entries(changes)) write(path, contents);
  return inspectPull(repo, base, { number, head: commit(name), branches: [name] });
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'pr-merge-map-'));
  git(repo, ['init', '-q', '--initial-branch=base']);
  git(repo, ['config', 'user.name', 'PR Map Fixture']);
  git(repo, ['config', 'user.email', 'pr-map@example.invalid']);
  write('shared.txt', 'base\n');
  write('packages/database/src/index.ts', 'const existing = "101_existing";\n');
  write('apps/server/src/app.ts', 'original\n');
  base = commit('base');
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('PR merge map', () => {
  it('matches every advertised branch by SHA and keeps unmatched PRs', () => {
    const other = branch(2, 'other', { 'other.txt': 'other\n' });
    git(repo, ['update-ref', 'refs/pull/10/head', base]);
    git(repo, ['update-ref', 'refs/pull/2/head', other.head]);
    git(repo, ['branch', 'also-base', base]);
    git(repo, ['switch', '-q', 'base']);
    git(repo, ['branch', '-D', 'other']);
    const { pulls } = parseRemoteRefs(git(repo, ['ls-remote', '.', 'refs/heads/*', 'refs/pull/*/head']));
    expect(pulls.map(({ number, branches }: { number: number; branches: string[] }) => [number, branches])).toEqual([
      [2, []], [10, ['also-base', 'base']],
    ]);
  });

  it('preserves tabs and newlines in paths and marks binary counts unavailable', () => {
    expect(parseNumstat('2\t1\tpath\twith\nseparators\0-\t-\tbinary\0')).toEqual([
      { path: 'path\twith\nseparators', added: 2, removed: 1 },
      { path: 'binary', added: null, removed: null },
    ]);
  });

  it('reads conflicting paths and detects a clean merge', () => {
    const path = 'a file\nwith a newline.txt';
    const seed = branch(10, 'seed', { [path]: 'initial\n' });
    const a = branch(1, 'a', { [path]: 'A\n' }, seed.head);
    const b = branch(2, 'b', { [path]: 'B\n' }, seed.head);
    const c = branch(3, 'c', { 'unrelated.txt': 'C\n' }, seed.head);
    expect(conflictingFiles(repo, a.head, b.head)).toEqual([path]);
    expect(conflictingFiles(repo, a.head, c.head)).toEqual([]);
  });

  it('recognizes commit containment and avoids a separate merge for covered PRs', () => {
    const a = branch(1, 'a', { 'shared.txt': 'A\n' });
    const b = branch(2, 'integration/wave', { 'b.txt': 'B\n' }, a.head);
    const c = branch(3, 'c', { 'shared.txt': 'C\n' });
    const d = branch(4, 'd', { 'd.txt': 'D\n' });
    expect(comparePulls(a, b)).toMatchObject({ aContainsB: false, bContainsA: true });
    const conflicts = [{ a: 2, b: 3, files: conflictingFiles(repo, b.head, c.head) }];
    const { steps, coveredBy } = suggestOrder([a, b, c, d], [{ child: 1, parent: 2 }], conflicts);
    expect(steps.map((step: { number: number; cumulative: number }) => [step.number, step.cumulative])).toEqual([[2, 0], [4, 0], [3, 1]]);
    expect(steps[0].frontier).toEqual(conflicts);
    expect(steps[2].newConflicts).toEqual(conflicts);
    expect([...coveredBy]).toEqual([[1, 2]]);
    expect(suggestOrder([a, b], [{ child: 1, parent: 2 }], [], new Set([2])).steps[0].number).toBe(1);
  });

  it('distinguishes identical patches, overlapping file sets and unrelated changes', () => {
    const common = { '1.txt': 'a\n', '2.txt': 'a\n', '3.txt': 'a\n', '4.txt': 'a\n' };
    const a = branch(1, 'a', common);
    const b = branch(2, 'b', common);
    const c = branch(3, 'c', { ...common, '4.txt': 'different\n', '5.txt': 'extra\n' });
    const d = branch(4, 'd', { 'shared.txt': 'D\n' });
    expect(comparePulls(a, b)).toMatchObject({ duplicate: true, samePatch: true, bContainsA: false });
    expect(comparePulls(a, c)).toMatchObject({ duplicate: true, samePatch: false, overlap: 0.8 });
    expect(comparePulls(a, d)).toMatchObject({ duplicate: false, samePatch: false, overlap: 0 });
  });

  it('finds new migration IDs and groups exact IDs and competing IDs by prefix', () => {
    const a = branch(1, 'a', {
      'packages/database/src/index.ts': 'const existing = "101_existing";\nconst pending = "102_alpha";\n',
      'packages/database/src/migrations/alpha.ts': 'export const version = "102_alpha";\n',
      'packages/database/src/migrations/alpha.test.ts': 'const fixture = "103_fixture";\n',
    });
    const b = branch(2, 'b', { 'packages/skills/src/migration.ts': "const version = '102_beta';\n" });
    const c = branch(3, 'c', { 'packages/database/src/migrations/c.ts': 'const version = `102_alpha`;\n' });
    expect(a.migrations).toEqual(['102_alpha']);
    expect(migrationCollisions([a, b, c])).toEqual([['102', [
      { id: '102_alpha', number: 1 }, { id: '102_beta', number: 2 }, { id: '102_alpha', number: 3 },
    ]]]);
  });

  it('flags held edits above five lines and reports pinned paths and added docs', () => {
    const result = branch(1, 'a', {
      'apps/server/src/app.ts': 'one\ntwo\nthree\nfour\nfive\n',
      'apps/web/components/new.ts': 'one\ntwo\nthree\nfour\nfive\nsix\n',
      'docs/map.md': 'notes\n',
      'packages/execution-model/src/model.ts': 'model\n',
      'packages/execution-pipeline/src/run.ts': 'pipeline\n',
    });
    expect(result).toMatchObject({
      mergeBase: base, added: 14, removed: 1, docs: ['docs/map.md'],
      held: [
        { path: 'apps/server/src/app.ts', added: 5, removed: 1, overLimit: true },
      ],
      newInHeldFolders: ['apps/web/components/new.ts'],
      pinned: ['packages/execution-model/src/model.ts', 'packages/execution-pipeline/src/run.ts'],
    });
    expect(result.files.size).toBe(5);
    expect(result.commits.size).toBe(1);
  });
  it('checks held paths against the fixed snapshot even when the comparison base advances', () => {
    const path = 'packages/browser/src/observed-layout.ts';
    const earlier = branch(1, 'earlier', { [path]: 'later addition\n' });
    const head = branch(2, 'change', { [path]: 'one\ntwo\nthree\nfour\nfive\nsix\n' }, earlier.head);
    expect(inspectPull(repo, earlier.head, head, new Map(), base)).toMatchObject({
      held: [],
      newInHeldFolders: [path],
    });
  });

  it('keeps the named alternative with fewer conflicts against earlier picks', () => {
    const wave = branch(1, 'integration/wave', { 'shared.txt': 'wave\n' });
    const original = branch(2, 'feat/task', { 'shared.txt': 'original\n' });
    const alternative = branch(3, 'feat/task-alt', { 'independent.txt': 'alternative\n' });
    const unmatched = branch(4, 'feat/other-alt', { 'other.txt': 'other\n' });
    const pulls = [wave, original, alternative, unmatched];
    expect(comparePulls(original, alternative).duplicate).toBe(false);
    expect(alternativePairs(pulls)).toEqual([{ a: 2, b: 3 }]);
    const conflicts = [{ a: 1, b: 2, files: conflictingFiles(repo, wave.head, original.head) }];
    expect(conflicts[0].files).toEqual(['shared.txt']);
    const { steps, skippedAlternatives } = suggestOrder(pulls, [], conflicts);
    expect(steps.map((step: { number: number }) => step.number)).toEqual([1, 3, 4]);
    expect(skippedAlternatives).toEqual([{ number: 2, kept: 3, conflicts: 1 }]);
    expect(steps[1].newConflicts).toEqual([]);
    expect(suggestOrder(pulls, [], []).skippedAlternatives).toEqual([{ number: 3, kept: 2, conflicts: 0 }]);
  });

});
