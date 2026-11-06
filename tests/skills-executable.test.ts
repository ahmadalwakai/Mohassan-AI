import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SkillContractSchema, type SkillNodeBinding } from '@mohassan/contracts';
import { createSkillControl, createSkillScheduler, createToolGateway, hashSkillData } from '@mohassan/skills';
import { createApplication } from '../apps/server/src/app.ts';
import { executionFixture } from './helpers/skill-execution.ts';

const prefix = 'mohassan-executable-denial-';
async function removeFixture(directory: string) {
  const root = await realpath(directory), base = await realpath(tmpdir()), inside = relative(base, root);
  if (!inside || inside.startsWith('..') || isAbsolute(inside) || !basename(root).startsWith(prefix)) throw new Error('Invalid fixture cleanup target.');
  await rm(root, { recursive: true, force: true });
}
const inputFor = (id: string) => ({ plan: { nodes: [{ id: 'main', skillId: id, inputs: {}, dependsOn: [] }], inputs: [] }, values: {} });
const contractFor = () => SkillContractSchema.parse({
  slug: `executable-${randomUUID().slice(0, 8)}`, name: 'Stored Node fixture', description: 'A controlled Node file stored for negative execution acceptance.',
  version: '1.0.0', category: 'analytics', level: 'executable', sideEffects: 'none',
  execution: { timeoutMs: 1000, memoryMb: 64, outputMaxBytes: 1024 },
  steps: [{ id: 'script', kind: 'script', title: 'Never execute this fixture', entry: 'main.mjs' }],
  verification: 'Execution remains denied until all isolation gates are independently verified.',
});

