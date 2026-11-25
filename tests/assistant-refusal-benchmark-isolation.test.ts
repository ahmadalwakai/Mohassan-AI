import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

type BenchmarkCorpus = {
  cases: {
    id: string;
    turns: {
      text: string;
      fields?: Record<string, string>;
      expect: { requiredContent: { match: 'literal' | 'number'; anyOf: string[] }[] };
    }[];
  }[];
};

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = 'tests/fixtures/agent-capability-bench/development.json';
const benchmarkRef = `origin/feat/agent-capability-bench:${fixture}`;
const fixturePath = join(root, fixture);
const hasLocalFixture = existsSync(fixturePath);
const hasDevelopmentCorpus = hasLocalFixture || spawnSync('git', ['cat-file', '-e', benchmarkRef], {
  cwd: root,
  stdio: 'ignore',
}).status === 0;
const benchmarkPaths = /^(?:scripts\/agent-capability-bench\/|tests\/fixtures\/agent-capability-bench\/|tests\/agent-capability-(?:corpus|observe|score)\.test\.ts$|docs\/AGENT-ROOT-AUDIT-2026-11-25\.(?:md|results\.json)$)/u;

function benchmarkStrings(corpus: BenchmarkCorpus) {
  const strings: { id: string; turn: number; field: string; pattern: RegExp }[] = [];
  for (const item of corpus.cases) {
    for (const [index, turn] of item.turns.entries()) {
      const fields = [['text', turn.text], ...Object.entries(turn.fields ?? {})];
      // The scoring rules use fragments and numbers. Check sentence-length literal alternatives.
      for (const assertion of turn.expect.requiredContent) {
        if (assertion.match !== 'literal') continue;
        for (const value of assertion.anyOf) {
          if (value.trim().split(/\s+/u).length >= 4 && /[.!?؟。]$/u.test(value.trim())) {
            fields.push(['requiredContent', value]);
          }
        }
      }
      for (const [field, text] of fields) {
        const value = text.trim().normalize('NFC');
        if (!value) continue;
        const encoded = JSON.stringify(value).slice(1, -1);
        const alternatives = new Set([value, encoded, encoded.replace(/\\"/gu, '"').replace(/'/gu, "\\'")]);
        const escaped = [...alternatives].map(variant => variant.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|');
        // A short utterance can be a fragment of unrelated prose. Match it as a complete literal or line.
        const delimiter = "[\"'`|~]";
        const source = value.length >= 20 ? escaped : `(?:^\\s*|${delimiter})(?:${escaped})(?=\\s*$|${delimiter})`;
        strings.push({ id: item.id, turn: index + 1, field, pattern: new RegExp(source, 'mu') });
      }
    }
  }
  return strings;
}

// The frozen benchmark fixtures are available in the scratch merge or from its fetched ref.
it.skipIf(!hasDevelopmentCorpus)('keeps capability benchmark strings out of repository source', () => {
  const corpus = JSON.parse(hasLocalFixture ? readFileSync(fixturePath, 'utf8')
    : execFileSync('git', ['show', benchmarkRef], { cwd: root, encoding: 'utf8' })) as BenchmarkCorpus;
  const strings = benchmarkStrings(corpus);
  expect(strings.length).toBeGreaterThan(0);
  const files = new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
  }).split('\0').filter(Boolean));
  const matches: string[] = [];
  for (const path of files) {
    if (benchmarkPaths.test(path)) continue;
    const absolute = join(root, path);
    if (!lstatSync(absolute, { throwIfNoEntry: false })?.isFile()) continue;
    const bytes = readFileSync(absolute);
    if (bytes.includes(0)) continue;
    const source = bytes.toString('utf8').normalize('NFC');
    for (const { id, turn, field, pattern } of strings) {
      if (pattern.test(source)) matches.push(`${path}: ${id}, turn ${turn}, ${field}`);
    }
  }
  expect(matches).toEqual([]);
});
