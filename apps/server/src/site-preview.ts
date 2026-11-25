import type { Kysely } from 'kysely';
import { z } from 'zod';

const filePath = /^(?:[a-z0-9][a-z0-9-]{0,40}\/)?[a-z0-9][a-z0-9._-]{0,80}\.[a-z0-9]{2,11}$/;
const previewFiles = z.array(z.object({ path: z.string(), content: z.string(), contentType: z.string() }));

type PreviewFile = { bytes: Buffer; contentType: string; status: number };

/** Read the supplied revision only after validating the public preview token. */
export function createSitePreviewReader(db: Kysely<any>, matchesToken: (id: string, revision: number, token: string) => boolean) {
  return async (id: string, token: string, path: string): Promise<PreviewFile | null> => {
    const wanted = path === '' ? 'index.html' : path;
    if (!filePath.test(wanted) || !/^[A-Za-z0-9_-]{32}$/.test(token) || !z.uuid().safeParse(id).success) return null;
    const site = await db.selectFrom('sites').select('revision').where('id', '=', id).executeTakeFirst();
    if (!site || !matchesToken(id, site.revision, token)) return null;

    const asset = wanted.match(/^assets\/([0-9a-f-]{36})(-small)?\.(png|jpg|webp)$/);
    if (asset) {
      const image = await db.selectFrom('site_images').innerJoin('sites', 'sites.id', 'site_images.site_id')
        .select(['site_images.data_base64', 'site_images.small_base64', 'site_images.mime_type'])
        .where('site_images.id', '=', asset[1]!).where('sites.id', '=', id).where('sites.revision', '=', site.revision)
        .executeTakeFirst();
      if (image) {
        const data = asset[2] && image.small_base64 ? image.small_base64 : image.data_base64;
        return { bytes: Buffer.from(data, 'base64'), contentType: image.mime_type, status: 200 };
      }
    }

    const row = await db.selectFrom('sites').select('files').where('id', '=', id).where('revision', '=', site.revision).executeTakeFirst();
    if (!row) return null;
    const files = previewFiles.parse(row.files);
    const file = files.find(entry => entry.path === wanted);
    const fallback = file ?? files.find(entry => entry.path === '404.html');
    return fallback ? { bytes: Buffer.from(fallback.content, 'utf8'), contentType: fallback.contentType, status: file ? 200 : 404 } : null;
  };
}
