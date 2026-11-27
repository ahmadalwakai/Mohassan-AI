import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, migrate, sql } from '@mohassan/database';
import { createAuth, migrateAuth, setAuthSessionCreationCheck } from '../apps/server/src/auth.js';
import { registerAuditedMemberRoutes } from '../apps/server/src/member-administration.js';
import { migrateMemberDataRights } from '../apps/server/src/member-data-migration.js';
import { assertDeletionCanSignIn } from '../apps/server/src/member-deletion.js';
import { migrateMembers, registerMemberRoutes } from '../apps/server/src/members.js';

describe('invite acceptance recovery', () => {
  let store: Awaited<ReturnType<typeof createDatabase>>;
  const app = Fastify();
  const db = () => store.db;
  const origin = 'http://127.0.0.1:3101';
  const owner = { id: randomUUID(), name: 'Invite owner fixture', email: 'invite-owner@example.test' };

  beforeAll(async () => {
    store = await createDatabase();
    await migrateAuth(db());
    await migrateMembers(db());
    await migrate(db());
    await migrateMemberDataRights(db());
    await db().insertInto('user').values(owner).execute();
    await db().insertInto('workspace_owner').values({ id: 1, owner_id: owner.id }).execute();

    const auth = createAuth(db(), { secret: 'fixture-invite-recovery-key-00000000001', webOrigin: origin, production: false });
    setAuthSessionCreationCheck(auth, assertDeletionCanSignIn);
    await registerAuditedMemberRoutes(app, {
      db: db(), auth, webOrigin: origin, dailyRuns: 1, imagesAvailable: () => false, adsAvailable: () => false,
      owner: async () => owner, role: async () => 'owner',
    }, registerMemberRoutes);
  });

  afterAll(async () => {
    await app.close();
    await store?.close();
  });

  it.each([
    { phase: 'discarding the signup session', event: 'AFTER DELETE ON session' },
    { phase: 'inserting the membership', event: 'BEFORE INSERT ON workspace_members' },
  ])('rolls back a failure while $phase and accepts the same invite once on retry', async ({ event }) => {
    const name = 'Invite recovery fixture';
    const email = `${randomUUID()}@example.test`;
    const issued = await app.inject({ method: 'POST', url: '/api/members/invites', payload: { name, email } });
    expect(issued.statusCode).toBe(200);
    const { id, url } = issued.json<{ id: string; url: string }>();
    const token = new URL(url).hash.slice('#invite='.length);
    const password = `Fixture-${randomUUID()}`;
    const accept = () => app.inject({ method: 'POST', url: '/api/invites/accept', payload: { token, name, password } });
    const invite = () => db().selectFrom('workspace_invites').select(['claimed_at', 'consumed_by']).where('id', '=', id).executeTakeFirstOrThrow();
    const uses = () => db().selectFrom('workspace_member_audit').select(['target_id', 'actor_id'])
      .where('target_id', '=', id).where('action', '=', 'invite_used').execute();
    const members = () => db().selectFrom('workspace_members').select(['user_id', 'role']).where('invite_id', '=', id).execute();
    const accountsBefore = await db().selectFrom('account').select('id').orderBy('id').execute();

    // Sequence increments survive transaction rollback (retrieved 2026-11-27).
    // https://www.postgresql.org/docs/current/functions-sequence.html
    await sql`CREATE SEQUENCE invite_recovery_fixture_attempt`.execute(db());
    await sql`CREATE FUNCTION fail_invite_recovery_fixture_once() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF nextval('invite_recovery_fixture_attempt') = 1 THEN
          RAISE EXCEPTION 'Forced invite acceptance failure';
        END IF;
        RETURN NEW;
      END;
    $$`.execute(db());
    await sql`CREATE TRIGGER fail_invite_recovery_fixture ${sql.raw(event)}
      FOR EACH ROW EXECUTE FUNCTION fail_invite_recovery_fixture_once()`.execute(db());

    try {
      const failed = await accept();
      expect(failed.statusCode).toBe(500);
      expect(failed.json().message).toBe('Forced invite acceptance failure');
      expect(await invite()).toEqual({ claimed_at: null, consumed_by: null });
      expect(await db().selectFrom('user').select('id').where('email', '=', email).executeTakeFirst()).toBeUndefined();
      expect(await db().selectFrom('account').select('id').orderBy('id').execute()).toEqual(accountsBefore);
      expect(await db().selectFrom('session').select('id').execute()).toEqual([]);
      expect(await members()).toEqual([]);
      expect(await uses()).toEqual([]);

      const inspected = await app.inject({ method: 'POST', url: '/api/invites/inspect', payload: { token } });
      expect(inspected.statusCode).toBe(200);
      const retried = await accept();
      expect(retried.statusCode).toBe(200);
      expect(retried.json()).toEqual({ ok: true, email });
      expect(retried.headers['set-cookie']).toBeUndefined();
      expect((await accept()).statusCode).toBe(404);

      const [user] = await db().selectFrom('user').select('id').where('email', '=', email).execute();
      expect(user).toBeDefined();
      const userId = user!.id;
      expect(await invite()).toMatchObject({ claimed_at: expect.any(Date), consumed_by: userId });
      expect(await members()).toEqual([{ user_id: userId, role: 'member' }]);
      expect(await db().selectFrom('account').select('userId').where('userId', '=', userId).execute()).toEqual([{ userId }]);
      expect(await db().selectFrom('session').select('id').execute()).toEqual([]);
      expect(await uses()).toEqual([{ target_id: id, actor_id: userId }]);
    } finally {
      await sql`DROP FUNCTION fail_invite_recovery_fixture_once() CASCADE`.execute(db());
      await sql`DROP SEQUENCE invite_recovery_fixture_attempt`.execute(db());
    }
  });
});
