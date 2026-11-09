import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { captureEvidenceSources, createEvidenceRun } from '../scripts/lib/evidence-report.js';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'mohassan-evidence-test-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  const parent = await realpath(tmpdir());
  for (const root of roots.splice(0)) {
    const target = await realpath(root), relative = path.relative(parent, target);
    if (path.isAbsolute(relative) || !relative.startsWith('mohassan-evidence-test-') || relative.includes('..') || relative.includes(path.sep)) throw new Error('Unsafe fixture cleanup');
    await rm(target, { recursive: true, force: true });
  }
});

it('keeps concurrent runs and previous reports intact even at the same timestamp', async () => {
  const root = await fixture(), startedAt = '2026-11-09T00:00:00.000Z';
  const [first, second] = await Promise.all([createEvidenceRun(root, 'browser', startedAt), createEvidenceRun(root, 'browser', startedAt)]);
  expect(first.directory).not.toBe(second.directory);
  await first.writeReport({ accepted: false });
  await second.writeReport({ accepted: true });
  await expect(first.writeReport({ accepted: true })).rejects.toMatchObject({ code: 'EEXIST' });
  expect(JSON.parse(await readFile(first.reportPath, 'utf8'))).toEqual({ accepted: false });
  expect(JSON.parse(await readFile(second.reportPath, 'utf8'))).toEqual({ accepted: true });
});

it('pins the bytes used for fingerprints and detects subsequent source changes', async () => {
  const root = await fixture(), run = await createEvidenceRun(root, 'source', new Date().toISOString());
  await writeFile(path.join(root, 'fixture.ts'), 'original');
  const before = await captureEvidenceSources(root, ['fixture.ts'], run.directory);
  await writeFile(path.join(root, 'fixture.ts'), 'changed');
  const after = await captureEvidenceSources(root, ['fixture.ts']);
  expect(before.hash).not.toBe(after.hash);
  expect(await readFile(path.join(run.directory, 'source', 'fixture.ts'), 'utf8')).toBe('original');
  await expect(captureEvidenceSources(root, ['../outside'])).rejects.toThrow('Invalid evidence source path');
});
