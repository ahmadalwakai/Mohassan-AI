import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, migrate } from '@mohassan/database';
import { expect, it } from 'vitest';
import { loadReplyPreferences, resolveReplyTurn } from '../apps/server/src/assistant/reply-preferences.js';
import { commandChatMigration } from '../apps/server/src/command-chat.js';

it('keeps explicit preferences across turns and reopening, with scoped overrides and removals', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mohassan-reply-preferences-'));
  const ownerId = 'reply-owner';
  const conversationId = 'reply-conversation';
  const secondConversation = 'reply-other-conversation';
  let database: Awaited<ReturnType<typeof createDatabase>> | undefined;
  try {
    database = await createDatabase({ dataDir });
    const { db } = database;
    await migrate(db);
    await db.insertInto('chat_conversations').values([
      { id: conversationId, owner_id: ownerId, title: 'Existing chat' },
      { id: secondConversation, owner_id: ownerId, title: 'Another chat' },
    ]).execute();
    await commandChatMigration(db);
    expect(await loadReplyPreferences(db, ownerId, conversationId)).toEqual({});

    const turn = (text: string) => db.transaction().execute(tx => resolveReplyTurn(tx, ownerId, conversationId, text));
    await turn('أجب بالعربية دائماً');
    await turn('من الآن إجابات مختصرة');
    for (let index = 0; index < 10; index++) {
      expect((await turn(`What is ${index} + 1?`)).constraints).toEqual({ lang: 'ar', brief: true });
    }
    expect((await turn('What is rain? In English.')).constraints).toEqual({ lang: 'en', brief: true });
    expect(await loadReplyPreferences(db, ownerId, conversationId)).toEqual({ lang: 'ar', brief: true });
    expect((await resolveReplyTurn(db, ownerId, secondConversation, 'What is rain?')).constraints).toEqual({});
    expect(await loadReplyPreferences(db, 'foreign-account', conversationId)).toEqual({});
    await resolveReplyTurn(db, 'foreign-account', conversationId, 'Always answer in English');
    expect(await loadReplyPreferences(db, ownerId, conversationId)).toEqual({ lang: 'ar', brief: true });

    await database.close();
    database = await createDatabase({ dataDir });
    const reopened = database.db;
    await commandChatMigration(reopened);
    expect(await reopened.selectFrom('schema_migrations').select('version').where('version', '=', '060_reply_preferences').execute())
      .toEqual([{ version: '060_reply_preferences' }]);
    expect((await resolveReplyTurn(reopened, ownerId, conversationId, 'What is rain?')).constraints).toEqual({ lang: 'ar', brief: true });

    await expect(reopened.transaction().execute(async tx => {
      await resolveReplyTurn(tx, ownerId, conversationId, 'Always answer in English');
      throw new Error('Rejected turn');
    })).rejects.toThrow('Rejected turn');
    expect(await loadReplyPreferences(reopened, ownerId, conversationId)).toEqual({ lang: 'ar', brief: true });

    await resolveReplyTurn(reopened, ownerId, conversationId, 'Always answer in English');
    await resolveReplyTurn(reopened, ownerId, conversationId, 'لا داعي للاختصار بعد الآن');
    expect(await loadReplyPreferences(reopened, ownerId, conversationId)).toEqual({ lang: 'en' });
    expect((await resolveReplyTurn(reopened, ownerId, conversationId, 'What is rain?')).constraints).toEqual({ lang: 'en' });
  } finally {
    await database?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}, 30_000);
