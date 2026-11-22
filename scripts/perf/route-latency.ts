/**
 * Phase 0: route latency baseline (docs/MOHASSAN-DEVELOPMENT-PLAN-2026-11-22.md §5.1, §1.6).
 *
 * Usage: npx tsx scripts/perf/route-latency.ts [--reps 3] [--poll 300] [--out artifacts/perf/2026-11-22/route-latency] [--no-web]
 *
 * Runs 40 fixed owner requests that cover the chat's paths, one at a time, against a disposable
 * isolated server (scripts/perf/fixture.ts): empty embedded database, no chat model, Windows control
 * off. Web questions use the real public web through the server's own hidden browser, as in the lab.
 *
 * Per request it records, all as wall-clock ms from just before the POST:
 *   accept    POST round trip; the reply already carries the first progress line («يفهم طلبك…»)
 *   progress  each new progress text and when a poll first saw it (poll interval = granularity)
 *   browser   when the conversation first had a browser page, i.e. when the UI would open the panel
 *   settle    when a poll first saw the run leave `running`
 *   server    assistant message created_at − user message created_at (database clock, no polling error)
 *   steps     server step events (chat_events kind=step) relative to the user message
 * Routing is timed in-process on the same texts (rulesRoute + B0), because it is not visible over HTTP.
 * The first web request after start is reported separately as the cold browser start.
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { FixtureClient, observeRun, startMeasureFixture, stats, type RunObservation } from './fixture.js';
import { loadRouterModel, routeWithModel, rulesRoute } from '../../apps/server/src/assistant/router.js';

type Category = 'compute' | 'memory' | 'writing' | 'planning' | 'chat' | 'reminder' | 'web_knowledge' | 'web_live' | 'news'
  | 'browser_command' | 'follow_up' | 'ads' | 'unsupported';
interface Item { key: string; category: Category; text: string; after?: string }

/** Fixed set. `after` makes the item a second turn in the conversation of that key. No request reads or controls the computer. */
export const REQUESTS: Item[] = [
  { key: 'c1', category: 'compute', text: 'كم 15 ضرب 23؟' },
  { key: 'c2', category: 'compute', text: 'احسب ١٥٪ من ٤٠٠' },
  { key: 'c3', category: 'compute', text: 'حوّل 3.75 كيلومتر إلى متر' },
  { key: 'c4', category: 'compute', text: 'What is 17% of 250?' },
  { key: 'c5', category: 'compute', text: 'Calculate 241 + 178' },
  { key: 'm1', category: 'memory', text: 'تذكر أن مدينتي المفضلة هي مسقط' },
  { key: 'm2', category: 'memory', text: 'من ذاكرتي، ما مدينتي المفضلة؟' },
  { key: 'm3', category: 'memory', text: 'Remember that my home city is Bristol.' },
  { key: 'm4', category: 'memory', text: 'From my memory, return my home city only.' },
  { key: 'w1', category: 'writing', text: 'اكتب رسالة بريد احترافية' },
  { key: 'w2', category: 'writing', text: 'Write a thank-you letter to my team' },
  { key: 'w3', category: 'writing', text: 'اكتب منشورًا قصيرًا عن افتتاح متجري' },
  { key: 'p1', category: 'planning', text: 'خطط لأسبوعي' },
  { key: 'p2', category: 'planning', text: 'Plan my week' },
  { key: 't1', category: 'chat', text: 'مرحبا' },
  { key: 't2', category: 'chat', text: 'شكرًا' },
  { key: 't3', category: 'chat', text: 'How are you?' },
  { key: 'r1', category: 'reminder', text: 'ذكرني بعد ساعة أن أشرب الماء' },
  { key: 'k1', category: 'web_knowledge', text: 'ما عاصمة اليابان؟' },
  { key: 'k2', category: 'web_knowledge', text: 'who wrote the novel One Hundred Years of Solitude' },
  { key: 'k3', category: 'web_knowledge', text: 'ما فوائد الشاي الأخضر؟' },
  { key: 'k4', category: 'web_knowledge', text: 'What is the speed of light?' },
  { key: 'k5', category: 'web_knowledge', text: 'من هو الخوارزمي؟' },
  { key: 'k6', category: 'web_knowledge', text: 'ما هو الذكاء الاصطناعي؟' },
  { key: 'k7', category: 'web_knowledge', text: 'When did the Berlin Wall fall?' },
  { key: 'l1', category: 'web_live', text: 'كم سعر الذهب اليوم؟' },
  { key: 'l2', category: 'web_live', text: 'what is the weather in London today' },
  { key: 'l3', category: 'web_live', text: 'كم سعر الدولار مقابل الجنيه المصري؟' },
  { key: 'n1', category: 'news', text: 'لخّص لي أهم أخبار اليوم' },
  { key: 'n2', category: 'news', text: "what's the news today" },
  { key: 'b1', category: 'browser_command', text: 'ابحث في ويكيبيديا عن الخوارزمي' },
  { key: 'b2', category: 'browser_command', text: 'افتح gov.uk وابحث عن passport renewal' },
  { key: 'b3', category: 'browser_command', text: 'search for python dataclasses on docs.python.org then open the first result' },
  { key: 'f1', category: 'follow_up', text: 'وكم سعره في مصر؟', after: 'l1' },
  { key: 'f2', category: 'follow_up', text: 'وكم عدد سكانها؟', after: 'k1' },
  { key: 'a1', category: 'ads', text: 'أنشئ حملة إعلانية لموقع dukestreettyres.com' },
  { key: 'a2', category: 'ads', text: 'Show my Google Ads campaigns' },
  { key: 'u1', category: 'unsupported', text: 'ارسم لي صورة قطة' },
  { key: 'u2', category: 'unsupported', text: 'شغّل أغنية لفيروز' },
  { key: 'u3', category: 'unsupported', text: 'Book me a flight to Paris next Monday' },
];
const WARM_UP = 'احسب 2 + 2';
const COLD_BROWSER = 'ما عاصمة فرنسا؟';

