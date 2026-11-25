import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemberAgentBrowser, purgeAgentBrowserProfiles } from '../apps/server/src/member-profile-storage.ts';
import { createApplication } from '../apps/server/src/app.ts';
import { memberDocumentDirectory } from '../apps/server/src/member-data-document-path.ts';
import { purgeMemberAccount, startMemberDeletionPurge } from '../apps/server/src/member-deletion.ts';
import { conversationSharePaths } from '../apps/server/src/conversation-share-paths.ts';
import { createReminderScheduler } from '../apps/server/src/reminders/scheduler.ts';
import { addPlatformMemberData } from './fixtures/platform-member-data.ts';

describe('member deletion', () => {
  const origin = 'http://127.0.0.1:3000';
  const internalSecret = 'member-deletion-fixture-internal-00001';
  const setupToken = 'member-deletion-fixture-setup-000001';
  const owner = { name: 'Deletion owner fixture', email: 'deletion-owner@example.test', password: 'Deletion-Fixture-Owner-42' };
  const first = { name: 'Deletion member fixture', email: 'deletion-member@example.test', password: 'Deletion-Fixture-Member-42' };
  const second = { name: 'Purge member fixture', email: 'purge-member@example.test', password: 'Purge-Fixture-Member-42' };
  let app: Awaited<ReturnType<typeof createApplication>> | undefined;
  let directory = '', ownerCookie = '', ownerId = '', memberId = '', purgedId = '';
  let documentsDir = '', browserDir = '';
  const headers = (cookie = '') => ({ origin, 'x-mohassan-internal': internalSecret, ...(cookie ? { cookie } : {}) });
  const db = () => app!.database.db;
  const get = (url: string, cookie = '') => app!.app.inject({ url, headers: headers(cookie) });
  const post = (url: string, payload: object, cookie = '') => app!.app.inject({ method: 'POST', url, headers: headers(cookie), payload });
  const remove = (url: string, cookie: string, payload?: object) =>
    app!.app.inject({ method: 'DELETE', url, headers: headers(cookie), ...(payload ? { payload } : {}) });
  const self = '/api/member-data/deletion';
  const pending = '/api/members/deletions';

  async function login(account: { email: string; password: string }) {
    // Fastify injections share an IP and Better Auth limits repeated sign-ins from it.
    await db().deleteFrom('rateLimit').execute();
    const response = await post('/api/auth/sign-in/email', { email: account.email, password: account.password });
    const cookie = [response.headers['set-cookie']].flat().filter(Boolean).map(value => String(value).split(';')[0]).join('; ');
    return { status: response.statusCode, cookie, result: response.statusCode === 200 ? null : response.json() };
  }

  async function invite(account: { name: string; email: string; password: string }) {
    const { name, email, password } = account;
    const invite = await post('/api/members/invites', { name, email }, ownerCookie);
    expect(invite.statusCode).toBe(200);
    const token = new URL(invite.json().url).hash.slice('#invite='.length);
    expect((await post('/api/invites/accept', { token, name, password })).statusCode).toBe(200);
    const signedIn = await login(account);
    expect(signedIn.status).toBe(200);
    return (await get('/api/access', signedIn.cookie)).json().user.id as string;
  }

  async function audit(id: string) {
    const rows = await db().selectFrom('workspace_member_audit').select(['actor_id', 'action'])
      .where('target_id', '=', id).orderBy('id').execute();
    return rows;
  }

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mohassan-member-deletion-'));
    documentsDir = join(directory, 'documents');
    browserDir = join(directory, 'browser');
    app = await createApplication({
      authSecret: 'member-deletion-fixture-auth-000001', internalSecret, setupToken,
      webOrigin: origin, production: false, runWorker: false, documentsDir, browserProfileDir: browserDir,
    });
    expect((await post('/api/setup', { ...owner, setupToken })).statusCode).toBe(200);
    const signedIn = await login(owner);
    expect(signedIn.status).toBe(200);
    ownerCookie = signedIn.cookie;
    ownerId = (await get('/api/access', ownerCookie)).json().user.id;
    memberId = await invite(first);
    purgedId = await invite(second);
  }, 60_000);

  afterAll(async () => {
    await app?.app.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('uses the current session password, revokes every session, and limits a new sign-in to grace controls', async () => {
    const one = await login(first), another = await login(first);
    expect(one.status).toBe(200);
    expect(another.status).toBe(200);
    expect((await get(self, one.cookie)).json()).toEqual({ deletion: null });
    const wrong = await post(self, { password: second.password }, one.cookie);
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().error.code).toBe('PASSWORD_CONFIRMATION_FAILED');
    expect((await get(self, another.cookie)).json()).toEqual({ deletion: null });
    expect(await audit(memberId)).toEqual([]);

    const conversationId = randomUUID(), ownerConversationId = randomUUID();
    await db().insertInto('chat_conversations').values([
      { id: conversationId, owner_id: memberId, title: 'Member share fixture' },
      { id: ownerConversationId, owner_id: ownerId, title: 'Owner share fixture' },
    ]).execute();
    const memberData = await addPlatformMemberData(db(), memberId, conversationId);
    const ownerData = await addPlatformMemberData(db(), ownerId, ownerConversationId);
    const queuedId = memberData.exportedRows.reminder_deliveries.delivery_key;
    const queuedAt = new Date();
    await db().insertInto('chat_notifications').values({
      task_id: queuedId, user_id: memberId, conversation_id: conversationId, kind: 'reminder_due',
      started_at: queuedAt, happened_at: queuedAt, available_at: memberData.dueAt, delivery: 'pending',
    }).execute();
    const publicPath = (token: string) => conversationSharePaths.public.replace(':token', token);
    expect((await get(publicPath(memberData.token))).statusCode).toBe(200);

    const request = await post(self, { password: first.password }, one.cookie);
    expect(request.statusCode).toBe(200);
    const { deletion } = request.json();
    expect(Date.parse(deletion.purgeAfter) - Date.parse(deletion.requestedAt)).toBe(7 * 24 * 60 * 60 * 1000);
    for (const cookie of [one.cookie, another.cookie]) expect((await get(self, cookie)).statusCode).toBe(401);
    expect((await remove(self, one.cookie)).statusCode).toBe(401);
    expect(await db().selectFrom('session').select('id').where('userId', '=', memberId).execute()).toHaveLength(0);
    expect((await get(publicPath(memberData.token))).statusCode).toBe(404);
    expect((await get(publicPath(ownerData.token))).statusCode).toBe(200);
    expect(await db().selectFrom('push_subscriptions').select('id').execute()).toEqual([{ id: ownerData.pushId }]);
    expect(await db().selectFrom('chat_notifications').select('delivery').where('task_id', '=', memberData.taskId).executeTakeFirst())
      .toEqual({ delivery: 'suppressed' });
    const now = () => new Date(Math.max(memberData.dueAt.getTime(), ownerData.dueAt.getTime()));
    const scheduler = createReminderScheduler(db(), { now });
    const deliveries = () => db().selectFrom('reminder_deliveries').select('delivery_key')
      .where('delivery_key', 'in', [memberData.deliveryKey, ownerData.deliveryKey]).execute();
    const queuedMessage = () => db().selectFrom('chat_messages').select('id').where('id', '=', queuedId).executeTakeFirst();
    await scheduler.runOnce();
    expect(await deliveries()).toEqual([{ delivery_key: ownerData.deliveryKey }]);
    expect(await queuedMessage()).toBeUndefined();
    expect(await purgeMemberAccount(db(), memberId, { documentsDir, purgeBrowserProfiles: async () => {} })).toBe(false);

    const recovery = await login(first);
    expect(recovery.status).toBe(200);
    expect((await get('/api/access', recovery.cookie)).json().deletion).toEqual(deletion);
    expect((await get(self, recovery.cookie)).json()).toEqual({ deletion });
    expect((await get('/api/chat/conversations', recovery.cookie)).statusCode).toBe(403);
    await expect(app!.chat.create(memberId, {})).rejects.toMatchObject({ code: 'CHAT_ACCOUNT_INACTIVE' });
    expect((await get(pending, ownerCookie)).json()).toEqual({
      requests: [{ userId: memberId, name: first.name, email: first.email, ...deletion }],
    });
    expect((await remove(self, recovery.cookie, { userId: purgedId })).statusCode).toBe(400);
    expect((await remove(self, recovery.cookie)).json()).toEqual({ cancelled: true });
    await scheduler.runOnce();
    expect(await deliveries()).toHaveLength(2);
    expect(await queuedMessage()).toEqual({ id: queuedId });
    expect((await get(publicPath(memberData.token))).statusCode).toBe(404);
    expect(await db().selectFrom('push_subscriptions').select('id').where('user_id', '=', memberId).execute()).toEqual([]);
    expect((await get(self, recovery.cookie)).json()).toEqual({ deletion: null });
    expect((await get('/api/chat/conversations', recovery.cookie)).statusCode).toBe(200);
    expect((await remove(self, recovery.cookie)).json()).toEqual({ cancelled: false });
    expect(await audit(memberId)).toEqual([
      { actor_id: memberId, action: 'deletion_requested' }, { actor_id: memberId, action: 'deletion_cancelled' },
    ]);
  }, 30_000);

  it('lets the owner cancel a member request and protects the owner even if a request row exists', async () => {
    const signedIn = await login(first);
    const request = await post(self, { password: first.password }, signedIn.cookie);
    expect(request.statusCode).toBe(200);
    expect((await remove(`${pending}/${memberId}`, ownerCookie)).json()).toEqual({ cancelled: true });
    expect((await get(pending, ownerCookie)).json()).toEqual({ requests: [] });
    expect(await audit(memberId)).toContainEqual({ actor_id: ownerId, action: 'deletion_cancelled' });
    expect((await post(self, { password: owner.password }, ownerCookie)).json().error.code).toBe('OWNER_DELETION_PROTECTED');
    await sql`INSERT INTO member_deletion_requests (user_id, requested_at, purge_after)
      VALUES (${ownerId}, clock_timestamp() - interval '8 days', clock_timestamp() - interval '1 day')`.execute(db());
    await db().insertInto('workspace_members').values({ user_id: ownerId, role: 'member', disabled_at: new Date() }).execute();
    try {
      expect((await get('/api/access', ownerCookie)).json()).toMatchObject({ role: 'owner', services: ['all'] });
      expect((await get(self, ownerCookie)).json()).toEqual({ deletion: null });
      expect((await get(pending, ownerCookie)).json()).toEqual({ requests: [] });
      expect((await login(owner)).status).toBe(200);
      expect(await purgeMemberAccount(db(), ownerId, { documentsDir, purgeBrowserProfiles: async () => {} })).toBe(false);
      expect(await db().selectFrom('user').select('id').where('id', '=', ownerId).executeTakeFirst()).toBeDefined();
    } finally {
      await db().deleteFrom('workspace_members').where('user_id', '=', ownerId).execute();
      await db().deleteFrom('member_deletion_requests').where('user_id', '=', ownerId).execute();
    }
  }, 30_000);

  it('purges overdue rows in batches and retries after an interrupted final transaction', async () => {
    const { cookie } = await login(second);
    const hash = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, 24);
    const legacyRemovedName = 'legacy-conversation-removed';
    const removedConversation = randomUUID();
    await db().insertInto('chat_conversations').values({
      id: removedConversation, owner_id: purgedId, title: 'Remove old binding', browser_account: legacyRemovedName,
    }).execute();
    const removedConversationProfile = join(browserDir, `account-${hash(`account:${JSON.stringify([purgedId, legacyRemovedName])}`)}`);
    await mkdir(removedConversationProfile, { recursive: true });
    expect((await remove(`/api/chat/conversations/${removedConversation}`, cookie)).statusCode).toBe(200);
    expect((await stat(removedConversationProfile)).isDirectory()).toBe(true);
    const request = await post(self, { password: second.password }, cookie);
    expect(request.statusCode).toBe(200);
    const recovery = await login(second);
    expect(recovery.status).toBe(200);
    await sql`UPDATE member_deletion_requests
      SET requested_at = clock_timestamp() - interval '8 days', purge_after = clock_timestamp() - interval '1 day'
      WHERE user_id = ${purgedId}`.execute(db());

    const expiredLogin = await login(second);
    expect(expiredLogin.status).toBe(403);
    expect(expiredLogin.result.code).toBe('DELETION_GRACE_ENDED');
    expect(Boolean(expiredLogin.cookie)).toBe(false);
    expect((await get(self, recovery.cookie)).statusCode).toBe(403);
    expect((await remove(`${pending}/${purgedId}`, ownerCookie)).json().error.code).toBe('DELETION_GRACE_ENDED');

    await db().insertInto('ai_provider_settings').values({
      id: 'freellmapi', enabled: false, models: JSON.stringify([]), automatic_fallback: false, free_only: true, updated_by: purgedId,
    }).execute();
    const conversationId = randomUUID(), otherConversation = randomUUID(), legacyName = 'legacy-profile';
    await db().insertInto('chat_conversations').values([
      { id: conversationId, owner_id: purgedId, title: 'Delete this', browser_account: legacyName },
      { id: otherConversation, owner_id: memberId, title: 'Keep this' },
    ]).execute();
    await db().insertInto('chat_messages').values(Array.from({ length: 251 }, () =>
      ({ id: randomUUID(), conversation_id: conversationId, role: 'user', text: 'fixture message' }))).execute();
    await db().insertInto('chat_messages').values({ id: randomUUID(), conversation_id: otherConversation, role: 'user', text: 'other fixture message' }).execute();
    const platform = await addPlatformMemberData(db(), purgedId, conversationId);
    const deletedDocs = memberDocumentDirectory(documentsDir, purgedId);
    const retainedDocs = memberDocumentDirectory(documentsDir, memberId);
    for (const folder of [deletedDocs, retainedDocs]) {
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, 'fixture.pdf'), 'test document');
    }
    const defaultProfile = join(browserDir, hash(purgedId));
    const namedProfile = (id: string, name: string) => join(browserDir, `account-${hash(`account:${JSON.stringify([id, name])}`)}`);
    const trackedName = 'already-deleted-conversation';
    const browser = new MemberAgentBrowser({ profileDir: browserDir });
    await browser.bindAccount(purgedId, randomUUID(), trackedName);
    const trackedProfile = namedProfile(purgedId, trackedName);
    const legacyProfile = namedProfile(purgedId, legacyName);
    const otherProfile = namedProfile(memberId, legacyName);
    for (const folder of [defaultProfile, trackedProfile, legacyProfile, otherProfile]) {
      await mkdir(folder, { recursive: true });
    }
    const options = {
      documentsDir, purgeBrowserProfiles: (userId: string, accounts: readonly string[]) => browser.purgeAccount(userId, accounts),
    };
    const purge = () => purgeMemberAccount(db(), purgedId, options);

    await sql`CREATE FUNCTION stop_member_purge_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'simulated interruption'; END; $$`.execute(db());
    await sql`CREATE TRIGGER stop_member_purge_fixture BEFORE DELETE ON "user"
      FOR EACH ROW EXECUTE FUNCTION stop_member_purge_fixture()`.execute(db());
    try {
      await expect(purge()).rejects.toThrow('simulated interruption');
      expect(await db().selectFrom('chat_messages').select('id').where('conversation_id', '=', conversationId).execute()).toHaveLength(0);
      expect(await db().selectFrom('chat_messages').select('id').where('conversation_id', '=', otherConversation).execute()).toHaveLength(1);
      for (const [table, row] of Object.entries(platform.exportedRows)) {
        const accountColumn = 'sharer_id' in row ? 'sharer_id' : 'user_id';
        expect(await db().selectFrom(table).select(accountColumn).where(accountColumn, '=', purgedId).execute(), table).toEqual([]);
      }
      expect(await db().selectFrom('user').select('id').where('id', '=', purgedId).executeTakeFirst()).toBeDefined();
      expect((await db().selectFrom('member_deletion_requests').select('started_at').where('user_id', '=', purgedId).executeTakeFirstOrThrow()).started_at).toBeTruthy();
      expect(await db().selectFrom('session').select('id').where('userId', '=', purgedId).execute()).toHaveLength(0);
      expect(await audit(purgedId)).toEqual([{ actor_id: purgedId, action: 'deletion_requested' }]);
      expect(await db().selectFrom('ai_provider_settings').select(['enabled', 'updated_by']).executeTakeFirst())
        .toEqual({ enabled: false, updated_by: null });
      expect(await db().selectFrom('workspace_invites').select('id').where('email', '=', second.email).execute()).toHaveLength(0);
      expect(await db().selectFrom('workspace_invites').select('id').where('email', '=', first.email).execute()).toHaveLength(1);
      for (const folder of [deletedDocs, defaultProfile, trackedProfile, legacyProfile, removedConversationProfile]) {
        await expect(stat(folder)).rejects.toMatchObject({ code: 'ENOENT' });
      }
      expect((await stat(retainedDocs)).isDirectory()).toBe(true);
      expect((await stat(otherProfile)).isDirectory()).toBe(true);
    } finally {
      await sql`DROP TRIGGER stop_member_purge_fixture ON "user"`.execute(db());
      await sql`DROP FUNCTION stop_member_purge_fixture()`.execute(db());
    }

    const maintenance = Fastify();
    startMemberDeletionPurge(maintenance, db(), options);
    await maintenance.ready();
    await maintenance.close();
    expect(await purge()).toBe(false);
    expect(await db().selectFrom('user').select('id').where('id', '=', purgedId).executeTakeFirst()).toBeUndefined();
    expect(await db().selectFrom('workspace_members').select('user_id').where('user_id', '=', purgedId).executeTakeFirst()).toBeUndefined();
    expect(await db().selectFrom('member_deletion_requests').select('user_id').where('user_id', '=', purgedId).executeTakeFirst()).toBeUndefined();
    expect(await db().selectFrom('user').select('id').where('id', 'in', [ownerId, memberId]).execute()).toHaveLength(2);
    expect((await login(second)).status).toBe(401);
    expect(await audit(purgedId)).toEqual([
      { actor_id: purgedId, action: 'deletion_requested' }, { actor_id: null, action: 'deletion_purged' },
    ]);
    await browser.close();
  }, 45_000);
});

it('closes live browser profiles and forgets bindings only for the account being purged', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mohassan-member-browser-files-'));
  const hash = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, 24);
  const ownerId = 'purged-fixture', otherId = 'retained-fixture';
  const boundKey = `account:${JSON.stringify([ownerId, 'profile'])}`;
  const removedBinding = JSON.stringify([ownerId, 'conversation']);
  const keptBinding = JSON.stringify([otherId, 'conversation']);
  const closed: string[] = [];
  const owners = new Map([boundKey, `default:${ownerId}`, `default:${otherId}`].map(key => [
    key, Promise.resolve({ context: { async close() { closed.push(key); } } }),
  ]));
  const accounts = new Map([[removedBinding, 'profile'], [keptBinding, 'profile']]);
  const checkpoints = new Map([[removedBinding, {}], [keptBinding, {}]]);
  try {
    await purgeAgentBrowserProfiles(directory, ownerId, [], owners, accounts, checkpoints, hash);
    expect(new Set(closed)).toEqual(new Set([boundKey, `default:${ownerId}`]));
    expect([...owners.keys()]).toEqual([`default:${otherId}`]);
    expect([...accounts.keys()]).toEqual([keptBinding]);
    expect([...checkpoints.keys()]).toEqual([keptBinding]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
