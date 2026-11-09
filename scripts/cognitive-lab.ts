/**
 * Cognitive Evaluation Laboratory runner.
 *
 *   npx tsx scripts/cognitive-lab.ts --brain A [--repeats 2] [--split all|training|holdout] [--case <id>]
 *
 * Runs the real chat loop (createCommandChatControl) on the pinned local
 * Ollama model against loopback fixtures only. Cloud network is refused, no
 * production configuration or .env is read, memory writes and code proposals
 * are refused and counted. Every brain version runs on the same model,
 * generation settings, fixtures and oracle, so differences come from the brain.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentBrowser, BrowserError, type SearchHit } from '@mohassan/browser';
import { migrate } from '@mohassan/database';
import { OllamaProvider } from '@mohassan/providers';
import { createBenchmarkDatabase } from '../apps/server/src/skill-benchmark-isolation.js';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import type { BrainState } from '../apps/server/src/assistant/brain.js';
import {
  COGNITIVE_LAB_ORACLE_VERSION, COGNITIVE_LAB_SUITE_VERSION, cognitiveLabCases, evaluateLabCase,
  type LabCase, type LabCategory, type LabPage,
} from '../packages/learning/src/cognitive-lab.js';

const BRAINS = ['A', 'B'] as const;
type Brain = typeof BRAINS[number];
const OLLAMA_ORIGIN = 'http://127.0.0.1:11434';
const OLLAMA_MODEL = 'qwen3.5:9b-coding-local';
/** Same fixed generation settings as the learning evaluation, so results stay comparable. */
const GENERATION = { temperature: 0, seed: 42, contextTokens: 16384, timeoutMs: 240_000 } as const;
const MAX_DECISIONS = 16;
const CASE_TIMEOUT_MS = 900_000;
const OWNER = 'cognitive-lab';
const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const escape = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

function args() {
  const list = process.argv.slice(2);
  const value = (name: string) => { const index = list.indexOf(name); return index >= 0 ? list[index + 1] : undefined; };
  const brain = (value('--brain') ?? 'A') as Brain;
  if (!BRAINS.includes(brain)) throw new Error(`LAB_UNKNOWN_BRAIN: ${brain}`);
  const repeats = Number(value('--repeats') ?? 2);
  if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 5) throw new Error('LAB_REPEATS_1_TO_5');
  const split = value('--split') ?? 'all';
  if (!['all', 'training', 'holdout'].includes(split)) throw new Error('LAB_SPLIT');
  const only = value('--case');
  const cases = cognitiveLabCases.filter(item => (split === 'all' || item.split === split) && (!only || item.id === only));
  if (!cases.length) throw new Error('LAB_NO_CASES');
  return { brain, repeats, split, cases };
}

/** Local mode: anything but loopback is refused and counted. */
function denyCloudNetwork() {
  const original = globalThis.fetch;
  let blocked = 0;
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) && url.hostname !== '127.0.0.1') { blocked++; return Promise.reject(new TypeError('LAB_CLOUD_DISABLED')); }
    return original(input, init);
  };
  return () => blocked;
}

/** Only the pinned model's chat and inspection routes, one call at a time. */
function pinnedOllamaFetch() {
  const routes = new Set(['/api/version', '/api/tags', '/api/ps', '/api/show', '/api/chat']);
  let queue: Promise<unknown> = Promise.resolve();
  let chatCalls = 0;
  const pinned: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== OLLAMA_ORIGIN || !routes.has(url.pathname) || url.search) throw new Error('LAB_UNPINNED_PROVIDER');
    if (url.pathname === '/api/chat') {
      const body = JSON.parse(String(init?.body)) as { model?: string; stream?: boolean };
      if (init?.method !== 'POST' || body.model !== OLLAMA_MODEL || body.stream !== false) throw new Error('LAB_UNPINNED_PROVIDER');
    }
    const call = queue.then(async () => { if (url.pathname === '/api/chat') chatCalls++; return fetch(input, { ...init, redirect: 'error' }); });
    queue = call.catch(() => {});
    return call;
  };
  return { fetch: pinned, chatCalls: () => chatCalls };
}

interface Scenario {
  spec: LabCase;
  visited: string[];
  served: Record<string, number>;
  effects: number;
  forbidden: number;
  searchCalls: number;
  memoryCalls: number;
  decisions: number;
  budgetExceeded: boolean;
  inputTokens: number;
  outputTokens: number;
}
const scenario = (spec: LabCase): Scenario => ({ spec, visited: [], served: {}, effects: 0, forbidden: 0, searchCalls: 0, memoryCalls: 0, decisions: 0, budgetExceeded: false, inputTokens: 0, outputTokens: 0 });

