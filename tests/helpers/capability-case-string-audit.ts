import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

type CapabilityCorpus = {
  cases: { id: string; turns: { text: string; fields?: Record<string, string> }[] }[];
};

export const benchmarkFixtures = 'tests/fixtures/agent-capability-bench/';
const benchmarkTests = new Set([
  'tests/agent-capability-corpus.test.ts',
  'tests/agent-capability-observe.test.ts',
  'tests/agent-capability-score.test.ts',
]);
// Existing overlaps on e3cc45d are permitted only in the original file bytes.
const baselineOverlaps = new Map([
  ['scripts/chat-training/build_dataset.py', {
    sha256: 'bfd50191741c2eaa00f32892037e08a68fb13e7c9a27155f039bf9d65e16cc91',
    location: 'dev-small-talk-010 turn 1 text',
  }],
  ['tests/assistant-selection-answer-types.test.ts', {
    sha256: '0a9fde5c4444f881ce5fab9ea3d62553ed3c4c937c67b9ca05c6acdf7107a7fc',
    location: 'dev-follow-up-049 turn 1 text',
  }],
  ['tests/mind-limits.test.ts', {
    sha256: 'a389c25083088aec136dcc61ab1a9ddfdd941abb00a4424fbf4b26a1cc4c090e',
    location: 'dev-small-talk-014 turn 1 text',
  }],
]);

export const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

function caseStrings({ cases }: CapabilityCorpus): Map<string, string> {
  const strings = new Map<string, string>();
  for (const { id, turns } of cases) {
    for (const [index, { text, fields }] of turns.entries()) {
      for (const [label, value] of [['text', text], ...Object.entries(fields ?? {})]) {
        if (!value.trim()) continue;
        const jsonString = JSON.stringify(value).slice(1, -1);
        const singleQuoted = jsonString.replace(/\\"/gu, '"').replace(/'/gu, "\\'");
        const location = `${id} turn ${index + 1} ${label}`;
        for (const form of [value, jsonString, singleQuoted]) strings.set(form.normalize('NFC'), location);
      }
    }
  }
  return strings;
}

function sourcePaths(root: string): string[] {
  const gitPaths = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
  });
  return [...new Set(gitPaths.split('\0'))].filter(path => path
    && !path.startsWith(benchmarkFixtures)
    && !path.startsWith('scripts/agent-capability-bench/')
    && !benchmarkTests.has(path));
}

function sourceFile(absolutePath: string): { bytes: Buffer; text: string } | undefined {
  if (!lstatSync(absolutePath, { throwIfNoEntry: false })?.isFile()) return undefined;
  const bytes = readFileSync(absolutePath);
  if (bytes.includes(0)) return undefined;
  try {
    return { bytes, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes).normalize('NFC') };
  } catch {
    return undefined;
  }
}

export function caseStringsInSource(root: string, corpus: Buffer): string[] {
  const strings = caseStrings(JSON.parse(corpus.toString('utf8')) as CapabilityCorpus);
  if (!strings.size) throw new Error('The corpus has no auditable case strings.');
  const matches: string[] = [];
  for (const path of sourcePaths(root)) {
    const source = sourceFile(join(root, path));
    if (source === undefined) continue;
    const overlap = baselineOverlaps.get(path);
    const allowedLocation = overlap && sha256(source.bytes) === overlap.sha256 ? overlap.location : undefined;
    for (const [value, location] of strings) {
      if (location === allowedLocation) continue;
      const start = source.text.indexOf(value);
      if (start >= 0) {
        const line = source.text.slice(0, start).split('\n').length;
        matches.push(`${path}:${line} contains ${location}`);
      }
    }
  }
  return matches;
}
