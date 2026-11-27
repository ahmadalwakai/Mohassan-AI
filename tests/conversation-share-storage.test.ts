import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentBrowser } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { commandChatMigration, createCommandChatControl } from '../apps/server/src/command-chat.js';
import { scanConversationPrivacy } from '../apps/server/src/conversation-share-privacy.js';
import { createConversationShareStorage } from '../apps/server/src/conversation-share-storage.js';

describe('conversation share storage', () => {
  let database: Awaited<ReturnType<typeof createDatabase>>;
  const owner = 'snapshot-owner';
  const createdAt = '2026-11-25T12:00:00.000Z';

  beforeAll(async () => {
    database = await createDatabase();
    await migrate(database.db);
    await commandChatMigration(database.db);
  }, 30_000);
  afterAll(async () => { await database?.close(); });

  async function conversation(title: string) {
    const id = randomUUID();
    await database.db.insertInto('chat_conversations').values({ id, owner_id: owner, title, created_at: createdAt }).execute();
    return id;
  }

  it('applies the command chat migration once and reads visible text and sources in message order', async () => {
    await commandChatMigration(database.db);
    const migrations = await database.db.selectFrom('schema_migrations').select('version').where('version', '=', '039_conversation_shares').execute();
    expect(migrations).toEqual([{ version: '039_conversation_shares' }]);
    const id = await conversation('المصادر');
    const question = 'أعطني المرجع.';
    const answer = 'هذه الإجابة.\n<think>hidden reasoning</think>\n\n**المصدر:** [وثائق](https://example.test/wiki/page_(documentation))';
    const answeredAt = '2026-11-25T12:01:00.000Z';
    await database.db.insertInto('chat_messages').values([
      { id: randomUUID(), conversation_id: id, role: 'assistant', text: answer, created_at: answeredAt },
      { id: randomUUID(), conversation_id: id, role: 'user', text: question, created_at: createdAt },
    ]).execute();
    const store = createConversationShareStorage(database.db);
    expect(await store.ownedSnapshot('another-account', id)).toBeNull();
    const result = await store.ownedSnapshot(owner, id);
    expect(result?.snapshot).toEqual({
      title: 'المصادر',
      createdAt,
      messages: [
        { role: 'user', text: question, createdAt, sources: [] },
        {
          role: 'assistant', text: expect.stringMatching(/^هذه الإجابة\.\s*$/u), createdAt: answeredAt,
          sources: [{ title: 'وثائق', url: 'https://example.test/wiki/page_(documentation)' }],
        },
      ],
    });
    expect(result?.provenance.get(1)).toEqual(['tool-output']);
  });

  it('binds directly recorded provenance and carries earlier private content into an answer that quotes it', async () => {
    const id = await conversation('متابعة المحادثة');
    const memoryRun = randomUUID();
    const otherRun = randomUUID();
    const followupRun = randomUUID();
    await database.db.insertInto('chat_runs').values([
      {
        id: memoryRun, owner_id: owner, conversation_id: id, status: 'completed', goal: 'شو بتتذكر؟', lease_token: randomUUID(),
        created_at: createdAt, updated_at: '2026-11-25T12:02:00.000Z', lease_expires_at: createdAt,
        state: JSON.stringify({ trail: [{ action: 'memory_search' }] }),
      },
      {
        id: otherRun, owner_id: owner, conversation_id: id, status: 'completed', goal: 'Run the tool', lease_token: randomUUID(),
        created_at: createdAt, updated_at: '2026-11-25T12:03:00.000Z', lease_expires_at: createdAt,
        state: JSON.stringify({ trail: [{ action: 'computer_view' }] }),
      },
      {
        id: followupRun, owner_id: owner, conversation_id: id, status: 'completed', goal: 'اختصر الجواب', lease_token: randomUUID(),
        created_at: '2026-11-25T12:04:00.000Z', updated_at: '2026-11-25T12:06:00.000Z', lease_expires_at: createdAt,
        state: JSON.stringify({ trail: [{ action: 'shorten_previous_answer' }] }),
      },
    ]).execute();
    await database.db.insertInto('chat_messages').values([
      { id: randomUUID(), conversation_id: id, role: 'assistant', text: 'نص الملاحظة', created_at: '2026-11-25T12:01:00.000Z', run_id: memoryRun },
      { id: randomUUID(), conversation_id: id, role: 'assistant', text: 'نص مختصر', created_at: '2026-11-25T12:05:00.000Z', run_id: followupRun },
    ]).execute();
    const result = await createConversationShareStorage(database.db).ownedSnapshot(owner, id);
    expect([...result!.provenance.entries()]).toEqual([[0, ['memory']], [1, ['memory']]]);
  });

  it('fails closed for older runs without state and for recorded prompts with unknown inputs', async () => {
    const id = await conversation('محادثة قديمة');
    const noState = randomUUID();
    const modelRun = randomUUID();
    await database.db.insertInto('chat_runs').values([
      {
        id: noState, owner_id: owner, conversation_id: id, status: 'completed', goal: 'أجب', lease_token: randomUUID(),
        created_at: createdAt, updated_at: '2026-11-25T12:02:00.000Z', lease_expires_at: createdAt,
      },
      {
        id: modelRun, owner_id: owner, conversation_id: id, status: 'completed', goal: 'Answer', lease_token: randomUUID(),
        created_at: '2026-11-25T12:03:00.000Z', updated_at: '2026-11-25T12:04:00.000Z', lease_expires_at: createdAt,
        state: JSON.stringify({ trail: [] }),
      },
    ]).execute();
    await database.db.insertInto('chat_model_receipts').values({
      id: randomUUID(), run_id: modelRun, step: 1, model: 'fixture', status: 'succeeded',
    }).execute();
    await database.db.insertInto('chat_messages').values([
      { id: randomUUID(), conversation_id: id, role: 'assistant', text: 'نص قديم', created_at: '2026-11-25T12:01:00.000Z' },
      { id: randomUUID(), conversation_id: id, role: 'assistant', text: 'Old text', created_at: '2026-11-25T12:03:30.000Z' },
    ]).execute();
    const result = await createConversationShareStorage(database.db).ownedSnapshot(owner, id);
    expect([...result!.provenance.entries()]).toEqual([[0, ['tool-output']], [1, ['memory', 'tool-output']]]);
  });

  it('keeps query credentials available to the privacy check when a citation has balanced punctuation', async () => {
    const id = await conversation('المراجع');
    const url = 'https://example.test/wiki/page_(documentation)?access_token=fixture-only';
    await database.db.insertInto('chat_messages').values({
      id: randomUUID(), conversation_id: id, role: 'assistant', created_at: createdAt,
      text: `**المصدر:** [التوثيق](${url}) · قُرئت 2026-11-25 12:00 UTC`,
    }).execute();
    const { snapshot } = (await createConversationShareStorage(database.db).ownedSnapshot(owner, id))!;
    expect(snapshot.messages[0]?.sources).toEqual([{ title: 'التوثيق', url }]);
    const checked = scanConversationPrivacy(snapshot);
    expect(checked.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'token-url', location: 'message' }),
      expect.objectContaining({ kind: 'token-url', location: 'source' }),
    ]));
    expect(JSON.stringify(checked.snapshot)).not.toContain('fixture-only');
  });

  it('records the run on assistant messages written by the chat controller', async () => {
    const browser = {
      setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; }, async close() {},
    } as unknown as AgentBrowser;
    const control = await createCommandChatControl(database.db, {
      browser, models: { fast: [], deep: [], vision: '' }, recordExperiences: false,
    });
    try {
      const { id } = await control.create(owner, { goal: 'السلام عليكم' });
      await control.settled(id);
      const run = await database.db.selectFrom('chat_runs').select('id').where('conversation_id', '=', id).executeTakeFirstOrThrow();
      const written = await database.db.selectFrom('chat_messages').select('run_id').where('conversation_id', '=', id)
        .where('role', '=', 'assistant').executeTakeFirstOrThrow();
      expect(written.run_id).toBe(run.id);
      const loaded = await createConversationShareStorage(database.db).ownedSnapshot(owner, id);
      expect(loaded?.provenance.size).toBe(0);
    } finally {
      await control.shutdown();
    }
  });

  it('carries private source provenance into an explanation of the previous reply', async () => {
    const id = await conversation('نتيجة قراءة خاصة');
    const priorRun = randomUUID();
    const url = 'https://workspace.example.test/internal-report';
    const answeredAt = '2026-11-25T12:01:00.000Z';
    await database.db.insertInto('chat_runs').values({
      id: priorRun, owner_id: owner, conversation_id: id, status: 'completed', goal: 'Read my report', lease_token: randomUUID(),
      created_at: createdAt, updated_at: answeredAt, lease_expires_at: createdAt,
      state: JSON.stringify({ handsFound: { url }, trail: [{ action: 'browser_observe' }] }),
    }).execute();
    await database.db.insertInto('chat_messages').values({
      id: randomUUID(), conversation_id: id, role: 'assistant', run_id: priorRun, created_at: answeredAt,
      text: `قرأت التقرير.\n\n**المصدر:** [التقرير](${url})`,
    }).execute();
    const browser = { setCheckpointStore() {}, async close() {} } as unknown as AgentBrowser;
    const control = await createCommandChatControl(database.db, { browser, models: { fast: [], deep: [], vision: '' }, recordExperiences: false });
    try {
      await control.send(owner, id, { text: 'كيف حصلت على الإجابة السابقة؟' });
      await control.settled(id);
      expect((await control.detail(owner, id)).messages.at(-1)?.text).toContain(url);
      const { snapshot, provenance, quotes } = (await createConversationShareStorage(database.db).ownedSnapshot(owner, id))!;
      expect(snapshot.messages.at(-1)?.sources.map(source => source.url)).toContain(url);
      const checked = scanConversationPrivacy(snapshot, provenance, quotes);
      expect(checked.findings).toContainEqual(expect.objectContaining({ messageIndex: snapshot.messages.length - 1, kind: 'tool-output' }));
      expect(JSON.stringify(checked.snapshot)).not.toContain(url);
    } finally {
      await control.shutdown();
    }
  });

  it('stores only the 128-bit credential hash and keeps the public snapshot independent of chat edits and deletion', async () => {
    const id = await conversation('قبل التعديل');
    const store = createConversationShareStorage(database.db, () => Date.parse(createdAt));
    const { snapshot } = (await store.ownedSnapshot(owner, id))!;
    const { share, token } = await store.createShare(owner, id, snapshot, 'never', 'owner');
    expect(Buffer.from(token, 'base64url')).toHaveLength(16);
    const row = await database.db.selectFrom('conversation_shares').selectAll().where('id', '=', share.id).executeTakeFirstOrThrow();
    expect(row.token_hash).toBe(createHash('sha256').update(token, 'utf8').digest('hex'));
    expect(JSON.stringify(row).includes(token)).toBe(false);
    await database.db.updateTable('chat_conversations').set({ title: 'بعد التعديل' }).where('id', '=', id).execute();
    await database.db.deleteFrom('chat_conversations').where('id', '=', id).execute();
    expect(await store.lookupShare(token)).toEqual({ snapshot, sharedAt: createdAt });
    expect(await store.lookupShare(share.id)).toBeNull();
    expect(await store.revokeShare('another-account', share.id)).toBe(false);
    expect(await store.revokeShare(owner, share.id)).toBe(true);
    expect(await store.lookupShare(token)).toBeNull();
  });

  it.each([
    ['1d', '2026-11-26T12:00:00.000Z'],
    ['7d', '2026-12-02T12:00:00.000Z'],
    ['30d', '2026-12-25T12:00:00.000Z'],
  ] as const)('expires %s at its exact cutoff in the list and on lookup', async (expiry, expiresAt) => {
    let clock = Date.parse(createdAt);
    const store = createConversationShareStorage(database.db, () => clock);
    const id = await conversation('المدة');
    const { snapshot } = (await store.ownedSnapshot(owner, id))!;
    const { share, token } = await store.createShare(owner, id, snapshot, expiry, 'owner');
    expect(share.expiresAt).toBe(expiresAt);
    clock = Date.parse(expiresAt) - 1;
    expect(await store.lookupShare(token)).toEqual({ snapshot, sharedAt: createdAt });
    expect((await store.listShares(owner)).some(item => item.id === share.id)).toBe(true);
    clock += 1;
    expect(await store.lookupShare(token)).toBeNull();
    expect((await store.listShares(owner)).some(item => item.id === share.id)).toBe(false);
  });
});
