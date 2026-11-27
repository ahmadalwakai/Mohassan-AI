import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopApps, DesktopWindows, type WindowInfo } from '@mohassan/desktop';
import { NextRequest } from 'next/server';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { GET as relayGet } from '../apps/web/app/api/[...path]/route.js';
import { runCommand } from '../packages/desktop/src/shell.ts';
import { checkError, checkJson, openClientApiApp, type ClientApiAccount } from './support/client-api-app.js';

vi.mock('../packages/desktop/src/shell.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../packages/desktop/src/shell.ts')>(),
  runCommand: vi.fn(),
}));

// The desktop web DTOs are local to the component and the Fastify handlers, retrieved 2026-11-27.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/web/components/desktop-workspace.tsx#L12
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/desktop.ts#L51
const pathFields = { path: z.string().min(1), display: z.string().min(1) };
const project = z.object({
  ...pathFields, id: z.uuid(), name: z.string(), template: z.string(), createdAt: z.iso.datetime(), git: z.boolean(), exists: z.boolean(),
});
const template = z.object({ id: z.string(), label: z.string(), labelAr: z.string(), descriptionAr: z.string(), needsInstall: z.boolean() });
const audit = z.object({ at: z.iso.datetime(), kind: z.string(), detail: z.record(z.string(), z.unknown()), ok: z.boolean() });
const windowItem = z.object({
  handle: z.number(), title: z.string(), processName: z.string(), minimized: z.boolean(),
  foreground: z.boolean(), width: z.number(), height: z.number(),
});
const captureMeta = z.strictObject({ width: z.number(), height: z.number(), capturedAt: z.iso.datetime(), file: z.string().nullable(), window: z.string().nullable() });
const captureHeader = 'x-desktop-capture';
const capturePath = '/api/desktop/screenshot?save=true&maxWidth=1600';
const api = '/api/desktop';

let fixture: Awaited<ReturnType<typeof openClientApiApp>>;
let owner: ClientApiAccount;
let member: ClientApiAccount;
let temp: string;
let projectsRoot: string;
let image: Buffer<ArrayBufferLike>;
let capturedAt: string;

beforeAll(async () => {
  temp = await mkdtemp(join(tmpdir(), 'mohassan-client-desktop-'));
  projectsRoot = join(temp, 'projects');
  await mkdir(projectsRoot);
  fixture = await openClientApiApp({
    desktop: { enabled: true, dataDir: join(temp, 'desktop'), projectsRoot, roots: [temp], screenshotsDir: join(temp, 'captures') },
  });
  owner = await fixture.setupOwner();
  member = await fixture.inviteMember(owner);
  image = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'white' } }).png().toBuffer();
  capturedAt = new Date().toISOString();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  try { await fixture?.close(); }
  finally { if (temp) await rm(temp, { recursive: true, force: true }); }
});