function argument(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1]! : fallback;
}
const reps = Number(argument('reps', '3'));
const pollMs = Number(argument('poll', '300'));
const withWeb = !process.argv.includes('--no-web');
const stamp = new Date().toISOString().replaceAll(':', '-').slice(0, 19);
const out = path.resolve(argument('out', path.join('artifacts', 'perf', '2026-11-22', `route-latency-${stamp}`)));
await mkdir(out, { recursive: true });
const rowsFile = path.join(out, 'runs.jsonl');

// 1) Routing in-process: the rules (today's decision) and the B0 shadow model on the same texts.
const routing: { key: string; text: string; rules: string; rulesMs: { p50: number | null; p95: number | null }; b0?: { route: string; confidence: number; p50: number | null } }[] = [];
const routerDir = path.resolve('artifacts', 'router');
const model = existsSync(path.join(routerDir, 'router-b0.bin')) ? await loadRouterModel(routerDir) : null;
for (const item of REQUESTS) {
  const previous = item.after ? REQUESTS.find(other => other.key === item.after)!.text : null;
  const times: number[] = [], modelTimes: number[] = [];
  let rules = '';
  for (let round = 0; round < 60; round++) { const started = performance.now(); rules = rulesRoute(item.text, previous); times.push(performance.now() - started); }
  let b0: { route: string; confidence: number; p50: number | null } | undefined;
  if (model) {
    let choice = { route: '', confidence: 0 };
    for (let round = 0; round < 30; round++) { const started = performance.now(); choice = routeWithModel(model, item.text); modelTimes.push(performance.now() - started); }
    b0 = { route: choice.route, confidence: Number(choice.confidence.toFixed(3)), p50: stats(modelTimes.slice(5)).p50 };
  }
  const settled = stats(times.slice(10));
  routing.push({ key: item.key, text: item.text, rules, rulesMs: { p50: settled.p50, p95: settled.p95 }, ...(b0 ? { b0 } : {}) });
}
await writeFile(path.join(out, 'routing.json'), JSON.stringify(routing, null, 2));

// 2) The disposable server, with the resource sampler watching this process tree.
const setStarted = Date.now();
const sampler = spawn('pwsh', ['-NoProfile', '-File', path.resolve('scripts/perf/resource-sampler.ps1'), '-RootPid', String(process.pid),
  '-OutFile', path.join(out, 'resources.jsonl'), '-IntervalSeconds', '3', '-StopFile', path.join(out, 'sampler.stop')], { stdio: 'ignore', windowsHide: true });
