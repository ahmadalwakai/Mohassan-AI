import { randomUUID } from 'node:crypto';
import type { createAuth } from '../../apps/server/src/auth.js';
import type { DatabaseHandle } from '@mohassan/database';
import { startIsolatedE2E } from './isolation.js';

export const pagingOwner = {
  name: 'مالك سجل المحادثات',
  email: 'conversation-paging@example.test',
  password: 'Isolated-Paging-Password-42',
};
export const oldestTitle = 'إِدَارَةٌ قَدِيمَة';
export const oldestMessage = 'رسالة من أقدم محادثة في السجل.';
export const newestTitle = 'محادثة تجريبية 60';

export async function seedConversationPaging(db: DatabaseHandle['db'], auth: ReturnType<typeof createAuth>) {
  const { createOwner } = await import('../../apps/server/src/auth.js');
  const owner = await createOwner(db, auth, pagingOwner);
  const oldestId = randomUUID();
  const rows = Array.from({ length: 61 }, (_, index) => {
    const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index));
    return {
      id: index === 0 ? oldestId : randomUUID(),
      owner_id: owner.id,
      title: index === 0 ? oldestTitle : `محادثة تجريبية ${index}`,
      status: 'idle',
      created_at: timestamp,
      updated_at: timestamp,
    };
  });
  await db.transaction().execute(async tx => {
    await tx.insertInto('chat_conversations').values(rows).execute();
    await tx.insertInto('chat_messages').values({
      id: randomUUID(), conversation_id: oldestId, role: 'user', text: oldestMessage, created_at: rows[0]!.created_at,
    }).execute();
  });
}

export default async function setup() {
  const fixture = await startIsolatedE2E({ localBrain: true, conversationPaging: true });
  return fixture.stop;
}
