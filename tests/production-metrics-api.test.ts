import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ConversationSharePreview, CreatedConversationShare, ModelCouncil, ProductionMetricsResponse } from '@mohassan/contracts';
import { afterEach, expect, it, vi } from 'vitest';
import { createApplication } from '../apps/server/src/app.js';
import { commandChatMigration } from '../apps/server/src/command-chat.js';
import { monitorTiming } from '../apps/server/src/monitors/schedule.js';
import { createMonitorStore } from '../apps/server/src/monitors/store.js';
import { recordBackgroundRunOutcome } from '../apps/server/src/notifications-store.js';
import { MEMBER_ROUTES } from '../apps/server/src/members.js';
import { productionMetricsSettings } from '../apps/server/src/ops/metrics/index.js';

const origin = 'http://127.0.0.1:3000';
const internalSecret = 'metrics-test-internal-fixture-00000000';
const setupToken = 'metrics-test-setup-fixture-00000000';
const owner = { name: 'Metrics fixture owner', email: 'metrics-owner@example.test', password: 'Metrics-Test-Owner-FortyTwo' };
const member = { name: 'Metrics fixture member', email: 'metrics-member@example.test', password: 'Metrics-Test-Member-FortyTwo' };

async function fixture(enabled: boolean) {
  const directory = await mkdtemp(join(tmpdir(), 'mohassan-metrics-api-'));
  const snapshots = join(directory, 'snapshots');
  vi.stubEnv('PRODUCTION_METRICS_ENABLED', String(enabled));
  vi.stubEnv('PRODUCTION_METRICS_DIR', snapshots);

  let application: Awaited<ReturnType<typeof createApplication>> | undefined;
  async function dispose() {
    try { await application?.app.close(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
  try {
    application = await createApplication({
      authSecret: 'metrics-test-auth-fixture-00000000000', internalSecret, setupToken, webOrigin: origin,
      production: false, runWorker: false, codingDataDir: join(directory, 'coding'),
    });
    const { app } = application;
    const headers = (cookie?: string) => ({ origin, 'x-mohassan-internal': internalSecret, ...(cookie ? { cookie } : {}) });
    async function login(credentials: typeof owner) {
      const response = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: headers(),
        payload: { email: credentials.email, password: credentials.password } });
      expect(response.statusCode).toBe(200);
      const cookies = [response.headers['set-cookie']].flat().filter(Boolean).map(value => String(value).split(';')[0]);
      expect(cookies.length).toBeGreaterThan(0);
      return headers(cookies.join('; '));
    }
    const setup = await app.inject({ method: 'POST', url: '/api/setup', headers: headers(), payload: { ...owner, setupToken } });
    expect(setup.statusCode).toBe(200);
    const ownerHeaders = await login(owner);
    return { app, db: application.database.db, dispose, snapshots, headers, ownerHeaders, login };
  } catch (error) {
    await dispose();
    throw error;
  }
}

afterEach(() => vi.unstubAllEnvs());

it('keeps JSON and CSV owner-only and records request and chat data without private fields', async () => {
  const f = await fixture(true);
  try {
    const { app, ownerHeaders } = f;
    const first = await app.inject({ url: '/api/ops/metrics', headers: ownerHeaders });
    expect(first.statusCode).toBe(200);
    expect(first.json<ProductionMetricsResponse>()).toMatchObject({ enabled: true, snapshotAvailable: true,
      windows: { hour: { roles: { owner: { routes: [] }, member: { routes: [] } } } } });

    const invitation = await app.inject({ method: 'POST', url: '/api/members/invites', headers: ownerHeaders,
      payload: { name: member.name, email: member.email } });
    expect(invitation.statusCode).toBe(200);
    const token = new URL(invitation.json<{ url: string }>().url).hash.replace('#invite=', '');
    const accepted = await app.inject({ method: 'POST', url: '/api/invites/accept', headers: f.headers(),
      payload: { token, name: member.name, password: member.password } });
    expect(accepted.statusCode).toBe(200);
    const memberHeaders = await f.login(member);
    for (const url of ['/api/ops/metrics', '/api/ops/metrics.csv']) {
      expect(MEMBER_ROUTES.has(`GET ${url}`)).toBe(false);
      expect((await app.inject({ url, headers: memberHeaders })).statusCode).toBe(403);
      expect((await app.inject({ url, headers: f.headers() })).statusCode).toBe(401);
      expect((await app.inject({ url })).statusCode).toBe(401);
    }
    const access = await app.inject({ url: '/api/access', headers: memberHeaders });
    expect(access.statusCode).toBe(200);
    const memberId = access.json<{ user: { id: string } }>().user.id;
    const uuid = randomUUID();
    expect((await app.inject({ url: `/api/tasks/${uuid}`, headers: memberHeaders })).statusCode).toBe(403);
    expect((await app.inject({ url: `/api/tasks/${uuid}`, headers: ownerHeaders })).statusCode).toBe(404);
    expect((await app.inject({ url: `/api/notifications/events/${uuid}`, headers: memberHeaders })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/reminders/${uuid}`, headers: memberHeaders })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/member-data/sessions', headers: memberHeaders })).statusCode).toBe(200);

    const created = await app.inject({ method: 'POST', url: '/api/chat/conversations', headers: ownerHeaders, payload: {} });
    expect(created.statusCode).toBe(200);
    const conversationId = created.json<{ id: string }>().id;
    const shareUrl = `/api/chat/conversations/${conversationId}/share`;
    const preview = await app.inject({ method: 'POST', url: `${shareUrl}/preview`, headers: ownerHeaders, payload: {} });
    expect(preview.statusCode).toBe(200);
    const review = preview.json<ConversationSharePreview>().review;
    const published = await app.inject({ method: 'POST', url: shareUrl, headers: ownerHeaders,
      payload: { expiry: '1d', redact: true, review } });
    expect(published.statusCode).toBe(201);
    const { share, url } = published.json<CreatedConversationShare>();
    const shareToken = new URL(url).pathname.split('/').at(-1)!;
    const publicUrl = `/api/chat/conversation-shares/public/${shareToken}`;
    for (const viewer of [f.headers(), ownerHeaders, memberHeaders]) {
      expect((await app.inject({ url: publicUrl, headers: viewer })).statusCode).toBe(200);
    }
    const revoked = await app.inject({ method: 'DELETE', url: `/api/chat/conversation-shares/${share.id}`, headers: ownerHeaders });
    expect(revoked.statusCode).toBe(200);
    const query = 'fixture_private_query_47621', message = 'احسب 4351 + 869';
    const email = 'do-not-store-metrics@example.test', ip = '203.0.113.81';
    const submitted = await app.inject({ method: 'POST', url: `/api/chat/conversations/${conversationId}/messages?${query}=hidden`,
      remoteAddress: ip, headers: { ...ownerHeaders, 'x-metrics-private-fixture': email }, payload: { text: message } });
    expect(submitted.statusCode).toBe(200);
    const visibility = await f.db.selectFrom('chat_events').select(['run_id', 'data']).where('conversation_id', '=', conversationId)
      .where('kind', '=', 'visibility').executeTakeFirstOrThrow();
    expect(visibility.data).toMatchObject({ firstProgressAtMs: expect.any(Number) });

    let measured = first;
    for (let attempt = 0; attempt < 50; attempt++) {
      measured = await app.inject({ url: '/api/ops/metrics', headers: ownerHeaders });
      const report = measured.json<ProductionMetricsResponse>();
      if (report.chatAvailable && report.windows.hour.roles.owner.chat.finalAnswer.samples > 0) break;
      await delay(500);
    }
    const report = measured.json<ProductionMetricsResponse>();
    expect(report.chatAvailable).toBe(true);
    const hour = report.windows.hour;
    expect(hour.roles.owner.chat).toMatchObject({ runs: 1, firstProgress: { samples: 1 }, finalAnswer: { samples: 1 },
      paths: { local_computation: 1 } });
    expect(Object.values(hour.roles.owner.chat.phases).some(phase => phase.samples > 0)).toBe(true);
    expect(hour.roles.owner.routes).toEqual(expect.arrayContaining([
      expect.objectContaining({ route: 'POST /api/chat/conversations/:id/messages', count: 1, latency: expect.objectContaining({ samples: 1 }) }),
      expect.objectContaining({ route: 'GET /api/tasks/:id', count: 1, statusClasses: expect.objectContaining({ '4xx': 1 }) }),
      expect.objectContaining({ route: 'POST /api/chat/conversations/:id/share/preview', count: 1 }),
      expect.objectContaining({ route: 'DELETE /api/chat/conversation-shares/:id', count: 1 }),
    ]));
    expect(hour.roles.member.routes).toEqual(expect.arrayContaining([
      expect.objectContaining({ route: 'GET /api/access', count: 1, statusClasses: expect.objectContaining({ '2xx': 1 }) }),
      expect.objectContaining({ route: 'GET /api/tasks/:id', count: 1, statusClasses: expect.objectContaining({ '4xx': 1 }) }),
      expect.objectContaining({ route: 'GET /api/notifications/events/:id', count: 1 }),
      expect.objectContaining({ route: 'DELETE /api/reminders/:id', count: 1 }),
      expect.objectContaining({ route: 'GET /api/member-data/sessions', count: 1 }),
    ]));
    const csv = await app.inject({ url: '/api/ops/metrics.csv', headers: ownerHeaders });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toBe('attachment; filename="production-metrics.csv"');
    expect(csv.body).toContain('owner,request,POST /api/chat/conversations/:id/messages,1,1');
    expect(csv.body).toContain('member,request,GET /api/access,1,1');
    expect(csv.body).toContain('owner,answer_path,local_computation,1');

    await app.close();
    const files = (await readdir(f.snapshots, { recursive: true })).filter(file => file.endsWith('.jsonl'));
    expect(files.length).toBeGreaterThan(0);
    const disk = (await Promise.all(files.map(file => readFile(join(f.snapshots, file), 'utf8')))).join('');
    expect(disk).toContain('/api/chat/conversations/:id/messages');
    for (const source of [measured.body, csv.body, disk]) {
      expect(source).not.toContain('/api/chat/conversation-shares/public/');
      for (const privateValue of [query, message, email, ip, uuid, conversationId, String(visibility.run_id), memberId,
        owner.email, member.email, token, shareToken, share.id, review]) {
        expect(source).not.toContain(privateValue);
      }
    }
  } finally {
    await f.dispose();
  }
}, 60_000);

it('turns off collection and disk writes with the environment flag', async () => {
  expect(productionMetricsSettings(true, {}).enabled).toBe(true);
  expect(productionMetricsSettings(false, {}).enabled).toBe(false);
  expect(productionMetricsSettings(true, { PRODUCTION_METRICS_ENABLED: 'false' }).enabled).toBe(false);
  expect(productionMetricsSettings(false, { PRODUCTION_METRICS_ENABLED: 'true' }).enabled).toBe(true);
  const stateDirectory = resolve('fixture-state');
  expect(productionMetricsSettings(true, { STATE_DIRECTORY: stateDirectory }).directory).toBe(join(stateDirectory, 'production-metrics'));
  expect(productionMetricsSettings(true, { STATE_DIRECTORY: stateDirectory, PRODUCTION_METRICS_DIR: 'custom-metrics' }).directory).toBe(resolve('custom-metrics'));
  const f = await fixture(false);
  try {
    expect((await f.app.inject({ url: '/api/access', headers: f.ownerHeaders })).statusCode).toBe(200);
    const created = await f.app.inject({ method: 'POST', url: '/api/chat/conversations', headers: f.ownerHeaders,
      payload: { goal: 'احسب 23 + 49' } });
    expect(created.statusCode).toBe(200);
    const visibility = await f.db.selectFrom('chat_events').select('data')
      .where('conversation_id', '=', created.json<{ id: string }>().id).where('kind', '=', 'visibility').executeTakeFirstOrThrow();
    expect(visibility.data).not.toHaveProperty('firstProgressAtMs');
    const result = await f.app.inject({ url: '/api/ops/metrics', headers: f.ownerHeaders });
    expect(result.statusCode).toBe(200);
    expect(result.json<ProductionMetricsResponse>()).toMatchObject({ enabled: false, snapshotAvailable: false, chatAvailable: false,
      windows: { hour: { roles: { owner: { routes: [], chat: { runs: 0 } }, member: { routes: [] } } } } });
    await f.app.close();
    await expect(readdir(f.snapshots)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await f.dispose();
  }
}, 60_000);

it('reads council and reply feedback aggregates on request and exports them in CSV', async () => {
  vi.stubEnv('MOHASSAN_MODEL_COUNCIL', 'owner');
  vi.stubEnv('MOHASSAN_MODELS_ROOT', '');
  const f = await fixture(true);
  try {
    const { app, db, ownerHeaders } = f;
    const metricsURL = '/api/ops/metrics';
    const empty = await app.inject({ url: metricsURL, headers: ownerHeaders });
    expect(empty.statusCode).toBe(200);
    expect(empty.json<ProductionMetricsResponse>().windows.hour.roles.owner.chat.council?.turns).toBe(0);

    // Add the optional experiment column via the same schema hook, with no model worker.
    await commandChatMigration(db, undefined, true);
    const conversation = await app.inject({ method: 'POST', url: '/api/chat/conversations', headers: ownerHeaders, payload: {} });
    expect(conversation.statusCode).toBe(200);
    const conversationId = conversation.json<{ id: string }>().id;
    const privateText = 'unexported reply and member output';
    const createdAt = new Date(Date.now() - 1000);
    const councilRecord = (elapsedMs: number, chosen: 'pipeline' | 'chat-v5', outcome: 'ok' | 'timeout'): ModelCouncil => ({
      version: 1, elapsedMs, chosen, changed: chosen !== 'pipeline', reason: privateText,
      members: [
        { model: 'pipeline', label: 'Pipeline', round: 'answer', outcome: 'ok', elapsedMs: 0, chosen: chosen === 'pipeline' },
        { model: 'chat-v5', label: 'v5', round: 'answer', outcome, elapsedMs, chosen: chosen === 'chat-v5',
          ...(outcome === 'ok' && { output: privateText }) },
      ],
    });
    const changed = randomUUID(), standaloneV5 = randomUUID(), kept = randomUUID(), timedOut = randomUUID();
    await db.insertInto('chat_messages').values([
      { id: kept, council: JSON.stringify(councilRecord(100, 'pipeline', 'ok')), experiment: null },
      { id: timedOut, council: JSON.stringify(councilRecord(200, 'pipeline', 'timeout')), experiment: null },
      { id: changed, council: JSON.stringify(councilRecord(300, 'chat-v5', 'ok')), experiment: 'v5' },
      { id: standaloneV5, council: null, experiment: 'v5' },
    ].map(fields => ({ ...fields, conversation_id: conversationId, role: 'assistant', text: privateText, created_at: createdAt }))).execute();
    for (const [messageId, verdict] of [[changed, 'wrong'], [standaloneV5, 'useful'], [kept, 'incomplete']]) {
      const rated = await app.inject({ method: 'POST', url: `/api/chat/conversations/${conversationId}/feedback`,
        headers: ownerHeaders, payload: { messageId, verdict, note: privateText } });
      expect(rated.statusCode).toBe(200);
    }

    const result = await app.inject({ url: metricsURL, headers: ownerHeaders });
    expect(result.statusCode).toBe(200);
    for (const { roles } of Object.values(result.json<ProductionMetricsResponse>().windows)) {
      expect(roles.owner.chat.council).toEqual({
        turns: 3, changedReplies: 1, chosenByModel: { pipeline: 2, 'chat-v5': 1 },
        memberOutcomes: {
          pipeline: { ok: 3, abstained: 0, timeout: 0, failed: 0 },
          'chat-v5': { ok: 2, abstained: 0, timeout: 1, failed: 0 },
        },
        elapsedMs: { samples: 3, p50: 200, p90: 300, p99: 300 },
        v5: { attempted: 3, answered: 2, unusedAnswers: 1 },
      });
      expect(roles.owner.chat.feedback).toEqual({
        pipeline: { replies: 2, useful: 0, wrong: 0, incomplete: 1, unrated: 1 },
        v5: { replies: 1, useful: 1, wrong: 0, incomplete: 0, unrated: 0 },
        councilChanged: { replies: 1, useful: 0, wrong: 1, incomplete: 0, unrated: 0 },
      });
      expect(roles.member.chat).not.toHaveProperty('council');
    }

    const csv = await app.inject({ url: '/api/ops/metrics.csv', headers: ownerHeaders });
    expect(csv.statusCode).toBe(200);
    const [header, ...lines] = csv.body.trimEnd().split('\r\n');
    const columns = header!.split(',');
    const rows = lines.map(line => Object.fromEntries(line.split(',').map((value, index) => [columns[index], value])));
    const hour = rows.filter(row => row.window === 'hour');
    expect(hour).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'owner', section: 'model_council', name: 'summary', turns: '3', changed_replies: '1',
        samples: '3', p50_ms: '200', p90_ms: '300', p99_ms: '300', v5_attempted: '3', v5_answered: '2', v5_unused_answers: '1' }),
      expect.objectContaining({ role: 'owner', section: 'council_member', name: 'chat-v5', chosen_by_model: '1',
        ok: '2', abstained: '0', timeout: '1', failed: '0' }),
      expect.objectContaining({ role: 'owner', section: 'reply_feedback', name: 'councilChanged', replies: '1',
        useful: '0', wrong: '1', incomplete: '0', unrated: '0' }),
      expect.objectContaining({ role: 'member', section: 'reply_feedback', name: 'pipeline', replies: '0', unrated: '0' }),
    ]));
    for (const output of [result.body, csv.body]) {
      for (const forbidden of [conversationId, changed, standaloneV5, kept, timedOut, privateText]) expect(output).not.toContain(forbidden);
    }
  } finally {
    await f.dispose();
  }
}, 60_000);

it('reads each alert’s current feedback once and exports only aggregates for a completed trial window', async () => {
  const f = await fixture(true);
  try {
    const { db, app, ownerHeaders } = f;
    const ownerId = (await app.inject({ url: '/api/access', headers: ownerHeaders })).json<{ user: { id: string } }>().user.id;
    const conversationId = (await app.inject({ method: 'POST', url: '/api/chat/conversations',
      headers: ownerHeaders, payload: {} })).json<{ id: string }>().id;
    const hourMs = 3_600_000;
    const end = Math.floor(Date.now() / hourMs) * hourMs;
    const happenedAt = new Date(end - 1000);
    const privateText = 'unexported monitor evidence';
    const privateUrl = 'https://page.example.test/private-sample';
    const { id } = await createMonitorStore(db).propose(ownerId, {
      conversationId, observation: { excerpt: privateText, value: privateText, observedAt: happenedAt.toISOString() },
      spec: { source: { kind: 'page', url: privateUrl }, read: { kind: 'main' }, condition: { kind: 'change' },
        timing: monitorTiming('page', 'normal', { now: new Date() }), language: 'en', title: privateText, message: privateText },
    });
    const alert = randomUUID();
    for (const alertId of [alert, randomUUID()]) {
      await recordBackgroundRunOutcome(db, {
        runId: alertId, userId: ownerId, conversationId, startedAt: happenedAt, outcome: 'completed',
        language: 'en', preview: privateText, monitorId: id,
      }, happenedAt);
    }
    await db.insertInto('monitor_alert_feedback').values({ user_id: ownerId, alert_id: alert, rating: 'helpful' }).execute();
    await db.updateTable('monitor_alert_feedback').set({ rating: 'not_helpful', reason: 'wrong_value' })
      .where('alert_id', '=', alert).execute();
    const report = await app.inject({ url: '/api/ops/metrics', headers: ownerHeaders });
    expect(report.statusCode).toBe(200);
    expect(report.json<ProductionMetricsResponse>().completedMonitorWeek).toMatchObject({
      startMs: end - 168 * hourMs, endMs: end,
      monitors: { alerts: { total: 2, helpful: 0, notHelpful: 1, unrated: 1,
        reasons: { no_meaningful_change: 0, late: 0, wrong_value: 1 } } },
    });
    const csv = await app.inject({ url: '/api/ops/metrics.csv', headers: ownerHeaders });
    expect(csv.statusCode).toBe(200);
    expect(csv.body).toContain('monitor_alerts,notHelpful,1');
    expect(csv.body).toContain('monitor_feedback_reason,wrong_value,1');
    for (const output of [report.body, csv.body]) {
      for (const forbidden of [ownerId, conversationId, id, alert, privateText, privateUrl]) expect(output).not.toContain(forbidden);
    }
  } finally {
    await f.dispose();
  }
}, 60_000);
