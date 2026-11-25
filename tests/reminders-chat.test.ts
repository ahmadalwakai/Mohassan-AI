import { sql } from 'kysely';
import { ChatConversationSchema } from '@mohassan/contracts';
import { createDatabase, migrate } from '@mohassan/database';
import type { AgentBrowser } from '@mohassan/browser';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAuth, migrateAuth } from '../apps/server/src/auth.js';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import { migrateMembers } from '../apps/server/src/members.js';
import { registerReminderChat } from '../apps/server/src/reminders/chat-turn.js';
import { migrateReminders } from '../apps/server/src/reminders/migration.js';
import { createReminderStore } from '../apps/server/src/reminders/storage.js';

const timeZone = 'Asia/Riyadh';
// SI hour and minute definitions. https://www.bipm.org/en/publications/si-brochure (retrieved 2026-11-25).
const hour = 60 * 60 * 1000;

let database: Awaited<ReturnType<typeof createDatabase>>;
let auth: ReturnType<typeof createAuth>;
let store: ReturnType<typeof createReminderStore>;
let chat: Awaited<ReturnType<typeof createCommandChatControl>>;
const external = vi.fn(async () => { throw new Error('A reminder must use local storage.'); });

beforeAll(async () => {
  database = await createDatabase();
  await migrateAuth(database.db);
  await migrateMembers(database.db);
  await migrate(database.db);
  auth = createAuth(database.db, { secret: 'fixture-reminders-chat-secret-value', webOrigin: 'http://localhost:3000', production: false });
  store = createReminderStore(database.db);
  chat = await createCommandChatControl(database.db, {
    fullAccess: async () => false,
    browser: { setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; }, async close() {} } as unknown as AgentBrowser,
    models: { fast: [], deep: [], vision: '' }, fetch: external,
  });
  await migrateReminders(database.db);
  registerReminderChat(database.db, store);
});

afterAll(async () => { await chat?.shutdown(); await database?.close(); });

async function member(name: string) {
  const { user } = await auth.api.signUpEmail({ body: { name, email: `${name}@example.test`, password: 'Fixture-reminder-password-13' } });
  await database.db.insertInto('workspace_members').values({ user_id: user.id, role: 'member' }).execute();
  return user.id;
}

async function settled(userId: string, id: string) {
  await chat.settled(id);
  const detail = ChatConversationSchema.parse(await chat.detail(userId, id));
  expect(detail.error).toBeNull();
  expect(detail.approval).toBeNull();
  expect(external).not.toHaveBeenCalled();
  return { ...detail, reply: detail.messages.at(-1)?.text };
}

async function start(userId: string, goal: string) {
  return settled(userId, (await chat.create(userId, { goal })).id);
}

async function send(userId: string, id: string, text: string, questionId?: string) {
  await chat.send(userId, id, { text, ...(questionId ? { questionId } : {}) });
  return settled(userId, id);
}

