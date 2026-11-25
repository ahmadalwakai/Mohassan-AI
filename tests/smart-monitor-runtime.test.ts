import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MonitorCardSchema, MonitorSpecSchema, NotificationPayloadSchema, type MonitorSpec, type NotificationPayload } from '@mohassan/contracts';
import { createDatabase, migrate, type DatabaseHandle } from '@mohassan/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrateAuth } from '../apps/server/src/auth.js';
import { dispatchBackgroundApns } from '../apps/server/src/background-apns-delivery.js';
import { migrateBackgroundResults } from '../apps/server/src/background-results-migration.js';
import { commandChatMigration } from '../apps/server/src/command-chat.js';
import { registerIosPushDevice } from '../apps/server/src/ios-push-devices.js';
import { migrateMemberDataRights } from '../apps/server/src/member-data-migration.js';
import { migrateMembers } from '../apps/server/src/members.js';
import { MONITOR_MIGRATION, migrateMonitors } from '../apps/server/src/monitors/migration.js';
import { createMonitorRuntime } from '../apps/server/src/monitors/runtime.js';
import { MONITOR_LIMITS, monitorExpiry, monitorTiming, nextMonitorCheck } from '../apps/server/src/monitors/schedule.js';
import type { MonitorReadResult } from '../apps/server/src/monitors/sources.js';
import { createMonitorStore } from '../apps/server/src/monitors/store.js';
import { claimNotification, dispatchBackgroundWebPush, subscribePushDevice, syncNotifications } from '../apps/server/src/notifications-store.js';
import { migrateRemindersInTransaction } from '../apps/server/src/reminders/migration.js';
import type { ApnsSender } from '../apps/server/src/apns.js';
import type { PushSender } from '../apps/server/src/web-push.js';

const minute = 60_000;
const hour = 60 * minute;
const baseline = Date.UTC(2026, 10, 25, 9);
const owner = 'smart-monitor-fixture-owner';
const member = 'smart-monitor-fixture-member';
const ownerConversation = randomUUID();
const memberConversation = randomUUID();
const source = { kind: 'page', url: 'https://stock.example.org/cart' } as const;

const pageSpec = (at: Date, extra?: { deadline?: string; lifetimeMs?: number }): MonitorSpec => MonitorSpecSchema.parse({
  source, read: { kind: 'number', label: 'Price' },
  condition: { kind: 'crossing', direction: 'below', value: 3.70, hysteresis: 0.02 },
  language: 'en', title: 'Price watch', message: 'The price crossed below 3.70.',
  timing: monitorTiming(source.kind, 'normal', { now: at, ...extra }),
});

describe('smart monitor cadence', () => {
  it('uses source-sensitive intervals, exponential backoff, deadline tightening and bounded lifetimes', () => {
    const at = new Date(baseline);
    expect(monitorTiming('currency', 'normal', { now: at }).initialIntervalMs).toBe(hour);
    expect(monitorTiming('run', 'urgent', { now: at }).initialIntervalMs).toBe(minute);
    expect(monitorTiming('page', 'normal', { now: at, lifetimeMs: Infinity }).lifetimeMs).toBe(MONITOR_LIMITS.maxLifetimeMs);
    expect(monitorTiming('page', 'urgent', { now: at, requestedIntervalMs: 10 }).initialIntervalMs).toBe(5 * minute);

    const spec = pageSpec(at);
    expect(spec.timing.lifetimeMs).toBe(7 * 24 * hour);
    expect(spec.timing.maxChecks).toBe(52);
    const expiry = monitorExpiry(spec.timing, at);
    const backedOff = nextMonitorCheck(spec, at, 15 * minute, { expiry, changed: false });
    expect(backedOff).toEqual({ intervalMs: 30 * minute, dueAt: new Date(baseline + 30 * minute) });
    expect(nextMonitorCheck(spec, at, 4 * hour, { expiry, changed: false }).intervalMs).toBe(6 * hour);
    const changed = nextMonitorCheck(spec, backedOff.dueAt, backedOff.intervalMs, { expiry, changed: true });
    expect(changed).toEqual({ intervalMs: 15 * minute, dueAt: new Date(baseline + 45 * minute) });

    const deadline = new Date(baseline + 4 * hour);
    const timed = pageSpec(at, { deadline: deadline.toISOString() });
    expect(monitorExpiry(timed.timing, new Date(baseline + hour))).toEqual(deadline);
    const tightening = nextMonitorCheck(timed, at, 6 * hour, { expiry: deadline, changed: false });
    expect(tightening.dueAt).toEqual(new Date(baseline + 3 * hour));
    expect(nextMonitorCheck(timed, tightening.dueAt, tightening.intervalMs, { expiry: deadline, changed: false })).toEqual({
      intervalMs: 5 * minute, dueAt: new Date(baseline + 3 * hour + 5 * minute),
    });
  });
});

