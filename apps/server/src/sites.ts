import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import sharp from 'sharp';
import { SiteBriefSchema, SiteCheckReportSchema, SiteDetailSchema, SiteKindSchema, SiteLangSchema, SiteSummarySchema, SiteWantSchema, type SiteBrief, type SiteCheckReport, type SiteDetail, type SiteImageRef, type SitePartialBrief, type SiteSummary, type SiteWant } from '@mohassan/contracts';
import { applyAnswers, applyPatch, checkSite, completeBrief, composeSite, contentTypeFor, detectRequests, fulfilWant, GENERATOR_VERSION, siteCommand, slugify, zipFiles, type SiteFile, type SiteImageAsset } from '@mohassan/sites';
import { noPublisher, PublishError, type SitePublisher } from './sites-publish.js';
import type { WorkspaceRole } from './members.js';

/**
 * Generated websites: the brief is the source of truth, the composed text files are the snapshot the
 * user previewed, images live in their own table. Nothing here calls a model. The preview route is
 * public behind a per-revision token because a sandboxed iframe sends no session cookie.
 */
export class SiteError extends Error { constructor(public readonly code: string, message: string, public readonly statusCode = 400) { super(message); this.name = 'SiteError'; } }

export interface SitesConfig {
  /** Keys the preview tokens; the server's internal secret is fine. */
  tokenSecret: string;
  publisher?: SitePublisher;
  /** Proposals until the owner sets them: sites per account and images per site. */
  limits?: { ownerSites?: number; memberSites?: number; imagesPerSite?: number };
  now?: () => Date;
}
const IMAGE_LIMIT_BYTES = 1_048_576;
const MAX_FILES_JSON = 4_000_000;
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const UploadInput = z.object({
  mimeType: z.enum(['image/png', 'image/jpeg']),
  data: z.string().min(16).max(1_400_000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  alt: z.string().trim().min(1).max(200),
  role: z.enum(['hero', 'gallery', 'about', 'logo', 'team', 'item']).default('gallery'),
}).strict();
const BriefUpdate = z.object({ brief: SiteBriefSchema, revision: z.number().int().min(1) }).strict();
const CommandInput = z.object({ text: z.string().trim().min(1).max(4000), want: z.enum(['about', 'team', 'faq', 'pricing', 'projects', 'features', 'steps', 'facts', 'testimonials', 'posts', 'hours', 'address']).optional() }).strict();
const FILE_PATH = /^(?:[a-z0-9][a-z0-9-]{0,40}\/)?[a-z0-9][a-z0-9._-]{0,80}\.[a-z0-9]{2,11}$/;

interface SiteRow { id: string; owner_id: string; conversation_id: string | null; slug: string; brief: unknown; files: unknown; files_hash: string; checks: unknown; history: unknown; revision: number; generator_version: string; status: string; published_url: string | null; published_at: Date | null; publish: unknown; created_at: Date; updated_at: Date }
interface ImageRow { id: string; site_id: string; owner_id: string; mime_type: string; width: number; height: number; data_base64: string; small_base64: string | null; alt: string; role: string; created_at: Date }
type TextFile = { path: string; content: string; contentType: string };

export async function sitesMigration(db: Kysely<any>) {
  await db.transaction().execute(async tx => {
    await sql`SELECT pg_advisory_xact_lock(1846021109)`.execute(tx);
    if (await tx.selectFrom('schema_migrations').select('version').where('version', '=', '030_sites').executeTakeFirst()) return;
    await sql`CREATE TABLE IF NOT EXISTS sites (
      id text PRIMARY KEY, owner_id text NOT NULL, conversation_id text, slug text NOT NULL,
      brief jsonb NOT NULL, files jsonb NOT NULL, files_hash text NOT NULL, checks jsonb NOT NULL, history jsonb NOT NULL DEFAULT '[]',
      revision integer NOT NULL DEFAULT 1, generator_version text NOT NULL,
      status text NOT NULL CHECK (status IN ('draft', 'ready', 'published', 'failed')),
      published_url text, published_at timestamptz, publish jsonb,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`.execute(tx);
    await sql`CREATE INDEX IF NOT EXISTS sites_owner_idx ON sites(owner_id, updated_at)`.execute(tx);
    await sql`CREATE TABLE IF NOT EXISTS site_images (
      id text PRIMARY KEY, site_id text NOT NULL REFERENCES sites(id) ON DELETE CASCADE, owner_id text NOT NULL,
      mime_type text NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg')), width integer NOT NULL, height integer NOT NULL,
      data_base64 text NOT NULL CHECK (char_length(data_base64) <= 1400000), small_base64 text, alt text NOT NULL, role text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now())`.execute(tx);
    await sql`CREATE INDEX IF NOT EXISTS site_images_site_idx ON site_images(site_id)`.execute(tx);
    await tx.insertInto('schema_migrations').values({ version: '030_sites' }).execute();
  });
}

export async function createSitesControl(db: Kysely<any>, config: SitesConfig) {
  await sitesMigration(db);
  const publisher = config.publisher ?? noPublisher;
  const now = config.now ?? (() => new Date());
  const limits = { ownerSites: config.limits?.ownerSites ?? 100, memberSites: config.limits?.memberSites ?? 5, imagesPerSite: config.limits?.imagesPerSite ?? 12 };

  const token = (id: string, revision: number) => createHmac('sha256', config.tokenSecret).update(`${id}:${revision}`).digest('base64url').slice(0, 32);
  const tokenValid = (id: string, revision: number, candidate: string) => { const expected = Buffer.from(token(id, revision)), given = Buffer.from(candidate); return expected.length === given.length && timingSafeEqual(expected, given); };
  const previewPath = (id: string, revision: number) => `/api/sites/${id}/p/${token(id, revision)}/`;

  const imageAssets = (rows: ImageRow[]): SiteImageAsset[] => rows.map(row => ({ id: row.id, role: row.role as SiteImageRef['role'], alt: row.alt, ext: row.mime_type === 'image/png' ? 'png' : 'jpg', bytes: Buffer.from(row.data_base64, 'base64'), width: row.width, height: row.height, ...(row.small_base64 ? { small: Buffer.from(row.small_base64, 'base64') } : {}) }));
  async function imagesOf(siteId: string, connection: Kysely<any> = db): Promise<ImageRow[]> {
    return connection.selectFrom('site_images').selectAll().where('site_id', '=', siteId).orderBy('created_at', 'asc').execute() as Promise<ImageRow[]>;
  }
  /** Composes and checks; only text files are stored, images are joined back at serve time. */
  function build(brief: SiteBrief, images: ImageRow[], options: { baseUrl?: string } = {}) {
    const assets = imageAssets(images);
    const site = composeSite(brief, { images: assets, generatorVersion: GENERATOR_VERSION, ...options });
    const checks = checkSite(site.files, brief);
    const text: TextFile[] = site.files.filter((file): file is SiteFile & { content: string } => typeof file.content === 'string').map(file => ({ path: file.path, content: file.content, contentType: file.contentType }));
    const json = JSON.stringify(text);
    if (Buffer.byteLength(json) > MAX_FILES_JSON) throw new SiteError('SITE_TOO_LARGE', 'تجاوز الموقع حد الحفظ؛ قلّل النصوص أو الصفحات.', 413);
    return { site, checks, text, filesHash: sha256(json), warnings: site.warnings };
  }
  async function rowFor(ownerId: string, id: string, connection: Kysely<any> = db, lock = false): Promise<SiteRow> {
    let query = connection.selectFrom('sites').selectAll().where('id', '=', id).where('owner_id', '=', ownerId);
    if (lock) query = query.forUpdate();
    const row = await query.executeTakeFirst() as SiteRow | undefined;
    if (!row) throw new SiteError('SITE_NOT_FOUND', 'لم يُعثر على الموقع.', 404);
    return row;
  }
  const summary = (row: SiteRow): SiteSummary => { const brief = SiteBriefSchema.parse(row.brief); return SiteSummarySchema.parse({ id: row.id, name: brief.name, slug: row.slug, kind: brief.kind, lang: brief.lang, status: row.status, revision: row.revision, publishedUrl: row.published_url, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() }); };
  async function detailOf(row: SiteRow, connection: Kysely<any> = db): Promise<SiteDetail> {
    const brief = SiteBriefSchema.parse(row.brief), images = await imagesOf(row.id, connection);
    const history = z.array(z.unknown()).parse(row.history ?? []);
    return SiteDetailSchema.parse({
      ...summary(row), brief, pages: brief.pages.map(page => ({ path: page.path, title: page.title })), checks: SiteCheckReportSchema.parse(row.checks), previewPath: previewPath(row.id, row.revision), canUndo: history.length > 0,
      images: images.map(image => ({ id: image.id, role: image.role, alt: image.alt, ext: image.mime_type === 'image/png' ? 'png' : 'jpg', width: image.width, height: image.height, bytes: Buffer.byteLength(image.data_base64, 'base64') })),
    });
  }
  /** Stores a new revision: the previous brief goes into history (last 20), files and checks are replaced. */
  async function saveRevision(tx: Kysely<any>, row: SiteRow, brief: SiteBrief, built: ReturnType<typeof build>, keepHistory = true): Promise<SiteRow> {
    const history = keepHistory ? [...z.array(z.unknown()).parse(row.history ?? []), row.brief].slice(-20) : z.array(z.unknown()).parse(row.history ?? []).slice(0, -1);
    const updated = await tx.updateTable('sites').set({ brief: JSON.stringify(brief), files: JSON.stringify(built.text), files_hash: built.filesHash, checks: JSON.stringify(built.checks), history: JSON.stringify(history), revision: row.revision + 1, generator_version: GENERATOR_VERSION, status: row.status === 'published' ? 'ready' : row.status, updated_at: now() }).where('id', '=', row.id).where('revision', '=', row.revision).returningAll().executeTakeFirst() as SiteRow | undefined;
    if (!updated) throw new SiteError('SITE_REVISION_CONFLICT', 'تغيّر الموقع قبل حفظ هذا التعديل؛ أعد التحميل.', 409);
    // An undo can drop an image the restored brief and its history never used (an upload being undone): delete it.
    if (!keepHistory) {
      const kept = new Set<string>(brief.images.map(image => image.id));
      for (const older of history) { const parsed = SiteBriefSchema.safeParse(older); if (parsed.success) for (const image of parsed.data.images) kept.add(image.id); }
      const stored = await tx.selectFrom('site_images').select('id').where('site_id', '=', row.id).execute() as { id: string }[];
      const orphans = stored.map(image => image.id).filter(imageId => !kept.has(imageId));
      if (orphans.length) await tx.deleteFrom('site_images').where('site_id', '=', row.id).where('id', 'in', orphans).execute();
    }
    return updated;
  }

  async function list(ownerId: string): Promise<SiteSummary[]> {
    const rows = await db.selectFrom('sites').selectAll().where('owner_id', '=', ownerId).orderBy('updated_at', 'desc').limit(limits.ownerSites).execute() as SiteRow[];
    return rows.map(summary);
  }
  async function create(ownerId: string, input: { brief: unknown; conversationId?: string | null; role?: WorkspaceRole }): Promise<SiteDetail> {
    const brief = SiteBriefSchema.parse(input.brief);
    const built = build(brief, []);
    const id = randomUUID();
    const slug = `${slugify(brief.name, brief.kind)}-${id.slice(0, 6)}`;
    const row = await db.transaction().execute(async tx => {
      const count = await tx.selectFrom('sites').select(eb => eb.fn.countAll<string>().as('n')).where('owner_id', '=', ownerId).executeTakeFirstOrThrow();
      const cap = input.role === 'member' ? limits.memberSites : limits.ownerSites;
      if (Number(count.n) >= cap) throw new SiteError('SITE_QUOTA', `بلغ الحساب حدّه من المواقع (${cap}). احذف موقعاً قديماً أولاً.`, 409);
      return tx.insertInto('sites').values({ id, owner_id: ownerId, conversation_id: input.conversationId ?? null, slug, brief: JSON.stringify(brief), files: JSON.stringify(built.text), files_hash: built.filesHash, checks: JSON.stringify(built.checks), history: '[]', revision: 1, generator_version: GENERATOR_VERSION, status: 'ready', created_at: now(), updated_at: now() }).returningAll().executeTakeFirstOrThrow() as Promise<SiteRow>;
    });
    return detailOf(row);
  }
  /** The form in the app: the same answers the chat card collects, completed by the same planner. */
  async function createFromAnswers(ownerId: string, input: unknown, role?: WorkspaceRole): Promise<SiteDetail | { missing: SiteWant[] }> {
    const request = z.object({ lang: SiteLangSchema, kind: SiteKindSchema.optional(), name: z.string().trim().max(80).optional(), request: z.string().trim().max(2000).optional(), answers: z.partialRecord(SiteWantSchema, z.string().max(8000)).default({}), conversationId: z.uuid().optional() }).strict().parse(input);
    const requests = request.request ? detectRequests(request.request) : null;
    const partial: SitePartialBrief = { lang: request.lang, ...(request.kind ? { kind: request.kind } : {}), ...(request.name ? { name: request.name } : {}), requested: requests?.wants ?? [], skipped: [], rounds: 0, ...(requests?.singlePage ? { singlePage: true } : {}) };
    const filled = applyAnswers(partial, request.answers);
    const completion = completeBrief(filled, { requestText: request.request });
    if ('missing' in completion) return { missing: completion.missing };
    return create(ownerId, { brief: completion.brief, conversationId: request.conversationId ?? null, role });
  }
  async function detail(ownerId: string, id: string): Promise<SiteDetail> { return detailOf(await rowFor(ownerId, id)); }
  async function updateBrief(ownerId: string, id: string, input: unknown): Promise<SiteDetail> {
    const request = BriefUpdate.parse(input);
    return detailOf(await db.transaction().execute(async tx => {
      const row = await rowFor(ownerId, id, tx, true);
      if (row.revision !== request.revision) throw new SiteError('SITE_REVISION_CONFLICT', 'تغيّر الموقع قبل حفظ هذا التعديل؛ أعد التحميل.', 409);
      // Image references must point at this site's own images.
      const images = await imagesOf(id, tx);
      const known = new Set(images.map(image => image.id));
      const brief = { ...request.brief, images: request.brief.images.filter(image => known.has(image.id)) };
      return saveRevision(tx, row, brief, build(brief, images));
    }));
  }
  /** A plain-language edit; returns what happened and the site, or a question when a block needs content. */
  async function command(ownerId: string, id: string, input: unknown): Promise<{ kind: 'patch' | 'undo' | 'ask' | 'unknown'; summary: string; want?: SiteWant; title?: string; detail: SiteDetail }> {
    const request = CommandInput.parse(input);
    return db.transaction().execute(async tx => {
      const row = await rowFor(ownerId, id, tx, true);
      const brief = SiteBriefSchema.parse(row.brief), images = await imagesOf(id, tx);
      if (request.want) {
        const patch = fulfilWant(brief, request.want, request.text);
        if (!patch) return { kind: 'unknown' as const, summary: brief.lang === 'ar' ? 'لم أستطع قراءة المحتوى بهذا الشكل؛ اكتبه سطراً لكل بند.' : 'I could not read that content; write one entry per line.', detail: await detailOf(row, tx) };
        const next = applyPatch(brief, patch);
        return { kind: 'patch' as const, summary: brief.lang === 'ar' ? 'أضفت القسم بمحتواك.' : 'Added the section with your content.', detail: await detailOf(await saveRevision(tx, row, next, build(next, images)), tx) };
      }
      const result = siteCommand(request.text, brief);
      if (!result) return { kind: 'unknown' as const, summary: '', detail: await detailOf(row, tx) };
      if (result.kind === 'ask') return { kind: 'ask' as const, summary: result.summary, want: result.want, title: result.title, detail: await detailOf(row, tx) };
      if (result.kind === 'undo') {
        const history = z.array(z.unknown()).parse(row.history ?? []);
        const previous = history.at(-1);
        if (!previous) return { kind: 'unknown' as const, summary: brief.lang === 'ar' ? 'لا يوجد تعديل سابق للتراجع عنه.' : 'There is no earlier change to undo.', detail: await detailOf(row, tx) };
        const restored = SiteBriefSchema.parse(previous);
        return { kind: 'undo' as const, summary: result.summary, detail: await detailOf(await saveRevision(tx, row, restored, build(restored, images), false), tx) };
      }
      const next = applyPatch(brief, result.patch);
      return { kind: 'patch' as const, summary: result.summary, detail: await detailOf(await saveRevision(tx, row, next, build(next, images)), tx) };
    });
  }
  async function undo(ownerId: string, id: string): Promise<SiteDetail> {
    return db.transaction().execute(async tx => {
      const row = await rowFor(ownerId, id, tx, true);
      const previous = z.array(z.unknown()).parse(row.history ?? []).at(-1);
      if (!previous) throw new SiteError('SITE_NO_HISTORY', 'لا يوجد تعديل سابق للتراجع عنه.', 409);
      const restored = SiteBriefSchema.parse(previous);
      return detailOf(await saveRevision(tx, row, restored, build(restored, await imagesOf(id, tx)), false), tx);
    });
  }
  async function uploadImage(ownerId: string, id: string, input: unknown): Promise<SiteDetail> {
    const request = UploadInput.parse(input), bytes = Buffer.from(request.data, 'base64');
    if (bytes.byteLength > IMAGE_LIMIT_BYTES) throw new SiteError('SITE_IMAGE_LIMIT', 'حجم الصورة الأقصى 1MB.', 413);
    let normalized: Buffer, small: Buffer | null = null, width: number, height: number;
    try {
      const image = sharp(bytes, { limitInputPixels: 4000 * 4000, failOn: 'error' }), metadata = await image.metadata();
      if (!metadata.width || !metadata.height || metadata.width < 32 || metadata.height < 32 || !['png', 'jpeg'].includes(metadata.format ?? '') || request.mimeType !== (metadata.format === 'png' ? 'image/png' : 'image/jpeg')) throw new Error('unsupported');
      const resized = image.rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true });
      const encoded = await (request.mimeType === 'image/png' ? resized.png({ compressionLevel: 8 }) : resized.jpeg({ quality: 86 })).toBuffer({ resolveWithObject: true });
      normalized = encoded.data; width = encoded.info.width; height = encoded.info.height;
      if (width > 640) small = await (request.mimeType === 'image/png' ? sharp(normalized).resize({ width: 640 }).png({ compressionLevel: 8 }) : sharp(normalized).resize({ width: 640 }).jpeg({ quality: 82 })).toBuffer();
    } catch { throw new SiteError('SITE_IMAGE_INVALID', 'يلزم PNG أو JPEG صالح بعرض وارتفاع 32 بكسل على الأقل.'); }
    if (normalized.byteLength > IMAGE_LIMIT_BYTES) throw new SiteError('SITE_IMAGE_LIMIT', 'تجاوزت الصورة المنقحة حد 1MB.', 413);
    return db.transaction().execute(async tx => {
      const row = await rowFor(ownerId, id, tx, true);
      const images = await imagesOf(id, tx);
      if (images.length >= limits.imagesPerSite) throw new SiteError('SITE_IMAGE_QUOTA', `بلغ الموقع حدّه من الصور (${limits.imagesPerSite}).`, 409);
      const imageId = randomUUID();
      await tx.insertInto('site_images').values({ id: imageId, site_id: id, owner_id: ownerId, mime_type: request.mimeType, width, height, data_base64: normalized.toString('base64'), small_base64: small ? small.toString('base64') : null, alt: request.alt, role: request.role, created_at: now() }).execute();
      const inserted = { id: imageId, site_id: id, owner_id: ownerId, mime_type: request.mimeType, width, height, data_base64: normalized.toString('base64'), small_base64: small ? small.toString('base64') : null, alt: request.alt, role: request.role, created_at: now() } as ImageRow;
      const brief = SiteBriefSchema.parse(row.brief);
      // A hero or about image replaces the previous one of that role; gallery and team images accumulate.
      const refs = (request.role === 'hero' || request.role === 'about' || request.role === 'logo') ? brief.images.filter(image => image.role !== request.role) : brief.images;
      const ref: SiteImageRef = { id: imageId, role: request.role, alt: request.alt, ext: request.mimeType === 'image/png' ? 'png' : 'jpg' };
      let next: SiteBrief = { ...brief, images: [...refs, ref].slice(-24) };
      if (request.role === 'gallery' && !next.pages.some(page => page.blocks.some(block => block.type === 'gallery'))) {
        const { placeBlock } = await import('@mohassan/sites');
        next = { ...next, pages: placeBlock(next.pages, { type: 'gallery' }, next.lang) };
      }
      return detailOf(await saveRevision(tx, row, next, build(next, [...images, inserted])), tx);
    });
  }
  async function deleteImage(ownerId: string, id: string, imageId: string): Promise<SiteDetail> {
    return db.transaction().execute(async tx => {
      const row = await rowFor(ownerId, id, tx, true);
      const removed = await tx.deleteFrom('site_images').where('id', '=', imageId).where('site_id', '=', id).executeTakeFirst();
      if (!Number(removed.numDeletedRows)) throw new SiteError('SITE_IMAGE_NOT_FOUND', 'لم يُعثر على الصورة.', 404);
      const brief = SiteBriefSchema.parse(row.brief);
      const next = { ...brief, images: brief.images.filter(image => image.id !== imageId) };
      return detailOf(await saveRevision(tx, row, next, build(next, await imagesOf(id, tx))), tx);
    });
  }
  async function exportZip(ownerId: string, id: string): Promise<{ bytes: Buffer; filename: string }> {
    const row = await rowFor(ownerId, id);
    const brief = SiteBriefSchema.parse(row.brief), images = await imagesOf(id);
    const built = build(brief, images);
    if (built.filesHash !== row.files_hash) throw new SiteError('SITE_SNAPSHOT_MISMATCH', 'تغيّر المولّد منذ آخر معاينة؛ أعد توليد الموقع ثم حمّله.', 409);
    return { bytes: zipFiles(built.site.files), filename: `${row.slug}.zip` };
  }
  async function regenerate(ownerId: string, id: string): Promise<SiteDetail> {
    return db.transaction().execute(async tx => {
      const row = await rowFor(ownerId, id, tx, true);
      const brief = SiteBriefSchema.parse(row.brief);
      return detailOf(await saveRevision(tx, row, brief, build(brief, await imagesOf(id, tx)), false), tx);
    });
  }
  /** A file of the previewed revision, by its token: text from the stored snapshot, images from their table. */
  async function previewFile(id: string, candidate: string, path: string): Promise<{ bytes: Buffer; contentType: string; status: number } | null> {
    if (!/^[A-Za-z0-9_-]{32}$/.test(candidate) || !z.uuid().safeParse(id).success) return null;
    const row = await db.selectFrom('sites').select(['id', 'revision', 'files']).where('id', '=', id).executeTakeFirst() as Pick<SiteRow, 'id' | 'revision' | 'files'> | undefined;
    if (!row || !tokenValid(id, row.revision, candidate)) return null;
    const files = z.array(z.object({ path: z.string(), content: z.string(), contentType: z.string() })).parse(row.files);
    const wanted = path === '' ? 'index.html' : path;
    if (!FILE_PATH.test(wanted)) return null;
    const text = files.find(file => file.path === wanted);
    if (text) return { bytes: Buffer.from(text.content, 'utf8'), contentType: text.contentType, status: 200 };
    const asset = wanted.match(/^assets\/([0-9a-f-]{36})(-small)?\.(png|jpg|webp)$/);
    if (asset) {
      const image = await db.selectFrom('site_images').select(['data_base64', 'small_base64', 'mime_type']).where('id', '=', asset[1]!).where('site_id', '=', id).executeTakeFirst() as Pick<ImageRow, 'data_base64' | 'small_base64' | 'mime_type'> | undefined;
      if (image) return { bytes: Buffer.from(asset[2] && image.small_base64 ? image.small_base64 : image.data_base64, 'base64'), contentType: image.mime_type, status: 200 };
    }
    const notFound = files.find(file => file.path === '404.html');
    return notFound ? { bytes: Buffer.from(notFound.content, 'utf8'), contentType: notFound.contentType, status: 404 } : null;
  }
  async function publish(ownerId: string, id: string, signal?: AbortSignal): Promise<SiteDetail> {
    const row = await rowFor(ownerId, id);
    if (!publisher.available()) throw new PublishError('PUBLISH_NOT_CONFIGURED', 'النشر غير مهيأ على هذا الخادم؛ حمّل الموقع كملف ZIP أو فعّل النشر من الإعدادات.', 409);
    const brief = SiteBriefSchema.parse(row.brief), images = await imagesOf(id);
    const previewBuild = build(brief, images);
    if (previewBuild.filesHash !== row.files_hash) throw new SiteError('SITE_SNAPSHOT_MISMATCH', 'تغيّر المولّد منذ آخر معاينة؛ أعد توليد الموقع ثم انشره.', 409);
    const expectedUrl = row.published_url ?? undefined;
    // Publish with absolute links when the URL is already known (a republish); the first publish learns it.
    const release = build(brief, images, expectedUrl ? { baseUrl: expectedUrl } : {});
    let result: Awaited<ReturnType<SitePublisher['publish']>>;
    try { result = await publisher.publish({ slug: row.slug, files: release.site.files }, signal); }
    catch (error) {
      await db.updateTable('sites').set({ status: 'failed', publish: JSON.stringify({ error: error instanceof Error ? error.message : String(error), at: now().toISOString() }), updated_at: now() }).where('id', '=', id).execute();
      throw error;
    }
    if (!expectedUrl) {
      // Second pass with the real origin so sitemap, canonical and OG links are absolute.
      const final = build(brief, images, { baseUrl: result.url });
      result = await publisher.publish({ slug: row.slug, files: final.site.files }, signal);
    }
    const updated = await db.updateTable('sites').set({ status: 'published', published_url: result.url, published_at: now(), publish: JSON.stringify({ provider: result.provider, reference: result.reference, at: now().toISOString() }), updated_at: now() }).where('id', '=', id).returningAll().executeTakeFirstOrThrow() as SiteRow;
    return detailOf(updated);
  }
  async function remove(ownerId: string, id: string): Promise<void> {
    const deleted = await db.deleteFrom('sites').where('id', '=', id).where('owner_id', '=', ownerId).executeTakeFirst();
    if (!Number(deleted.numDeletedRows)) throw new SiteError('SITE_NOT_FOUND', 'لم يُعثر على الموقع.', 404);
  }
  return { list, create, createFromAnswers, detail, updateBrief, command, undo, uploadImage, deleteImage, exportZip, regenerate, previewFile, publish, remove, previewPath, publisherKind: publisher.kind, publishAvailable: () => publisher.available(), limits };
}
export type SitesControl = Awaited<ReturnType<typeof createSitesControl>>;