describe('M8 negative acceptance while mandatory isolation gates remain closed', () => {
  let f: Awaited<ReturnType<typeof executionFixture>>, directory: string, skills: ReturnType<typeof createSkillControl>;
  beforeAll(async () => {
    f = await executionFixture(); directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
    skills = createSkillControl(f.store.db, { allowedRoots: [directory], executableReady: async () => false,
      environment: () => ({ capabilities: [], modelReady: false, visionReady: false, executableReady: false }) });
  });
  afterAll(async () => { await f?.store.close(); if (directory) await removeFixture(directory); });

  async function imported(activeFixture = false) {
    const contract = contractFor(), folder = join(directory, contract.slug); await mkdir(folder);
    // Stored as data only. The test never imports this file or invokes a process.
    await writeFile(join(folder, 'main.mjs'), 'export const controlledFixture = "stored, never executed";\n');
    await writeFile(join(folder, 'SKILL.md'), `---\nname: ${contract.slug}\ndescription: Store a controlled Node fixture for review.\n---\nKeep executable skills disabled until every gate is proved.\n`);
    await writeFile(join(folder, 'skill.contract.json'), JSON.stringify(contract));
    const { skill } = await skills.importLocal(f.owner, { path: folder });
    expect(skill).toMatchObject({ level: 'executable', status: 'quarantined', active: false });
    const detail = await skills.inspect(f.owner, skill.id, { expectedRevision: skill.revision });
    expect(detail.skill.status).toBe('inspected');
    expect(['pass', 'review']).toContain(detail.inspection?.verdict);
    if (activeFixture) {
      // Simulate pre-existing legacy/corrupt state in this disposable DB only.
      await f.store.db.updateTable('skill_versions').set({ status: 'active' }).where('id', '=', skill.id).execute();
      await f.store.db.updateTable('skill_families').set({ active_version_id: skill.id }).where('id', '=', skill.familyId).execute();
    }
    return detail;
  }
  function gatewayFor(id: string, contentHash: string) {
    const claimNode = vi.fn(f.scheduler.claimNode), executeModel = vi.fn(async () => ({}));
    const gateway = createToolGateway(f.store.db, { scheduler: { ...f.scheduler, claimNode }, adapters: [], model: { execute: executeModel } });
    const binding: SkillNodeBinding = { parentTaskId: randomUUID(), runId: randomUUID(), nodeId: 'main.script', versionId: id, contentHash, inputsHash: hashSkillData({}), kind: 'script' };
    const context = { ownerId: f.owner, taskId: randomUUID(), leaseToken: randomUUID(), binding, signal: new AbortController().signal, assertActive: vi.fn(async () => {}) };
    return { gateway, context, claimNode, executeModel };
  }

  it('imports and inspects Node as data but refuses explicit activation with closed gates', async () => {
    const detail = await imported();
    await expect(skills.activate(f.owner, detail.skill.id, { expectedRevision: detail.skill.revision, approve: true, acknowledgeFindings: true }))
      .rejects.toMatchObject({ code: 'SKILL_EXECUTABLE_GATES_CLOSED' });
    expect((await skills.detail(f.owner, detail.skill.id)).skill).toMatchObject({ status: 'inspected', active: false });
  });

  it('blocks a pre-existing active executable in the real planner and scheduler without dispatch', async () => {
    const detail = await imported(true), input = inputFor(detail.skill.id), validation = await skills.validateComposition(f.owner, input.plan);
    expect(validation.valid).toBe(false);
    expect(validation.issues).toContainEqual(expect.objectContaining({ code: 'isolation_gates_closed', severity: 'error' }));
    const parent = await f.parent(input), dispatchChild = vi.fn(parent.context.dispatchChild);
    const scheduler = createSkillScheduler(f.store.db, { validateComposition: skills.validateComposition, validateParentAuthority: f.validateParentAuthority });
    await expect(scheduler.runSkillGraph(input, { ...parent.context, dispatchChild })).rejects.toMatchObject({ code: 'SKILL_COMPOSITION_INVALID' });
    expect(dispatchChild).not.toHaveBeenCalled();
    expect(await f.store.db.selectFrom('skill_runs').select('id').where('parent_task_id', '=', parent.id).execute()).toEqual([]);
  });

  it('independently rejects a script-only graph as gates closed even if a permissive planner marks it valid', async () => {
    const detail = await imported(true), input = inputFor(detail.skill.id);
    // The existing helper deliberately reports ready gates. It cannot bypass
    // the scheduler's independent hard boundary or relabel execution as guidance.
    expect((await f.skills.validateComposition(f.owner, input.plan)).valid).toBe(true);
    const parent = await f.parent(input), dispatchChild = vi.fn(parent.context.dispatchChild);
    await expect(f.scheduler.runSkillGraph(input, { ...parent.context, dispatchChild })).rejects.toMatchObject({ code: 'SKILL_EXECUTABLE_GATES_CLOSED' });
    expect(dispatchChild).not.toHaveBeenCalled();
    expect(await f.store.db.selectFrom('skill_runs').select('id').where('parent_task_id', '=', parent.id).execute()).toEqual([]);
  });

  it('Gateway refuses an active script binding before claiming evidence or reaching any execution adapter', async () => {
    const detail = await imported(true), denied = gatewayFor(detail.skill.id, detail.skill.contentHash);
    await expect(denied.gateway.executeNode(denied.context)).rejects.toMatchObject({ code: 'SKILL_SANDBOX_UNVERIFIED' });
    expect(denied.claimNode).not.toHaveBeenCalled(); expect(denied.executeModel).not.toHaveBeenCalled();
    expect(await f.store.db.selectFrom('skill_evidence').select('id').where('version_id', '=', detail.skill.id).execute()).toEqual([]);
  });

  it('rejects one-byte script tampering before scheduler dispatch or Gateway claim', async () => {
    const detail = await imported(true), input = inputFor(detail.skill.id);
    await f.store.db.updateTable('skill_files').set({ content: 'export const controlledFixture = "stored, never executed";\n ' }).where('version_id', '=', detail.skill.id).where('path', '=', 'main.mjs').execute();
    const validation = await skills.validateComposition(f.owner, input.plan);
    expect(validation.issues).toContainEqual(expect.objectContaining({ code: 'skill_integrity_failed', severity: 'error' }));
    // Force the already-computed admission decision only; initialize must still
    // independently reject content, and the transaction must create no run.
    const scheduler = createSkillScheduler(f.store.db, { validateComposition: async () => ({ ...validation, valid: true, issues: [] }), validateParentAuthority: f.validateParentAuthority });
    const parent = await f.parent(input), dispatchChild = vi.fn(parent.context.dispatchChild);
    await expect(scheduler.runSkillGraph(input, { ...parent.context, dispatchChild })).rejects.toMatchObject({ code: 'SKILL_INTEGRITY_FAILED' });
    const denied = gatewayFor(detail.skill.id, detail.skill.contentHash);
    await expect(denied.gateway.executeNode(denied.context)).rejects.toMatchObject({ code: 'SKILL_INTEGRITY_FAILED' });
    expect(dispatchChild).not.toHaveBeenCalled(); expect(denied.claimNode).not.toHaveBeenCalled(); expect(denied.executeModel).not.toHaveBeenCalled();
    expect(await f.store.db.selectFrom('skill_runs').select('id').where('parent_task_id', '=', parent.id).execute()).toEqual([]);
  });
});

