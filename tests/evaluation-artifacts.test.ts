import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createEvaluationArtifactRun } from '../scripts/lib/evaluation-artifacts.js';

const directories: string[] = [];
afterEach(async () => {
  const parent = await realpath(tmpdir());
  for (const directory of directories.splice(0)) {
    const target = await realpath(directory), local = relative(parent, target);
    if (isAbsolute(local) || !/^mohassan-evaluation-artifacts-[^/\\]+$/.test(local)) throw new Error('Unsafe fixture cleanup');
    await rm(target, { recursive: true, force: true });
  }
});

it('preserves frozen source bytes and previous reports across independent runs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mohassan-evaluation-artifacts-')); directories.push(root);
  const bytes = Buffer.from('original source');
  const first = await createEvaluationArtifactRun(root, [{ name: 'scripts/fixture.ts', bytes }]);
  await first.writeReport({ passed: false });
  bytes.fill(0);
  const second = await createEvaluationArtifactRun(root, [{ name: 'scripts/fixture.ts', bytes: Buffer.from('changed source') }]);
  await second.writeReport({ passed: true });
  expect(first.directory).not.toBe(second.directory);
  expect(await readFile(join(first.directory, 'sources/scripts/fixture.ts'), 'utf8')).toBe('original source');
  const manifest = JSON.parse(await readFile(join(first.directory, 'source-manifest.json'), 'utf8'));
  expect(manifest.files['scripts/fixture.ts']).toBe(createHash('sha256').update('original source').digest('hex'));
  expect(manifest.runnableCheckout).toBe(false);
  await expect(first.writeReport({ passed: true })).rejects.toMatchObject({ code: 'EEXIST' });
  expect(JSON.parse(await readFile(join(first.directory, 'report.json'), 'utf8'))).toEqual({ passed: false });
});

it.each(['../outside.ts', 'C:/outside.ts', '/outside.ts', 'scripts/../outside.ts', 'scripts\\outside.ts'])('rejects escaping snapshot name %s', async name => {
  const root = await mkdtemp(join(tmpdir(), 'mohassan-evaluation-artifacts-')); directories.push(root);
  await expect(createEvaluationArtifactRun(root, [{ name, bytes: Buffer.from('fixture') }])).rejects.toThrow('EVAL_ARTIFACT_SOURCE_INVALID');
});
