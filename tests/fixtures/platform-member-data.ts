import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';

// Fixtures use the source schemas for the three features (retrieved 2026-11-25).
// https://github.com/ahmadalwakai/Mohassan-AI/blob/ae8b33121f312fce5a75e32fb7a21ac64946d7b6/packages/database/src/notifications-migration.ts
// https://github.com/ahmadalwakai/Mohassan-AI/blob/bccfe23ed5cf74157bcdd354d4f308da694d55a6/apps/server/src/reminders/migration.ts
// https://github.com/ahmadalwakai/Mohassan-AI/blob/4e6d5bacb60a9437aaceecee45e3f62c6db95662/apps/server/src/conversation-share-migration.ts
export async function addPlatformMemberData(db: Kysely<any>, userId: string, conversationId: string) {
  const now = new Date();
  const dueAt = new Date(now);
  dueAt.setUTCHours(dueAt.getUTCHours() + 1);
  const previousDueAt = new Date(dueAt);
  previousDueAt.setUTCDate(previousDueAt.getUTCDate() - 1);
  const reminderId = randomUUID(), deliveryKey = randomUUID();
  const sentDeliveryKey = randomUUID(), tabId = randomUUID();
  const taskId = randomUUID(), pushId = randomUUID(), shareId = randomUUID();
  const token = randomBytes(16).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const endpoint = `https://push.example.test/${randomUUID()}`;
  const keys = { p256dh: randomBytes(32).toString('base64url'), auth: randomBytes(16).toString('base64url') };
  const text = `Reminder fixture for ${userId}`;
  const title = `Share fixture for ${userId}`;
  await db.transaction().execute(async tx => {
    await tx.insertInto('notification_preferences').values({ user_id: userId, hide_title: true }).execute();
    await tx.insertInto('push_subscriptions').values({ id: pushId, user_id: userId, endpoint, ...keys, label: 'Fixture' }).execute();
    await tx.insertInto('notification_tabs').values({ user_id: userId, tab_id: tabId, visible: false, expires_at: now }).execute();
    await tx.insertInto('chat_notifications').values({
      task_id: taskId, user_id: userId, conversation_id: conversationId, kind: 'task_completed', started_at: now,
      happened_at: now, available_at: now, delivery: 'push',
    }).execute();
    await tx.insertInto('reminder_preferences').values({ user_id: userId, time_zone: 'UTC' }).execute();
    await tx.insertInto('reminders').values({
      id: reminderId, user_id: userId, conversation_id: conversationId, text, due_at: dueAt, time_zone: 'UTC',
      recurrence: JSON.stringify({ kind: 'daily', hour: dueAt.getUTCHours(), minute: dueAt.getUTCMinutes() }),
      delivery_key: deliveryKey,
    }).execute();
    await tx.insertInto('reminder_deliveries').values({
      delivery_key: sentDeliveryKey, reminder_id: reminderId, user_id: userId, conversation_id: conversationId,
      text, due_at: previousDueAt, time_zone: 'UTC', delivered_at: previousDueAt, late: false,
    }).execute();
    await tx.insertInto('conversation_shares').values({
      id: shareId, sharer_id: userId, conversation_id: conversationId, token_hash: tokenHash, shared_at: now,
      snapshot: JSON.stringify({ title, createdAt: now.toISOString(), messages: [] }),
    }).execute();
  });
  return {
    token, dueAt, deliveryKey, pushId, taskId, shareId,
    secrets: [token, tokenHash, endpoint, ...Object.values(keys)],
    exportedRows: {
      notification_preferences: { user_id: userId, hide_title: true },
      push_subscriptions: { user_id: userId, id: pushId },
      notification_tabs: { user_id: userId, tab_id: tabId },
      chat_notifications: { user_id: userId, task_id: taskId },
      reminder_preferences: { user_id: userId, time_zone: 'UTC' },
      reminders: { user_id: userId, id: reminderId, text },
      reminder_deliveries: { user_id: userId, delivery_key: sentDeliveryKey, text },
      conversation_shares: { sharer_id: userId, id: shareId, snapshot: { title } },
    },
  };
}
