import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createDatabase, migrate } from '@mohassan/database';
import { createMemoryControl, memoryMigration, type MemoryExactWriteReceipt } from '@mohassan/memory';
import { migrateAuth } from '../apps/server/src/auth.js';
import { createComputationMemoryReceipt } from '../apps/server/src/assistant/computation-memory-receipt.js';
import { runComputationMemoryFlow, type ComputationMemoryFlowInput, type ComputationMemoryFlowPorts, type ComputationMemoryFlowState } from '../apps/server/src/assistant/computation-memory-flow.js';

const evaluatedAt = Date.UTC(2026, 10, 21, 7);
const request = 'Calculate 2 + 3, then remember the result. Only the result.';
const binding = { ownerId: 'isolated-flow-owner', conversationId: 'isolated-flow-conversation', runId: 'isolated-flow-run', evaluatedAt };
const policy = { accountAllowed: true, quota: { used: 0, limit: 3 } };
class RunEnded extends Error {}
const clone = <T,>(value: T): T => structuredClone(value);

function harness(text = request) {
  let clock = evaluatedAt + 1000;
  const receipt = createComputationMemoryReceipt(text, binding)!;
  const createdAt = new Date(clock).toISOString(), expiresAt = new Date(clock + 86400000).toISOString();
  const itemId = '11111111-2222-4333-8444-555555555555', evidenceId = '11111111-2222-4333-8444-666666666666';
  const commit: MemoryExactWriteReceipt = { version: 1, ownerId: binding.ownerId, operationKey: receipt.operationKey, payloadHash: receipt.payload.hash, payloadBytes: receipt.payload.bytes,
    itemId, rootId: itemId, itemVersion: 1, evidenceId, layer: 'semantic', createdAt, expiresAt };
  const readback = () => ({ status: 'verified' as const, scope: 'memory_persistence_only' as const, receipt: clone(commit), observedAt: new Date(clock).toISOString(),
    item: { id: itemId, rootId: itemId, version: 1, title: 'Saved result', content: receipt.payload.text, layer: 'semantic' as const, status: 'active' as const,
      confidence: 0.5, confidenceKind: 'user_asserted' as const, taskId: null, createdAt, updatedAt: createdAt, expiresAt,
      provenance: [{ id: evidenceId, kind: 'manual' as const, description: 'Explicit fixture result', taskId: null, eventId: null, contentHash: receipt.payload.hash,
        observedAt: createdAt, expiresAt: null, trust: 'manual' as const, status: 'active' as const }] } });
  const controller = new AbortController(), checkpoints: ComputationMemoryFlowState[] = [], events: string[] = [];
  const ports: ComputationMemoryFlowPorts = {
    signal: controller.signal,
    assertActive: vi.fn(async () => { events.push('active'); }),
    isExecutionEnded: error => error instanceof RunEnded,
    checkpoint: vi.fn(async state => { events.push(`checkpoint:${state.phase}`); checkpoints.push(clone(state)); }),
    scrubExact: vi.fn(text => text), now: () => clock,
    writeExact: vi.fn(async () => { events.push('write'); return { created: true, receipt: clone(commit) }; }),
    reconcileExact: vi.fn(async () => { events.push('read'); return readback(); }),
  };
  const input: ComputationMemoryFlowInput = { request: text, binding, policy: clone(policy) };
  const attempted = (): Extract<ComputationMemoryFlowState, { phase: 'write_attempted' }> => ({ version: 1, kind: 'calculation_memory_flow', phase: 'write_attempted', receipt: clone(receipt), attemptedAt: evaluatedAt + 1000 });
  return { input, ports, receipt, commit, readback, controller, checkpoints, events, attempted, setClock: (value: number) => { clock = value; } };
}
const zeroIO = (test: ReturnType<typeof harness>) => {
  expect(test.ports.assertActive).not.toHaveBeenCalled(); expect(test.ports.checkpoint).not.toHaveBeenCalled();
  expect(test.ports.writeExact).not.toHaveBeenCalled(); expect(test.ports.reconcileExact).not.toHaveBeenCalled();
};

