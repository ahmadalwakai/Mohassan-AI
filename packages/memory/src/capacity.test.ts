import { randomUUID } from 'node:crypto';
import { createDatabase, migrate } from '@mohassan/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrateAuth } from '../../../apps/server/src/auth.ts';
import { MAX_AUTOMATIC_TASK_OUTCOMES, MAX_LIVE_USER_MEMORY_VERSIONS } from './capacity.ts';
import { createMemoryControl, exactMemoryPayloadHash, memoryMigration } from './index.ts';

let store: Awaited<ReturnType<typeof createDatabase>>;
let memory: ReturnType<typeof createMemoryControl>;
let owner: string, other: string, clock: Date;

beforeAll(async () => {
  store = await createDatabase({});
  expect(store.mode).toBe('embedded');
  await migrateAuth(store.db);
  await migrate(store.db);
  await memoryMigration(store.db);
});

beforeEach(async () => {
  owner = randomUUID();
  other = randomUUID();
  await store.db.insertInto('user').values([owner, other].map(id => ({ id, name: id, email: `${id}@example.test` }))).execute();
  clock = new Date('2026-11-27T12:00:00Z');
  memory = createMemoryControl(store.db, { now: () => clock });
});

afterAll(async () => { await store?.close(); });

const note = { title: 'Owner note', content: 'Files are in the cabinet.', layer: 'semantic' };
const mutation = { expectedVersion: 1, reason: 'Owner changed the record.' };

function exactRequest(payload: string) {
  return { operationKey: exactMemoryPayloadHash(randomUUID()), payload, payloadHash: exactMemoryPayloadHash(payload) };
}

function reconcileRequest({ operationKey, payloadHash }: ReturnType<typeof exactRequest>) {
  return memory.reconcileExact(owner, { operationKey, payloadHash });
}

function itemFixture() {
  const id = randomUUID();
  return {
    id, root_id: id, owner_id: owner, version: 1, title: note.title, content: note.content,
    layer: note.layer, status: 'active', confidence: 0.5, confidence_kind: 'user_asserted',
    task_id: null as string | null, expires_at: new Date(clock.getTime() + 1), created_at: clock, updated_at: clock,
  };
}

async function seedItems(count: number, overrides: Partial<ReturnType<typeof itemFixture>> = {}) {
  await store.db.insertInto('memory_items')
    .values(Array.from({ length: count }, () => ({ ...itemFixture(), ...overrides }))).execute();
}

async function finishedTask(ownerId = owner, updatedAt = clock) {
  const id = randomUUID();
  await store.db.insertInto('tasks').values({
    id, owner_id: ownerId, title: 'Completed diagnostic', goal: 'Check the local database.',
    capability_id: 'system.diagnostic', autonomy: 'scoped', status: 'completed', attempt: 1,
    idempotency_key: id, input_hash: exactMemoryPayloadHash(id), updated_at: updatedAt,
  }).execute();
  return id;
}

function automaticItems(ownerId = owner) {
  return store.db.selectFrom('memory_items').selectAll().where('owner_id', '=', ownerId)
    .where('confidence_kind', '=', 'task_observed');
}

