import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApplication } from '../apps/server/src/app.js';

describe('owner backup status', () => {
  const url = '/api/ops/backup-status';
  const origin = 'http://127.0.0.1:3000';
  const secret = 'backup-status-test-service-fixture-0001';
  const setupToken = 'backup-status-test-setup-fixture-0001';
  const owner = { name: 'Backup status owner', email: 'backup-owner@example.test', password: 'Backup-Owner-Fixture-Pass-42' };
  const member = { name: 'Backup status member', email: 'backup-member@example.test', password: 'Backup-Member-Fixture-Pass-42' };
  let application: Awaited<ReturnType<typeof createApplication>> | undefined;
  let directory = '';
  let statusDirectory = '';
  let ownerCookie = '';
  let memberCookie = '';
  const app = () => application!.app;
  const headers = (cookie?: string) => ({ origin, 'x-mohassan-internal': secret, ...(cookie ? { cookie } : {}) });

  async function login({ email, password }: typeof owner) {
    const response = await app().inject({
      method: 'POST', url: '/api/auth/sign-in/email', headers: headers(), payload: { email, password },
    });
    expect(response.statusCode).toBe(200);
    const cookies = [response.headers['set-cookie']].flat().filter(Boolean);
    expect(cookies.length).toBeGreaterThan(0);
    return cookies.map(cookie => String(cookie).split(';')[0]).join('; ');
  }

  async function statusFile(name: string, body: object) {
    await writeFile(join(statusDirectory, name), JSON.stringify(body));
  }

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mohassan-backup-status-'));
    statusDirectory = join(directory, 'status');
    application = await createApplication({
      authSecret: 'backup-status-test-auth-fixture-0001', internalSecret: secret, setupToken,
      webOrigin: origin, production: false, runWorker: false, backupStatusDirectory: statusDirectory,
    });
    const setup = await app().inject({ method: 'POST', url: '/api/setup', headers: headers(), payload: { ...owner, setupToken } });
    expect(setup.statusCode).toBe(200);
    ownerCookie = await login(owner);
    const invite = await app().inject({
      method: 'POST', url: '/api/members/invites', headers: headers(ownerCookie), payload: { name: member.name, email: member.email },
    });
    expect(invite.statusCode).toBe(200);
    const token = new URL(invite.json().url).hash.slice('#invite='.length);
    const accept = await app().inject({
      method: 'POST', url: '/api/invites/accept', headers: headers(), payload: { token, name: member.name, password: member.password },
    });
    expect(accept.statusCode).toBe(200);
    memberCookie = await login(member);
  });

  beforeEach(async () => {
    await rm(statusDirectory, { recursive: true, force: true });
  });

  afterAll(async () => {
    await application?.app.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('returns 403 to a signed-in member and 401 to an anonymous caller with the service credential', async () => {
    const memberResponse = await app().inject({ url, headers: headers(memberCookie) });
    expect(memberResponse.statusCode).toBe(403);
    expect(memberResponse.json().error.code).toBe('MEMBER_FORBIDDEN');
    const anonymousResponse = await app().inject({ url, headers: headers() });
    expect(anonymousResponse.statusCode).toBe(401);
    expect(anonymousResponse.json().error.code).toBe('UNAUTHORIZED');
  });

  it('returns timestamps, dump size, ages and the newest drill verdict to the owner', async () => {
    const now = Date.now();
    const hour = 3_600_000;
    const snapshotAt = new Date(now - 27 * hour).toISOString();
    const finishedAt = new Date(now - 25 * hour).toISOString();
    const drillAt = new Date(now - 2 * hour).toISOString();
    const downloadedAt = new Date(now - 1 * hour).toISOString();
    const sizeBytes = Buffer.byteLength('fixture archive');
    function drillName(at: string) {
      return `restore-drill-${at.replaceAll(':', '')}.json`;
    }
    await mkdir(statusDirectory);
    await statusFile('backup.json', { snapshotAt, finishedAt, sizeBytes, sha256: 'fixture-metadata' });
    await statusFile(drillName(drillAt), { finishedAt: drillAt, verdict: 'failed', counts: { fixture: 1 } });
    const olderDrillAt = new Date(now - 24 * hour).toISOString();
    await statusFile(drillName(olderDrillAt), { finishedAt: olderDrillAt, verdict: 'passed' });
    await statusFile('restore-drill-latest.json', { finishedAt: downloadedAt, verdict: 'passed' });
    await statusFile('off-server-copy.json', { downloadedAt, dump: 'fixture-name' });

    const response = await app().inject({ url, headers: headers(ownerCookie) });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({
      newestDump: { snapshotAt, finishedAt, sizeBytes, ageHours: expect.any(Number) },
      lastDrill: { finishedAt: drillAt, verdict: 'failed', ageHours: expect.any(Number) },
      offServerCopy: { downloadedAt },
    });
    expect(response.json().newestDump.ageHours).toBeCloseTo(27, 1);
    expect(response.json().lastDrill.ageHours).toBeCloseTo(2, 1);
  });

  it.each([undefined, null, '14', 0, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'preserves the dump timestamps when size is missing or invalid (%j)',
    async sizeBytes => {
      const snapshotAt = new Date().toISOString();
      const finishedAt = snapshotAt;
      await mkdir(statusDirectory);
      await statusFile('backup.json', { snapshotAt, finishedAt, sizeBytes });

      const response = await app().inject({ url, headers: headers(ownerCookie) });
      expect(response.statusCode).toBe(200);
      expect(response.json().newestDump).toEqual({ snapshotAt, finishedAt, ageHours: expect.any(Number) });
    },
  );

  it('reports missing or invalid records as unknown', async () => {
    expect((await app().inject({ url, headers: headers(ownerCookie) })).json()).toEqual({
      newestDump: null, lastDrill: null, offServerCopy: null,
    });
    await mkdir(statusDirectory);
    await writeFile(join(statusDirectory, 'backup.json'), '{');
    await statusFile('off-server-copy.json', { downloadedAt: 'invalid' });
    const response = await app().inject({ url, headers: headers(ownerCookie) });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ newestDump: null, lastDrill: null, offServerCopy: null });
  });
});
