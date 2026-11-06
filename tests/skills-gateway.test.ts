import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createToolGateway } from '@mohassan/skills';
import { ProviderError, type ModelRequest, type ModelResult } from '@mohassan/providers';
import { createSkillRuntime } from '../apps/server/src/skill-runtime.js';
import type { SkillToolControls } from '../apps/server/src/skill-tools.js';
import type { SkillGatewayContext, SkillToolAdapter } from '../packages/skills/src/gateway.js';
import { decideRecovery } from '../packages/skills/src/fallback.js';
import { executionFixture, singlePlan, toolContract } from './helpers/skill-execution.js';

let fixture: Awaited<ReturnType<typeof executionFixture>> | undefined;
afterEach(async () => { await fixture?.store.close(); fixture = undefined; });
function deferred<T = void>() { let resolve!: (value: T | PromiseLike<T>) => void; const promise = new Promise<T>(ready => { resolve = ready; }); return { promise, resolve }; }
function adapter(overrides: Partial<SkillToolAdapter> = {}): SkillToolAdapter {
  return { id: 'research.run', input: z.object({ query: z.string().max(64000) }).strict(), output: z.object({ answer: z.string() }).strict(), execute: vi.fn(async () => ({ answer: 'Verified fixture evidence' })), verify: vi.fn(async () => true), ...overrides };
}
async function execution(input?: ReturnType<typeof singlePlan>) {
  fixture = await executionFixture(); const f = fixture, version = await f.version(toolContract());
  const parent = await f.parent(input ? { ...input, plan: { ...input.plan, nodes: [{ ...input.plan.nodes[0], skillId: version.id }] } } : singlePlan(version.id));
  const pending = await f.scheduler.runSkillGraph(parent.input, parent.context); if (pending.kind !== 'pending') throw new Error('pending');
  const child = await f.child(pending.runId, 'main.search');
  const context: SkillGatewayContext = { ...child.context, binding: child.binding, signal: new AbortController().signal, async assertActive() {
    const row = await f.store.db.selectFrom('tasks').selectAll().where('id', '=', child.context.taskId).where('owner_id', '=', f.owner).executeTakeFirstOrThrow();
    const parentRow = await f.store.db.selectFrom('tasks').selectAll().where('id', '=', parent.id).executeTakeFirstOrThrow();
    if (row.lease_token !== child.context.leaseToken || row.cancellation_requested || parentRow.cancellation_requested || !['running', 'verifying'].includes(row.status)) throw new Error('fixture authority lost');
  } };
  return { ...f, version, parent, pending, child, context };
}
async function receipt() { return fixture!.store.db.selectFrom('skill_evidence').selectAll().executeTakeFirstOrThrow(); }