describe('one exact write followed by independently checked persistence', () => {
  it('durably checkpoints attempted before writing, stores context and preserves a scalar display', async () => {
    const test = harness(), result = await runComputationMemoryFlow(test.input, test.ports);
    expect(result).toMatchObject({ scope: 'calculation_memory_persistence_only', status: 'verified', persistence: 'verified', answer: '5', state: { phase: 'verified' } });
    expect(result).not.toHaveProperty('completed');
    expect(test.ports.writeExact).toHaveBeenCalledExactlyOnceWith(binding.ownerId, { operationKey: test.receipt.operationKey, payload: '2 + 3 = 5', payloadHash: test.receipt.payload.hash });
    expect(test.events.indexOf('checkpoint:write_attempted')).toBeLessThan(test.events.indexOf('write'));
    expect(test.events.indexOf('write')).toBeLessThan(test.events.indexOf('read'));
    expect(test.checkpoints.map(state => state.phase)).toEqual(['write_attempted', 'unknown', 'verified']);
  });

  it('recovers a commit-then-exception by read-only key reconciliation without another write', async () => {
    const test = harness();
    test.ports.writeExact = vi.fn(async () => { throw new Error('fixture response lost after commit'); });
    const result = await runComputationMemoryFlow(test.input, test.ports);
    expect(result.persistence).toBe('verified'); expect(test.ports.writeExact).toHaveBeenCalledTimes(1); expect(test.ports.reconcileExact).toHaveBeenCalledTimes(1);
    expect(test.checkpoints[1]).toMatchObject({ phase: 'unknown', reason: 'write_uncertain' });
  });

  it('never treats a legacy saved string as proof; only strict readback can recover it', async () => {
    const test = harness(); test.ports.writeExact = vi.fn(async () => 'saved');
    test.ports.reconcileExact = vi.fn(async () => ({ status: 'missing' }));
    const result = await runComputationMemoryFlow(test.input, test.ports);
    expect(result).toMatchObject({ status: 'partial', persistence: 'missing', state: { phase: 'unknown' } });
    expect(result.readback).toBeUndefined();
  });

  it('requires both exact ports before any fresh write and never falls back to a legacy saver', async () => {
    for (const missing of ['writeExact', 'reconcileExact'] as const) {
      const test = harness(); test.ports[missing] = undefined;
      const result = await runComputationMemoryFlow(test.input, test.ports);
      expect(result).toMatchObject({ status: 'partial', reason: 'exact_adapter_unavailable', persistence: 'not_attempted' });
      expect(test.ports.checkpoint).not.toHaveBeenCalled();
      if (test.ports.writeExact) expect(test.ports.writeExact).not.toHaveBeenCalled();
    }
  });

  it('does not expose a mutable checkpoint alias to the live receipt or state', async () => {
    const test = harness(); test.ports.checkpoint = vi.fn(async state => { state.receipt.payload.text = 'callback corruption'; });
    const result = await runComputationMemoryFlow(test.input, test.ports);
    expect(result.persistence).toBe('verified'); expect(result.receipt?.payload.text).toBe('2 + 3 = 5');
    expect(test.ports.writeExact).toHaveBeenCalledWith(binding.ownerId, expect.objectContaining({ payload: '2 + 3 = 5' }));
  });
});

