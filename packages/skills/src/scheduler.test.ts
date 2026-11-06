import { afterEach, describe, expect, it } from 'vitest';
import { SkillNodeBindingSchema, SkillRunInputSchema } from '@mohassan/contracts';
import { executionFixture, singlePlan, toolContract } from '../../../tests/helpers/skill-execution.ts';
import { canonicalSkillEvidenceJson, canonicalSkillJson, hashSkillData } from './evidence.ts';
import { sha256 } from './hash.ts';
import { createSkillScheduler } from './scheduler.ts';

let fixture: Awaited<ReturnType<typeof executionFixture>> | undefined;
afterEach(async () => { await fixture?.store.close(); fixture = undefined; });
async function start() {
  fixture = await executionFixture();
  const version = await fixture.version(toolContract()), parent = await fixture.parent(singlePlan(version.id));
  const pending = await fixture.scheduler.runSkillGraph(parent.input, parent.context);
  if (pending.kind !== 'pending') throw new Error('Expected pending');
  return { ...fixture, version, parent, pending };
}

describe('typed pinned skill execution schemas', () => {
  it('canonicalizes nested object keys across JSONB round trips', () => {
    expect(hashSkillData({ z: [{ b: 2, a: 1 }], a: true })).toBe(hashSkillData({ a: true, z: [{ a: 1, b: 2 }] }));
  });
  it('allows bounded aggregate evidence without expanding execution input limits', () => {
    const aggregate = { input: { value: 'a'.repeat(40000) }, output: { value: 'b'.repeat(40000) } };
    expect(() => canonicalSkillJson(aggregate)).toThrow(expect.objectContaining({ code: 'SKILL_DATA_INVALID' }));
    expect(JSON.parse(canonicalSkillEvidenceJson(aggregate))).toEqual(aggregate);
    expect(() => canonicalSkillEvidenceJson({ oversized: 'x'.repeat(131073) })).toThrow();
  });
  it.each([NaN, Infinity, undefined, () => 1, { value: 'x'.repeat(65537) }])('rejects non-JSON or oversized payload %s', value => {
    expect(SkillRunInputSchema.safeParse({ ...singlePlan('00000000-0000-4000-8000-000000000001'), values: { query: value } }).success).toBe(false);
  });
  it('does not accept a model binding disguised as a tool', () => {
    expect(SkillNodeBindingSchema.safeParse({ parentTaskId: '00000000-0000-4000-8000-000000000001', runId: '00000000-0000-4000-8000-000000000002', nodeId: 'main.search', versionId: '00000000-0000-4000-8000-000000000003', contentHash: 'a'.repeat(64), inputsHash: 'b'.repeat(64), kind: 'model', tool: 'research.run' }).success).toBe(false);
  });
});

