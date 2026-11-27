import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { snapshotHash, type SandboxRunner } from '@mohassan/coding';
import type { ChatConversation, Project, Task } from '@mohassan/contracts';
import { createApplication } from '../apps/server/src/app.js';
import { git } from '../packages/coding/src/git.ts';
import { pairMeasurementDevice, unavailableServerSandbox } from '../scripts/mohassan-code/device-fixture.ts';
import { REPAIR_DEMO_FAILURE_OUTPUT } from './fixtures/coding-repair-demo-output.js';

it('records a missing device result and does not dispatch an approved change again after reconnect', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'mohassan-coding-device-drop-')));
  const origin = 'http://127.0.0.1:3000';
  const setupToken = 'coding-device-drop-fixture-setup-0001';
  const internalSecret = 'coding-device-drop-fixture-service-0001';
  const account = { name: 'Coding device owner', email: 'coding-device-drop@example.test', password: 'Coding-Device-Drop-42' };
  const settings = { 'x-mohassan-internal': internalSecret, origin };
  let application: Awaited<ReturnType<typeof createApplication>> | undefined;
  let stopDevice: (() => Promise<void>) | undefined;
  let sandboxRuns = 0;
  const sandbox: SandboxRunner = {
    available: async () => ({ available: true, provider: 'device-drop-fixture', message: 'Recorded repair baseline' }),
    async run({ files, signal }) {
      sandboxRuns++;
      if (sandboxRuns > 1) {
        // The engine has created the review branch before starting the post-edit checks.
        await delay(60_000, undefined, { signal });
        throw new Error('The simulated disconnect never arrived');
      }
      return {
        exitCode: 1, stdout: REPAIR_DEMO_FAILURE_OUTPUT, stderr: '', timedOut: false, durationMs: 1,
        provider: 'device-drop-fixture', network: 'denied', isolation: 'appcontainer', isolationVerified: true,
        snapshotHash: snapshotHash(files),
      };
    },
  };

  try {
    const app = application = await createApplication({
      webOrigin: origin, internalSecret, authSecret: 'coding-device-drop-fixture-auth-0001', setupToken,
      production: false, runWorker: true, testRequestLimit: 2_000, browserChannel: null,
      codingDeviceLink: true, sandboxRunner: unavailableServerSandbox,
      codingDataDir: join(directory, 'unused-server-coding'), codingAllowedRoots: [],
    });
    let cookie = '';
    const api = (method: 'POST' | 'GET', url: string, payload?: object) => app.app.inject({
      method, url, headers: { ...settings, cookie }, ...(payload === undefined ? {} : { payload }),
    });
    expect((await api('POST', '/api/setup', { ...account, setupToken })).statusCode).toBe(200);
    const login = await api('POST', '/api/auth/sign-in/email', { email: account.email, password: account.password });
    expect(login.statusCode).toBe(200);
    cookie = [login.headers['set-cookie']].flat().filter(Boolean).map(value => value!.split(';')[0]).join('; ');
    const owner = (await api('GET', '/api/access')).json<{ user: { id: string } }>().user.id;
    const device = await pairMeasurementDevice(app, {
      checkout: process.cwd(), ownerId: owner, dataDir: directory, allowedRoots: [directory], sandbox,
      createPairing: () => api('POST', '/api/coding/devices/pairing', {}),
    });
    stopDevice = await device.start();
    const demo = await api('POST', '/api/coding/projects/demo', {});
    expect(demo.statusCode).toBe(200);
    const project = demo.json<Project>();
    const chats = '/api/chat/conversations';
    const created = await api('POST', chats, { goal: `Fix the code in ${project.name}` });
    expect(created.statusCode).toBe(200);
    const url = `${chats}/${created.json<ChatConversation>().id}`;
    const conversation = async () => (await api('GET', url)).json<ChatConversation>();
    await expect.poll(async () => (await conversation()).status, { timeout: 15_000 }).toBe('waiting_approval');
    const approval = (await conversation()).approval;
    const approved = await api('POST', `${url}/approve`, { approvalId: approval!.id, approved: true });
    expect(approved.statusCode).toBe(200);
    await expect.poll(() => sandboxRuns, { timeout: 35_000 }).toBe(2);

    const db = app.database.db;
    const executeJobs = () => db.selectFrom('coding_device_jobs').selectAll().where('kind', '=', 'execute').execute();
    const [job] = await executeJobs();
    expect(job).toMatchObject({ status: 'dispatched', project_id: project.id });
    const taskId = job.task_id as string;
    const refs = async () => (await git(project.path, ['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads/mohassan'])).stdout.trim();
    expect(await refs()).toBe(`mohassan/${taskId} ${project.baseCommit}`);
    await stopDevice();
    stopDevice = undefined;

    // Advance only the dispatched row's deadline so the real waiter settles in this test.
    await db.updateTable('coding_device_jobs').set({ deadline_at: new Date(Date.now() - 1_000) }).where('id', '=', job.id).execute();
    await expect.poll(async () => (await executeJobs())[0]?.status, { timeout: 15_000 }).toBe('unknown');
    const task = async (): Promise<Task> => (await app.runtime.detail(owner, taskId)).task;
    await expect.poll(async () => (await task()).status, { timeout: 15_000 }).toBe('failed');
    expect(await task()).toMatchObject({ status: 'failed', attempt: 1, result: null });
    await expect.poll(async () => (await conversation()).status, { timeout: 15_000 }).toBe('idle');
    const reply = (await conversation()).messages.findLast(message => message.role === 'assistant')!.text;
    expect(reply).toContain('The device did not return a result. The job will not be re-run automatically.');
    expect(reply).not.toContain('Review branch');

    stopDevice = await device.start();
    await delay(1_000);
    expect(await executeJobs()).toMatchObject([{ id: job.id, status: 'unknown', result_code: 'CODING_DEVICE_RESULT_UNKNOWN' }]);
    expect((await app.runtime.snapshot(owner)).tasks.filter(task => task.capabilityId === 'coding.change')).toHaveLength(1);
    expect(sandboxRuns).toBe(2);
    expect(await refs()).toBe(`mohassan/${taskId} ${project.baseCommit}`);
  } finally {
    try {
      await stopDevice?.();
    } finally {
      try {
        await application?.app.close();
      } finally {
        await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    }
  }
}, 120_000);
