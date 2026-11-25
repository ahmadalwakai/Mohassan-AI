import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixturePath = 'tests/fixtures/agent-capability-bench/';
const developmentPath = join(root, fixturePath, 'development.json');
const benchmarkBaseline = 'c2a0ff765071657cf200b5ee7d12fabaad738c0b';
const inheritedMannersRevision = 'f50520112a23632ec4f6e4a121018077d1c422be';
const inheritedMannersPaths = new Set([
  'apps/server/src/assistant/manners/replies.ts',
  'tests/fixtures/manners-development.ts',
]);
const benchmarkTests = new Set([
  'tests/agent-capability-corpus.test.ts',
  'tests/agent-capability-observe.test.ts',
  'tests/agent-capability-score.test.ts',
]);

type Case = { id: string; turns: { text: string; fields?: Record<string, string> }[] };
type Pattern = { caseId: string; turn: number; text: string };
type Match = { caseId: string; turn: number; line: number; context: string };

function inputPatterns(cases: readonly Case[]): Pattern[] {
  return cases.flatMap(({ id, turns }) => turns.flatMap((turn, index) => {
    const strings = [turn.text, ...Object.values(turn.fields ?? {})].map(text => text.trim()).filter(Boolean);
    const phrases = strings.flatMap(text => text.split(/(?<=[.!?؟;؛])\s+|\n/u)
      .filter(phrase => phrase.split(/\s+/u).length >= 6));
    const spellings = [...strings, ...phrases].flatMap(text => [text, JSON.stringify(text).slice(1, -1)]);
    return [...new Set(spellings)].map(text => ({ caseId: id, turn: index + 1, text }));
  }));
}

function findMatches(contents: string, patterns: readonly Pattern[]): Match[] {
  const matches: Match[] = [];
  for (const { caseId, turn, text } of patterns) {
    for (let start = contents.indexOf(text); start >= 0; start = contents.indexOf(text, start + 1)) {
      const contextStart = start === 0 ? 0 : contents.lastIndexOf('\n', start - 1) + 1;
      const contextEnd = contents.indexOf('\n', start + text.length);
      const context = contents.slice(contextStart, contextEnd < 0 ? contents.length : contextEnd);
      const line = contents.slice(0, start).split('\n').length;
      matches.push({ caseId, turn, line, context });
    }
  }
  return matches;
}

function newMatches(current: readonly Match[], historical: readonly Match[]): Match[] {
  const key = ({ caseId, turn, context }: Match) => JSON.stringify([caseId, turn, context]);
  const counts = new Map<string, number>();
  for (const match of historical) counts.set(key(match), (counts.get(key(match)) ?? 0) + 1);
  return current.filter(match => {
    const id = key(match);
    const count = counts.get(id) ?? 0;
    if (count === 0) return true;
    counts.set(id, count - 1);
    return false;
  });
}

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

describe('capability benchmark leakage', () => {
  it('detects a complete turn, a longer clause, and an escaped turn', () => {
    const sentence = ['Please', 'move', 'the', 'purple', 'abacus', 'upstairs?'].join(' ');
    const text = sentence + '\n"Keep it balanced."';
    const patterns = inputPatterns([{ id: 'example', turns: [{ text }] }]);
    expect(findMatches(text, patterns)).toContainEqual({ caseId: 'example', turn: 1, line: 1, context: text });
    expect(findMatches(sentence, patterns)).toHaveLength(1);
    expect(findMatches(JSON.stringify(text), patterns)).toEqual([
      { caseId: 'example', turn: 1, line: 1, context: JSON.stringify(text) },
      { caseId: 'example', turn: 1, line: 1, context: JSON.stringify(text) },
    ]);
  });

  it('detects additional copies and changed contexts in a historically overlapping file', () => {
    const patterns = inputPatterns([{ id: 'example', turns: [{ text: 'Place the purple abacus upstairs.' }] }]);
    const previous = '// Place the purple abacus upstairs.';
    expect(newMatches(findMatches(previous, patterns), findMatches(previous, patterns))).toEqual([]);
    expect(newMatches(findMatches(`${previous}\n${previous}`, patterns), findMatches(previous, patterns)))
      .toEqual([{ caseId: 'example', turn: 1, line: 2, context: previous }]);
    const changed = 'const request = "Place the purple abacus upstairs.";';
    expect(newMatches(findMatches(changed, patterns), findMatches(previous, patterns)))
      .toEqual([{ caseId: 'example', turn: 1, line: 1, context: changed }]);
  });

  // The corpus is present only in the scratch benchmark merge.
  it.skipIf(!existsSync(developmentPath))('keeps the pinned development inputs out of the source tree', () => {
    const bytes = readFileSync(developmentPath);
    const manifest = JSON.parse(readFileSync(join(root, fixturePath, 'manifest.json'), 'utf8')) as {
      baselineCommit: string; development: { sha256: string; caseCount: number };
    };
    expect(manifest.baselineCommit).toBe(benchmarkBaseline);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(manifest.development.sha256);
    const { cases } = JSON.parse(bytes.toString('utf8')) as { cases: Case[] };
    expect(cases).toHaveLength(manifest.development.caseCount);
    const patterns = inputPatterns(cases);
    const paths = new Set(git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean));
    const historicalPaths = new Set(git(['ls-tree', '-r', '--name-only', '-z', benchmarkBaseline]).split('\0'));
    const copies: string[] = [];
    for (const path of paths) {
      if (path.startsWith(fixturePath) || path.startsWith('scripts/agent-capability-bench/') || benchmarkTests.has(path)) continue;
      const absolute = join(root, path);
      if (!existsSync(absolute) || !lstatSync(absolute).isFile()) continue;
      const contents = readFileSync(absolute, 'utf8');
      if (contents.includes('\0')) continue;
      const matches = findMatches(contents, patterns);
      if (!matches.length) continue;
      // Two ordinary phrases predate the benchmark in a training template and an identity test.
      // Match their exact source contexts and counts so any additional copy still fails.
      // Wave 1 also accepted two reviewed manners files. Their exact original
      // contexts and counts are allowed, and any added occurrence is checked.
      const reference = inheritedMannersPaths.has(path) ? inheritedMannersRevision
        : historicalPaths.has(path) ? benchmarkBaseline : null;
      const historical = reference ? findMatches(git(['show', `${reference}:${path}`]), patterns) : [];
      for (const { caseId, turn, line } of newMatches(matches, historical)) {
        copies.push(`${path}:${line} matches ${caseId} turn ${turn}`);
      }
    }
    expect(copies).toEqual([]);
  });
});
