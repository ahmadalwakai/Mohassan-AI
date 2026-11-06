/** Repository-owned benchmark worker only. Candidate files stay database data. */
import { appendFile, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { createDatabase, sql } from '@mohassan/database';
import { sha256 } from '@mohassan/skills';
import { SkillBenchmarkSnapshotSchema } from '../../../packages/contracts/src/skill-benchmarks.ts';
import { BENCHMARK_BEFORE, BENCHMARK_UNICODE, skillBenchmarkSuite, skillBenchmarkSupport } from '../../../packages/skills/src/benchmark-suites.ts';
import { BENCHMARK_OWNER, createBenchmarkControls, grantBenchmarkRoot, initializeBenchmarkClone, prepareBenchmarkRoot, startBenchmarkTask, tickBenchmarkTask, verifyBenchmarkSnapshot } from './skill-benchmark-isolation.ts';

const [rawDirectory, phase] = process.argv.slice(2), directory = await realpath(resolve(rawDirectory ?? ''));
const base = await realpath(tmpdir()), inside = relative(base, directory);
if (!process.send || !['start', 'resume'].includes(phase) || isAbsolute(inside) || inside.startsWith('..') || basename(directory) !== inside || !inside.startsWith('mohassan-benchmark-worker-')) throw new Error('BENCHMARK_WORKER_DIRECTORY_REJECTED');
const text = await readFile(join(directory, 'manifest.json'), 'utf8');
if (Buffer.byteLength(text) > 2_097_152) throw new Error('BENCHMARK_MANIFEST_LIMIT');
const manifest = z.object({ nonce: z.uuid(), snapshot: SkillBenchmarkSnapshotSchema }).strict().parse(JSON.parse(text));
const contract = verifyBenchmarkSnapshot(manifest.snapshot);
if (skillBenchmarkSupport(contract, skillBenchmarkSuite('file-write-correctness-v1')!) !== null) throw new Error('BENCHMARK_WORKER_SCOPE_REJECTED');
const store = await createDatabase({ dataDir: join(directory, 'database') });
let controls: ReturnType<typeof createBenchmarkControls> | undefined;
try {
  if (phase === 'start') {
    const setup = await initializeBenchmarkClone(store.db, directory, manifest.snapshot);
    const root = await prepareBenchmarkRoot(directory, 'confirmed-crash'); await writeFile(join(root, 'reports', 'result.txt'), BENCHMARK_BEFORE);
    controls = createBenchmarkControls(store.db, directory, async next => {
      await appendFile(join(directory, 'dispatches.txt'), 'dispatch\n');
      const result = await next();
      await sql`CHECKPOINT`.execute(store.db);
      process.send!({ kind: 'checkpoint', nonce: manifest.nonce, pid: process.pid, stage: 'confirmed-receipt-before-runtime-finish' });
      await new Promise<void>(() => {});
      return result;
    });
    await grantBenchmarkRoot(controls, setup.versionId, root, 'file.write');
    const parent = await startBenchmarkTask(controls, setup.versionId, contract, { root, path: 'reports/result.txt', content: BENCHMARK_UNICODE, expectedHash: sha256(BENCHMARK_BEFORE) });
    await tickBenchmarkTask(store.db, controls, parent.id, AbortSignal.timeout(45000));
    throw new Error('BENCHMARK_EXPECTED_CHECKPOINT_MISSING');
  }
  const versions = await store.db.selectFrom('skill_versions').select(['id', 'content_hash']).where('owner_id', '=', BENCHMARK_OWNER).execute();
  if (versions.length !== 1 || versions[0].content_hash !== manifest.snapshot.pin.contentHash) throw new Error('BENCHMARK_WORKER_PIN_CHANGED');
  const parent = await store.db.selectFrom('tasks').select('id').where('owner_id', '=', BENCHMARK_OWNER).where('capability_id', '=', 'skill.run').executeTakeFirstOrThrow();
  controls = createBenchmarkControls(store.db, directory, async next => { await appendFile(join(directory, 'dispatches.txt'), 'dispatch\n'); return next(); });
  await tickBenchmarkTask(store.db, controls, parent.id, AbortSignal.timeout(45000), false);
  await controls.runtime.stop(); await store.close();
  process.send!({ kind: 'finished', nonce: manifest.nonce, pid: process.pid, parentId: parent.id }); process.disconnect();
} catch (error) {
  await controls?.runtime.stop().catch(() => {}); await store.close().catch(() => {}); throw error;
}
