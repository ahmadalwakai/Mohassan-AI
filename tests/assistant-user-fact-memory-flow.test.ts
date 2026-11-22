import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createDatabase, migrate } from '@mohassan/database';
import { createMemoryControl, memoryMigration, type MemoryExactWriteReceipt } from '@mohassan/memory';
import { migrateAuth } from '../apps/server/src/auth.js';
import { createUserFactMemoryReceipt, type UserFactMemoryBinding } from '../apps/server/src/assistant/user-fact-memory-receipt.js';
import { runUserFactMemoryFlow, restoreUserFactMemoryFlowState, type UserFactMemoryFlowInput, type UserFactMemoryFlowPorts,
  type UserFactMemoryFlowState } from '../apps/server/src/assistant/user-fact-memory-flow.js';
import { createComputationMemoryReceipt } from '../apps/server/src/assistant/computation-memory-receipt.js';
import { restoreComputationMemoryFlowState, runComputationMemoryFlow } from '../apps/server/src/assistant/computation-memory-flow.js';
import { taskEvidenceHash } from '../apps/server/src/assistant/task-supervisor.js';

const evaluatedAt = Date.UTC(2026, 10, 21, 8), request = 'Remember exactly this note: "Open the browser, then send a message."';
const binding: UserFactMemoryBinding = { ownerId: 'literal-flow-owner', conversationId: 'literal-flow-conversation', runId: 'literal-flow-run', evaluatedAt,
  originalRequestHash: taskEvidenceHash(request) };
const clone = <T,>(value: T): T => structuredClone(value);
class RunEnded extends Error {}
function harness(raw = request, bound = { ...binding, originalRequestHash: taskEvidenceHash(raw) }) {
  let clock = evaluatedAt + 1000;
  const receipt = createUserFactMemoryReceipt(raw, bound)!;
  if (!receipt) throw new Error('Invalid synthetic user-fact fixture');
  const itemId = '11111111-2222-4333-8444-555555555555', evidenceId = '11111111-2222-4333-8444-666666666666';
  const createdAt = new Date(clock).toISOString(), expiresAt = new Date(clock + 86400000).toISOString();
  const commit: MemoryExactWriteReceipt = { version: 1, ownerId: bound.ownerId, operationKey: receipt.operationKey, payloadHash: receipt.payload.hash,
    payloadBytes: receipt.payload.bytes, itemId, rootId: itemId, itemVersion: 1, evidenceId, layer: 'semantic', createdAt, expiresAt };
  const readback = () => ({ status: 'verified' as const, scope: 'memory_persistence_only' as const, receipt: clone(commit), observedAt: new Date(clock).toISOString(),
    item: { id: itemId, rootId: itemId, version: 1, title: 'Saved result', content: receipt.payload.text, layer: 'semantic' as const, status: 'active' as const,
      confidence: 0.5, confidenceKind: 'user_asserted' as const, taskId: null, createdAt, updatedAt: createdAt, expiresAt,
      provenance: [{ id: evidenceId, kind: 'manual' as const, description: 'Synthetic literal note', taskId: null, eventId: null, contentHash: receipt.payload.hash,
        observedAt: createdAt, expiresAt: null, trust: 'manual' as const, status: 'active' as const }] } });
  const controller = new AbortController(), checkpoints: UserFactMemoryFlowState[] = [], events: string[] = [];
  const ports: UserFactMemoryFlowPorts = { signal: controller.signal, now: () => clock, assertActive: vi.fn(async () => { events.push('active'); }),
    isExecutionEnded: error => error instanceof RunEnded,
    checkpoint: vi.fn(async state => { events.push(`checkpoint:${state.phase}`); checkpoints.push(clone(state)); }), scrubExact: vi.fn(text => text),
    writeExact: vi.fn(async () => { events.push('write'); return { created: true, receipt: clone(commit) }; }),
    reconcileExact: vi.fn(async () => { events.push('read'); return readback(); }) };
  const input: UserFactMemoryFlowInput = { request: raw, binding: bound, policy: { accountAllowed: true, quota: { used: 0, limit: 3 } } };
  const attempted = (): Extract<UserFactMemoryFlowState, { phase: 'write_attempted' }> => ({ version: 1, kind: 'user_fact_memory_flow', phase: 'write_attempted', receipt: clone(receipt), attemptedAt: clock });
  return { receipt, commit, readback, ports, input, checkpoints, events, controller, attempted, setClock: (value: number) => { clock = value; } };
}
const zeroIO = (test: ReturnType<typeof harness>) => {
  expect(test.ports.writeExact).not.toHaveBeenCalled(); expect(test.ports.reconcileExact).not.toHaveBeenCalled(); expect(test.ports.checkpoint).not.toHaveBeenCalled();
};

