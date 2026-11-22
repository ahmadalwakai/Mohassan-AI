import { afterEach, describe, expect, it } from 'vitest';
import { sql, type CompiledQuery } from 'kysely';
import { createDatabase } from '@mohassan/database';
import { lockOwnerToolAccess } from '../apps/server/src/owner-tool-authorization.js';
import { roleOf } from '../apps/server/src/members.js';

const handles: Awaited<ReturnType<typeof createDatabase>>[] = [];
async function database() {
  const handle = await createDatabase({});expect(handle.mode).toBe('embedded');handles.push(handle);
  // The canonical role resolver reads only these production grant columns.
  await sql`CREATE TABLE workspace_owner(id integer PRIMARY KEY, owner_id text NOT NULL)`.execute(handle.db);
  await sql`CREATE TABLE workspace_members(user_id text PRIMARY KEY, role text NOT NULL CHECK(role IN ('owner','member')), disabled_at timestamptz)`.execute(handle.db);
  return handle;
}
afterEach(async () => { for (const handle of handles.splice(0)) await handle.close(); });

async function evaluate(options: { ownerId: string; primary?: string; membership?: 'owner' | 'member'; disabled?: boolean }) {
  const handle = await database();
  if (options.primary) await handle.db.insertInto('workspace_owner').values({ id: 1, owner_id: options.primary }).execute();
  if (options.membership) await handle.db.insertInto('workspace_members').values({ user_id: options.ownerId, role: options.membership,
    disabled_at: options.disabled ? new Date() : null }).execute();
  const queries: CompiledQuery[] = [];
  const result = await handle.db.transaction().execute(async tx => {
    const compiler = tx.getExecutor();
    const observed = tx.withPlugin({ transformQuery(input) {
      queries.push(compiler.compileQuery(input.node, input.queryId));return input.node;
    }, async transformResult(input) { return input.result; } });
    expect(observed.isTransaction).toBe(true);
    const allowed = await lockOwnerToolAccess(observed, options.ownerId);
    return { allowed, canonicalRole: await roleOf(tx, options.ownerId) };
  });
  return { ...result, queries };
}

describe('owner-only native queue grant lock using the caller transaction', () => {
  it('locks the matching primary owner grant before canonical role resolution', async () => {
    const result = await evaluate({ ownerId: 'primary-owner', primary: 'primary-owner' });
    expect(result.allowed).toBe(true);expect(result.canonicalRole).toBe('owner');expect(result.queries).toHaveLength(2);
    expect(result.queries[0].sql).toMatch(/from "workspace_owner" .*for share$/iu);
    expect(result.queries[0].parameters).toEqual([1, 'primary-owner']);
    expect(result.queries[1].sql).toContain('SELECT EXISTS');
    expect(result.queries.some(query => query.sql.includes('from "workspace_members"'))).toBe(false);
  });
  it('locks an active additional-owner membership after the primary owner path misses', async () => {
    const result = await evaluate({ ownerId: 'additional-owner', primary: 'different-primary', membership: 'owner' });
    expect(result.allowed).toBe(true);expect(result.canonicalRole).toBe('owner');expect(result.queries).toHaveLength(3);
    expect(result.queries[0].sql).toMatch(/from "workspace_owner" .*for share$/iu);
    expect(result.queries[1].sql).toMatch(/from "workspace_members" .*for share$/iu);
    expect(result.queries[1].sql).toContain('"disabled_at" is null');
    expect(result.queries[1].parameters).toEqual(['additional-owner', 'owner']);
    expect(result.queries[2].sql).toContain('SELECT EXISTS');
  });
  it.each([
    { ownerId: 'active-member', primary: 'different-primary', membership: 'member' as const, expected: 'member' },
    { ownerId: 'disabled-extra-owner', primary: 'different-primary', membership: 'owner' as const, disabled: true, expected: null },
    { ownerId: 'disabled-member', membership: 'member' as const, disabled: true, expected: null },
    { ownerId: 'foreign-user', primary: 'another-owner', expected: null },
    { ownerId: 'no-grant', expected: null },
  ])('does not grant owner tools to $ownerId or change its canonical account role', async options => {
    const result = await evaluate(options);
    expect(result.allowed).toBe(false);expect(result.canonicalRole).toBe(options.expected);expect(result.queries).toHaveLength(2);
    expect(result.queries.every(query => /for share$/iu.test(query.sql))).toBe(true);
    expect(result.queries.some(query => query.sql.includes('SELECT EXISTS'))).toBe(false);
  });
  it('preserves canonical primary-owner precedence over a disabled membership row', async () => {
    const result = await evaluate({ ownerId: 'canonical-primary', primary: 'canonical-primary', membership: 'member', disabled: true });
    expect(result.allowed).toBe(true);expect(result.canonicalRole).toBe('owner');expect(result.queries).toHaveLength(2);
    expect(result.queries[0].sql).toMatch(/from "workspace_owner" .*for share$/iu);
  });
  it('parameterizes grant identity instead of interpreting SQL-looking owner text', async () => {
    const id = "owner' OR true --";
    const result = await evaluate({ ownerId: id, primary: 'another-owner' });
    expect(result.allowed).toBe(false);expect(result.queries[0].parameters).toEqual([1, id]);
    expect(result.queries[0].sql).not.toContain(id);
  });
  it('fails closed outside a transaction instead of releasing a grant lock before admission', async () => {
    const handle = await database();await handle.db.insertInto('workspace_owner').values({ id: 1, owner_id: 'primary-owner' }).execute();
    expect(await lockOwnerToolAccess(handle.db, 'primary-owner')).toBe(false);
    expect(await roleOf(handle.db, 'primary-owner')).toBe('owner');
  });
  it('uses current transaction writes and leaves the grant unchanged', async () => {
    const handle = await database();await handle.db.insertInto('workspace_members').values({ user_id: 'additional-owner', role: 'owner', disabled_at: null }).execute();
    await handle.db.transaction().execute(async tx => {
      expect(await lockOwnerToolAccess(tx, 'additional-owner')).toBe(true);
      await tx.updateTable('workspace_members').set({ role: 'member' }).where('user_id', '=', 'additional-owner').execute();
      expect(await lockOwnerToolAccess(tx, 'additional-owner')).toBe(false);
      expect(await roleOf(tx, 'additional-owner')).toBe('member');
    });
    expect(await handle.db.selectFrom('workspace_members').selectAll().execute()).toEqual([{ user_id: 'additional-owner', role: 'member', disabled_at: null }]);
  });
});
