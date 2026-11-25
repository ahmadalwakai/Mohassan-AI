import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const development = join(root, 'tests/fixtures/agent-capability-bench/development.json');
const base = '2d171b0dce3ab9eac4721aee0a6b6d0f436d2a64';
const benchmarkTests = new Set([
  'tests/agent-capability-corpus.test.ts',
  'tests/agent-capability-observe.test.ts',
  'tests/agent-capability-score.test.ts',
]);

type DevelopmentCase = {
  id: string;
  turns: Array<{ text: string; fields?: Record<string, string> }>;
};

function normalize(text: string): string {
  return text.normalize('NFC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

function countOccurrences(text: string, phrase: string): number {
  let count = 0;
  for (let at = text.indexOf(phrase); at !== -1; at = text.indexOf(phrase, at + 1)) {
    count++;
  }
  return count;
}

function benchmarkPath(path: string): boolean {
  return path.startsWith('tests/fixtures/agent-capability-bench/')
    || path.startsWith('scripts/agent-capability-bench/')
    || benchmarkTests.has(path);
}

it.skipIf(!existsSync(development))('does not introduce frozen development case strings outside the benchmark', () => {
  const { cases } = JSON.parse(readFileSync(development, 'utf8')) as { cases: DevelopmentCase[] };
  const inputs = new Map<string, string>();
  for (const item of cases) {
    for (const [index, turn] of item.turns.entries()) {
      for (const input of [turn.text, ...Object.values(turn.fields ?? {})]) {
        const phrase = normalize(input);
        if (phrase) inputs.set(phrase, `${item.id} turn ${index + 1}`);
      }
    }
  }
  expect(inputs.size).toBeGreaterThan(0);

  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
  }).split('\0');
  const leaks: string[] = [];
  for (const path of new Set(files)) {
    if (!path || benchmarkPath(path)) continue;
    const absolutePath = join(root, path);
    if (!lstatSync(absolutePath, { throwIfNoEntry: false })?.isFile()) continue;
    const bytes = readFileSync(absolutePath);
    if (bytes.includes(0)) continue;
    const text = normalize(bytes.toString('utf8'));
    const matches = [...inputs].filter(([phrase]) => text.includes(phrase));
    if (!matches.length) continue;

    // Some inputs already occur in the base. Count only occurrences introduced by this work.
    const previous = spawnSync('git', ['show', `${base}:${path}`], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: bytes.length * 2 + 1024 * 1024,
    });
    if (previous.error) throw previous.error;
    const baseline = previous.status === 0 ? normalize(previous.stdout) : '';
    for (const [phrase, location] of matches) {
      if (countOccurrences(text, phrase) > countOccurrences(baseline, phrase)) {
        leaks.push(`${location} in ${path}`);
      }
    }
  }
  expect(leaks).toEqual([]);
});
