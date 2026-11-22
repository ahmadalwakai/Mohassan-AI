/**
 * The sites API end to end on the real application: a site from the form answers, a cookie-free preview by
 * token, plain-language commands, undo, images, ZIP export, member gating and a publish against a fake Vercel.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { listZip } from '@mohassan/sites';
import { createApplication } from '../apps/server/src/app.js';

const secret = 'sites-api-internal-secret-0000000001', origin = 'http://127.0.0.1:3000', setupToken = 'sites-api-setup-token-00000000001';

describe('sites API', () => {
  const open: Awaited<ReturnType<typeof createApplication>>[] = [];
  afterEach(async () => { await Promise.all(open.splice(0).map(item => item.app.close())); });

  async function boot(vercel?: typeof fetch) {
    const directory = await mkdtemp(join(tmpdir(), 'mohassan-sites-api-'));
    const application = await createApplication({
      authSecret: 'sites-api-auth-secret-00000000000001', internalSecret: secret, setupToken, webOrigin: origin, production: false, runWorker: false,
      codingAllowedRoots: [directory], browserProfileDir: join(directory, 'profile'), browserChannel: null, testRequestLimit: 2000,
      ...(vercel ? { sites: { vercelToken: 'test-token', publishTarget: 'vercel', fetch: vercel } } : {}),
    });
    open.push(application);
    const app = application.app, account = { email: 'sites-owner@example.test', password: 'Sites-owner-password-42', name: 'Owner' };
    const base = { 'x-mohassan-internal': secret, origin };
    await app.inject({ method: 'POST', url: '/api/setup', headers: base, payload: { ...account, setupToken } });
    const login = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: base, payload: account });
    const headers = { ...base, cookie: [login.headers['set-cookie']].flat().filter(Boolean).map(value => String(value).split(';')[0]).join('; ') };
    return { app, application, base, headers };
  }
  const draft = { lang: 'ar', kind: 'restaurant', name: 'بيت الشام', request: 'موقع لمطعم فيه الأسئلة الشائعة وخريطة', answers: { items: 'شاورما لحم - 25\nفتوش - 12\nكنافة - 15', contact: '0933123456 واتساب', city: 'دمشق', faq: 'هل يوجد توصيل؟\nنعم داخل المدينة.', hours: 'يومياً ١١ صباحاً - ١٢ منتصف الليل' } };

  it('builds a site from answers, previews it without a cookie, edits it by sentence and exports a ZIP', async () => {
    const { app, headers, base } = await boot();
    const created = await app.inject({ method: 'POST', url: '/api/sites/draft', headers, payload: draft });
    expect(created.statusCode, created.body).toBe(200);
    const site = created.json();
    expect(site.brief.name).toBe('بيت الشام');
    expect(site.brief.items).toHaveLength(3);
    expect(site.brief.pages.flatMap((page: { blocks: { type: string }[] }) => page.blocks.map(block => block.type))).toEqual(expect.arrayContaining(['hero', 'items', 'faq', 'contact', 'hours']));
    expect(site.checks.passed).toBe(true);
    expect(site.previewPath).toMatch(new RegExp(`^/api/sites/${site.id}/p/[A-Za-z0-9_-]{32}/$`));

    // The preview: internal header only, no session cookie, exact media types, a sandboxing CSP, the site's own 404.
    const index = await app.inject({ method: 'GET', url: `${site.previewPath}index.html`, headers: base });
    expect(index.statusCode).toBe(200);
    expect(index.headers['content-type']).toContain('text/html');
    expect(String(index.headers['content-security-policy'])).toContain('sandbox');
    expect(index.body).toContain('بيت الشام');
    const css = await app.inject({ method: 'GET', url: `${site.previewPath}styles.css`, headers: base });
    expect(css.statusCode).toBe(200);
    expect(css.headers['content-type']).toContain('text/css');
    const root = await app.inject({ method: 'GET', url: site.previewPath, headers: base });
    expect(root.statusCode).toBe(200);
    const missing = await app.inject({ method: 'GET', url: `${site.previewPath}nope.html`, headers: base });
    expect(missing.statusCode).toBe(404);
    expect(missing.body).toContain('<!DOCTYPE html>');
    const wrongToken = await app.inject({ method: 'GET', url: `/api/sites/${site.id}/p/${'x'.repeat(32)}/index.html`, headers: base });
    expect(wrongToken.statusCode).toBe(404);
    const traversal = await app.inject({ method: 'GET', url: `${site.previewPath}..%2F..%2Fpackage.json`, headers: base });
    expect([400, 404]).toContain(traversal.statusCode);
    const anonymous = await app.inject({ method: 'GET', url: `/api/sites/${site.id}`, headers: base });
    expect(anonymous.statusCode).toBe(401);

    // Commands: a patch, an ask for content, the answer to it, undo.
    const colour = await app.inject({ method: 'POST', url: `/api/sites/${site.id}/commands`, headers, payload: { text: 'غيّر اللون إلى أزرق' } });
    expect(colour.json().kind).toBe('patch');
    expect(colour.json().detail.brief.primary).toBe('#1d4ed8');
    expect(colour.json().detail.revision).toBe(site.revision + 1);
    const ask = await app.inject({ method: 'POST', url: `/api/sites/${site.id}/commands`, headers, payload: { text: 'أضف قسم الفريق' } });
    expect(ask.json().kind).toBe('ask');
    expect(ask.json().want).toBe('team');
    const answered = await app.inject({ method: 'POST', url: `/api/sites/${site.id}/commands`, headers, payload: { text: 'أبو أحمد - الشيف\nسامر - مدير الصالة', want: 'team' } });
    expect(answered.json().kind).toBe('patch');
    expect(answered.json().detail.brief.pages.flatMap((page: { blocks: { type: string }[] }) => page.blocks.map(block => block.type))).toContain('team');
    const unknown = await app.inject({ method: 'POST', url: `/api/sites/${site.id}/commands`, headers, payload: { text: 'ما رأيك بالطقس؟' } });
    expect(unknown.json().kind).toBe('unknown');
    const undone = await app.inject({ method: 'POST', url: `/api/sites/${site.id}/undo`, headers, payload: {} });
    expect(undone.statusCode).toBe(200);
    expect(undone.json().brief.pages.flatMap((page: { blocks: { type: string }[] }) => page.blocks.map(block => block.type))).not.toContain('team');
    // The old token no longer serves: every revision has its own.
    const stale = await app.inject({ method: 'GET', url: `${site.previewPath}index.html`, headers: base });
    expect(stale.statusCode).toBe(404);

    // ZIP export lists every file.
    const archive = await app.inject({ method: 'GET', url: `/api/sites/${site.id}/export`, headers });
    expect(archive.statusCode).toBe(200);
    expect(archive.headers['content-type']).toContain('application/zip');
    const entries = listZip(Buffer.from(archive.rawPayload));
    expect(entries.map(entry => entry.path)).toEqual(expect.arrayContaining(['index.html', 'styles.css', 'site.js', 'assets/logo.svg', '404.html']));

    // The list and the brief update.
    const list = await app.inject({ method: 'GET', url: '/api/sites', headers });
    expect(list.json().sites).toHaveLength(1);
    expect(list.json().publish.available).toBe(false);
    const current = (await app.inject({ method: 'GET', url: `/api/sites/${site.id}`, headers })).json();
    const updated = await app.inject({ method: 'POST', url: `/api/sites/${site.id}/brief`, headers, payload: { brief: { ...current.brief, tagline: 'مطبخ شامي أصيل' }, revision: current.revision } });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json().brief.tagline).toBe('مطبخ شامي أصيل');
    const conflict = await app.inject({ method: 'POST', url: `/api/sites/${site.id}/brief`, headers, payload: { brief: current.brief, revision: current.revision } });
    expect(conflict.statusCode).toBe(409);
    const publish = await app.inject({ method: 'POST', url: `/api/sites/${site.id}/publish`, headers, payload: {} });
    expect(publish.statusCode).toBe(409);
  });

  it('stores an uploaded image, serves it in the preview and removes it', async () => {
    const { app, headers, base } = await boot();
    const site = (await app.inject({ method: 'POST', url: '/api/sites/draft', headers, payload: draft })).json();
    const png = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 200, g: 120, b: 40 } } }).png().toBuffer();
    const uploaded = await app.inject({ method: 'POST', url: `/api/sites/${site.id}/images`, headers, payload: { mimeType: 'image/png', data: png.toString('base64'), alt: 'صحن مشاوي', role: 'gallery' } });
    expect(uploaded.statusCode, uploaded.body).toBe(200);
    const detail = uploaded.json();
    expect(detail.images).toHaveLength(1);
    expect(detail.brief.pages.flatMap((page: { blocks: { type: string }[] }) => page.blocks.map(block => block.type))).toContain('gallery');
    const image = detail.images[0];
    const served = await app.inject({ method: 'GET', url: `${detail.previewPath}assets/${image.id}.png`, headers: base });
    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toBe('image/png');
    const small = await app.inject({ method: 'GET', url: `${detail.previewPath}assets/${image.id}-small.png`, headers: base });
    expect(small.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `${detail.previewPath}index.html`, headers: base })).body).toContain(`assets/${image.id}.png`);
    const bad = await app.inject({ method: 'POST', url: `/api/sites/${site.id}/images`, headers, payload: { mimeType: 'image/png', data: Buffer.from('not an image at all, really').toString('base64'), alt: 'x', role: 'gallery' } });
    expect(bad.statusCode).toBe(400);
    const removed = await app.inject({ method: 'DELETE', url: `/api/sites/${site.id}/images/${image.id}`, headers });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().images).toHaveLength(0);
    // Undoing an upload also deletes the stored photo, so the list never shows an image the site does not use.
    const second = (await app.inject({ method: 'POST', url: `/api/sites/${site.id}/images`, headers, payload: { mimeType: 'image/png', data: png.toString('base64'), alt: 'واجهة المطعم', role: 'hero' } })).json();
    expect(second.images).toHaveLength(1);
    const undone = await app.inject({ method: 'POST', url: `/api/sites/${site.id}/undo`, headers, payload: {} });
    expect(undone.statusCode).toBe(200);
    expect(undone.json().images).toHaveLength(0);
    expect(undone.json().brief.images).toHaveLength(0);
  });

  it('publishes through the Vercel adapter and records the URL', async () => {
    const calls: { url: string; method: string; body?: unknown }[] = [];
    const vercel: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.includes('/v13/deployments?')) return new Response(JSON.stringify({ id: 'dpl_123', url: 'mohassan-site-x.vercel.app', readyState: 'BUILDING', alias: [] }), { status: 200 });
      if (url.includes('/v13/deployments/dpl_123')) return new Response(JSON.stringify({ id: 'dpl_123', readyState: 'READY', url: 'mohassan-site-x.vercel.app', alias: ['mohassan-site-x.vercel.app'] }), { status: 200 });
      return new Response('{}', { status: 404 });
    };
    const { app, headers } = await boot(vercel);
    const site = (await app.inject({ method: 'POST', url: '/api/sites/draft', headers, payload: draft })).json();
    expect((await app.inject({ method: 'GET', url: '/api/sites', headers })).json().publish).toEqual({ available: true, provider: 'vercel' });
    const published = await app.inject({ method: 'POST', url: `/api/sites/${site.id}/publish`, headers, payload: {} });
    expect(published.statusCode, published.body).toBe(200);
    expect(published.json().status).toBe('published');
    expect(published.json().publishedUrl).toBe('https://mohassan-site-x.vercel.app');
    const deployments = calls.filter(call => call.method === 'POST');
    // Two deployments: the first learns the URL, the second carries absolute sitemap and canonical links.
    expect(deployments).toHaveLength(2);
    const files = (deployments[1]!.body as { files: { file: string; data: string; encoding: string }[] }).files;
    expect(files.map(file => file.file)).toEqual(expect.arrayContaining(['index.html', 'sitemap.xml', 'robots.txt']));
    expect(Buffer.from(files.find(file => file.file === 'sitemap.xml')!.data, 'base64').toString('utf8')).toContain('https://mohassan-site-x.vercel.app/');
    expect((deployments[0]!.body as { projectSettings: { framework: null } }).projectSettings.framework).toBeNull();
  });

  it('lets a member build and preview a site but not publish it', async () => {
    const { app, headers, base, application } = await boot();
    const invite = await app.inject({ method: 'POST', url: '/api/members/invites', headers, payload: { name: 'Member', email: 'member@example.test' } });
    const token = new URL(invite.json().url).hash.replace('#invite=', '');
    await app.inject({ method: 'POST', url: '/api/invites/accept', headers: base, payload: { token, name: 'Member', password: 'Member-password-000042' } });
    const login = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: base, payload: { email: 'member@example.test', password: 'Member-password-000042' } });
    const member = { ...base, cookie: [login.headers['set-cookie']].flat().filter(Boolean).map(value => String(value).split(';')[0]).join('; ') };
    const access = await app.inject({ method: 'GET', url: '/api/access', headers: member });
    expect(access.json().services).toContain('sites');
    const created = await app.inject({ method: 'POST', url: '/api/sites/draft', headers: member, payload: draft });
    expect(created.statusCode, created.body).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/sites/${created.json().id}`, headers: member })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/sites/${created.json().id}`, headers })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/sites/${created.json().id}/publish`, headers: member, payload: {} })).statusCode).toBe(403);
    expect(application.routes.has('GET /api/sites/:id/p/:token/*')).toBe(true);
  });
});