interface RouteOptions { control: SitesControl; owner: (request: any) => Promise<{ id: string }>; role: (request: any) => Promise<WorkspaceRole> }
export async function registerSiteRoutes(app: FastifyInstance, { control, owner, role }: RouteOptions) {
  const id = (value: string) => z.uuid().parse(value);
  app.get('/api/sites', async request => ({ sites: await control.list((await owner(request)).id), publish: { available: control.publishAvailable(), provider: control.publisherKind } }));
  app.post('/api/sites', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async request => {
    const user = await owner(request);
    const body = z.object({ brief: SiteBriefSchema, conversationId: z.uuid().optional() }).strict().parse(request.body);
    return control.create(user.id, { brief: body.brief, conversationId: body.conversationId ?? null, role: await role(request) });
  });
  app.post('/api/sites/draft', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async request => control.createFromAnswers((await owner(request)).id, request.body, await role(request)));
  app.get<{ Params: { id: string } }>('/api/sites/:id', async request => control.detail((await owner(request)).id, id(request.params.id)));
  app.post<{ Params: { id: string } }>('/api/sites/:id/brief', { bodyLimit: 262144 }, async request => control.updateBrief((await owner(request)).id, id(request.params.id), request.body));
  app.post<{ Params: { id: string } }>('/api/sites/:id/commands', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async request => control.command((await owner(request)).id, id(request.params.id), request.body));
  app.post<{ Params: { id: string } }>('/api/sites/:id/undo', async request => { z.object({}).strict().parse(request.body ?? {}); return control.undo((await owner(request)).id, id(request.params.id)); });
  app.post<{ Params: { id: string } }>('/api/sites/:id/regenerate', async request => { z.object({}).strict().parse(request.body ?? {}); return control.regenerate((await owner(request)).id, id(request.params.id)); });
  app.post<{ Params: { id: string } }>('/api/sites/:id/images', { bodyLimit: 1_500_000, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async request => control.uploadImage((await owner(request)).id, id(request.params.id), request.body));
  app.delete<{ Params: { id: string; imageId: string } }>('/api/sites/:id/images/:imageId', async request => control.deleteImage((await owner(request)).id, id(request.params.id), id(request.params.imageId)));
  app.get<{ Params: { id: string } }>('/api/sites/:id/export', async (request, reply) => {
    const archive = await control.exportZip((await owner(request)).id, id(request.params.id));
    return reply.type('application/zip').header('Content-Disposition', `attachment; filename="${archive.filename}"`).send(archive.bytes);
  });
  app.post<{ Params: { id: string } }>('/api/sites/:id/publish', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async request => {
    const user = await owner(request);
    if (await role(request) !== 'owner') throw new SiteError('SITE_PUBLISH_OWNER_ONLY', 'النشر متاح للمالك فقط في هذه النسخة؛ حمّل الموقع كملف ZIP.', 403);
    z.object({}).strict().parse(request.body ?? {});
    return control.publish(user.id, id(request.params.id));
  });
  app.delete<{ Params: { id: string } }>('/api/sites/:id', async request => { await control.remove((await owner(request)).id, id(request.params.id)); return { ok: true }; });
  // Public by token (PUBLIC_ROUTES): a sandboxed preview iframe has an opaque origin and sends no cookie.
  app.get<{ Params: { id: string; token: string; '*': string } }>('/api/sites/:id/p/:token/*', { config: { rateLimit: { max: 600, timeWindow: '1 minute', keyGenerator: (request: any) => `site-preview:${request.params?.token ?? ''}` } } }, async (request, reply) => {
    const file = await control.previewFile(request.params.id, request.params.token, request.params['*'] ?? '');
    if (!file) return reply.code(404).send({ error: { code: 'SITE_PREVIEW_NOT_FOUND', message: 'لم يُعثر على ملف المعاينة.' } });
    return reply.code(file.status).type(file.contentType).header('Content-Security-Policy', "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox").header('X-Frame-Options', 'SAMEORIGIN').header('Referrer-Policy', 'no-referrer').send(file.bytes);
  });
  return control;
}
export { contentTypeFor };
