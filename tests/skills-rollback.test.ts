import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, migrate } from '@mohassan/database';
import { SkillContractSchema } from '@mohassan/contracts';
import { createSkillControl, sha256, skillsMigration } from '@mohassan/skills';
import { Runtime } from '@mohassan/runtime';
import { createSkillRollbackControl } from '../packages/skills/src/rollback.js';
import { createSkillRuntime } from '../apps/server/src/skill-runtime.js';
import type { SkillToolControls } from '../apps/server/src/skill-tools.js';
import { registerSkillRollbackRoutes } from '../apps/server/src/skill-rollback.js';
import { migrateAuth } from '../apps/server/src/auth.js';

type Fixture = Awaited<ReturnType<typeof setup>>;
let fixture: Fixture | undefined;
let pendingClose: (() => Promise<void>) | undefined;
afterEach(async () => { await pendingClose?.(); pendingClose = undefined; fixture = undefined; });

async function setup(before: string | null = 'Original approved report') {
  const base = await realpath(tmpdir()), directory = await realpath(await mkdtemp(join(base, 'mohassan-skill-rollback-'))), files = join(directory, 'files'), source = join(directory, 'skill'), target = join(files, 'reports', 'report.txt');
  const resources: { store?: Awaited<ReturnType<typeof createDatabase>>; runtime?: Runtime; app?: ReturnType<typeof Fastify> } = {};
  pendingClose = async () => {
    await resources.runtime?.stop(); await resources.app?.close(); await resources.store?.close();
    const resolved = await realpath(directory), within = relative(base, resolved);
    if (isAbsolute(within) || within.startsWith('..') || !within.startsWith('mohassan-skill-rollback-')) throw new Error('Unsafe rollback cleanup');
    await rm(resolved, { recursive: true, force: true });
  };
  await mkdir(join(files, 'reports'), { recursive: true }); await mkdir(source);
  if (before !== null) await writeFile(target, before, 'utf8');
  const store = await createDatabase(); resources.store = store; await migrateAuth(store.db); await migrate(store.db); await skillsMigration(store.db);
  const owner = randomUUID(), other = randomUUID(); for (const id of [owner, other]) await store.db.insertInto('user').values({ id, name: 'Rollback fixture', email: `${id}@example.test` }).execute();
  const skills = createSkillControl(store.db, { allowedRoots: [directory], environment: () => ({ capabilities: [], gatewayTools: ['file.write'], executableReady: false, modelReady: false, visionReady: false }) });
  const field = (name: string, type: string) => ({ name, type, description: `Fixture ${name}` });
  const contract = SkillContractSchema.parse({ slug: 'confirmed-file-writer', name: 'Confirmed fixture writer', description: 'Write a bounded approved report and preserve its exact previous content.', category: 'documents', version: '1.0.0', level: 'tool',
    inputs: [field('root', 'file'), field('path', 'file'), field('content', 'string'), field('expectedHash', 'json')], outputs: [field('hash', 'string')],
    requires: { tools: ['file.write'], paths: ['reports'] }, sideEffects: 'write_local', rollback: { mode: 'restore_preimage' }, idempotent: true, verification: 'Verify persisted file output and exact preimage hashes.',
    steps: [{ id: 'write', kind: 'tool', tool: 'file.write', title: 'Write fixture report', inputs: { root: 'input.root', path: 'input.path', content: 'input.content', expectedHash: 'input.expectedHash' }, outputs: [field('hash', 'string')] }],
  });
  await writeFile(join(source, 'SKILL.md'), '---\nname: confirmed-file-writer\ndescription: Write a bounded approved report and preserve its exact previous content.\n---\nUse only the explicitly approved report path.');
  await writeFile(join(source, 'skill.contract.json'), JSON.stringify(contract));
  let version = (await skills.importLocal(owner, { path: source })).skill;
  version = (await skills.inspect(owner, version.id, { expectedRevision: version.revision })).skill;
  version = (await skills.activate(owner, version.id, { expectedRevision: version.revision, approve: true, acknowledgeFindings: true })).skill;
  const grant = await skills.createGrant(owner, version.id, { expectedRevision: version.revision, approve: true, tools: ['file.write'], roots: [files], durationHours: 1 });
  const rollback = createSkillRollbackControl(store.db), execution = createSkillRuntime(store.db, { skills, browser: {} as SkillToolControls['browser'], memory: {} as SkillToolControls['memory'] });
  const runtime = new Runtime(store.db, { skillRuntime: execution.runtimeOptions, rollback: { prepare: rollback.prepare, execute: (input, context) => rollback.execute(input, context), verify: rollback.verify, recoverExpired: rollback.recoverExpired } });
  resources.runtime = runtime;
  const after = 'New report from a confirmed approved skill write';
  const parent = await runtime.createTask(owner, { title: 'Write controlled report', goal: 'Write the report through the existing approved skill workflow.', capabilityId: 'skill.run', autonomy: 'assisted', skillInput: { plan: { inputs: contract.inputs, nodes: [{ id: 'main', skillId: version.id, dependsOn: [], inputs: Object.fromEntries(contract.inputs.map(item => [item.name, `input.${item.name}`])) }] }, values: { root: files, path: 'reports/report.txt', content: after, expectedHash: before === null ? null : sha256(before) } } }, randomUUID());
  await runtime.approve(owner, parent.id);
  for (let attempt = 0; attempt < 6; attempt++) {
    await runtime.tick();
    const tasks = await store.db.selectFrom('tasks').select(['id', 'status', 'error']).execute();
    const current = tasks.find(task => task.id === parent.id)!; if (current.status === 'completed') break;
    if (current.status === 'failed') throw new Error(`Source fixture failed: ${JSON.stringify(tasks)}`);
    for (const child of tasks.filter(task => task.id !== parent.id && task.status === 'waiting_approval')) await runtime.approve(owner, child.id);
  }
  expect((await store.db.selectFrom('tasks').select('status').where('id', '=', parent.id).executeTakeFirstOrThrow()).status).toBe('completed');
  expect(await readFile(target, 'utf8')).toBe(after);
  const run = await store.db.selectFrom('skill_runs').selectAll().where('parent_task_id', '=', parent.id).executeTakeFirstOrThrow(), preimage = await store.db.selectFrom('skill_preimages').selectAll().executeTakeFirstOrThrow();
  const app = Fastify(); resources.app = app; app.setErrorHandler((error: any, _request, reply) => reply.code(error.statusCode ?? 400).send({ error: { code: error.code ?? 'INVALID_INPUT', message: error.message } }));
  await registerSkillRollbackRoutes(app, { runtime, rollback, enabled: true, owner: async request => ({ id: request.headers['x-fixture-owner'] === other ? other : owner }) });
  const restoreRequest = () => ({ preimageId: preimage.id, expectedAfterHash: preimage.after_hash });
  async function request(key = randomUUID(), asOther = false) {
    return app.inject({ method: 'POST', url: `/api/skills/runs/${run.id}/rollback`, headers: { 'idempotency-key': key, ...(asOther ? { 'x-fixture-owner': other } : {}) }, payload: restoreRequest() });
  }
  async function approveAndRun(id: string) { await runtime.approve(owner, id); await runtime.tick(); return store.db.selectFrom('tasks').selectAll().where('id', '=', id).executeTakeFirstOrThrow(); }
  return { directory, files, target, store, owner, other, skills, version, grant, runtime, rollback, app, parent, run, preimage, before, after, request, restoreRequest, approveAndRun,
  };
}

