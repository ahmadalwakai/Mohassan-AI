import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import { createDatabase, migrate } from '@mohassan/database';
import { createMemoryControl, exactMemoryPayloadHash, memoryMigration, MemoryError,
  type MemoryExactReconciliation, type MemoryExactWriteInput, type MemoryExactWriteOptions, type MemoryExactWriteReceipt } from '@mohassan/memory';
import { migrateAuth } from '../apps/server/src/auth.js';
import { createAssistantTools } from '../apps/server/src/assistant/tools.js';
import { decisionSchema, WORK_TOOLS } from '../apps/server/src/assistant/brain.js';

type Modules = Parameters<typeof createAssistantTools>[0];
type MemoryModule = Modules['memory'];
const owner = 'exact-adapter-fixture-owner';
const unused = async (..._args: unknown[]): Promise<never> => { throw new Error('Unrelated module must not run in this fixture.'); };
function modules(memory: MemoryModule): Modules {
  return { memory, coding: { available: false, workspace: unused }, studio: { workspace: unused, detail: unused }, studioChange: false,
    runtime: { createTask: unused, approve: unused, cancel: unused, detail: unused },
    windows: { enabled: false, view: unused, act: unused, command: unused } };
}
function fixture() {
  const create = vi.fn(async (_owner: string, _input: unknown) => ({}));
  const search = vi.fn(async (_owner: string, _input: unknown, _options: { readOnly: true }) => ({ items: [] }));
  const input: MemoryExactWriteInput = { operationKey: 'a'.repeat(64), payload: '٢ + ٣ = ٥\nRésumé e\u0301', payloadHash: exactMemoryPayloadHash('٢ + ٣ = ٥\nRésumé e\u0301') };
  const receipt: MemoryExactWriteReceipt = { version: 1, ownerId: owner, operationKey: input.operationKey, payloadHash: input.payloadHash,
    payloadBytes: Buffer.byteLength(input.payload, 'utf8'), itemId: randomUUID(), rootId: randomUUID(), itemVersion: 1,
    evidenceId: randomUUID(), layer: 'semantic', createdAt: '2026-11-21T07:00:00.000Z', expiresAt: '2027-05-20T07:00:00.000Z' };
  const committed = { created: true, receipt };
  const missing: MemoryExactReconciliation = { status: 'missing' };
  return { create, search, input, receipt, committed, missing };
}

