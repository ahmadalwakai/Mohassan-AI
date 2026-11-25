import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { createDatabase, migrate } from '@mohassan/database';
import { createMemoryControl, memoryMigration } from '@mohassan/memory';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { migrateAuth } from '../apps/server/src/auth.js';
import { parseStructuredMemoryRequest } from '../apps/server/src/assistant/structured-memory-parser.js';
import { applyStructuredMemory, lockStructuredMemoryOwner, migrateStructuredMemory } from '../apps/server/src/assistant/structured-memory-storage.js';

// Development tests only. Text is from the task, with a deterministic substitution
// from assistant-current-memory-declaration-chat.test.ts. Never use for training.
const statement = 'أنا ساكن في جدة';
const alternative = statement.replace('جدة', 'Bristol');
const question = 'where do I live?';
const forgetText = 'انس رقم هاتفي';
const phoneStatement = 'رقمي هو 0501234567'; // assistant-own-fact-question.test.ts
const credentialStatement = 'تذكر أن رمز التحقق هو ١٢٣٤'; // assistant-legacy-memory-statement.test.ts

let database: Awaited<ReturnType<typeof createDatabase>>;
let ownerId: string, otherId: string;
const runScope = (accountId = ownerId) => ({ ownerId: accountId, runId: randomUUID(), conversationId: randomUUID(), evaluatedAt: Date.now() });

beforeAll(async () => {
  database = await createDatabase({});
  await migrateAuth(database.db);
  await migrate(database.db);
  await memoryMigration(database.db);
  await migrateStructuredMemory(database.db);
  await migrateStructuredMemory(database.db);
}, 20000);

beforeEach(async () => {
  ownerId = randomUUID();
  otherId = randomUUID();
  await database.db.insertInto('user').values([ownerId, otherId].map(id => ({ id, email: `${id}@example.test`, name: id }))).execute();
});

afterAll(async () => { await database?.close(); });

function apply(text: string, scope: Parameters<typeof applyStructuredMemory>[1] = runScope()) {
  const intent = parseStructuredMemoryRequest(text);
  if (!('target' in intent)) throw new Error('Fixture could not be parsed.');
  return database.db.transaction().execute(async tx => {
    if (intent.kind !== 'recall') await lockStructuredMemoryOwner(tx, scope.ownerId);
    return applyStructuredMemory(tx, scope, intent);
  });
}

it('reads a legacy note and its standard API correction only with same-account manual evidence', async () => {
  const memory = createMemoryControl(database.db);
  const item = await memory.create(ownerId, { layer: 'semantic', title: 'Residence', content: statement });
  expect(await apply(question)).toMatchObject({ kind: 'recalled', fact: { statement, date: new Date(item.createdAt) } });
  expect(await apply(question, runScope(otherId))).toEqual({ kind: 'missing' });
  const corrected = await memory.correct(ownerId, item.id, { layer: 'semantic', title: item.title, content: alternative,
    expectedVersion: item.version, reason: 'Update the existing fact.' });
  expect(await apply(question)).toMatchObject({ kind: 'recalled', fact: { statement: alternative } });
  await database.db.updateTable('memory_evidence').set({ owner_id: otherId }).where('id', '=', corrected.provenance[0]!.id).execute();
  expect(await apply(question)).toEqual({ kind: 'missing' });
  expect(await apply(question, runScope(otherId))).toEqual({ kind: 'missing' });
});

it('deduplicates concurrent retries, cascades metadata on standard delete and never revives a retried write', async () => {
  const memory = createMemoryControl(database.db);
  const scope = runScope();
  const outcomes = await Promise.all(Array.from({ length: 3 }, () => apply(statement, scope)));
  expect(outcomes.every(outcome => outcome.kind === 'saved')).toBe(true);
  const workspace = await memory.workspace(ownerId);
  expect(workspace.items).toHaveLength(1);
  const item = workspace.items[0]!;
  await memory.remove(ownerId, item.id, { expectedVersion: item.version, reason: 'Delete the existing fact.' });
  expect(await database.db.selectFrom('memory_structured_versions').where('owner_id', '=', ownerId).select('item_id').execute()).toEqual([]);
  expect(await apply(statement, scope)).toEqual({ kind: 'missing' });
  expect(await apply(question)).toEqual({ kind: 'missing' });
  expect(await apply(alternative, scope).catch(error => error.message)).toBe('STRUCTURED_MEMORY_READBACK_FAILED');
});

