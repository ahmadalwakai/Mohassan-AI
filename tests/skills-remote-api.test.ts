import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SkillRemoteStartResultSchema, SkillRemoteStatusSchema, type SkillRemoteStatus } from '@mohassan/contracts';
import { CodingError } from '@mohassan/coding/security';
import { createDatabase } from '@mohassan/database';
import type { SkillRemoteEntry, SkillRemoteTransport } from '@mohassan/skills';
import { createApplication } from '../apps/server/src/app.js';

const manifest = (name: string) => `---\nname: ${name}\ndescription: يوضح هذا الوصف ما تفعله المهارة.\n---\n\nDo the task carefully.\n`;
/** A transport whose `head` can be held open, so a run stays observable as `running` and can be aborted by shutdown. */
class GateTransport implements SkillRemoteTransport {
  private gate: Promise<void> | null = null; private release: (() => void) | null = null;
  readonly content = manifest('alpha'); readonly blobId = 'b'.repeat(40);
  hold() { this.gate = new Promise((resolve) => { this.release = resolve; }); }
  open() { this.release?.(); this.release = null; this.gate = null; }
  async head(signal: AbortSignal) {
    if (this.gate) await Promise.race([this.gate, new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new CodingError('ABORTED', 'أُلغيت.')), { once: true }))]);
    signal.throwIfAborted();
    return 'a'.repeat(40);
  }
  async ensure(commit: string) { return commit; }
  async children(): Promise<SkillRemoteEntry[]> { return [{ mode: '040000', type: 'tree', objectId: 'c'.repeat(40), size: null, path: 'alpha' }]; }
  async entries(): Promise<SkillRemoteEntry[]> { return [{ mode: '100644', type: 'blob', objectId: this.blobId, size: Buffer.byteLength(this.content), path: 'SKILL.md' }]; }
  async blob() { return new Uint8Array(Buffer.from(this.content, 'utf8')); }
}