describe('real scheduler and gateway boundaries with trusted fake tool adapters', () => {
  it('claims a node once across concurrent dispatch and verifies its persisted output', async () => {
    const f = await execution(), tool = adapter(), gateway = createToolGateway(f.store.db, { scheduler: f.scheduler, adapters: [tool] });
    const attempts = await Promise.allSettled([gateway.executeNode(f.context), gateway.executeNode(f.context)]);
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1); expect(tool.execute).toHaveBeenCalledOnce();
    const successful = attempts.find(result => result.status === 'fulfilled')!; if (successful.status !== 'fulfilled') throw new Error('result');
    expect(await gateway.verifyNode(successful.value, f.context)).toEqual(successful.value);
    expect(await gateway.verifyNode({ ...successful.value, output: { answer: 'tampered' } }, f.context)).toBeNull();
    expect((await receipt()).status).toBe('succeeded');
    await expect(gateway.executeNode(f.context)).rejects.toMatchObject({ code: 'SKILL_NODE_ALREADY_STARTED' }); expect(tool.execute).toHaveBeenCalledOnce();
  });

  it('rejects a revoked grant before claiming or calling an adapter', async () => {
    const f = await execution(), tool = adapter(), gateway = createToolGateway(f.store.db, { scheduler: f.scheduler, adapters: [tool] });
    await f.store.db.updateTable('skill_grants').set({ revoked_at: new Date() }).where('version_id', '=', f.version.id).execute();
    await expect(gateway.executeNode(f.context)).rejects.toMatchObject({ code: 'SKILL_SCOPE_REVOKED' }); expect(tool.execute).not.toHaveBeenCalled();
    expect(await f.store.db.selectFrom('skill_evidence').select('id').execute()).toEqual([]);
  });

  it('does not inherit owner or content authority from a previously valid composition', async () => {
    const f = await execution(), tool = adapter(), gateway = createToolGateway(f.store.db, { scheduler: f.scheduler, adapters: [tool] });
    await expect(gateway.executeNode({ ...f.context, ownerId: 'another-owner' })).rejects.toMatchObject({ code: 'SKILL_AUTHORITY_REVOKED' });
    await f.store.db.updateTable('skill_files').set({ content: 'Changed after inspection' }).where('version_id', '=', f.version.id).execute();
    await expect(gateway.executeNode(f.context)).rejects.toMatchObject({ code: 'SKILL_INTEGRITY_FAILED' }); expect(tool.execute).not.toHaveBeenCalled();
  });

  it('rechecks grant revocation after an adapter starts and refuses a successful receipt', async () => {
    const f = await execution(), entered = deferred(), release = deferred();
    const tool = adapter({ execute: vi.fn(async (_input, context) => { entered.resolve(); await release.promise; await context.assertActive(); return { answer: 'Uncommitted result' }; }) });
    const gateway = createToolGateway(f.store.db, { scheduler: f.scheduler, adapters: [tool] }), pending = gateway.executeNode(f.context), rejected = expect(pending).rejects.toMatchObject({ code: 'SKILL_SCOPE_REVOKED' });
    await entered.promise; await f.store.db.updateTable('skill_grants').set({ revoked_at: new Date() }).where('version_id', '=', f.version.id).execute(); release.resolve(); await rejected;
    expect((await receipt()).status).toBe('unknown'); expect(tool.execute).toHaveBeenCalledOnce();
  });

  it('rejects expanded input before effect dispatch', async () => {
    const f = await execution(), tool = adapter({ input: z.object({ query: z.literal('different exact request') }).strict() }), gateway = createToolGateway(f.store.db, { scheduler: f.scheduler, adapters: [tool] });
    await expect(gateway.executeNode(f.context)).rejects.toThrow(); expect(tool.execute).not.toHaveBeenCalled(); expect((await receipt()).status).toBe('failed');
  });

  it.each(['wrong_type', 'missing_declared_output', 'oversized', 'failed_independent_check'])('refuses %s output without a successful receipt or automatic retry', async scenario => {
    const f = await execution();
    const tool = adapter({
      output: z.object({ answer: z.unknown().optional() }).strict(),
      execute: vi.fn(async () => scenario === 'wrong_type' ? { answer: 7 } : scenario === 'missing_declared_output' ? {} : { answer: scenario === 'oversized' ? 'ع'.repeat(40000) : 'Unverified fixture evidence' }),
      verify: vi.fn(async () => scenario !== 'failed_independent_check'),
    });
    const gateway = createToolGateway(f.store.db, { scheduler: f.scheduler, adapters: [tool] });
    await expect(gateway.executeNode(f.context)).rejects.toThrow(); expect(tool.execute).toHaveBeenCalledOnce(); expect((await receipt()).status).toBe('unknown');
    await expect(gateway.executeNode(f.context)).rejects.toMatchObject({ code: 'SKILL_NODE_ALREADY_STARTED' }); expect(tool.execute).toHaveBeenCalledOnce();
  });

  it('stores combined evidence over 64 KiB while each execution input/output remains within its own bound', async () => {
    const input = singlePlan('00000000-0000-4000-8000-000000000001'); input.values.query = 'x'.repeat(60000);
    const f = await execution(input), tool = adapter({ execute: vi.fn(async () => ({ answer: 'ب'.repeat(28000) })) }), gateway = createToolGateway(f.store.db, { scheduler: f.scheduler, adapters: [tool] });
    const result = await gateway.executeNode(f.context), saved = await receipt();
    expect(Buffer.byteLength(JSON.stringify(saved.details))).toBeGreaterThan(65536); expect(Buffer.byteLength(JSON.stringify(saved.details))).toBeLessThanOrEqual(1048576);
    expect(await gateway.verifyNode(result, f.context)).toEqual(result);
  });

  it('keeps a late aborted operation unknown while accepting its original usage accounting exactly once', async () => {
    const f = await execution(), entered = deferred(), release = deferred(), finished = deferred(), controller = new AbortController();
    const tool = adapter({ execute: vi.fn(async (_input, context) => {
      entered.resolve(); await release.promise;
      try { await context.recordUsage({ model: 'late-fixture', usageKnown: true, inputTokens: 5, outputTokens: 2 }); return { answer: 'Late result is not committed' }; }
      finally { finished.resolve(); }
    }) });
    const gateway = createToolGateway(f.store.db, { scheduler: f.scheduler, adapters: [tool] }), pending = gateway.executeNode({ ...f.context, signal: controller.signal }), rejected = expect(pending).rejects.toMatchObject({ code: 'SKILL_EXECUTION_ABORTED' });
    await entered.promise; controller.abort(new Error('fixture cancelled')); await rejected;
    expect((await receipt()).status).toBe('unknown'); release.resolve(); await finished.promise;
    const saved = await receipt(); expect(saved.status).toBe('unknown'); expect(saved.output).toBeNull();
    expect(saved.details.filter((entry: any) => entry.kind === 'model.usage')).toEqual([{ kind: 'model.usage', data: { model: 'late-fixture', usageKnown: true, inputTokens: 5, outputTokens: 2 } }]);
    expect(saved.details.filter((entry: any) => entry.kind === 'gateway.failure')).toEqual([{kind: 'gateway.failure', data: {source: 'adapter', effect: 'unknown', retryable: false, errorCode: 'SKILL_EXECUTION_ABORTED', tool: 'research.run'}}]);
    expect(await gateway.verifyNode({ output: { answer: 'Late result is not committed' } }, f.context)).toBeNull(); expect(tool.execute).toHaveBeenCalledOnce();
  });
});

