import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixtureDirectory = 'tests/fixtures/agent-capability-bench/';
const developmentPath = join(root, fixtureDirectory, 'development.json');

type Corpus = {
  cases: { id: string; turns: { text: string; fields?: Record<string, string> }[] }[];
};

type Manifest = {
  baselineCommit: string;
  development: { sha256: string; caseCount: number };
};

type CaseInput = { id: string; turn: number; text: string; pattern: RegExp };

function git(args: string[]): Buffer {
  return execFileSync('git', args, { cwd: root, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

function sourceText(bytes: Buffer): string {
  if (bytes.includes(0)) return '';
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).normalize('NFC');
  } catch (error) {
    if (error instanceof TypeError) return '';
    throw error;
  }
}

function searchText(value: string): string {
  return value.normalize('NFC').toLowerCase().trim().replace(/\s+/gu, ' ');
}

function caseInputs({ cases }: Corpus): CaseInput[] {
  const inputs: CaseInput[] = [];
  for (const { id, turns } of cases) {
    for (const [index, turn] of turns.entries()) {
      for (const value of [turn.text, ...Object.values(turn.fields ?? {})]) {
        const text = searchText(value);
        if (!text) continue;
        const pattern = text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replaceAll(' ', '\\s+');
        inputs.push({ id, turn: index + 1, text, pattern: new RegExp(pattern, 'giu') });
      }
    }
  }
  return inputs;
}

function contexts(source: string, pattern: RegExp) {
  return [...source.matchAll(pattern)].map(match => {
    const start = source.lastIndexOf('\n', match.index - 1) + 1;
    const end = source.indexOf('\n', match.index + match[0].length);
    return {
      line: source.slice(0, start).split('\n').length,
      text: source.slice(start, end < 0 ? source.length : end),
    };
  });
}

// The frozen fixture is available in the benchmark worktree.
it.skipIf(!existsSync(developmentPath))('keeps capability case inputs out of project sources', () => {
  const manifest = JSON.parse(readFileSync(join(root, fixtureDirectory, 'manifest.json'), 'utf-8')) as Manifest;
  const development = readFileSync(developmentPath);
  const corpus = JSON.parse(development.toString('utf-8')) as Corpus;
  expect(createHash('sha256').update(development).digest('hex')).toBe(manifest.development.sha256);
  expect(corpus.cases).toHaveLength(manifest.development.caseCount);
  expect(manifest.baselineCommit).toMatch(/^[a-f0-9]{40}$/u);
  const inputs = caseInputs(corpus);
  expect(inputs.length).toBeGreaterThanOrEqual(corpus.cases.length);

  const baselinePaths = new Set(git(['ls-tree', '-r', '-z', '--name-only', manifest.baselineCommit]).toString('utf-8').split('\0'));
  const paths = new Set(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).toString('utf-8').split('\0'));
  const copies: string[] = [];
  for (const path of paths) {
    if (!path || path.startsWith(fixtureDirectory) || path.startsWith('scripts/agent-capability-bench/')) continue;
    const absolute = join(root, path);
    if (!lstatSync(absolute, { throwIfNoEntry: false })?.isFile()) continue;
    const source = sourceText(readFileSync(absolute));
    const searchable = searchText(source);
    const present = inputs.filter(input => searchable.includes(input.text));
    if (present.length === 0) continue;

    // Allow unchanged source lines already present at the frozen baseline, including ordinary greetings.
    const baseline = baselinePaths.has(path) ? sourceText(git(['show', `${manifest.baselineCommit}:${path}`])) : '';
    for (const { id, turn, pattern } of present) {
      const existing = contexts(baseline, pattern).map(context => context.text);
      for (const context of contexts(source, pattern)) {
        const index = existing.indexOf(context.text);
        if (index >= 0) existing.splice(index, 1);
        else copies.push(`${path}:${context.line} matches ${id} turn ${turn}`);
      }
    }
  }
  expect(copies).toEqual([]);
});
