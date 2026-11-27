import { createDatabase, migrate } from '@mohassan/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApplication } from '../apps/server/src/app.js';
import { migrateAuth } from '../apps/server/src/auth.js';
import { migrateMemberAccountRecovery } from '../apps/server/src/member-account-recovery-migration.js';
import { listMemberAudit, recordMemberAudit } from '../apps/server/src/member-audit.js';
import { migrateMemberDataRights } from '../apps/server/src/member-data-migration.js';
import { migrateMembers } from '../apps/server/src/members.js';

const origin = 'http://127.0.0.1:3000';
const internalSecret = 'account-change-fixture-internal-secret';
const setupToken = 'account-change-fixture-setup-secret';
const owner = { name: 'Change fixture', email: 'change-owner@example.test', password: 'initial-owner-fixture-password' };
const member = { name: 'Member fixture', email: 'change-member@example.test', password: 'initial-member-fixture-password' };
const newPassword = 'replacement-owner-fixture-password';
const changePath = '/api/member-data/password';
const cookieOf = (value: string | string[] | undefined) => [value].flat().filter(Boolean).map(item => item!.split(';')[0]).join('; ');

describe('self-service account password change', () => {
  let application: Awaited<ReturnType<typeof createApplication>>;
  let setupOwnerCookie: string;
  let nextAddress = 1;
  const headers = (cookie?: string) => ({ origin, 'x-mohassan-internal': internalSecret, ...(cookie ? { cookie } : {}) });
  // Use distinct fixture clients from TEST-NET-2 to avoid unrelated sign-in throttling.
  // https://www.rfc-editor.org/rfc/rfc5737.html (retrieved 2026-11-27)
  const signIn = (email: string, password: string) => application.app.inject({
    method: 'POST', url: '/api/auth/sign-in/email', payload: { email, password },
    headers: { ...headers(), 'x-mohassan-client-ip': `198.51.100.${nextAddress++}` },
  });
  const change = (cookie: string, currentPassword: string, replacement: string) => application.app.inject({
    method: 'POST', url: changePath, headers: headers(cookie), payload: { currentPassword, newPassword: replacement },
  });
  const access = (cookie: string) => application.app.inject({ url: '/api/access', headers: headers(cookie) });

  beforeAll(async () => {
    application = await createApplication({
      authSecret: 'account-change-fixture-auth-secret-000', internalSecret, setupToken,
      webOrigin: origin, production: false, runWorker: false,
    });
    const setup = await application.app.inject({
      method: 'POST', url: '/api/setup', headers: headers(), payload: { ...owner, setupToken },
    });
    expect(setup.statusCode).toBe(200);
    const signedIn = await signIn(owner.email, owner.password);
    expect(signedIn.statusCode).toBe(200);
    setupOwnerCookie = cookieOf(signedIn.headers['set-cookie']);
    const invite = await application.app.inject({ method: 'POST', url: '/api/members/invites',
      headers: headers(setupOwnerCookie), payload: { name: member.name, email: member.email } });
    expect(invite.statusCode).toBe(200);
    const token = new URL(invite.json().url).hash.slice('#invite='.length);
    const joined = await application.app.inject({ method: 'POST', url: '/api/invites/accept', headers: headers(),
      payload: { token, name: member.name, password: member.password } });
    expect(joined.statusCode).toBe(200);
  });
  afterAll(async () => { await application?.app.close(); });

  it('checks the current password, rotates the cookie, revokes other sessions and audits the owner change', async () => {
    const other = await signIn(owner.email, owner.password);
    expect(other.statusCode).toBe(200);
    const currentCookie = setupOwnerCookie;
    const otherCookie = cookieOf(other.headers['set-cookie']);
    const ownerId = other.json().user.id;
    const passwordAudit = async () => (await listMemberAudit(application.database.db)).entries
      .filter(entry => entry.action === 'password_changed' && entry.targetId === ownerId);
    const wrong = await change(currentCookie, 'incorrect-password', newPassword);
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().error.code).toBe('PASSWORD_CONFIRMATION_FAILED');
    expect((await access(otherCookie)).statusCode).toBe(200);
    expect(await passwordAudit()).toEqual([]);

    const changed = await change(currentCookie, owner.password, newPassword);
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toEqual({ ok: true });
    const rotated = cookieOf(changed.headers['set-cookie']);
    expect(Boolean(rotated)).toBe(true);
    expect(rotated === currentCookie).toBe(false);
    expect((await access(rotated)).statusCode).toBe(200);
    expect((await access(currentCookie)).statusCode).toBe(401);
    expect((await access(otherCookie)).statusCode).toBe(401);
    expect((await signIn(owner.email, owner.password)).statusCode).toBe(401);
    expect((await signIn(owner.email, newPassword)).statusCode).toBe(200);
    expect(await passwordAudit()).toEqual([
      expect.objectContaining({ actorId: ownerId, targetId: ownerId, action: 'password_changed' }),
    ]);
  });

  it('lets a member change their own password during the deletion grace period and limits attempts', async () => {
    const beforeDeletion = await signIn(member.email, member.password);
    expect(beforeDeletion.statusCode).toBe(200);
    const pending = await application.app.inject({ method: 'POST', url: '/api/member-data/deletion',
      headers: headers(cookieOf(beforeDeletion.headers['set-cookie'])), payload: { password: member.password } });
    expect(pending.statusCode).toBe(200);

    const signedIn = await signIn(member.email, member.password);
    expect(signedIn.statusCode).toBe(200);
    const cookie = cookieOf(signedIn.headers['set-cookie']);
    const replacement = 'replacement-member-fixture-password';
    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await change(cookie, 'incorrect-password', replacement)).statusCode).toBe(403);
    }
    const changed = await change(cookie, member.password, replacement);
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toEqual({ ok: true });
    const rotated = cookieOf(changed.headers['set-cookie']);
    const memberAccess = await access(rotated);
    expect(memberAccess.statusCode).toBe(200);
    expect(memberAccess.json()).toMatchObject({ dataOnly: true, deletion: pending.json().deletion });
    expect((await change(rotated, replacement, member.password)).statusCode).toBe(429);
  });
});

it('upgrades the preceding audit constraint and preserves the existing append-only rows', async () => {
  const { db, close } = await createDatabase();
  try {
    await migrateAuth(db);
    await migrateMembers(db);
    await migrate(db);
    await migrateMemberDataRights(db);
    const actorId = 'recovery-migration-fixture';
    const historical = { actorId, targetId: actorId, action: 'export_downloaded' } as const;
    await recordMemberAudit(db, historical);
    const actions = ['password_changed', 'password_reset_issued', 'password_reset_used', 'member_sessions_ended'] as const;
    await expect(recordMemberAudit(db, { ...historical, action: actions[0] })).rejects.toThrow('workspace_member_audit_action_check');

    await migrateMemberAccountRecovery(db);
    await migrateMemberAccountRecovery(db);
    for (const action of actions) await recordMemberAudit(db, { ...historical, action });
    const { entries } = await listMemberAudit(db);
    expect(entries.map(({ action }) => action)).toEqual([...actions.toReversed(), historical.action]);
    await expect(db.deleteFrom('workspace_member_audit').execute()).rejects.toThrow('Member audit is append only');
  } finally {
    await close();
  }
});
