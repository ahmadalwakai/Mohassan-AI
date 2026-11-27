import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { expect, it } from 'vitest';
import { createDatabase, migrate } from '@mohassan/database';
import { migrateAuth } from '../apps/server/src/auth.js';
import { commandChatMigration } from '../apps/server/src/command-chat.js';

const script = fileURLToPath(new URL('../scripts/purge-orphaned-chat-images.ts', import.meta.url));
const run = promisify(execFile);

it('lists orphaned images and deletes only those images on explicit confirmation', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mohassan-orphaned-chat-images-'));
  try {
    const createdAt = new Date(0);
    const image = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#ffffff' } })
      .png().toBuffer({ resolveWithObject: true });
    const stored = {
      content_hash: createHash('sha256').update(image.data).digest('hex'),
      mime_type: 'image/png', width: image.info.width, height: image.info.height,
      bytes: image.data.byteLength, data_base64: image.data.toString('base64'), created_at: createdAt,
    };
    const database = await createDatabase({ dataDir });
    try {
      await migrateAuth(database.db);
      await migrate(database.db);
      await commandChatMigration(database.db);
      await database.db.insertInto('chat_conversations').values([
        { id: 'removed-conversation', owner_id: 'first-owner', title: 'Removed' },
        { id: 'live-conversation', owner_id: 'second-owner', title: 'Live' },
      ]).execute();
      await database.db.insertInto('chat_images').values([
        { ...stored, id: 'orphaned-a', owner_id: 'first-owner', conversation_id: 'removed-conversation', expires_at: null },
        { ...stored, id: 'orphaned-b', owner_id: 'second-owner', conversation_id: null, expires_at: null },
        { ...stored, id: 'attached', owner_id: 'second-owner', conversation_id: 'live-conversation', expires_at: null },
        { ...stored, id: 'expired', owner_id: 'third-owner', conversation_id: null, expires_at: createdAt },
        { ...stored, id: 'unattached', owner_id: 'third-owner', conversation_id: null, expires_at: new Date(Date.now() + 60_000) },
      ]).execute();
      await database.db.deleteFrom('chat_conversations').where('id', '=', 'removed-conversation').execute();
    } finally {
      await database.close();
    }

    const command = (...args: string[]) => run(process.execPath, ['--import', 'tsx', script, '--database-dir', dataDir, ...args]);
    const preview = await command();
    const listed = [
      { id: 'orphaned-a', owner_id: 'first-owner', bytes: stored.bytes, created_at: createdAt.toISOString() },
      { id: 'orphaned-b', owner_id: 'second-owner', bytes: stored.bytes, created_at: createdAt.toISOString() },
    ];
    expect(JSON.parse(preview.stdout)).toEqual({ mode: 'preview', count: listed.length, images: listed });
    await expect(command('--confirm=false')).rejects.toMatchObject({ code: 1 });

    const confirmed = await command('--confirm');
    expect(JSON.parse(confirmed.stdout)).toEqual({ mode: 'deleted', count: listed.length, images: expect.arrayContaining(listed) });
    const after = await createDatabase({ dataDir });
    try {
      const remaining = await after.db.selectFrom('chat_images').select('id').orderBy('id').execute();
      expect(remaining.map(row => row.id)).toEqual(['attached', 'expired', 'unattached']);
    } finally {
      await after.close();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
