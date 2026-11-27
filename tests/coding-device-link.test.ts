import { createHash, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDatabase, migrate } from '@mohassan/database';
import { CODING_DEVICE_POLL_BODY_LIMIT, CODING_RESULT_HEADERS, type CodingJobKind, type CodingPollRequest } from '@mohassan/coding-link';
import { migrateAuth } from '../apps/server/src/auth.js';
import { createCodingDeviceLink, registerCodingDeviceRoutes } from '../apps/server/src/coding-link.js';
import { CODING_DEVICE_MIGRATION, migrateCodingDeviceLink } from '../apps/server/src/coding-link-migration.js';
import { migrateMembers } from '../apps/server/src/members.js';

const owner = { id: 'coding-device-owner', sessionId: 'coding-device-owner-session' };
const project = {
  id: randomUUID(), ownerId: owner.id, name: 'Coding device fixture', path: String.raw`C:\Projects\CodingDevice`,
  baseCommit: 'a'.repeat(40), testProfile: 'node-test' as const, allowedPaths: ['src/sum.ts'], createdAt: new Date().toISOString(),
};
const sandbox = { available: true, provider: 'stub', message: 'Stub sandbox' };
const pairingPath = '/api/coding/devices/pairing';
const devicesPath = '/api/coding/devices';
const pairPath = '/api/coding/device/pair';
const pollPath = '/api/coding/device/poll';