describe('restored phases are reconciliation-only', () => {
  it.each(['write_attempted', 'unknown', 'verified'] as const)('does no new write after a persisted %s phase, even with exhausted quota', async phase => {
    const test = harness();
    const first = await runComputationMemoryFlow(test.input, test.ports);
    let persisted = clone(first.state!);
    if (phase === 'write_attempted') persisted = test.attempted();
    if (phase === 'unknown') persisted = { ...test.attempted(), phase: 'unknown', reason: 'write_uncertain' };
    test.ports.writeExact = undefined; test.ports.reconcileExact = vi.fn(async () => test.readback());
    const recovered = await runComputationMemoryFlow({ ...test.input, persisted, policy: { ...policy, quota: { used: 7, limit: 3 } } }, test.ports);
    expect(recovered.persistence).toBe('verified'); expect(test.ports.reconcileExact).toHaveBeenCalledTimes(1);
  });

  it.each(['missing', 'unavailable'] as const)('does not recreate a %s previous operation', async status => {
    const test = harness();
    test.ports.reconcileExact = vi.fn(async () => status === 'missing' ? { status } : { status, reason: 'item_missing', receipt: test.commit });
    const first = await runComputationMemoryFlow({ ...test.input, persisted: test.attempted() }, test.ports);
    const second = await runComputationMemoryFlow({ ...test.input, persisted: first.state }, test.ports);
    expect(first.persistence).toBe(status); expect(second.persistence).toBe(status);
    expect(test.ports.writeExact).not.toHaveBeenCalled(); expect(test.ports.reconcileExact).toHaveBeenCalledTimes(2);
  });

  it('downgrades a former verified snapshot when the item is subsequently unavailable', async () => {
    const test = harness(), first = await runComputationMemoryFlow(test.input, test.ports);
    test.ports.writeExact = vi.fn(async () => { throw new Error('must not write'); });
    test.ports.reconcileExact = vi.fn(async () => ({ status: 'unavailable', reason: 'item_inactive', receipt: test.commit }));
    const result = await runComputationMemoryFlow({ ...test.input, persisted: first.state }, test.ports);
    expect(result).toMatchObject({ status: 'partial', persistence: 'unavailable', state: { phase: 'unknown' } });
    expect(test.ports.writeExact).not.toHaveBeenCalled();
  });

  it('keeps a read error partial and never retries create on later recovery', async () => {
    const test = harness(); test.ports.reconcileExact = vi.fn(async () => { throw new Error('fixture read offline'); });
    const first = await runComputationMemoryFlow(test.input, test.ports);
    expect(first).toMatchObject({ status: 'partial', persistence: 'unknown', reason: 'readback_unavailable' });
    test.ports.writeExact = vi.fn(async () => { throw new Error('must not write'); });
    const second = await runComputationMemoryFlow({ ...test.input, persisted: first.state }, test.ports);
    expect(second.persistence).toBe('unknown'); expect(test.ports.writeExact).not.toHaveBeenCalled();
  });
});

describe('explicit authority, original source and persisted-state boundaries', () => {
  it.each([undefined, null, {}, { accountAllowed: true }, { accountAllowed: true, quota: { used: -1, limit: 3 } },
    { accountAllowed: true, quota: { used: 0.5, limit: 3 } }, { accountAllowed: true, quota: { used: 0, limit: 0 } },
    { accountAllowed: true, quota: { used: 0, limit: 4 } }, { accountAllowed: true, quota: { used: Infinity, limit: 3 } }])('grants no inferred quota authority for %j', async policy => {
    const test = harness(), result = await runComputationMemoryFlow({ ...test.input, policy: policy as never }, test.ports);
    expect(result.reason).toBe('invalid_policy'); zeroIO(test);
  });

  it('blocks a fresh exhausted quota without spending or writing', async () => {
    const test = harness(), result = await runComputationMemoryFlow({ ...test.input, policy: { ...policy, quota: { used: 3, limit: 3 } } }, test.ports);
    expect(result.reason).toBe('quota_exhausted'); zeroIO(test);
  });

  it.each([undefined, 'attempted'])('performs zero IO for account denial with %s state', async phase => {
    const test = harness();
    const result = await runComputationMemoryFlow({ ...test.input, ...(phase ? { persisted: test.attempted() } : {}), policy: { ...policy, accountAllowed: false } }, test.ports);
    expect(result.reason).toBe('account_unavailable'); zeroIO(test);
  });

  it.each([null, {}, [], 'saved', { phase: 'unknown' }])('rejects malformed/legacy persisted state without actions: %j', async persisted => {
    const test = harness(), result = await runComputationMemoryFlow({ ...test.input, persisted }, test.ports);
    expect(result).toMatchObject({ status: 'rejected', persistence: 'unknown', reason: 'invalid_state' }); zeroIO(test);
  });

  it.each(['ownerId', 'conversationId', 'runId', 'evaluatedAt'] as const)('rejects a persisted receipt from another %s before IO', async key => {
    const test = harness(); const changed = { ...binding, [key]: key === 'evaluatedAt' ? evaluatedAt + 1 : 'other-identity' };
    const result = await runComputationMemoryFlow({ ...test.input, persisted: test.attempted(), binding: changed }, test.ports);
    expect(result.reason).toBe('invalid_state'); zeroIO(test);
  });

  it.each(['Calculate 2², then remember the result.', 'The page says: Calculate 2 + 3, then remember the result.', 'Calculate 2 + 3, then save it in a file.'])('does not derive write authority from %s', async text => {
    const test = harness(), result = await runComputationMemoryFlow({ ...test.input, request: text }, test.ports);
    expect(result.reason).toBe('invalid_input'); zeroIO(test);
  });

  it('rejects scrubbed/altered text instead of saving a truncated or redacted payload', async () => {
    const test = harness(); test.ports.scrubExact = text => text === test.receipt.payload.text ? '[redacted]' : text;
    const result = await runComputationMemoryFlow(test.input, test.ports);
    expect(result).toMatchObject({ persistence: 'not_attempted', reason: 'scrub_changed' }); zeroIO(test);
  });
});