describe('GitHub skills source API', () => {
  type Application = Awaited<ReturnType<typeof createApplication>>;
  const webOrigin = 'http://127.0.0.1:3000', secret = 'skills-remote-fixture-internal-secret-0001', setupToken = 'skills-remote-fixture-setup-token-000001';
  const base = { authSecret: 'skills-remote-fixture-auth-secret-000001', internalSecret: secret, setupToken, webOrigin, production: false, runWorker: false };
  const owner = { email: 'skills-remote-owner@example.test', password: 'Skills-Remote-Owner-Password-42' };
  const member = { name: 'Remote member fixture', email: 'skills-remote-member@example.test', password: 'Skills-Remote-Member-Password-42' };
  const remote = { repo: 'owner/skills', ref: 'main', path: 'skills', autoActivate: false, intervalMinutes: 0 };
  const transport = new GateTransport();
  let plain: Application | undefined, configured: Application | undefined, directory = '', plainCookie = '', memberCookie = '', configuredCookie = '';
  const headers = (cookie: string) => ({ 'x-mohassan-internal': secret, origin: webOrigin, ...(cookie ? { cookie } : {}) });
  const cookieOf = (response: { headers: Record<string, unknown> }) => [response.headers['set-cookie']].flat().filter(Boolean).map((value) => String(value).split(';')[0]).join('; ');
  async function bootstrap(application: Application, name: string) {
    expect((await application.app.inject({ method: 'POST', url: '/api/setup', headers: headers(''), payload: { name, ...owner, setupToken } })).statusCode).toBe(200);
    return cookieOf(await application.app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: headers(''), payload: owner }));
  }
  async function status(application: Application, cookie: string): Promise<SkillRemoteStatus> {
    const response = await application.app.inject({ url: '/api/skills/remote', headers: headers(cookie) });
    expect(response.statusCode, response.body).toBe(200);
    return SkillRemoteStatusSchema.parse(response.json());
  }
  async function settled(syncId: string) {
    for (let attempt = 0; attempt < 400; attempt++) {
      const current = await status(configured!, configuredCookie);
      if (current.last?.id === syncId && current.last.status !== 'running') return current;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('sync did not settle');
  }
  beforeAll(async () => {
    directory = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'mohassan-skills-remote-')));
    plain = await createApplication(base);
    plainCookie = await bootstrap(plain, 'Remote plain fixture');
    const invite = await plain.app.inject({ method: 'POST', url: '/api/members/invites', headers: headers(plainCookie), payload: { name: member.name, email: member.email } });
    expect(invite.statusCode, invite.body).toBe(200);
    const token = new URL((invite.json() as { url: string }).url).hash.replace('#invite=', '');
    expect((await plain.app.inject({ method: 'POST', url: '/api/invites/accept', headers: headers(''), payload: { token, name: member.name, password: member.password } })).statusCode).toBe(200);
    memberCookie = cookieOf(await plain.app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: headers(''), payload: { email: member.email, password: member.password } }));
    configured = await createApplication({ ...base, dataDir: join(directory, 'postgres'), skillEngineEnabled: true, skillRemote: { config: remote, problem: null, dataDir: join(directory, 'mirror') }, skillRemoteTransport: transport });
    configuredCookie = await bootstrap(configured, 'Remote configured fixture');
  }, 120000);
  afterAll(async () => {
    await plain?.app.close();
    await configured?.app.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('requires the service secret and a session on both routes', async () => {
    for (const [method, url] of [['GET', '/api/skills/remote'], ['POST', '/api/skills/remote/sync']] as const) {
      const payload = method === 'POST' ? { payload: {} } : {};
      expect((await plain!.app.inject({ method, url, ...payload })).statusCode).toBe(401);
      expect((await plain!.app.inject({ method, url, headers: { 'x-mohassan-internal': secret, origin: webOrigin }, ...payload })).statusCode).toBe(401);
    }
  });
  it('refuses a member on both routes before any handler runs', async () => {
    const read = await plain!.app.inject({ url: '/api/skills/remote', headers: headers(memberCookie) });
    expect(read.statusCode).toBe(403); expect(read.json().error.code).toBe('MEMBER_FORBIDDEN');
    const start = await plain!.app.inject({ method: 'POST', url: '/api/skills/remote/sync', headers: headers(memberCookie), payload: {} });
    expect(start.statusCode).toBe(403); expect(start.json().error.code).toBe('MEMBER_FORBIDDEN');
  });
  it('reports an unconfigured source and refuses to start one', async () => {
    const response = await plain!.app.inject({ url: '/api/skills/remote', headers: headers(plainCookie) });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(SkillRemoteStatusSchema.parse(response.json())).toMatchObject({ configured: false, engineEnabled: false, running: false, last: null, pending: [], repo: null, nextSyncAt: null });
    const start = await plain!.app.inject({ method: 'POST', url: '/api/skills/remote/sync', headers: headers(plainCookie), payload: {} });
    expect(start.statusCode).toBe(409); expect(start.json().error.code).toBe('SKILL_REMOTE_NOT_CONFIGURED');
  });
  it('accepts a sync with 202 before any transport work, reports it running, refuses a second start and finishes with one pending skill', async () => {
    transport.hold();
    const startedAt = Date.now();
    const start = await configured!.app.inject({ method: 'POST', url: '/api/skills/remote/sync', headers: headers(configuredCookie), payload: {} });
    expect(start.statusCode, start.body).toBe(202);
    const { syncId } = SkillRemoteStartResultSchema.parse(start.json());
    expect(Date.now() - startedAt).toBeLessThan(1000);
    const running = await status(configured!, configuredCookie);
    expect(running).toMatchObject({ configured: true, engineEnabled: true, running: true, repo: 'owner/skills', ref: 'main', path: 'skills', autoActivate: false, last: { id: syncId, status: 'running', cause: 'manual' } });
    const again = await configured!.app.inject({ method: 'POST', url: '/api/skills/remote/sync', headers: headers(configuredCookie), payload: {} });
    expect(again.statusCode).toBe(409); expect(again.json().error.code).toBe('SKILL_REMOTE_SYNC_RUNNING');
    transport.open();
    const final = await settled(syncId);
    expect(final.last).toMatchObject({ id: syncId, status: 'succeeded', unchanged: false, commit: 'a'.repeat(40), counts: { total: 1, pendingReview: 1, errors: 0 } });
    expect(final.last!.items).toEqual([expect.objectContaining({ slug: 'alpha', outcome: 'pending_review', code: 'AUTO_ACTIVATE_OFF', verdict: 'pass' })]);
    expect(final.pending.map((entry) => entry.slug)).toEqual(['alpha']);
    expect(final.running).toBe(false);
    const invalid = await configured!.app.inject({ method: 'POST', url: '/api/skills/remote/sync', headers: headers(configuredCookie), payload: { force: true } });
    expect(invalid.statusCode).toBe(400);
  }, 30000);
  it('closes while a run is held and leaves that run failed as aborted instead of running', async () => {
    transport.hold();
    const start = await configured!.app.inject({ method: 'POST', url: '/api/skills/remote/sync', headers: headers(configuredCookie), payload: {} });
    expect(start.statusCode, start.body).toBe(202);
    const { syncId } = SkillRemoteStartResultSchema.parse(start.json());
    expect((await status(configured!, configuredCookie)).running).toBe(true);
    await configured!.app.close();
    configured = undefined;
    const store = await createDatabase({ dataDir: join(directory, 'postgres') });
    try {
      expect(await store.db.selectFrom('skill_remote_syncs').select(['status', 'error_code']).where('id', '=', syncId).executeTakeFirstOrThrow()).toEqual({ status: 'failed', error_code: 'SKILL_REMOTE_SYNC_ABORTED' });
      expect(await store.db.selectFrom('skill_remote_syncs').select('id').where('status', '=', 'running').execute()).toHaveLength(0);
    } finally { await store.close(); }
  }, 60000);
});