describe('durable scheduler advancement', () => {
  it('queues bounded children and yields instead of awaiting execution, then requires both receipt and completed child', async () => {
    const f = await start();
    expect(f.pending.childTaskIds).toHaveLength(1);
    const child = await f.child(f.pending.runId, 'main.search');
    const claim = await f.scheduler.claimNode(child.binding, child.context);
    expect((await f.store.db.selectFrom('skill_evidence').select('status').executeTakeFirstOrThrow()).status).toBe('started');
    const result = await f.scheduler.recordNodeResult(claim, { outcome: 'succeeded', outputs: { answer: 'Verified fixture answer' } });
    expect(result).not.toBeNull(); expect(await f.scheduler.verifyNodeResult(f.owner, child.binding, child.context.taskId)).toEqual(result);
    expect((await f.scheduler.runSkillGraph(f.parent.input, f.parent.context)).kind).toBe('pending');
    await f.store.db.updateTable('tasks').set({ status: 'completed', result: JSON.stringify(result) }).where('id', '=', child.context.taskId).execute();
    const complete = await f.scheduler.runSkillGraph(f.parent.input, f.parent.context);
    expect(complete.kind).toBe('complete');
    if (complete.kind === 'complete') {
      expect(complete.result.outputs).toEqual({ main: { answer: 'Verified fixture answer' } });
      expect(await f.scheduler.verifyRunResult(complete.result, { ownerId: f.owner, taskId: f.parent.id })).toEqual(complete.result);
      expect(await f.scheduler.verifyRunResult({ ...complete.result, outputs: {} }, { ownerId: f.owner, taskId: f.parent.id })).toBeNull();
    }
  });
  it('pins dependent outputs into the next child only after the producer commits', async () => {
    fixture = await executionFixture(); const f = fixture;
    const contract = toolContract();
    contract.steps.push({ ...contract.steps[0], id: 'summarize', dependsOn: ['search'], inputs: { query: 'search.answer' }, outputs: [{ name: 'final', type: 'string', required: true, description: 'Final answer' }] });
    contract.outputs = [{ name: 'final', type: 'string', required: true, description: 'Final answer' }];
    const version = await f.version(contract), parent = await f.parent(singlePlan(version.id));
    const pending = await f.scheduler.runSkillGraph(parent.input, parent.context); if (pending.kind !== 'pending') throw new Error('pending');
    expect(pending.childTaskIds).toHaveLength(1);
    const first = await f.child(pending.runId, 'main.search'), claim = await f.scheduler.claimNode(first.binding, first.context);
    await f.scheduler.recordNodeResult(claim, { outcome: 'succeeded', outputs: { answer: 'Pinned producer output' } });
    await f.store.db.updateTable('tasks').set({ status: 'completed' }).where('id', '=', first.context.taskId).execute();
    await f.scheduler.runSkillGraph(parent.input, parent.context);
    const second = await f.scheduler.readNode(f.store.db, f.owner, pending.runId, 'main.summarize');
    expect(second?.node.inputs).toEqual({ query: 'Pinned producer output' });
    expect(second?.binding?.inputsHash).toBe(hashSkillData({ query: 'Pinned producer output' }));
  });
  it('persists and verifies a parent result larger than one bounded child output', async () => {
    fixture = await executionFixture(); const f = fixture;
    const version = await f.version(toolContract()), input = singlePlan(version.id);
    input.plan.nodes.push({ ...input.plan.nodes[0], id: 'second' });
    const parent = await f.parent(input), pending = await f.scheduler.runSkillGraph(parent.input, parent.context);
    if (pending.kind !== 'pending') throw new Error('pending');
    expect(pending.childTaskIds).toHaveLength(2);
    for (const nodeId of ['main.search', 'second.search']) {
      const child = await f.child(pending.runId, nodeId), claim = await f.scheduler.claimNode(child.binding, child.context);
      await f.scheduler.appendEvidence(claim, { kind: 'fixture.aggregate', data: { inputs: { value: 'x'.repeat(40000) }, actual: { value: 'y'.repeat(40000) } } });
      await f.scheduler.recordNodeResult(claim, { outcome: 'succeeded', outputs: { answer: 'a'.repeat(40000) } });
      await f.store.db.updateTable('tasks').set({ status: 'completed' }).where('id', '=', child.context.taskId).execute();
    }
    const complete = await f.scheduler.runSkillGraph(parent.input, parent.context);
    if (complete.kind !== 'complete') throw new Error('complete');
    expect(JSON.stringify(complete.result).length).toBeGreaterThan(65536);
    expect(await f.scheduler.verifyRunResult(complete.result, { ownerId: f.owner, taskId: parent.id })).toEqual(complete.result);
  });
  it('rejects ambiguous exported producers before any child exists', async () => {
    fixture = await executionFixture(); const f = fixture, contract = toolContract();
    contract.steps.push({ ...contract.steps[0], id: 'another', dependsOn: ['search'] });
    const version = await f.version(contract), parent = await f.parent(singlePlan(version.id));
    await expect(f.scheduler.runSkillGraph(parent.input, parent.context)).rejects.toMatchObject({ code: 'SKILL_OUTPUT_PRODUCER_INVALID' });
    expect(await f.store.db.selectFrom('skill_runs').select('id').execute()).toEqual([]);
  });
  it('requires an explicit model scope instead of inheriting a tool grant', async () => {
    fixture = await executionFixture(); const f = fixture, contract = toolContract();
    contract.steps.push({ id: 'reason', kind: 'model', title: 'Model fixture', dependsOn: ['search'], inputs: { evidence: 'search.answer' }, outputs: [] });
    const version = await f.version(contract), parent = await f.parent(singlePlan(version.id));
    await expect(f.scheduler.runSkillGraph(parent.input, parent.context)).rejects.toMatchObject({ code: 'SKILL_MODEL_SCOPE_REQUIRED' });
  });
  it('does not turn an instruction-only plan into an execution receipt', async () => {
    fixture = await executionFixture(); const f = fixture;
    const version = await f.version({ ...toolContract(), level: 'instruction', steps: [], outputs: [], requires: {} });
    const parent = await f.parent(singlePlan(version.id));
    await expect(f.scheduler.runSkillGraph(parent.input, parent.context)).rejects.toMatchObject({ code: 'SKILL_INSTRUCTION_ONLY' });
  });
  it('stops a failed child without a receipt as unknown rather than leaving an empty paused parent', async () => {
    const f = await start();
    await f.store.db.updateTable('tasks').set({ status: 'failed' }).where('id', '=', f.pending.childTaskIds[0]).execute();
    await expect(f.scheduler.runSkillGraph(f.parent.input, f.parent.context)).rejects.toMatchObject({ code: 'SKILL_CHILD_FAILED' });
    expect((await f.store.db.selectFrom('skill_runs').select('status').executeTakeFirstOrThrow()).status).toBe('unknown');
  });
  it('refuses altered inputs, foreign claims, and expired child leases before dispatch', async () => {
    const f = await start(), child = await f.child(f.pending.runId, 'main.search');
    await expect(f.scheduler.claimNode({ ...child.binding, inputsHash: 'f'.repeat(64) }, child.context)).rejects.toMatchObject({ code: 'SKILL_FENCE_LOST' });
    await expect(f.scheduler.claimNode(child.binding, { ...child.context, ownerId: 'foreign' })).rejects.toMatchObject({ code: 'SKILL_PARENT_INACTIVE' });
    await f.store.db.updateTable('tasks').set({ lease_expires_at: new Date(0) }).where('id', '=', child.context.taskId).execute();
    await expect(f.scheduler.claimNode(child.binding, child.context)).rejects.toMatchObject({ code: 'SKILL_FENCE_LOST' });
    expect(await f.store.db.selectFrom('skill_evidence').select('id').execute()).toEqual([]);
  });
  it.each(['step', 'output_schema'])('refuses a tampered pinned %s before recording a started attempt', async column => {
    const f = await start(), child = await f.child(f.pending.runId, 'main.search');
    const tampered = column === 'step' ? { ...f.version.contract.steps[0], title: 'Uninspected step' } : [];
    await f.store.db.updateTable('skill_run_nodes').set({ [column]: JSON.stringify(tampered) }).where('run_id', '=', f.pending.runId).execute();
    await expect(f.scheduler.claimNode(child.binding, child.context)).rejects.toMatchObject({ code: 'SKILL_NODE_INTEGRITY_FAILED' });
    expect(await f.store.db.selectFrom('skill_evidence').select('id').execute()).toEqual([]);
  });
  it('persists the checked preimage and blocks replacing it after the claim', async () => {
    const f = await start(), child = await f.child(f.pending.runId, 'main.search'), claim = await f.scheduler.claimNode(child.binding, child.context);
    const data = { root: 'fixture-root', path: 'fixture.txt', before: 'before', beforeHash: sha256('before'), afterHash: sha256('after') };
    await f.scheduler.saveNodePreimage(claim, data); await f.scheduler.saveNodePreimage(claim, data);
    expect(await f.store.db.selectFrom('skill_preimages').select('before_text').execute()).toEqual([{ before_text: 'before' }]);
    await expect(f.scheduler.saveNodePreimage(claim, { ...data, beforeHash: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'SKILL_PREIMAGE_INVALID' });
    await expect(f.scheduler.saveNodePreimage(claim, { ...data, afterHash: sha256('changed') })).rejects.toMatchObject({ code: 'SKILL_PREIMAGE_CONFLICT' });
  });
  it('keeps a cancelled started attempt unknown and never replays it', async () => {
    const f = await start(), child = await f.child(f.pending.runId, 'main.search'), claim = await f.scheduler.claimNode(child.binding, child.context);
    await f.store.db.transaction().execute(async tx => { await tx.selectFrom('tasks').select('id').where('id', '=', f.parent.id).forUpdate().executeTakeFirstOrThrow(); await f.scheduler.cancelRun(tx, f.owner, f.parent.id); });
    expect(await f.scheduler.recordNodeResult(claim, { outcome: 'succeeded', outputs: { answer: 'Late result' } })).toBeNull();
    expect((await f.store.db.selectFrom('skill_evidence').select('status').executeTakeFirstOrThrow()).status).toBe('unknown');
    await expect(f.scheduler.claimNode(child.binding, child.context)).rejects.toBeDefined();
  });
  it.each(['claim', 'commit'])('allows a parallel child %s while a completed sibling wakes the authorized parent to queued', async phase => {
    fixture = await executionFixture(); const f = fixture, version = await f.version(toolContract()), input = singlePlan(version.id);
    input.plan.nodes.push({ ...input.plan.nodes[0], id: 'second' });
    const parent = await f.parent(input), pending = await f.scheduler.runSkillGraph(parent.input, parent.context);
    const first = await f.child(pending.runId, 'main.search'), second = await f.child(pending.runId, 'second.search');
    const a = await f.scheduler.claimNode(first.binding, first.context);
    let b = phase === 'commit' ? await f.scheduler.claimNode(second.binding, second.context) : undefined;
    await f.scheduler.recordNodeResult(a, { outcome: 'succeeded', outputs: { answer: 'First completed' } });
    await f.store.db.updateTable('tasks').set({ status: 'completed' }).where('id', '=', first.context.taskId).execute();
    await f.store.db.updateTable('tasks').set({ status: 'queued' }).where('id', '=', parent.id).execute();
    b ??= await f.scheduler.claimNode(second.binding, second.context);
    expect(await f.scheduler.recordNodeResult(b, { outcome: 'succeeded', outputs: { answer: 'Second completed' } })).not.toBeNull();
  });
  it('refuses execution without Runtime authority and fences a late result after workflow approval renewal', async () => {
    const f = await start(), child = await f.child(f.pending.runId, 'main.search');
    const unconfigured = createSkillScheduler(f.store.db, { validateComposition: f.skills.validateComposition });
    await expect(unconfigured.claimNode(child.binding, child.context)).rejects.toMatchObject({ code: 'SKILL_PARENT_INACTIVE' });
    const claim = await f.scheduler.claimNode(child.binding, child.context);
    await f.store.db.updateTable('tasks').set({ workflow_token: 'different-approved-workflow' }).where('id', '=', f.parent.id).execute();
    expect(await f.scheduler.recordNodeResult(claim, { outcome: 'succeeded', outputs: { answer: 'Late old approval' } })).toBeNull();
    expect((await f.store.db.selectFrom('skill_evidence').select('status').executeTakeFirstOrThrow()).status).toBe('unknown');
  });
});
