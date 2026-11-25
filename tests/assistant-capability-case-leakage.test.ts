import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { findSourceLeaks, sourceFiles, type BenchmarkCaseInput } from './helpers/capability-case-leakage.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const developmentPath = 'tests/fixtures/agent-capability-bench/development.json';
const frozenRevision = 'a258b3d47e39b5a2c03c71d4a9eb01107ae3d97f';
const developmentSha256 = '712a170d3d60c6aec41f9fe44e7d5cc222bbafbe28d9ca763b5f396db2d2410b';

function frozenDevelopment(): Buffer | undefined {
  const path = resolve(root, developmentPath);
  if (existsSync(path)) return readFileSync(path);
  // The feature branch does not contain the benchmark. Use its pinned object when already fetched.
  const object = `${frozenRevision}:${developmentPath}`;
  try {
    return execFileSync('git', ['show', object], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return undefined;
  }
}

it('detects pasted inputs while allowing a short greeting inside an unrelated sentence', () => {
  const cases = [{ id: 'synthetic', turns: [
    { text: 'Look alive!' },
    { text: 'Can you sort the wooden bookmarks by colour?', fields: { folder: 'مستندات الورشة القديمة' } },
  ] }];
  expect(findSourceLeaks(cases, [
    ['ordinary-prose.md', 'Look alive! Your next clue is in the upstairs room.'],
    ['copied-greeting.ts', "const example = 'Look alive!';"],
    ['copied-prompt.md', 'A user asked: Can you sort the wooden bookmarks by colour? Then they waited.'],
    ['copied-field.json', '{"folder":"مستندات الورشة القديمة"}'],
  ])).toEqual([
    { path: 'copied-greeting.ts', caseId: 'synthetic', turn: 1 },
    { path: 'copied-prompt.md', caseId: 'synthetic', turn: 2 },
    { path: 'copied-field.json', caseId: 'synthetic', turn: 2 },
  ]);
});

const development = frozenDevelopment();
it.skipIf(!development)('keeps the frozen development prompts and field values out of the source tree', () => {
  expect(createHash('sha256').update(development!).digest('hex')).toBe(developmentSha256);
  const { cases } = JSON.parse(development!.toString('utf8')) as { cases: BenchmarkCaseInput[] };
  expect(findSourceLeaks(cases, sourceFiles(root))).toEqual([]);
});
