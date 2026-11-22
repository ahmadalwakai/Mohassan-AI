import { createHash, randomUUID } from 'node:crypto';
import type { KyselyPlugin } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, migrate } from '@mohassan/database';
import { migrateAuth } from '../../../apps/server/src/auth.ts';
import { createMemoryControl, exactMemoryPayloadHash, memoryMigration, type MemoryExactWriteReceipt } from './index.ts';

let store: Awaited<ReturnType<typeof createDatabase>>;
let memory: ReturnType<typeof createMemoryControl>;
let owner: string, other: string, clock: Date;
const date = '2026-11-21T07:00:00.000Z';
const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const input = (payload = '2 + 3 = 5', operationKey = digest(randomUUID())) => ({ operationKey, payload, payloadHash: digest(payload) });
const expected = (receipt: MemoryExactWriteReceipt) => ({ operationKey: receipt.operationKey, payloadHash: receipt.payloadHash });

beforeAll(async () => {
  store = await createDatabase({});
  expect(store.mode).toBe('embedded');
  await migrateAuth(store.db); await migrate(store.db);
  await memoryMigration(store.db); await memoryMigration(store.db);
});
beforeEach(async () => {
  owner = `exact-owner-${randomUUID()}`; other = `exact-other-${randomUUID()}`;
  for (const id of [owner, other]) await store.db.insertInto('user').values({ id, name: id, email: `${id}@example.test` }).execute();
  clock = new Date(date);
  memory = createMemoryControl(store.db, { now: () => clock });
});
afterAll(async () => { await store?.close(); });

async function snapshot(ownerId = owner) {
  const [items, evidence, operations, audit] = await Promise.all([
    store.db.selectFrom('memory_items').selectAll().where('owner_id', '=', ownerId).orderBy('id').execute(),
    store.db.selectFrom('memory_evidence').selectAll().where('owner_id', '=', ownerId).orderBy('id').execute(),
    store.db.selectFrom('memory_exact_operations').selectAll().where('owner_id', '=', ownerId).orderBy('operation_key').execute(),
    store.db.selectFrom('memory_audit').selectAll().where('owner_id', '=', ownerId).orderBy('id').execute(),
  ]);
  return { items, evidence, operations, audit };
}

