/**
 * Phase 2 P7: the web app as a dev server versus its production build, measured on the same request.
 *
 * Usage: npx tsx scripts/perf/web-proxy-mode.ts [--out artifacts/perf/2026-11-22/web-proxy-mode]
 *
 * Starts the disposable isolated API (scripts/perf/fixture.ts), then the copied web app twice: `next dev`
 * (what `npm run dev:lab` runs) and, after `next build` in the same copy, `next start` (what
 * `npm run dev:lab:built` runs). Through each, 60 GETs of the conversation list and 60 of one conversation,
 * the first 10 of each dropped, against the same GETs straight to the API. Build time is recorded too.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnOwned, stopOwnedChildren, type OwnedChild } from '../../tests/e2e/isolation.js';
import { FixtureClient, observeRun, startMeasureFixture, stats } from './fixture.js';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const argument = (name: string, fallback: string) => { const at = process.argv.indexOf(`--${name}`); return at >= 0 && process.argv[at + 1] ? process.argv[at + 1]! : fallback; };
const out = path.resolve(argument('out', path.join('artifacts', 'perf', '2026-11-22', 'web-proxy-mode')));
await mkdir(out, { recursive: true });
const WEB_PORT = 3130;

const fixture = await startMeasureFixture({ withWeb: false, apiPort: 4130, webPort: WEB_PORT });
// This script starts the web app itself, twice; tell the client where it will answer.
(fixture as { webBase: string | null }).webBase = fixture.origin;
const client = new FixtureClient(fixture);
const next = path.join(repository, 'node_modules', 'next', 'dist', 'bin', 'next');
async function waitReady(child: OwnedChild, url: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.hasClosed()) throw new Error('WEB_EXITED');
    try { const response = await fetch(url, { signal: AbortSignal.timeout(2000) }); await response.body?.cancel(); if (response.ok) return; } catch { /* starting */ }
    await delay(250);
  }
  throw new Error('WEB_READY_TIMEOUT');
}
async function measure(label: string, conversationId: string) {
  const list: number[] = [], detail: number[] = [], direct: number[] = [];
  for (let round = 0; round < 60; round++) {
    let started = performance.now(); await client.call('GET', '/api/chat/conversations', undefined, 'web'); list.push(performance.now() - started);
    started = performance.now(); await client.call('GET', `/api/chat/conversations/${conversationId}`, undefined, 'web'); detail.push(performance.now() - started);
    started = performance.now(); await client.call('GET', `/api/chat/conversations/${conversationId}`); direct.push(performance.now() - started);
  }
  return { label, listMs: stats(list.slice(10)), detailMs: stats(detail.slice(10)), directDetailMs: stats(direct.slice(10)) };
}
const result: Record<string, unknown> = { at: new Date().toISOString() };
const children: OwnedChild[] = [];
try {
  await client.signIn();
  const warm = await observeRun(client, { text: 'احسب 2 + 2' }, { pollMs: 300, timeoutMs: 60_000 });
  const webDirectory = path.join(fixture.directory, 'web');
  const environment = { ...(fixture as unknown as { environment?: NodeJS.ProcessEnv }).environment };
  // The fixture keeps its environment private; rebuild the few keys the web process needs from what it exposes.
  const webEnv: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1', MOHASSAN_ISOLATED_TEST: 'true',
    INTERNAL_API_SECRET: fixture.secret, MOHASSAN_SERVER_URL: fixture.apiBase, PORT: String(WEB_PORT), WEB_ORIGIN: fixture.origin, ...environment };
  // 1) next dev
  let started = performance.now();
  const dev = spawnOwned([next, 'dev', '--webpack', '--hostname', '127.0.0.1', '--port', String(WEB_PORT)], webDirectory, webEnv);
  children.push(dev);
  await waitReady(dev, `${fixture.origin}/api/setup`, 180_000);
  result.devReadyMs = Math.round(performance.now() - started);
  // First request compiles the route; measure after it.
  await client.call('GET', `/api/chat/conversations/${warm.conversationId}`, undefined, 'web');
  result.dev = await measure('next dev', warm.conversationId);
  await stopOwnedChildren([dev]);
  // 2) next build + next start in the same copy
  started = performance.now();
  // The copied web app reaches node_modules through a junction; Turbopack cannot find Next there, webpack can (as `next dev --webpack` does).
  const build = spawnOwned([next, 'build', '--webpack'], webDirectory, { ...webEnv, NODE_ENV: 'production' });
  await build.closed;
  result.buildMs = Math.round(performance.now() - started);
  started = performance.now();
  const prod = spawnOwned([next, 'start', '--hostname', '127.0.0.1', '--port', String(WEB_PORT)], webDirectory, { ...webEnv, NODE_ENV: 'production' });
  children.push(prod);
  await waitReady(prod, `${fixture.origin}/api/setup`, 120_000);
  result.startReadyMs = Math.round(performance.now() - started);
  await client.call('GET', `/api/chat/conversations/${warm.conversationId}`, undefined, 'web');
  result.built = await measure('next start', warm.conversationId);
  await stopOwnedChildren([prod]);
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error);
} finally {
  await stopOwnedChildren(children).catch(() => {});
  await fixture.stop().catch(() => {});
}
await writeFile(path.join(out, 'web-proxy-mode.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 1));
process.exit(result.error ? 1 : 0);