describe('desktop web contracts', () => {
  it('validates status, project metadata, filesystem replies, local shell, audit and authorization', async () => {
    checkError(await fixture.send('GET', api), 401, 'UNAUTHORIZED');
    checkError(await fixture.send('GET', api, member), 403, 'MEMBER_FORBIDDEN');
    checkJson(await fixture.send('GET', api, owner), 200, z.object({
      enabled: z.literal(true), native: z.boolean(), projectsRoot: z.literal(projectsRoot), roots: z.array(z.string()),
      screenshotsDir: z.string(), projects: z.number(), templates: z.array(template),
      apps: z.array(z.object({ id: z.string(), label: z.string(), labelAr: z.string() })), recent: z.array(audit),
    }));

    const projectsPath = `${api}/projects`;
    const created = checkJson(await fixture.send('POST', projectsPath, owner, { name: 'Contract fixture', template: 'empty', git: false }), 200,
      project.extend({ files: z.array(z.string()).min(1), install: z.literal('skipped'), opened: z.literal('none') }));
    expect(checkJson(await fixture.send('GET', projectsPath, owner), 200,
      z.object({ projects: z.array(project), templates: z.array(template), root: z.string() })).projects[0]?.id).toBe(created.id);

    // Native program launches are stubbed. The production app still parses requests and shapes replies.
    vi.spyOn(DesktopApps.prototype, 'open').mockImplementation(async target => ({ target, display: target, kind: 'folder' }));
    const projectAction = `${projectsPath}/${created.id}`;
    const opened = z.object({ target: z.string(), display: z.string(), kind: z.literal('folder') });
    checkJson(await fixture.send('POST', `${projectAction}/open`, owner, { target: 'folder' }), 200, opened.extend({ project }));
    checkJson(await fixture.send('POST', `${api}/open`, owner, { kind: 'path', target: created.path }), 200, opened);
    checkError(await fixture.send('POST', `${projectsPath}/${randomUUID()}/open`, owner, { target: 'folder' }), 404, 'DESKTOP_PROJECT_NOT_FOUND');

    const filesPath = `${api}/files`;
    const path = join(created.path, 'fixture.txt');
    const text = 'Local transport fixture';
    const write = { op: 'write', path, content: text };
    checkJson(await fixture.send('POST', filesPath, owner, write), 200,
      z.object({ ...pathFields, bytes: z.literal(Buffer.byteLength(text)), created: z.literal(true), appended: z.literal(false) }));
    checkError(await fixture.send('POST', filesPath, owner, write), 409, 'DESKTOP_FILE_EXISTS');
    const listed = checkJson(await fixture.send('GET', `${filesPath}?path=${encodeURIComponent(created.path)}`, owner), 200, z.object({
      ...pathFields, parent: z.string().nullable(), entries: z.array(z.object({
        name: z.string(), kind: z.enum(['file', 'folder', 'link', 'other']), size: z.number(), modifiedAt: z.iso.datetime(), hidden: z.boolean(),
      })), truncated: z.boolean(), total: z.number(),
    }));
    expect(listed.entries.some(entry => entry.name === 'fixture.txt')).toBe(true);
    checkJson(await fixture.send('GET', `${filesPath}/content?path=${encodeURIComponent(path)}`, owner), 200,
      z.object({ ...pathFields, text: z.literal(text), size: z.number(), modifiedAt: z.iso.datetime(), truncated: z.boolean(), binary: z.boolean() }));

    checkJson(await fixture.send('POST', `${api}/command`, owner, { text: 'list projects' }), 200, z.object({
      understood: z.literal(true), label: z.string(), outcome: z.object({ status: z.literal('completed'), text: z.string() }),
    }));
    const command = 'echo contract-fixture';
    vi.mocked(runCommand).mockResolvedValueOnce({
      command, cwd: created.path, shell: 'powershell', exitCode: 0, stdout: 'contract-fixture\n', stderr: '',
      durationMs: 1, timedOut: false, truncated: false,
    });
    checkJson(await fixture.send('POST', `${api}/shell`, owner, { command, cwd: created.path }), 200, z.object({
      verdict: z.object({ level: z.literal('safe'), reasonAr: z.string() }), cwd: z.string(),
      result: z.object({ exitCode: z.literal(0), stdout: z.string(), stderr: z.string(), durationMs: z.number(), timedOut: z.literal(false) }),
    }));
    checkJson(await fixture.send('GET', `${api}/system`, owner), 200, z.object({
      hostname: z.string(), user: z.string(), os: z.string(), release: z.string(),
      cpu: z.object({ model: z.string(), cores: z.number() }), memory: z.object({ totalBytes: z.number(), freeBytes: z.number() }),
      disks: z.array(z.object({ drive: z.string(), label: z.string(), totalBytes: z.number(), freeBytes: z.number() })),
      battery: z.object({ percent: z.number(), charging: z.boolean().nullable() }).nullable(),
      gpus: z.array(z.string()), uptimeSeconds: z.number(),
    }));
    checkJson(await fixture.send('GET', `${api}/audit`, owner), 200, z.object({ entries: z.array(audit).min(1) }));
    checkJson(await fixture.send('POST', `${projectAction}/forget`, owner, {}), 200, z.strictObject({ removed: z.literal(true) }));
  });

  it('validates the client windows responses and binary capture from Fastify', async () => {
    const nativeWindow: WindowInfo = {
      handle: 1, title: 'Fixture window', processId: 1, processName: 'fixture', className: 'fixture',
      x: 0, y: 0, width: 640, height: 480, minimized: false, maximized: false, foreground: true,
    };
    vi.spyOn(DesktopWindows.prototype, 'list').mockResolvedValue([nativeWindow]);
    vi.spyOn(DesktopWindows.prototype, 'foreground').mockResolvedValue(nativeWindow);
    vi.spyOn(DesktopWindows.prototype, 'focus').mockResolvedValue({ window: nativeWindow, result: 'OK' });
    checkJson(await fixture.send('GET', `${api}/windows`, owner), 200, z.strictObject({
      windows: z.array(windowItem).min(1), foreground: windowItem,
    }));
    checkJson(await fixture.send('POST', `${api}/windows`, owner, { handle: nativeWindow.handle, action: 'focus' }), 200,
      z.strictObject({ window: windowItem, result: z.string() }));

    const capture = await screenshot();
    expect(capture.statusCode).toBe(200);
    expect(capture.headers['content-type']).toBe('image/png');
    expect(capture.headers['content-disposition']).toBe('inline');
    expect(capture.rawPayload.equals(image)).toBe(true);
    const header = capture.headers[captureHeader];
    const meta = captureMeta.parse(JSON.parse(typeof header === 'string' ? header : '{}'));
    expect(meta.capturedAt).toBe(capturedAt);
    expect(meta.file).toContain(join(temp, 'captures'));
    const relayed = await relayScreenshot(capture);
    expect(relayed.status).toBe(200);
    expect(relayed.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await relayed.arrayBuffer()).equals(image)).toBe(true);
  });

  it.fails('preserves the screenshot metadata header through the Next relay (reported production drift)', async () => {
    const capture = await screenshot();
    const relayed = await relayScreenshot(capture);
    expect(relayed.headers.get(captureHeader)).toBe(capture.headers[captureHeader]);
  });
});

function relayScreenshot(capture: Awaited<ReturnType<typeof screenshot>>) {
  const header = capture.headers[captureHeader];
  if (typeof header !== 'string') throw new Error('Fastify screenshot metadata is missing');
  const headers = { 'content-type': 'image/png', [captureHeader]: header };
  vi.stubEnv('INTERNAL_API_SECRET', 'fixture-only-internal-secret');
  vi.stubEnv('MOHASSAN_SERVER_URL', 'http://api.example.test');
  vi.stubGlobal('fetch', async () => new Response(new Uint8Array(capture.rawPayload), { status: capture.statusCode, headers }));
  return relayGet(new NextRequest(`http://web.example.test${capturePath}`),
    { params: Promise.resolve({ path: ['desktop', 'screenshot'] }) });
}

function screenshot() {
  vi.spyOn(DesktopWindows.prototype, 'screenshot').mockResolvedValue({
    png: image.toString('base64'), width: 2, height: 2, scaledWidth: 2, scaledHeight: 2,
    left: 0, top: 0, capturedAt, window: null,
  });
  return fixture.send('GET', capturePath, owner);
}