it('the actual task API rejects direct internal-node dispatch and client-supplied execution bindings', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix))), run = vi.fn(async () => { throw new Error('No script or project may execute in this fixture.'); });
  let application: Awaited<ReturnType<typeof createApplication>> | undefined;
  const secret = 'executable-denial-internal-secret-0001', setupToken = 'executable-denial-setup-token-000001', origin = 'http://127.0.0.1:3000';
  let cookie = '';
  const headers = () => ({ 'x-mohassan-internal': secret, origin, ...(cookie ? { cookie } : {}) });
  try {
    application = await createApplication({ authSecret: 'executable-denial-auth-secret-000001', internalSecret: secret, setupToken, webOrigin: origin, production: false,
      runWorker: false, skillEngineEnabled: true, codingAllowedRoots: [directory], codingDataDir: join(directory, 'coding'), studioAiDataDir: join(directory, 'studio'), browserProfileDir: join(directory, 'browser'),
      sandboxRunner: { available: async () => ({ available: false, provider: 'negative-fixture', message: 'Mandatory gates are closed.' }), run } });
    const app = application.app, account = { email: 'executable-denial@example.test', password: 'Executable-denial-fixture-password-42' };
    expect((await app.inject({ method: 'POST', url: '/api/setup', headers: headers(), payload: { name: 'Executable denial fixture', ...account, setupToken } })).statusCode).toBe(200);
    const login = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: headers(), payload: account });
    expect(login.statusCode).toBe(200);
    cookie = [login.headers['set-cookie']].flat().filter(Boolean).map(value => String(value).split(';')[0]).join('; ');
    const tasksBefore = await application.database.db.selectFrom('tasks').select('id').execute();
    for (const payload of [
      { title: 'Attempt internal node', goal: 'Never dispatch a script from a public request.', capabilityId: 'skill.node', autonomy: 'assisted' },
      { title: 'Attempt injected binding', goal: 'Never use caller-supplied internal execution metadata.', capabilityId: 'system.diagnostic', autonomy: 'assisted', skillBinding: { kind: 'script' }, skillNodeInput: {} },
    ]) {
      const response = await app.inject({ method: 'POST', url: '/api/tasks', headers: { ...headers(), 'idempotency-key': randomUUID() }, payload });
      expect(response.statusCode, response.body).toBe(400);
    }
    expect(await application.database.db.selectFrom('tasks').select('id').execute()).toEqual(tasksBefore);
    expect(run).not.toHaveBeenCalled();
  } finally { await application?.app.close(); await removeFixture(directory); }
}, 60000);
