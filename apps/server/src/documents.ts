import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import {
  DOCUMENT_THEMES, PDF_LIMITS, PdfError, WATERMARK_PRINT, createPdfRenderer, deletePages, extractPages, mergePdfs, numberPages, pdfInfo,
  renderDocumentHtml, rotatePages, setPdfMetadata, stampPdf, watermarkHtml, type DocumentSpecInput, type PdfInfo, type PdfRenderer,
} from '@mohassan/pdf';

/**
 * PDF files Mohassan made or edited, one row per file, bytes on disk under the data directory.
 * Creation renders the owner's words through Chromium; edits run pdf-lib in a worker. Reading a
 * file from the owner's computer follows the same root rules as knowledge imports.
 */
export const UPLOAD_MAX_BYTES = 10_000_000;
export type DocumentSource = 'created' | 'edited' | 'uploaded';
export interface StoredDocument {
  id: string; conversationId: string | null; name: string; size: number; hash: string; pages: number;
  source: DocumentSource; theme: string | null; createdAt: string;
}
export interface DocumentInput { name: string; bytes: Buffer }
export type DocumentEdit =
  | { op: 'merge'; name?: string }
  | { op: 'extract'; pages: number[] }
  | { op: 'delete'; pages: number[] }
  | { op: 'rotate'; angle: 90 | 180 | 270; pages?: number[] }
  | { op: 'watermark'; text: string; opacity?: number }
  | { op: 'number' }
  | { op: 'metadata'; title?: string; author?: string };

export interface DocumentControlOptions {
  dir: string;
  renderer?: PdfRenderer;
  fontsDir?: string;
  /** Folders the owner may read PDFs from by path; absent or empty disables local reading. */
  allowedRoots?: readonly string[] | ((ownerId: string) => Promise<readonly string[]> | readonly string[]);
}

export async function migrateDocuments(db: Kysely<any>) {
  await db.transaction().execute(async tx => {
    await sql`SELECT pg_advisory_xact_lock(7240398)`.execute(tx);
    await sql`CREATE TABLE IF NOT EXISTS pdf_documents (
      id text PRIMARY KEY, owner_id text NOT NULL, conversation_id text, name text NOT NULL,
      byte_count integer NOT NULL, content_hash text NOT NULL, pages integer NOT NULL, source text NOT NULL, theme text,
      path text NOT NULL, created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`.execute(tx);
    await sql`CREATE INDEX IF NOT EXISTS pdf_documents_owner ON pdf_documents(owner_id, conversation_id, created_at DESC)`.execute(tx);
  });
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const segment = (ownerId: string) => createHash('sha256').update(ownerId, 'utf8').digest('hex').slice(0, 32);
/** Letters of any script, digits, spaces and -_. only, so the name is safe in a header and on every file system. */
export function documentFileName(title: string, fallback = 'document'): string {
  const base = title.normalize('NFC').replace(/\.pdf$/iu, '').replace(/[^\p{L}\p{N} _.-]+/gu, ' ').replace(/\s+/gu, ' ').trim().replace(/^[. ]+|[. ]+$/gu, '').slice(0, 80).trim();
  return `${base || fallback}.pdf`;
}
const suffixed = (name: string, suffix: string) => documentFileName(`${name.replace(/\.pdf$/iu, '')} ${suffix}`);
const inside = (root: string, target: string) => { const relative = path.relative(root, target); return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative); };

