import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentBrowser, type AgentAuthority } from './index.js';

// The quiet-network wait after an action (0-baseline §7.2: 0.63 s per step came from Playwright's fixed 500 ms networkidle).
const owner = 'settle-fixture-owner';
const auth = (): AgentAuthority => ({ signal: new AbortController().signal, assertActive: async () => {}, dispatched: async permit => permit.id, completed: async () => {} });
let server: Server, origin: string, root: string, temporaryRoot: string;
const browsers: AgentBrowser[] = [];
const page = (body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Settle fixture</title></head><body>${body}</body></html>`;

beforeAll(async () => {
  temporaryRoot = await realpath(tmpdir());
  root = await mkdtemp(join(temporaryRoot, 'mohassan-settle-fixture-'));
  server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://fixture').pathname;
    if (path === '/data') { setTimeout(() => { response.writeHead(200, { 'content-type': 'text/plain' }); response.end('LOADED-DATA-7731'); }, 300); return; }
    if (path === '/tick') { setTimeout(() => { response.writeHead(200, { 'content-type': 'text/plain' }); response.end('tick'); }, 20); return; }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (path === '/late-content') {
      // A page that fetches its real content shortly after load, as many article pages do.
      response.end(page('<main><h1>Shell</h1><p id="out">waiting</p></main><script>setTimeout(() => fetch("/data").then(r => r.text()).then(t => { document.getElementById("out").textContent = t; }), 100);</script>'));
      return;
    }
    if (path === '/never-quiet') {
      // A page whose network never rests: the wait must end at the cap, not hang.
      response.end(page('<main><h1>Busy</h1><p>streaming</p></main><script>(function loop(){ fetch("/tick").finally(() => setTimeout(loop, 40)); })();</script>'));
      return;
    }
    response.end(page('<main><h1>Plain</h1><p>static text</p></main>'));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing settle fixture port');
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  await Promise.allSettled(browsers.map(browser => browser.close()));
  await new Promise<void>(resolve => server?.close(() => resolve()));
  const target = await realpath(root), within = relative(temporaryRoot, target);
  if (isAbsolute(within) || !within.startsWith('mohassan-settle-fixture-') || within.includes('..')) throw new Error('Unsafe settle fixture cleanup');
  await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const newBrowser = (settleQuietMs?: number) => {
  const browser = new AgentBrowser({ profileDir: join(root, randomUUID()), testOrigins: [origin], allowedOrigins: [origin], channel: null, headless: true, idlePageMs: null, ...(settleQuietMs === undefined ? {} : { settleQuietMs }) });
  browsers.push(browser);
  return browser;
};

describe('the quiet-network wait after an action', () => {
  it('still waits for content a page fetches right after load, so the read page carries it', async () => {
    const browser = newBrowser();
    const result = await browser.act(owner, randomUUID(), { kind: 'open', text: `${origin}/late-content` }, auth());
    expect(result.page.text).toContain('LOADED-DATA-7731');
    expect(result.page.text).not.toContain('waiting');
  });

  it('ends at the cap on a page whose network never rests, instead of hanging', async () => {
    const browser = newBrowser();
    const started = performance.now();
    const result = await browser.act(owner, randomUUID(), { kind: 'open', text: `${origin}/never-quiet` }, auth());
    const elapsed = performance.now() - started;
    expect(result.page.text).toContain('streaming');
    // Navigation plus the 900 ms cap and the page read; well under the old 4 s document timeout even on a loaded machine.
    expect(elapsed).toBeLessThan(6000);
  });

  it('is cheaper than the 500 ms window on a plain page, and 500 reproduces the old floor', async () => {
    const quick = newBrowser(200), slow = newBrowser(500);
    const id = randomUUID();
    await quick.act(owner, id, { kind: 'open', text: `${origin}/plain` }, auth());
    await slow.act(owner, id, { kind: 'open', text: `${origin}/plain` }, auth());
    const time = async (browser: AgentBrowser, step: number) => { const begin = performance.now(); await browser.act(owner, id, { kind: 'open', text: `${origin}/plain?step=${step}` }, auth()); return performance.now() - begin; };
    const quickTimes: number[] = [], slowTimes: number[] = [];
    for (let step = 0; step < 4; step++) { quickTimes.push(await time(quick, step)); slowTimes.push(await time(slow, step)); }
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
    // The old floor was 120 + 500 ms before the page could be read; the new one is 120 + 200 ms.
    expect(median(slowTimes)).toBeGreaterThan(600);
    expect(median(quickTimes)).toBeLessThan(median(slowTimes));
  });
});
