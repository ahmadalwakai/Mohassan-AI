import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { z } from 'zod';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixtureRoot = 'tests/fixtures/agent-capability-bench';
const development = join(root, fixtureRoot, 'development.json');
const baseline = '5ccc61789b9a3ba93891897037e0e6b38fa6cd2f';
const benchmarkPaths = new Set([
  'docs/AGENT-ROOT-AUDIT-2026-11-25.md',
  'docs/AGENT-ROOT-AUDIT-2026-11-25.results.json',
  'tests/agent-capability-corpus.test.ts',
  'tests/agent-capability-observe.test.ts',
  'tests/agent-capability-score.test.ts',
]);

const corpusSchema = z.object({
  schemaVersion: z.literal(1),
  cases: z.array(z.object({
    id: z.string().regex(/^[a-z][a-z0-9-]{2,95}$/u),
    turns: z.array(z.object({
      text: z.string(),
      fields: z.record(z.string(), z.string()).optional(),
    })).min(1),
  })).min(1),
});

function normalize(text: string): string {
  return text.normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

function promptsFrom(path: string) {
  try {
    const { cases } = corpusSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    return cases.flatMap(({ id, turns }) => turns.flatMap(({ text, fields }, index) =>
      [text, ...Object.values(fields ?? {})].map(normalize).filter(Boolean).map(prompt => ({ id, turn: index + 1, prompt }))));
  } catch {
    throw new Error('Could not read the capability corpus for the overfitting check.');
  }
}

function occurrences(text: string, prompt: string): number {
  let count = 0;
  for (let at = text.indexOf(prompt); at !== -1; at = text.indexOf(prompt, at + prompt.length)) count++;
  return count;
}

function addedOccurrence(prompt: string, previous: string, working: string, staged = ''): boolean {
  return Math.max(occurrences(working, prompt), occurrences(staged, prompt)) > occurrences(previous, prompt);
}

function git(...args: string[]): Buffer {
  return execFileSync('git', args, { cwd: root, maxBuffer: 16 * 1024 * 1024 });
}

function decode(bytes: Buffer): string {
  if (bytes.includes(0)) return '';
  try {
    return normalize(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return '';
  }
}

function findings(corpusPath: string): string[] {
  const prompts = promptsFrom(corpusPath);
  const paths = new Set(git('ls-files', '--cached', '--others', '--exclude-standard', '-z').toString().split('\0'));
  const unstaged = new Set(git('diff', '--name-only', '--no-renames', '-z').toString().split('\0'));
  const copies: string[] = [];
  for (const path of paths) {
    if (!path || path.startsWith(`${fixtureRoot}/`) || path.startsWith('scripts/agent-capability-bench/') || benchmarkPaths.has(path)) continue;
    const file = join(root, path);
    const working = lstatSync(file, { throwIfNoEntry: false })?.isFile() && realpathSync(file) === file
      ? decode(readFileSync(file)) : '';
    const staged = unstaged.has(path) ? decode(git('cat-file', 'blob', `:${path}`)) : '';
    const candidates = prompts.filter(({ prompt }) => working.includes(prompt) || staged.includes(prompt));
    if (!candidates.length) continue;
    // Some ordinary conversational phrases occur verbatim in the frozen base.
    // Only the original number of occurrences at each original path is allowed.
    const baseEntry = git('--literal-pathspecs', 'ls-tree', '-z', baseline, '--', path).toString();
    const previous = /^[0-7]+ blob /u.test(baseEntry) ? decode(git('cat-file', 'blob', `${baseline}:${path}`)) : '';
    for (const { id, turn, prompt } of candidates) {
      if (addedOccurrence(prompt, previous, working, staged)) copies.push(`${path} (${id}, turn ${turn})`);
    }
  }
  return copies;
}

it('counts extra copies of short and long prompts despite an earlier occurrence', () => {
  const shortPrompt = normalize('Ink!');
  const longPrompt = normalize('How heavy is the red garden shed?');
  const original = normalize(`before ${shortPrompt} and ${longPrompt}`);
  const updated = normalize(`${original}\nINK! how heavy is the red\ngarden shed?`);
  for (const prompt of [shortPrompt, longPrompt]) {
    expect(addedOccurrence(prompt, original, original)).toBe(false);
    expect(addedOccurrence(prompt, original, updated)).toBe(true);
    expect(addedOccurrence(prompt, original, original, updated)).toBe(true);
  }
});

it.skipIf(!existsSync(development))('keeps capability development prompts out of new source', () => {
  expect(findings(development)).toEqual([]);
});

// The final check opts in only after the implementation commit has been frozen.
it.skipIf(process.env.MOHASSAN_CAPABILITY_GUARD_SEALED !== '1')('keeps sealed capability prompts out of new source', () => {
  expect(findings(join(root, fixtureRoot, 'holdout', 'sealed.json')).length).toBe(0);
});