async function modelExecution(generate: (request: ModelRequest) => Promise<ModelResult>, retry = false) {
  fixture = await executionFixture(); const f = fixture, contract = toolContract();
  if (retry) { contract.idempotent = true; contract.retry = {maxAttempts: 3}; }
  contract.requires.scopes.push('model:generate');
  contract.steps.unshift({ id: 'reason', kind: 'model', title: 'Typed data transformation', dependsOn: [], inputs: { goal: 'input.query' }, outputs: [{ name: 'analysis', type: 'string', required: true, description: 'Untrusted model analysis' }] });
  contract.steps[1].dependsOn = ['reason']; contract.steps[1].inputs = { query: 'reason.analysis' };
  const version = await f.version(contract), parent = await f.parent(singlePlan(version.id));
  const parentRow = await f.store.db.selectFrom('tasks').selectAll().where('id', '=', parent.id).executeTakeFirstOrThrow();
  // Shared production wiring requires the real consumed workflow grant, rather
  // than the lightweight scheduler-only fixture authority callback.
  await f.store.db.insertInto('approvals').values({id: randomUUID(), task_id: parent.id, owner_id: f.owner,
    capability_id: 'skill.run', capability_version: parentRow.capability_version, input_hash: parentRow.input_hash,
    scope: `skill.run:${parentRow.input_hash}`, expires_at: new Date(Date.now() + 60_000), consumed_at: new Date(), consumed_lease_token: parentRow.workflow_token}).execute();
  // No browser or memory action runs: the only ready node uses the injected
  // trusted model transport, never credentials or a live service.
  const runtime = createSkillRuntime(f.store.db, { skills: f.skills, browser: {} as SkillToolControls['browser'], memory: {} as SkillToolControls['memory'], modelGenerate: generate });
  const pending = await runtime.scheduler.runSkillGraph(parent.input, parent.context); if (pending.kind !== 'pending') throw new Error('pending');
  const child = await f.child(pending.runId, 'main.reason'), context = { ...child.context, binding: child.binding, signal: new AbortController().signal, assertActive: async () => undefined };
  return { ...f, version, runtime, child, context };
}

