import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ProductionMetricsResponse } from '@mohassan/contracts';
import { afterEach, expect, it, vi } from 'vitest';
import { createApplication } from '../apps/server/src/app.js';
import { MEMBER_ROUTES } from '../apps/server/src/members.js';
import { productionMetricsSettings } from '../apps/server/src/ops/metrics/index.js';

const origin = 'http://127.0.0.1:3000';
const internalSecret = 'metrics-test-internal-fixture-00000000';
const setupToken = 'metrics-test-setup-fixture-00000000';
const owner = { name: 'Metrics fixture owner', email: 'metrics-owner@example.test', password: 'Metrics-Test-Owner-FortyTwo' };
const member = { name: 'Metrics fixture member', email: 'metrics-member@example.test', password: 'Metrics-Test-Member-FortyTwo' };

async function fixture(enabled: boolean) {
  const directory = await mkdtemp(join(tmpdir(), 'mohassan-metrics-api-'));
  const snapshots = join(directory, 'snapshots');
  vi.stubEnv('PRODUCTION_METRICS_ENABLED', String(enabled));
  vi.stubEnv('PRODUCTION_METRICS_DIR', snapshots);

  let application: Awaited<ReturnType<typeof createApplication>> | undefined;
  async function dispose() {
    try { await application?.app.close(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
  try {
    application = await createApplication({
      authSecret: 'metrics-test-auth-fixture-00000000000', internalSecret, setupToken, webOrigin: origin,
      production: false, runWorker: false, codingDataDir: join(directory, 'coding'),
    });
    const { app } = application;
    const headers = (cookie?: string) => ({ origin, 'x-mohassan-internal': internalSecret, ...(cookie ? { cookie } : {}) });
    async function login(credentials: typeof owner) {
      const response = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: headers(),
        payload: { email: credentials.email, password: credentials.password } });
      expect(response.statusCode).toBe(200);
      const cookies = [response.headers['set-cookie']].flat().filter(Boolean).map(value => String(value).split(';')[0]);
      expect(cookies.length).toBeGreaterThan(0);
      return headers(cookies.join('; '));
    }
    const setup = await app.inject({ method: 'POST', url: '/api/setup', headers: headers(), payload: { ...owner, setupToken } });
    expect(setup.statusCode).toBe(200);
    const ownerHeaders = await login(owner);
    return { app, dispose, snapshots, headers, ownerHeaders, login };
  } catch (error) {
    await dispose();
    throw error;
  }
}

afterEach(() => vi.unstubAllEnvs());

it('keeps JSON and CSV owner-only and records request and chat data without private fields', async () => {
  const f = await fixture(true);
  try {
    const { app, ownerHeaders } = f;
    const first = await app.inject({ url: '/api/ops/metrics', headers: ownerHeaders });
    expect(first.statusCode).toBe(200);
    expect(first.json<ProductionMetricsResponse>()).toMatchObject({ enabled: true, snapshotAvailable: true,
      windows: { hour: { roles: { owner: { routes: [] }, member: { routes: [] } } } } });

    const invitation = await app.inject({ method: 'POST', url: '/api/members/invites', headers: ownerHeaders,
      payload: { name: member.name, email: member.email } });
    expect(invitation.statusCode).toBe(200);
    const token = new URL(invitation.json<{ url: string }>().url).hash.replace('#invite=', '');
    const accepted = await app.inject({ method: 'POST', url: '/api/invites/accept', headers: f.headers(),
      payload: { token, name: member.name, password: member.password } });
    expect(accepted.statusCode).toBe(200);
    const memberHeaders = await f.login(member);
    for (const url of ['/api/ops/metrics', '/api/ops/metrics.csv']) {
      expect(MEMBER_ROUTES.has(`GET ${url}`)).toBe(false);
      expect((await app.inject({ url, headers: memberHeaders })).statusCode).toBe(403);
      expect((await app.inject({ url, headers: f.headers() })).statusCode).toBe(401);
      expect((await app.inject({ url })).statusCode).toBe(401);
    }
    const access = await app.inject({ url: '/api/access', headers: memberHeaders });
    expect(access.statusCode).toBe(200);
    const memberId = access.json<{ user: { id: string } }>().user.id;
    const uuid = randomUUID();
    expect((await app.inject({ url: `/api/tasks/${uuid}`, headers: memberHeaders })).statusCode).toBe(403);
    expect((await app.inject({ url: `/api/tasks/${uuid}`, headers: ownerHeaders })).statusCode).toBe(404);

    const created = await app.inject({ method: 'POST', url: '/api/chat/conversations', headers: ownerHeaders, payload: {} });
    expect(created.statusCode).toBe(200);
    const conversationId = created.json<{ id: string }>().id;
    const query = 'fixture_private_query_47621', message = 'احسب 4351 + 869';
    const email = 'do-not-store-metrics@example.test', ip = '203.0.113.81';
    const submitted = await app.inject({ method: 'POST', url: `/api/chat/conversations/${conversationId}/messages?${query}=hidden`,
      remoteAddress: ip, headers: { ...ownerHeaders, 'x-metrics-private-fixture': email }, payload: { text: message } });
    expect(submitted.statusCode).toBe(200);

    let measured = first;
    for (let attempt = 0; attempt < 40; attempt++) {
      measured = await app.inject({ url: '/api/ops/metrics', headers: ownerHeaders });
      if (measured.json<ProductionMetricsResponse>().windows.hour.roles.owner.chat.finalAnswer.samples > 0) break;
      await delay(50);
    }
    const hour = measured.json<ProductionMetricsResponse>().windows.hour;
    expect(hour.roles.owner.chat).toMatchObject({ runs: 1, firstProgress: { samples: 1 }, finalAnswer: { samples: 1 },
      paths: { local_computation: 1 } });
    expect(Object.values(hour.roles.owner.chat.phases).some(phase => phase.samples > 0)).toBe(true);
    expect(hour.roles.owner.routes).toEqual(expect.arrayContaining([
      expect.objectContaining({ route: 'POST /api/chat/conversations/:id/messages', count: 1, latency: expect.objectContaining({ samples: 1 }) }),
      expect.objectContaining({ route: 'GET /api/tasks/:id', count: 1, statusClasses: expect.objectContaining({ '4xx': 1 }) }),
    ]));
    expect(hour.roles.member.routes).toEqual(expect.arrayContaining([
      expect.objectContaining({ route: 'GET /api/access', count: 1, statusClasses: expect.objectContaining({ '2xx': 1 }) }),
      expect.objectContaining({ route: 'GET /api/tasks/:id', count: 1, statusClasses: expect.objectContaining({ '4xx': 1 }) }),
    ]));
    const csv = await app.inject({ url: '/api/ops/metrics.csv', headers: ownerHeaders });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toBe('attachment; filename="production-metrics.csv"');
    expect(csv.body).toContain('owner,request,POST /api/chat/conversations/:id/messages,1,1');
    expect(csv.body).toContain('member,request,GET /api/access,1,1');
    expect(csv.body).toContain('owner,answer_path,local_computation,1');

    await app.close();
    const files = (await readdir(f.snapshots, { recursive: true })).filter(file => file.endsWith('.jsonl'));
    expect(files.length).toBeGreaterThan(0);
    const disk = (await Promise.all(files.map(file => readFile(join(f.snapshots, file), 'utf8')))).join('');
    expect(disk).toContain('/api/chat/conversations/:id/messages');
    for (const source of [measured.body, csv.body, disk]) {
      for (const privateValue of [query, message, email, ip, uuid, conversationId, memberId, owner.email, member.email, token]) {
        expect(source).not.toContain(privateValue);
      }
    }
  } finally {
    await f.dispose();
  }
});

it('turns off collection and disk writes with the environment flag', async () => {
  expect(productionMetricsSettings(true, {}).enabled).toBe(true);
  expect(productionMetricsSettings(false, {}).enabled).toBe(false);
  expect(productionMetricsSettings(true, { PRODUCTION_METRICS_ENABLED: 'false' }).enabled).toBe(false);
  expect(productionMetricsSettings(false, { PRODUCTION_METRICS_ENABLED: 'true' }).enabled).toBe(true);
  const stateDirectory = resolve('fixture-state');
  expect(productionMetricsSettings(true, { STATE_DIRECTORY: stateDirectory }).directory).toBe(join(stateDirectory, 'production-metrics'));
  expect(productionMetricsSettings(true, { STATE_DIRECTORY: stateDirectory, PRODUCTION_METRICS_DIR: 'custom-metrics' }).directory).toBe(resolve('custom-metrics'));
  const f = await fixture(false);
  try {
    expect((await f.app.inject({ url: '/api/access', headers: f.ownerHeaders })).statusCode).toBe(200);
    const result = await f.app.inject({ url: '/api/ops/metrics', headers: f.ownerHeaders });
    expect(result.statusCode).toBe(200);
    expect(result.json<ProductionMetricsResponse>()).toMatchObject({ enabled: false, snapshotAvailable: false,
      windows: { hour: { roles: { owner: { routes: [], chat: { runs: 0 } }, member: { routes: [] } } } } });
    await f.app.close();
    await expect(readdir(f.snapshots)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await f.dispose();
  }
});
