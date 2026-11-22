import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentBrowser, type AgentAuthority, type AgentSessionCheckpoint } from './index.js';

// Idle conversation pages (docs/MOHASSAN-DEVELOPMENT-PLAN-2026-11-22.md §5.2 P2; measured in 0-baseline §7: pages never closed).
const owner = 'idle-fixture-owner';
const auth = (): AgentAuthority => ({ signal: new AbortController().signal, assertActive: async () => {}, dispatched: async permit => permit.id, completed: async () => {} });
const IDLE_MS = 60_000;
let server: Server, origin: string, root: string, temporaryRoot: string;
const saved: AgentSessionCheckpoint[] = [];
const browsers: AgentBrowser[] = [];
const newBrowser = (idlePageMs: number | null) => {
  const browser = new AgentBrowser({ profileDir: join(root, randomUUID()), testOrigins: [origin], allowedOrigins: [origin], channel: null, headless: true, idlePageMs,
    onCheckpoint: async checkpoint => { saved.push(checkpoint); } });
  browsers.push(browser);
  return browser;
};
const open = (browser: AgentBrowser, id: string, path: string) => browser.act(owner, id, { kind: 'open', text: `${origin}${path}` }, auth());

beforeAll(async () => {
  temporaryRoot = await realpath(tmpdir());
  root = await mkdtemp(join(temporaryRoot, 'mohassan-idle-fixture-'));
  server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><html lang="ar"><head><title>Idle fixture</title></head><body><main><h1>صفحة خاملة</h1><p>نص قصير.</p></main></body></html>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing idle fixture port');
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  await Promise.allSettled(browsers.map(browser => browser.close()));
  await new Promise<void>(resolve => server?.close(() => resolve()));
  const target = await realpath(root), within = relative(temporaryRoot, target);
  if (isAbsolute(within) || !within.startsWith('mohassan-idle-fixture-') || within.includes('..')) throw new Error('Unsafe idle fixture cleanup');
  await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('idle conversation pages are closed, their checkpoint kept', () => {
  it('closes a page nobody used for idlePageMs and keeps a ready checkpoint that names the page', async () => {
    const browser = newBrowser(IDLE_MS);
    const id = randomUUID();
    await open(browser, id, '/first');
    expect(await browser.hasPage(owner, id)).toBe(true);
    // Used a moment ago: nothing to close.
    expect(await browser.sweepIdlePages(Date.now())).toBe(0);
    expect(await browser.hasPage(owner, id)).toBe(true);
    const before = saved.length;
    expect(await browser.sweepIdlePages(Date.now() + IDLE_MS + 1)).toBe(1);
    expect(await browser.hasPage(owner, id)).toBe(false);
    expect(await browser.activity(owner, id)).toBeNull();
    expect(await browser.screen(owner, id)).toBeNull();
    const checkpoint = saved.slice(before).at(-1);
    expect(checkpoint).toMatchObject({ ownerId: owner, conversationId: id, status: 'ready', resumeUrl: `${origin}/first` });
    // The conversation goes on: its next page opens in the same context.
    const again = await open(browser, id, '/second');
    expect(again.page.url).toBe(`${origin}/second`);
    expect(await browser.hasPage(owner, id)).toBe(true);
    // A second sweep finds nothing new to close.
    expect(await browser.sweepIdlePages(Date.now())).toBe(0);
  });

  it('never closes a page with an action in flight, and closes it once the action is over', async () => {
    const browser = newBrowser(IDLE_MS);
    const id = randomUUID();
    await open(browser, id, '/busy');
    const waiting = browser.wait(owner, id, 700);
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(await browser.sweepIdlePages(Date.now() + IDLE_MS + 1)).toBe(0);
    expect(await browser.hasPage(owner, id)).toBe(true);
    await waiting;
    expect(await browser.sweepIdlePages(Date.now() + IDLE_MS + 1)).toBe(1);
    expect(await browser.hasPage(owner, id)).toBe(false);
  });

  it('closes only the idle conversations of an owner and leaves the rest', async () => {
    const browser = newBrowser(IDLE_MS);
    const idle = randomUUID(), fresh = randomUUID();
    await open(browser, idle, '/idle');
    const idleAt = Date.now();
    await new Promise(resolve => setTimeout(resolve, 60));
    await open(browser, fresh, '/fresh');
    // Half a minute after the first page opened: the first is idle for IDLE_MS only if we move the clock past it alone.
    expect(await browser.sweepIdlePages(idleAt + IDLE_MS + 10)).toBe(1);
    expect(await browser.hasPage(owner, idle)).toBe(false);
    expect(await browser.hasPage(owner, fresh)).toBe(true);
  });

  it('sweeps by itself on a timer, and never when disabled', async () => {
    const quick = newBrowser(300);
    const id = randomUUID();
    await open(quick, id, '/timer');
    await expect.poll(() => quick.hasPage(owner, id), { timeout: 8000, interval: 100 }).toBe(false);
    const never = newBrowser(null);
    const other = randomUUID();
    await open(never, other, '/kept');
    expect(await never.sweepIdlePages(Date.now() + 10 * IDLE_MS)).toBe(0);
    expect(await never.hasPage(owner, other)).toBe(true);
  });
});