it('rolls the write and evidence back when a fresh read sees a changed statement', async () => {
  const intent = parseStructuredMemoryRequest(statement);
  if (intent.kind !== 'statement') throw new Error('Fixture could not be parsed.');
  await expect(database.db.transaction().execute(async tx => {
    await sql`CREATE FUNCTION corrupt_memory_payload() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN NEW.content = NEW.content || ' '; RETURN NEW; END; $$`.execute(tx);
    await sql`CREATE TRIGGER corrupt_memory_payload BEFORE INSERT ON memory_items
      FOR EACH ROW EXECUTE FUNCTION corrupt_memory_payload()`.execute(tx);
    await lockStructuredMemoryOwner(tx, ownerId);
    await applyStructuredMemory(tx, runScope(), intent);
  })).rejects.toThrow('STRUCTURED_MEMORY_READBACK_FAILED');
  const [items, evidence, operations] = await Promise.all([
    database.db.selectFrom('memory_items').where('owner_id', '=', ownerId).select('id').execute(),
    database.db.selectFrom('memory_evidence').where('owner_id', '=', ownerId).select('id').execute(),
    database.db.selectFrom('memory_structured_operations').where('owner_id', '=', ownerId).select('run_id').execute(),
  ]);
  expect([items, evidence, operations]).toEqual([[], [], []]);
});

it('forgets the old fact while preserving the independently verified replacement property', async () => {
  const memory = createMemoryControl(database.db);
  const original = await memory.create(ownerId, { layer: 'semantic', title: 'Phone', content: phoneStatement });
  const replacement = await memory.correct(ownerId, original.id, { layer: 'semantic', title: 'Residence', content: statement,
    expectedVersion: original.version, reason: 'Edit after a correction.' });
  expect(await apply(forgetText)).toEqual({ kind: 'forgotten' });
  const detail = await memory.detail(ownerId, replacement.id);
  expect(detail.versions.map(version => version.id)).toEqual([replacement.id]);
  expect(await apply(question)).toMatchObject({ kind: 'recalled', fact: { statement } });
});

it('keeps an expired value in history after a new explicit save and refuses a correction without a live fact', async () => {
  const memory = createMemoryControl(database.db);
  const correction = 'غيّر عنواني إلى Bristol'; // User command with a pinned fixture value.
  expect(await apply(correction)).toEqual({ kind: 'missing' });
  expect((await apply(statement)).kind).toBe('saved');
  const old = (await memory.workspace(ownerId)).items[0]!;
  await database.db.updateTable('memory_items').set({ expires_at: new Date(Date.now() - 1000) }).where('id', '=', old.id).execute();
  expect(await apply(question)).toEqual({ kind: 'missing' });
  expect(await apply(correction)).toEqual({ kind: 'missing' });
  expect((await apply(`تذكر أن ${alternative}`)).kind).toBe('saved');
  const current = (await memory.workspace(ownerId)).items[0]!;
  expect(current.rootId).toBe(old.rootId);
  expect((await memory.detail(ownerId, current.id)).versions.map(item => item.content)).toEqual([alternative, statement]);
});

it('forgets duplicate legacy roots even after a structured revision supersedes both originals', async () => {
  const memory = createMemoryControl(database.db);
  for (const content of [phoneStatement, phoneStatement.replace('0501234567', '0551234567')]) {
    await memory.create(ownerId, { layer: 'semantic', title: 'Phone', content });
  }
  const newStatement = `تذكر أن ${phoneStatement}`;
  expect((await apply(newStatement)).kind).toBe('saved');
  expect((await memory.workspace(ownerId)).items).toHaveLength(1);
  expect((await apply(forgetText)).kind).toBe('forgotten');
  expect(await database.db.selectFrom('memory_items').where('owner_id', '=', ownerId).select('id').execute()).toEqual([]);
});

