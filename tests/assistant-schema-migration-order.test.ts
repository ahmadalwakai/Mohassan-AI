import { createDatabase, migrate } from '@mohassan/database';
import { memoryMigration } from '@mohassan/memory';
import { expect, it } from 'vitest';
import { migrateStructuredMemory } from '../apps/server/src/assistant/structured-memory-migration.js';
import { migrateAuth } from '../apps/server/src/auth.js';

it('records the reviewer and structured memory migrations under distinct numbers on repeat startup', async () => {
  const { db, close } = await createDatabase();
  try {
    await migrateAuth(db);
    for (let startup = 0; startup < 2; startup++) {
      await migrate(db);
      await memoryMigration(db);
      await migrateStructuredMemory(db);

      const versions = await db.selectFrom('schema_migrations').select('version')
        .where('version', 'in', ['035_chat_conversation_review', '035_structured_memory', '036_structured_memory'])
        .orderBy('version').execute();
      expect(versions).toEqual([
        { version: '035_chat_conversation_review' },
        { version: '036_structured_memory' },
      ]);
    }

    expect(await db.selectFrom('chat_conversations').select('review_summary').execute()).toEqual([]);
    expect(await db.selectFrom('memory_structured_versions').select('item_id').execute()).toEqual([]);
    expect(await db.selectFrom('memory_structured_operations').select('run_id').execute()).toEqual([]);
  } finally {
    await close();
  }
}, 20000);

it('keeps data when adopting the standalone structured memory migration', async () => {
  const { db, close } = await createDatabase();
  try {
    await migrateAuth(db);
    await migrate(db);
    await memoryMigration(db);
    await migrateStructuredMemory(db);

    // The standalone migration installed the same schema and recorded it under 035.
    await db.updateTable('schema_migrations').set({ version: '035_structured_memory' })
      .where('version', '=', '036_structured_memory').execute();
    await db.insertInto('user').values({ id: 'owner', name: 'Owner', email: 'owner@example.invalid' }).execute();
    await db.insertInto('memory_structured_operations').values({
      owner_id: 'owner', run_id: 'old-run', conversation_id: 'old-chat', intent_hash: 'a'.repeat(64), outcome: 'unchanged',
    }).execute();

    await migrateStructuredMemory(db);

    const versions = await db.selectFrom('schema_migrations').select('version')
      .where('version', 'in', ['035_chat_conversation_review', '035_structured_memory', '036_structured_memory'])
      .orderBy('version').execute();
    expect(versions).toEqual([
      { version: '035_chat_conversation_review' },
      { version: '036_structured_memory' },
    ]);
    expect(await db.selectFrom('memory_structured_operations').select(['run_id', 'outcome']).execute()).toEqual([
      { run_id: 'old-run', outcome: 'unchanged' },
    ]);
  } finally {
    await close();
  }
}, 20000);
