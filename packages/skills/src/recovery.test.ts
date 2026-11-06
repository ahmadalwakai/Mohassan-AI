import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { executionFixture, singlePlan, toolContract } from '../../../tests/helpers/skill-execution.ts';
import { canonicalSkillEvidenceJson, hashSkillData } from './evidence.ts';
import { sha256 } from './hash.ts';

let fixture: Awaited<ReturnType<typeof executionFixture>> | undefined;
afterEach(async () => { await fixture?.store.close(); fixture = undefined; });
const rejection = (delay = 0) => ({ kind: 'gateway.failure', data: { source: 'provider_rejection', effect: 'none', retryable: true, errorCode: 'RATE_LIMITED', httpStatus: 429, retryAfterMs: delay, usage: { inputTokens: 0, outputTokens: 0 } } });
async function modelRun() {
  fixture = await executionFixture(); const f = fixture, contract = toolContract();
  contract.idempotent = true; contract.retry.maxAttempts = 3; contract.requires.scopes.push('model:generate');
  const output = { name: 'final', type: 'string' as const, required: true, description: 'Verified fixture summary' };
  contract.outputs = [output]; contract.steps.push({ id: 'summarize', kind: 'model', title: 'Fixture summary', dependsOn: ['search'], inputs: { goal: 'input.query' }, outputs: [output] });
  const version = await f.version(contract), parent = await f.parent(singlePlan(version.id)), pending = await f.scheduler.runSkillGraph(parent.input, parent.context);
  const search = await f.child(pending.runId, 'main.search'), claim = await f.scheduler.claimNode(search.binding, search.context);
  await f.scheduler.recordNodeResult(claim, { outcome: 'succeeded', outputs: { answer: 'Verified evidence' } });
  await f.store.db.updateTable('tasks').set({ status: 'completed' }).where('id', '=', search.context.taskId).execute();
  await f.scheduler.runSkillGraph(parent.input, parent.context);
  const child = await f.child(pending.runId, 'main.summarize'), model = await f.scheduler.claimNode(child.binding, child.context);
  return { ...f, childTask: f.child, parent, pending, child, claim: model };
}