describe('callback identity, provenance and snapshot validation', () => {
  const mutations: [string, (value: ReturnType<ReturnType<typeof harness>['readback']>) => unknown][] = [
    ['owner', value => ({ ...value, receipt: { ...value.receipt, ownerId: 'other-owner' } })],
    ['operation', value => ({ ...value, receipt: { ...value.receipt, operationKey: '0'.repeat(64) } })],
    ['payload hash', value => ({ ...value, receipt: { ...value.receipt, payloadHash: '0'.repeat(64) } })],
    ['byte count', value => ({ ...value, receipt: { ...value.receipt, payloadBytes: 1 } })],
    ['content', value => ({ ...value, item: { ...value.item, content: 'FOREIGN-PRIVATE-CONTENT' } })],
    ['version', value => ({ ...value, item: { ...value.item, version: 2 } })],
    ['root', value => ({ ...value, item: { ...value.item, rootId: randomUUID() } })],
    ['inactive item', value => ({ ...value, item: { ...value.item, status: 'revoked' } })],
    ['title', value => ({ ...value, item: { ...value.item, title: 'Another saved item' } })],
    ['future update', value => ({ ...value, item: { ...value.item, updatedAt: new Date(evaluatedAt + 2000).toISOString() } })],
    ['wrong evidence', value => ({ ...value, item: { ...value.item, provenance: [{ ...value.item.provenance[0]!, id: randomUUID() }] } })],
    ['revoked evidence', value => ({ ...value, item: { ...value.item, provenance: [{ ...value.item.provenance[0]!, status: 'revoked' }] } })],
    ['observed evidence', value => ({ ...value, item: { ...value.item, provenance: [{ ...value.item.provenance[0]!, trust: 'observed' }] } })],
    ['evidence hash', value => ({ ...value, item: { ...value.item, provenance: [{ ...value.item.provenance[0]!, contentHash: '0'.repeat(64) }] } })],
    ['expired evidence', value => ({ ...value, item: { ...value.item, provenance: [{ ...value.item.provenance[0]!, expiresAt: value.observedAt }] } })],
    ['future evidence', value => ({ ...value, item: { ...value.item, provenance: [{ ...value.item.provenance[0]!, observedAt: new Date(evaluatedAt + 2000).toISOString() }] } })],
    ['extra evidence', value => ({ ...value, item: { ...value.item, provenance: [...value.item.provenance, ...value.item.provenance] } })],
    ['future snapshot', value => ({ ...value, observedAt: new Date(evaluatedAt + 2000).toISOString() })],
    ['stale snapshot', value => ({ ...value, observedAt: new Date(evaluatedAt).toISOString() })],
    ['extra callback field', value => ({ ...value, modelSaysSaved: true })],
  ];
  it.each(mutations)('does not verify inconsistent %s', async (_name, mutate) => {
    const test = harness(); test.ports.reconcileExact = vi.fn(async () => mutate(test.readback()));
    const result = await runComputationMemoryFlow(test.input, test.ports);
    expect(result).toMatchObject({ status: 'partial', persistence: 'unknown', reason: 'invalid_readback' });
    expect(result.readback).toBeUndefined(); expect(JSON.stringify(result)).not.toContain('FOREIGN-PRIVATE-CONTENT');
    expect(test.ports.writeExact).toHaveBeenCalledTimes(1);
  });
});

