import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateVAPIDKeys } from 'web-push';
import { z } from 'zod';
import {
  AccountSessionsSchema, CancelMemberDeletionResultSchema,
  ChatBrowserActivitySchema, ChatConversationSchema, ConversationShareListSchema,
  ConversationSharePreviewSchema, ConversationShareSettingsSchema, CreatedConversationShareSchema,
  EndAccountSessionsResultSchema, MemberAuditPageSchema, MemberDeletionStatusSchema, ModelCouncilSchema,
  ModelListSchema, ModelRunResponseSchema, MonitorAlertFeedbackStateSchema, MonitorCardSchema, MonitorListSchema,
  MonitorManagementResultSchema, MonitorV2ControlSchema, PendingMemberDeletionsSchema, PhoneAuthErrorReplySchema,
  PhoneChatImageAvailabilityReplySchema, PhoneChatImageUploadReplySchema, PhoneChatListReplySchema, PhoneSessionReplySchema,
  PhoneSignOutReplySchema, PublicConversationShareSchema,
  ReminderDueListSchema, ReminderListSchema, ReminderMutationResultSchema,
} from '@mohassan/contracts';
import { BackgroundRunSchema } from '../packages/contracts/src/background-run.js';
import { createReminderScheduler } from '../apps/server/src/reminders/scheduler.js';
import { recordBackgroundRunOutcome } from '../apps/server/src/notifications-store.js';
import { V5_CHAT_LABEL, generateV5ChatReply, isV5ChatReady } from '../apps/server/src/v5-chat.js';
import { ModelRuntime } from '../packages/model-relations/src/runtime.js';
import { checkError, checkJson, openClientApiApp, type ClientApiAccount } from './support/client-api-app.js';
import { validateContract } from './support/client-api-contract.js';

vi.mock('../apps/server/src/v5-chat.js', async importOriginal => ({
  ...await importOriginal<typeof import('../apps/server/src/v5-chat.js')>(),
  generateV5ChatReply: vi.fn(), isV5ChatReady: vi.fn(),
}));

vi.mock('../apps/server/src/web-push.js', async importOriginal => ({
  ...await importOriginal<typeof import('../apps/server/src/web-push.js')>(),
  // Keep real registration, device lookup, and responses while delivering nothing remotely.
  sendWebPushNotification: vi.fn(async () => 'delivered'),
}));

