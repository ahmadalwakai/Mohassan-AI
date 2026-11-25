import { randomUUID } from 'node:crypto';
import { ChatConversationSchema, MonitorAlertFeedbackStateSchema, MonitorListSchema } from '@mohassan/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApplication } from '../apps/server/src/app.js';
import { monitorChat } from '../apps/server/src/monitors/chat.js';
import { monitorTiming } from '../apps/server/src/monitors/schedule.js';
import { recordBackgroundRunOutcome } from '../apps/server/src/notifications-store.js';

const origin = 'http://127.0.0.1:3000';
const internalSecret = 'monitor-feedback-test-internal-secret';
const setupToken = 'monitor-feedback-test-setup-token';
const monitors = '/api/chat/monitors';
const conversations = '/api/chat/conversations';
type Session = { id: string; cookie: string };

describe('authenticated monitor alert feedback', () => {
  let application: Awaited<ReturnType<typeof createApplication>>;
  let owner: Session;
  let member: Session;

  const request = (method: 'GET' | 'POST', url: string, session?: Session, payload?: object) => application.app.inject({
    method, url, headers: { origin, 'x-mohassan-internal': internalSecret, ...(session && { cookie: session.cookie }) },
    ...(payload && { payload }),
  });
  const feedback = (id: string, session: Session | undefined, payload: object) =>
    request('POST', `${monitors}/alerts/${id}/feedback`, session, payload);

  async function signIn(role: 'owner' | 'member'): Promise<Session> {
    const credentials = { name: `Feedback ${role}`, email: `feedback-${role}@example.test`, password: 'Feedback-fixture-password-19' };
    if (role === 'owner') {
      const setup = await request('POST', '/api/setup', undefined, { ...credentials, setupToken });
      expect(setup.statusCode, setup.body).toBe(200);
    } else {
      const { user } = await application.auth.api.signUpEmail({ body: credentials });
      await application.database.db.insertInto('workspace_members').values({ user_id: user.id, role }).execute();
    }
    const response = await request('POST', '/api/auth/sign-in/email', undefined, credentials);
    expect(response.statusCode, response.body).toBe(200);
    const cookie = [response.headers['set-cookie']].flat().filter(Boolean).map(value => String(value).split(';')[0]).join('; ');
    const access = (await request('GET', '/api/access', { id: '', cookie })).json();
    expect(access.role).toBe(role);
    return { id: access.user.id, cookie };
  }

  async function deliverMonitorAlert(session: Session) {
    const db = application.database.db;
    const control = monitorChat(db)!;
    await control.runtime.runOnce();
    const conversation = await request('POST', conversations, session, {});
    expect(conversation.statusCode, conversation.body).toBe(200);
    const { id: conversationId } = ChatConversationSchema.parse(conversation.json());
    const runId = randomUUID();
    const at = new Date();
    await db.insertInto('chat_runs').values({
      id: runId, owner_id: session.id, conversation_id: conversationId, status: 'completed', goal: 'Offline fixture job',
      lease_token: randomUUID(), lease_expires_at: at, created_at: at, updated_at: at,
    }).execute();
    const monitor = await control.store.propose(session.id, {
      conversationId,
      spec: { source: { kind: 'run', runId }, read: { kind: 'status' }, condition: { kind: 'equals', value: 'completed' },
        language: 'en', title: 'Job completion', message: 'The job was completed.', timing: monitorTiming('run', 'urgent', { now: at }) },
      observation: { value: 'running', excerpt: 'Running', observedAt: at.toISOString() },
    });
    const approved = await request('POST', monitors, session, { proposalId: monitor.id });
    expect(approved.statusCode, approved.body).toBe(200);
    await db.updateTable('smart_monitors').set({ next_check_at: at }).where('id', '=', monitor.id).execute();
    await control.runtime.runOnce();
    const alert = await db.selectFrom('chat_notifications').select(['task_id', 'happened_at'])
      .where('monitor_id', '=', monitor.id).executeTakeFirstOrThrow();
    return { alertId: alert.task_id as string, happenedAt: new Date(alert.happened_at).toISOString(), conversationId, monitorId: monitor.id, runId, at };
  }

  beforeAll(async () => {
    vi.stubEnv('MOHASSAN_MONITORS_ENABLED', '1');
    application = await createApplication({
      authSecret: 'monitor-feedback-test-authentication', internalSecret, setupToken, webOrigin: origin, production: false, runWorker: false,
    });
    owner = await signIn('owner');
    member = await signIn('member');
  });

  afterAll(async () => {
    await application?.app.close();
    vi.unstubAllEnvs();
  });

  it('requires a session, binds the alert to its account and rejects ordinary background results', async () => {
    const { alertId, conversationId, runId, at } = await deliverMonitorAlert(member);
    const db = application.database.db;
    await recordBackgroundRunOutcome(db, { runId, userId: member.id, conversationId, startedAt: at,
      outcome: 'completed', language: 'en' }, at);
    const input = { rating: 'helpful' };
    expect((await feedback(alertId, undefined, input)).statusCode).toBe(401);
    for (const response of [await feedback(alertId, owner, input), await feedback(runId, member, input)]) {
      expect(response.statusCode, response.body).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'MONITOR_ALERT_NOT_FOUND' } });
    }
    expect((await feedback(alertId, member, { rating: 'helpful', reason: 'late' })).statusCode).toBe(400);
    expect((await feedback(alertId, member, { rating: 'not_helpful', reason: 'free text' })).statusCode).toBe(400);
    expect(await db.selectFrom('monitor_alert_feedback').select('alert_id').where('alert_id', 'in', [alertId, runId]).execute()).toEqual([]);
    expect((await feedback(alertId, member, input)).statusCode).toBe(200);
    expect((await feedback(alertId, owner, { rating: 'not_helpful' })).statusCode).toBe(404);
    expect(await db.selectFrom('monitor_alert_feedback').select(['user_id', 'rating']).where('alert_id', '=', alertId).execute())
      .toEqual([{ user_id: member.id, rating: 'helpful' }]);
  });

  it('updates the same response and projects it onto the alert message and monitor card', async () => {
    const { alertId, happenedAt, conversationId, monitorId } = await deliverMonitorAlert(owner);
    const db = application.database.db;
    const detail = async () => ChatConversationSchema.parse((await request('GET', `${conversations}/${conversationId}`, owner)).json());
    const initial = await detail();
    expect(initial.messages).toContainEqual(expect.objectContaining({ id: alertId, role: 'assistant' }));
    expect(initial.monitorAlerts).toEqual([{ id: alertId, happenedAt }]);
    expect(initial.monitors?.find(monitor => monitor.id === monitorId)?.alerts).toEqual([{ id: alertId, happenedAt }]);

    for (const input of [{ rating: 'helpful' }, { rating: 'not_helpful' }, { rating: 'not_helpful', reason: 'late' }, { rating: 'not_helpful', reason: 'wrong_value' }]) {
      const response = await feedback(alertId, owner, input);
      expect(response.statusCode, response.body).toBe(200);
      const saved = MonitorAlertFeedbackStateSchema.parse(response.json());
      expect(saved).toEqual({ ...input, updatedAt: expect.any(String) });
      const alert = { id: alertId, happenedAt, feedback: saved };
      const conversation = await detail();
      expect(conversation.monitorAlerts).toEqual([alert]);
      expect(conversation.monitors?.find(monitor => monitor.id === monitorId)?.alerts).toEqual([alert]);
      const list = MonitorListSchema.parse((await request('GET', `${monitors}?conversationId=${conversationId}`, owner)).json());
      expect(list.monitors.find(monitor => monitor.id === monitorId)?.alerts).toEqual([alert]);
    }
    expect(await db.selectFrom('monitor_alert_feedback').select(['user_id', 'alert_id', 'rating', 'reason']).where('alert_id', '=', alertId).execute())
      .toEqual([{ user_id: owner.id, alert_id: alertId, rating: 'not_helpful', reason: 'wrong_value' }]);
  });
});