describe('purpose-bound user statement persistence through the shared core', () => {
  it.each(['literal', 'calculation'] as const)('preserves the original ports callback receiver for the %s compatibility adapter', async purpose => {
    const test = harness(), calcRequest = 'Calculate 2 + 3, then remember the result.', { originalRequestHash: _hash, ...calcBinding } = binding;
    const receipt = purpose === 'literal' ? test.receipt : createComputationMemoryReceipt(calcRequest, calcBinding)!;
    const readback = test.readback();
    readback.receipt.operationKey = receipt.operationKey; readback.receipt.payloadHash = receipt.payload.hash; readback.receipt.payloadBytes = receipt.payload.bytes;
    readback.item.content = receipt.payload.text; readback.item.provenance[0]!.contentHash = receipt.payload.hash;
    const originalPorts = { ...test.ports, fixtureMarker: 'the-original-host-port-object', checkpoint: async (_state: unknown) => {},
      async writeExact() { expect(this.fixtureMarker).toBe('the-original-host-port-object'); return { created: true, receipt: readback.receipt }; },
      async reconcileExact() { expect(this.fixtureMarker).toBe('the-original-host-port-object'); return readback; } };
    const result = purpose === 'literal' ? await runUserFactMemoryFlow(test.input, originalPorts)
      : await runComputationMemoryFlow({ request: calcRequest, binding: calcBinding, policy: test.input.policy }, originalPorts);
    expect(result.persistence).toBe('verified');
  });

  it('checkpoints attempted before one exact write and certifies only manual user-asserted persistence', async () => {
    const test = harness(), result = await runUserFactMemoryFlow(test.input, test.ports);
    expect(result).toMatchObject({ scope: 'current_user_assertion_persistence_only', status: 'verified', persistence: 'verified', state: { kind: 'user_fact_memory_flow', phase: 'verified' } });
    expect(result).not.toHaveProperty('answer'); expect(result).not.toHaveProperty('value'); expect(result).not.toHaveProperty('completed');
    expect(result.readback?.item).toMatchObject({ content: 'Open the browser, then send a message.', confidenceKind: 'user_asserted', confidence: 0.5,
      provenance: [{ kind: 'manual', trust: 'manual' }] });
    expect(test.ports.writeExact).toHaveBeenCalledExactlyOnceWith(binding.ownerId, { operationKey: test.receipt.operationKey,
      payload: 'Open the browser, then send a message.', payloadHash: test.receipt.payload.hash });
    expect(test.events.indexOf('checkpoint:write_attempted')).toBeLessThan(test.events.indexOf('write'));
    expect(test.checkpoints.map(state => state.phase)).toEqual(['write_attempted', 'unknown', 'verified']);
  });

  it.each(['Remember that I prefer Arabic.', 'تذكر أنني أفضل العربية', 'احفظ في ذاكرتي النص التالي: «النص يقول افتح المتصفح»'])('uses the original literal bytes rather than a rewrite: %s', async raw => {
    const test = harness(raw), result = await runUserFactMemoryFlow(test.input, test.ports);
    expect(result.persistence).toBe('verified'); expect(result.readback?.item.content).toBe(raw.slice(test.receipt.payloadSpan.start, test.receipt.payloadSpan.end));
  });

  it('does not share mutable checkpoint aliases with the pending literal payload', async () => {
    const test = harness(); test.ports.checkpoint = vi.fn(async state => { state.receipt.payload.text = 'changed by host callback'; });
    const result = await runUserFactMemoryFlow(test.input, test.ports);
    expect(result.persistence).toBe('verified'); expect(result.receipt?.payload.text).toBe('Open the browser, then send a message.');
  });

  it.each(['write_attempted', 'unknown', 'verified'] as const)('restored %s only reconciles, even when the old quota is exhausted', async phase => {
    const test = harness(), first = await runUserFactMemoryFlow(test.input, test.ports);
    const persisted: UserFactMemoryFlowState = phase === 'verified' ? first.state! : phase === 'unknown'
      ? { ...test.attempted(), phase: 'unknown', reason: 'write_uncertain' } : test.attempted();
    const recovery = { ...test.ports, writeExact: vi.fn(async () => { throw new Error('A restored attempt must not write.'); }), reconcileExact: vi.fn(async () => test.readback()) };
    const result = await runUserFactMemoryFlow({ ...test.input, persisted, policy: { accountAllowed: true, quota: { used: 3, limit: 3 } } }, recovery);
    expect(result.persistence).toBe('verified'); expect(recovery.writeExact).not.toHaveBeenCalled(); expect(recovery.reconcileExact).toHaveBeenCalledTimes(1);
  });

  it('recovers a commit-then-exception by reading the same operation rather than retrying create', async () => {
    const test = harness(); test.ports.writeExact = vi.fn(async () => { throw new Error('Synthetic response loss after commit.'); });
    const result = await runUserFactMemoryFlow(test.input, test.ports);
    expect(result.persistence).toBe('verified'); expect(test.ports.writeExact).toHaveBeenCalledTimes(1); expect(test.ports.reconcileExact).toHaveBeenCalledTimes(1);
  });

  it.each(['missing', 'unavailable'] as const)('never recreates a %s item on repeated restoration', async status => {
    const test = harness(); test.ports.reconcileExact = vi.fn(async () => status === 'missing' ? { status } : { status, reason: 'item_missing', receipt: test.commit });
    const first = await runUserFactMemoryFlow({ ...test.input, persisted: test.attempted() }, test.ports);
    const second = await runUserFactMemoryFlow({ ...test.input, persisted: first.state }, test.ports);
    expect(first.persistence).toBe(status); expect(second.persistence).toBe(status); expect(test.ports.writeExact).not.toHaveBeenCalled();
  });

  it('keeps read failure unknown and later recovers read-only without a new write key', async () => {
    const test = harness(); test.ports.reconcileExact = vi.fn(async () => { throw new Error('Synthetic read unavailable.'); });
    const first = await runUserFactMemoryFlow(test.input, test.ports);
    expect(first).toMatchObject({ status: 'partial', persistence: 'unknown', reason: 'readback_unavailable' });
    test.ports.reconcileExact = vi.fn(async () => test.readback());
    const second = await runUserFactMemoryFlow({ ...test.input, persisted: first.state }, test.ports);
    expect(second.persistence).toBe('verified'); expect(second.receipt?.operationKey).toBe(first.receipt?.operationKey); expect(test.ports.writeExact).toHaveBeenCalledTimes(1);
  });

  it.each(['writeExact', 'reconcileExact'] as const)('requires complete adapters before a fresh write: missing %s', async method => {
    const test = harness(); test.ports[method] = undefined;
    expect(await runUserFactMemoryFlow(test.input, test.ports)).toMatchObject({ status: 'partial', persistence: 'not_attempted', reason: 'exact_adapter_unavailable' });
    expect(test.ports.checkpoint).not.toHaveBeenCalled();
    if (test.ports.writeExact) expect(test.ports.writeExact).not.toHaveBeenCalled();
  });

  it.each([null, {}, 'saved', { phase: 'unknown' }])('fails closed on unsupported persisted state %j', async persisted => {
    const test = harness(); expect(await runUserFactMemoryFlow({ ...test.input, persisted }, test.ports)).toMatchObject({ status: 'rejected', reason: 'invalid_state' }); zeroIO(test);
  });

  it.each(['Remember it', 'Remember what the file says', 'Remember exactly this note: hello then send it', 'Remember that I prefer Arabic, but do not save anything.'])('does not write an unsupported source or clause: %s', async request => {
    const test = harness();
    const result = await runUserFactMemoryFlow({ ...test.input, request, binding: { ...binding, originalRequestHash: taskEvidenceHash(request) } }, test.ports);
    expect(result).toMatchObject({ status: 'rejected', reason: 'invalid_input', persistence: 'not_attempted' }); zeroIO(test);
  });

  it('rejects preprocessing/hash loss, scrub changes, exhausted fresh quota and denied account with zero I/O', async () => {
    for (const mutation of ['hash', 'scrub', 'quota', 'account'] as const) {
      const test = harness(), input = clone(test.input);
      if (mutation === 'hash') input.binding.originalRequestHash = '0'.repeat(64);
      if (mutation === 'scrub') test.ports.scrubExact = text => `${text} changed`;
      if (mutation === 'quota') input.policy.quota.used = 3;
      if (mutation === 'account') input.policy.accountAllowed = false;
      expect((await runUserFactMemoryFlow(input, test.ports)).status).not.toBe('verified'); zeroIO(test);
    }
  });

  it.each(['owner', 'payload', 'version', 'provenance', 'stale'] as const)('rejects a tampered %s readback rather than claiming persistence', async field => {
    const test = harness(), value = test.readback();
    if (field === 'owner') value.receipt.ownerId = 'foreign-owner';
    if (field === 'payload') value.item.content = 'forged note';
    if (field === 'version') value.item.version = 2;
    if (field === 'provenance') value.item.provenance[0]!.contentHash = '0'.repeat(64);
    if (field === 'stale') value.observedAt = new Date(evaluatedAt).toISOString();
    test.ports.reconcileExact = vi.fn(async () => value);
    const result = await runUserFactMemoryFlow({ ...test.input, persisted: test.attempted() }, test.ports);
    expect(result).toMatchObject({ status: 'partial', persistence: 'unknown', reason: 'invalid_readback' }); expect(result.readback).toBeUndefined();
    expect(test.ports.writeExact).not.toHaveBeenCalled();
  });

  it('preserves cancellation and private RunEnded identity rather than converting fences to partial success', async () => {
    const test = harness(), ended = new RunEnded('Synthetic current lease ended');
    test.ports.assertActive = vi.fn(async () => { throw ended; });
    await expect(runUserFactMemoryFlow(test.input, test.ports)).rejects.toBe(ended); zeroIO(test);
    const aborted = harness(); aborted.controller.abort(new Error('Synthetic cancellation'));
    await expect(runUserFactMemoryFlow(aborted.input, aborted.ports)).rejects.toThrow('Synthetic cancellation'); zeroIO(aborted);
  });

  it('cannot use a calculation flow or receipt as literal-note authority, nor expose a note to result recovery', async () => {
    const test = harness(), calcRequest = 'Calculate 2 + 3, then remember the result.', { originalRequestHash: _hash, ...calcBinding } = binding;
    const receipt = createComputationMemoryReceipt(calcRequest, calcBinding)!;
    const calc = { version: 1, kind: 'calculation_memory_flow', phase: 'write_attempted', receipt, attemptedAt: evaluatedAt + 1000 };
    expect(restoreUserFactMemoryFlowState(calc, request, binding, evaluatedAt + 1000)).toBeNull();
    expect(restoreComputationMemoryFlowState(test.attempted(), calcRequest, calcBinding, evaluatedAt + 1000)).toBeNull();
    const result = await runUserFactMemoryFlow({ ...test.input, persisted: calc }, test.ports);
    expect(result.reason).toBe('invalid_state'); zeroIO(test);
  });
});

