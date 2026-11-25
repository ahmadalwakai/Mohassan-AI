import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { createApplication } from '../apps/server/src/app.js';
import { createTrainingMonitor, localTrainingMonitorRoot, registerTrainingMonitorRoutes } from '../apps/server/src/training-monitor/route.js';

vi.mock('../apps/server/src/training-monitor/gpu.js', () => ({ createGpuSampler: () => async () => null }));

const origin = 'http://127.0.0.1:3000';
const timestamp = '2026-11-25T00:07:28Z';
const url = '/api/training-monitor';

async function writeStatus(root: string, status: Record<string, unknown> = {}) {
  const path = join(root, 'artifacts', 'execution-model-runs', 'fixture-run', '85m', 'status.json');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ status: 'running', updated_at: timestamp, step: 10,
    processed_tokens: 200, settings: { total_tokens: 1000 }, ...status }));
}

describe('training monitor route', () => {
  it('uses the local root only for a loopback local stack', () => {
    expect(localTrainingMonitorRoot({}, origin, '/repo')).toBe('/repo');
    expect(localTrainingMonitorRoot({ SERVER_HOST: '::1' }, 'http://[::1]:3000', '/repo')).toBe('/repo');
    expect(localTrainingMonitorRoot({ SERVER_HOST: '0.0.0.0' }, origin, '/repo')).toBeUndefined();
    expect(localTrainingMonitorRoot({}, 'https://example.test', '/repo')).toBeUndefined();
    expect(localTrainingMonitorRoot({ NODE_ENV: 'production' }, origin, '/repo')).toBeUndefined();
    expect(localTrainingMonitorRoot({ NODE_ENV: 'production', MOHASSAN_DESKTOP_SHELL: '1' }, origin, '/repo')).toBe('/repo');
  });

  it('refuses missing files and a disabled monitor with a clear local-only message', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mohassan-training-missing-'));
    try {
      for (const candidate of [undefined, root]) {
        const app = Fastify();
        try {
          registerTrainingMonitorRoutes(app, candidate);
          const result = await app.inject({ url });
          expect(result.statusCode).toBe(503);
          expect(result.json()).toEqual({ error: { code: 'TRAINING_MONITOR_UNAVAILABLE', message: expect.stringContaining('جهاز المالك') } });
        } finally { await app.close(); }
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('lets the owner read a snapshot while the existing member and session gate refuses other accounts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mohassan-training-role-'));
    const secret = 'fixture-training-route-internal-secret';
    const setupToken = 'fixture-training-route-setup-token';
    const owner = { name: 'Training Owner', email: 'training-owner@example.test', password: 'Fixture-Training-Owner-2026' };
    const member = { name: 'Training Member', email: 'training-member@example.test', password: 'Fixture-Training-Member-2026' };
    const headers = (cookie = '') => ({ origin, 'x-mohassan-internal': secret, ...(cookie ? { cookie } : {}) });
    let application: Awaited<ReturnType<typeof createApplication>> | undefined;

    try {
      await writeStatus(root);
      application = await createApplication({ authSecret: 'fixture-training-route-session-secret', internalSecret: secret, setupToken,
        webOrigin: origin, production: false, runWorker: false, trainingMonitorRoot: root, codingAllowedRoots: [root],
        codingDataDir: join(root, 'coding'), browserProfileDir: join(root, 'browser'), documentsDir: join(root, 'documents') });
      const { app } = application;
      const signIn = async ({ email, password }: typeof owner) => {
        const response = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: headers(), payload: { email, password } });
        expect(response.statusCode).toBe(200);
        return [response.headers['set-cookie']].flat().filter(Boolean).map(item => String(item).split(';')[0]).join('; ');
      };
      expect((await app.inject({ method: 'POST', url: '/api/setup', headers: headers(), payload: { ...owner, setupToken } })).statusCode).toBe(200);
      const ownerSession = await signIn(owner);
      const invite = await app.inject({ method: 'POST', url: '/api/members/invites', headers: headers(ownerSession), payload: { name: member.name, email: member.email } });
      expect(invite.statusCode).toBe(200);
      const token = new URL(invite.json().url).hash.slice('#invite='.length);
      const accepted = await app.inject({ method: 'POST', url: '/api/invites/accept', headers: headers(), payload: { token, name: member.name, password: member.password } });
      expect(accepted.statusCode, accepted.body).toBe(200);

      const ownerResponse = await app.inject({ url, headers: headers(ownerSession) });
      expect(ownerResponse.statusCode).toBe(200);
      expect(ownerResponse.headers['cache-control']).toBe('no-store');
      expect(ownerResponse.json()).toMatchObject({ active: { run: 'fixture-run', percentDone: 20 }, gpu: null });
      const denied = await app.inject({ url, headers: headers(await signIn(member)) });
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error).toEqual({ code: 'MEMBER_FORBIDDEN', message: 'هذه الخدمة غير متاحة لحسابك.' });
      expect((await app.inject({ url, headers: headers() })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url, headers: headers(ownerSession) })).statusCode).toBe(404);
    } finally {
      await application?.app.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('shares in-flight reads and caches both snapshots and absent files for ten seconds', async () => {
    let clock = 0;
    const readRuns = vi.fn().mockResolvedValue(null);
    const sampleGpu = vi.fn().mockResolvedValue(null);
    const monitor = createTrainingMonitor({ root: '/fixture', clock: () => clock, now: () => Date.parse(timestamp), readRuns, sampleGpu });
    expect(await Promise.all([monitor.snapshot(), monitor.snapshot()])).toEqual([null, null]);
    clock = 9_999;
    expect(await monitor.snapshot()).toBeNull();
    expect(readRuns).toHaveBeenCalledExactlyOnceWith('/fixture', Date.parse(timestamp));
    expect(sampleGpu).not.toHaveBeenCalled();

    readRuns.mockResolvedValue({ active: null, recent: [], gpuLock: null });
    clock = 10_000;
    const fresh = await monitor.snapshot();
    clock = 19_999;
    expect(await monitor.snapshot()).toBe(fresh);
    expect(fresh).toMatchObject({ sampledAt: '2026-11-25T00:07:28.000Z', gpu: null });
    expect(readRuns).toHaveBeenCalledTimes(2);
    expect(sampleGpu).toHaveBeenCalledTimes(1);
  });
});