describe('shared model adapter with actual scheduler/gateway and mocked transport', () => {
  it.each([1500, 600000])('persists a confirmed zero-usage 429 with the full %i ms durable delay', async retryAfterMs => {
    const failure = new ProviderError('RATE_LIMITED', 'Controlled rate limit', true, 429); failure.usage = {inputTokens: 0, outputTokens: 0}; failure.retryAfterMs = retryAfterMs;
    const generate = vi.fn(async (): Promise<ModelResult> => { throw failure; }), f = await modelExecution(generate, true);
    await expect(f.runtime.gateway.executeNode(f.context)).rejects.toBe(failure); const saved = await receipt();
    expect(saved.status).toBe('failed'); expect(generate).toHaveBeenCalledOnce();
    expect(saved.details.find((entry: any) => entry.kind === 'gateway.failure').data).toMatchObject({effect: 'none', source: 'provider_rejection', retryable: true, retryAfterMs});
    expect(decideRecovery({contract: f.version.contract, step: f.version.contract.steps[0], attempt: 1,
      receipt: {status: saved.status, finishedAt: saved.finished_at, details: saved.details}})).toMatchObject({action: 'retry', attempt: 2, notBefore: new Date(new Date(saved.finished_at).getTime() + retryAfterMs)});
    await expect(f.runtime.gateway.executeNode(f.context)).rejects.toMatchObject({code: 'SKILL_NODE_ALREADY_STARTED'}); expect(generate).toHaveBeenCalledOnce();
  });

  it('preserves an original provider error with invalid metadata and refuses automatic replay', async () => {
    const failure = new ProviderError('RATE_LIMITED', 'Malformed fixture headers', true, 429); failure.usage = {inputTokens: 0, outputTokens: 0}; failure.retryAfterMs = NaN;
    const generate = vi.fn(async (): Promise<ModelResult> => { throw failure; }), f = await modelExecution(generate, true);
    await expect(f.runtime.gateway.executeNode(f.context)).rejects.toBe(failure); const saved = await receipt();
    expect(saved.status).toBe('unknown'); expect(saved.details.find((entry: any) => entry.kind === 'model.usage').data).toMatchObject({usageKnown: true, retryAfterInvalid: true});
    expect(saved.details.find((entry: any) => entry.kind === 'gateway.failure').data).toMatchObject({effect: 'unknown', retryable: false, retryAfterInvalid: true});
    expect(generate).toHaveBeenCalledOnce(); expect(Number.isNaN(failure.retryAfterMs)).toBe(true);
  });
  it('requires model scope and keeps tool authority outside the model prompt', async () => {
    const generate = vi.fn(async (_request: ModelRequest): Promise<ModelResult> => ({ text: JSON.stringify({ analysis: 'Bounded fixture analysis' }), model: 'fixture-model', usage: { inputTokens: 15, outputTokens: 7 } }));
    const f = await modelExecution(generate), result = await f.runtime.gateway.executeNode(f.context);
    expect(generate).toHaveBeenCalledOnce(); expect(JSON.parse(generate.mock.calls[0][0].goal)).toMatchObject({ trust: 'untrusted_skill_data', toolsGranted: false });
    expect(await f.runtime.gateway.verifyNode(result, f.context)).toEqual(result);
    expect((await receipt()).details.some((entry: any) => entry.kind === 'model.usage' && entry.data.inputTokens === 15)).toBe(true);
    await f.store.db.updateTable('skill_grants').set({ scopes: JSON.stringify(['research:read']) }).where('version_id', '=', f.version.id).execute();
    expect(await f.runtime.gateway.verifyNode(result, f.context)).toBeNull(); expect(generate).toHaveBeenCalledOnce();
  });

  it('rejects a model call when the model grant was narrowed after planning', async () => {
    const generate = vi.fn(async (): Promise<ModelResult> => ({ text: '{}', model: 'unused', usage: { inputTokens: 0, outputTokens: 0 } })), f = await modelExecution(generate);
    await f.store.db.updateTable('skill_grants').set({ scopes: JSON.stringify(['research:read']) }).where('version_id', '=', f.version.id).execute();
    await expect(f.runtime.gateway.executeNode(f.context)).rejects.toMatchObject({ code: 'SKILL_SCOPE_REVOKED' }); expect(generate).not.toHaveBeenCalled();
  });

  it('preserves paid malformed-model output usage and does not execute undeclared output fields', async () => {
    const generate = vi.fn(async (): Promise<ModelResult> => ({ text: JSON.stringify({ analysis: 'fixture', tools: ['computer.act'] }), model: 'fixture-model', usage: { inputTokens: 12, outputTokens: 6 } })), f = await modelExecution(generate);
    await expect(f.runtime.gateway.executeNode(f.context)).rejects.toThrow(); const saved = await receipt();
    expect(saved.status).toBe('unknown'); expect(saved.output).toBeNull(); expect(saved.details.some((entry: any) => entry.kind === 'model.usage' && entry.data.inputTokens === 12 && entry.data.outputTokens === 6)).toBe(true); expect(generate).toHaveBeenCalledOnce();
  });

  it('records ambiguous provider failure usage with one model call', async () => {
    const failure = new ProviderError('UPSTREAM_UNAVAILABLE', 'Ambiguous fixture 503', false, 503); failure.usage = { inputTokens: 9, outputTokens: 4 };
    const generate = vi.fn(async (): Promise<ModelResult> => { throw failure; }), f = await modelExecution(generate);
    await expect(f.runtime.gateway.executeNode(f.context)).rejects.toBe(failure); const saved = await receipt();
    expect(saved.status).toBe('unknown'); expect(saved.details.some((entry: any) => entry.kind === 'model.usage' && entry.data.usageKnown && entry.data.inputTokens === 9 && entry.data.errorCode === 'UPSTREAM_UNAVAILABLE')).toBe(true); expect(generate).toHaveBeenCalledOnce();
  });
});
