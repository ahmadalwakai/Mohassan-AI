import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtureDirectory = 'tests/fixtures/agent-capability-bench/';
export const capabilityDevelopmentFixture = fixtureDirectory + 'development.json';
const benchmarkFiles = new Set([
  'docs/AGENT-ROOT-AUDIT-2026-11-25.md',
  'docs/AGENT-ROOT-AUDIT-2026-11-25.results.json',
  'tests/agent-capability-corpus.test.ts',
  'tests/agent-capability-observe.test.ts',
  'tests/agent-capability-score.test.ts',
]);

// These lines predate the clarification work. Allow one exact occurrence of each
// without storing the prompt, so a copy or change still fails the guard.
const inheritedMatches = [
  {
    path: 'scripts/chat-training/build_dataset.py',
    id: 'dev-small-talk-010',
    turn: 1,
    lineHash: 'eb437e663a9617e79094235e9c3434a3d75b5793d607c53af6ae78ced744d789',
  },
  {
    path: 'tests/mind-limits.test.ts',
    id: 'dev-small-talk-014',
    turn: 1,
    lineHash: '20a7d1fea93d473e1d8ca0f3d71a932603f91e7472723ad082e97c6c5d37add3',
  },
];

type CorpusCase = {
  id: string;
  turns: { text: string; fields?: Record<string, string> }[];
};

function literalVariants(value: string): string[] {
  const text = value.trim().normalize('NFC');
  if (!text) return [];
  const quoted = JSON.stringify(text).slice(1, -1);
  const unquoted = quoted.replaceAll('\\\"', '"');
  return [...new Set([
    text,
    quoted,
    unquoted.replaceAll("'", "\\'"),
    unquoted.replaceAll('`', '\\`').replaceAll('${', '\\${'),
  ])];
}

function matchOffsets(source: string, variants: string[]): Set<number> {
  const offsets = new Set<number>();
  for (const variant of variants) {
    let offset = source.indexOf(variant);
    while (offset !== -1) {
      offsets.add(offset);
      offset = source.indexOf(variant, offset + 1);
    }
  }
  return offsets;
}

function matchKey(path: string, id: string, turn: number, lineHash: string): string {
  return JSON.stringify([path, id, turn, lineHash]);
}

export function findCapabilityInputLeaks(root: string, cases: CorpusCase[]): string[] {
  const files = new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  }).split('\0'));
  const needles = cases.flatMap(item => item.turns.flatMap((turn, index) =>
    [turn.text, ...Object.values(turn.fields ?? {})].map(value => ({
      id: item.id,
      turn: index + 1,
      variants: literalVariants(value),
    })).filter(needle => needle.variants.length > 0),
  ));
  const allowances = new Set(inheritedMatches.map(match => matchKey(match.path, match.id, match.turn, match.lineHash)));
  const leaks: string[] = [];

  for (const path of files) {
    if (!path || path.startsWith(fixtureDirectory) || path.startsWith('scripts/agent-capability-bench/') || benchmarkFiles.has(path)) continue;
    const absolute = join(root, path);
    if (!lstatSync(absolute, { throwIfNoEntry: false })?.isFile()) continue;
    const bytes = readFileSync(absolute);
    if (bytes.includes(0)) continue;
    const source = bytes.toString('utf8').normalize('NFC');
    for (const needle of needles) {
      for (const offset of matchOffsets(source, needle.variants)) {
        const before = source.slice(0, offset);
        const start = before.lastIndexOf('\n') + 1;
        const end = source.indexOf('\n', offset);
        const line = source.slice(start, end === -1 ? source.length : end).replace(/\r$/, '');
        const lineHash = createHash('sha256').update(line).digest('hex');
        if (allowances.delete(matchKey(path, needle.id, needle.turn, lineHash))) continue;
        const lineNumber = before.split('\n').length;
        leaks.push(`${path}:${lineNumber} (${needle.id}, turn ${needle.turn})`);
      }
    }
  }
  return leaks.sort();
}

export function findCapabilityPartitionLeaks(root: string, partition: 'development' | 'sealed'): string[] {
  const fixture = partition === 'development' ? capabilityDevelopmentFixture : fixtureDirectory + 'holdout/sealed.json';
  const corpus = JSON.parse(readFileSync(join(root, fixture), 'utf8')) as { cases: CorpusCase[] };
  if (!corpus.cases.length) throw new Error(`No capability cases found in the ${partition} fixture.`);
  return findCapabilityInputLeaks(root, corpus.cases);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== '--sealed') {
    throw new Error('Pass --sealed to check the sealed inputs after freezing the implementation.');
  }
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const leaks = findCapabilityPartitionLeaks(root, 'sealed');
  if (leaks.length) throw new Error(`Sealed capability inputs outside the benchmark:\n${leaks.join('\n')}`);
  console.log('No sealed capability inputs found outside the benchmark.');
}
