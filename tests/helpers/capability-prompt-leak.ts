import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
export const capabilityLeakBaseline = 'c2a0ff765071657cf200b5ee7d12fabaad738c0b';

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

export function hasGitObject(spec: string): boolean {
  return spawnSync('git', ['cat-file', '-e', spec], { cwd: root, stdio: 'ignore' }).status === 0;
}

function isBenchmarkFile(path: string): boolean {
  return path.startsWith('scripts/agent-capability-bench/')
    || path.startsWith('tests/fixtures/agent-capability-bench/')
    || /^tests\/agent-capability-(?:corpus|observe|score)\.test\.ts$/u.test(path)
    || /^docs\/AGENT-ROOT-AUDIT-2026-11-25\.(?:md|results\.json)$/u.test(path);
}

function occurrences(source: string, phrase: string): number {
  return source.split(phrase).length - 1;
}

type Input = { id: string; turns: { text: string; fields?: Record<string, string> }[] };

export function readCapabilityInputs(spec: string): Input[] {
  return (JSON.parse(git('show', spec)) as { cases: Input[] }).cases;
}

export function findAddedCapabilityInputs(cases: readonly Input[]): string[] {
  const prompts = cases.flatMap(({ id, turns }) => turns.flatMap(({ text, fields }) =>
    [text, ...Object.values(fields ?? {})].filter(value => value.trim()).flatMap(value => {
      const phrase = value.normalize('NFC');
      return [...new Set([phrase, JSON.stringify(phrase).slice(1, -1)])].map(literal => ({ id, literal }));
    }),
  ));
  if (!prompts.length) throw new Error('The benchmark partition has no chat inputs.');

  const paths = git('ls-files', '-z', '--cached', '--others', '--exclude-standard', '--deduplicate')
    .split('\0').filter(path => path && !isBenchmarkFile(path));
  const baselinePaths = new Set(git('ls-tree', '-r', '--name-only', '-z', capabilityLeakBaseline).split('\0'));
  const leaks: string[] = [];
  for (const path of paths) {
    const filename = resolve(root, path);
    if (!lstatSync(filename, { throwIfNoEntry: false })?.isFile()) continue;
    const bytes = readFileSync(filename);
    if (bytes.includes(0)) continue;
    const source = bytes.toString('utf8').normalize('NFC');
    const matches = prompts.filter(({ literal }) => source.includes(literal));
    if (!matches.length) continue;

    // Ordinary conversational phrases can already occur by chance in the pinned product baseline.
    const baseline = baselinePaths.has(path) ? git('show', `${capabilityLeakBaseline}:${path}`).normalize('NFC') : '';
    for (const { id, literal } of matches) {
      if (occurrences(source, literal) > occurrences(baseline, literal)) leaks.push(`${path} (${id})`);
    }
  }
  return leaks;
}
