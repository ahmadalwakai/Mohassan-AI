import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inheritedCapabilitySourceRevisions } from './inherited-capability-sources.js';

const root = resolve(import.meta.dirname, '../..');
const baseRevision = '5ccc61789b9a3ba93891897037e0e6b38fa6cd2f';

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function canonical(text: string): string {
  return text.normalize('NFC').replaceAll('\r\n', '\n');
}

function literalForms(text: string): string[] {
  const literal = canonical(text);
  const json = JSON.stringify(literal).slice(1, -1);
  const unquoted = json.replaceAll('\\"', '"');
  const singleQuote = unquoted.replaceAll("'", "\\'");
  const template = unquoted.replaceAll('`', '\\`').replaceAll('${', '\\${');
  return [...new Set([literal, json, singleQuote, template])];
}

function isBenchmarkPath(path: string): boolean {
  return path.startsWith('scripts/agent-capability-bench/') || path.startsWith('tests/fixtures/agent-capability-bench/');
}

function addsLiteral(source: string, previous: string, literal: string): boolean {
  return source.split(literal).length > previous.split(literal).length;
}

export function addsInputLiteral(source: string, previous: string, input: string): boolean {
  return literalForms(input).some(literal => addsLiteral(source, previous, literal));
}

type Corpus = { cases: { id: string; turns: { text: string; fields?: Record<string, string> }[] }[] };

export function scanCapabilityCorpus(path: string) {
  const corpus = JSON.parse(readFileSync(path, 'utf8')) as Corpus;
  const inputs = corpus.cases.flatMap(({ id, turns }) => turns.flatMap(({ text, fields }, index) =>
    [text, ...Object.values(fields ?? {})].filter(input => input.trim()).map(input =>
      ({ id, turn: index + 1, forms: literalForms(input) }))));
  if (!inputs.length) throw new Error('The capability corpus has no text inputs.');

  const sourcePaths = new Set(git('ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0'));
  const basePaths = new Set(git('ls-tree', '-rz', '--name-only', baseRevision).split('\0'));
  const leaks: { path: string; id: string; turn: number }[] = [];
  for (const path of sourcePaths) {
    if (!path || isBenchmarkPath(path)) continue;
    const sourcePath = resolve(root, path);
    if (!lstatSync(sourcePath, { throwIfNoEntry: false })?.isFile()) continue;
    const bytes = readFileSync(sourcePath);
    if (bytes.includes(0)) continue;
    const source = canonical(bytes.toString('utf8'));
    const found = inputs.filter(input => input.forms.some(form => source.includes(form)));
    if (!found.length) continue;

    // Preserve unrelated literals already present at the base. A new path or additional copy still fails.
    const reference = inheritedCapabilitySourceRevisions.get(path) ?? (basePaths.has(path) ? baseRevision : null);
    const previous = reference ? canonical(git('show', `${reference}:${path}`)) : '';
    for (const { id, turn, forms } of found) {
      if (forms.some(form => addsLiteral(source, previous, form))) leaks.push({ path, id, turn });
    }
  }
  return { cases: corpus.cases.length, inputs: inputs.length, leaks };
}

// The sealed audit supplies its corpus path explicitly, after the feature commit is frozen.
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const [path, ...extra] = process.argv.slice(2);
  if (!path || extra.length) {
    console.error('Pass one capability corpus path.');
    process.exitCode = 2;
  } else {
    const result = scanCapabilityCorpus(path);
    console.log(JSON.stringify(result));
    process.exitCode = result.leaks.length ? 1 : 0;
  }
}