describe('durable smart monitor runtime', () => {
  let database: DatabaseHandle;
  let directory: string;
  let store: ReturnType<typeof createMonitorStore>;
  let clock: number;
  const now = () => new Date(clock);
  const observe = (value: number) => ({ value, excerpt: `Price ${value}`, url: source.url, observedAt: now().toISOString() });
  const value = (number: number): MonitorReadResult => ({ kind: 'value', observation: observe(number) });
  const events = () => database.db.selectFrom('chat_notifications').selectAll().orderBy('happened_at').execute();
  const messages = () => database.db.selectFrom('chat_messages').selectAll().orderBy('created_at').execute();
  const open = async () => {
    database = await createDatabase({ dataDir: directory });
    store = createMonitorStore(database.db, { now });
  };
  const runtime = (read: Parameters<typeof createMonitorRuntime>[1]['read']) => createMonitorRuntime(database.db, { read, store }, { now });

  async function proposal(userId = member, spec = pageSpec(now()), conversationId = userId === member ? memberConversation : ownerConversation) {
    return store.propose(userId, { conversationId, spec, observation: observe(3.75), offer: 'explicit' });
  }
  const byId = async (id: string, userId = member) => MonitorCardSchema.parse((await store.list(userId)).find(card => card.id === id));
  const goto = (timestamp: string | null) => { clock = Date.parse(timestamp!); };

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'smart-monitor-runtime-'));
    await open();
    await migrateAuth(database.db);
    await migrateMembers(database.db);
    await migrate(database.db);
    await commandChatMigration(database.db, migrateRemindersInTransaction);
    await migrateMemberDataRights(database.db);
    await migrateBackgroundResults(database.db);
    await migrateMonitors(database.db);
    await migrateMonitors(database.db);
    await database.db.insertInto('user').values([
      { id: owner, name: 'Fixture Owner', email: 'fixture-owner@example.test' },
      { id: member, name: 'Fixture Member', email: 'fixture-member@example.test' },
    ]).execute();
    await database.db.insertInto('workspace_owner').values({ id: 1, owner_id: owner }).execute();
    await database.db.insertInto('workspace_members').values({ user_id: member, role: 'member' }).execute();
  });

  beforeEach(async () => {
    clock = baseline;
    for (const table of ['chat_notifications', 'notification_tabs', 'notification_preferences', 'push_subscriptions', 'ios_push_devices', 'smart_monitor_budgets', 'smart_monitor_hosts', 'chat_conversations']) {
      await database.db.deleteFrom(table).execute();
    }
    await database.db.updateTable('workspace_members').set({ disabled_at: null }).execute();
    await database.db.insertInto('chat_conversations').values([
      { id: ownerConversation, owner_id: owner, title: 'Owner conversation', created_at: now(), updated_at: now() },
      { id: memberConversation, owner_id: member, title: 'Member conversation', created_at: now(), updated_at: now() },
    ]).execute();
  });

  afterAll(async () => {
    await database?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('keeps approval read-only, survives a database reopen and delivers a trigger once after four hours', async () => {
    expect(await database.db.selectFrom('schema_migrations').select('version').where('version', '=', MONITOR_MIGRATION).execute()).toHaveLength(1);
    const proposed = await proposal();
    expect(proposed).toMatchObject({ status: 'proposed', current: { value: 3.75 }, nextCheckAt: null });
    const read = vi.fn(async () => value(3.69));
    await runtime(read).runOnce();
    expect(read).not.toHaveBeenCalled();
    await store.approve(member, proposed.id);
    await registerIosPushDevice(database.db, member, { platform: 'ios', environment: 'sandbox', token: 'aa'.repeat(32), appVersion: '15' });
    await database.close();
    await open();
    clock = baseline + 4 * hour;
    await Promise.all([runtime(read).runOnce(), runtime(read).runOnce()]);
    await runtime(read).runOnce();
    expect(read).toHaveBeenCalledTimes(1);
    expect(await byId(proposed.id)).toMatchObject({ status: 'completed', nextCheckAt: null, current: { value: 3.69 } });
    const [event] = await events();
    expect(await events()).toHaveLength(1);
    expect(event).toMatchObject({ monitor_id: proposed.id, run_id: null, background_outcome: 'completed' });
    expect(await messages()).toEqual([expect.objectContaining({ id: event.task_id, text: expect.stringContaining('Price 3.69') })]);
    expect(await database.db.selectFrom('chat_runs').select('id').execute()).toEqual([]);

    const tabId = randomUUID();
    clock += 3_000;
    const [pending] = (await syncNotifications(database.db, member, { tabId, state: 'visible' }, now())).pending;
    expect(NotificationPayloadSchema.parse(pending)).toMatchObject({ monitorId: proposed.id, runId: event.task_id,
      conversationId: memberConversation, runKind: 'run-completed', body: 'Open the conversation to see the update.' });
    await claimNotification(database.db, member, event.task_id, 'tab', now(), tabId);
    await claimNotification(database.db, member, event.task_id, 'tab', now(), tabId, true);
    expect((await syncNotifications(database.db, member, { tabId, state: 'visible' }, now())).pending).toEqual([]);

    const apns = vi.fn<ApnsSender>().mockResolvedValue('delivered');
    await dispatchBackgroundApns(database.db, apns, async () => true, now());
    await dispatchBackgroundApns(database.db, apns, async () => true, now());
    expect(apns).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ environment: 'sandbox' }), {
      aps: { alert: { title: 'Monitor update', body: 'Open the conversation to see the update.' },
        sound: 'mohassan-done.caf', 'thread-id': memberConversation },
      conversationId: memberConversation, runId: event.task_id, kind: 'run-completed', monitorId: proposed.id,
    }, event.task_id);
  });

  it('advances the due slot before a read and never repeats a check across an interrupted worker', async () => {
    const { id } = await proposal();
    goto((await store.approve(member, id)).nextCheckAt);
    let reached!: () => void;
    const started = new Promise<void>(resolve => { reached = resolve; });
    const interrupted = runtime(async () => { reached(); return new Promise<MonitorReadResult>(() => {}); });
    const first = interrupted.runOnce();
    await started;
    await interrupted.stop();
    await first;
    const { nextCheckAt } = await byId(id);
    const read = vi.fn(async () => value(3.69));
    clock += MONITOR_LIMITS.leaseMs;
    await runtime(read).runOnce();
    expect(read).not.toHaveBeenCalled();
    goto(nextCheckAt);
    await Promise.all([runtime(read).runOnce(), runtime(read).runOnce()]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(await events()).toHaveLength(1);
    expect(await byId(id)).toMatchObject({ status: 'completed' });
    expect(await database.db.selectFrom('smart_monitors').select('checks').where('id', '=', id).executeTakeFirst()).toEqual({ checks: 2 });
  });

  it('uses the same committed event for Web Push without putting evidence on the lock screen', async () => {
    const device = { endpoint: 'https://fcm.googleapis.com/fcm/send/monitor-fixture', keys: {
      p256dh: createECDH('prime256v1').generateKeys().toString('base64url'), auth: randomBytes(16).toString('base64url'),
    } };
    await subscribePushDevice(database.db, member, { ...device, label: 'Fixture browser' });
    const { id } = await proposal();
    goto((await store.approve(member, id)).nextCheckAt);
    await runtime(async () => value(3.69)).runOnce();
    const [event] = await events();
    clock += 3_000;
    const push = vi.fn<PushSender<NotificationPayload>>().mockResolvedValue('delivered');
    await dispatchBackgroundWebPush(database.db, push, async () => true, now());
    await dispatchBackgroundWebPush(database.db, push, async () => true, now());
    expect(push).toHaveBeenCalledExactlyOnceWith(device, {
      monitorId: id, taskId: event.task_id, runId: event.task_id, conversationId: memberConversation,
      kind: 'task_completed', runKind: 'run-completed', title: 'Monitor update',
      body: 'Open the conversation to see the update.', language: 'en', sound: true,
    });
  });

  it.each([['unreachable', 'repeatedly failed'], ['missing', 'lost track']] as const)(
    'notifies once and pauses for a persistently %s source', async (kind, evidence) => {
      const { id } = await proposal();
      let active = await store.approve(member, id);
      const read = vi.fn(async (): Promise<MonitorReadResult> => ({ kind }));
      const worker = runtime(read);
      for (let attempt = 0; attempt < MONITOR_LIMITS.consecutiveFailures; attempt++) {
        goto(active.nextCheckAt);
        await worker.runOnce();
        active = await byId(id);
      }
      clock += hour;
      await runtime(read).runOnce();
      expect(read).toHaveBeenCalledTimes(MONITOR_LIMITS.consecutiveFailures);
      expect(active).toMatchObject({ status: 'paused', nextCheckAt: null, note: expect.stringContaining(evidence) });
      expect(await events()).toEqual([expect.objectContaining({ monitor_id: id, background_outcome: 'approval', kind: 'needs_you' })]);
      expect(await messages()).toEqual([expect.objectContaining({ text: expect.stringContaining(evidence) })]);
      const pending = (await syncNotifications(database.db, member, { tabId: randomUUID(), state: 'visible' }, now())).pending;
      expect(pending).toEqual([expect.objectContaining({ monitorId: id, runKind: 'run-blocked', body: 'Open the conversation to see why.' })]);
    },
  );

  it('enforces account isolation, pending/active slots, preview limits and pause or stop', async () => {
    const { monitors, previews } = MONITOR_LIMITS.account.member;
    const first = await proposal();
    expect(await proposal()).toEqual(first);
    expect(await store.list(owner, memberConversation)).toEqual([]);
    await expect(store.approve(owner, first.id)).rejects.toMatchObject({ code: 'MONITOR_NOT_FOUND' });
    await expect(store.reservePreview(owner, memberConversation)).rejects.toMatchObject({ code: 'MONITOR_CONVERSATION_NOT_FOUND' });
    const candidate = (index: number) => ({ ...pageSpec(now()), source: { ...source, anchor: `Product ${index}` } });
    for (let index = 1; index < monitors; index++) await proposal(member, candidate(index));
    await expect(proposal(member, candidate(monitors))).rejects.toMatchObject({ code: 'MONITOR_LIMIT' });
    for (let index = 0; index < previews; index++) await store.reservePreview(member, memberConversation);
    await expect(store.reservePreview(member, memberConversation)).rejects.toMatchObject({ code: 'MONITOR_PREVIEW_LIMIT' });
    await expect(store.reservePreview(owner, ownerConversation)).resolves.toBeUndefined();

    const active = await store.approve(member, first.id);
    await expect(store.change(member, first.id, 'pause')).resolves.toMatchObject({ status: 'paused', nextCheckAt: null });
    goto(active.nextCheckAt);
    const read = vi.fn(async () => value(3.69));
    await runtime(read).runOnce();
    expect(read).not.toHaveBeenCalled();
    const resumed = await store.change(member, first.id, 'resume');
    expect(resumed).toMatchObject({ status: 'active', expiresAt: active.expiresAt });
    await expect(store.change(member, first.id, 'stop')).resolves.toMatchObject({ status: 'stopped', nextCheckAt: null });
    goto(resumed.nextCheckAt);
    await runtime(read).runOnce();
    expect(read).not.toHaveBeenCalled();
    await expect(store.change(member, first.id, 'resume')).rejects.toMatchObject({ code: 'MONITOR_STATUS_CONFLICT' });
    await expect(proposal(member, candidate(monitors))).resolves.toMatchObject({ status: 'proposed' });
  });

  it('shares a durable host interval across workers and honors a longer robots interval', async () => {
    const duplicate = createMonitorStore(database.db, { now });
    const admitted = await Promise.all([store.reserveHost('example.org'), duplicate.reserveHost('EXAMPLE.ORG.')]);
    expect(admitted).toEqual(expect.arrayContaining([null, baseline + MONITOR_LIMITS.hostIntervalMs]));
    await store.extendHost('example.org', 90_000);
    clock += MONITOR_LIMITS.hostIntervalMs;
    await expect(duplicate.reserveHost('example.org')).resolves.toBe(baseline + 90_000);
    await expect(duplicate.reserveHost('other.example.org')).resolves.toBeNull();
    clock = baseline + 90_000;
    await expect(duplicate.reserveHost('example.org')).resolves.toBeNull();
  });

  it('defers a busy host without spending the individual monitor budget before a host is admitted', async () => {
    const { id } = await proposal();
    goto((await store.approve(member, id)).nextCheckAt);
    await store.reserveHost('stock.example.org');
    const read: Parameters<typeof createMonitorRuntime>[1]['read'] = async (_spec, options) => {
      const at = await options.reserveHost!('stock.example.org');
      return at === null ? value(3.75) : { kind: 'deferred', at };
    };
    await runtime(read).runOnce();
    expect(await database.db.selectFrom('smart_monitors').select('checks').where('id', '=', id).executeTakeFirst()).toEqual({ checks: 0 });
    expect(await database.db.selectFrom('smart_monitor_budgets').select('checks').where('user_id', '=', member).executeTakeFirst()).toEqual({ checks: 1 });
    expect((await byId(id)).nextCheckAt).toBe(new Date(clock + MONITOR_LIMITS.hostIntervalMs).toISOString());
  });

  it('defers check and notice quota excess until the next budget day', async () => {
    const { id } = await proposal();
    goto((await store.approve(member, id)).nextCheckAt);
    const budget = MONITOR_LIMITS.account.member;
    await database.db.insertInto('smart_monitor_budgets').values({ user_id: member, budget_day: '2026-11-25',
      checks: budget.checks, notifications: budget.notifications }).execute();
    const read = vi.fn(async () => value(3.69));
    await runtime(read).runOnce();
    expect(read).not.toHaveBeenCalled();
    expect((await byId(id)).nextCheckAt).toBe('2026-11-26T00:00:00.000Z');

    goto((await byId(id)).nextCheckAt);
    await database.db.updateTable('smart_monitor_budgets').set({ budget_day: '2026-11-26', checks: 0 }).where('user_id', '=', member).execute();
    await runtime(read).runOnce();
    expect(read).toHaveBeenCalledTimes(1);
    expect(await events()).toEqual([]);
    expect(await byId(id)).toMatchObject({ status: 'completed' });
    goto('2026-11-27T00:00:00.000Z');
    await Promise.all([runtime(read).runOnce(), runtime(read).runOnce()]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(await events()).toHaveLength(1);
    expect(await messages()).toHaveLength(1);
  });

  it('never checks a disabled account or a monitor past its expiry', async () => {
    const { id } = await proposal(member, pageSpec(now(), { lifetimeMs: hour }));
    const card = await store.approve(member, id);
    await database.db.updateTable('workspace_members').set({ disabled_at: now() }).where('user_id', '=', member).execute();
    goto(card.nextCheckAt);
    const read = vi.fn(async () => value(3.69));
    await runtime(read).runOnce();
    await database.db.updateTable('workspace_members').set({ disabled_at: null }).where('user_id', '=', member).execute();
    goto(card.expiresAt);
    await runtime(read).runOnce();
    expect(read).not.toHaveBeenCalled();
    expect(await byId(id)).toMatchObject({ status: 'expired', nextCheckAt: null });
    expect(await events()).toEqual([]);
  });
});
