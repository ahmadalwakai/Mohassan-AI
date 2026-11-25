import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, migrate, sql } from '@mohassan/database';
import { migrateAuth } from '../apps/server/src/auth.js';
import { migrateMembers } from '../apps/server/src/members.js';
import { migrateMemberDataRights } from '../apps/server/src/member-data-migration.js';
import { listMemberAudit, recordMemberAudit, withMemberAuditActor } from '../apps/server/src/member-audit.js';
import { endMemberSessions, endOtherAccountSessions, listAccountSessions, memberAuthClientIp, sessionIpPrefix } from '../apps/server/src/member-sessions.js';

const ownerId = 'owner-fixture';
const otherOwnerId = 'second-owner-fixture';
const memberId = 'member-fixture';
const otherMemberId = 'second-member-fixture';

// Documentation ranges from RFC 5737 §3 and RFC 3849 §2 (retrieved 2026-11-25).
// https://www.rfc-editor.org/rfc/rfc5737.html#section-3
// https://www.rfc-editor.org/rfc/rfc3849.html#section-2
const ipv4 = '203.0.113.197';
const ipv6 = '2001:db8:1:2:3:4:5:6';

describe('member sessions and administration audit', () => {
  let database: Awaited<ReturnType<typeof createDatabase>>;
  const db = () => database.db;

  beforeAll(async () => {
    database = await createDatabase();
    await migrateAuth(db());
    await migrateMembers(db());
    await migrate(db());
    await migrateMemberDataRights(db());
    await migrateMemberDataRights(db());
    for (const id of [ownerId, otherOwnerId, memberId, otherMemberId]) {
      await db().insertInto('user').values({ id, name: id, email: `${id}@example.test` }).execute();
    }
    await db().insertInto('workspace_owner').values({ id: 1, owner_id: ownerId }).execute();
    await db().insertInto('workspace_members').values([
      { user_id: otherOwnerId, role: 'owner' }, { user_id: memberId, role: 'member' }, { user_id: otherMemberId, role: 'member' },
    ]).execute();
  });

  afterAll(async () => { await database?.close(); });

  it('uses only validated internal IPs and masks IPv4, mapped IPv4 and IPv6', () => {
    expect(memberAuthClientIp({ headers: { 'x-mohassan-client-ip': ipv4 }, ip: ipv6 }, true)).toBe(ipv4);
    expect(memberAuthClientIp({ headers: { 'x-forwarded-for': ipv4 }, ip: ipv6 }, true)).toBeUndefined();
    expect(memberAuthClientIp({ headers: { 'x-mohassan-client-ip': `${ipv4}, ${ipv6}` }, ip: ipv6 }, false)).toBe(ipv6);
    expect(sessionIpPrefix(ipv4)).toBe('203.0.113.0/24');
    expect(sessionIpPrefix(ipv6)).toBe('2001:db8:1:2::/64');
    expect(sessionIpPrefix(`::ffff:${ipv4}`)).toBe('203.0.113.0/24');
    expect(sessionIpPrefix('::ffff:cb00:71c5')).toBe('203.0.113.0/24');
    expect(sessionIpPrefix('2001:db8::ff00:42:8329')).toBe('2001:db8::/64');
    expect(sessionIpPrefix('private-invalid-ip-fixture')).toBeNull();
  });

  it('lists only active sessions of the account and preserves the caller when ending others', async () => {
    const lastSeen = new Date();
    const future = new Date(lastSeen.getTime() + 60_000);
    const expired = new Date(lastSeen.getTime() - 60_000);
    // Reduced Chrome UA pattern from https://developer.chrome.com/docs/privacy-security/user-agent-client-hints (2026-11-25).
    const userAgent = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Mobile Safari/537.36';
    const sessions = [
      { id: 'member-active-1', userId: memberId, expiresAt: future, ipAddress: ipv4, userAgent },
      { id: 'member-active-2', userId: memberId, expiresAt: future, ipAddress: ipv6, userAgent: 'fixture-agent-private' },
      { id: 'member-expired', userId: memberId, expiresAt: expired },
      { id: 'another-member-active', userId: otherMemberId, expiresAt: future },
      { id: 'owner-active', userId: ownerId, expiresAt: future },
    ];
    for (const session of sessions) {
      await db().insertInto('session').values({ ...session, updatedAt: lastSeen, token: `fixture-token-${session.id}` }).execute();
    }

    expect(await listAccountSessions(db(), memberId, 'member-active-1')).toEqual([
      { id: 'member-active-1', deviceLabel: 'Android · Chrome', ipPrefix: '203.0.113.0/24', lastSeen: lastSeen.toISOString(), current: true },
      { id: 'member-active-2', deviceLabel: 'جهاز غير معروف', ipPrefix: '2001:db8:1:2::/64', lastSeen: lastSeen.toISOString(), current: false },
    ]);
    await expect(endOtherAccountSessions(db(), memberId, 'another-member-active')).rejects.toMatchObject({ statusCode: 401 });
    await expect(endOtherAccountSessions(db(), memberId, 'member-active-1')).resolves.toEqual({ ended: 1 });
    await expect(endOtherAccountSessions(db(), memberId, 'member-active-1')).resolves.toEqual({ ended: 0 });
    expect((await listAccountSessions(db(), memberId, 'member-active-1')).map(row => row.id)).toEqual(['member-active-1']);
    expect((await listAccountSessions(db(), otherMemberId, 'another-member-active')).map(row => row.id)).toEqual(['another-member-active']);

    await expect(endMemberSessions(db(), ownerId)).rejects.toMatchObject({ statusCode: 404 });
    await expect(endMemberSessions(db(), otherOwnerId)).rejects.toMatchObject({ statusCode: 404 });
    await expect(endMemberSessions(db(), memberId)).resolves.toEqual({ ended: 1 });
    expect(await listAccountSessions(db(), memberId, 'member-active-1')).toEqual([]);
    expect((await listAccountSessions(db(), ownerId, 'owner-active')).map(row => row.id)).toEqual(['owner-active']);
    expect((await listAccountSessions(db(), otherMemberId, 'another-member-active')).map(row => row.id)).toEqual(['another-member-active']);
  });

  it('retains one session when two devices try to end the other concurrently', async () => {
    const left = 'member-left';
    const right = 'member-right';
    for (const id of [left, right]) {
      await db().insertInto('session').values({
        id, userId: memberId, expiresAt: new Date(Date.now() + 60_000), token: `fixture-token-${id}`,
      }).execute();
    }
    const results = await Promise.allSettled([
      endOtherAccountSessions(db(), memberId, left), endOtherAccountSessions(db(), memberId, right),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toEqual([{ status: 'fulfilled', value: { ended: 1 } }]);
    expect(results.filter(result => result.status === 'rejected')).toMatchObject([{ status: 'rejected', reason: { statusCode: 401 } }]);
    expect(await listAccountSessions(db(), memberId, left)).toHaveLength(1);
  });

  it('appends committed membership changes, records the actor and rejects rewrites', async () => {
    const invite = (id: string, creatorId: string) => ({
      id, token_hash: `fixture-hash-${id}`, email: `${id}@example.test`, name: id, created_by: creatorId,
      expires_at: new Date(Date.now() + 60_000),
    });
    await db().insertInto('workspace_invites').values(invite('original-invite', ownerId)).execute();
    await withMemberAuditActor(db(), otherOwnerId, async tx => {
      await tx.updateTable('workspace_invites').set({ revoked_at: new Date() }).where('id', '=', 'original-invite').execute();
      await tx.insertInto('workspace_invites').values(invite('replacement-invite', otherOwnerId)).execute();
    });
    await db().updateTable('workspace_invites').set({ consumed_by: memberId }).where('id', '=', 'replacement-invite').execute();
    await db().updateTable('workspace_invites').set({ consumed_by: null }).where('id', '=', 'replacement-invite').execute();
    await withMemberAuditActor(db(), ownerId, async tx => {
      await tx.updateTable('workspace_members').set({ disabled_at: new Date() }).where('user_id', '=', memberId).execute();
      await tx.updateTable('workspace_members').set({ disabled_at: new Date() }).where('user_id', '=', memberId).execute();
    });
    await expect(withMemberAuditActor(db(), ownerId, async tx => {
      await tx.updateTable('workspace_members').set({ disabled_at: null }).where('user_id', '=', memberId).execute();
      throw new Error('rollback fixture');
    })).rejects.toThrow('rollback fixture');
    await withMemberAuditActor(db(), otherOwnerId, async tx => {
      await tx.updateTable('workspace_members').set({ disabled_at: null }).where('user_id', '=', memberId).execute();
    });
    await recordMemberAudit(db(), { actorId: memberId, targetId: memberId, action: 'export_downloaded' });

    const { entries } = await listMemberAudit(db());
    expect(entries.map(({ actorId, targetId, action }) => [actorId, targetId, action])).toEqual([
      [memberId, memberId, 'export_downloaded'],
      [otherOwnerId, memberId, 'member_unsuspended'],
      [ownerId, memberId, 'member_suspended'],
      [memberId, 'replacement-invite', 'invite_used'],
      [otherOwnerId, 'replacement-invite', 'invite_created'],
      [otherOwnerId, 'original-invite', 'invite_revoked'],
      [ownerId, 'original-invite', 'invite_created'],
    ]);
    expect(entries.every(entry => Object.keys(entry).sort().join(',') === 'action,actorId,id,occurredAt,targetId')).toBe(true);
    await expect(sql`UPDATE workspace_member_audit SET target_id = 'changed'`.execute(db())).rejects.toThrow('Member audit is append only');
    await expect(sql`DELETE FROM workspace_member_audit`.execute(db())).rejects.toThrow('Member audit is append only');
    await expect(sql`TRUNCATE workspace_member_audit`.execute(db())).rejects.toThrow('Member audit is append only');
    const page = await listMemberAudit(db(), { limit: 2 });
    expect(page.entries).toEqual(entries.slice(0, 2));
    expect((await listMemberAudit(db(), { beforeId: page.nextBeforeId! })).entries).toEqual(entries.slice(2));
  });
});