describe('live user memory capacity', () => {
  it('allows create and exact write with a full cap of dead and automatic versions', async () => {
    const taskId = await finishedTask();
    const perKind = Math.ceil(MAX_LIVE_USER_MEMORY_VERSIONS / 4);
    await seedItems(perKind, { status: 'superseded' });
    await seedItems(perKind, { status: 'revoked' });
    await seedItems(perKind, { expires_at: clock });
    await seedItems(perKind, { confidence_kind: 'task_observed', layer: 'episodic', task_id: taskId, confidence: 1 });
    await seedItems(MAX_LIVE_USER_MEMORY_VERSIONS - 2);

    const saved = await memory.create(owner, { ...note, taskId });
    expect(saved).toMatchObject({ ...note, taskId, confidenceKind: 'user_asserted' });
    const request = exactRequest('The total is 17.');
    const written = await memory.writeExact(owner, request);
    expect(written.created).toBe(true);
    expect(await reconcileRequest(request)).toMatchObject({ status: 'verified', item: { content: request.payload } });
    await expect(memory.create(owner, note)).rejects.toMatchObject({ code: 'MEMORY_LIMIT' });
    await expect(memory.writeExact(owner, exactRequest('The total is 18.'))).rejects.toMatchObject({ code: 'MEMORY_LIMIT' });
    expect(await memory.writeExact(owner, request)).toEqual({ created: false, receipt: written.receipt });
  });

  it('allows a same-slot correction and blocks operations that would add a live user version at capacity', async () => {
    const taskId = await finishedTask();
    await memory.sync(owner);
    const automatic = await automaticItems().where('task_id', '=', taskId).executeTakeFirstOrThrow();
    const original = await memory.create(owner, note);
    const expired = await memory.create(owner, { ...note, expiresAt: clock.toISOString() });
    await seedItems(MAX_LIVE_USER_MEMORY_VERSIONS - 1);

    const replacement = { ...note, ...mutation, content: 'Files are in the drawer.' };
    const updated = await memory.correct(owner, original.id, replacement);
    expect(updated).toMatchObject({ rootId: original.rootId, version: original.version + 1, content: replacement.content });
    expect((await memory.detail(owner, updated.id)).versions.map(row => row.status)).toEqual(['active', 'superseded']);
    await expect(memory.correct(owner, automatic.id, replacement)).rejects.toMatchObject({ code: 'MEMORY_LIMIT' });
    await expect(memory.correct(owner, expired.id, replacement)).rejects.toMatchObject({ code: 'MEMORY_LIMIT' });
    expect((await memory.detail(owner, automatic.id)).versions.map(row => row.status)).toEqual(['active']);
    expect((await memory.detail(owner, expired.id)).versions.map(row => row.status)).toEqual(['expired']);
    expect(await memory.create(owner, { ...note, expiresAt: clock.toISOString() })).toMatchObject({ status: 'expired' });
    expect(await memory.correct(owner, expired.id, { ...replacement, expiresAt: clock.toISOString() })).toMatchObject({ status: 'expired' });

    const preference = {
      taskId, kind: 'preference', comment: 'Use a short summary.', submissionKey: randomUUID(), persistPreference: true,
    };
    await expect(memory.feedback(owner, preference)).rejects.toMatchObject({ code: 'MEMORY_LIMIT' });
    expect(await store.db.selectFrom('memory_feedback').select('id').where('owner_id', '=', owner).execute()).toEqual([]);
    await expect(memory.feedback(owner, { ...preference, persistPreference: false, submissionKey: randomUUID() }))
      .resolves.toMatchObject({ persistedPreference: false });
    await memory.revoke(owner, updated.id, { ...mutation, expectedVersion: updated.version });
    await expect(memory.feedback(owner, preference)).resolves.toMatchObject({ persistedPreference: true });
  });
});