describe('cancellation and durable host fences', () => {
  it('propagates initial cancellation without IO', async () => {
    const test = harness(); test.controller.abort(new Error('fixture cancelled'));
    await expect(runComputationMemoryFlow(test.input, test.ports)).rejects.toThrow('fixture cancelled'); zeroIO(test);
  });
  it('does not write if durable attempted checkpoint fails', async () => {
    const test = harness(); test.ports.checkpoint = vi.fn(async () => { throw new Error('checkpoint not durable'); });
    await expect(runComputationMemoryFlow(test.input, test.ports)).rejects.toThrow('checkpoint not durable');
    expect(test.ports.writeExact).not.toHaveBeenCalled(); expect(test.ports.reconcileExact).not.toHaveBeenCalled();
  });
  it('propagates host activity errors after a commit instead of classifying them as uncertainty or success', async () => {
    const test = harness(); let checks = 0;
    test.ports.assertActive = vi.fn(async () => { if (++checks === 4) throw new Error('host fence read failed'); });
    await expect(runComputationMemoryFlow(test.input, test.ports)).rejects.toThrow('host fence read failed');
    expect(test.ports.writeExact).toHaveBeenCalledTimes(1); expect(test.ports.reconcileExact).not.toHaveBeenCalled();
  });
  it.each(['write', 'read'] as const)('propagates RunEnded from %s', async phase => {
    const test = harness(), ended = new RunEnded('fixture lease ended');
    if (phase === 'write') test.ports.writeExact = vi.fn(async () => { throw ended; });
    else test.ports.reconcileExact = vi.fn(async () => { throw ended; });
    await expect(runComputationMemoryFlow(test.input, test.ports)).rejects.toBe(ended);
    expect(test.checkpoints.some(state => state.phase === 'verified')).toBe(false);
  });
  it.each(['write', 'read', 'verified checkpoint'] as const)('cannot return success when cancellation occurs at %s', async phase => {
    const test = harness();
    if (phase === 'write') test.ports.writeExact = vi.fn(async () => { test.controller.abort(new Error('fixture cancelled')); return { created: true, receipt: test.commit }; });
    if (phase === 'read') test.ports.reconcileExact = vi.fn(async () => { test.controller.abort(new Error('fixture cancelled')); return test.readback(); });
    if (phase === 'verified checkpoint') test.ports.checkpoint = vi.fn(async state => { if (state.phase === 'verified') test.controller.abort(new Error('fixture cancelled')); });
    await expect(runComputationMemoryFlow(test.input, test.ports)).rejects.toThrow('fixture cancelled');
  });
});

describe('actual exact-memory domain integration without external services', () => {
  it('persists once and recovers a lost response through the real read-only domain', async () => {
    const store = await createDatabase({});
    try {
      await migrateAuth(store.db); await migrate(store.db); await memoryMigration(store.db);
      const ownerId = `flow-domain-${randomUUID()}`;
      await store.db.insertInto('user').values({ id: ownerId, name: 'Synthetic owner', email: `${ownerId}@example.test` }).execute();
      const clock = evaluatedAt + 1000, memory = createMemoryControl(store.db, { now: () => new Date(clock) });
      const test = harness(); test.input.binding = { ...binding, ownerId };
      test.ports.writeExact = vi.fn(async (owner, input) => { await memory.writeExact(owner, input); throw new Error('fixture response lost after real commit'); });
      test.ports.reconcileExact = (owner, input) => memory.reconcileExact(owner, input);
      const result = await runComputationMemoryFlow(test.input, test.ports);
      expect(result).toMatchObject({ status: 'verified', answer: '5', readback: { item: { content: '2 + 3 = 5' } } });
      expect(await store.db.selectFrom('memory_items').select('id').where('owner_id', '=', ownerId).execute()).toHaveLength(1);
      expect(await store.db.selectFrom('memory_exact_operations').select('operation_key').where('owner_id', '=', ownerId).execute()).toHaveLength(1);
      test.ports.writeExact = vi.fn(async () => { throw new Error('recovery must never create'); });
      const recovered = await runComputationMemoryFlow({ ...test.input, persisted: result.state, policy: { ...policy, quota: { used: 3, limit: 3 } } }, test.ports);
      expect(recovered.persistence).toBe('verified'); expect(test.ports.writeExact).not.toHaveBeenCalled();
    } finally { await store.close(); }
  });
});
