import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Runtime } from '@mohassan/runtime';
import { memoryMigration } from '@mohassan/memory';
import { SkillEvidencePageSchema, SkillRunSummarySchema } from '@mohassan/contracts';
import { SkillError } from '@mohassan/skills';
import { registerSkillRunRoutes } from '../apps/server/src/skill-runs.ts';
import { executionFixture, singlePlan, toolContract } from './helpers/skill-execution.ts';

describe('owner-scoped skill run API without dispatching effects', () => {
  let f: Awaited<ReturnType<typeof executionFixture>>, app: FastifyInstance, disabled: FastifyInstance, runtime: Runtime;
  let version: Awaited<ReturnType<typeof f.version>>, revision: number, runId: string, parentId: string;
  const key = randomUUID();
  const headers = () => ({ 'x-fixture-owner': f.owner, 'idempotency-key': key });
  const payload = () => ({ expectedRevision: revision, values: { query: 'Owned fixture evidence' } });
  async function server(enabled: boolean) {
    const instance = Fastify();
    instance.setErrorHandler((error: any, _request, reply) => reply.code(error instanceof z.ZodError ? 400 : error.statusCode ?? 500).send({ error: { code: error.code ?? 'INVALID_INPUT' } }));
    await registerSkillRunRoutes(instance, { db: f.store.db, skills: f.skills, runtime, enabled, owner: async request => {
      const id = request.headers['x-fixture-owner'];
      if (typeof id !== 'string') throw new SkillError('SESSION_REQUIRED', 'Fixture session required.', 401);
      return { id };
    } });
    return instance;
  }
  beforeAll(async () => {
    f = await executionFixture(); await memoryMigration(f.store.db);
    runtime = new Runtime(f.store.db, { skillRuntime: {
      advance: f.scheduler.runSkillGraph, verify: f.scheduler.verifyRunResult, wakeCandidates: f.scheduler.wakeCandidates, cancelRun: f.scheduler.cancelRun,
      mapChild: () => null, validateBinding: async () => false, executeNode: async () => { throw new Error('API must not dispatch'); }, verifyNode: async () => null,
    } });
    version = await f.version(toolContract()); revision = (await f.skills.detail(f.owner, version.id)).skill.revision;
    app = await server(true); disabled = await server(false);
    // Persisted scheduler fixtures exercise read/cancel routes without any actual tool invocation.
    const input = singlePlan(version.id); input.plan.nodes.push({ ...input.plan.nodes[0], id: 'second' });
    const parent = await f.parent(input), pending = await f.scheduler.runSkillGraph(parent.input, parent.context); parentId = parent.id; runId = pending.runId;
    for (const node of ['main.search', 'second.search']) {
      const child = await f.child(runId, node), claim = await f.scheduler.claimNode(child.binding, child.context);
      await f.scheduler.appendEvidence(claim, { kind: 'fixture.receipt', data: { observed: 'Owner-only observation.' } });
    }
    await f.store.db.updateTable('tasks').set({ status: 'paused' }).where('id', '=', parentId).execute();
  });
  afterAll(async () => { await app?.close(); await disabled?.close(); await runtime?.stop(); await f?.store.close(); });

  it('creates only a reviewable waiting-approval Runtime task and returns the same task for the same key', async () => {
    const response = await app.inject({ method: 'POST', url: `/api/skills/${version.id}/run`, headers: headers(), payload: payload() });
    expect(response.statusCode, response.body).toBe(200);
    const created = response.json(); expect(created).toMatchObject({ runId: null, task: { capabilityId: 'skill.run', status: 'waiting_approval', autonomy: 'assisted' } });
    expect(created.task.skillInput.plan.nodes).toEqual([{ id: 'main', skillId: version.id, inputs: { query: 'input.query' }, dependsOn: [] }]);
    const again = await app.inject({ method: 'POST', url: `/api/skills/${version.id}/run`, headers: headers(), payload: payload() });
    expect(again.json().task.id).toBe(created.task.id);
    expect(await f.store.db.selectFrom('skill_runs').select('id').where('parent_task_id', '=', created.task.id).execute()).toEqual([]);
    const conflict = await app.inject({ method: 'POST', url: `/api/skills/${version.id}/run`, headers: headers(), payload: { ...payload(), goal: 'A different explicit goal.' } });
    expect(conflict.statusCode).toBe(409); expect(conflict.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
  });
  it('enforces revision, target plan, strict fields and idempotency header', async () => {
    const request = (body: unknown, extra: Record<string, string> = headers()) => app.inject({ method: 'POST', url: `/api/skills/${version.id}/run`, headers: extra, payload: body as object });
    expect((await request({ ...payload(), expectedRevision: revision + 1 })).json().error.code).toBe('SKILL_VERSION_CONFLICT');
    expect((await request({ ...payload(), plan: { nodes: [{ id: 'other', skillId: randomUUID() }] } })).json().error.code).toBe('SKILL_PLAN_TARGET_MISMATCH');
    expect((await request({ ...payload(), approve: true })).statusCode).toBe(400);
    expect((await request(payload(), { 'x-fixture-owner': f.owner })).statusCode).toBe(400);
    expect((await request(payload(), { ...headers(), 'idempotency-key': 'invalid/key' })).statusCode).toBe(400);
  });
  it('requires a session and never reveals another owner’s skill, run or evidence', async () => {
    expect((await app.inject({ method: 'POST', url: `/api/skills/${version.id}/run`, payload: payload() })).statusCode).toBe(401);
    const foreign = { ...headers(), 'x-fixture-owner': 'another-owner' };
    expect((await app.inject({ method: 'POST', url: `/api/skills/${version.id}/run`, headers: foreign, payload: payload() })).statusCode).toBe(404);
    for (const suffix of ['', '/evidence']) expect((await app.inject({ url: `/api/skills/runs/${runId}${suffix}`, headers: foreign })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/skills/runs/${runId}/cancel`, headers: foreign, payload: {} })).statusCode).toBe(404);
  });
  it('returns bounded run metadata and paginated owned evidence without execution inputs, leases or preimages', async () => {
    const response = await app.inject({ url: `/api/skills/runs/${runId}`, headers: headers() });
    expect(response.statusCode, response.body).toBe(200);
    expect(SkillRunSummarySchema.parse(response.json()).nodes).toHaveLength(2);
    expect(response.body).not.toContain('Owned fixture evidence'); expect(response.body).not.toContain('lease'); expect(response.body).not.toContain('preimage');
    const page = await app.inject({ url: `/api/skills/runs/${runId}/evidence?limit=1&offset=1`, headers: headers() });
    const parsed = SkillEvidencePageSchema.parse(page.json()); expect(parsed).toMatchObject({ total: 2, limit: 1, offset: 1 }); expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].details[0]).toEqual({ kind: 'fixture.receipt', data: { observed: 'Owner-only observation.' } });
    for (const query of ['limit=11', 'offset=-1', 'unknown=1']) expect((await app.inject({ url: `/api/skills/runs/${runId}/evidence?${query}`, headers: headers() })).statusCode).toBe(400);
  });
  it('blocks new execution when disabled while retaining owned history and cancellation', async () => {
    const response = await disabled.inject({ method: 'POST', url: `/api/skills/${version.id}/run`, headers: headers(), payload: payload() });
    expect(response.statusCode).toBe(403); expect(response.json().error.code).toBe('SKILL_ENGINE_DISABLED');
    expect((await disabled.inject({ url: `/api/skills/runs/${runId}`, headers: headers() })).statusCode).toBe(200);
  });
  it('cancels through Runtime once, retains unknown evidence and accepts no invented revision', async () => {
    const request = (body: unknown) => disabled.inject({ method: 'POST', url: `/api/skills/runs/${runId}/cancel`, headers: headers(), payload: body as object });
    expect((await request({ expectedRevision: 1 })).statusCode).toBe(400);
    const first = await request({}); expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ task: { id: parentId, status: 'cancelled', cancellationRequested: true }, run: { id: runId, status: 'cancelled' } });
    const repeated = await request({}); expect(repeated.json()).toEqual(first.json());
    expect((await f.store.db.selectFrom('skill_evidence').select('status').where('run_id', '=', runId).execute()).every(row => row.status === 'unknown')).toBe(true);
  });
  it('rejects revoked or instruction-only versions before creating another task', async () => {
    const instruction = await f.version({ ...toolContract(), level: 'instruction', steps: [], outputs: [], requires: {} });
    const detail = await f.skills.detail(f.owner, instruction.id);
    const response = await app.inject({ method: 'POST', url: `/api/skills/${instruction.id}/run`, headers: { ...headers(), 'idempotency-key': randomUUID() }, payload: { expectedRevision: detail.skill.revision, values: {} } });
    expect(response.json().error.code).toBe('SKILL_INSTRUCTION_ONLY');
    await f.skills.revoke(f.owner, version.id, { expectedRevision: revision, reason: 'End fixture approval.' });
    const revoked = await f.skills.detail(f.owner, version.id);
    expect((await app.inject({ method: 'POST', url: `/api/skills/${version.id}/run`, headers: headers(), payload: { ...payload(), expectedRevision: revoked.skill.revision } })).json().error.code).toBe('SKILL_NOT_ACTIVE');
  });
});