export function createDocumentControl(db: Kysely<any>, options: DocumentControlOptions) {
  const renderer = options.renderer ?? createPdfRenderer({ fontsDir: options.fontsDir });
  const publicRow = (row: any): StoredDocument => ({ id: row.id, conversationId: row.conversation_id ?? null, name: row.name, size: row.byte_count, hash: row.content_hash, pages: row.pages, source: row.source, theme: row.theme ?? null, createdAt: new Date(row.created_at).toISOString() });

  async function store(ownerId: string, conversationId: string | null, name: string, bytes: Uint8Array, source: DocumentSource, theme: string | null, known?: PdfInfo): Promise<StoredDocument> {
    const info = known ?? await pdfInfo(bytes);
    const id = randomUUID();
    const file = path.join(options.dir, segment(ownerId), `${id}.pdf`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes, { flag: 'wx' });
    try {
      await db.insertInto('pdf_documents').values({ id, owner_id: ownerId, conversation_id: conversationId, name: documentFileName(name), byte_count: bytes.byteLength, content_hash: sha256(bytes), pages: info.pages, source, theme, path: file }).execute();
    } catch (error) { await rm(file, { force: true }); throw error; }
    return (await get(ownerId, id))!;
  }
  async function get(ownerId: string, id: string): Promise<StoredDocument> {
    const row = await db.selectFrom('pdf_documents').selectAll().where('owner_id', '=', ownerId).where('id', '=', id).executeTakeFirst();
    if (!row) throw new PdfError('DOCUMENT_NOT_FOUND', 'الملف غير موجود.', 404);
    return publicRow(row);
  }

  return {
    renderer,
    /** The owner's words through a theme into a stored PDF. `name`: the file name the owner asked for («named sample.pdf»); the title otherwise. */
    async create(ownerId: string, conversationId: string | null, spec: DocumentSpecInput, signal?: AbortSignal, options: { name?: string } = {}): Promise<StoredDocument> {
      const document = renderDocumentHtml(spec, await renderer.fontFaces());
      const bytes = await renderer.render(document.html, { print: document.print, signal });
      return store(ownerId, conversationId, documentFileName(options.name?.trim() ? options.name : document.title), bytes, 'created', document.theme);
    },
    async upload(ownerId: string, conversationId: string | null, name: string, bytes: Uint8Array): Promise<StoredDocument> {
      if (bytes.byteLength > UPLOAD_MAX_BYTES) throw new PdfError('PDF_SIZE_LIMIT', `حد الرفع ${UPLOAD_MAX_BYTES / 1_000_000} ميغابايت.`);
      return store(ownerId, conversationId, name, bytes, 'uploaded', null);
    },
    /** One structural edit on stored or local files; the result is a new stored file. */
    async edit(ownerId: string, conversationId: string | null, inputs: readonly DocumentInput[], edit: DocumentEdit, signal?: AbortSignal): Promise<StoredDocument> {
      if (edit.op !== 'merge' && inputs.length !== 1) throw new PdfError('DOCUMENT_INPUT_COUNT', 'هذه العملية تعمل على ملف واحد.');
      const [first] = inputs;
      const options = { signal };
      let bytes: Buffer, name: string;
      switch (edit.op) {
        case 'merge': bytes = await mergePdfs(inputs.map(input => input.bytes), options); name = edit.name ?? suffixed(first!.name, 'merged'); break;
        case 'extract': bytes = await extractPages(first!.bytes, edit.pages, options); name = suffixed(first!.name, 'pages'); break;
        case 'delete': bytes = await deletePages(first!.bytes, edit.pages, options); name = suffixed(first!.name, 'edited'); break;
        case 'rotate': bytes = await rotatePages(first!.bytes, edit.angle, edit.pages, options); name = suffixed(first!.name, 'rotated'); break;
        case 'watermark': {
          const overlay = await renderer.render(watermarkHtml(edit.text, { opacity: edit.opacity }, await renderer.fontFaces()), { print: WATERMARK_PRINT, signal });
          bytes = await stampPdf(first!.bytes, overlay, options); name = suffixed(first!.name, 'watermark'); break;
        }
        case 'number': bytes = await numberPages(first!.bytes, options); name = suffixed(first!.name, 'numbered'); break;
        case 'metadata': bytes = await setPdfMetadata(first!.bytes, { ...(edit.title !== undefined ? { title: edit.title } : {}), ...(edit.author !== undefined ? { author: edit.author } : {}) }, options); name = edit.title ? documentFileName(edit.title) : first!.name; break;
      }
      return store(ownerId, conversationId, name, bytes, 'edited', null);
    },
    info: (bytes: Uint8Array, signal?: AbortSignal) => pdfInfo(bytes, { signal }),
    async list(ownerId: string, conversationId?: string, limit = 50): Promise<StoredDocument[]> {
      let query = db.selectFrom('pdf_documents').selectAll().where('owner_id', '=', ownerId);
      if (conversationId) query = query.where('conversation_id', '=', conversationId);
      return (await query.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(Math.min(50, Math.max(1, limit))).execute()).map(publicRow);
    },
    get,
    async content(ownerId: string, id: string): Promise<DocumentInput & { document: StoredDocument }> {
      const row = await db.selectFrom('pdf_documents').selectAll().where('owner_id', '=', ownerId).where('id', '=', id).executeTakeFirst();
      if (!row) throw new PdfError('DOCUMENT_NOT_FOUND', 'الملف غير موجود.', 404);
      let bytes: Buffer;
      try { bytes = await readFile(row.path); } catch { throw new PdfError('DOCUMENT_MISSING', 'ملف PDF لم يبق على القرص.', 410); }
      if (sha256(bytes) !== row.content_hash) throw new PdfError('DOCUMENT_CHANGED', 'تغيّر محتوى الملف على القرص ولم يُسلَّم.', 409);
      return { name: row.name, bytes, document: publicRow(row) };
    },
    /** A .pdf inside an allowed folder on the owner's computer, read once with the links and roots checked. */
    async readLocal(ownerId: string, rawPath: string): Promise<DocumentInput> {
      const configured = typeof options.allowedRoots === 'function' ? await options.allowedRoots(ownerId) : options.allowedRoots ?? [];
      if (!configured.length) throw new PdfError('DOCUMENT_PATH_DENIED', 'قراءة الملفات من الجهاز غير مفعّلة لهذا الحساب.', 403);
      const requested = path.resolve(rawPath.trim());
      if (path.extname(requested).toLowerCase() !== '.pdf') throw new PdfError('DOCUMENT_FORMAT', 'المسار يجب أن يشير إلى ملف .pdf.');
      const roots = (await Promise.all(configured.map(async root => { try { const resolved = path.resolve(root); return { configured: resolved, canonical: await realpath(resolved) }; } catch { return null; } }))).filter((entry): entry is { configured: string; canonical: string } => entry !== null);
      const match = roots.find(entry => inside(entry.configured, requested) || inside(entry.canonical, requested));
      if (!match) throw new PdfError('DOCUMENT_PATH_DENIED', 'الملف خارج المجلدات المسموح بقراءتها.', 403);
      const root = match.canonical;
      const target = inside(match.configured, requested) ? path.join(root, path.relative(match.configured, requested)) : requested;
      try {
        let cursor = root;
        for (const part of path.relative(root, target).split(path.sep)) {
          cursor = path.join(cursor, part);
          if ((await lstat(cursor)).isSymbolicLink()) throw new PdfError('DOCUMENT_LINK_DENIED', 'الروابط الرمزية غير مقبولة كمصدر.', 403);
        }
        const canonical = await realpath(target);
        if (!inside(root, canonical)) throw new PdfError('DOCUMENT_PATH_DENIED', 'الملف خارج المجلدات المسموح بقراءتها.', 403);
        const handle = await open(canonical, 'r');
        try {
          const stat = await handle.stat();
          if (!stat.isFile()) throw new PdfError('DOCUMENT_NOT_FOUND', 'المسار ليس ملفًا.', 404);
          if (stat.size > PDF_LIMITS.inputBytes) throw new PdfError('PDF_SIZE_LIMIT', `حجم الملف يتجاوز ${PDF_LIMITS.inputBytes / 1_000_000} ميغابايت.`);
          const bytes = Buffer.alloc(stat.size);
          let total = 0;
          while (total < bytes.length) { const read = await handle.read(bytes, total, bytes.length - total, total); if (!read.bytesRead) break; total += read.bytesRead; }
          return { name: path.basename(canonical), bytes: bytes.subarray(0, total) };
        } finally { await handle.close(); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT' || (error as NodeJS.ErrnoException)?.code === 'ENOTDIR') throw new PdfError('DOCUMENT_NOT_FOUND', 'لم أجد ملفًا في هذا المسار.', 404);
        throw error;
      }
    },
    async remove(ownerId: string, id: string): Promise<{ removed: true }> {
      const row = await db.selectFrom('pdf_documents').select(['path']).where('owner_id', '=', ownerId).where('id', '=', id).executeTakeFirst();
      if (!row) throw new PdfError('DOCUMENT_NOT_FOUND', 'الملف غير موجود.', 404);
      await db.deleteFrom('pdf_documents').where('owner_id', '=', ownerId).where('id', '=', id).execute();
      await rm(row.path, { force: true });
      return { removed: true };
    },
    shutdown: () => renderer.close(),
  };
}
export type DocumentControl = ReturnType<typeof createDocumentControl>;

const Filename = z.string().min(1).max(120).regex(/^[\p{L}\p{N}][\p{L}\p{M}\p{N} _.()-]*$/u).refine(value => !value.includes('..'));
const CreateInput = z.object({ conversationId: z.uuid().optional(), spec: z.record(z.string(), z.unknown()) }).strict();
const UploadInput = z.object({ conversationId: z.uuid().optional(), name: Filename, base64: z.string().min(1).max(Math.ceil(UPLOAD_MAX_BYTES / 3) * 4 + 4) }).strict();

/** Owner and member HTTP routes. The chat uses the control directly; the model has no document tool. */
export async function registerDocumentRoutes(app: FastifyInstance, { control, owner, link }: { control: DocumentControl; owner: (request: any) => Promise<{ id: string }>; link: (id: string) => string }) {
  const withUrl = (row: StoredDocument) => ({ ...row, url: link(row.id) });
  app.get<{ Querystring: { conversationId?: string } }>('/api/documents', async request => {
    const user = await owner(request);
    const query = z.object({ conversationId: z.uuid().optional() }).strict().parse(request.query ?? {});
    return { documents: (await control.list(user.id, query.conversationId)).map(withUrl), maxUploadBytes: UPLOAD_MAX_BYTES, themes: DOCUMENT_THEMES };
  });
  app.post('/api/documents', { bodyLimit: 400_000, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async request => {
    const user = await owner(request);
    const input = CreateInput.parse(request.body);
    return withUrl(await control.create(user.id, input.conversationId ?? null, input.spec as DocumentSpecInput));
  });
  app.post('/api/documents/upload', { bodyLimit: 14_000_000, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async request => {
    const user = await owner(request);
    const input = UploadInput.parse(request.body);
    const bytes = Buffer.from(input.base64, 'base64');
    if (!bytes.length || bytes.toString('base64') !== input.base64.replace(/=+$/u, '').concat('='.repeat((4 - input.base64.replace(/=+$/u, '').length % 4) % 4))) throw new PdfError('DOCUMENT_ENCODING', 'ترميز الملف غير صالح.');
    return withUrl(await control.upload(user.id, input.conversationId ?? null, input.name, bytes));
  });
  app.get<{ Params: { id: string } }>('/api/documents/:id/content', async (request, reply) => {
    const user = await owner(request);
    const result = await control.content(user.id, z.uuid().parse(request.params.id));
    const fallback = /^[a-zA-Z0-9][a-zA-Z0-9._ -]{0,99}$/u.test(result.name) ? result.name : 'document.pdf';
    return reply.type('application/pdf').header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff').header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Content-Disposition', `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(result.name)}`).send(result.bytes);
  });
  app.delete<{ Params: { id: string } }>('/api/documents/:id', async request => control.remove((await owner(request)).id, z.uuid().parse(request.params.id)));
  app.addHook('preClose', async () => { await control.shutdown(); });
}