describe('exact owner-scoped memory commit identities', () => {
  it('migrates idempotently and persists exact bytes with an atomic identity, not a verification assertion', async () => {
    const migrations = await store.db.selectFrom('schema_migrations').select('version').where('version', '=', 'memory_exact_writes_v1').execute();
    expect(migrations).toHaveLength(1);
    const request = input('٢ + ٣ = ٥\nA recorded result.');
    const written = await memory.writeExact(owner, request);
    expect(written).toMatchObject({ created: true, receipt: { version: 1, ownerId: owner, operationKey: request.operationKey,
      payloadHash: request.payloadHash, payloadBytes: Buffer.byteLength(request.payload, 'utf8'), layer: 'semantic', itemVersion: 1, createdAt: date } });
    expect(written).not.toHaveProperty('verified'); expect(written).not.toHaveProperty('item');
    const saved = await snapshot();
    expect(saved.items).toHaveLength(1); expect(saved.evidence).toHaveLength(1); expect(saved.operations).toHaveLength(1);
    expect(saved.items[0]).toMatchObject({ id: written.receipt.itemId, root_id: written.receipt.rootId, content: request.payload, layer: 'semantic', confidence_kind: 'user_asserted' });
    expect(saved.operations[0]).not.toHaveProperty('payload'); expect(saved.operations[0]).not.toHaveProperty('content');
    expect(saved.evidence[0]).toMatchObject({ id: written.receipt.evidenceId, source_key: `exact:${request.operationKey}`, content_hash: request.payloadHash });
    const checked = await memory.reconcileExact(owner, expected(written.receipt));
    expect(checked).toMatchObject({ status: 'verified', scope: 'memory_persistence_only', receipt: written.receipt,
      item: { id: written.receipt.itemId, content: request.payload, confidenceKind: 'user_asserted', provenance: [{ id: written.receipt.evidenceId, trust: 'manual' }] }, observedAt: date });
    expect(await snapshot()).toEqual(saved); // Reconciliation performed no mutation or audit write.
  });

  it('returns one identity for concurrent equal-key/equal-payload writes without duplicate rows', async () => {
    const request = input();
    const results = await Promise.all(Array.from({ length: 8 }, () => memory.writeExact(owner, request)));
    expect(results.filter(result => result.created)).toHaveLength(1);
    expect(new Set(results.map(result => result.receipt.itemId)).size).toBe(1);
    expect(results.every(result => JSON.stringify(result.receipt) === JSON.stringify(results[0].receipt))).toBe(true);
    const saved = await snapshot();
    expect(saved.items).toHaveLength(1); expect(saved.evidence).toHaveLength(1); expect(saved.operations).toHaveLength(1);
  });

  it('rejects same-key/different-payload use, including different Unicode bytes, without altering the original', async () => {
    const request = input('é');
    const written = await memory.writeExact(owner, request), before = await snapshot();
    expect(digest('é')).not.toBe(digest('e\u0301'));
    await expect(memory.writeExact(owner, input('e\u0301', request.operationKey))).rejects.toMatchObject({ code: 'MEMORY_OPERATION_CONFLICT' });
    await expect(memory.reconcileExact(owner, { operationKey: request.operationKey, payloadHash: digest('another payload') })).rejects.toMatchObject({ code: 'MEMORY_OPERATION_CONFLICT' });
    expect(await snapshot()).toEqual(before);
    expect((await memory.reconcileExact(owner, expected(written.receipt))).status).toBe('verified');
  });

  it('scopes operation keys and all readbacks to their owner', async () => {
    const request = input();
    const first = await memory.writeExact(owner, request);
    expect(await memory.reconcileExact(other, expected(first.receipt))).toEqual({ status: 'missing' });
    const second = await memory.writeExact(other, request);
    expect(second.created).toBe(true); expect(second.receipt.itemId).not.toBe(first.receipt.itemId);
    expect((await memory.reconcileExact(other, expected(second.receipt))).status).toBe('verified');
    expect(await snapshot(other)).toMatchObject({ items: [{ owner_id: other }], operations: [{ owner_id: other }] });
    await expect(memory.writeExact('nonexistent-exact-owner', input())).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('retains only tombstone metadata after deletion and never recreates the deleted item', async () => {
    const request = input(), written = await memory.writeExact(owner, request);
    await memory.remove(owner, written.receipt.itemId, { expectedVersion: 1, reason: 'Delete this isolated test note.' });
    const before = await snapshot();
    expect(before.items).toEqual([]); expect(before.evidence).toEqual([]); expect(before.operations).toHaveLength(1);
    const read = await memory.reconcileExact(owner, expected(written.receipt));
    expect(read).toEqual({ status: 'unavailable', reason: 'item_missing', receipt: written.receipt });
    expect(read).not.toHaveProperty('item'); expect(JSON.stringify(read)).not.toContain(request.payload);
    expect(await memory.writeExact(owner, request)).toEqual({ created: false, receipt: written.receipt });
    expect(await snapshot()).toEqual(before);
  });

  it('never revives revoked, expired or superseded items', async () => {
    const revokedRequest = input(), revoked = await memory.writeExact(owner, revokedRequest);
    await memory.revoke(owner, revoked.receipt.itemId, { expectedVersion: 1, reason: 'Revoke the isolated result.' });
    expect(await memory.reconcileExact(owner, expected(revoked.receipt))).toMatchObject({ status: 'unavailable', reason: 'item_inactive' });
    expect((await memory.writeExact(owner, revokedRequest)).created).toBe(false);
    const correctedRequest = input(), corrected = await memory.writeExact(owner, correctedRequest);
    await memory.correct(owner, corrected.receipt.itemId, { title: 'Owner correction', content: 'Changed by the owner.', layer: 'semantic', expectedVersion: 1, reason: 'Correct the isolated result.' });
    expect(await memory.reconcileExact(owner, expected(corrected.receipt))).toMatchObject({ status: 'unavailable', reason: 'item_inactive' });
    expect((await memory.writeExact(owner, correctedRequest)).receipt).toEqual(corrected.receipt);
    const expiringRequest = input(), expiring = await memory.writeExact(owner, expiringRequest);
    clock = new Date(clock.getTime() + 181 * 86400000);
    const before = await snapshot();
    expect(await memory.reconcileExact(owner, expected(expiring.receipt))).toEqual({ status: 'unavailable', reason: 'item_expired', receipt: expiring.receipt });
    expect((await memory.writeExact(owner, expiringRequest)).created).toBe(false);
    expect(await snapshot()).toEqual(before);
  });

  it('enforces the existing item limit for new operations while retaining old identities', async () => {
    const request = input(), first = await memory.writeExact(owner, request);
    const expiry = new Date(clock.getTime() + 86400000);
    await store.db.insertInto('memory_items').values(Array.from({ length: 1999 }, () => {
      const id = randomUUID(); return { id, root_id: id, owner_id: owner, version: 1, title: 'Limit fixture', content: 'Bounded fixture content',
        layer: 'semantic', status: 'active', confidence: .5, confidence_kind: 'user_asserted', task_id: null, expires_at: expiry, created_at: clock, updated_at: clock };
    })).execute();
    await expect(memory.writeExact(owner, input('Different new operation.'))).rejects.toMatchObject({ code: 'MEMORY_LIMIT' });
    expect(await memory.writeExact(owner, request)).toEqual({ created: false, receipt: first.receipt });
    expect((await snapshot()).operations).toHaveLength(1);
  });
});

describe('independent read-only reconciliation', () => {
  it.each(['content', 'version', 'root', 'layer'] as const)('rejects altered %s without exposing the stored content', async change => {
    const written = await memory.writeExact(owner, input());
    const update = change === 'content' ? { content: 'Wrong stored result' } : change === 'version' ? { version: 2 }
      : change === 'root' ? { root_id: randomUUID() } : { layer: 'preference' };
    await store.db.updateTable('memory_items').set(update).where('id', '=', written.receipt.itemId).execute();
    const before = await snapshot(), checked = await memory.reconcileExact(owner, expected(written.receipt));
    expect(checked).toMatchObject({ status: 'unavailable', reason: change === 'content' ? 'payload_mismatch' : 'identity_mismatch' });
    expect(checked).not.toHaveProperty('item'); expect(JSON.stringify(checked)).not.toContain('Wrong stored result');
    expect(await snapshot()).toEqual(before);
  });

  it.each(['revoked', 'expired', 'wrong_owner', 'wrong_hash', 'wrong_source', 'missing_link'] as const)('rejects %s provenance without repairing it', async change => {
    const written = await memory.writeExact(owner, input());
    if (change === 'missing_link') await store.db.deleteFrom('memory_provenance').where('memory_id', '=', written.receipt.itemId).execute();
    else {
      const update = change === 'revoked' ? { status: 'revoked' } : change === 'expired' ? { expires_at: new Date(clock.getTime() - 1000) }
        : change === 'wrong_owner' ? { owner_id: other } : change === 'wrong_hash' ? { content_hash: digest('not the approved bytes') } : { source_key: 'manual:unrelated' };
      await store.db.updateTable('memory_evidence').set(update).where('id', '=', written.receipt.evidenceId).execute();
    }
    const before = await snapshot(), checked = await memory.reconcileExact(owner, expected(written.receipt));
    expect(checked).toEqual({ status: 'unavailable', reason: 'provenance_unavailable', receipt: written.receipt });
    expect(await snapshot()).toEqual(before);
  });

  it('recovers a commit followed by a provenance read error using the key read-only, with no second create', async () => {
    const plugin: KyselyPlugin = {
      transformQuery(args) {
        if (args.node.kind === 'SelectQueryNode' && JSON.stringify(args.node).includes('memory_provenance')) throw new Error('fixture provenance read unavailable');
        return args.node;
      },
      async transformResult(args) { return args.result; },
    };
    const failing = createMemoryControl(store.db.withPlugin(plugin), { now: () => clock });
    const request = input();
    const written = await failing.writeExact(owner, request); // Commit succeeds before the independent query.
    await expect(failing.reconcileExact(owner, expected(written.receipt))).rejects.toThrow('fixture provenance read unavailable');
    const before = await snapshot();
    expect(before.items).toHaveLength(1); expect(before.operations).toHaveLength(1);
    const recovered = await memory.reconcileExact(owner, { operationKey: request.operationKey, payloadHash: request.payloadHash });
    expect(recovered).toMatchObject({ status: 'verified', receipt: written.receipt, item: { id: written.receipt.itemId, content: request.payload } });
    expect(await snapshot()).toEqual(before);
  });

  it('rechecks provenance expiry at the final observation after the last read completes', async () => {
    const written = await memory.writeExact(owner, input());
    const expiresAt = new Date(clock.getTime() + 100);
    await store.db.updateTable('memory_evidence').set({ expires_at: expiresAt }).where('id', '=', written.receipt.evidenceId).execute();
    let provenanceReads = 0;
    const lateReads = new Set<unknown>();
    const plugin: KyselyPlugin = {
      transformQuery(args) {
        if (args.node.kind === 'SelectQueryNode' && JSON.stringify(args.node).includes('memory_provenance') && ++provenanceReads === 2) lateReads.add(args.queryId);
        return args.node;
      },
      async transformResult(args) {
        if (lateReads.has(args.queryId)) clock = new Date(expiresAt.getTime() + 1);
        return args.result;
      },
    };
    const late = createMemoryControl(store.db.withPlugin(plugin), { now: () => clock });
    const before = await snapshot();
    expect(await late.reconcileExact(owner, expected(written.receipt))).toEqual({ status: 'unavailable', reason: 'provenance_unavailable', receipt: written.receipt });
    expect(provenanceReads).toBe(2); expect(await snapshot()).toEqual(before);
  });

  it('enforces real PostgreSQL read-only mode in PGlite, even if a query plugin attempts a write', async () => {
    const written = await memory.writeExact(owner, input()), before = await snapshot();
    let attempted = false;
    const mutatingSelect = store.db.with('forbidden_memory_delete', db => db.deleteFrom('memory_exact_operations')
      .where('owner_id', '=', owner).returningAll()).selectFrom('forbidden_memory_delete').selectAll().toOperationNode();
    const plugin: KyselyPlugin = {
      transformQuery(args) {
        if (!attempted && args.node.kind === 'SelectQueryNode') {
          attempted = true;
          return mutatingSelect as typeof args.node;
        }
        return args.node;
      },
      async transformResult(args) { return args.result; },
    };
    const readOnly = createMemoryControl(store.db.withPlugin(plugin), { now: () => clock });
    await expect(readOnly.reconcileExact(owner, expected(written.receipt))).rejects.toMatchObject({ code: '25006' });
    expect(attempted).toBe(true); expect(await snapshot()).toEqual(before);
  });
});

describe('same-transaction execution fences and cancellation', () => {
  it('runs both trusted fences on the transaction and commits only after the final check', async () => {
    const seen: number[] = [], request = input();
    const written = await memory.writeExact(owner, request, { fence: async tx => {
      const rows = await tx.selectFrom('memory_exact_operations').select('operation_key').where('owner_id', '=', owner).execute();
      seen.push(rows.length);
    } });
    expect(seen).toEqual([0, 1]);
    expect((await memory.reconcileExact(owner, expected(written.receipt))).status).toBe('verified');
  });

  it.each([1, 2])('rolls back all rows when trusted fence %s rejects', async phase => {
    const before = await snapshot(); let calls = 0;
    await expect(memory.writeExact(owner, input(), { fence: async tx => {
      const rows = await tx.selectFrom('memory_items').select('id').where('owner_id', '=', owner).execute();
      calls++; expect(rows.length).toBe(calls === 1 ? 0 : 1);
      if (calls === phase) throw new Error(`fixture lease revoked at phase ${phase}`);
    } })).rejects.toThrow(`fixture lease revoked at phase ${phase}`);
    expect(calls).toBe(phase); expect(await snapshot()).toEqual(before);
  });

  it('rolls back when cancellation occurs in the final fence and never compensates a later committed operation', async () => {
    const controller = new AbortController(), request = input(); let calls = 0;
    await expect(memory.writeExact(owner, request, { signal: controller.signal, fence: async () => {
      if (++calls === 2) controller.abort(new Error('fixture cancelled before commit'));
    } })).rejects.toThrow('fixture cancelled before commit');
    expect((await snapshot()).items).toEqual([]); expect((await snapshot()).operations).toEqual([]);
    const afterCommit = new AbortController();
    const written = await memory.writeExact(owner, input(), { signal: afterCommit.signal });
    afterCommit.abort(new Error('fixture cancelled after commit'));
    const before = await snapshot();
    await expect(memory.reconcileExact(owner, expected(written.receipt), { signal: afterCommit.signal })).rejects.toThrow('fixture cancelled after commit');
    expect(await snapshot()).toEqual(before);
    expect((await memory.reconcileExact(owner, expected(written.receipt))).status).toBe('verified');
  });

  it('rejects an already aborted write before invoking a fence or inserting data', async () => {
    const controller = new AbortController(); controller.abort(new Error('fixture already aborted'));
    let calls = 0;
    await expect(memory.writeExact(owner, input(), { signal: controller.signal, fence: async () => { calls++; } })).rejects.toThrow('fixture already aborted');
    expect(calls).toBe(0); expect((await snapshot()).items).toEqual([]);
  });
});

describe('canonical byte and input boundaries', () => {
  it('hashes standard UTF-8 bytes without normalizing or trimming', () => {
    expect(exactMemoryPayloadHash('hello')).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    expect(exactMemoryPayloadHash('é')).not.toBe(exactMemoryPayloadHash('e\u0301'));
    expect(exactMemoryPayloadHash('5')).not.toBe(exactMemoryPayloadHash(' 5'));
  });

  it.each(['', ' ', ' 5', '5 ', '\n5', '5\n', 'bad\0text', 'bad\ud800text', 'x'.repeat(4001)])('rejects noncanonical or oversized payload before writing', async payload => {
    const before = await snapshot();
    await expect(memory.writeExact(owner, input(payload))).rejects.toBeDefined();
    expect(await snapshot()).toEqual(before);
  });

  it('rejects malformed keys, dishonest hashes, unknown fields and credentials without truncation', async () => {
    const request = input(), before = await snapshot();
    for (const operationKey of ['x', 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(65)]) {
      await expect(memory.writeExact(owner, { ...request, operationKey })).rejects.toBeDefined();
    }
    await expect(memory.writeExact(owner, { ...request, payloadHash: '0'.repeat(64) })).rejects.toMatchObject({ code: 'MEMORY_PAYLOAD_HASH_MISMATCH' });
    await expect(memory.writeExact(owner, { ...request, title: 'unapproved metadata' })).rejects.toBeDefined();
    await expect(memory.writeExact(owner, input('password=fixture-secret-value'))).rejects.toMatchObject({ code: 'MEMORY_SECRET_REJECTED' });
    expect(await snapshot()).toEqual(before);
  });
});