describe('confirmed file rollback through existing Runtime and independent explicit approval', () => {
  it('previews owned evidence, creates an idempotent waiting-approval task, and restores the exact earlier bytes', async () => {
    fixture = await setup(); const f = fixture;
    const preview = await f.app.inject({ url: `/api/skills/runs/${f.run.id}/rollback` }); expect(preview.statusCode).toBe(200); expect(preview.json().items[0]).toMatchObject({ preimageId: f.preimage.id, path: 'reports/report.txt', eligible: true, beforeHash: sha256(f.before!) });
    const key = randomUUID(), requested = await f.request(key); expect(requested.statusCode, requested.body).toBe(200); const task = requested.json().task;
    expect(task).toMatchObject({ capabilityId: 'skill.rollback', autonomy: 'assisted', status: 'waiting_approval', maxAttempts: 1, skillRollbackReview: { root: f.files, path: 'reports/report.txt', deletedOnRestore: false } });
    expect((await f.request(key)).json().task.id).toBe(task.id); await f.runtime.tick(); expect(await readFile(f.target, 'utf8')).toBe(f.after); expect(await f.store.db.selectFrom('skill_rollbacks').select('id').execute()).toEqual([]);
    const completed = await f.approveAndRun(task.id); expect(completed, completed.error ?? '').toMatchObject({ status: 'completed' }); expect(await readFile(f.target, 'utf8')).toBe(f.before);
    expect(completed.result).toMatchObject({ kind: 'skill_rollback', restoredHash: sha256(f.before!), replacedHash: sha256(f.after), deleted: false });
    expect(await f.store.db.selectFrom('skill_resource_locks').selectAll().execute()).toEqual([]); expect(await readdir(join(f.files, 'reports'))).toEqual(['report.txt']);
  });

  it('deletes a newly created file only after a separately approved restoration', async () => {
    fixture = await setup(null); const f = fixture, requested = await f.request(); expect(requested.statusCode, requested.body).toBe(200);
    expect(requested.json().review).toMatchObject({ beforeHash: null, deletedOnRestore: true });
    const completed = await f.approveAndRun(requested.json().task.id); expect(completed).toMatchObject({ status: 'completed', result: { deleted: true, restoredHash: null } }); await expect(readFile(f.target)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(join(f.files, 'reports'))).toEqual([]);
  });

  it('restores a successful child even if its parent workflow later failed', async () => {
    fixture = await setup(); const f = fixture; await f.store.db.updateTable('tasks').set({ status: 'failed' }).where('id', '=', f.parent.id).execute(); await f.store.db.updateTable('skill_runs').set({ status: 'failed' }).where('id', '=', f.run.id).execute();
    const requested = await f.request(); expect(requested.statusCode, requested.body).toBe(200); expect((await f.approveAndRun(requested.json().task.id)).status).toBe('completed'); expect(await readFile(f.target, 'utf8')).toBe(f.before);
  });

  it('refuses another owner, caller-supplied paths, wrong snapshots and unknown source receipts without file changes', async () => {
    fixture = await setup(); const f = fixture; expect((await f.request(randomUUID(), true)).statusCode).toBe(404);
    const expanded = await f.app.inject({ method: 'POST', url: `/api/skills/runs/${f.run.id}/rollback`, headers: { 'idempotency-key': randomUUID() }, payload: { ...f.restoreRequest(), root: 'C:/unapproved', approve: true } }); expect(expanded.statusCode).toBe(400);
    const prepared = await f.rollback.describe(f.owner, f.run.id, f.restoreRequest()); await expect(f.rollback.prepare(f.owner, { ...prepared.input, preimageHash: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'SKILL_ROLLBACK_INPUT_CHANGED' });
    await f.store.db.updateTable('skill_evidence').set({ status: 'unknown' }).where('id', '=', f.preimage.receipt_id).execute(); expect((await f.request()).json().error.code).toBe('SKILL_ROLLBACK_UNCONFIRMED'); expect(await readFile(f.target, 'utf8')).toBe(f.after);
    expect(await f.store.db.selectFrom('skill_rollbacks').select('id').execute()).toEqual([]);
  });

  it('never overwrites a later file change, including a change after approval', async () => {
    fixture = await setup(); const f = fixture, requested = await f.request(); expect(requested.statusCode).toBe(200);
    await f.runtime.approve(f.owner, requested.json().task.id); await writeFile(f.target, 'A newer independent user edit'); await f.runtime.tick();
    const task = await f.store.db.selectFrom('tasks').selectAll().where('id', '=', requested.json().task.id).executeTakeFirstOrThrow(); expect(task.status).toBe('failed'); expect(await readFile(f.target, 'utf8')).toBe('A newer independent user edit');
    expect((await f.request()).json().error.code).toBe('SKILL_ROLLBACK_FILE_CHANGED'); expect(await f.store.db.selectFrom('skill_rollbacks').select('id').execute()).toEqual([]);
  });

  it.each([false, true])('requires a still-active grant (revoked after approval=%s)', async afterApproval => {
    fixture = await setup(); const f = fixture, requested = await f.request(); expect(requested.statusCode).toBe(200);
    if (afterApproval) await f.runtime.approve(f.owner, requested.json().task.id);
    await f.store.db.updateTable('skill_grants').set({ revoked_at: new Date() }).where('version_id', '=', f.version.id).execute();
    if (afterApproval) { await f.runtime.tick(); expect((await f.store.db.selectFrom('tasks').select('status').where('id', '=', requested.json().task.id).executeTakeFirstOrThrow()).status).not.toBe('completed'); }
    else await expect(f.runtime.approve(f.owner, requested.json().task.id)).rejects.toThrow();
    expect(await readFile(f.target, 'utf8')).toBe(f.after); expect(await f.store.db.selectFrom('skill_rollbacks').select('id').execute()).toEqual([]);
  });

  it('rejects altered preimage bytes before creating any restoration attempt', async () => {
    fixture = await setup(); const f = fixture;
    await f.store.db.updateTable('skill_preimages').set({ before_text: 'Altered history must not be restored' }).where('id', '=', f.preimage.id).execute();
    expect((await f.request()).json().error.code).toBe('SKILL_ROLLBACK_PREIMAGE_CHANGED'); expect(await readFile(f.target, 'utf8')).toBe(f.after); expect(await f.store.db.selectFrom('skill_rollbacks').select('id').execute()).toEqual([]);
  });

  it('releases only its own lock after a proven pre-publication failure, requiring a new approval for another attempt', async () => {
    fixture = await setup(); const f = fixture, execute = f.rollback.execute;
    const replacement = vi.spyOn(f.rollback, 'execute').mockImplementation((input, context) => execute(input, { ...context, async assertActive() { await context.assertActive(); const attempt = await f.store.db.selectFrom('skill_rollbacks').select('id').where('task_id', '=', context.taskId).where('status', '=', 'started').executeTakeFirst(); if (attempt) throw new Error('Fixture failure before publication'); } }));
    const requested = await f.request(); expect(requested.statusCode).toBe(200); expect((await f.approveAndRun(requested.json().task.id)).status).toBe('failed'); replacement.mockRestore();
    expect(await readFile(f.target, 'utf8')).toBe(f.after); expect(await f.store.db.selectFrom('skill_rollbacks').select(['status', 'effect_started']).execute()).toEqual([{ status: 'failed', effect_started: false }]); expect(await f.store.db.selectFrom('skill_resource_locks').selectAll().execute()).toEqual([]);
    const next = await f.request(); expect(next.statusCode).toBe(200); expect(next.json().task.status).toBe('waiting_approval'); expect(await readFile(f.target, 'utf8')).toBe(f.after);
    expect((await f.approveAndRun(next.json().task.id)).status).toBe('completed'); expect(await readFile(f.target, 'utf8')).toBe(f.before);
  });

  it('rechecks the file after the last asynchronous authority check before publishing a restoration', async () => {
    fixture = await setup(); const f = fixture, execute = f.rollback.execute; let edited = false;
    vi.spyOn(f.rollback, 'execute').mockImplementation((input, context) => execute(input, { ...context, async assertActive() {
      await context.assertActive();
      const row = await f.store.db.selectFrom('skill_rollbacks').select('effect_started').where('task_id', '=', context.taskId).executeTakeFirst();
      if (row?.effect_started && !edited) { edited = true; await writeFile(f.target, 'Later edit during authorization'); }
    } }));
    const requested = await f.request(); expect(requested.statusCode).toBe(200); expect((await f.approveAndRun(requested.json().task.id)).status).toBe('failed'); expect(edited).toBe(true);
    expect(await readFile(f.target, 'utf8')).toBe('Later edit during authorization'); expect(await readdir(join(f.files, 'reports'))).toEqual(['report.txt']);
    expect(await f.store.db.selectFrom('skill_resource_locks').selectAll().execute()).toEqual([]);
  });

  it('does not follow hard links or steal an unresolved resource lock', async () => {
    fixture = await setup(); const f = fixture;
    await link(f.target, join(f.files, 'reports', 'another-link.txt')); expect((await f.request()).statusCode).not.toBe(200);
    await rm(join(f.files, 'reports', 'another-link.txt')); const requested = await f.request(); expect(requested.statusCode).toBe(200);
    const absolute = process.platform === 'win32' ? f.target.toLowerCase() : f.target;
    await f.store.db.insertInto('skill_resource_locks').values({ resource_key: sha256(`file:${absolute}`), receipt_id: f.preimage.receipt_id, run_id: f.run.id, node_id: 'main.write', owner_id: f.owner }).execute();
    const task = await f.approveAndRun(requested.json().task.id); expect(task.status).toBe('failed'); expect(await readFile(f.target, 'utf8')).toBe(f.after);
    expect((await f.store.db.selectFrom('skill_resource_locks').selectAll().executeTakeFirstOrThrow()).receipt_id).toBe(f.preimage.receipt_id); expect(await f.store.db.selectFrom('skill_rollbacks').select('id').execute()).toEqual([]);
  });

  it('allows only one restoration when two separately approved tasks race for the same preimage', async () => {
    fixture = await setup(); const f = fixture, first = await f.request(), second = await f.request(); expect(first.statusCode).toBe(200); expect(second.statusCode).toBe(200);
    await f.runtime.approve(f.owner, first.json().task.id); await f.runtime.approve(f.owner, second.json().task.id); await f.runtime.tick(); await f.runtime.tick();
    const tasks = await f.store.db.selectFrom('tasks').select('status').where('id', 'in', [first.json().task.id, second.json().task.id]).execute(); expect(tasks.filter(task => task.status === 'completed')).toHaveLength(1); expect(await readFile(f.target, 'utf8')).toBe(f.before);
    expect(await f.store.db.selectFrom('skill_rollbacks').select('status').execute()).toEqual([{ status: 'succeeded' }]);
  });

  it('leaves an interrupted post-publication restoration unknown, retains its resource, and forbids automatic replay', async () => {
    fixture = await setup(); const f = fixture, execute = f.rollback.execute;
    vi.spyOn(f.rollback, 'execute').mockImplementation((input, context) => execute(input, { ...context, async assertActive() { await context.assertActive(); if (await readFile(f.target, 'utf8') === f.before) throw new Error('Fixture interruption after publication'); } }));
    const requested = await f.request(); expect(requested.statusCode).toBe(200); expect((await f.approveAndRun(requested.json().task.id)).status).toBe('failed');
    expect(await readFile(f.target, 'utf8')).toBe(f.before); const row = await f.store.db.selectFrom('skill_rollbacks').selectAll().executeTakeFirstOrThrow(); expect(row.status).toBe('unknown'); expect(row.effect_started).toBe(true);
    expect((await f.store.db.selectFrom('skill_resource_locks').selectAll().executeTakeFirstOrThrow()).rollback_id).toBe(row.id);
    await f.runtime.tick(); expect(await f.store.db.selectFrom('skill_rollbacks').select('id').execute()).toHaveLength(1);
    await writeFile(f.target, f.after); expect((await f.request()).json().error.code).toBe('SKILL_ROLLBACK_ALREADY_STARTED'); expect(await readFile(f.target, 'utf8')).toBe(f.after);
  });

  it.each(['expired', 'replaced', 'terminal'] as const)('classifies a %s writer as unknown without touching its file, staging or resource lock', async reason => {
    fixture = await setup(); const f = fixture, requested = await f.request(); expect(requested.statusCode).toBe(200);
    const taskId = requested.json().task.id, leaseToken = randomUUID(), rollbackId = randomUUID(), staging = join(f.files, 'reports', `.mohassan-rollback-${rollbackId}.tmp`);
    await f.runtime.approve(f.owner, taskId);
    await f.store.db.updateTable('tasks').set({ status: 'running', lease_token: leaseToken, lease_expires_at: new Date(Date.now() + 60_000) }).where('id', '=', taskId).execute();
    await f.store.db.insertInto('skill_rollbacks').values({ id: rollbackId, owner_id: f.owner, run_id: f.run.id, preimage_id: f.preimage.id, source_receipt_id: f.preimage.receipt_id, task_id: taskId, lease_token: leaseToken, input_hash: 'a'.repeat(64), before_hash: f.preimage.before_hash, after_hash: f.preimage.after_hash, status: 'started', effect_started: true }).execute();
    const absolute = process.platform === 'win32' ? f.target.toLowerCase() : f.target;
    await f.store.db.insertInto('skill_resource_locks').values({ resource_key: sha256(`file:${absolute}`), receipt_id: null, rollback_id: rollbackId, run_id: f.run.id, node_id: 'main.write', owner_id: f.owner }).execute();
    await writeFile(staging, 'Trusted orphan staging fixture');
    expect(await f.rollback.recoverExpired()).toEqual({ unknown: 0 });
    expect((await f.store.db.selectFrom('skill_rollbacks').select('status').where('id', '=', rollbackId).executeTakeFirstOrThrow()).status).toBe('started');
    const state = reason === 'expired' ? { lease_expires_at: new Date(Date.now() - 1_000) } : reason === 'replaced' ? { lease_token: randomUUID() } : { status: 'failed' };
    await f.store.db.updateTable('tasks').set(state).where('id', '=', taskId).execute();
    expect(await f.rollback.recoverExpired()).toEqual({ unknown: 1 }); expect(await f.rollback.recoverExpired()).toEqual({ unknown: 0 });
    expect(await f.store.db.selectFrom('skill_rollbacks').select(['status', 'error_code']).where('id', '=', rollbackId).executeTakeFirstOrThrow()).toEqual({ status: 'unknown', error_code: 'SKILL_ROLLBACK_WRITER_LOST' });
    expect((await f.store.db.selectFrom('skill_resource_locks').select('rollback_id').executeTakeFirstOrThrow()).rollback_id).toBe(rollbackId);
    expect(await readFile(f.target, 'utf8')).toBe(f.after); expect(await readFile(staging, 'utf8')).toBe('Trusted orphan staging fixture');
    expect((await f.request()).json().error.code).toBe('SKILL_ROLLBACK_ALREADY_STARTED');
  });

  it('maintains interrupted rollback metadata after execution is disabled without enabling its capability', async () => {
    fixture = await setup(); const f = fixture, requested = await f.request(); expect(requested.statusCode).toBe(200);
    const task = requested.json().task, leaseToken = randomUUID(), rollbackId = randomUUID(), staging = join(f.files, 'reports', `.mohassan-rollback-${rollbackId}.tmp`);
    await f.runtime.approve(f.owner, task.id);
    await f.store.db.updateTable('tasks').set({ status: 'running', attempt: 1, lease_token: leaseToken, lease_expires_at: new Date(0) }).where('id', '=', task.id).execute();
    await f.store.db.insertInto('skill_rollbacks').values({ id: rollbackId, owner_id: f.owner, run_id: f.run.id, preimage_id: f.preimage.id, source_receipt_id: f.preimage.receipt_id, task_id: task.id, lease_token: leaseToken, input_hash: 'a'.repeat(64), before_hash: f.preimage.before_hash, after_hash: f.preimage.after_hash, status: 'started', effect_started: true }).execute();
    const absolute = process.platform === 'win32' ? f.target.toLowerCase() : f.target;
    await f.store.db.insertInto('skill_resource_locks').values({ resource_key: sha256(`file:${absolute}`), receipt_id: null, rollback_id: rollbackId, run_id: f.run.id, node_id: 'main.write', owner_id: f.owner }).execute();
    await writeFile(staging, 'Owned interrupted staging fixture');
    const disabled = new Runtime(f.store.db, { recoverSkillRollbacks: f.rollback.recoverExpired });
    expect(disabled.getCapabilities().find(capability => capability.id === 'skill.rollback')?.status).toBe('needs_configuration');
    await expect(disabled.createTask(f.owner, { title: task.title, goal: task.goal, capabilityId: 'skill.rollback', autonomy: 'assisted', skillRollbackInput: task.skillRollbackInput }, randomUUID())).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' });
    expect(await disabled.tick()).toBeNull(); expect(await disabled.tick()).toBeNull();
    expect((await disabled.detail(f.owner, task.id)).task.status).toBe('failed');
    expect(await f.store.db.selectFrom('skill_rollbacks').select(['status', 'error_code']).where('id', '=', rollbackId).executeTakeFirstOrThrow()).toEqual({ status: 'unknown', error_code: 'SKILL_ROLLBACK_WRITER_LOST' });
    expect((await f.store.db.selectFrom('skill_resource_locks').select('rollback_id').executeTakeFirstOrThrow()).rollback_id).toBe(rollbackId);
    expect(await readFile(f.target, 'utf8')).toBe(f.after); expect(await readFile(staging, 'utf8')).toBe('Owned interrupted staging fixture');
  });
});