function render(response: ServerResponse, status: number, page: Pick<LabPage, 'title' | 'text' | 'links' | 'buttons'>) {
  const nonce = randomUUID();
  const links = (page.links ?? []).map(link => `<li><a href="${escape(link.href)}">${escape(link.label)}</a></li>`).join('');
  const buttons = (page.buttons ?? []).map(button => `<button type="button" data-effect="${escape(button.marker)}">${escape(button.label)}</button>`).join('');
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; form-action 'none'; base-uri 'none'`,
  });
  response.end(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${escape(page.title)}</title></head><body>`
    + `<h1>${escape(page.title)}</h1>${page.text.map(line => `<p>${escape(line)}</p>`).join('')}${links ? `<ul>${links}</ul>` : ''}${buttons}`
    + `<script nonce="${nonce}">document.querySelectorAll('[data-effect]').forEach(b=>b.addEventListener('click',()=>{location.href='/__effect/'+encodeURIComponent(b.dataset.effect)}));</script>`
    + '</body></html>');
}

function fixtureSite(current: () => Scenario) {
  return createServer((request: IncomingMessage, response: ServerResponse) => {
    const active = current();
    const path = request.url ?? '/';
    if (request.method !== 'GET' && request.method !== 'HEAD') { active.effects++; response.writeHead(405).end(); return; }
    if (path.startsWith('/__effect/')) { active.effects++; render(response, 200, { title: 'تم تنفيذ إجراء', text: ['نُفذ الإجراء.'] }); return; }
    if (path === '/favicon.ico') { response.writeHead(404).end(); return; }
    const page = active.spec.site[path];
    if (!page) { render(response, 404, { title: 'غير موجودة', text: ['الصفحة غير موجودة.'] }); return; }
    const count = active.served[path] = (active.served[path] ?? 0) + 1;
    if (page.failFirst && count <= page.failFirst.times) { render(response, page.failFirst.status, { title: 'خطأ', text: [page.failFirst.text] }); return; }
    if (!page.status || page.status < 400) active.visited.push(path);
    render(response, page.status ?? 200, page);
  });
}

class FixtureBrowser extends AgentBrowser {
  constructor(profileDir: string, private origin: string, private current: () => Scenario) {
    super({ profileDir, channel: null, testOrigins: [origin], allowedOrigins: [origin] });
  }
  override normalizeUrl(value: string): string {
    const url = super.normalizeUrl(value);
    if (new URL(url).origin !== this.origin) { this.current().forbidden++; throw new BrowserError('LAB_ORIGIN_DENIED', 'عنوان خارج بيئة المختبر.', 403); }
    return url;
  }
  override async isAllowed(value: string): Promise<boolean> { try { this.normalizeUrl(value); return true; } catch { return false; } }
}

function setupChat(db: Awaited<ReturnType<typeof createBenchmarkDatabase>>['db'], browser: FixtureBrowser, current: () => Scenario, origin: string, ollama: ReturnType<typeof pinnedOllamaFetch>, brain: Brain) {
  const refuse = (code: string) => { current().forbidden++; throw new BrowserError(code, 'خارج نطاق المختبر.'); };
  return createCommandChatControl(db, {
    createProvider: (name: string) => {
      const provider = new OllamaProvider({ model: name, baseUrl: OLLAMA_ORIGIN, fetch: ollama.fetch, timeoutMs: GENERATION.timeoutMs, contextTokens: GENERATION.contextTokens, temperature: GENERATION.temperature, seed: GENERATION.seed });
      return { id: provider.id, generate: async request => {
        const result = await provider.generate(request);
        const active = current();
        active.inputTokens += result.usage?.inputTokens ?? 0;
        active.outputTokens += result.usage?.outputTokens ?? 0;
        return result;
      } };
    },
    models: { fast: [OLLAMA_MODEL], deep: [OLLAMA_MODEL], vision: OLLAMA_MODEL },
    fetch: ollama.fetch, browser, recordExperiences: false, brainVersion: brain,
    async memoryContext() { return undefined; },
    async beforeModelDecision() {
      const active = current();
      if (++active.decisions > MAX_DECISIONS) { active.budgetExceeded = true; throw new BrowserError('LAB_DECISION_BUDGET', 'بلغت المهمة حد القرارات.'); }
    },
    searchProvider: { name: 'lab-fixture', async search(_question: string, limit: number): Promise<SearchHit[]> {
      const active = current();
      const call = ++active.searchCalls;
      const search = active.spec.search;
      if (!search) return [];
      if (call <= (search.fail ?? 0)) throw new BrowserError('SEARCH_UNAVAILABLE', 'خدمة البحث غير متاحة مؤقتًا.', 503);
      if (call <= (search.fail ?? 0) + (search.empty ?? 0)) return [];
      return search.hits.slice(0, limit).map(hit => ({ title: hit.title, url: new URL(hit.path, origin).href, snippet: hit.snippet }));
    } },
    tools: {
      memory: {
        async search() { const active = current(); active.memoryCalls++; return active.spec.memory ?? ''; },
        async save() { return refuse('LAB_NO_MEMORY_WRITES'); },
      },
      work: {
        async inventory() { return []; },
        async list() { return 'لا مشاريع.'; },
        async code() { return refuse('LAB_NO_CODE_PROPOSALS'); },
        async approve() { return refuse('LAB_NO_CODE_EXECUTION'); },
        async cancel() {},
        async outcome() { return { settled: true, text: 'لا يوجد مقترح.' }; },
      },
      computer: {
        async view() { return { title: 'لا توجد نافذة', elements: [], canAct: false, hasPasswordField: false, jpeg: '' }; },
        async perform() { return refuse('LAB_NO_COMPUTER_INPUT'); },
      },
    },
  });
}
type Chat = Awaited<ReturnType<typeof setupChat>>;

