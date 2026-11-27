import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CodingJob } from '@mohassan/coding-link';
import { createRepairDemoProject, type SandboxRunner } from '@mohassan/coding';
import type { CodingWorkspace } from '@mohassan/contracts';
import { createApplication } from '../apps/server/src/app.js';

const origin = 'http://127.0.0.1:3000';
const internal = randomUUID();
const setupToken = randomUUID();
const headers = { origin, 'x-mohassan-internal': internal };
const account = { name: 'Coding link routing', email: 'coding-link-routing@example.test', password: 'Coding-Link-Routing-Test-42' };
const provider = 'routing-fixture';
const localRun = vi.fn(async () => { throw new Error('An unavailable server sandbox cannot execute a job'); }) satisfies SandboxRunner['run'];

describe('coding control with no server sandbox and an optional owner device', () => {
  let application: Awaited<ReturnType<typeof createApplication>>;
  let root: string;
  let ownerId: string;
  let cookie: string;
  let bearer: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'mohassan-coding-routing-'));
    application = await createApplication({
      production: false, runWorker: false, webOrigin: origin, authSecret: randomUUID(), internalSecret: internal, setupToken,
      codingDataDir: join(root, 'server'), codingAllowedRoots: [root], codingDeviceLink: true,
      sandboxRunner: { available: async () => ({ available: false, provider, message: 'Fixture unavailable' }), run: localRun },
    });
    expect((await application.app.inject({ method: 'POST', url: '/api/setup', headers, payload: { ...account, setupToken } })).statusCode).toBe(200);
    const login = await application.app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers,
      payload: { email: account.email, password: account.password } });
    expect(login.statusCode).toBe(200);
    cookie = [login.headers['set-cookie']].flat().filter(Boolean).map(value => String(value).split(';')[0]).join('; ');
    ownerId = (await application.database.db.selectFrom('user').select('id').executeTakeFirstOrThrow()).id;
  });
  afterAll(async () => {
    await application?.app.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  const workspace = async () => (await application.app.inject({ url: '/api/coding/projects', headers: { ...headers, cookie } })).json<CodingWorkspace>();
  async function poll(sandbox: boolean, result: unknown = null) {
    const response = await application.app.inject({ method: 'POST', url: '/api/coding/device/poll',
      headers: { authorization: bearer }, payload: { nonce: randomUUID(), sentAt: new Date().toISOString(),
        activeJobId: null, progress: [], result,
        status: { protocolVersion: 1, platform: 'win32', sandbox: { available: sandbox, provider, message: sandbox ? 'Fixture ready' : 'Fixture probing' } } },
    });
    expect(response.statusCode).toBe(200);
    return response.json<{ job: CodingJob | null }>().job;
  }
  async function takeJob(kind: CodingJob['kind']) {
    return vi.waitFor(async () => {
      const job = await poll(true);
      expect(job).toMatchObject({ kind });
      return job!;
    });
  }

  async function pair() {
    const pairing = await application.app.inject({ method: 'POST', url: '/api/coding/devices/pairing', headers: { ...headers, cookie }, payload: {} });
    expect(pairing.statusCode).toBe(200);
    const paired = await application.app.inject({ method: 'POST', url: '/api/coding/device/pair',
      payload: { name: 'Routing fixture', code: pairing.json().code } });
    expect(paired.statusCode).toBe(200);
    const { deviceId, deviceKey } = paired.json();
    bearer = `Bearer ${deviceId}.${deviceKey}`;
  }

  it('reports unpaired, offline, probing and ready and preserves owner HTTP error codes', async () => {
    expect(application.coding.available).toBe(true);
    expect(await workspace()).toMatchObject({ device: null, sandbox: { available: false } });
    const demo = () => application.app.inject({ method: 'POST', url: '/api/coding/projects/demo', headers: { ...headers, cookie }, payload: {} });
    const unpaired = await demo();
    expect(unpaired.statusCode).toBe(503);
    expect(unpaired.json().error.code).toBe('CODING_DEVICE_NOT_PAIRED');

    await pair();
    expect(await workspace()).toMatchObject({ device: { online: false }, sandbox: { available: false } });
    const offline = await demo();
    expect(offline.statusCode).toBe(503);
    expect(offline.json().error.code).toBe('CODING_DEVICE_OFFLINE');
    await poll(false);
    expect(await workspace()).toMatchObject({ device: { online: true }, sandbox: { available: false, message: 'Fixture probing' } });
    await poll(true);
    expect(await workspace()).toMatchObject({ device: { online: true }, sandbox: { available: true } });
  });

  it('keeps Windows paths opaque, deduplicates scopes case-insensitively, and reads registered projects on the device', async () => {
    await pair();
    await poll(true);
    const fixture = await createRepairDemoProject(join(root, 'test-projects'));
    const canonical = 'C:\\Owner\\Projects\\sum';
    const lower = canonical.toLowerCase();
    const register = (path: string) => application.coding.register(ownerId, { name: 'Windows demo', path, allowedPaths: fixture.allowedPaths });
    const inspection = { baseCommit: fixture.baseCommit, path: canonical, candidateEditablePaths: fixture.allowedPaths, testFiles: ['test/sum.test.mjs'] };

    const first = register(canonical);
    const firstJob = await takeJob('inspect');
    expect(firstJob.payload).toEqual({ path: canonical });
    await poll(true, { jobId: firstJob.id, status: 'succeeded', value: inspection });
    const project = await first;
    expect(project.path).toBe(canonical);
    const second = register(lower);
    const secondJob = await takeJob('inspect');
    expect(secondJob.payload).toEqual({ path: lower });
    await poll(true, { jobId: secondJob.id, status: 'succeeded', value: { ...inspection, path: lower } });
    expect((await second).id).toBe(project.id);
    expect(await application.database.db.selectFrom('coding_projects').select('location').where('id', '=', project.id).executeTakeFirst())
      .toEqual({ location: 'device' });

    const query = 'rightHandVaule';
    const pending = application.coding.search(ownerId, project.id, query);
    const readJob = await takeJob('search');
    expect(readJob.payload).toEqual({ project, query });
    const result = { query, wholeWord: false, matches: [], total: 0, files: 0, masked: 0, pathMatches: [] };
    await poll(true, { jobId: readJob.id, status: 'succeeded', value: result });
    expect(await pending).toEqual(result);

    const task = await application.runtime.createTask(ownerId, {
      title: 'Remote cancellation fixture', goal: 'Repair the sum function.', capabilityId: 'coding.change',
      autonomy: 'scoped', projectId: project.id,
    }, 'coding-device-cancel-route');
    await application.runtime.approve(ownerId, task.id);
    const executing = application.runtime.tick();
    const dispatched = await takeJob('execute');
    await application.runtime.cancel(ownerId, task.id);
    await executing;
    await vi.waitFor(async () => {
      const job = await application.database.db.selectFrom('coding_device_jobs').select('status').where('id', '=', dispatched.id).executeTakeFirst();
      expect(job?.status).toBe('unknown');
      const lock = await application.database.db.selectFrom('coding_project_locks').select('task_id')
        .where('project_id', '=', project.id).executeTakeFirst();
      expect(lock?.task_id).toBe(task.id);
    });
    expect(localRun).not.toHaveBeenCalled();
  });

  it('keeps a legacy server project on the server with the link enabled', async () => {
    const fixture = await createRepairDemoProject(join(root, 'legacy'));
    const id = randomUUID();
    await application.database.db.insertInto('coding_projects').values({
      id, owner_id: ownerId, name: 'Legacy fixture', repo_path: fixture.path, base_commit: fixture.baseCommit,
      allowed_paths: JSON.stringify(fixture.allowedPaths), test_profile: 'node-test', scope_hash: randomUUID(),
    }).execute();
    expect(await application.database.db.selectFrom('coding_projects').select('location').where('id', '=', id).executeTakeFirst())
      .toEqual({ location: 'server' });
    expect(await application.coding.inspect(fixture.path, { ownerId, projectId: id })).toMatchObject({ path: fixture.path, baseCommit: fixture.baseCommit });
    expect(await application.coding.search(ownerId, id, 'rightHandVaule')).toMatchObject({ total: 1 });
    await expect(application.coding.check(ownerId, id, new AbortController().signal)).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
    expect(await application.database.db.selectFrom('coding_device_jobs').select('id').where('project_id', '=', id).execute()).toEqual([]);
  });
});
