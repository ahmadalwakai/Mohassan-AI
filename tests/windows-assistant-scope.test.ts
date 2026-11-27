import { createHash, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '@mohassan/database';
import { registerWindowsRoutes, revokeWindowsSession, windowsMigration, type WindowsOrigin } from '@mohassan/windows';
import { migrateAuth } from '../apps/server/src/auth.js';

const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const action = { type: 'key', key: 'Escape' };
let database: Awaited<ReturnType<typeof createDatabase>>;
beforeAll(async () => { database = await createDatabase({}); await migrateAuth(database.db); await windowsMigration(database.db); });
afterAll(async () => { await database?.close(); });
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });

/** Real PGlite authorization/queue domain. No companion is connected, so no desktop command is delivered. */
async function fixture(pauseNextTransaction = false) {
  const owner = `windows-scope-owner-${randomUUID()}`, sessionId = randomUUID();
  const deviceId = randomUUID(), grantId = randomUUID(), targetKey = 'a'.repeat(64), epoch = randomUUID();
  const sessionBinding = `session:${hash(sessionId)}`;
  await database.db.insertInto('user').values({ id: owner, name: 'Synthetic owner', email: `${owner}@example.test` }).execute();
  await database.db.insertInto('session').values({ id: sessionId, userId: owner, token: randomUUID(), expiresAt: new Date(Date.now() + 60000) }).execute();
  const state = { approvalNonce: epoch, sessionId: 1, safeDesktop: true, localView: true, localControl: true,
    target: { key: targetKey, mode: 'window', title: 'Synthetic scope window', width: 800, height: 600 }, status: 'isolated fixture' };
  const frame = { id: randomUUID(), targetKey, capturedAt: new Date().toISOString(), width: 800, height: 600,
    jpeg: Buffer.concat([Buffer.from([255, 216, 255]), Buffer.alloc(150), Buffer.from([255, 217])]).toString('base64'), elements: [] };
  await database.db.insertInto('windows_devices').values({ id: deviceId, owner_id: owner, name: 'Synthetic device A', key_hash: hash('synthetic-device-key'),
    last_seen_at: new Date(), state: JSON.stringify(state), last_frame: JSON.stringify({ ...frame, receivedAt: new Date().toISOString() }) }).execute();
  await database.db.insertInto('windows_grants').values({ id: grantId, owner_id: owner, device_id: deviceId, session_binding: sessionBinding,
    scope: 'control', target_key: targetKey, approval_nonce: epoch, expires_at: new Date(Date.now() + 30000) }).execute();
  let armed = false, entered = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  // Pause BEFORE the actual queue transaction acquires its connection. The
  // outside grant lookup has finished; another real grant TX can now commit.
  const controlledDb = new Proxy(database.db, { get(target, property) {
    if (property === 'transaction') return () => {
      const builder = target.transaction();
      return new Proxy(builder, { get(transaction, member) {
        if (member === 'execute') return async (callback: Parameters<typeof builder.execute>[0]) => {
          if (armed) { armed = false; entered = true; await gate; }
          return builder.execute(callback);
        };
        const value = Reflect.get(transaction, member, transaction);
        return typeof value === 'function' ? value.bind(transaction) : value;
      } });
    };
    const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const app = Fastify({ logger: false }); apps.push(app);
  app.setErrorHandler((error, _request, reply) => { const failure = error as { statusCode?: number; code?: string; message?: string };
    reply.code(failure.statusCode ?? 500).send({ error: { code: failure.code ?? 'ERROR', message: failure.message } }); });
  const native = await registerWindowsRoutes(app, { db: controlledDb, owner: async request => {
    if (request.headers['x-synthetic-owner'] !== owner) throw Object.assign(new Error('Synthetic unauthorized owner'), { statusCode: 401 }); return { id: owner, sessionId };
  }, lockOwnerAccess: async (_tx, id) => id === owner, config: { webOrigin: 'http://127.0.0.1:3000', production: false, windowsEnabled: true } });
  const control = { ...native,
    view: (...args: Parameters<typeof native.view>) => native.runInSession(owner, sessionId, () => native.view(...args)),
    act: (...args: Parameters<typeof native.act>) => native.runInSession(owner, sessionId, () => native.act(...args)),
  };
  await app.ready();
  const replaceGrant = async (key = targetKey, approvalNonce = epoch) => {
    const response = await app.inject({ method: 'POST', url: `/api/windows/devices/${deviceId}/grants`,
      headers: { 'x-synthetic-owner': owner }, payload: { scope: 'control', durationSeconds: 30, targetKey: key, approvalNonce } });
    expect(response.statusCode, response.body).toBe(200); return response.json() as { id: string };
  };
  return { owner, sessionId, sessionBinding, deviceId, grantId, targetKey, epoch, state, frame, control, app, replaceGrant,
    arm() { expect(pauseNextTransaction).toBe(true); armed = true; }, entered: () => entered, release,
    commands: () => database.db.selectFrom('windows_commands').selectAll().where('owner_id', '=', owner).execute() };
}

describe('native Windows assistant origin fence with actual PGlite grant state', () => {
  it('exposes genuine device/grant/window origin and permits a fresh frame within that same scope', async () => {
    const f = await fixture(), observed = await f.control.view(f.owner);
    expect(f.control.requiresViewOrigin).toBe(true);
    expect(observed.origin).toEqual({ deviceId: f.deviceId, grantId: f.grantId, targetKey: f.targetKey });
    const fresh = { ...f.frame, id: randomUUID(), capturedAt: new Date().toISOString() };
    await database.db.updateTable('windows_devices').set({ last_seen_at: new Date(), last_frame: JSON.stringify({ ...fresh, receivedAt: new Date().toISOString() }) })
      .where('id', '=', f.deviceId).execute();
    const queued = await f.control.act(f.owner, fresh.id, action, observed.origin);
    expect(queued.status).toBe('queued'); expect(await f.commands()).toEqual([expect.objectContaining({ grant_id: f.grantId, frame_id: fresh.id, status: 'queued' })]);
  });
  it('does not reuse a still-fresh same-window frame under a replacement grant', async () => {
    const f = await fixture(), observed = await f.control.view(f.owner), replacement = await f.replaceGrant();
    expect(replacement.id).not.toBe(f.grantId);
    await expect(f.control.act(f.owner, f.frame.id, action, observed.origin)).rejects.toMatchObject({ code: 'COMPUTER_SCOPE_CHANGED' });
    expect(await f.commands()).toEqual([]);
  });
  it('rechecks the expected grant inside the actual transaction after an outside lookup/replacement race', async () => {
    const f = await fixture(true), observed = await f.control.view(f.owner); f.arm();
    const pending = f.control.act(f.owner, f.frame.id, action, observed.origin).then(value => ({ value }), error => ({ error }));
    try {
      await expect.poll(f.entered).toBe(true); await f.replaceGrant();
    } finally { f.release(); }
    const outcome = await pending;
    expect(outcome).toMatchObject({ error: { code: 'COMPUTER_SCOPE_CHANGED' } }); expect(await f.commands()).toEqual([]);
  });
  it('does not silently follow a new target window and consent epoch', async () => {
    const f = await fixture(), observed = await f.control.view(f.owner), nextKey = 'b'.repeat(64), nextEpoch = randomUUID();
    const nextFrame = { ...f.frame, id: randomUUID(), targetKey: nextKey, capturedAt: new Date().toISOString() };
    await database.db.updateTable('windows_devices').set({ last_seen_at: new Date(), state: JSON.stringify({ ...f.state, approvalNonce: nextEpoch,
      target: { ...f.state.target, key: nextKey, title: 'Synthetic window B' } }), last_frame: JSON.stringify({ ...nextFrame, receivedAt: new Date().toISOString() }) })
      .where('id', '=', f.deviceId).execute();
    await f.replaceGrant(nextKey, nextEpoch);
    await expect(f.control.act(f.owner, nextFrame.id, action, observed.origin)).rejects.toMatchObject({ code: 'COMPUTER_SCOPE_CHANGED' });
    expect(await f.commands()).toEqual([]);
  });
  it('binds device identity even when another permitted device has the same target key', async () => {
    const f = await fixture(), observed = await f.control.view(f.owner), secondDevice = randomUUID(), secondGrant = randomUUID();
    await database.db.insertInto('windows_devices').values({ id: secondDevice, owner_id: f.owner, name: 'Synthetic device B', key_hash: hash('synthetic-device-key-b'),
      created_at: new Date(Date.now() + 10), last_seen_at: new Date(), state: JSON.stringify(f.state), last_frame: JSON.stringify({ ...f.frame, receivedAt: new Date().toISOString() }) }).execute();
    await database.db.insertInto('windows_grants').values({ id: secondGrant, owner_id: f.owner, device_id: secondDevice, session_binding: f.sessionBinding,
      scope: 'control', target_key: f.targetKey, approval_nonce: f.epoch, expires_at: new Date(Date.now() + 30000) }).execute();
    await expect(f.control.act(f.owner, f.frame.id, action, observed.origin)).rejects.toMatchObject({ code: 'COMPUTER_SCOPE_CHANGED' });
    expect(await f.commands()).toEqual([]);
  });
  it.each(['session', 'local_consent'] as const)('retains %s revocation fences without creating a command', async revoked => {
    const f = await fixture(), observed = await f.control.view(f.owner);
    if (revoked === 'session') await revokeWindowsSession(database.db, f.sessionId);
    else await database.db.updateTable('windows_devices').set({ state: JSON.stringify({ ...f.state, localControl: false }) }).where('id', '=', f.deviceId).execute();
    await expect(f.control.act(f.owner, f.frame.id, action, observed.origin)).rejects.toMatchObject({ code: 'WINDOWS_GRANT_REQUIRED' }); expect(await f.commands()).toEqual([]);
  });
  it('rejects malformed expected origin before dispatch without weakening the bounded legacy domain API', async () => {
    const f = await fixture();
    await expect(f.control.act(f.owner, f.frame.id, action, { deviceId: f.deviceId, grantId: 'invalid', targetKey: f.targetKey } as WindowsOrigin))
      .rejects.toMatchObject({ code: 'COMPUTER_SCOPE_CHANGED' }); expect(await f.commands()).toEqual([]);
    // Programmatic legacy callers still have current owner/session/grant/frame
    // validation, but no guarantee binding a previous assistant observation.
    expect((await f.control.act(f.owner, f.frame.id, action)).status).toBe('queued');
  });
  it.each([1, 2])('rolls all queue effects back when the host fence rejects at transaction boundary %s', async rejectedCall => {
    const f = await fixture(), observed = await f.control.view(f.owner);
    const failure = Object.assign(new Error('Synthetic durable host fence rejected'), { code: 'SYNTHETIC_HOST_FENCE' });
    let calls = 0, originalTransaction: unknown;
    const inputOptions = { hostMarker: 'not serialized', async fence(this: { hostMarker: string }, transaction: typeof database.db) {
      expect(this.hostMarker).toBe('not serialized'); calls++;
      if (calls === 1) originalTransaction = transaction; else expect(transaction).toBe(originalTransaction);
      const commands = await transaction.selectFrom('windows_commands').select('id').where('owner_id', '=', f.owner).execute();
      expect(commands).toHaveLength(calls === 1 ? 0 : 1);
      if (calls === rejectedCall) throw failure;
    } };
    await expect(f.control.act(f.owner, f.frame.id, action, observed.origin, inputOptions)).rejects.toBe(failure);
    expect(calls).toBe(rejectedCall); expect(await f.commands()).toEqual([]);
    expect((await database.db.selectFrom('windows_grants').select('next_sequence').where('id', '=', f.grantId).executeTakeFirstOrThrow()).next_sequence).toBe(1);
    expect(await database.db.selectFrom('windows_audit').select('id').where('owner_id', '=', f.owner).where('type', '=', 'input_requested').execute()).toEqual([]);
  });
  it('rechecks an AbortSignal after an awaited final fence and rolls back the uncommitted queue record', async () => {
    const f = await fixture(), observed = await f.control.view(f.owner), controller = new AbortController();
    const failure = new Error('Synthetic cancellation during final queue fence'); let calls = 0;
    await expect(f.control.act(f.owner, f.frame.id, action, observed.origin, { signal: controller.signal, fence: async () => {
      if (++calls === 2) { await Promise.resolve(); controller.abort(failure); }
    } })).rejects.toBe(failure);
    expect(calls).toBe(2); expect(await f.commands()).toEqual([]);
    expect((await database.db.selectFrom('windows_grants').select('next_sequence').where('id', '=', f.grantId).executeTakeFirstOrThrow()).next_sequence).toBe(1);
  });
});