describe('durable skill scheduler recovery', () => {
  it('persists the full Retry-After, waits until due, and pins a fresh task key without rewriting prior receipts', async () => {
    const f = await modelRun();
    await f.scheduler.recordNodeResult(f.claim, { outcome: 'failed', errorCode: 'RATE_LIMITED', evidence: [rejection(600000)] });
    await f.store.db.updateTable('tasks').set({ status: 'failed' }).where('id', '=', f.child.context.taskId).execute();
    const previous = await f.store.db.selectFrom('skill_evidence').selectAll().where('id', '=', f.claim.evidenceId).executeTakeFirstOrThrow();
    const paused = await f.scheduler.runSkillGraph(f.parent.input, f.parent.context); expect(paused.kind).toBe('pending');
    const node = await f.scheduler.readNode(f.store.db, f.owner, f.pending.runId, 'main.summarize');
    expect(node?.node).toMatchObject({ status: 'pending', execution_attempt: 2, child_task_id: null });
    expect(new Date(node!.node.retry_not_before).getTime()).toBe(new Date(previous.finished_at).getTime() + 600000);
    await f.store.db.updateTable('tasks').set({ status: 'paused' }).where('id', '=', f.parent.id).execute();
    expect(await f.scheduler.wakeCandidates()).toEqual([]);
    // Advance only this disposable scheduler clock marker; no timer or real delay is required.
    await f.store.db.updateTable('skill_run_nodes').set({ retry_not_before: new Date(Date.now() - 1) }).where('run_id', '=', f.pending.runId).where('node_id', '=', 'main.summarize').execute();
    expect(await f.scheduler.wakeCandidates()).toEqual([{ ownerId: f.owner, parentTaskId: f.parent.id }]);
    await f.store.db.updateTable('tasks').set({ status: 'running' }).where('id', '=', f.parent.id).execute();
    await f.scheduler.runSkillGraph(f.parent.input, f.parent.context);
    const next = await f.scheduler.readNode(f.store.db, f.owner, f.pending.runId, 'main.summarize');
    expect(next!.node.child_task_id).not.toBe(f.child.context.taskId);
    const task = await f.store.db.selectFrom('tasks').select(['idempotency_key']).where('id', '=', next!.node.child_task_id).executeTakeFirstOrThrow();
    expect(task.idempotency_key).toBe(`skill:${f.pending.runId}:main.summarize:attempt:2`);
    expect(next!.node.inputs_hash).toBe(f.child.binding.inputsHash);
    expect(await f.store.db.selectFrom('skill_evidence').selectAll().where('id', '=', f.claim.evidenceId).executeTakeFirstOrThrow()).toEqual(previous);
    await expect(f.scheduler.acquireNodeResource(f.claim, sha256('stale-claim'))).rejects.toMatchObject({ code: 'SKILL_FENCE_LOST' });
  });
  it('limits retries to three attempts and retains every receipt and task identity', async () => {
    const f = await modelRun(); let child = f.child, claim = f.claim;
    const ids: string[] = [], taskIds: string[] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      ids.push(claim.evidenceId); taskIds.push(child.context.taskId);
      await f.scheduler.recordNodeResult(claim, { outcome: 'failed', errorCode: 'RATE_LIMITED', evidence: [rejection()] });
      await f.store.db.updateTable('skill_evidence').set({ finished_at: new Date(Date.now() - 10000) }).where('id', '=', claim.evidenceId).execute();
      await f.store.db.updateTable('tasks').set({ status: 'failed' }).where('id', '=', child.context.taskId).execute();
      if (attempt === 3) await expect(f.scheduler.runSkillGraph(f.parent.input, f.parent.context)).rejects.toMatchObject({ code: 'SKILL_CHILD_FAILED' });
      else {
        await f.scheduler.runSkillGraph(f.parent.input, f.parent.context);
        child = await f.childTask(f.pending.runId, 'main.summarize'); claim = await f.scheduler.claimNode(child.binding, child.context);
      }
    }
    const receipts = await f.store.db.selectFrom('skill_evidence').select(['id', 'attempt', 'status']).where('node_id', '=', 'main.summarize').orderBy('attempt').execute();
    expect(receipts).toEqual(ids.map((id, index) => ({ id, attempt: index + 1, status: 'failed' })));
    expect(new Set(taskIds).size).toBe(3);
    expect((await f.scheduler.readNode(f.store.db, f.owner, f.pending.runId, 'main.summarize'))!.node.execution_attempt).toBe(3);
  });
  it('classifies a started crashed effect as unknown and retains its resource lock', async () => {
    const f = await modelRun(); await f.scheduler.acquireNodeResource(f.claim, sha256('unknown-resource'));
    await f.store.db.updateTable('tasks').set({ status: 'failed' }).where('id', '=', f.child.context.taskId).execute();
    await expect(f.scheduler.runSkillGraph(f.parent.input, f.parent.context)).rejects.toMatchObject({ code: 'SKILL_CHILD_FAILED' });
    expect((await f.store.db.selectFrom('skill_evidence').select('status').where('id', '=', f.claim.evidenceId).executeTakeFirstOrThrow()).status).toBe('unknown');
    expect(await f.store.db.selectFrom('skill_resource_locks').select('receipt_id').execute()).toEqual([{ receipt_id: f.claim.evidenceId }]);
    expect((await f.scheduler.readNode(f.store.db, f.owner, f.pending.runId, 'main.summarize'))!.node.execution_attempt).toBe(1);
  });
  it('recovers confirmed generic receipts read-only and preserves the original lease across repeated verification crashes', async () => {
    const f = await modelRun(), output = { final: 'Confirmed model output' };
    const result = await f.scheduler.recordNodeResult(f.claim, { outcome: 'succeeded', outputs: output });
    const before = await f.store.db.selectFrom('skill_evidence').selectAll().where('id', '=', f.claim.evidenceId).executeTakeFirstOrThrow();
    const context = { ...f.child.context, binding: f.child.binding };
    expect(await f.scheduler.recoverNode(f.store.db, context)).toEqual({ kind: 'confirmed', result, receiptLeaseToken: f.child.context.leaseToken });
    const verifyingLease = randomUUID();
    await f.store.db.updateTable('tasks').set({ verification_only: true, verification_source_lease: f.child.context.leaseToken, lease_token: verifyingLease }).where('id', '=', f.child.context.taskId).execute();
    expect(await f.scheduler.recoverNode(f.store.db, { ...context, leaseToken: verifyingLease })).toEqual({ kind: 'confirmed', result, receiptLeaseToken: f.child.context.leaseToken });
    expect(await f.store.db.selectFrom('skill_evidence').selectAll().where('id', '=', f.claim.evidenceId).executeTakeFirstOrThrow()).toEqual(before);
    expect(await f.scheduler.recoverNode(f.store.db, { ...context, ownerId: 'foreign' })).toMatchObject({ kind: 'unknown' });
  });
  it('requires original native result proof for mapped task recovery, and rejects a forged hash', async () => {
    const f = await modelRun(), raw = { kind: 'native_fixture', summary: 'Original verified output' }, output = { final: 'Projected output' };
    await f.store.db.updateTable('tasks').set({ capability_id: 'coding.change' }).where('id', '=', f.child.context.taskId).execute();
    const result = await f.scheduler.recordNodeResult(f.claim, { outcome: 'succeeded', outputs: output, evidence: [{ kind: 'runtime.verified', data: { taskId: f.child.context.taskId, resultHash: sha256(canonicalSkillEvidenceJson(raw)), rawResult: raw, projectionHash: hashSkillData(output) } }] });
    expect(result).not.toBeNull();
    const context = { ...f.child.context, binding: f.child.binding };
    expect(await f.scheduler.recoverNode(f.store.db, context)).toMatchObject({ kind: 'confirmed', result: raw });
    await f.store.db.updateTable('skill_evidence').set({ details: JSON.stringify([{ kind: 'runtime.verified', data: { taskId: f.child.context.taskId, resultHash: 'f'.repeat(64), rawResult: raw, projectionHash: hashSkillData(output) } }]) }).where('id', '=', f.claim.evidenceId).execute();
    expect(await f.scheduler.recoverNode(f.store.db, context)).toMatchObject({ kind: 'unknown' });
  });
  it('reserves a bounded wake-up share for due retries even when completed children fill the other queue', async () => {
    fixture = await executionFixture(); const f = fixture, version = await f.version(toolContract());
    for (let index = 0; index < 26; index++) {
      const parent = await f.parent(singlePlan(version.id)), pending = await f.scheduler.runSkillGraph(parent.input, parent.context);
      await f.store.db.updateTable('tasks').set({ status: 'failed' }).where('id', 'in', pending.kind === 'pending' ? pending.childTaskIds : []).execute();
      await f.store.db.updateTable('tasks').set({ status: 'paused' }).where('id', '=', parent.id).execute();
    }
    const due = await f.parent(singlePlan(version.id)), pending = await f.scheduler.runSkillGraph(due.input, due.context);
    await f.store.db.updateTable('skill_run_nodes').set({ status: 'pending', child_task_id: null, execution_attempt: 2, retry_not_before: new Date(Date.now() - 1) }).where('run_id', '=', pending.runId).execute();
    await f.store.db.updateTable('tasks').set({ status: 'paused' }).where('id', '=', due.id).execute();
    const candidates = await f.scheduler.wakeCandidates();
    expect(candidates).toHaveLength(26); expect(candidates).toContainEqual({ ownerId: f.owner, parentTaskId: due.id });
  });
});
