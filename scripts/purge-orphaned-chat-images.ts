import { access } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import dotenv from 'dotenv';
import { createDatabase, sql } from '@mohassan/database';

const usage = 'Usage: npm exec -- tsx scripts/purge-orphaned-chat-images.ts [--database-dir PATH] [--confirm]';
const metadata = ['id', 'owner_id', 'bytes', 'created_at'] as const;
const orphaned = sql<boolean>`conversation_id IS NULL AND expires_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM chat_messages m
    WHERE m.images @> jsonb_build_array(jsonb_build_object('id', chat_images.id))
  )`;

async function main() {
  const { values } = parseArgs({ options: {
    confirm: { type: 'boolean' },
    'database-dir': { type: 'string' },
    help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log(usage);
    console.log('Uses DATABASE_URL or an existing PGlite directory. Lists orphaned image metadata by default. --confirm deletes the matching images.');
    return;
  }

  const dataDir = values['database-dir'];
  if (dataDir === undefined) dotenv.config({ quiet: true });
  const connectionString = dataDir === undefined && process.env.MOHASSAN_LOCAL_LAB !== '1'
    ? process.env.DATABASE_URL
    : undefined;
  if (dataDir !== undefined) await access(dataDir);
  if (!dataDir && !connectionString) {
    console.error('Configure DATABASE_URL or pass --database-dir for local PGlite.');
    process.exitCode = 1;
    return;
  }

  const database = await createDatabase({ connectionString, dataDir });
  try {
    const images = values.confirm
      ? await database.db.deleteFrom('chat_images').where(orphaned).returning(metadata).execute()
      : await database.db.selectFrom('chat_images').select(metadata).where(orphaned).orderBy('id').execute();
    console.log(JSON.stringify({ mode: values.confirm ? 'deleted' : 'preview', count: images.length, images }));
  } finally {
    await database.close();
  }
}

try {
  await main();
} catch {
  console.error('Orphaned chat image cleanup failed. Check the arguments, database target and chat schema.');
  console.error(usage);
  process.exitCode = 1;
}