describe('coding device HTTP link', () => {
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let link: Awaited<ReturnType<typeof createCodingDeviceLink>>;
  let time = Date.now();
  let authentication = '';
  let deviceId = '';
  const app = Fastify();
  const db = () => database.db;
  const code = (response: { json: () => { error: { code: string } } }) => response.json().error.code;
  const readJob = (id: string) => db().selectFrom('coding_device_jobs').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  async function queued(kind: CodingJobKind) {
    return vi.waitFor(async () => {
      const row = await db().selectFrom('coding_device_jobs').selectAll().where('kind', '=', kind).where('status', '=', 'queued')
        .orderBy('created_at', 'desc').executeTakeFirst();
      expect(row).toBeDefined();
      return row!;
    }, { timeout: 2_000, interval: 20 });
  }
  function input(overrides: Partial<CodingPollRequest> = {}): CodingPollRequest {
    return {
      nonce: randomUUID(), sentAt: new Date(time).toISOString(), activeJobId: null, progress: [], result: null,
      status: { protocolVersion: 1, platform: 'win32', sandbox }, ...overrides,
    };
  }
  function poll(payload = input(), headers: Record<string, string> = {}) {
    return app.inject({ method: 'POST', url: pollPath, headers: { authorization: authentication, ...headers }, payload });
  }
  async function pairing(remoteAddress = '127.0.0.1') {
    const response = await app.inject({ method: 'POST', url: pairingPath, remoteAddress, payload: {} });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ code: string; expiresAt: string }>();
  }
  async function pair(pairCode: string) {
    return app.inject({ method: 'POST', url: pairPath, payload: { code: pairCode, name: 'Fixture PC' } });
  }
  function useCredentials(response: { json: () => { deviceId: string; deviceKey: string } }) {
    const credentials = response.json();
    deviceId = credentials.deviceId;
    authentication = `Bearer ${deviceId}.${credentials.deviceKey}`;
    return credentials;
  }

  beforeAll(async () => {
    database = await createDatabase();
    await migrateAuth(db());
    await migrateMembers(db());
    await migrate(db());
    await db().insertInto('user').values({ id: owner.id, name: 'Fixture owner', email: 'coding-device-owner@example.test' }).execute();
    await db().insertInto('workspace_owner').values({ id: 1, owner_id: owner.id }).execute();
    await db().insertInto('session').values({ id: owner.sessionId, userId: owner.id, token: 'fixture-session', expiresAt: new Date(time + 86_400_000) }).execute();
    await db().insertInto('coding_projects').values({
      id: project.id, owner_id: owner.id, name: project.name, repo_path: project.path, base_commit: project.baseCommit,
      test_profile: project.testProfile, allowed_paths: JSON.stringify(project.allowedPaths), scope_hash: 'fixture-scope',
    }).execute();
    link = await createCodingDeviceLink(db(), { enabled: true, now: () => time });
    await app.register(rateLimit, { global: false });
    registerCodingDeviceRoutes(app, link, async () => owner);
    await app.ready();
  }, 30_000);

  afterAll(async () => { await app.close(); await database?.close(); });

  it('records migration 070 once and preserves an existing server project', async () => {
    await migrateCodingDeviceLink(db());
    expect(await db().selectFrom('schema_migrations').select('version').where('version', '=', CODING_DEVICE_MIGRATION).execute()).toEqual([
      { version: CODING_DEVICE_MIGRATION },
    ]);
    expect(await db().selectFrom('coding_projects').select('location').where('id', '=', project.id).executeTakeFirstOrThrow())
      .toEqual({ location: 'server' });
    expect((await app.inject(devicesPath)).json()).toEqual({ enabled: true, devices: [] });
    await expect(link.run(owner.id, { kind: 'inspect', payload: { path: project.path } })).rejects
      .toMatchObject({ code: 'CODING_DEVICE_NOT_PAIRED', statusCode: 503 });
  });

  it('issues a 96-bit single-use code and persists hashes only', async () => {
    const token = await pairing();
    expect(Buffer.from(token.code, 'base64url')).toHaveLength(12);
    expect(new Date(token.expiresAt).getTime() - time).toBe(120_000);
    const storedCode = await db().selectFrom('coding_device_pairings').selectAll().executeTakeFirstOrThrow();
    expect(storedCode.code_hash).toBe(createHash('sha256').update(token.code).digest('hex'));

    const responses = await Promise.all([pair(token.code), pair(token.code)]);
    const accepted = responses.find(response => response.statusCode === 200);
    expect(responses.map(response => response.statusCode).sort()).toEqual([200, 401]);
    const credentials = useCredentials(accepted!);
    expect(Buffer.from(credentials.deviceKey, 'base64url')).toHaveLength(32);
    const storedKey = await db().selectFrom('coding_devices').selectAll().where('id', '=', deviceId).executeTakeFirstOrThrow();
    expect(storedKey.key_hash).toBe(createHash('sha256').update(credentials.deviceKey).digest('hex'));
    const response = await app.inject(devicesPath);
    expect(response.json()).toMatchObject({ devices: [{ id: deviceId, name: 'Fixture PC', online: false, lastSeenAt: null }] });
    expect(response.body).not.toContain(credentials.deviceKey);
    await expect(link.run(owner.id, { kind: 'inspect', payload: { path: project.path } })).rejects
      .toMatchObject({ code: 'CODING_DEVICE_OFFLINE', statusCode: 503 });
  });

  it('refuses browser traffic, off-loopback HTTP and spoofed forwarded HTTPS', async () => {
    for (const headers of [{ origin: '' }, { 'sec-fetch-site': 'same-origin' }] as Record<string, string>[]) {
      const response = await poll(input(), headers);
      expect(response.statusCode).toBe(403);
      expect(code(response)).toBe('CODING_DEVICE_BROWSER_DENIED');
    }
    const remote = '192.0.2.78';
    for (const headers of [{ authorization: authentication }, { authorization: authentication, 'x-forwarded-proto': 'https' }]) {
      const response = await app.inject({ method: 'POST', url: pollPath, headers, remoteAddress: remote, payload: input() });
      expect(response.statusCode).toBe(403);
      expect(code(response)).toBe('CODING_DEVICE_TLS_REQUIRED');
    }
    const denied = await poll(input(), { 'x-forwarded-for': remote, 'x-forwarded-proto': 'http' });
    expect(denied.statusCode).toBe(403);
    const allowed = await poll(input(), { 'x-forwarded-for': remote, 'x-forwarded-proto': 'https' });
    expect(allowed.statusCode, allowed.body).toBe(200);
  });

  it('refuses bad credentials, stale polls, replayed nonces, and incompatible versions', async () => {
    const badKey = await poll(input(), { authorization: authentication.replace(/.$/, char => char === 'A' ? 'B' : 'A') });
    expect(badKey.statusCode).toBe(401);
    const stale = await poll(input({ sentAt: new Date(time - 60_001).toISOString() }));
    expect(code(stale)).toBe('CODING_DEVICE_STALE_POLL');
    const replay = input();
    const responses = await Promise.all([poll(replay), poll(replay)]);
    expect(responses.map(response => response.statusCode).sort()).toEqual([200, 409]);
    expect(code(responses.find(response => response.statusCode === 409)!)).toBe('CODING_DEVICE_REPLAY');
    const wrongVersion = await poll(input({ status: { protocolVersion: 2, platform: 'win32', sandbox } }));
    expect(code(wrongVersion)).toBe('CODING_DEVICE_VERSION');
    await expect(link.run(owner.id, { kind: 'inspect', payload: { path: project.path } })).rejects.toMatchObject({ code: 'CODING_DEVICE_VERSION' });
    const unavailable = await poll(input({ status: {
      protocolVersion: 1, platform: 'win32', sandbox: { ...sandbox, available: false },
    } }));
    expect(unavailable.statusCode).toBe(200);
    expect((await app.inject(devicesPath)).json()).toMatchObject({ devices: [{ online: true, sandbox: { available: false } }] });
    await expect(link.run(owner.id, { kind: 'inspect', payload: { path: project.path } })).rejects
      .toMatchObject({ code: 'CODING_DEVICE_SANDBOX_UNAVAILABLE' });
    expect((await poll()).statusCode).toBe(200);
  });

  it('dispatches one job at a time, forwards progress once, and validates the result', async () => {
    const onProgress = vi.fn(async (_stage: string, _message: string) => {});
    const inspection = link.run(owner.id, { kind: 'inspect', payload: { path: project.path } }, { onProgress });
    const first = await queued('inspect');
    expect(new Date(first.deadline_at).getTime() - time).toBe(60_000);
    const dispatched = (await poll()).json().job;
    expect(dispatched).toMatchObject({ id: first.id, kind: 'inspect', payload: { path: project.path } });

    const check = link.run(owner.id, { kind: 'check', payload: { project } });
    const invalid = expect(check).rejects.toMatchObject({ code: 'CODING_DEVICE_BAD_RESULT' });
    const second = await queued('check');
    expect(new Date(second.deadline_at).getTime() - time).toBe(120_000);
    const progress = [{ jobId: first.id, seq: 1, stage: 'project_inspected', message: 'Fixture progress' }] as const;
    for (let index = 0; index < 2; index++) {
      expect((await poll(input({ activeJobId: first.id, progress: [...progress] }))).json()).toEqual({ job: null, cancel: [] });
    }
    const result = { path: project.path, baseCommit: project.baseCommit, candidateEditablePaths: project.allowedPaths, testFiles: ['test/sum.test.mjs'] };
    expect((await poll(input({ result: { jobId: first.id, status: 'succeeded', value: result } }))).json().job.id).toBe(second.id);
    await expect(inspection).resolves.toEqual(result);
    expect(onProgress).toHaveBeenCalledExactlyOnceWith('project_inspected', 'Fixture progress');
    expect((await poll(input({ result: { jobId: second.id, status: 'succeeded', value: { unexpected: 'value' } } }))).statusCode).toBe(200);
    await invalid;
    expect(await readJob(second.id)).toMatchObject({ status: 'failed', result_code: 'CODING_DEVICE_BAD_RESULT' });
    const audit = await db().selectFrom('coding_device_audit').selectAll().where('job_id', 'in', [first.id, second.id]).execute();
    expect(audit.filter(row => row.event === 'dispatch')).toHaveLength(2);
    expect(audit).toEqual(expect.arrayContaining([expect.objectContaining({
      job_id: second.id, event: 'result', kind: 'check', project_id: project.id, outcome_code: 'CODING_DEVICE_BAD_RESULT',
    })]));
    expect(JSON.stringify(audit)).not.toContain(project.path);
  });

  it('rejects an oversized result and only fails its authenticated job', async () => {
    const run = link.run(owner.id, { kind: 'inspect', payload: { path: project.path } });
    const failed = expect(run).rejects.toMatchObject({ code: 'CODING_DEVICE_RESULT_TOO_LARGE', statusCode: 413 });
    const row = await queued('inspect');
    expect((await poll()).json().job.id).toBe(row.id);
    const large = input({ result: { jobId: row.id, status: 'succeeded', value: 'x'.repeat(CODING_DEVICE_POLL_BODY_LIMIT) } });
    const metadata = {
      [CODING_RESULT_HEADERS.jobId]: row.id, [CODING_RESULT_HEADERS.nonce]: large.nonce, [CODING_RESULT_HEADERS.sentAt]: large.sentAt,
    };
    expect((await poll(large, { ...metadata, authorization: '' })).statusCode).toBe(401);
    expect((await readJob(row.id)).status).toBe('dispatched');
    const response = await poll(large, metadata);
    expect(response.statusCode, response.body).toBe(413);
    expect(code(response)).toBe('CODING_DEVICE_RESULT_TOO_LARGE');
    expect(code(await poll(large, metadata))).toBe('CODING_DEVICE_REPLAY');
    await failed;
  });

  it('cancels queued jobs and waits for a dispatched cancellation receipt', async () => {
    const beforeDispatch = new AbortController();
    const first = link.run(owner.id, { kind: 'inspect', payload: { path: project.path } }, { signal: beforeDispatch.signal });
    const cancelled = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    const queuedJob = await queued('inspect');
    beforeDispatch.abort();
    await cancelled;
    expect((await readJob(queuedJob.id)).status).toBe('cancelled');

    const afterDispatch = new AbortController();
    const second = link.run(owner.id, { kind: 'inspect', payload: { path: project.path } }, { signal: afterDispatch.signal });
    const aborted = expect(second).rejects.toMatchObject({ name: 'AbortError' });
    const running = await queued('inspect');
    expect((await poll()).json().job.id).toBe(running.id);
    afterDispatch.abort();
    await aborted;
    expect((await readJob(running.id)).status).toBe('unknown');
    expect((await poll(input({ activeJobId: running.id }))).json()).toEqual({ job: null, cancel: [running.id] });
    const ack = await poll(input({ result: { jobId: running.id, status: 'cancelled', code: 'CODING_DEVICE_CANCELLED' } }));
    expect(ack.json()).toEqual({ job: null, cancel: [] });
    expect((await readJob(running.id)).status).toBe('cancelled');
  });

  it('expires an undispatched job and records unknown when a dispatched result never arrives', async () => {
    const first = link.run(owner.id, { kind: 'check', payload: { project } });
    const expired = expect(first).rejects.toMatchObject({ code: 'CODING_DEVICE_TIMEOUT', statusCode: 504 });
    const waiting = await queued('check');
    time += 120_001;
    await expired;
    expect((await readJob(waiting.id)).status).toBe('expired');
    expect((await poll()).json().job).toBeNull();

    const second = link.run(owner.id, { kind: 'inspect', payload: { path: project.path } });
    const missed = expect(second).rejects.toMatchObject({ code: 'CODING_DEVICE_RESULT_UNKNOWN' });
    const running = await queued('inspect');
    expect((await poll()).json().job.id).toBe(running.id);
    time += 60_001;
    await missed;
    expect((await readJob(running.id)).status).toBe('unknown');
    expect((await poll(input({ result: { jobId: running.id, status: 'failed', code: 'PROJECT_HEAD_CHANGED' } }))).json().job).toBeNull();
    expect((await readJob(running.id)).status).toBe('unknown');
    expect(await db().selectFrom('coding_device_audit').select('id').where('job_id', '=', running.id).where('event', '=', 'dispatch').execute())
      .toHaveLength(1);
  });

  it('fences execute against its real lease, expires a lost dispatch, and refuses to enqueue the same task again', async () => {
    const taskId = randomUUID(), leaseToken = randomUUID(), goal = 'Repair the demo sum.';
    await db().insertInto('tasks').values({
      id: taskId, owner_id: owner.id, title: goal, goal, capability_id: 'coding.change', autonomy: 'scoped', status: 'running',
      input_hash: 'fixture', idempotency_key: taskId, project_id: project.id, lease_token: leaseToken,
      lease_expires_at: new Date(time + 90_000),
    }).execute();
    const request = { kind: 'execute' as const, payload: { project, taskId, goal } };
    await expect(link.run(owner.id, request, { leaseToken: randomUUID() })).rejects.toMatchObject({ code: 'CODING_AUTHORIZATION_LOST' });
    const run = link.run(owner.id, request, { leaseToken });
    const missed = expect(run).rejects.toMatchObject({ code: 'CODING_DEVICE_RESULT_UNKNOWN' });
    const job = await queued('execute');
    expect(new Date(job.deadline_at).getTime() - time).toBe(75_000);
    expect((await poll()).json().job.id).toBe(job.id);
    time += 90_001;
    expect(await db().transaction().execute(tx => link.recoverDeviceDispatch(tx, owner.id, taskId))).toBe(true);
    await missed;
    expect((await readJob(job.id)).status).toBe('unknown');
    expect((await poll()).json().job).toBeNull();
    await expect(link.run(owner.id, request, { leaseToken })).rejects.toMatchObject({ code: 'CODING_DEVICE_RESULT_UNKNOWN' });
    expect(await db().selectFrom('coding_device_jobs').select('id').where('task_id', '=', taskId).execute()).toEqual([{ id: job.id }]);
  });

  it('refuses expired pairings, replaces the device, and revokes its queued or dispatched jobs', async () => {
    const expired = await pairing();
    time += 120_001;
    const rejected = await pair(expired.code);
    expect(rejected.statusCode).toBe(401);
    expect(code(rejected)).toBe('CODING_DEVICE_PAIRING_INVALID');
    const original = { id: deviceId, authorization: authentication };
    const next = await pair((await pairing()).code);
    expect(next.statusCode, next.body).toBe(200);
    useCredentials(next);
    expect((await poll(input(), { authorization: original.authorization })).statusCode).toBe(401);
    expect((await poll()).statusCode).toBe(200);
    expect((await app.inject(devicesPath)).json().devices.map((device: { id: string }) => device.id)).toEqual([deviceId]);
    expect(await db().selectFrom('coding_device_audit').selectAll().where('device_id', '=', original.id).where('event', '=', 'revoked').executeTakeFirstOrThrow())
      .toMatchObject({ outcome_code: 'REPLACED' });

    const first = link.run(owner.id, { kind: 'inspect', payload: { path: project.path } });
    const missed = expect(first).rejects.toMatchObject({ code: 'CODING_DEVICE_RESULT_UNKNOWN' });
    const running = await queued('inspect');
    expect((await poll()).json().job.id).toBe(running.id);
    const second = link.run(owner.id, { kind: 'check', payload: { project } });
    const cancelled = expect(second).rejects.toMatchObject({ code: 'CODING_DEVICE_CANCELLED' });
    const waiting = await queued('check');
    expect((await app.inject({ method: 'DELETE', url: `${devicesPath}/${deviceId}` })).json()).toEqual({ revoked: true });
    await Promise.all([missed, cancelled]);
    expect((await readJob(running.id)).status).toBe('unknown');
    expect((await readJob(waiting.id)).status).toBe('cancelled');
    expect((await poll()).statusCode).toBe(401);
    expect((await app.inject(devicesPath)).json().devices).toEqual([]);
    await link.maintain();
    expect(await db().selectFrom('coding_device_nonces').select('nonce').where('expires_at', '<', new Date(time)).execute()).toEqual([]);
    expect(await db().selectFrom('coding_device_pairings').select('id').where('expires_at', '<', new Date(time)).execute()).toEqual([]);
  });

  it('limits owner pairing requests to three a minute', async () => {
    const address = '192.0.2.82';
    for (let index = 0; index < 3; index++) await pairing(address);
    const limited = await app.inject({ method: 'POST', url: pairingPath, remoteAddress: address, payload: {} });
    expect(limited.statusCode).toBe(429);
  });
});
