import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface BenchmarkCaseInput {
  id: string;
  turns: readonly { text: string; fields?: Record<string, string> }[];
}

interface SourceLeak {
  path: string;
  caseId: string;
  turn: number;
}

const benchmarkDirectories = ['scripts/agent-capability-bench/', 'tests/fixtures/agent-capability-bench/'];
const benchmarkTests = new Set([
  'tests/agent-capability-corpus.test.ts',
  'tests/agent-capability-observe.test.ts',
  'tests/agent-capability-score.test.ts',
]);

export function* sourceFiles(root: string): Iterable<readonly [string, string]> {
  const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
  }).split('\0').filter(Boolean);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (const path of new Set(paths)) {
    if (benchmarkDirectories.some(directory => path.startsWith(directory)) || benchmarkTests.has(path)) continue;
    const absolutePath = resolve(root, path);
    if (!lstatSync(absolutePath, { throwIfNoEntry: false })?.isFile()) continue;
    const bytes = readFileSync(absolutePath);
    if (bytes.includes(0)) continue;
    let source: string;
    try {
      source = decoder.decode(bytes);
    } catch (error) {
      if (error instanceof TypeError) continue;
      throw error;
    }
    yield [path, source];
  }
}

function sourceMatch(input: string): (source: string) => boolean {
  const escaped = JSON.stringify(input).slice(1, -1);
  const singleQuoted = input.replaceAll("'", "\\'");
  const template = input.replaceAll('`', '\\`');
  if (input.split(/\s+/u).length > 2) {
    const spellings = [...new Set([input, escaped, singleQuoted, template])];
    return source => spellings.some(spelling => source.includes(spelling));
  }

  // Short expressions occur naturally inside unrelated sentences. Match them as whole utterances.
  const literals = [
    '"' + escaped + '"',
    "'" + singleQuoted + "'",
    '`' + template + '`',
    '“' + input + '”',
    '‘' + input + '’',
    '«' + input + '»',
  ];
  const pattern = input.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const ownLine = new RegExp(`^[ \\t]*${pattern}[ \\t]*\\r?$`, 'mu');
  return source => ownLine.test(source) || literals.some(literal => source.includes(literal));
}

export function findSourceLeaks(cases: readonly BenchmarkCaseInput[], files: Iterable<readonly [string, string]>): SourceLeak[] {
  const checks = cases.flatMap(item => item.turns.flatMap((turn, index) => {
    const inputs = new Set([turn.text, ...Object.values(turn.fields ?? {})].map(value => value.normalize('NFC').trim()));
    return [...inputs].filter(Boolean).map(input => ({ caseId: item.id, turn: index + 1, matches: sourceMatch(input) }));
  }));
  const leaks: SourceLeak[] = [];
  for (const [path, text] of files) {
    const source = text.normalize('NFC');
    for (const { caseId, turn, matches } of checks) {
      if (matches(source)) leaks.push({ path, caseId, turn });
    }
  }
  return leaks;
}