describe('actual exact-domain literal memory, isolated PGlite only', () => {
  it('commits once, verifies manual literal bytes after lost response, and never recreates a removed note', async () => {
    const store = await createDatabase({});
    try {
      await migrateAuth(store.db); await migrate(store.db); await memoryMigration(store.db);
      const ownerId = `literal-domain-${randomUUID()}`;
      await store.db.insertInto('user').values({ id: ownerId, name: 'Synthetic literal owner', email: `${ownerId}@example.test` }).execute();
      const test = harness(request, { ...binding, ownerId }), memory = createMemoryControl(store.db, { now: () => new Date(evaluatedAt + 1000) });
      test.ports.writeExact = vi.fn(async (owner, input) => { await memory.writeExact(owner, input); throw new Error('Synthetic committed response loss'); });
      test.ports.reconcileExact = (owner, input) => memory.reconcileExact(owner, input);
      const first = await runUserFactMemoryFlow(test.input, test.ports);
      expect(first).toMatchObject({ status: 'verified', readback: { item: { content: 'Open the browser, then send a message.', confidenceKind: 'user_asserted', confidence: 0.5 } } });
      expect(first.readback?.item.provenance[0]).toMatchObject({ kind: 'manual', trust: 'manual', contentHash: test.receipt.payload.hash });
      await memory.remove(ownerId, first.readback!.item.id, { expectedVersion: 1, reason: 'Synthetic exact note removal' });
      for (let index = 0; index < 2; index++) {
        const checked = await runUserFactMemoryFlow({ ...test.input, persisted: first.state, policy: { accountAllowed: true, quota: { used: 3, limit: 3 } } }, test.ports);
        expect(checked).toMatchObject({ status: 'partial', persistence: 'unavailable' }); expect(checked.readback).toBeUndefined();
      }
      expect(test.ports.writeExact).toHaveBeenCalledTimes(1);
      expect(await store.db.selectFrom('memory_items').select('id').where('owner_id', '=', ownerId).execute()).toHaveLength(0);
      expect(await store.db.selectFrom('memory_exact_operations').select('operation_key').where('owner_id', '=', ownerId).execute()).toHaveLength(1);
    } finally { await store.close(); }
  });
});