describe('trusted host exact-memory adapters', () => {
  it('forwards exact bytes, owner, options, signal and committed identity once without rewrites', async () => {
    const f = fixture(), controller = new AbortController();
    const fence = vi.fn(async (_tx: Kysely<any>) => {}), options = { signal: controller.signal, fence };
    let receiver: unknown;
    const memory: MemoryModule = { create: f.create, search: f.search,
      writeExact: vi.fn(async function (this: MemoryModule, _owner: string, _input: MemoryExactWriteInput, _options?: MemoryExactWriteOptions) {
        receiver = this; return f.committed;
      }), reconcileExact: vi.fn(async () => f.missing) };
    const tools = createAssistantTools(modules(memory));
    await expect(tools.memory!.writeExact!(owner, f.input, options)).resolves.toBe(f.committed);
    expect(memory.writeExact).toHaveBeenCalledOnce();
    const [forwardedOwner, forwardedInput, forwardedOptions] = vi.mocked(memory.writeExact!).mock.calls[0];
    expect(forwardedOwner).toBe(owner); expect(forwardedInput).toBe(f.input); expect(forwardedOptions).toBe(options);
    expect(forwardedInput.payload).toBe('٢ + ٣ = ٥\nRésumé e\u0301');
    expect(forwardedOptions!.signal).toBe(controller.signal); expect(forwardedOptions!.fence).toBe(fence);
    expect(receiver).toBe(memory); expect(f.create).not.toHaveBeenCalled(); expect(f.search).not.toHaveBeenCalled();
  });

  it('forwards reconciliation unchanged without falling back to search or create', async () => {
    const f = fixture(), signal = new AbortController().signal, options = { signal }, query = { operationKey: f.input.operationKey, payloadHash: f.input.payloadHash };
    const unavailable: MemoryExactReconciliation = { status: 'unavailable', reason: 'item_missing', receipt: f.receipt };
    let receiver: unknown;
    const memory: MemoryModule = { create: f.create, search: f.search, writeExact: vi.fn(async () => f.committed),
      reconcileExact: vi.fn(async function (this: MemoryModule) { receiver = this; return unavailable; }) };
    const tools = createAssistantTools(modules(memory));
    await expect(tools.memory!.reconcileExact!(owner, query, options)).resolves.toBe(unavailable);
    expect(memory.reconcileExact).toHaveBeenCalledOnce();
    const args = vi.mocked(memory.reconcileExact!).mock.calls[0];
    expect(args[0]).toBe(owner); expect(args[1]).toBe(query); expect(args[2]).toBe(options);
    expect(receiver).toBe(memory); expect(memory.writeExact).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled(); expect(f.search).not.toHaveBeenCalled();
  });

  it('passes the original fence closure through to the domain transaction object', async () => {
    const f = fixture(), tx = { fixtureTransactionIdentity: true } as unknown as Kysely<any>;
    const fence = vi.fn(async (provided: Kysely<any>) => { expect(provided).toBe(tx); });
    const memory: MemoryModule = { create: f.create, search: f.search,
      writeExact: vi.fn(async (_owner, _input, options) => { expect(options!.fence).toBe(fence); await options!.fence!(tx); return f.committed; }),
      reconcileExact: vi.fn(async () => f.missing) };
    await createAssistantTools(modules(memory)).memory!.writeExact!(owner, f.input, { fence });
    expect(fence).toHaveBeenCalledExactlyOnceWith(tx);
  });

  it.each(['neither', 'write_only', 'reconcile_only'] as const)('exposes neither method for an incomplete %s capability', kind => {
    const f = fixture(), memory: MemoryModule = { create: f.create, search: f.search,
      ...(kind === 'write_only' ? { writeExact: vi.fn(async () => f.committed) } : {}),
      ...(kind === 'reconcile_only' ? { reconcileExact: vi.fn(async () => f.missing) } : {}) };
    const tools = createAssistantTools(modules(memory));
    expect(tools.memory!.writeExact).toBeUndefined(); expect(tools.memory!.reconcileExact).toBeUndefined();
    expect(typeof tools.memory!.save).toBe('function'); expect(typeof tools.memory!.search).toBe('function');
  });

  it('preserves domain error identities, codes and status on both methods', async () => {
    const f = fixture(), error = new MemoryError('MEMORY_OPERATION_CONFLICT', 'Isolated conflicting operation.', 409);
    const memory: MemoryModule = { create: f.create, search: f.search,
      writeExact: vi.fn(async () => { throw error; }), reconcileExact: vi.fn(async () => { throw error; }) };
    const tools = createAssistantTools(modules(memory));
    await expect(tools.memory!.writeExact!(owner, f.input)).rejects.toBe(error);
    await expect(tools.memory!.reconcileExact!(owner, { operationKey: f.input.operationKey, payloadHash: f.input.payloadHash })).rejects.toBe(error);
    expect(error.code).toBe('MEMORY_OPERATION_CONFLICT'); expect(error.statusCode).toBe(409);
    expect(memory.writeExact).toHaveBeenCalledOnce(); expect(memory.reconcileExact).toHaveBeenCalledOnce();
  });

  it('preserves a coded execution-ended fence error without converting its class', async () => {
    const f = fixture();
    class FixtureRunEnded extends Error { readonly code = 'CHAT_EXECUTION_ENDED'; }
    const ended = new FixtureRunEnded('Isolated lease ended.'), tx = {} as Kysely<any>;
    const memory: MemoryModule = { create: f.create, search: f.search,
      writeExact: vi.fn(async (_owner, _input, options) => { await options!.fence!(tx); return f.committed; }),
      reconcileExact: vi.fn(async () => f.missing) };
    await expect(createAssistantTools(modules(memory)).memory!.writeExact!(owner, f.input, { fence: async () => { throw ended; } })).rejects.toBe(ended);
    expect(memory.writeExact).toHaveBeenCalledOnce(); expect(f.create).not.toHaveBeenCalled();
  });

  it('preserves cancellation reasons without retrying or compensating', async () => {
    const f = fixture(), controller = new AbortController(), reason = new Error('Isolated cancellation.');
    controller.abort(reason);
    const memory: MemoryModule = { create: f.create, search: f.search,
      writeExact: vi.fn(async (_owner, _input, options) => { options!.signal!.throwIfAborted(); return f.committed; }),
      reconcileExact: vi.fn(async (_owner, _input, options) => { options!.signal!.throwIfAborted(); return f.missing; }) };
    const tools = createAssistantTools(modules(memory));
    await expect(tools.memory!.writeExact!(owner, f.input, { signal: controller.signal })).rejects.toBe(reason);
    await expect(tools.memory!.reconcileExact!(owner, { operationKey: f.input.operationKey, payloadHash: f.input.payloadHash }, { signal: controller.signal })).rejects.toBe(reason);
    expect(memory.writeExact).toHaveBeenCalledOnce(); expect(memory.reconcileExact).toHaveBeenCalledOnce(); expect(f.create).not.toHaveBeenCalled();
  });

  it('leaves the legacy save path and its request-language context unchanged', async () => {
    const f = fixture(), tools = createAssistantTools(modules({ create: f.create, search: f.search }));
    await expect(tools.memory!.save(owner, '  The result is five.  ', '  Remember this result.  ')).resolves.toBe('saved to memory');
    expect(f.create).toHaveBeenCalledExactlyOnceWith(owner, { title: 'Remember this result.', content: 'The result is five.\nRemember this result.', layer: 'semantic' });
    expect(tools.memory!.writeExact).toBeUndefined(); expect(tools.memory!.reconcileExact).toBeUndefined();
  });

  it('does not add exact-memory methods to the model decision vocabulary', () => {
    for (const tool of ['writeExact', 'reconcileExact', 'memory_write_exact', 'memory_reconcile_exact']) {
      expect(WORK_TOOLS).not.toContain(tool);
      expect(decisionSchema(false, false, ['memory_save']).safeParse({ tool }).success).toBe(false);
    }
  });

  it('uses the real PGlite domain transaction and read-only reconciliation through the adapter', async () => {
    const database = await createDatabase({});
    try {
      await migrateAuth(database.db); await migrate(database.db); await memoryMigration(database.db);
      await database.db.insertInto('user').values({ id: owner, name: owner, email: 'exact-adapter-owner@example.test' }).execute();
      const domain = createMemoryControl(database.db), tools = createAssistantTools(modules(domain));
      const f = fixture(), seen: number[] = [];
      const fence = async (tx: Kysely<any>) => {
        const rows = await tx.selectFrom('memory_exact_operations').select('operation_key').where('owner_id', '=', owner).execute();
        seen.push(rows.length);
      };
      const written = await tools.memory!.writeExact!(owner, f.input, { fence });
      expect(seen).toEqual([0, 1]); expect(written.created).toBe(true);
      const readback = await tools.memory!.reconcileExact!(owner, { operationKey: f.input.operationKey, payloadHash: f.input.payloadHash });
      expect(readback).toMatchObject({ status: 'verified', scope: 'memory_persistence_only', receipt: written.receipt, item: { content: f.input.payload } });
      class FixtureLeaseEnded extends Error { readonly code = 'CHAT_EXECUTION_ENDED'; }
      const ended = new FixtureLeaseEnded('Isolated final transaction fence expired.');
      let calls = 0;
      const second = { ...f.input, operationKey: 'b'.repeat(64) };
      await expect(tools.memory!.writeExact!(owner, second, { fence: async tx => {
        expect((await tx.selectFrom('memory_items').select('id').where('owner_id', '=', owner).execute()).length).toBe(++calls === 1 ? 1 : 2);
        if (calls === 2) throw ended;
      } })).rejects.toBe(ended);
      expect(await domain.reconcileExact(owner, { operationKey: second.operationKey, payloadHash: second.payloadHash })).toEqual({ status: 'missing' });
      expect(await database.db.selectFrom('memory_items').select('id').where('owner_id', '=', owner).execute()).toHaveLength(1);
    } finally { await database.close(); }
  });
});
