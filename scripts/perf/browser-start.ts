/**
 * Phase 0: hidden browser start, cold and warm, and its memory (docs/MOHASSAN-DEVELOPMENT-PLAN-2026-11-22.md §1.6).
 *
 * Usage: npx tsx scripts/perf/browser-start.ts [--rounds 5] [--out artifacts/perf/2026-11-22/browser-start]
 *
 * Uses the server's own AgentBrowser class with a fresh temporary profile each round, so the owner's
 * browser profile is never touched. A local page (allowed through testOrigins) isolates start-up from
 * the network; one public page (example.com, the reserved example domain) shows a real first load.
 *   cold   first open for a new owner: launches Chrome headless with a new persistent profile
 *   warm   first open for another conversation of the same owner: a new page in the running context
 *   hot    a second navigation in an existing page
 * Memory comes from scripts/perf/resource-sampler.ps1 -Once over this process tree (role `browser`).
 * channel `chrome` is what the server uses by default (installed Google Chrome); `bundled` is Playwright's Chromium.
 */
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { AgentBrowser, type AgentAuthority } from '@mohassan/browser';
import { stats } from './fixture.js';

// The server opens pages through act() with an execution authority (as scripts/hands-live.ts does); open() alone is refused.
const controller = new AbortController();
const authority = (): AgentAuthority => ({ signal: controller.signal, assertActive: async () => {}, dispatched: async permit => permit.id, completed: async () => {} });

const run = promisify(execFile);
const argument = (name: string, fallback: string) => { const at = process.argv.indexOf(`--${name}`); return at >= 0 && process.argv[at + 1] ? process.argv[at + 1]! : fallback; };
const rounds = Number(argument('rounds', '5'));
const out = path.resolve(argument('out', path.join('artifacts', 'perf', '2026-11-22', 'browser-start')));
await mkdir(out, { recursive: true });

const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end('<!doctype html><html lang="ar"><head><title>قياس</title></head><body><h1>صفحة قياس محلية</h1><p>نص قصير.</p></body></html>');
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('LOCAL_SERVER_UNAVAILABLE');
const local = `http://127.0.0.1:${address.port}/`;

async function snapshot(label: string): Promise<Record<string, { count: number; workingSetMB: number; privateMB: number }>> {
  const file = path.join(out, 'snapshots.jsonl');
  const before = await readFile(file, 'utf8').catch(() => '');
  await run('pwsh', ['-NoProfile', '-File', path.resolve('scripts/perf/resource-sampler.ps1'), '-RootPid', String(process.pid), '-OutFile', file, '-Once'], { windowsHide: true });
  const after = await readFile(file, 'utf8');
  const line = after.slice(before.length).trim().split('\n').at(-1)!;
  const sample = JSON.parse(line) as { roles?: Record<string, { count: number; workingSetMB: number; privateMB: number }> };
  await writeFile(path.join(out, 'snapshot-labels.jsonl'), `${JSON.stringify({ label, line: after.split('\n').filter(Boolean).length })}\n`, { flag: 'a' });
  return sample.roles ?? {};
}

const timed = async <T>(work: () => Promise<T>): Promise<[number, T]> => { const started = performance.now(); const value = await work(); return [performance.now() - started, value]; };
const results: Record<string, unknown> = { local, rounds, at: new Date().toISOString() };
for (const channel of ['chrome', 'bundled'] as const) {
  const cold: number[] = [], warm: number[] = [], hot: number[] = [], publicFirst: number[] = [], close: number[] = [];
  const memory: Record<string, unknown>[] = [];
  const failures: string[] = [];
  for (let round = 0; round < rounds; round++) {
    const profileDir = await mkdtemp(path.join(tmpdir(), 'mohassan-perf-browser-'));
    const browser = new AgentBrowser({ profileDir, testOrigins: [local], channel: channel === 'chrome' ? 'chrome' : null, headless: true });
    const owner = `perf-owner-${round}`;
    try {
      const open = (conversation: string, url: string) => browser.act(owner, conversation, { kind: 'open', text: url }, authority());
      const [coldMs] = await timed(() => open('c0', local)); cold.push(coldMs);
      if (round === 0) memory.push({ pages: 1, roles: await snapshot(`${channel} after 1 page`) });
      const [hotMs] = await timed(() => open('c0', `${local}?again`)); hot.push(hotMs);
      for (let page = 1; page <= 2; page++) { const [warmMs] = await timed(() => open(`c${page}`, local)); warm.push(warmMs); }
      if (round === 0) memory.push({ pages: 3, roles: await snapshot(`${channel} after 3 pages`) });
      const [publicMs] = await timed(() => open('public', 'https://example.com/')); publicFirst.push(publicMs);
    } catch (error) {
      failures.push(`${round}: ${error instanceof Error ? `${(error as { code?: string }).code ?? ''} ${error.message}` : String(error)}`);
    } finally {
      const [closeMs] = await timed(() => browser.close()); close.push(closeMs);
      await rm(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => {});
    }
    console.log(`${channel} round ${round}: cold=${cold.at(-1)?.toFixed(0)}ms warm=${warm.slice(-2).map(value => value.toFixed(0)).join('/')}ms hot=${hot.at(-1)?.toFixed(0)}ms example.com=${publicFirst.at(-1)?.toFixed(0)}ms`);
  }
  results[channel] = { coldMs: stats(cold), warmMs: stats(warm), hotMs: stats(hot), exampleComFirstMs: stats(publicFirst), closeMs: stats(close),
    raw: { cold, warm, hot, publicFirst, close }, memory, failures };
}
server.close();
await writeFile(path.join(out, 'browser-start.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify({ out: path.join(out, 'browser-start.json') }));
process.exit(0);
