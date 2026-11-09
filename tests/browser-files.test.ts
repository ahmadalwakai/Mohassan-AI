import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { createDatabase, migrate } from '@mohassan/database';
import { AgentBrowser, BrowserError, BROWSER_FILE_MAX_BYTES, SafeNetwork, inspectBrowserFile, type AgentAuthority } from '@mohassan/browser';
import { registerBrowserFileRoutes } from '../apps/server/src/browser-files.js';

const auth = (): AgentAuthority => ({ signal: new AbortController().signal, assertActive: async () => {}, dispatched: async permit => permit.id, completed: async () => {} });
const ownerId = 'files-owner', headers = { 'x-test-owner': ownerId };
let store: Awaited<ReturnType<typeof createDatabase>>, browser: AgentBrowser, app: ReturnType<typeof Fastify>, control: Awaited<ReturnType<typeof registerBrowserFileRoutes>>, server: Server, origin: string, root: string, temporary: string;
const uploads: { body: Buffer; cookie: string }[] = [], hits: string[] = [];
const base = (id: string) => `/api/browser/files/${id}`;
const inputFile = (text = 'وثيقة من المالك') => ({ name: 'owner-note.txt', type: 'text/plain', base64: Buffer.from(text).toString('base64') });
const request = (url: string, method: 'GET' | 'POST' | 'DELETE' = 'GET', payload?: unknown, owner = ownerId) => app.inject({ url, method, headers: { 'x-test-owner': owner }, ...(payload === undefined ? {} : { payload }) });

