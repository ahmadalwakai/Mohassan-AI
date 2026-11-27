import { SiteDetailSchema, SiteSummarySchema, SiteWantSchema } from '@mohassan/contracts';
import { listZip } from '@mohassan/sites';
import { PNG } from 'pngjs';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { checkError, checkJson, openClientApiApp } from './support/client-api-app.js';

const draft = {
  lang: 'ar', kind: 'restaurant', name: 'بيت الشام',
  request: 'موقع لمطعم فيه الأسئلة الشائعة وخريطة',
  answers: {
    items: 'شاورما لحم - 25\nفتوش - 12\nكنافة - 15', contact: '0933123456 واتساب',
    city: 'دمشق', faq: 'هل يوجد توصيل؟\nنعم داخل المدينة.', hours: 'يومياً ١١ صباحاً - ١٢ منتصف الليل',
  },
};

// The response wrappers come from the handlers without package-level schemas.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/sites.ts (retrieved 2026-11-27)
const siteList = z.strictObject({
  sites: z.array(SiteSummarySchema),
  publish: z.strictObject({ available: z.boolean(), provider: z.string() }),
});
const commandResult = z.strictObject({
  kind: z.enum(['patch', 'undo', 'ask', 'unknown']), summary: z.string(),
  want: SiteWantSchema.optional(), title: z.string().optional(), detail: SiteDetailSchema,
});

it('validates the Sites client draft, edit, assets, preview, export, and publish contracts', async () => {
  const deploymentHost = 'site-fixture.vercel.app';
  const publisher = vi.fn<typeof fetch>(async (input, init) => {
    expect(new URL(String(input)).pathname).toBe('/v13/deployments');
    expect(init?.method).toBe('POST');
    return Response.json({ id: 'dpl_fixture', readyState: 'READY', url: deploymentHost, alias: [deploymentHost] });
  });
  const { send, setupOwner, inviteMember, close } = await openClientApiApp({
    sites: { vercelToken: 'fixture-token', publishTarget: 'vercel', fetch: publisher },
  });
  try {
    const owner = await setupOwner();
    const member = await inviteMember(owner);
    checkJson(await send('POST', '/api/sites/draft', member, { lang: 'ar' }), 200,
      z.strictObject({ missing: z.array(SiteWantSchema).min(1) }));
    const site = checkJson(await send('POST', '/api/sites/draft', member, draft), 200, SiteDetailSchema);
    const path = `/api/sites/${site.id}`;
    const listed = checkJson(await send('GET', '/api/sites', member), 200, siteList);
    expect(listed.sites.map(entry => entry.id)).toContain(site.id);
    // Production advertises publishing to the member client when the authenticated owner has configured it.
    expect(listed.publish).toEqual({ available: true, provider: 'vercel' });
    checkError(await send('POST', `${path}/publish`, member, {}), 403, 'MEMBER_FORBIDDEN');
    expect(publisher).not.toHaveBeenCalled();
    expect(checkJson(await send('GET', path, member), 200, SiteDetailSchema)).toEqual(site);
    checkError(await send('GET', path, owner), 404, 'SITE_NOT_FOUND');

    const preview = await send('GET', `${site.previewPath}index.html`);
    expect(preview.statusCode).toBe(200);
    expect(preview.headers['content-type']).toMatch(/^text\/html/u);
    expect(preview.body).toContain(site.name);
    expect(preview.headers['content-security-policy']).toContain('sandbox');
    const previewMissing = await send('GET', `${site.previewPath}missing.html`);
    expect(previewMissing.statusCode).toBe(404);
    expect(previewMissing.headers['content-type']).toMatch(/^text\/html/u);

    const changedBrief = { revision: site.revision, brief: { ...site.brief, tagline: 'مطبخ شامي أصيل' } };
    const changed = checkJson(await send('POST', `${path}/brief`, member, changedBrief), 200, SiteDetailSchema);
    expect(changed.brief.tagline).toBe(changedBrief.brief.tagline);
    checkError(await send('POST', `${path}/brief`, member, changedBrief), 409, 'SITE_REVISION_CONFLICT');
    const asked = checkJson(await send('POST', `${path}/commands`, member, { text: 'أضف قسم الفريق' }), 200, commandResult);
    expect(asked).toMatchObject({ kind: 'ask', want: 'team' });
    const answered = checkJson(await send('POST', `${path}/commands`, member,
      { text: 'سامر - مدير الصالة', want: asked.want }), 200, commandResult);
    expect(answered).toMatchObject({ kind: 'patch' });
    expect(checkJson(await send('POST', `${path}/undo`, member, {}), 200, SiteDetailSchema).brief).toEqual(changed.brief);
    checkJson(await send('POST', `${path}/regenerate`, member, {}), 200, SiteDetailSchema);

    const png = PNG.sync.write(new PNG({ width: 32, height: 32, fill: true }));
    const uploaded = checkJson(await send('POST', `${path}/images`, member, {
      mimeType: 'image/png', data: png.toString('base64'), alt: 'Fixture image', role: 'gallery',
    }), 200, SiteDetailSchema);
    expect(uploaded.images).toHaveLength(1);
    const image = uploaded.images[0]!;
    const asset = await send('GET', `${uploaded.previewPath}assets/${image.id}.png`);
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['content-type']).toBe('image/png');
    expect(PNG.sync.read(asset.rawPayload).width).toBe(image.width);
    expect(checkJson(await send('DELETE', `${path}/images/${image.id}`, member), 200, SiteDetailSchema).images).toEqual([]);

    const archive = await send('GET', `${path}/export`, member);
    expect(archive.statusCode).toBe(200);
    expect(archive.headers['content-type']).toBe('application/zip');
    expect(listZip(archive.rawPayload).map(file => file.path)).toContain('index.html');
    checkJson(await send('DELETE', path, member), 200, z.strictObject({ ok: z.literal(true) }));
    checkError(await send('GET', path, member), 404, 'SITE_NOT_FOUND');

    const ownerSite = checkJson(await send('POST', '/api/sites/draft', owner, draft), 200, SiteDetailSchema);
    const published = checkJson(await send('POST', `/api/sites/${ownerSite.id}/publish`, owner, {}), 200, SiteDetailSchema);
    expect(published).toMatchObject({ status: 'published', publishedUrl: `https://${deploymentHost}` });
    expect(publisher).toHaveBeenCalled();
  } finally {
    await close();
  }
}, 90_000);
