import { randomUUID } from 'node:crypto';
import {
  ReminderDueListSchema,
  ReminderListSchema,
  ReminderMutationResultSchema,
  type ReminderSummary,
} from '@mohassan/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApplication } from '../apps/server/src/app.ts';
import { createReminderScheduler } from '../apps/server/src/reminders/scheduler.ts';

const base = '/api/reminders';
const origin = 'http://127.0.0.1:3000';
const internalSecret = 'reminder-route-fixture-internal-value';
const setupToken = 'reminder-route-fixture-setup-token';
const headers = (cookie = '') => ({ origin, 'x-mohassan-internal': internalSecret, ...(cookie ? { cookie } : {}) });

type Fixture = { id: string; cookie: string; conversationId: string; reminder: ReminderSummary };
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

// London follows the EU rule: the last Sunday in March and October at 01:00 UTC.
// https://data.iana.org/time-zones/tzdb/europe (retrieved 2026-11-25).
function londonTransition(year: number, month: number) {
  const lastDay = new Date(Date.UTC(year, month, 0));
  return String(lastDay.getUTCDate() - lastDay.getUTCDay()).padStart(2, '0');
}

describe('authenticated reminder API', () => {
  let application: Awaited<ReturnType<typeof createApplication>> | undefined;
  let owner: Fixture;
  let sara: Fixture;
  let sami: Fixture;
  const tomorrow = new Date();
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const timeZone = 'Asia/Riyadh';

  const send = (method: Method, url: string, actor?: Fixture, payload?: object) =>
    application!.app.inject({ method, url, headers: headers(actor?.cookie), ...(payload ? { payload } : {}) });

  beforeAll(async () => {
    application = await createApplication({
      authSecret: 'reminder-route-fixture-authentication-value',
      internalSecret,
      setupToken,
      webOrigin: origin,
      production: false,
      runWorker: false,
    });
    const app = application.app;
    const db = application.database.db;

    async function account(name: string, role: 'owner' | 'member') {
      const credentials = { name, email: `${name.toLowerCase()}@example.test`, password: 'Fixture-password-only-84' };
      if (role === 'owner') {
        const setup = await app.inject({ method: 'POST', url: '/api/setup', headers: headers(), payload: { ...credentials, setupToken } });
        expect(setup.statusCode).toBe(200);
      } else {
        const session = await application!.auth.api.signUpEmail({ body: credentials });
        await db.insertInto('workspace_members').values({ user_id: session.user.id, role }).execute();
      }
      const { id } = await db.selectFrom('user').select('id').where('email', '=', credentials.email).executeTakeFirstOrThrow();
      const { statusCode, headers: responseHeaders } = await app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        headers: headers(),
        payload: { email: credentials.email, password: credentials.password },
      });
      expect(statusCode).toBe(200);
      const cookie = [responseHeaders['set-cookie']].flat().filter(Boolean)
        .map(value => String(value).split(';')[0]).join('; ');
      const conversationId = randomUUID();
      await db.insertInto('chat_conversations').values({ id: conversationId, owner_id: id, title: name, status: 'idle' }).execute();
      const created = await app.inject({
        method: 'POST',
        url: base,
        headers: headers(cookie),
        payload: { conversationId, text: `${name}'s reminder`, timeZone, dueAt: tomorrow.toISOString() },
      });
      expect(created.statusCode, created.body).toBe(201);
      return { id, cookie, conversationId, reminder: ReminderMutationResultSchema.parse(created.json()).reminder };
    }

    owner = await account('Owner', 'owner');
    sara = await account('Sara', 'member');
    sami = await account('Sami', 'member');
  });

  afterAll(async () => { await application?.app.close(); });

  it('requires a session on every route', async () => {
    const item = `${base}/${sara.reminder.id}`;
    for (const [method, path, payload] of [
      ['GET', base],
      ['GET', `${base}/due`],
      ['POST', base, { conversationId: sara.conversationId, text: 'Unauthenticated', dueAt: tomorrow.toISOString(), timeZone }],
      ['PATCH', item, { text: 'Unauthenticated' }],
      ['DELETE', item],
    ] as const) {
      expect((await send(method, path, undefined, payload)).statusCode).toBe(401);
    }
  });

  it('lists only the signed-in account’s reminders and rejects a user override', async () => {
    for (const actor of [owner, sara, sami]) {
      const response = await send('GET', base, actor);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(ReminderListSchema.parse(response.json()).reminders).toEqual([actor.reminder]);
    }
    expect((await send('GET', `${base}?userId=${sami.id}`, sara)).statusCode).toBe(400);
  });

  it('allows member creation only in their own conversation and validates input', async () => {
    const payload = { text: 'Cross-account attempt', dueAt: tomorrow.toISOString(), timeZone };
    for (const foreign of [owner, sami]) {
      const response = await send('POST', base, sara, { ...payload, conversationId: foreign.conversationId });
      expect(response.statusCode).toBe(404);
    }
    expect((await send('POST', base, sara, { ...payload, conversationId: sara.conversationId, userId: sami.id })).statusCode).toBe(400);
    expect((await send('POST', base, sara, { ...payload, conversationId: sara.conversationId, timeZone: '+03:00' })).statusCode).toBe(400);
    expect((await send('POST', base, sara, {
      ...payload,
      conversationId: sara.conversationId,
      recurrence: { kind: 'weekly', weekdays: [1, 1], hour: 12, minute: 0 },
    })).statusCode).toBe(400);
  });

  it('allows only the reminder owner to edit or cancel and handles stale edits', async () => {
    for (const foreign of [owner, sami]) {
      const item = `${base}/${foreign.reminder.id}`;
      expect((await send('PATCH', item, sara, { text: 'Cross-account edit' })).statusCode).toBe(404);
      expect((await send('DELETE', item, sara)).statusCode).toBe(404);
      expect(ReminderListSchema.parse((await send('GET', base, foreign)).json()).reminders).toEqual([foreign.reminder]);
    }

    const item = `${base}/${sara.reminder.id}`;
    expect((await send('PATCH', item, sara, { conversationId: sami.conversationId })).statusCode).toBe(400);
    const expected = { dueAt: sara.reminder.dueAt, updatedAt: sara.reminder.updatedAt };
    const nextDue = new Date(tomorrow);
    nextDue.setUTCDate(nextDue.getUTCDate() + 1);
    const edited = await send('PATCH', item, sara, { text: 'Edited', dueAt: nextDue.toISOString(), expected });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(ReminderMutationResultSchema.parse(edited.json()).reminder).toMatchObject({ id: sara.reminder.id, text: 'Edited', dueAt: nextDue.toISOString() });
    expect((await send('PATCH', item, sara, { text: 'Stale edit', expected })).statusCode).toBe(409);
    const cancelled = await send('DELETE', item, sara);
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(ReminderMutationResultSchema.parse(cancelled.json()).reminder.status).toBe('cancelled');
    expect(ReminderListSchema.parse((await send('GET', base, sara)).json()).reminders).toEqual([]);
  });

  it('requires an explicit choice for repeated wall times and rejects a spring gap', async () => {
    const item = `${base}/${sami.reminder.id}`;
    const year = tomorrow.getUTCFullYear() + 1;
    const london = { timeZone: 'Europe/London' };
    const fallDate = `${year}-10-${londonTransition(year, 10)}`;
    const springDate = `${year}-03-${londonTransition(year, 3)}`;
    const spring = await send('PATCH', item, sami, { ...london, localDueAt: `${springDate}T01:30` });
    expect(spring.statusCode, spring.body).toBe(400);
    expect(spring.json().error.code).toBe('REMINDER_TIME_GAP');
    const fall = await send('PATCH', item, sami, { ...london, localDueAt: `${fallDate}T01:30` });
    expect(fall.statusCode, fall.body).toBe(400);
    expect(fall.json().error.code).toBe('REMINDER_TIME_AMBIGUOUS');
    for (const [overlap, utcHour] of [['earlier', '00'], ['later', '01']] as const) {
      const chosen = await send('PATCH', item, sami, { ...london, localDueAt: `${fallDate}T01:30`, overlap });
      expect(chosen.statusCode, chosen.body).toBe(200);
      expect(ReminderMutationResultSchema.parse(chosen.json()).reminder.dueAt).toBe(`${fallDate}T${utcHour}:30:00.000Z`);
    }
  });

  it('exposes only the signed-in account’s delivered reminders for polling', async () => {
    const dueAt = new Date();
    dueAt.setUTCMinutes(dueAt.getUTCMinutes() + 10);
    const actors = [owner, sara, sami];
    const ids = [];
    for (const actor of actors) {
      const created = await send('POST', base, actor, {
        conversationId: actor.conversationId,
        text: actor.reminder.text,
        dueAt: dueAt.toISOString(),
        timeZone,
      });
      expect(created.statusCode, created.body).toBe(201);
      ids.push(ReminderMutationResultSchema.parse(created.json()).reminder.id);
    }

    const scheduler = createReminderScheduler(application!.database.db, { now: () => dueAt });
    await scheduler.runOnce();

    for (const [index, actor] of actors.entries()) {
      const response = await send('GET', `${base}/due`, actor);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      const { deliveries } = ReminderDueListSchema.parse(response.json());
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]).toMatchObject({ reminderId: ids[index], conversationId: actor.conversationId, text: actor.reminder.text });
    }
    expect((await send('GET', `${base}/due?userId=${sami.id}`, sara)).statusCode).toBe(400);
  });
});