describe('reminder commands through real chat runs', () => {
  it('asks for and remembers the time zone, creates without approval, lists and cancels in Arabic', async () => {
    const user = await member('meeting');
    const initial = await start(user, 'ذكرني غدًا الساعة 9 مساءً بالاجتماع');
    expect(initial.status).toBe('waiting_user');
    expect(initial.question?.prompt).toContain('IANA');
    expect(await store.list(user)).toEqual([]);
    const saved = await send(user, initial.id, timeZone, initial.question?.id);
    expect(saved.status).toBe('idle');
    expect(saved.reply).toMatch(/الاجتماع.*Asia\/Riyadh/u);
    expect(saved.reply).toContain('للإلغاء');
    const [reminder] = await store.list(user);
    expect(reminder).toMatchObject({ text: 'الاجتماع', conversationId: initial.id, timeZone, recurrence: null });
    const hourOfDay = new Intl.DateTimeFormat('en', { hour: 'numeric', hourCycle: 'h23', timeZone }).format(new Date(reminder!.dueAt));
    expect(hourOfDay).toBe('21');
    expect(await store.getTimeZone(user)).toBe(timeZone);
    expect((await send(user, initial.id, 'ما تذكيراتي؟')).reply).toContain('الاجتماع');
    expect((await send(user, initial.id, 'ألغِ تذكير الاجتماع')).reply).toContain('تم إلغاء');
    expect(await store.list(user)).toEqual([]);
    expect((await send(user, initial.id, 'ما تذكيراتي؟')).reply).toContain('ليس لديك');
    const later = await start(user, 'remind me in 2 hours to call Sami');
    expect(later.question).toBeNull();
    expect(later.reply).toContain('call Sami');
    const run = await database.db.selectFrom('chat_runs').select('created_at').where('conversation_id', '=', later.id).executeTakeFirstOrThrow();
    expect((await store.list(user))[0]?.dueAt).toBe(new Date(new Date(run.created_at).getTime() + 2 * hour).toISOString());
  });

  it('asks one AM/PM question, keeps the subject, then postpones and edits by chat', async () => {
    const user = await member('ambiguous');
    await store.setTimeZone(user, timeZone);
    const initial = await start(user, 'Remind me tomorrow at 9 to call Sami');
    expect(initial.status).toBe('waiting_user');
    expect(initial.question?.prompt).toBe('Do you mean AM or PM?');
    expect(await store.list(user)).toEqual([]);
    const saved = await send(user, initial.id, 'pm', initial.question?.id);
    expect(saved.question).toBeNull();
    expect(saved.reply).toContain('call Sami');
    const [original] = await store.list(user);
    const delayed = await send(user, initial.id, 'أجّله ساعة');
    expect(delayed.reply).toContain('تم تأجيل');
    const [postponed] = await store.list(user);
    expect(new Date(postponed!.dueAt).getTime()).toBe(new Date(original!.dueAt).getTime() + hour);
    const edit = await send(user, initial.id, 'Edit reminder call Sami to in 3 days');
    expect(edit.reply).toContain('Reminder updated');
    const [edited] = await store.list(user);
    expect(edited!.id).toBe(original!.id);
    expect(Date.parse(edited!.dueAt)).toBeGreaterThan(Date.parse(postponed!.dueAt));
  });

  it('asks which matching reminder to cancel and accepts an Arabic-Indic selection', async () => {
    const user = await member('matches');
    await store.setTimeZone(user, timeZone);
    const { id } = await start(user, 'ذكرني بعد ساعتين باجتماع الفريق');
    await send(user, id, 'ذكرني بعد 3 ساعات باجتماع اللجنة');
    const before = await store.list(user);
    expect(before).toHaveLength(2);
    const question = await send(user, id, 'ألغِ تذكير اجتماع');
    expect(question.status).toBe('waiting_user');
    expect(question.question?.prompt).toContain('الفريق');
    expect(question.question?.prompt).toContain('اللجنة');
    expect(await store.list(user)).toHaveLength(2);
    const cancelled = await send(user, id, '٢', question.question?.id);
    expect(cancelled.reply).toContain('اللجنة');
    expect((await store.list(user)).map(item => item.id)).toEqual([before[0]!.id]);
  });

  it('lists each page of ambiguous matches and only accepts a visible choice', async () => {
    const user = await member('pages');
    await store.setTimeZone(user, timeZone);
    const initial = await start(user, 'Remind me every Monday at 9am to review project Alpha');
    expect(initial.reply).toContain('weekly');
    for (const name of ['Beta', 'Gamma', 'Delta', 'Epsilon']) {
      await send(user, initial.id, `Remind me every Monday at 9am to review project ${name}`);
    }
    const first = await send(user, initial.id, 'Cancel reminder review project');
    expect(first.question?.prompt).toContain('next');
    expect(first.question?.prompt).not.toContain('\n5.');
    const retry = await send(user, initial.id, '5', first.question?.id);
    expect(retry.status).toBe('waiting_user');
    expect(await store.list(user)).toHaveLength(5);
    const second = await send(user, initial.id, 'next', retry.question?.id);
    const fifth = (await store.list(user))[4]!;
    expect(second.question?.prompt).toContain(`5. ${fifth.text}`);
    const cancelled = await send(user, initial.id, '5', second.question?.id);
    expect(cancelled.reply).toContain(fifth.text);
    expect((await store.list(user)).some(({ id }) => id === fifth.id)).toBe(false);
  });

  it('handles capability questions and keeps the full subject from the accepted run attempt', async () => {
    const user = await member('subject');
    await store.setTimeZone(user, timeZone);
    expect((await start(user, 'Do you support reminders?')).reply).toContain('capability is configured');
    const initial = await start(user, 'ذكرني شهريًا يوم 25 الساعة 14:30');
    expect(initial.question?.prompt).toContain('بماذا');
    expect(await store.list(user)).toEqual([]);
    const subject = `${'مراجعة محضر اجتماع الفريق '.repeat(22)}واعتماد النسخة النهائية`;
    const saved = await send(user, initial.id, subject, initial.question?.id);
    expect(saved.reply).toContain('شهريًا في اليوم 25');
    expect((await store.list(user))[0]?.text).toBe(subject);
    expect(saved.run?.verdict?.status).toBe('completed');
  });

  it('rolls back the reminder when publishing the confirmation fails', async () => {
    const user = await member('publication');
    await store.setTimeZone(user, timeZone);
    await sql`ALTER TABLE chat_messages ADD CONSTRAINT reminders_test_publication
      CHECK (role <> 'assistant' OR text NOT LIKE '%unique publication fixture%')`.execute(database.db);
    try {
      const { id } = await chat.create(user, { goal: 'Remind me in 2 hours to review the unique publication fixture' });
      await chat.settled(id);
      const detail = await chat.detail(user, id);
      expect(detail.status).toBe('failed');
      expect(detail.messages.map(message => message.role)).toEqual(['user']);
      expect(await store.list(user)).toEqual([]);
    } finally {
      await sql`ALTER TABLE chat_messages DROP CONSTRAINT reminders_test_publication`.execute(database.db);
    }
  });

  it('requests a replacement for a time that already passed and leaves compound requests untouched', async () => {
    const user = await member('past');
    await store.setTimeZone(user, timeZone);
    // Midnight at the start of today cannot be in the future in the user's zone.
    const initial = await start(user, 'Remind me today at 00:00 to submit the form');
    expect(initial.question?.prompt).toContain('has passed');
    const saved = await send(user, initial.id, 'tomorrow at 10:00 am', initial.question?.id);
    expect(saved.reply).toContain('submit the form');
    const compound = await send(user, initial.id, 'Remind me in 2 hours to call Sami, then open the calendar');
    expect(compound.reply).toContain('separate message');
    expect((await store.list(user)).map(item => item.text)).toEqual(['submit the form']);
  });
});