const marks: { at: string; mark: string }[] = [];
const mark = async (label: string) => { marks.push({ at: new Date().toISOString(), mark: label }); await writeFile(path.join(out, 'marks.json'), JSON.stringify(marks, null, 2)); };
await mark('fixture-starting');
const fixture = await startMeasureFixture({ withWeb });
await mark('fixture-ready');
const meta: Record<string, unknown> = {
  startedAt: new Date(setStarted).toISOString(), reps, pollMs, withWeb, node: process.version, platform: `${process.platform} ${process.arch}`,
  fixture: { apiReadyMs: Math.round(fixture.apiReadyMs), webReadyMs: fixture.webReadyMs === null ? null : Math.round(fixture.webReadyMs), model: 'none', windows: 'off', database: 'embedded PGlite, empty, disposable' },
  requestsSha256: createHash('sha256').update(JSON.stringify(REQUESTS)).digest('hex'),
};
const client = new FixtureClient(fixture);
let lastCreate = 0;
/** POST /api/chat/conversations allows 20 a minute; spacing creates keeps every request inside it. */
async function paced<T>(isCreate: boolean, run: () => Promise<T>): Promise<T> {
  if (isCreate) { const wait = lastCreate + 3200 - Date.now(); if (wait > 0) await delay(wait); lastCreate = Date.now(); }
  return run();
}
const record = async (row: Record<string, unknown>) => appendFile(rowsFile, `${JSON.stringify(row)}\n`, 'utf8');
try {
  await client.signIn();
  // Warm the API and its first database pages; this run is not measured.
  const warm = await paced(true, () => observeRun(client, { text: WARM_UP }, { pollMs, timeoutMs: 60_000 }));
  await record({ phase: 'warm-up', text: WARM_UP, ...warm });
  // Cold browser: the first request that starts the server's hidden browser.
  await mark('cold-browser');
  const cold = await paced(true, () => observeRun(client, { text: COLD_BROWSER }, { pollMs, timeoutMs: 150_000 }));
  await record({ phase: 'cold-browser', text: COLD_BROWSER, ...cold });
  // Proxy overhead: the same settled read through the Next dev proxy and straight to the API.
  if (withWeb) {
    const direct: number[] = [], proxied: number[] = [];
    for (let round = 0; round < 40; round++) {
      let started = performance.now();
      await client.call('GET', `/api/chat/conversations/${warm.conversationId}`, undefined, 'web'); proxied.push(performance.now() - started);
      started = performance.now();
      await client.call('GET', `/api/chat/conversations/${warm.conversationId}`); direct.push(performance.now() - started);
    }
    meta.proxy = { note: 'GET conversation detail, 40 each, first 5 dropped', direct: stats(direct.slice(5)), viaNextDev: stats(proxied.slice(5)) };
  }
  for (let rep = 1; rep <= reps; rep++) {
    await mark(`rep-${rep}`);
    const conversations = new Map<string, string>();
    for (const item of REQUESTS) {
      const conversationId = item.after ? conversations.get(item.after) : undefined;
      if (item.after && !conversationId) { await record({ phase: 'measure', rep, key: item.key, category: item.category, text: item.text, skipped: 'first turn missing' }); continue; }
      let observation: RunObservation | null = null, failure: string | null = null;
      try {
        observation = await paced(!item.after, () => observeRun(client, { text: item.text, conversationId }, { pollMs, timeoutMs: 150_000 }));
        conversations.set(item.key, observation.conversationId);
      } catch (error) { failure = error instanceof Error ? error.message : String(error); }
      await record({ phase: 'measure', rep, key: item.key, category: item.category, text: item.text, ...(observation ?? {}), ...(failure ? { failure } : {}) });
      console.log(`[rep ${rep}] ${item.key.padEnd(3)} ${(observation?.status ?? 'FAILED').padEnd(13)} settle=${observation?.settleMs ?? '-'}ms server=${observation?.serverMs ?? '-'}ms browser=${observation?.browserVisibleMs ?? '-'}  ${item.text}`);
    }
  }
  await mark('measure-done');
} finally {
  // meta.json first: nothing below may lose it.
  meta.finishedAt = new Date().toISOString();
  await writeFile(path.join(out, 'meta.json'), JSON.stringify(meta, null, 2));
  await writeFile(path.join(out, 'sampler.stop'), 'stop\n');
  await fixture.stop().catch(error => { meta.stopError = String(error); });
  await mark('fixture-stopped');
  // The sampler may already have exited; a ref'd timer keeps this await from leaving the event loop empty.
  if (sampler.exitCode === null && sampler.signalCode === null) await new Promise<void>(resolve => { const timer = setTimeout(resolve, 15_000); sampler.once('exit', () => { clearTimeout(timer); resolve(); }); });
  await writeFile(path.join(out, 'meta.json'), JSON.stringify(meta, null, 2));
}
console.log(JSON.stringify({ out, rows: rowsFile }));