beforeAll(async () => {
  temporary = await realpath(tmpdir()); root = await mkdtemp(join(temporary, 'mohassan-browser-files-'));
  server = createServer((req, res) => {
    const path = new URL(req.url!, 'http://localhost').pathname, chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk)); req.on('end', () => {
      hits.push(`${req.method} ${path}`);
      if (req.method === 'POST') {
        uploads.push({ body: Buffer.concat(chunks), cookie: req.headers.cookie ?? '' });
        if (path === '/uncertain') { res.destroy(); return; }
        if (path === '/slow-upload') { setTimeout(() => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('Late result'); }, 700); return; }
        res.writeHead(200, { 'content-type': 'text/plain' }); res.end('Received transport only'); return;
      }
      if (path === '/download') { res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': 'attachment; filename="unsafe.exe"' }); res.end(`محتوى موثق ${req.headers.cookie ?? 'anonymous'}`); return; }
      if (path === '/large') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('x'.repeat(BROWSER_FILE_MAX_BYTES + 1)); return; }
      if (path === '/pdf') { res.writeHead(200, { 'content-type': 'application/pdf' }); res.end('%PDF-1.7 bad'); return; }
      if (path === '/redirect') { res.writeHead(302, { location: 'https://127.0.0.1/private' }); res.end(); return; }
      if (path.startsWith('/login/')) res.setHeader('set-cookie', `account=${path.slice(7)}; Path=/; Max-Age=3600`);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><title>Files</title><main><form method=post enctype=multipart/form-data action="${path === '/unknown' ? '/uncertain' : path === '/slow' ? '/slow-upload' : '/upload'}"><label>Upload document<input type=file name=document></label><input type=hidden name=csrf value=exact-csrf><button>Upload</button></form><a href=/download>Download</a><a href=/large>Large</a><a href=/pdf>PDF</a><a href=/redirect>Redirect</a><output>Ready</output></main>`);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing address');
  origin = `http://127.0.0.1:${address.port}`;
  store = await createDatabase(); await migrate(store.db);
  await sql`CREATE TABLE chat_conversations(id text PRIMARY KEY,owner_id text NOT NULL,status text NOT NULL,active_run_id text,browser_account text)`.execute(store.db);
  browser = new AgentBrowser({ profileDir: root, testOrigins: [origin], channel: null });
  app = Fastify({ bodyLimit: 16384 });
  app.setErrorHandler((error: any, _req: FastifyRequest, reply: FastifyReply) => reply.code(error.statusCode ?? 400).send({ error: { code: error.code ?? 'INVALID', message: error.message } }));
  control = await registerBrowserFileRoutes(app, { db: store.db, browser, owner: async req => { const id = req.headers['x-test-owner']; if (typeof id !== 'string') throw new BrowserError('UNAUTHORIZED', 'Sign in', 401); return { id }; } });
  await app.ready();
}, 60000);

afterAll(async () => {
  await app?.close(); await browser?.close(); await store?.close();
  await new Promise<void>(resolve => server?.close(() => resolve()));
  const actual = await realpath(root), within = relative(temporary, actual);
  if (isAbsolute(within) || !within.startsWith('mohassan-browser-files-') || within.includes('..')) throw new Error('Unsafe test cleanup');
  await rm(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function conversation(account: string = 'files-common', page = '/files') {
  const id = randomUUID();
  await store.db.insertInto('chat_conversations').values({ id, owner_id: ownerId, status: 'idle', browser_account: account }).execute();
  await browser.bindAccount(ownerId, id, account);
  await browser.act(ownerId, id, { kind: 'open', text: origin + page }, auth());
  return id;
}
async function grant(id: string, direction: 'upload' | 'download', label = 'Download', file = inputFile()) {
  const targets = (await request(`${base(id)}/targets`)).json();
  const ref = (direction === 'upload' ? targets.uploads[0] : targets.downloads.find((item: any) => item.label === label)).ref;
  const response = await request(`${base(id)}/grants`, 'POST', { direction, ref, ...(direction === 'upload' ? { file } : {}) });
  expect(response.statusCode, response.body).toBe(200); return response.json();
}

describe('owner-only browser file grants through HTTP, SQL and real Chromium', () => {
  it('uploads once with the account cookie and exact hidden field, without exposing the file to page JavaScript', async () => {
    const id = await conversation('work', '/login/work'), before = uploads.length;
    const row = await grant(id, 'upload');
    expect(uploads).toHaveLength(before); expect(row.status).toBe('pending');
    expect(JSON.stringify(row)).not.toContain('exact-csrf'); expect(JSON.stringify(row)).not.toContain(inputFile().base64);
    const results = await Promise.all([request(`${base(id)}/grants/${row.id}/execute`, 'POST', {}), request(`${base(id)}/grants/${row.id}/execute`, 'POST', {})]);
    expect(results.map(item => item.statusCode).sort()).toEqual([200, 409]);
    expect(uploads).toHaveLength(before + 1);
    expect(uploads.at(-1)!.body.toString()).toContain('وثيقة من المالك'); expect(uploads.at(-1)!.body.toString()).toContain('exact-csrf');
    expect(uploads.at(-1)!.cookie).toContain('account=work');
    await expect((await browser['conversation'](ownerId, id)).page.locator('input[type=file]').evaluate((node: HTMLInputElement) => node.files?.length)).resolves.toBe(0);
    expect((await request(base(id))).json().files[0]).toMatchObject({ status: 'responded', responseStatus: 200 });
    expect((await store.db.selectFrom('browser_file_grants').select('bytes_base64').where('id', '=', row.id).executeTakeFirst())?.bytes_base64).toBeNull();
  }, 60000);

  it('keeps simultaneous account cookies isolated for real file reads', async () => {
    const work = await conversation('work', '/files'), personal = await conversation('personal', '/login/personal');
    for (const [id, account] of [[work, 'work'], [personal, 'personal']]) {
      const row = await grant(id, 'download');
      const fetched = await request(`${base(id)}/grants/${row.id}/execute`, 'POST', {}); expect(fetched.statusCode, fetched.body).toBe(200);
      expect(fetched.json().status).toBe('quarantined'); expect(fetched.json().filename).toMatch(/\.txt$/);
      expect((await request(`${base(id)}/grants/${row.id}/content`)).statusCode).toBe(403);
      expect((await request(`${base(id)}/grants/${row.id}/release`, 'POST', {})).statusCode).toBe(200);
      const content = await request(`${base(id)}/grants/${row.id}/content`);
      expect(content.body).toContain(`account=${account}`); expect(content.headers['content-type']).toBe('application/octet-stream');
      expect(content.headers['content-disposition']).toMatch(/^attachment; filename="download-.*\.txt"; filename\*=UTF-8''/);
      expect(content.headers['content-security-policy']).toContain('sandbox');
    }
  }, 60000);

  it('enforces ownership, revocation, expiry, and absence of model-supplied paths or destinations', async () => {
    const id = await conversation(), row = await grant(id, 'upload'), before = uploads.length;
    expect((await app.inject({ url: base(id) })).statusCode).toBe(401);
    expect((await request(`${base(id)}/grants/${row.id}/execute`, 'POST', {}, 'foreign-owner')).statusCode).toBe(404);
    expect((await request(`${base(id)}/grants`, 'POST', { direction: 'upload', ref: row.target.ref, file: inputFile(), path: 'C:/secret', url: origin + '/upload' })).statusCode).toBe(400);
    expect((await request(`${base(id)}/grants/${row.id}`, 'DELETE')).statusCode).toBe(200);
    expect((await request(`${base(id)}/grants/${row.id}/execute`, 'POST', {})).statusCode).toBe(409);
    const expired = await grant(id, 'upload');
    await store.db.updateTable('browser_file_grants').set({ expires_at: new Date(0) }).where('id', '=', expired.id).execute();
    expect((await request(`${base(id)}/grants/${expired.id}/execute`, 'POST', {})).statusCode).toBe(409);
    expect(uploads).toHaveLength(before);
  }, 60000);

  it('rejects a changed form, a changed account and a running conversation before dispatch', async () => {
    const id = await conversation(), row = await grant(id, 'upload'), before = uploads.length;
    await (await browser['conversation'](ownerId, id)).page.locator('input[name=csrf]').evaluate((node: HTMLInputElement) => { node.value = 'changed-token'; });
    const stale = await request(`${base(id)}/grants/${row.id}/execute`, 'POST', {}); expect(stale.json().error.code).toBe('BROWSER_FILE_TARGET_STALE');
    const cookieGrant = await grant(id, 'upload');
    await (await browser['conversation'](ownerId, id)).page.context().addCookies([{ name: 'account', value: 'changed-login', url: origin }]);
    expect((await request(`${base(id)}/grants/${cookieGrant.id}/execute`, 'POST', {})).json().error.code).toBe('BROWSER_FILE_TARGET_STALE');
    const second = await grant(id, 'upload');
    await store.db.updateTable('chat_conversations').set({ browser_account: 'different-account' }).where('id', '=', id).execute();
    expect((await request(`${base(id)}/grants/${second.id}/execute`, 'POST', {})).json().error.code).toBe('BROWSER_FILE_ACCOUNT_CHANGED');
    await store.db.updateTable('chat_conversations').set({ status: 'running' }).where('id', '=', id).execute();
    expect((await request(`${base(id)}/targets`)).json().error.code).toBe('BROWSER_FILE_CONVERSATION_BUSY');
    expect(uploads).toHaveLength(before);
  }, 60000);

  it('never retries an upload with an unknown transport result', async () => {
    const id = await conversation(undefined, '/unknown'), row = await grant(id, 'upload'), before = uploads.length;
    const response = await request(`${base(id)}/grants/${row.id}/execute`, 'POST', {}); expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(uploads).toHaveLength(before + 1);
    expect((await request(base(id))).json().files[0].status).toBe('unknown');
    expect((await request(`${base(id)}/grants/${row.id}/execute`, 'POST', {})).statusCode).toBe(409);
    expect(uploads).toHaveLength(before + 1);
    expect((await browser.snapshotSession(ownerId, id))?.status).toBe('review_required');
  }, 60000);

  it('blocks large files, PDF binary and private redirect destinations; default reading still rejects attachments', async () => {
    for (const label of ['Large', 'PDF', 'Redirect']) {
      const id = await conversation();
      const row = await grant(id, 'download', label);
      const response = await request(`${base(id)}/grants/${row.id}/execute`, 'POST', {});
      expect(response.statusCode, response.body).toBeGreaterThanOrEqual(400);
      expect((await request(`${base(id)}/grants/${row.id}/content`)).statusCode).toBe(403);
    }
    await expect(new SafeNetwork({ testOrigins: [origin] }).request(origin + '/download')).rejects.toMatchObject({ code: 'BROWSER_DOWNLOAD_DENIED' });
    const id = await conversation();
    const target = (await request(`${base(id)}/targets`)).json().uploads[0];
    const oversized = await request(`${base(id)}/grants`, 'POST', { direction: 'upload', ref: target.ref, file: inputFile('x'.repeat(BROWSER_FILE_MAX_BYTES + 1)) });
    expect(oversized.statusCode).toBe(400);
  }, 60000);

  it('rechecks content at release, makes revoke immediately effective and recovers interrupted transfers without retry', async () => {
    const id = await conversation(), row = await grant(id, 'download');
    expect((await request(`${base(id)}/grants/${row.id}/execute`, 'POST', {})).statusCode).toBe(200);
    await store.db.updateTable('browser_file_grants').set({ bytes_base64: Buffer.from('tampered').toString('base64') }).where('id', '=', row.id).execute();
    expect((await request(`${base(id)}/grants/${row.id}/release`, 'POST', {})).json().error.code).toBe('BROWSER_FILE_CHANGED');
    await request(`${base(id)}/grants/${row.id}`, 'DELETE');
    expect((await request(`${base(id)}/grants/${row.id}/content`)).statusCode).toBe(403);
    const pending = await grant(id, 'upload'), before = hits.length;
    await store.db.updateTable('browser_file_grants').set({ status: 'dispatching' }).where('id', '=', pending.id).execute();
    await control.recover();
    expect(hits).toHaveLength(before);
    expect((await request(base(id))).json().files.find((file: any) => file.id === pending.id)).toMatchObject({ status: 'unknown', errorCode: 'BROWSER_FILE_RESTARTED' });
  }, 60000);

  it('fences late upload responses after revocation and removes expired bytes in maintenance', async () => {
    const id = await conversation(undefined, '/slow'), row = await grant(id, 'upload'), before = uploads.length;
    const execution = Promise.resolve(request(`${base(id)}/grants/${row.id}/execute`, 'POST', {}));
    await expect.poll(() => uploads.length).toBe(before + 1);
    await request(`${base(id)}/grants/${row.id}`, 'DELETE');
    expect((await execution).statusCode).toBeGreaterThanOrEqual(400);
    const entry = (await request(base(id))).json().files[0]; expect(entry.status).toBe('unknown');
    expect((await store.db.selectFrom('browser_file_grants').select('bytes_base64').where('id', '=', row.id).executeTakeFirst())?.bytes_base64).toBeNull();
    const second = await conversation(), pending = await grant(second, 'upload');
    await store.db.updateTable('browser_file_grants').set({ expires_at: new Date(0) }).where('id', '=', pending.id).execute();
    await control.sweep();
    expect(await store.db.selectFrom('browser_file_grants').select(['status', 'bytes_base64']).where('id', '=', pending.id).executeTakeFirst()).toMatchObject({ status: 'expired', bytes_base64: null });
  }, 60000);

  it('deletes held file contents with their conversation', async () => {
    const id = await conversation(), row = await grant(id, 'upload');
    await store.db.deleteFrom('chat_conversations').where('id', '=', id).where('owner_id', '=', ownerId).execute();
    expect(await store.db.selectFrom('browser_file_grants').select('id').where('id', '=', row.id).executeTakeFirst()).toBeUndefined();
    expect((await request(`${base(id)}/grants/${row.id}/execute`, 'POST', {})).statusCode).toBe(404);
  }, 60000);
});

it('validates PNG structure, text encoding, safe names and type agreement', () => {
  const png = PNG.sync.write(new PNG({ width: 1, height: 1 }));
  expect(inspectBrowserFile(png, 'pixel.png', 'image/png').size).toBe(png.length);
  expect(() => inspectBrowserFile(png, 'pixel.txt', 'text/plain')).toThrow();
  const corrupt = Buffer.from(png); corrupt[35] ^= 127;
  expect(() => inspectBrowserFile(corrupt, 'pixel.png', 'image/png')).toThrow();
  expect(() => inspectBrowserFile(Buffer.from('x'), '../secret.txt', 'text/plain')).toThrow();
  expect(() => inspectBrowserFile(Buffer.from([255, 254]), 'x.txt', 'text/plain')).toThrow();
  expect(() => inspectBrowserFile(Buffer.from('a\u0000b'), 'x.txt', 'text/plain')).toThrow();
  expect(() => inspectBrowserFile(Buffer.from('bad'), 'x.json', 'application/json')).toThrow();
  expect(inspectBrowserFile(Buffer.from('وثيقة'), 'دليل.txt', 'text/plain').name).toBe('دليل.txt');
  const zeroWidth = Buffer.from(png); zeroWidth.writeUInt32BE(0, 16); zeroWidth.writeUInt32BE(0xffffffff, 20);
  expect(() => inspectBrowserFile(zeroWidth, 'pixel.png', 'image/png')).toThrow();
});
