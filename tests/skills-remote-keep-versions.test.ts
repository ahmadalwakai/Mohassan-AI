import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SkillRemoteStatusSchema, type SkillRemoteStatus } from '@mohassan/contracts';
import type { SkillRemoteEntry, SkillRemoteTransport } from '@mohassan/skills';
import { createApplication } from '../apps/server/src/app.js';

const oid = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 40);
const manifest = (name: string, body: string) => `---\nname: ${name}\ndescription: يوضح هذا الوصف ما تفعله المهارة.\n---\n\n${body}\n`;
/** One skill folder whose SKILL.md the test rewrites between syncs; ids derive from content, as in Git. */
class EditableRepo implements SkillRemoteTransport {
  content = '';
  async head() { return oid(`commit:${this.content}`); }
  async ensure(commit: string) { return commit; }
  async children(): Promise<SkillRemoteEntry[]> { return [{ mode: '040000', type: 'tree', objectId: oid(`tree:${this.content}`), size: null, path: 'kept-on-server' }]; }
  async entries(): Promise<SkillRemoteEntry[]> { return [{ mode: '100644', type: 'blob', objectId: oid(this.content), size: Buffer.byteLength(this.content), path: 'SKILL.md' }]; }
  async blob() { return new Uint8Array(Buffer.from(this.content, 'utf8')); }
}

// Owner decision for the release (2026-11-22, «بدون حذف»): the server never deletes a GitHub skill version. With retention on,
// the third publication of a skill deletes its first version (packages/skills/src/remote.test.ts); through the application it stays.
describe('the application keeps every GitHub skill version', () => {
  type Application = Awaited<ReturnType<typeof createApplication>>;
  const webOrigin = 'http://127.0.0.1:3000', secret = 'skills-keep-fixture-internal-secret-00001', setupToken = 'skills-keep-fixture-setup-token-0000001';
  const owner = { email: 'skills-keep-owner@example.test', password: 'Skills-Keep-Owner-Password-42' };
  const repo = new EditableRepo();
  let application: Application | undefined, directory = '', cookie = '';
  const headers = () => ({ 'x-mohassan-internal': secret, origin: webOrigin, ...(cookie ? { cookie } : {}) });

  beforeAll(async () => {
    directory = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'mohassan-skills-keep-')));
    application = await createApplication({ authSecret: 'skills-keep-fixture-auth-secret-0000001', internalSecret: secret, setupToken, webOrigin, production: false, runWorker: false,
      dataDir: join(directory, 'postgres'), skillEngineEnabled: true,
      skillRemote: { config: { repo: 'owner/skills', ref: 'main', path: 'skills', autoActivate: true, intervalMinutes: 0 }, problem: null, dataDir: join(directory, 'mirror') }, skillRemoteTransport: repo });
    expect((await application.app.inject({ method: 'POST', url: '/api/setup', headers: headers(), payload: { name: 'Keep versions fixture', ...owner, setupToken } })).statusCode).toBe(200);
    const signIn = await application.app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: headers(), payload: owner });
    cookie = [signIn.headers['set-cookie']].flat().filter(Boolean).map((value) => String(value).split(';')[0]).join('; ');
  }, 120000);
  afterAll(async () => { await application?.app.close(); if (directory) await rm(directory, { recursive: true, force: true }); });

  async function publish(body: string): Promise<SkillRemoteStatus> {
    repo.content = manifest('kept-on-server', body);
    const started = await application!.app.inject({ method: 'POST', url: '/api/skills/remote/sync', headers: headers(), payload: {} });
    expect(started.statusCode, started.body).toBe(202);
    const { syncId } = started.json() as { syncId: string };
    for (let attempt = 0; attempt < 400; attempt++) {
      const response = await application!.app.inject({ url: '/api/skills/remote', headers: headers() });
      const current = SkillRemoteStatusSchema.parse(response.json());
      if (current.last?.id === syncId && current.last.status !== 'running') return current;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('sync did not settle');
  }

  // Four publications: the sync route accepts four starts a minute, and with retention on the third one already deletes the first version.
  it('stores four publications of one skill and still holds all four', async () => {
    const ids: string[] = [];
    for (const body of ['First body.', 'Second body.', 'Third body.', 'Fourth body.']) {
      const status = await publish(body);
      expect(status.last).toMatchObject({ status: 'succeeded', counts: { activated: 1, errors: 0, pruned: 0 } });
      ids.push(status.last!.items.find((item) => item.slug === 'kept-on-server')!.versionId!);
    }
    expect(new Set(ids).size).toBe(4);
    const db = application!.database.db;
    const rows = await db.selectFrom('skill_versions as v').innerJoin('skill_families as f', 'f.id', 'v.family_id').select(['v.id', 'v.version', 'v.status']).where('f.slug', '=', 'kept-on-server').orderBy('v.sequence').execute();
    expect(rows.map((row) => [row.version, row.status])).toEqual([['1.0.0', 'deprecated'], ['1.0.1', 'deprecated'], ['1.0.2', 'deprecated'], ['1.0.3', 'active']]);
    expect(rows.map((row) => row.id)).toEqual(ids);
    expect(await db.selectFrom('skill_version_tombstones').select('version').execute()).toEqual([]);
    expect(await db.selectFrom('skill_audit').select('event').where('event', '=', 'skill.pruned').execute()).toEqual([]);
    // Every old version is still served by the library route, not only present in the table.
    for (const id of ids) expect((await application!.app.inject({ url: `/api/skills/${id}`, headers: headers() })).statusCode).toBe(200);
  }, 120000);
});
