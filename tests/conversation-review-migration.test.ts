import { createDatabase, ensureChatConversationsTable, migrate, sql } from '@mohassan/database';
import { describe, expect, it } from 'vitest';

const migrationVersion = '035_chat_conversation_review';

describe('central conversation review migration', () => {
  it('installs summary storage before command chat bootstrap and can run twice', async () => {
    const database = await createDatabase();
    try {
      await migrate(database.db);
      await ensureChatConversationsTable(database.db);
      await database.db.insertInto('chat_conversations').values({ id: 'chat', owner_id: 'owner', title: 'A chat' }).execute();
      await migrate(database.db);
      const row = await database.db.selectFrom('chat_conversations').select(['status', 'review_summary']).where('id', '=', 'chat').executeTakeFirstOrThrow();
      expect(row).toEqual({ status: 'idle', review_summary: null });
      const versions = await database.db.selectFrom('schema_migrations').select('version').where('version', '=', migrationVersion).execute();
      expect(versions).toEqual([{ version: migrationVersion }]);
    } finally {
      await database.close();
    }
  });

  it('leaves existing review summaries intact when the prior hook registered 035', async () => {
    const database = await createDatabase();
    try {
      await sql`CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`.execute(database.db);
      await ensureChatConversationsTable(database.db);
      await sql`ALTER TABLE chat_conversations ADD COLUMN review_summary jsonb`.execute(database.db);
      await database.db.insertInto('schema_migrations').values({ version: migrationVersion }).execute();
      await database.db.insertInto('chat_conversations').values({
        id: 'chat', owner_id: 'owner', title: 'Older chat', review_summary: JSON.stringify({ version: 1, messageCount: 24 }),
      }).execute();
      await migrate(database.db);
      const row = await database.db.selectFrom('chat_conversations').select('review_summary').where('id', '=', 'chat').executeTakeFirstOrThrow();
      expect(row.review_summary).toEqual({ version: 1, messageCount: 24 });
    } finally {
      await database.close();
    }
  });
});
