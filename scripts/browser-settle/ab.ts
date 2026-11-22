/**
 * A/B of the per-step browser cost: the quiet-network window AgentBrowser waits after each action
 * (0-baseline §7.2 measured 0.63–0.67 s per step on a local page; docs/MOHASSAN-DEVELOPMENT-PLAN-2026-11-22.md §5.2).
 *
 * Usage: npx tsx scripts/browser-settle/ab.ts [--steps 12] [--channel chrome|bundled] [--windows 500,200] [--out artifacts/browser-settle-2026-11-22]
 *
 * Both settings run in the same process, interleaved step by step on the same local page, so machine load affects
 * them equally. 500 ms is Playwright's own `networkidle` window (the behaviour before 2026-11-22); 200 ms is the
 * proposed default. Each step is one navigation through act() with an execution authority, as the server does.
 */
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentBrowser, type AgentAuthority } from '@mohassan/browser';

const controller = new AbortController();
const authority = (): AgentAuthority => ({ signal: controller.signal, assertActive: async () => {}, dispatched: async permit => permit.id, completed: async () => {} });
const argument = (name: string, fallback: string) => { const at = process.argv.indexOf(`--${name}`); return at >= 0 && process.argv[at + 1] ? process.argv[at + 1]! : fallback; };
const steps = Math.max(2, Number(argument('steps', '12')));
const channel = argument('channel', 'chrome') === 'bundled' ? null : 'chrome' as const;
const windows = argument('windows', '500,200').split(',').map(Number).filter(value => Number.isFinite(value) && value >= 0);
const out = path.resolve(argument('out', path.join('artifacts', 'browser-settle-2026-11-22')));
await mkdir(out, { recursive: true });

const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html><html lang="ar"><head><title>قياس</title></head><body><h1>صفحة قياس محلية</h1>${'<p>سطر نص يمثل مقالًا متوسط الطول.</p>'.repeat(60)}</body></html>`);
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('LOCAL_SERVER_UNAVAILABLE');
const local = `http://127.0.0.1:${address.port}/`;

const stats = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))] ?? 0; return { n: sorted.length, p50: +at(0.5).toFixed(0), p95: +at(0.95).toFixed(0), min: +(sorted[0] ?? 0).toFixed(0), max: +(sorted.at(-1) ?? 0).toFixed(0) }; };
const profiles: string[] = [];
const browsers = new Map<number, AgentBrowser>();
const owner = 'settle-ab-owner';
const durations = new Map<number, number[]>(windows.map(window => [window, []]));
const started = new Date().toISOString();
try {
  for (const window of windows) {
    const profileDir = await mkdtemp(path.join(tmpdir(), `mohassan-settle-${window}-`)); profiles.push(profileDir);
    const browser = new AgentBrowser({ profileDir, testOrigins: [local], channel, headless: true, idlePageMs: null, settleQuietMs: window });
    browsers.set(window, browser);
    // Warm-up: the first open launches the browser and is not a step.
    await browser.act(owner, 'c', { kind: 'open', text: `${local}?warm` }, authority());
  }
  for (let step = 0; step < steps; step++) {
    for (const window of windows) {
      const browser = browsers.get(window)!;
      const begin = performance.now();
      await browser.act(owner, 'c', { kind: 'open', text: `${local}?step=${step}&w=${window}` }, authority());
      durations.get(window)!.push(performance.now() - begin);
    }
  }
} finally {
  await Promise.allSettled([...browsers.values()].map(browser => browser.close()));
  server.close();
  await Promise.allSettled(profiles.map(profile => rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })));
}
const results = { at: started, channel: channel ?? 'bundled', steps, local, windows: Object.fromEntries(windows.map(window => [window, stats(durations.get(window)!)])), raw: Object.fromEntries(windows.map(window => [window, durations.get(window)!.map(value => +value.toFixed(0))])) };
await writeFile(path.join(out, `settle-ab-${channel ?? 'bundled'}.json`), `${JSON.stringify(results, null, 2)}\n`);
const table = ['| quiet window ms | steps | p50 ms | p95 ms | min | max |', '|---|---|---|---|---|---|', ...windows.map(window => { const s = results.windows[window]!; return `| ${window} | ${s.n} | ${s.p50} | ${s.p95} | ${s.min} | ${s.max} |`; })].join('\n');
await writeFile(path.join(out, `README-settle-ab-${channel ?? 'bundled'}.md`), `# Per-step browser cost by quiet-network window (${channel ?? 'bundled'})\n\nMeasured ${started}: one local page, ${steps} interleaved navigations per setting through act().\n\n${table}\n`);
console.log(table);