const conversations = '/api/chat/conversations';
const reminders = '/api/reminders';
const monitors = '/api/chat/monitors';
const shares = '/api/chat/conversation-shares';
const ok = z.strictObject({ ok: z.literal(true) });
const fixtureReply = 'Silver light across the hills.';
// Workspace and admin wrappers follow the server declarations at 29448ae.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/app.ts (retrieved 2026-11-27)
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/members.ts (retrieved 2026-11-27)
const setup = z.strictObject({ needsSetup: z.boolean(), setupAvailable: z.boolean() });
const account = z.strictObject({ id: z.string(), name: z.string(), email: z.email() });
const members = z.strictObject({
  members: z.array(account.extend({ joinedAt: z.iso.datetime(), disabled: z.boolean(), runsToday: z.number().int() })),
  invites: z.array(account.extend({ createdAt: z.iso.datetime(), expiresAt: z.iso.datetime() })),
  dailyRuns: z.number().int(),
});
const search = vi.fn(async (query: string, _limit: number, signal?: AbortSignal) => {
  if (query === 'tidal power') {
    return new Promise<never>((_resolve, reject) => {
      if (signal?.aborted) reject(signal.reason);
      else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }
  // A synthetic result for the real search-monitor detector. It is never fetched.
  return [{ title: 'Public park permit', url: 'https://parks.example.org/permits/one', snippet: 'Published permit.' }];
});

describe('client wire contracts through the Fastify app', () => {
  let fixture: Awaited<ReturnType<typeof openClientApiApp>>;
  let directory: string;
  let initiallyNeedsSetup: boolean;
  let owner: ClientApiAccount;
  let member: ClientApiAccount;
  const send: Awaited<ReturnType<typeof openClientApiApp>>['send'] = (...args) => fixture.send(...args);

  async function conversation(actor: ClientApiAccount, goal?: string) {
    return checkJson(await send('POST', conversations, actor, goal === undefined ? {} : { goal }), 200, ChatConversationSchema);
  }

  async function settled(actor: ClientApiAccount, id: string) {
    await fixture.application.chat.settled(id);
    return checkJson(await send('GET', `${conversations}/${id}`, actor), 200, ChatConversationSchema);
  }

  async function typed(name: string, method: Parameters<typeof send>[0], url: string, actor: ClientApiAccount, body?: object) {
    const response = await send(method, url, actor, body);
    expect(response.statusCode, `${method} ${url}`).toBe(200);
    const json = response.json();
    validateContract(name, json);
    return json;
  }

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mohassan-contract-metrics-'));
    vi.stubEnv('PRODUCTION_METRICS_ENABLED', 'true');
    vi.stubEnv('PRODUCTION_METRICS_DIR', join(directory, 'snapshots'));
    vi.stubEnv('MOHASSAN_LONG_RUN_ENABLED', '1');
    vi.stubEnv('MOHASSAN_BACKGROUND_RESULTS_ENABLED', '1');
    vi.stubEnv('MOHASSAN_MONITORS_ENABLED', '1');
    vi.stubEnv('MOHASSAN_MONITORS_V2', '1');
    vi.stubEnv('MOHASSAN_MODEL_COUNCIL', 'owner');
    vi.stubEnv('MOHASSAN_MODELS_ROOT', directory);
    vi.stubEnv('MOHASSAN_OCR_MODEL_DIR', join(directory, 'no-image-model'));
    vi.stubEnv('MOHASSAN_MODEL_WORKER', '0');
    vi.stubEnv('APNS_KEY_ID', undefined);
    const vapid = generateVAPIDKeys();
    vi.stubEnv('WEB_PUSH_VAPID_PUBLIC_KEY', vapid.publicKey);
    vi.stubEnv('WEB_PUSH_VAPID_PRIVATE_KEY', vapid.privateKey);
    vi.stubEnv('WEB_PUSH_VAPID_SUBJECT', 'mailto:client-api@example.test');
    vi.mocked(isV5ChatReady).mockReturnValue(true);
    vi.mocked(generateV5ChatReply).mockResolvedValue(fixtureReply);
    // The council and models page receive deterministic runtime results. No model is loaded.
    vi.spyOn(ModelRuntime.prototype, 'run').mockImplementation(async id => id === 'refusal'
      ? { ok: true, elapsedMs: 0, output: { label: 'allow' } }
      : { ok: false, elapsedMs: 0, reason: 'absent' });
    fixture = await openClientApiApp({ v5Chat: 'owner', browser: { searchProvider: { name: 'fixture search', search } } });
    initiallyNeedsSetup = checkJson(await send('GET', '/api/setup'), 200, setup).needsSetup;
    owner = await fixture.setupOwner();
    member = await fixture.inviteMember(owner);
  });

  afterAll(async () => {
    try { await fixture?.close(); }
    finally {
      if (directory) await rm(directory, { recursive: true, force: true });
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  });

  it('sets up a workspace and verifies invite, identity, authentication, and error envelopes', async () => {
    expect(initiallyNeedsSetup).toBe(true);
    expect(checkJson(await send('GET', '/api/setup'), 200, setup).needsSetup).toBe(false);
    const access = z.object({
      user: z.object({ id: z.string(), name: z.string(), email: z.email() }),
      role: z.enum(['owner', 'member']), services: z.array(z.string()),
      quota: z.object({ dailyRuns: z.number().int(), used: z.number().int() }).optional(),
    });
    expect(checkJson(await send('GET', '/api/access', member), 200, access)).toMatchObject({ user: { id: member.id }, role: 'member' });
    expect(checkJson(await send('GET', '/api/access', owner), 200, access)).toMatchObject({ user: { id: owner.id }, role: 'owner' });
    const invitation = checkJson(await send('POST', '/api/members/invites', owner,
      { name: 'Unused invite', email: 'unused-invite@example.test' }), 200, z.object({ id: z.string(), url: z.url() }));
    const administration = checkJson(await send('GET', '/api/members', owner), 200, members);
    expect(administration.members).toEqual(expect.arrayContaining([expect.objectContaining({ id: member.id, disabled: false })]));
    expect(administration.invites).toEqual(expect.arrayContaining([expect.objectContaining({ id: invitation.id })]));
    checkJson(await send('POST', `/api/members/invites/${invitation.id}/revoke`, owner, {}), 200, ok);
    checkJson(await send('POST', `/api/members/${member.id}/access`, owner, { enabled: true }), 200, ok);
    const auth = z.object({ user: z.object({ id: z.string() }), session: z.object({ id: z.string() }) });
    const signedIn = await send('GET', '/api/auth/get-session', member);
    checkJson(signedIn, 200, PhoneSessionReplySchema);
    expect(checkJson(signedIn, 200, auth).user.id).toBe(member.id);
    expect(signedIn.json()).not.toHaveProperty('session.token');
    expect((await send('GET', '/api/auth/get-session')).json()).toBeNull();

    checkError(await send('GET', '/api/access'), 401, 'UNAUTHORIZED');
    checkError(await send('GET', '/api/members', member), 403, 'MEMBER_FORBIDDEN');
    checkJson(await send('POST', '/api/auth/sign-in/email', 'anonymous',
      { email: 'absent@example.test', password: 'Fixture-password-invalid' }), 401, PhoneAuthErrorReplySchema);
    const unknown = await send('GET', `${conversations}/${randomUUID()}`, member);
    checkError(unknown, 404, 'CHAT_NOT_FOUND');
    checkError(await send('POST', '/api/members/invites', owner, { name: member.name, email: member.email }), 409, 'MEMBER_EXISTS');
    let limiter;
    for (let attempt = 0; attempt <= 10; attempt++) {
      limiter = await send('POST', '/api/invites/inspect', 'anonymous', { token: randomBytes(32).toString('base64url') });
      if (limiter.statusCode === 429) break;
      checkError(limiter, 404, 'INVITE_INVALID');
    }
    checkError(limiter!, 429);

    const disposable = await fixture.signIn(member);
    expect(checkJson(await send('POST', '/api/auth/sign-out', disposable, {}), 200, PhoneSignOutReplySchema).success).toBe(true);
    expect((await send('GET', '/api/auth/get-session', disposable)).json()).toBeNull();
  });

  it('validates the real owner v5 reply, council record, chat polling, and models routes', async () => {
    const created = await conversation(owner, 'Write a poem about a silver moon.');
    const detail = await settled(owner, created.id);
    expect(detail.messages.at(-1)).toMatchObject({ role: 'assistant', experiment: 'v5', text: `${fixtureReply}\n\n${V5_CHAT_LABEL}` });
    expect(ModelCouncilSchema.parse(detail.messages.at(-1)?.council).chosen).toBe('chat-v5');

    const memberChat = await conversation(member, 'Write a poem about a silver moon.');
    expect((await settled(member, memberChat.id)).messages.at(-1)).not.toHaveProperty('council');
    expect(checkJson(await send('GET', conversations, owner), 200, PhoneChatListReplySchema).conversations)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: created.id })]));

    const models = checkJson(await send('GET', '/api/models', owner), 200, ModelListSchema);
    expect(models.council).toBe(true);
    expect(models.models.length).toBeGreaterThan(0);
    const result = await send('POST', '/api/models/refusal/run', owner, { text: 'What is the time?' });
    expect(checkJson(result, 200, ModelRunResponseSchema).ok).toBe(true);
    checkError(await send('POST', '/api/models/execution/run', owner, { text: 'Fixture' }), 409, 'MODEL_NOT_RUNNABLE');
    checkError(await send('GET', '/api/models', member), 403, 'MEMBER_FORBIDDEN');
  });

  it('validates chat messages, feedback, image bytes, and stale interaction errors', async () => {
    const created = await conversation(owner);
    const path = `${conversations}/${created.id}`;
    const idempotency = { 'idempotency-key': 'client-contract-chat-message' };
    const message = { text: 'Hello' };
    checkJson(await send('POST', `${path}/messages`, owner, message, idempotency), 200, ChatConversationSchema);
    const detail = await settled(owner, created.id);
    const received = await send('GET', `${path}?since=${detail.version}&wait=1`, owner);
    expect(checkJson(received, 200, ChatConversationSchema).version).toBe(detail.version);
    checkError(await send('POST', `${path}/messages`, owner, { text: 'Different request' }, idempotency), 409, 'CHAT_REQUEST_KEY_REUSED');
    const reply = detail.messages.at(-1);
    expect(reply?.role).toBe('assistant');
    checkJson(await send('POST', `${path}/feedback`, owner, { messageId: reply?.id, verdict: 'useful' }), 200, ChatConversationSchema);
    checkError(await send('POST', `${path}/respond`, owner, { questionId: randomUUID(), optionId: 'stop' }), 409, 'CHAT_QUESTION_CHANGED');
    checkError(await send('POST', `${path}/approve`, owner, { approvalId: randomUUID(), approved: false }), 409, 'CHAT_APPROVAL_CHANGED');
    checkError(await send('POST', `${path}/secure`, owner, { requestId: randomUUID(), action: 'skip' }), 409, 'CHAT_SECURE_CHANGED');
    checkError(await send('GET', `${path}/screen`, owner), 404, 'CHAT_SCREEN_MISSING');
    expect(checkJson(await send('GET', `${path}/browser/activity`, owner), 200, ChatBrowserActivitySchema.nullable())).toBeNull();
    checkError(await send('POST', `${path}/browser/pointer`, owner, { x: 0.5, y: 0.5 }), 409, 'AGENT_NO_PAGE');
    checkError(await send('POST', `${path}/browser/keyboard`, owner, { key: 'Enter' }), 409, 'AGENT_NO_PAGE');
    checkError(await send('POST', `${path}/browser/restore`, owner, {}), 409, 'CHAT_CHECKPOINT_MISSING');
    checkError(await send('POST', `${path}/browser/review`, owner, { reviewed: true, checkpointToken: '0'.repeat(64) }),
      409, 'CHAT_CHECKPOINT_MISSING');
    checkJson(await send('DELETE', path, owner), 200, ok);

    checkJson(await send('GET', '/api/chat/images', owner), 200, PhoneChatImageAvailabilityReplySchema);
    const png = PNG.sync.write(new PNG({ width: 16, height: 16, fill: true }));
    const image = checkJson(await send('POST', '/api/chat/images', owner,
      { mimeType: 'image/png', data: png.toString('base64') }), 200, PhoneChatImageUploadReplySchema);
    const downloaded = await send('GET', image.url, owner);
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.headers['content-type']).toMatch(/^image\/png/u);
    expect(downloaded.rawPayload.byteLength).toBe(image.bytes);
    const decoded = PNG.sync.read(downloaded.rawPayload);
    expect([decoded.width, decoded.height]).toEqual([image.width, image.height]);
  });

  it('returns and cancels a background run and exposes push registration and notification result contracts', async () => {
    const run = await conversation(member, 'Research tidal power in the background.');
    expect(BackgroundRunSchema.parse(run.backgroundRun).task).toContain('tidal power');
    const stopped = checkJson(await send('POST', `${conversations}/${run.id}/cancel`, member, {}), 200, ChatConversationSchema);
    expect(stopped.backgroundRun).toBeUndefined();

    const iosRegistration = { platform: 'ios', token: randomBytes(32).toString('hex'), environment: 'sandbox', appVersion: '1.0' };
    let response = await send('POST', '/api/push/devices', member, iosRegistration);
    expect([response.statusCode, response.body]).toEqual([204, '']);
    checkError(await send('POST', '/api/push/devices', owner, iosRegistration), 409, 'PUSH_DEVICE_IN_USE');
    response = await send('DELETE', `/api/push/devices/${iosRegistration.token}`, member);
    expect([response.statusCode, response.body]).toEqual([204, '']);

    const base = '/api/notifications';
    await typed('NotificationSettingsResponse', 'GET', `${base}/settings`, member);
    await typed('NotificationSettingsResponse', 'POST', `${base}/settings`, member,
      { quietHours: null, hideTitle: false, completionSound: true, showResultPreview: true });
    const subscribe = await typed('PushSubscribeResponse', 'POST', `${base}/subscribe`, member, {
      endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`, label: 'Fixture browser',
      keys: { auth: randomBytes(16).toString('base64url'), p256dh: createECDH('prime256v1').generateKeys().toString('base64url') },
    }) as { device: { id: string } };
    await typed('PushTestResponse', 'POST', `${base}/test`, member, {});
    await typed('PushUnsubscribeResponse', 'DELETE', `${base}/devices/${subscribe.device.id}`, member);

    const happened = new Date(Date.now() - 10_000);
    const resultId = randomUUID();
    const db = fixture.application.database.db;
    await db.insertInto('chat_runs').values({ id: resultId, owner_id: member.id, conversation_id: run.id,
      status: 'completed', goal: 'Fixture result', lease_token: randomUUID(), lease_expires_at: happened }).execute();
    await recordBackgroundRunOutcome(db, { runId: resultId, userId: member.id, conversationId: run.id,
      startedAt: happened, outcome: 'completed', language: 'en', preview: 'Fixture result' }, happened);
    const tabId = randomUUID();
    const pending = await typed('NotificationSyncResponse', 'POST', `${base}/sync`, member, { tabId, state: 'visible' });
    expect(pending).toMatchObject({ pending: expect.arrayContaining([expect.objectContaining({ runId: resultId, runKind: 'run-completed' })]) });
    const claim = await typed('NotificationClaimResponse', 'POST', `${base}/events/${resultId}/claim`, member, { tabId });
    expect(claim).toMatchObject({ notification: { runId: resultId } });
    response = await send('GET', `${base}/events/${resultId}`, member);
    expect([response.statusCode, response.body]).toEqual([204, '']);
    response = await send('GET', `${base}/events/${resultId}`, owner);
    expect([response.statusCode, response.body]).toEqual([404, '']);
  });

  it('validates member reminder list, changes and delivered reminder fields', async () => {
    const { id: conversationId } = await conversation(member);
    const dueAt = new Date(Date.now() + 10 * 60_000);
    const input = { conversationId, text: 'Fixture reminder', timeZone: 'UTC', dueAt: dueAt.toISOString() };
    const created = checkJson(await send('POST', reminders, member, input), 201, ReminderMutationResultSchema).reminder;
    const path = `${reminders}/${created.id}`;
    expect(checkJson(await send('GET', reminders, member), 200, ReminderListSchema).reminders).toContainEqual(created);
    const expected = { dueAt: created.dueAt, updatedAt: created.updatedAt };
    checkJson(await send('PATCH', path, member, { text: 'Edited reminder', expected }), 200, ReminderMutationResultSchema);
    checkError(await send('PATCH', path, member, { text: 'Stale edit', expected }), 409);
    checkJson(await send('DELETE', path, member), 200, ReminderMutationResultSchema);
    checkError(await send('DELETE', path, owner), 404);
    const due = checkJson(await send('POST', reminders, member, input), 201, ReminderMutationResultSchema).reminder;
    await createReminderScheduler(fixture.application.database.db, { now: () => dueAt }).runOnce();
    expect(checkJson(await send('GET', `${reminders}/due`, member), 200, ReminderDueListSchema).deliveries)
      .toEqual(expect.arrayContaining([expect.objectContaining({ reminderId: due.id })]));
  });

  it('validates monitor approval, list, controls, settings, and alert feedback', async () => {
    const created = await conversation(member, 'Watch new results for public park permits and notify me when they appear');
    const detail = await settled(member, created.id);
    const { id } = MonitorCardSchema.parse(detail.monitorProposal);
    checkJson(await send('GET', `${monitors}?conversationId=${detail.id}`, member), 200, MonitorListSchema);
    checkJson(await send('GET', `${monitors}?control=v2&conversationId=${detail.id}`, member), 200, MonitorV2ControlSchema);
    checkJson(await send('POST', monitors, member, { proposalId: id }), 200, MonitorCardSchema);
    const preferences = checkJson(await send('POST', monitors, member, { proactiveOffers: false }), 200, MonitorManagementResultSchema);
    expect(preferences.proactiveOffers).toBe(false);
    const recording = z.strictObject({ included: z.boolean(), canChange: z.boolean() });
    checkJson(await send('GET', `${monitors}/decision-recording`, member), 200, recording);
    expect(checkJson(await send('POST', `${monitors}/decision-recording`, member, { decisionRecording: true }), 200, recording).included).toBe(true);

    const alertId = randomUUID();
    const happened = new Date();
    await recordBackgroundRunOutcome(fixture.application.database.db, { runId: alertId, userId: member.id,
      conversationId: detail.id, startedAt: happened, outcome: 'completed', language: 'en', monitorId: id }, happened);
    checkJson(await send('POST', `${monitors}/alerts/${alertId}/feedback`, member, { rating: 'helpful' }), 200, MonitorAlertFeedbackStateSchema);
    for (const action of ['pause', 'resume', 'stop']) {
      checkJson(await send('POST', `${monitors}/${id}/${action}`, member, {}), 200, MonitorCardSchema);
    }
    checkError(await send('POST', `${monitors}/${id}/resume`, member, {}), 409);
  });

  it('validates conversation export, preview, publication, public read, and revocation', async () => {
    const created = await conversation(member, 'Hello');
    const { id } = await settled(member, created.id);
    const path = `${conversations}/${id}`;
    const exportReply = await send('GET', `${path}/export?format=markdown`, member);
    expect(exportReply.statusCode).toBe(200);
    expect(exportReply.headers['content-type']).toMatch(/^text\/markdown/u);
    expect(exportReply.body).toContain('Hello');

    const preview = checkJson(await send('POST', `${path}/share/preview`, member, {}), 200, ConversationSharePreviewSchema);
    const published = checkJson(await send('POST', `${path}/share`, member,
      { review: preview.review, expiry: '1d', redact: true }), 201, CreatedConversationShareSchema);
    const token = new URL(published.url).pathname.split('/').at(-1);
    const publicPath = `${shares}/public/${token}`;
    checkJson(await send('GET', publicPath), 200, PublicConversationShareSchema);
    expect(checkJson(await send('GET', shares, member), 200, ConversationShareListSchema).shares).toContainEqual(published.share);
    checkJson(await send('DELETE', `${shares}/${published.share.id}`, member), 200, ok);
    checkError(await send('GET', publicPath), 404, 'CONVERSATION_SHARE_NOT_FOUND');
    const settings = '/api/chat/conversation-share-settings';
    checkJson(await send('GET', settings, owner), 200, ConversationShareSettingsSchema);
    checkJson(await send('POST', settings, owner, { memberSharingEnabled: false }), 200, ConversationShareSettingsSchema);
    checkError(await send('POST', `${path}/share/preview`, member, {}), 403, 'CONVERSATION_SHARE_DISABLED');
    checkJson(await send('POST', settings, owner, { memberSharingEnabled: true }), 200, ConversationShareSettingsSchema);
  });

  it('returns a typed owner metrics report and serves its CSV download', async () => {
    const metrics = '/api/ops/metrics';
    expect(await typed('ProductionMetricsResponse', 'GET', metrics, owner)).toMatchObject({ enabled: true, snapshotAvailable: true });
    const csv = await send('GET', `${metrics}.csv`, owner);
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toMatch(/^text\/csv/u);
    expect(csv.body.split(/\r?\n/u)[0]?.split(',')).toEqual(expect.arrayContaining(['window', 'role', 'section', 'count']));
    checkError(await send('GET', metrics, member), 403, 'MEMBER_FORBIDDEN');
  });

  it('validates the member rights and owner audit contracts with active and pending sessions', async () => {
    const data = '/api/member-data';
    const archive = await send('GET', `${data}/export`, member);
    expect(archive.statusCode).toBe(200);
    expect(archive.headers['content-type']).toBe('application/zip');
    expect(archive.rawPayload.subarray(0, 4).toString('hex')).toBe('504b0304');
    expect(checkJson(await send('GET', `${data}/sessions`, member), 200, AccountSessionsSchema).sessions)
      .toEqual(expect.arrayContaining([expect.objectContaining({ current: true })]));
    checkJson(await send('DELETE', `${data}/sessions`, member), 200, EndAccountSessionsResultSchema);
    checkJson(await send('GET', '/api/members/audit', owner), 200, MemberAuditPageSchema);

    expect(checkJson(await send('GET', `${data}/deletion`, member), 200, MemberDeletionStatusSchema).deletion).toBeNull();
    const pending = checkJson(await send('POST', `${data}/deletion`, member, { password: member.password }), 200, MemberDeletionStatusSchema);
    expect(pending.deletion).not.toBeNull();
    const pendingMember = await fixture.signIn(member);
    expect(checkJson(await send('GET', '/api/members/deletions', owner), 200, PendingMemberDeletionsSchema).requests)
      .toEqual(expect.arrayContaining([expect.objectContaining({ userId: member.id })]));
    expect(checkJson(await send('DELETE', `${data}/deletion`, pendingMember), 200, CancelMemberDeletionResultSchema).cancelled).toBe(true);
    const rejoined = await fixture.signIn(member);
    checkJson(await send('POST', `${data}/deletion`, rejoined, { password: member.password }), 200, MemberDeletionStatusSchema);
    expect(checkJson(await send('DELETE', `/api/members/deletions/${member.id}`, owner), 200,
      CancelMemberDeletionResultSchema).cancelled).toBe(true);
    checkJson(await send('DELETE', `/api/members/${member.id}/sessions`, owner), 200, EndAccountSessionsResultSchema);
  });
});
