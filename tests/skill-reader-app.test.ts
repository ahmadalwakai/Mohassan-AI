import { cp, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SearchProvider } from '@mohassan/browser';
import { SkillDetailSchema, SkillImportResultSchema } from '@mohassan/contracts';
import { createApplication } from '../apps/server/src/app.js';

/** The whole path on a disposable server: import → inspection → explicit activation → the model-free chat answers from the skill. */
describe('an activated skill answers in the real application', () => {
  type Application = Awaited<ReturnType<typeof createApplication>>;
  let application: Application | undefined, directory = '', cookie = '';
  const webOrigin = 'http://127.0.0.1:3000', secret = 'skill-reader-app-fixture-internal-secret-01', setupToken = 'skill-reader-app-fixture-setup-token-0001';
  const owner = { email: 'skill-reader-owner@example.test', password: 'Skill-Reader-Owner-Password-42' };
  const search = vi.fn<SearchProvider['search']>(async () => []);
  const headers = () => ({ 'x-mohassan-internal': secret, origin: webOrigin, ...(cookie ? { cookie } : {}) });
  const app = () => application!.app;
  async function post(url: string, payload: unknown) {
    const response = await app().inject({ method: 'POST', url, headers: headers(), payload: payload as Record<string, unknown> });
    expect(response.statusCode, `${url}: ${response.body}`).toBeLessThan(300);
    return response.json();
  }
  async function ask(goal: string) {
    const { id } = await post('/api/chat/conversations', { goal });
    for (let attempt = 0; attempt < 400; attempt++) {
      const detail = (await app().inject({ url: `/api/chat/conversations/${id}`, headers: headers() })).json();
      if (detail.status !== 'running') return detail as { status: string; messages: { role: string; text: string }[]; error: unknown };
      await new Promise(resolveWait => setTimeout(resolveWait, 50));
    }
    throw new Error('chat did not settle');
  }

  beforeAll(async () => {
    directory = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'mohassan-skill-reader-')));
    application = await createApplication({ authSecret: 'skill-reader-app-fixture-auth-secret-0001', internalSecret: secret, setupToken, webOrigin, production: false, runWorker: false,
      skillEngineEnabled: true, codingAllowedRoots: [directory], browserProfileDir: join(directory, 'browser'), browser: { searchProvider: { name: 'recorded-search', search } } });
    expect((await app().inject({ method: 'POST', url: '/api/setup', headers: headers(), payload: { name: 'Skill reader fixture', ...owner, setupToken } })).statusCode).toBe(200);
    const login = await app().inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: headers(), payload: owner });
    cookie = [login.headers['set-cookie']].flat().filter(Boolean).map(value => String(value).split(';')[0]).join('; ');
  }, 120000);
  afterAll(async () => { await application?.app.close(); if (directory) await rm(directory, { recursive: true, force: true }); });

  it('uses no skill before activation, then answers from it once the owner activated it', async () => {
    const folder = join(directory, 'arabic-seo-article');
    await cp(resolve('skills', 'arabic-seo-article'), folder, { recursive: true });
    const imported = SkillImportResultSchema.parse(await post('/api/skills/import', { path: folder }));
    expect(imported.skill).toMatchObject({ status: 'quarantined', level: 'instruction', active: false });

    const before = await ask('كيف أكتب مقال سيو يتصدر جوجل؟');
    expect(before.messages.at(-1)?.text ?? '').not.toContain('المصدر: مهارة');
    expect(search).toHaveBeenCalled();
    search.mockClear();

    const inspected = SkillDetailSchema.parse(await post(`/api/skills/${imported.skill.id}/inspect`, { expectedRevision: imported.skill.revision }));
    expect(inspected.inspection).toMatchObject({ verdict: 'pass', findings: [] });
    const activated = SkillDetailSchema.parse(await post(`/api/skills/${imported.skill.id}/activate`, { expectedRevision: inspected.skill.revision, approve: true }));
    expect(activated.skill).toMatchObject({ status: 'active', active: true });

    const after = await ask('كيف أكتب مقال سيو يتصدر جوجل؟');
    const text = after.messages.at(-1)?.text ?? '';
    expect(after.error).toBeNull();
    expect(search).not.toHaveBeenCalled();
    expect(text.startsWith('**كتابة مقال متوافق مع محركات البحث**')).toBe(true);
    expect(text).toContain('**الخطوات**');
    expect(text).toContain(`المصدر: مهارة «كتابة مقال متوافق مع محركات البحث» (${activated.skill.slug})، الإصدار ${activated.skill.version}.`);

    // Revoking the skill takes it out of the answers at once.
    await post(`/api/skills/${imported.skill.id}/revoke`, { expectedRevision: activated.skill.revision, reason: 'اختبار إلغاء المهارة من الإجابات.' });
    const revoked = await ask('كيف أكتب مقال سيو يتصدر جوجل؟');
    expect(revoked.messages.at(-1)?.text ?? '').not.toContain('المصدر: مهارة');
    expect(search).toHaveBeenCalled();
  }, 180000);
});
