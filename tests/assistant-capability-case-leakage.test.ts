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

// The reviewed small-talk merge f50520112a23632ec4f6e4a121018077d1c422be
// contains one inherited reply literal on this exact source line. Its UTF-16
// range masks one occurrence. Edited lines and further occurrences are scanned.
const inheritedMannersReplyPath = 'apps/server/src/assistant/manners/replies.ts';
const inheritedMannersReply = {
  lineSha256: 'af3ffb3c619a245ec1250f3328fa00d804718c4fc779f56c98afc0e5cb24bb42',
  start: 54,
  end: 69,
};

const inheritedMannersFixturePath = 'tests/fixtures/manners-development.ts';
const inheritedMannersFixtureSha256 = '714ba5081e72072d9e8a11aa411eff0ff12c4872ad53e39bbca7cbe48039cc15';

function maskPinnedOccurrence(source: string, { lineSha256, start, end }: typeof inheritedMannersReply): string {
  const lines = source.split('\n');
  const index = lines.findIndex(line => createHash('sha256').update(line).digest('hex') === lineSha256);
  if (index < 0) return source;
  const line = lines[index]!;
  lines[index] = line.slice(0, start) + ' '.repeat(end - start) + line.slice(end);
  return lines.join('\n');
}

function* sourcesForLeakCheck(): Iterable<readonly [string, string]> {
  for (const [path, source] of sourceFiles(root)) {
    if (path === inheritedMannersFixturePath) {
      const currentHash = createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex');
      if (currentHash === inheritedMannersFixtureSha256) continue;
    }
    yield [path, path === inheritedMannersReplyPath ? maskPinnedOccurrence(source, inheritedMannersReply) : source];
  }
}

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

it('masks a pinned occurrence once and keeps edited or repeated source in the scan', () => {
  const line = '  const values = [sample];';
  const edited = line + ' // edited';
  const start = line.indexOf('sample');
  const end = start + 'sample'.length;
  const lineSha256 = createHash('sha256').update(line).digest('hex');
  expect(maskPinnedOccurrence([edited, line, line].join('\n'), { lineSha256, start, end })).toBe(
    [edited, '  const values = [      ];', line].join('\n'),
  );
});

const development = frozenDevelopment();
it.skipIf(!development)('detects frozen development inputs beyond the pinned source baseline', () => {
  expect(createHash('sha256').update(development!).digest('hex')).toBe(developmentSha256);
  const { cases } = JSON.parse(development!.toString('utf8')) as { cases: BenchmarkCaseInput[] };
  expect(findSourceLeaks(cases, sourcesForLeakCheck())).toEqual([]);
});