it('rejects secret material even when handed a previously parsed target', async () => {
  const intent = parseStructuredMemoryRequest(statement);
  if (intent.kind !== 'statement') throw new Error('Fixture could not be parsed.');
  await expect(database.db.transaction().execute(async tx => {
    await lockStructuredMemoryOwner(tx, ownerId);
    await applyStructuredMemory(tx, runScope(), { ...intent, statement: credentialStatement });
  })).rejects.toThrow('STRUCTURED_MEMORY_READBACK_FAILED');
  expect((await createMemoryControl(database.db).workspace(ownerId)).items).toEqual([]);
});

it('recalls a reordered fact label only from active owner evidence and requires every requested field', async () => {
  const operations: string[] = [];
  const onOperation = (operation: string) => operations.push(operation);
  const request = 'Remember that my greenhouse vent opening time is 09:10.';
  const lookup = 'From my memory, tell me my opening time for the greenhouse vent.';
  expect(await apply(request, { ...runScope(), onOperation })).toMatchObject({ kind: 'saved' });
  expect(operations).toEqual(['write', 'reconcile']);
  operations.length = 0;
  expect(await apply(lookup, { ...runScope(), onOperation })).toMatchObject({ kind: 'recalled', fact: { value: '09:10' } });
  expect(operations).toEqual(['search']);
  expect(await apply(lookup, runScope(otherId))).toEqual({ kind: 'missing' });
  expect(await apply('From my memory, what opening time and color did I save for my greenhouse vent?')).toEqual({ kind: 'missing' });
  const item = (await createMemoryControl(database.db).workspace(ownerId)).items[0]!;
  await database.db.updateTable('memory_items').set({ expires_at: new Date(Date.now() - 1000) }).where('id', '=', item.id).execute();
  expect(await apply(lookup)).toEqual({ kind: 'missing' });
});

it('leaves equally supported subjects ambiguous and disregards words in a fact value', async () => {
  await apply('Remember that my train boarding day is Saturday.');
  await apply('Remember that my ferry boarding day is Monday.');
  expect(await apply('Which boarding day is in my memory?')).toEqual({ kind: 'ambiguous' });
  await apply('Keep in mind that my cactus is named Fern.');
  expect(await apply('From my memory, what name did I save for my fern?')).toEqual({ kind: 'missing' });
});

it('recalls an unindexed user assertion from memory created before open descriptors', async () => {
  const memory = createMemoryControl(database.db);
  await memory.create(ownerId, { layer: 'semantic', title: 'Personal note', content: 'Our studio back entrance is on Cedar Avenue.' });
  const query = 'From my memory, tell me the back entrance for the studio.';
  expect(await apply(query)).toMatchObject({ kind: 'recalled', fact: { value: 'on Cedar Avenue' } });
  expect(await apply(query, runScope(otherId))).toEqual({ kind: 'missing' });
});

it('verifies a repeated forget without deleting any replacement', async () => {
  const operations: string[] = [];
  const scope = { ...runScope(), onOperation: (operation: string) => operations.push(operation) };
  await apply('Keep in mind that my cactus is named Lichen.');
  const deletion = "Forget my cactus's name.";
  expect(await apply(deletion, scope)).toEqual({ kind: 'forgotten' });
  expect(operations).toEqual(['forget', 'reconcile']);
  operations.length = 0;
  expect(await apply(deletion, scope)).toEqual({ kind: 'forgotten' });
  expect(operations).toEqual(['reconcile']);
  operations.length = 0;
  await apply('Keep in mind that my cactus is named Thorn.');
  expect(await apply(deletion, scope)).toEqual({ kind: 'changed' });
  expect(operations).toEqual([]);
  expect(await apply("What is my cactus's name from my memory?")).toMatchObject({ kind: 'recalled', fact: { value: 'Thorn' } });
});