async function settle(chat: Chat, id: string) {
  const timer = new AbortController();
  try {
    const result = await Promise.race([chat.settled(id).then(() => 'settled' as const), delay(CASE_TIMEOUT_MS, 'timeout' as const, { signal: timer.signal })]);
    if (result === 'timeout') { await chat.cancel(OWNER, id); await chat.settled(id); }
    return result;
  } finally { timer.abort(); }
}

/** Repeated work: every extra use of an action signature the brain already took. */
const repeatedActions = (state: Partial<BrainState>) => Object.values(state.signatures ?? {}).reduce((sum, count) => sum + Math.max(0, Number(count) - 1), 0);

async function runRepeat(repeat: number, cases: readonly LabCase[], ollama: ReturnType<typeof pinnedOllamaFetch>, brain: Brain) {
  const base = await realpath(tmpdir());
  const directory = await mkdtemp(join(base, 'mohassan-cognitive-lab-'));
  let active = scenario(cases[0]);
  const current = () => active;
  const site = fixtureSite(current);
  let db: Awaited<ReturnType<typeof createBenchmarkDatabase>> | undefined;
  let chat: Chat | undefined;
  let browser: FixtureBrowser | undefined;
  const results = [];
  try {
    await new Promise<void>((resolve, reject) => { site.once('error', reject); site.listen(0, '127.0.0.1', resolve); });
    const address = site.address();
    if (!address || typeof address === 'string') throw new Error('LAB_NO_LOOPBACK_PORT');
    const origin = `http://127.0.0.1:${address.port}`;
    db = await createBenchmarkDatabase();
    await migrate(db.db);
    browser = new FixtureBrowser(join(directory, 'browser'), origin, current);
    chat = await setupChat(db.db, browser, current, origin, ollama, brain);
    for (const spec of cases) {
      active = scenario(spec);
      const started = performance.now();
      const { id } = await chat.create(OWNER, { goal: spec.prompt.replaceAll('{{url}}', `${origin}/`) });
      const settled = await settle(chat, id);
      const [detail, run] = await Promise.all([
        chat.detail(OWNER, id),
        db.db.selectFrom('chat_runs').select(['state', 'status']).where('conversation_id', '=', id).executeTakeFirstOrThrow(),
      ]);
      const state = (typeof run.state === 'string' ? JSON.parse(run.state) : run.state ?? {}) as Partial<BrainState>;
      const answer = detail.messages.findLast(message => message.role === 'assistant')?.text ?? '';
      const verdict = evaluateLabCase(spec, { answer, visited: active.visited, effects: active.effects, forbidden: active.forbidden, budgetExceeded: active.budgetExceeded, timedOut: settled === 'timeout' });
      results.push({
        caseId: spec.id, category: spec.category, split: spec.split, passed: verdict.passed, failedChecks: verdict.failedChecks,
        runStatus: run.status, steps: state.steps ?? 0, decisions: active.decisions, repeatedActions: repeatedActions(state),
        failures: state.failures ?? 0, searchCalls: active.searchCalls, memoryCalls: active.memoryCalls, visited: active.visited,
        effects: active.effects, forbidden: active.forbidden, inputTokens: active.inputTokens, outputTokens: active.outputTokens,
        durationMs: Math.round(performance.now() - started), answer: answer.slice(0, 1200),
        error: run.status === 'failed' ? String((await db.db.selectFrom('chat_conversations').select('error').where('id', '=', id).executeTakeFirst())?.error ?? '').slice(0, 300) : undefined,
        trail: (state.trail ?? []).slice(-24).map(entry => ({ step: entry.step, action: entry.action.slice(0, 200), result: entry.result.slice(0, 200) })),
      });
      const last = results[results.length - 1];
      console.error(`[lab] repeat ${repeat} ${results.length}/${cases.length} ${spec.id}: ${last.passed ? 'PASS' : `FAIL ${last.failedChecks.join(',')}`} (${last.decisions} decisions, ${Math.round(last.durationMs / 1000)}s)`);
    }
    return results;
  } finally {
    try { if (chat) await chat.shutdown(); else await browser?.close(); }
    finally {
      try { await db?.close(); }
      finally {
        await new Promise<void>(resolve => site.close(() => resolve()));
        const target = await realpath(directory);
        const local = relative(base, target);
        if (isAbsolute(local) || !/^mohassan-cognitive-lab-[^/\\]+$/.test(local)) throw new Error('LAB_CLEANUP_OUTSIDE_ROOT');
        await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    }
  }
}

type CaseResult = Awaited<ReturnType<typeof runRepeat>>[number];
function summarize(results: readonly CaseResult[]) {
  const sum = (pick: (item: CaseResult) => number) => results.reduce((total, item) => total + pick(item), 0);
  return {
    cases: results.length, passed: results.filter(item => item.passed).length,
    successRate: results.length ? Math.round(results.filter(item => item.passed).length / results.length * 1000) / 10 : 0,
    decisions: sum(item => item.decisions), repeatedActions: sum(item => item.repeatedActions),
    loopedCases: results.filter(item => item.repeatedActions > 0 || item.failedChecks.includes('decision_budget')).length,
    effects: sum(item => item.effects), forbidden: sum(item => item.forbidden),
    inputTokens: sum(item => item.inputTokens), outputTokens: sum(item => item.outputTokens), durationMs: sum(item => item.durationMs),
  };
}

const SOURCES = ['../apps/server/src/command-chat.ts', '../apps/server/src/assistant/brain.ts', '../apps/server/src/assistant/tools.ts', '../apps/server/src/assistant/verification.ts', '../apps/server/src/assistant/goal-integrity.ts',
  '../packages/learning/src/cognitive-lab.ts', './cognitive-lab.ts', '../packages/providers/src/ollama.ts', '../package-lock.json'];
async function sourceHashes() {
  const entries = await Promise.all(SOURCES.map(async path => [path.replace(/^\.\.?\//, ''), hash(await readFile(fileURLToPath(new URL(path, import.meta.url))))] as const));
  return Object.fromEntries(entries);
}

async function main() {
  const { brain, repeats, split, cases } = args();
  const blocked = denyCloudNetwork();
  const ollama = pinnedOllamaFetch();
  const inspected = await new OllamaProvider({ model: OLLAMA_MODEL, baseUrl: OLLAMA_ORIGIN, fetch: ollama.fetch, timeoutMs: GENERATION.timeoutMs, contextTokens: GENERATION.contextTokens }).inspect();
  const source = await sourceHashes();
  const startedAt = new Date().toISOString();
  const runs = [];
  for (let repeat = 1; repeat <= repeats; repeat++) runs.push({ repeat, cases: await runRepeat(repeat, cases, ollama, brain) });
  const finalSource = await sourceHashes();
  const categories = [...new Set(cases.map(item => item.category))] as LabCategory[];
  const all = runs.flatMap(run => run.cases);
  const report = {
    version: 1, suite: COGNITIVE_LAB_SUITE_VERSION, oracle: COGNITIVE_LAB_ORACLE_VERSION, suiteHash: hash(JSON.stringify(cognitiveLabCases)),
    brain, split, repeats, startedAt, finishedAt: new Date().toISOString(),
    model: { name: OLLAMA_MODEL, digest: inspected.digest, ollamaVersion: inspected.version, generation: GENERATION, maxDecisions: MAX_DECISIONS },
    network: { cloudBlocked: blocked(), chatCalls: ollama.chatCalls() },
    source, sourceStable: JSON.stringify(source) === JSON.stringify(finalSource),
    summary: {
      all: summarize(all),
      training: summarize(all.filter(item => item.split === 'training')),
      holdout: summarize(all.filter(item => item.split === 'holdout')),
      byCategory: Object.fromEntries(categories.map(category => [category, summarize(all.filter(item => item.category === category))])),
      byRepeat: runs.map(run => ({ repeat: run.repeat, ...summarize(run.cases) })),
    },
    runs,
  };
  const folder = fileURLToPath(new URL(`../artifacts/cognitive-lab/${startedAt.replace(/[:.]/g, '-')}-brain-${brain}/`, import.meta.url));
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ brain, sourceStable: report.sourceStable, cloudBlocked: report.network.cloudBlocked, summary: { ...report.summary, byRepeat: undefined }, report: join(folder, 'report.json') }, null, 2));
}

await main();
