/**
 * Memory of idle conversation pages before and after the idle close
 * (docs/MOHASSAN-DEVELOPMENT-PLAN-2026-11-22.md §5.2 P2; docs/RESPONSE-QUALITY-PLAN-2026-11-22.md E5.3).
 *
 * Usage: npx tsx scripts/browser-idle/measure.ts [--conversations 4] [--channel chrome|bundled] [--public] [--out artifacts/browser-idle-close-2026-11-22]
 *
 * The server's own AgentBrowser class with a fresh temporary profile, so the owner's profile is never touched.
 * Each stage is followed by one memory sample of this process tree (scripts/perf/resource-sampler.ps1 -Once, role `browser`):
 *   started      the browser is running, no page yet
 *   open         N conversations opened and left idle (the server keeps at most 4 per owner)
 *   closed       the idle sweep closed them (idlePageMs is 15 s here; the server default is 30 min, proposed)
 *   restored     one conversation opened its page again, as «استعادة» does
 * --public opens real pages (example.com, en.wikipedia.org, bbc.com, gov.uk) instead of the local fixture, which is
 * closer to the owner's day but depends on the network. Both runs write results.json and README.md under --out.
 */
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { AgentBrowser, type AgentAuthority } from '@mohassan/browser';

const controller = new AbortController();
const authority = (): AgentAuthority => ({ signal: controller.signal, assertActive: async () => {}, dispatched: async permit => permit.id, completed: async () => {} });
const run = promisify(execFile);
const argument = (name: string, fallback: string) => { const at = process.argv.indexOf(`--${name}`); return at >= 0 && process.argv[at + 1] ? process.argv[at + 1]! : fallback; };
const conversations = Math.max(1, Number(argument('conversations', '4')));
const channel = argument('channel', 'chrome') === 'bundled' ? null : 'chrome' as const;
const publicPages = process.argv.includes('--public');
const out = path.resolve(argument('out', path.join('artifacts', 'browser-idle-close-2026-11-22')));
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
await mkdir(out, { recursive: true });

const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html><html lang="ar"><head><title>قياس</title></head><body><h1>صفحة قياس محلية</h1>${'<p>سطر نص يمثل مقالًا متوسط الطول.</p>'.repeat(120)}</body></html>`);
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('LOCAL_SERVER_UNAVAILABLE');
const local = `http://127.0.0.1:${address.port}/`;
// Four different sites, so Chrome gives each its own renderer process as it does for the owner's conversations.
// bbc.com is left out: its consent redirect is an automatic navigation the effect policy blocks (0-baseline §8.3).
const PUBLIC = ['https://example.com/', 'https://en.wikipedia.org/wiki/Web_browser', 'https://www.gov.uk/', 'https://www.iana.org/help/example-domains'];
const pageFor = (index: number) => publicPages ? PUBLIC[index % PUBLIC.length]! : `${local}?conversation=${index}`;

type Roles = Record<string, { count: number; workingSetMB: number; privateMB: number }>;
const samplesFile = path.join(out, `samples-${publicPages ? 'public' : 'local'}.jsonl`);
async function sample(stage: string): Promise<{ stage: string; browser: Roles[string] | null; all: Roles }> {
  const before = await readFile(samplesFile, 'utf8').catch(() => '');
  await run('pwsh', ['-NoProfile', '-File', path.resolve('scripts/perf/resource-sampler.ps1'), '-RootPid', String(process.pid), '-OutFile', samplesFile, '-Once'], { windowsHide: true });
  const after = await readFile(samplesFile, 'utf8');
  const line = after.slice(before.length).trim().split('\n').at(-1)!;
  const parsed = JSON.parse(line) as { roles?: Roles };
  const roles = parsed.roles ?? {};
  return { stage, browser: roles.browser ?? null, all: roles };
}

const profileDir = await mkdtemp(path.join(tmpdir(), 'mohassan-idle-measure-'));
// Long enough that all pages are still open when the «open» stage is sampled (public opens take a few seconds each).
const IDLE_MS = 15_000;
const browser = new AgentBrowser({ profileDir, testOrigins: [local], channel, headless: true, idlePageMs: IDLE_MS });
const owner = 'idle-measure-owner';
const stages: { stage: string; pagesOpen: number; browser: Roles[string] | null; note?: string }[] = [];
const failures: string[] = [];
const started = new Date().toISOString();
try {
  const open = (conversation: string, url: string) => browser.act(owner, conversation, { kind: 'open', text: url }, authority());
  // Start the browser with a page we close at once, so the first sample is the running browser alone.
  await open('warm-up', pageFor(0));
  await browser.closeConversation(owner, 'warm-up');
  await delay(1500);
  stages.push({ stage: 'started', pagesOpen: 0, browser: (await sample('started')).browser });
  let opened = 0;
  for (let index = 0; index < conversations; index++) {
    try { await open(`c${index}`, pageFor(index)); opened++; }
    catch (error) { failures.push(`open c${index}: ${error instanceof Error ? `${(error as { code?: string }).code ?? ''} ${error.message}` : String(error)}`); }
  }
  const live = async () => { let count = 0; for (let index = 0; index < conversations; index++) if (await browser.hasPage(owner, `c${index}`)) count++; return count; };
  // Sample before the idle time elapses, so the pages are still open (the sweep timer runs every idlePageMs / 2).
  await delay(300);
  const openPages = await live();
  stages.push({ stage: 'open', pagesOpen: openPages, browser: (await sample('open')).browser, note: opened > 4 ? `${opened} opened; the server keeps at most 4 per owner` : undefined });
  // Nothing uses the pages: the timer sweeps them as it would in the server; a manual sweep catches any stragglers.
  await delay(IDLE_MS + 1500);
  await browser.sweepIdlePages();
  await delay(2500);
  const remaining = await live();
  stages.push({ stage: 'closed', pagesOpen: remaining, browser: (await sample('closed')).browser, note: `${openPages - remaining} closed by the idle sweep` });
  await open('c0', pageFor(0));
  await delay(800);
  const restored = await live();
  stages.push({ stage: 'restored', pagesOpen: restored, browser: (await sample('restored')).browser });
} catch (error) {
  failures.push(error instanceof Error ? `${(error as { code?: string }).code ?? ''} ${error.message}` : String(error));
} finally {
  await browser.close().catch(() => {});
  server.close();
  await rm(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => {});
}

const results = { at: started, channel: channel ?? 'bundled', pages: publicPages ? 'public' : 'local', conversations, idlePageMs: IDLE_MS, stages, failures };
const name = publicPages ? 'public' : 'local';
await writeFile(path.join(out, `results-${name}.json`), `${JSON.stringify(results, null, 2)}\n`);
const row = (stage: typeof stages[number]) => `| ${stage.stage} | ${stage.pagesOpen} | ${stage.browser?.count ?? '—'} | ${stage.browser?.workingSetMB ?? '—'} | ${stage.browser?.privateMB ?? '—'} | ${stage.note ?? ''} |`;
const table = ['| stage | pages open | chrome processes | working set MB | private MB | note |', '|---|---|---|---|---|---|', ...stages.map(row)].join('\n');
await writeFile(path.join(out, `README-${name}.md`), `# Idle page close: memory (${name} pages, ${channel ?? 'bundled'})\n\nMeasured ${started}. Conversations: ${conversations}. idlePageMs in this run: ${IDLE_MS} (server default 30 min, proposed).\n\n${table}\n\n${failures.length ? `Failures:\n${failures.map(line => `- ${line}`).join('\n')}\n` : 'No failures.\n'}`);
console.log(table);
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