describe('automatic task outcome capacity', () => {
  it('fills only the remaining slots under concurrent syncs and skips older outcomes while full', async () => {
    const newest = await finishedTask();
    const older = await finishedTask(owner, new Date(clock.getTime() - 1));
    await seedItems(MAX_AUTOMATIC_TASK_OUTCOMES - 1, {
      confidence_kind: 'task_observed', layer: 'episodic', task_id: newest, confidence: 1,
    });

    const firstSyncs = await Promise.all([memory.sync(owner), memory.sync(owner)]);
    expect(firstSyncs.map(({ created }) => created).sort()).toEqual([0, 1]);
    expect(await automaticItems().execute()).toHaveLength(MAX_AUTOMATIC_TASK_OUTCOMES);
    const seenKeys = () => store.db.selectFrom('memory_evidence').select('source_key')
      .where('owner_id', '=', owner).where('source_key', 'like', 'outcome:%').orderBy('source_key').execute();
    expect(await seenKeys()).toEqual([{ source_key: `outcome:${newest}:1:completed` }]);

    expect(await memory.sync(owner)).toEqual({ created: 0 });
    await seedItems(1, { confidence_kind: 'task_observed', layer: 'episodic', task_id: newest, confidence: 1 });
    expect(await memory.sync(owner)).toEqual({ created: 0 });
    expect(await automaticItems().execute()).toHaveLength(MAX_AUTOMATIC_TASK_OUTCOMES + 1);

    clock = new Date(clock.getTime() + 1);
    expect(await memory.sync(owner)).toEqual({ created: 1 });
    expect(await automaticItems().where('task_id', '=', older).execute()).toHaveLength(1);
    expect(await automaticItems().where('task_id', '=', newest).execute()).toHaveLength(1);
    expect(await memory.sync(owner)).toEqual({ created: 0 });
  });

  it('cleans up during a write-enabled search even without finished tasks', async () => {
    await seedItems(1, { confidence_kind: 'task_observed', layer: 'episodic', confidence: 1,
      task_id: randomUUID(), expires_at: clock });

    await memory.search(owner, { query: '' }, { readOnly: true });
    expect(await automaticItems().execute()).toHaveLength(1);
    await memory.search(owner, { query: '' });
    expect(await automaticItems().execute()).toEqual([]);
  });

  it('prunes only the owner’s expired automatic item and preserves evidence and exact reconciliation', async () => {
    const expiredRequest = exactRequest('An expired result.');
    const expired = await memory.writeExact(owner, expiredRequest);
    clock = new Date(expired.receipt.expiresAt);
    const liveRequest = exactRequest('A current result.');
    await memory.writeExact(owner, liveRequest);
    const deletedRequest = exactRequest('A deleted result.');
    const deleted = await memory.writeExact(owner, deletedRequest);
    await memory.remove(owner, deleted.receipt.itemId, mutation);

    const taskId = await finishedTask();
    await finishedTask(owner, new Date(clock.getTime() - 1));
    await finishedTask(other);
    await memory.sync(owner);
    await memory.sync(other);
    const outcome = await automaticItems().where('task_id', '=', taskId).executeTakeFirstOrThrow();
    const citation = (await memory.detail(owner, outcome.id)).item.provenance[0];
    await memory.create(owner, { ...note, taskId, evidenceIds: [citation.id] });
    await seedItems(1, { status: 'superseded', expires_at: clock });
    await seedItems(1, { status: 'revoked', expires_at: clock });
    await store.db.updateTable('memory_items').set({ expires_at: clock })
      .where('confidence_kind', '=', 'task_observed').where(eb => eb.or([
        eb('id', '=', outcome.id), eb('owner_id', '=', other),
      ])).execute();

    const snapshot = async () => ({
      items: await store.db.selectFrom('memory_items').selectAll().orderBy('id').execute(),
      evidence: await store.db.selectFrom('memory_evidence').selectAll().orderBy('id').execute(),
      provenance: await store.db.selectFrom('memory_provenance').selectAll().orderBy('memory_id').orderBy('evidence_id').execute(),
      operations: await store.db.selectFrom('memory_exact_operations').selectAll().orderBy('operation_key').execute(),
    });
    const requests = [expiredRequest, liveRequest, deletedRequest];
    const reconcile = () => Promise.all(requests.map(reconcileRequest));
    const before = await snapshot();
    const reconciled = await reconcile();
    expect(reconciled).toMatchObject([
      { status: 'unavailable', reason: 'item_expired' },
      { status: 'verified' },
      { status: 'unavailable', reason: 'item_missing' },
    ]);

    expect(await memory.sync(owner)).toEqual({ created: 0 });
    expect(await memory.sync(owner)).toEqual({ created: 0 });
    expect(await snapshot()).toEqual({
      ...before,
      items: before.items.filter(row => row.id !== outcome.id),
      provenance: before.provenance.filter(row => row.memory_id !== outcome.id),
    });
    expect(await reconcile()).toEqual(reconciled);
    expect(await memory.writeExact(owner, deletedRequest)).toEqual({ created: false, receipt: deleted.receipt });
  });
});
