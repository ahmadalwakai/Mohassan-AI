import { randomUUID } from 'node:crypto';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '@mohassan/database';
import { PdfError } from '@mohassan/pdf';
import { createDocumentControl, documentFileName, migrateDocuments, registerDocumentRoutes, type DocumentControl } from '../apps/server/src/documents.js';

const OWNER = 'owner-docs';
const OTHER = 'someone-else';

describe('document control', () => {
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let control: DocumentControl;
  let dir: string, root: string;
  const conversation = randomUUID();

  beforeAll(async () => {
    database = await createDatabase({});
    await migrateDocuments(database.db);
    dir = await mkdtemp(path.join(tmpdir(), 'mohassan-documents-'));
    root = await mkdtemp(path.join(tmpdir(), 'mohassan-owner-files-'));
    control = createDocumentControl(database.db, { dir, allowedRoots: async ownerId => ownerId === OWNER ? [root] : [] });
  });
  afterAll(async () => {
    await control.shutdown();
    await database.close();
    await rm(dir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });

  it('creates a stored PDF from a specification and serves its bytes back unchanged', async () => {
    const created = await control.create(OWNER, conversation, { title: 'تقرير التجربة', theme: 'report', blocks: [{ kind: 'paragraph', text: 'الفقرة الأولى.' }, { kind: 'bullets', items: ['أ', 'ب'] }] });
    expect(created).toMatchObject({ conversationId: conversation, name: 'تقرير التجربة.pdf', pages: 1, source: 'created', theme: 'report' });
    expect(created.size).toBeGreaterThan(1000);
    const content = await control.content(OWNER, created.id);
    expect(content.bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(content.bytes.byteLength).toBe(created.size);
    expect((await control.list(OWNER, conversation)).map(row => row.id)).toEqual([created.id]);
    expect(await control.list(OWNER, randomUUID())).toEqual([]);
    await expect(control.get(OTHER, created.id)).rejects.toMatchObject({ code: 'DOCUMENT_NOT_FOUND' });
  });

  it('edits stored files into new files: watermark, merge, delete, rotate, numbers and title', async () => {
    const [first] = await control.list(OWNER, conversation);
    const source = await control.content(OWNER, first!.id);
    const marked = await control.edit(OWNER, conversation, [source], { op: 'watermark', text: 'سري' });
    expect(marked).toMatchObject({ pages: 1, source: 'edited', name: 'تقرير التجربة watermark.pdf' });
    const second = await control.create(OWNER, conversation, { title: 'Second file', blocks: [{ kind: 'paragraph', text: 'Page one.' }, { kind: 'pagebreak' }, { kind: 'paragraph', text: 'Page two.' }] });
    expect(second.pages).toBe(2);
    const merged = await control.edit(OWNER, conversation, [source, await control.content(OWNER, second.id)], { op: 'merge' });
    expect(merged.pages).toBe(3);
    const trimmed = await control.edit(OWNER, conversation, [await control.content(OWNER, merged.id)], { op: 'delete', pages: [1] });
    expect(trimmed.pages).toBe(2);
    expect((await control.edit(OWNER, conversation, [source], { op: 'rotate', angle: 90 })).pages).toBe(1);
    expect((await control.edit(OWNER, conversation, [source], { op: 'number' })).name).toBe('تقرير التجربة numbered.pdf');
    const titled = await control.edit(OWNER, conversation, [source], { op: 'metadata', title: 'عنوان جديد' });
    expect(titled.name).toBe('عنوان جديد.pdf');
    expect((await control.info((await control.content(OWNER, titled.id)).bytes)).title).toBe('عنوان جديد');
    await expect(control.edit(OWNER, conversation, [source, source], { op: 'number' })).rejects.toMatchObject({ code: 'DOCUMENT_INPUT_COUNT' });
    expect((await control.list(OWNER, conversation)).length).toBe(8);
  });

  it('uploads valid PDFs only', async () => {
    const [first] = await control.list(OWNER, conversation);
    const bytes = (await control.content(OWNER, first!.id)).bytes;
    const uploaded = await control.upload(OTHER, null, 'mine.pdf', bytes);
    expect(uploaded).toMatchObject({ source: 'uploaded', conversationId: null, name: 'mine.pdf' });
    expect((await control.list(OTHER)).map(row => row.id)).toEqual([uploaded.id]);
    await expect(control.upload(OTHER, null, 'bad.pdf', Buffer.from('%PDF-1.4 but not really a pdf file content'))).rejects.toMatchObject({ code: 'PDF_INVALID' });
    await expect(control.upload(OTHER, null, 'huge.pdf', Buffer.alloc(10_000_001))).rejects.toMatchObject({ code: 'PDF_SIZE_LIMIT' });
  });

  it('reads local .pdf files only inside the owner\'s allowed roots, never through other accounts', async () => {
    const [first] = await control.list(OWNER, conversation);
    const bytes = (await control.content(OWNER, first!.id)).bytes;
    await writeFile(path.join(root, 'ملف المالك.pdf'), bytes);
    await writeFile(path.join(root, 'notes.txt'), 'text');
    const local = await control.readLocal(OWNER, path.join(root, 'ملف المالك.pdf'));
    expect(local.name).toBe('ملف المالك.pdf');
    expect(local.bytes.byteLength).toBe(bytes.byteLength);
    await expect(control.readLocal(OWNER, path.join(root, 'missing.pdf'))).rejects.toMatchObject({ code: 'DOCUMENT_NOT_FOUND' });
    await expect(control.readLocal(OWNER, path.join(root, 'notes.txt'))).rejects.toMatchObject({ code: 'DOCUMENT_FORMAT' });
    await expect(control.readLocal(OWNER, path.join(dir, 'outside.pdf'))).rejects.toMatchObject({ code: 'DOCUMENT_PATH_DENIED' });
    await expect(control.readLocal(OWNER, path.join(root, '..', 'escape.pdf'))).rejects.toMatchObject({ code: 'DOCUMENT_PATH_DENIED' });
    await expect(control.readLocal(OTHER, path.join(root, 'ملف المالك.pdf'))).rejects.toMatchObject({ code: 'DOCUMENT_PATH_DENIED', statusCode: 403 });
  });

  it('removes a file from the table and the disk', async () => {
    const [latest] = await control.list(OWNER, conversation);
    const file = path.join(dir, (await database.db.selectFrom('pdf_documents').select('path').where('id', '=', latest!.id).executeTakeFirstOrThrow()).path.split(/[\\/]/u).slice(-2).join(path.sep));
    await access(file);
    await control.remove(OWNER, latest!.id);
    await expect(access(file)).rejects.toThrow();
    await expect(control.get(OWNER, latest!.id)).rejects.toMatchObject({ code: 'DOCUMENT_NOT_FOUND' });
  });

  it('serves the list and a sandboxed PDF download over HTTP', async () => {
    const app = Fastify({ pluginTimeout: 60_000 });
    app.setErrorHandler((error: any, _request, reply) => reply.code(error instanceof PdfError ? error.statusCode : 500).send({ error: { code: error.code ?? 'INTERNAL', message: error.message } }));
    await registerDocumentRoutes(app, { control, owner: async () => ({ id: OWNER }), link: id => `http://web.test/api/documents/${id}/content` });
    await app.ready();
    try {
      const list = await app.inject({ method: 'GET', url: `/api/documents?conversationId=${conversation}` });
      expect(list.statusCode).toBe(200);
      const body = list.json() as { documents: { id: string; url: string }[]; themes: string[] };
      expect(body.documents.length).toBeGreaterThan(3);
      expect(body.documents[0]!.url).toBe(`http://web.test/api/documents/${body.documents[0]!.id}/content`);
      expect(body.themes).toContain('invoice');
      const download = await app.inject({ method: 'GET', url: `/api/documents/${body.documents[0]!.id}/content` });
      expect(download.statusCode).toBe(200);
      expect(download.headers['content-type']).toContain('application/pdf');
      expect(download.headers['content-disposition']).toMatch(/^attachment; filename="[a-zA-Z0-9][a-zA-Z0-9._ -]{0,99}"; filename\*=UTF-8''[a-zA-Z0-9._% -]{1,1200}$/u);
      expect(download.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
      expect(download.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect((await app.inject({ method: 'GET', url: `/api/documents/${randomUUID()}/content` })).statusCode).toBe(404);
      const created = await app.inject({ method: 'POST', url: '/api/documents', payload: { conversationId: conversation, spec: { title: 'Via HTTP', blocks: [{ kind: 'paragraph', text: 'Hello' }] } } });
      expect(created.statusCode).toBe(200);
      expect(created.json()).toMatchObject({ name: 'Via HTTP.pdf', pages: 1 });
    } finally { await app.close(); }
  });

  it('builds safe file names from any title', () => {
    expect(documentFileName('تقرير: المبيعات/نوفمبر <2026>')).toBe('تقرير المبيعات نوفمبر 2026.pdf');
    expect(documentFileName('   ')).toBe('document.pdf');
    expect(documentFileName('x'.repeat(200))).toHaveLength(84);
    expect(documentFileName('report.pdf')).toBe('report.pdf');
  });
});
