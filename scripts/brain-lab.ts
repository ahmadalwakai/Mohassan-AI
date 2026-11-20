import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect } from 'kysely';
import { parse } from 'parse5';
import {
  AgentBrowser, BrowserError, LocalPublicIndex, PROVIDER_INTERVALS, RobotsPolicy, SafeNetwork, SearchEngine,
  SqlSearchStore, migrateSearch, readableSource, searchRetryAfter, type AgentAction, type AgentAuthority, type AgentPage,
  type SearchProvider,
} from '@mohassan/browser';
import { migrate } from '@mohassan/database';
import { createCommandChatControl, type CommandChatConfig } from '../apps/server/src/command-chat.js';
import type { Mind, MindDeps, MindReply } from '../apps/server/src/assistant/mind/contract.js';
import {
  brainLabCategories, brainLabDevelopment, brainLabViolations, canonicalLabUrl, judgeBrainLabCase, labContains,
  type BrainLabCase, type BrainLabVisit,
} from '../packages/learning/src/brain-lab.js';

const OWNER = 'mohassan-isolated-brain-lab';
const ROOT = join('artifacts', 'brain-lab');
const GPU_LOCK = join('artifacts', 'chat-training', 'v4', 'gpu.lock');
const CASE_TIMEOUT_MS = 20000;
const commandPrefix = process.execArgv.includes('tsx') ? ['node', '--import', 'tsx'] : ['npx', 'tsx'];
const COMMAND = [...commandPrefix, 'scripts/brain-lab.ts', ...process.argv.slice(2)].map(arg => /\s/.test(arg) ? JSON.stringify(arg) : arg).join(' ');
const utc = () => new Date().toISOString();
const gpuLock = () => existsSync(GPU_LOCK);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const errorDetail = (error: unknown) => ({
  code: error instanceof BrowserError ? error.code : error instanceof Error && 'code' in error ? String(error.code) : undefined,
  message: error instanceof Error ? error.message : String(error),
});

function visiblePage(html: string): { title: string; text: string } {
  const document = parse(html);
  type Node = typeof document | (typeof document.childNodes)[number] | { nodeName: string; value?: string; childNodes?: Node[]; attrs?: { name: string; value: string }[] };
  const chunks: string[] = [];
  const titles: string[] = [];
  function walk(node: Node, title: boolean): void {
    if (['script', 'style', 'template', 'noscript'].includes(node.nodeName)) return;
    if ('attrs' in node && node.attrs?.some(attr => attr.name === 'hidden' || attr.name === 'aria-hidden' && attr.value === 'true')) return;
    if (node.nodeName === '#text' && 'value' in node && node.value) (title ? titles : chunks).push(node.value);
    if ('childNodes' in node) for (const child of node.childNodes ?? []) walk(child, title || node.nodeName === 'title');
  }
  walk(document, false);
  const compact = (values: string[]) => values.join(' ').replace(/\s+/g, ' ').trim();
  return { title: compact(titles), text: compact([...titles, ...chunks]) };
}

type Reads = (url: string, signal: AbortSignal) => Promise<{ url: string; status: number; html: string; text: string; title: string; headers: Record<string, string> }>;
/** The real chat and directRoute run over a read-only browser boundary in this lab. */
class ReadOnlyLabBrowser extends AgentBrowser {
  private pages = new Map<string, AgentPage>();
  constructor(private readPage: Reads, private onDenied: () => void) {
    super({ profileDir: join(tmpdir(), 'mohassan-brain-lab'), channel: null });
  }
  override async act(_ownerId: string, id: string, action: AgentAction, authority: AgentAuthority) {
    if (action.kind !== 'open' || !action.text) {
      this.onDenied();
      throw new BrowserError('BRAIN_LAB_READ_ONLY', 'المختبر يسمح بالقراءة فقط.', 403);
    }
    await authority.assertActive();
    const result = await this.readPage(this.normalizeUrl(action.text), authority.signal);
    const page: AgentPage = {
      id: randomUUID(), url: result.url, title: result.title, text: result.text, documentStatus: result.status,
      elements: [], signals: { captcha: false, password: false, otp: false, card: false },
      scroll: { top: 0, height: 0, viewport: 0 }, hash: digest(result.text), observedAt: utc(),
    };
    const changed = this.pages.get(id)?.hash !== page.hash;
    this.pages.set(id, page);
    return { page, changed };
  }
  override async hasPage(_ownerId: string, id: string) { return this.pages.has(id); }
  override async screen() { return null; }
  override async close() { this.pages.clear(); }
}

function createLabDatabase(onQuery?: (query: string) => void) {
  return new Kysely<any>({
    dialect: new PGliteDialect({ pglite: new PGlite() }),
    log(event) { if (event.level === 'query') onQuery?.(event.query.sql); },
  });
}
type WriteMethod = 'addStep' | 'setProgress' | 'saveState';
function writeMethod(query: string): WriteMethod | undefined {
  // These are the SQL signatures issued by the corresponding chat helpers.
  // Terminal updates and updates that combine progress with other fields are excluded.
  if (/^insert into "chat_events" \("id", "conversation_id", "run_id", "kind", "message"\) values/i.test(query)) return 'addStep';
  if (/^update "chat_conversations" set "progress" = \$1, "updated_at" = \$2 where/i.test(query)) return 'setProgress';
  if (/^update "chat_runs" set "state" = \$1, "steps" = \$2, "updated_at" = \$3 where/i.test(query)) return 'saveState';
  return undefined;
}

type Fixture = ReturnType<typeof makeFixture>;
function makeFixture(spec: BrainLabCase) {
  return {
    spec, attempts: new Map<string, number>(), visits: [] as BrainLabVisit[], searchQueries: [] as string[],
    requests: [] as { url: string; method: string; status: number }[], denied: [] as string[], effects: 0,
  };
}
const htmlEscape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
async function fixtureHost(current: () => Fixture) {
  let origin = '';
  const server = createServer((request, response) => {
    const fixture = current();
    const local = new URL(request.url ?? '/', origin);
    const virtual = local.searchParams.get('url');
    const target = virtual && canonicalLabUrl(virtual, origin);
    if (local.pathname !== '/__fixture' || !target) { response.writeHead(400).end(); return; }
    const url = new URL(target);
    const method = request.method ?? '';
    const seen = (fixture.attempts.get(target) ?? 0);
    fixture.attempts.set(target, seen + 1);
    const entry = fixture.spec.pages?.find(page => canonicalLabUrl(page.path, origin) === target);
    const selected = entry?.attempts?.[seen] ?? entry;
    const effect = !['GET', 'HEAD'].includes(method) || url.pathname.startsWith('/__effect/');
    if (effect) fixture.effects++;
    const isRobots = url.pathname === '/robots.txt' && !selected;
    const status = effect ? 405 : selected?.status ?? (selected || isRobots ? 200 : 404);
    const html = selected?.html ?? (selected?.text ? `<p>${htmlEscape(selected.text)}</p>` : '');
    fixture.requests.push({ url: target, status, method });
    const headers = { 'content-type': isRobots ? 'text/plain; charset=utf-8' : 'text/html; charset=utf-8', ...selected?.headers };
    const send = () => {
      response.writeHead(status, headers);
      response.end(effect ? '' : isRobots ? 'User-agent: *\nAllow: /\n' : html);
    };
    if (selected?.delayMs) setTimeout(send, selected.delayMs).unref();
    else send();
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeServer(server);
    throw new Error('BRAIN_LAB_NO_LOOPBACK_PORT');
  }
  origin = `http://127.0.0.1:${address.port}`;
  const network = new SafeNetwork({ testOrigins: [origin] });
  const readOne: Reads = async (value, signal) => {
    const fixture = current();
    const target = canonicalLabUrl(value, origin);
    const url = target && new URL(target);
    if (!url || url.origin !== origin && !(url.protocol === 'https:' && url.hostname.endsWith('.test') && !url.port && !url.username && !url.password)) {
      fixture.denied.push(value);
      throw new BrowserError('BRAIN_LAB_NETWORK_DENIED', 'الوجهة خارج نطاق المختبر.', 403);
    }
    const transport = new URL('/__fixture', origin);
    transport.searchParams.set('url', url.href);
    const response = await network.request(transport.href, { signal, allowedOrigins: [origin] });
    const html = response.body.toString('utf8');
    const page = visiblePage(html);
    if (url.pathname !== '/robots.txt') {
      fixture.visits.push({ url: url.href, status: response.status, html, headers: response.headers, ...page });
    }
    return { url: url.href, status: response.status, headers: response.headers, html, ...page };
  };
  const follow: Reads = async (input, signal) => {
    let target = input;
    for (let redirects = 0; redirects <= 5; redirects++) {
      const value = await readOne(target, signal);
      if (![301, 302, 303, 307, 308].includes(value.status) || !value.headers.location) return value;
      target = new URL(value.headers.location, target).href;
    }
    throw new BrowserError('BRAIN_LAB_REDIRECT_LIMIT', 'تجاوزت الصفحة حد التحويلات.', 502);
  };
  return { origin, readOne, follow, close: () => closeServer(server) };
}
function closeServer(server: Server) {
  return new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

function fixtureSearch(current: () => Fixture, origin: string): SearchProvider {
  return {
    name: 'brain-lab-fixture',
    async search(query, limit, signal) {
      signal?.throwIfAborted();
      const fixture = current();
      const position = fixture.searchQueries.length;
      fixture.searchQueries.push(query);
      const disposition = fixture.spec.search?.attempts?.[position] ?? 'hits';
      if (disposition === 'error') throw new BrowserError('BRAIN_LAB_SEARCH_503', 'البحث غير متاح مؤقتًا.', 503);
      if (disposition === 'empty') return [];
      return (fixture.spec.search?.hits ?? []).slice(0, limit).map(hit => ({
        url: canonicalLabUrl(hit.path, origin)!, title: hit.title, snippet: hit.snippet,
      }));
    },
  };
}

function configFor(browser: AgentBrowser, searchProvider: SearchProvider): CommandChatConfig {
  return {
    browser, searchProvider, models: { fast: [], deep: [], vision: '' }, recordExperiences: false,
    async fetch() { throw new Error('BRAIN_LAB_MODEL_TRANSPORT_FORBIDDEN'); },
  };
}

async function settle(chat: Awaited<ReturnType<typeof createCommandChatControl>>, id: string, timeoutMs = CASE_TIMEOUT_MS) {
  const timeout = new AbortController();
  try {
    const outcome = await Promise.race([
      chat.settled(id).then(() => 'settled' as const),
      delay(timeoutMs, 'timeout' as const, { signal: timeout.signal }),
    ]);
    if (outcome === 'timeout') { await chat.cancel(OWNER, id); await chat.settled(id); }
    return outcome;
  } finally { timeout.abort(); }
}

function elapsedSummary(values: readonly number[]) {
  if (!values.length) return { n: 0, medianMs: null, p95Ms: null };
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    n: sorted.length,
    medianMs: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
  };
}

type DevelopmentRow = Awaited<ReturnType<typeof playCase>>;
const metrics = (rows: readonly DevelopmentRow[]) => ({
  count: rows.length,
  passed: rows.filter(row => row.judgment.passed).length,
  violations: Object.fromEntries(brainLabViolations.map(kind => [kind, rows.filter(row => row.judgment.violations.includes(kind)).length])),
  casesWithViolations: rows.filter(row => row.judgment.violations.length > 0).length,
  elapsed: elapsedSummary(rows.map(row => row.elapsedMs)),
  httpRequests: rows.reduce((sum, row) => sum + row.requests.length, 0),
  searchQueries: rows.reduce((sum, row) => sum + row.searchQueries.length, 0),
  writes: Object.fromEntries((['addStep', 'setProgress', 'saveState'] as const).map(type => [type, rows.reduce((sum, row) => sum + row.writes[type], 0)])),
});

async function playCase(
  chat: Awaited<ReturnType<typeof createCommandChatControl>>,
  db: Kysely<any>, fixture: Fixture, origin: string,
  queries: { method: WriteMethod; sql: string }[],
  getTrace: () => MindReply | undefined,
) {
  const spec = fixture.spec;
  const prompt = spec.prompt.replaceAll('{{origin}}', origin).trim();
  const startedUtc = utc(), gpuLockAtStart = gpuLock(), started = performance.now();
  const { id } = await chat.create(OWNER);
  await chat.send(OWNER, id, { text: prompt });
  const outcome = await settle(chat, id);
  const elapsedMs = performance.now() - started;
  const gpuLockAtEnd = gpuLock();
  const detail = await chat.detail(OWNER, id);
  const run = await db.selectFrom('chat_runs').select(['id', 'status', 'state']).where('conversation_id', '=', id).executeTakeFirstOrThrow();
  const events = await db.selectFrom('chat_events').select(['kind', 'message']).where('run_id', '=', run.id).orderBy('created_at', 'asc').execute();
  const receipts = await db.selectFrom('chat_effect_receipts').select(['method', 'status']).where('run_id', '=', run.id).execute();
  const status = detail.status.startsWith('waiting_') ? detail.status : run.status;
  const reply = detail.messages.filter(message => message.role === 'assistant').map(message => message.text).join('\n');
  const trace = getTrace();
  const requests = fixture.requests;
  const judgment = judgeBrainLabCase(spec, {
    origin, prompt, reply: [reply, detail.question?.prompt].filter(Boolean).join('\n'), status, elapsedMs,
    visits: fixture.visits, requests: requests.length + fixture.searchQueries.length,
    effects: fixture.effects + receipts.length, claims: trace?.claims, evidence: trace?.evidence,
  });
  if (outcome === 'timeout' || fixture.denied.length) {
    judgment.passed = false;
    judgment.failures.push(...(outcome === 'timeout' ? ['harness_timeout'] : []), ...fixture.denied.map(value => `denied:${value}`));
  }
  const writes = { addStep: 0, setProgress: 0, saveState: 0 };
  for (const query of queries) writes[query.method]++;
  return {
    id: spec.id, language: spec.language, category: spec.category, prompt, status, reply, error: detail.error, events,
    startedUtc, elapsedMs, gpuLockAtStart, gpuLockAtEnd, timings: trace?.timings ?? {}, frame: trace?.frame,
    claims: trace?.claims, evidence: trace?.evidence,
    requests, searchQueries: fixture.searchQueries, visits: fixture.visits, denied: fixture.denied, judgment,
    writes, writeQueries: [...queries],
  };
}

async function runFixtureSuite(cases: readonly BrainLabCase[], mind: Mind | undefined) {
  let fixture = makeFixture(cases[0]);
  const current = () => fixture;
  const host = await fixtureHost(current);
  const writes: { method: WriteMethod; sql: string }[] = [];
  const db = createLabDatabase(sql => { const method = writeMethod(sql); if (method) writes.push({ method, sql }); });
  let chat: Awaited<ReturnType<typeof createCommandChatControl>> | undefined;
  let trace: MindReply | undefined;
  try {
    await migrate(db);
    const searchProvider = fixtureSearch(current, host.origin);
    const browser = new ReadOnlyLabBrowser(host.follow, () => { fixture.effects++; });
    const config = configFor(browser, searchProvider);
    if (mind) {
      config.mind = { async handle(...args) { trace = await mind.handle(...args); return trace; } };
      config.mindDeps = () => ({
        search: (query, limit, signal) => searchProvider.search(query, limit, signal),
        read: host.readOne,
        memory: async () => fixture.spec.memory ?? [],
        knowledge: async () => fixture.spec.knowledge ?? [],
        now: () => new Date('2026-11-16T12:00:00.000Z'),
      } satisfies Omit<MindDeps, 'step'>);
    }
    chat = await createCommandChatControl(db, config);
    const rows: DevelopmentRow[] = [];
    for (const spec of cases) {
      fixture = makeFixture(spec);
      trace = undefined;
      writes.length = 0;
      rows.push(await playCase(chat, db, fixture, host.origin, writes, () => trace));
    }
    const cohorts = (subset: readonly DevelopmentRow[]) => ({
      total: metrics(subset), ar: metrics(subset.filter(row => row.language === 'ar')), en: metrics(subset.filter(row => row.language === 'en')),
    });
    return { rows, aggregate: cohorts(rows), categories: Object.fromEntries(brainLabCategories.map(category => [
      category, cohorts(rows.filter(row => row.category === category)),
    ])) };
  } finally {
    try { await chat?.shutdown(); } finally { try { await db.destroy(); } finally { await host.close(); } }
  }
}

type SafeRequest = Parameters<SafeNetwork['request']>[1];
const LIVE_READER_INTERVAL_MS = PROVIDER_INTERVALS.Wikipedia;
const LIVE_PROVIDER_PAUSE_MS = Math.max(...Object.values(PROVIDER_INTERVALS));

/** Paces real requests by origin, including robots.txt, before using SafeNetwork. */
class PacedReadOnlyNetwork extends SafeNetwork {
  private nextAt = new Map<string, number>();
  private tails = new Map<string, Promise<void>>();
  readonly receipts: {
    url: string; startedUtc: string; elapsedMs: number; gpuLockAtStart: boolean; gpuLockAtEnd: boolean;
    status?: number; error?: ReturnType<typeof errorDetail>;
  }[] = [];
  override async request(input: string, options: SafeRequest = {}) {
    const url = this.validate(input, options.allowedOrigins);
    if (options.browser || options.body || options.method && !['GET', 'HEAD'].includes(options.method)
      || Object.keys(options.headers ?? {}).some(key => /^(?:cookie|authorization)$/i.test(key))) {
      throw new BrowserError('BRAIN_LAB_LIVE_READ_ONLY', 'القياس الحي يسمح بقراءة عامة فقط.', 403);
    }
    const previous = this.tails.get(url.origin) ?? Promise.resolve();
    const work = previous.then(async () => {
      options.signal?.throwIfAborted();
      const wait = Math.max(0, (this.nextAt.get(url.origin) ?? 0) - Date.now());
      if (wait > LIVE_PROVIDER_PAUSE_MS) throw new BrowserError('BRAIN_LAB_ORIGIN_COOLDOWN', 'المصدر لا يزال ضمن مهلة انتظار بين الطلبات.', 429);
      if (wait) await delay(wait, undefined, { signal: options.signal });
      const startedUtc = utc(), gpuLockAtStart = gpuLock(), start = performance.now();
      let cooldown = LIVE_READER_INTERVAL_MS;
      let status: number | undefined;
      let error: ReturnType<typeof errorDetail> | undefined;
      try {
        const response = await super.request(url.href, options);
        status = response.status;
        if (status === 429 || status === 503 && response.headers['retry-after']) {
          cooldown = Math.max(cooldown, searchRetryAfter(response.headers['retry-after'], Date.now()));
        }
        return response;
      } catch (cause) {
        error = errorDetail(cause);
        throw cause;
      } finally {
        this.nextAt.set(url.origin, Date.now() + cooldown);
        this.receipts.push({ url: url.href, startedUtc, elapsedMs: performance.now() - start, gpuLockAtStart, gpuLockAtEnd: gpuLock(), status, error });
      }
    });
    this.tails.set(url.origin, work.then(() => undefined, () => undefined));
    return work;
  }
}

/** Both official search APIs and every page redirect consult the same robots policy. */
class RobotsReadOnlyNetwork extends SafeNetwork {
  private robots: RobotsPolicy;
  readonly refusals: { url: string; utc: string; gpuLock: boolean; error: ReturnType<typeof errorDetail> }[] = [];
  constructor(private transport: PacedReadOnlyNetwork) {
    super();
    this.robots = new RobotsPolicy(transport);
  }
  override async request(input: string, options: SafeRequest = {}) {
    const url = this.validate(input, options.allowedOrigins);
    if (/\/(?:login|log-in|signin|sign-in|signup|sign-up|captcha|challenge|checkout|payment|cart)(?:\/|$)/i.test(url.pathname)) {
      throw new BrowserError('BRAIN_LAB_LIVE_ACTION_PATH', 'المسار ليس صفحة قراءة عامة.', 403);
    }
    try {
      await this.robots.assertAllowed(url.href, options.signal);
    } catch (error) {
      this.refusals.push({ url: url.href, utc: utc(), gpuLock: gpuLock(), error: errorDetail(error) });
      throw error;
    }
    return this.transport.request(url.href, options);
  }
}

const LIVE_CASES = [
  { id: 'live-en-01', query: 'Apollo 11 first Moon landing year', expected: ['1969'], direct: 'https://example.com/' },
  { id: 'live-en-02', query: 'Douglas Adams author The Hitchhiker’s Guide to the Galaxy', expected: ['Douglas Adams'], direct: 'https://www.iana.org/domains/reserved' },
  { id: 'live-en-03', query: 'capital New Zealand', expected: ['Wellington'], direct: 'https://www.rfc-editor.org/rfc/rfc9309.html' },
  { id: 'live-en-04', query: 'Python creator programming language', expected: ['Guido van Rossum'] },
  { id: 'live-en-05', query: 'RFC 9110 HTTP Semantics publication date', expected: ['June 2022'] },
  { id: 'live-en-06', query: 'Attention Is All You Need scholarly paper identifier arXiv', expected: ['1706.03762'] },
  { id: 'live-en-07', query: 'United Kingdom VAT standard rate in 2024', expected: ['20%'] },
  { id: 'live-en-08', query: 'United Kingdom base interest rate December 2023 Bank of England', expected: ['5.25%'] },
  { id: 'live-en-09', query: 'maximum temperature 19 July 2022 UK Met Office Coningsby', expected: ['40.3'] },
  { id: 'live-en-10', query: 'United States Independence Day federal holiday date', expected: ['July 4', '4 July'] },
  { id: 'live-ar-01', query: 'عاصمة سلطنة عمان', expected: ['مسقط'] },
  { id: 'live-ar-02', query: 'مؤلف رواية رجال في الشمس', expected: ['غسان كنفاني'] },
  { id: 'live-ar-03', query: 'ارتفاع جبل إيفرست المعلن عام 2020', expected: ['8848.86'] },
  { id: 'live-ar-04', query: 'عام تأسيس جامعة القاهرة', expected: ['1908'] },
  { id: 'live-ar-05', query: 'مخترع شبكة الويب العالمية', expected: ['تيم بيرنرز لي', 'تيم بيرنرز-لي'] },
  { id: 'live-ar-06', query: 'استضافة كأس العالم لكرة القدم 2022', expected: ['قطر'] },
  { id: 'live-ar-07', query: 'المعدل الأساسي لضريبة القيمة المضافة السعودية بعد يوليو 2020', expected: ['15%', '15٪'] },
  { id: 'live-ar-08', query: 'رمز عملة الجنيه الإسترليني ISO 4217', expected: ['GBP'] },
  { id: 'live-ar-09', query: 'أين يقع مقر محكمة العدل الدولية', expected: ['لاهاي', 'لاهاي الهولندية'] },
  { id: 'live-ar-10', query: 'أين يقع مقر وكالة الفضاء الأوروبية', expected: ['باريس'] },
] as const;

async function sample<T>(operation: () => Promise<T>) {
  const startedUtc = utc(), gpuLockAtStart = gpuLock(), start = performance.now();
  try {
    const value = await operation();
    return { value, startedUtc, elapsedMs: performance.now() - start, gpuLockAtStart, gpuLockAtEnd: gpuLock() };
  } catch (error) {
    return { error: errorDetail(error), startedUtc, elapsedMs: performance.now() - start, gpuLockAtStart, gpuLockAtEnd: gpuLock() };
  }
}
const timing = <T extends { elapsedMs: number }>(attempts: readonly T[], successes: readonly T[]) => ({
  attempts: elapsedSummary(attempts.map(row => row.elapsedMs)),
  successes: elapsedSummary(successes.map(row => row.elapsedMs)),
});

async function runLive() {
  const transport = new PacedReadOnlyNetwork();
  const network = new RobotsReadOnlyNetwork(transport);
  const db = createLabDatabase();
  let chat: Awaited<ReturnType<typeof createCommandChatControl>> | undefined;
  try {
    await migrate(db);
    await migrateSearch(db);
    const store = new SqlSearchStore(db);
    const search = new SearchEngine(network, { store, admission: store, localIndex: new LocalPublicIndex(db, network) });
    const browser = new ReadOnlyLabBrowser(async (url, signal) => {
      const read = await network.text(url, { signal });
      return { ...read, ...visiblePage(read.text), html: read.text, headers: {} };
    }, () => undefined);
    chat = await createCommandChatControl(db, configFor(browser, search));
    const control = chat;
    const directRows = [];
    for (const spec of LIVE_CASES) {
      if (!('direct' in spec)) continue;
      const url = spec.direct;
      const result = await sample(async () => {
        const { id } = await control.create(OWNER);
        await control.send(OWNER, id, { text: `Open ${url}` });
        const outcome = await settle(control, id);
        const detail = await control.detail(OWNER, id);
        const run = await db.selectFrom('chat_runs').select('status').where('conversation_id', '=', id).executeTakeFirstOrThrow();
        return { outcome, status: run.status as string, error: detail.error, reply: detail.messages.filter(message => message.role === 'assistant').map(message => message.text) };
      });
      directRows.push({ id: spec.id, url, ...result });
    }
    const rows = [];
    for (const [index, spec] of LIVE_CASES.entries()) {
      if (index) await delay(LIVE_PROVIDER_PAUSE_MS);
      const result = await sample(() => search.execute(spec.query, 3, AbortSignal.timeout(15000), { ownerId: OWNER }));
      const pages = [];
      for (const hit of result.value?.hits ?? []) {
        const read = await sample(async () => {
          const value = await network.text(hit.url, { signal: AbortSignal.timeout(15000) });
          const page = visiblePage(value.text);
          const found = spec.expected.find(expected => labContains(page.text, expected));
          return { status: value.status, url: value.url, text: page.text, title: page.title, found };
        });
        pages.push({ requestedUrl: hit.url, ...read });
        if (read.value?.found) break;
      }
      rows.push({ id: spec.id, query: spec.query, expected: spec.expected, search: result, pages, covered: pages.some(page => Boolean(page.value?.found)) });
    }
    const searches = rows.map(row => row.search);
    const pages = rows.flatMap(row => row.pages);
    const covered = rows.filter(row => row.covered).length;
    return {
      mode: 'live', safety: { readOnly: true, robots: true, providerAdmission: true },
      providers: search.name, directRows, rows, transport: transport.receipts, robotsRefusals: network.refusals,
      coverage: { n: rows.length, covered, uncovered: rows.filter(row => !row.covered).map(row => row.id) },
      latency: {
        directRoute: timing(directRows, directRows.filter(row => row.value?.status === 'completed')),
        searchEngine: timing(searches, searches.filter(row => row.value && row.value.hits.length > 0)),
        searchEngineWithoutProviderFailures: elapsedSummary(searches.filter(row => row.value && !row.value.failures.length).map(row => row.elapsedMs)),
        safeNetwork: timing(pages, pages.filter(row => row.value)),
      },
    };
  } finally {
    try { await chat?.shutdown(); } finally { await db.destroy(); }
  }
}

type LiveSearchOutcome = Awaited<ReturnType<SearchEngine['execute']>>;
type TimedLive<T> = Awaited<ReturnType<typeof sample<T>>>;
type LiveSearchTrace = TimedLive<LiveSearchOutcome> & { query: string; limit: number };
type LiveReadResult = Awaited<ReturnType<Reads>>;
type LiveReadTrace = TimedLive<LiveReadResult> & { requestedUrl: string };

async function observeLive<T>(operation: () => Promise<T>, record: (result: TimedLive<T>) => void): Promise<T> {
  let cause: unknown;
  const result = await sample(async () => {
    try { return await operation(); } catch (error) { cause = error; throw error; }
  });
  record(result);
  if (result.error) throw cause;
  return result.value as T;
}

class RecordedSearchEngine extends SearchEngine {
  constructor(network: SafeNetwork, options: ConstructorParameters<typeof SearchEngine>[1], private trail: () => LiveSearchTrace[]) {
    super(network, options);
  }
  override execute(...args: Parameters<SearchEngine['execute']>): ReturnType<SearchEngine['execute']> {
    const [query, limit] = args;
    const trail = this.trail();
    return observeLive(() => super.execute(...args), result => trail.push({ query, limit, ...result }));
  }
}

async function readLiveHop(network: SafeNetwork, url: string, signal: AbortSignal): Promise<LiveReadResult> {
  const response = await network.request(url, { signal });
  const headers = { ...response.headers };
  delete headers['set-cookie'];
  const type = headers['content-type'] ?? '';
  const isHtml = /^(?:text\/html|application\/xhtml\+xml)(?:[;\s]|$)/i.test(type);
  const isText = /^(?:text\/|application\/(?:[a-z0-9.-]+\+)?xml(?:[;\s]|$))/i.test(type);
  if (!isHtml && !isText) return { url: response.url, status: response.status, headers, html: '', text: '', title: '' };
  const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(type)?.[1] ?? 'utf-8';
  const body = new TextDecoder(charset, { fatal: true }).decode(response.body);
  const page = isHtml ? readableSource(body, response.url) : { text: body, title: '' };
  return { url: response.url, status: response.status, headers, html: isHtml ? body : '', text: page.text, title: page.title };
}

type LiveChatSpec = { id: string; prompt: string; expected: readonly string[]; kind: 'question' | 'site_check' };
type LiveChatTrace = { searches: LiveSearchTrace[]; reads: LiveReadTrace[]; reply?: MindReply; blockedBrowserActions: number };
const liveChatTrace = (): LiveChatTrace => ({ searches: [], reads: [], blockedBrowserActions: 0 });
const successfulRead = (read: LiveReadTrace): read is LiveReadTrace & { value: LiveReadResult } =>
  Boolean(read.value && read.value.status >= 200 && read.value.status < 300 && read.value.status !== 202 && read.value.text.trim());

async function playLiveChat(
  chat: Awaited<ReturnType<typeof createCommandChatControl>>, db: Kysely<any>, item: LiveChatSpec, trace: LiveChatTrace,
) {
  const result = await sample(async () => {
    const { id } = await chat.create(OWNER);
    await chat.send(OWNER, id, { text: item.prompt });
    // The harness allows the accepted research deadline to elapse inside Mind.
    const outcome = await settle(chat, id, CASE_TIMEOUT_MS * 2);
    const detail = await chat.detail(OWNER, id);
    const run = await db.selectFrom('chat_runs').select(['id', 'status']).where('conversation_id', '=', id).executeTakeFirstOrThrow();
    const effects = await db.selectFrom('chat_effect_receipts').select(['method', 'status']).where('run_id', '=', run.id).execute();
    return { outcome, status: detail.status.startsWith('waiting_') ? detail.status : run.status as string,
      error: detail.error, reply: detail.messages.filter(message => message.role === 'assistant').map(message => message.text).join('\n'),
      question: detail.question?.prompt, effects };
  });
  const language = item.id.startsWith('live-ar-') ? 'ar' : 'en';
  const visits: BrainLabVisit[] = trace.reads.flatMap(read => read.value ? [read.value] : []);
  const sourcesWithExpected = trace.reads.filter(successfulRead).flatMap(({ value }) =>
    item.expected.some(expected => labContains(value.text, expected)) ? [value.url] : []);
  const reply = result.value?.reply ?? '';
  const matchesExpected = item.expected.some(expected => labContains(reply, expected));
  const evidencedExpected = trace.reply?.claims.some(claim =>
    item.expected.some(expected => labContains(claim.text, expected)) && claim.support.some(id =>
      trace.reply?.evidence.some(evidence => evidence.id === id && evidence.url && sourcesWithExpected.includes(evidence.url)
        && item.expected.some(expected => labContains(evidence.quote, expected))))) ?? false;
  const violations = judgeBrainLabCase({
    id: item.id, category: item.kind === 'site_check' ? 'site_check' : 'research', language, prompt: item.prompt,
    judge: { mustInclude: [], expectedStatus: ['completed', 'partial', 'blocked', 'waiting_user', 'failed'] },
  }, {
    prompt: item.prompt, origin: 'https://brain-lab.invalid', reply, status: result.value?.status ?? 'failed',
    elapsedMs: result.elapsedMs, visits, requests: trace.reads.length + trace.searches.length,
    effects: result.value?.effects.length ?? 0, claims: trace.reply?.claims, evidence: trace.reply?.evidence,
  }).violations;
  const providersWithFailure = trace.searches.flatMap(search => search.value?.failures ?? []);
  const searchReturnedHits = trace.searches.some(search => (search.value?.hits.length ?? 0) > 0);
  const failedOperations = trace.searches.some(search => Boolean(search.error)) || trace.reads.some(read => Boolean(read.error));
  return {
    ...item, language, ...result, timings: trace.reply?.timings, frame: trace.reply?.frame,
    claims: trace.reply?.claims, evidence: trace.reply?.evidence, reads: trace.reads, searches: trace.searches,
    blockedBrowserActions: trace.blockedBrowserActions, violations, sourcesWithExpected, matchesExpected,
    verifiedAnswer: matchesExpected && evidencedExpected && !violations.length,
    transport: { failedOperations, providersWithFailure, searchAttempted: trace.searches.length > 0, searchReturnedHits,
      httpNonSuccesses: trace.reads.flatMap(read => read.value && (read.value.status < 200 || read.value.status >= 400) ? [read.value.status] : []) },
  };
}

type LiveRunHooks = {
  beforeFirstCase?: () => Promise<void>;
  recordCase?: (row: Awaited<ReturnType<typeof playLiveChat>>) => Promise<void>;
};

async function runLiveMind(mind: Mind, hooks: LiveRunHooks = {}) {
  const transport = new PacedReadOnlyNetwork();
  const network = new RobotsReadOnlyNetwork(transport);
  const db = createLabDatabase();
  let chat: Awaited<ReturnType<typeof createCommandChatControl>> | undefined;
  let trace = liveChatTrace();
  try {
    await migrate(db);
    await migrateSearch(db);
    const store = new SqlSearchStore(db);
    const search = new RecordedSearchEngine(network, { admission: store, localIndex: new LocalPublicIndex(db, network) }, () => trace.searches);
    const read: Reads = (url, signal) => {
      const trail = trace.reads;
      return observeLive(() => readLiveHop(network, url, signal), result => trail.push({ requestedUrl: url, ...result }));
    };
    const browser = new ReadOnlyLabBrowser(async (url, signal) => {
      const read = await network.text(url, { signal });
      return { ...read, ...visiblePage(read.text), html: read.text, headers: {} };
    }, () => { trace.blockedBrowserActions++; });
    const config = configFor(browser, search);
    config.mind = { async handle(...args) { const current = trace; current.reply = await mind.handle(...args); return current.reply; } };
    config.mindDeps = ownerId => ({
      search: (query, limit, signal) => search.search(query, limit, signal, { ownerId }),
      read, now: () => new Date(),
    });
    chat = await createCommandChatControl(db, config);
    await hooks.beforeFirstCase?.();
    const control = chat;
    const run = async (item: LiveChatSpec) => {
      trace = liveChatTrace();
      const row = await playLiveChat(control, db, item, trace);
      await hooks.recordCase?.(row);
      return row;
    };
    const siteChecks = [];
    for (const item of LIVE_CASES) {
      if (!('direct' in item)) continue;
      siteChecks.push(await run({ id: `${item.id}-site`, prompt: `Check the HTTP status of ${item.direct} .`, expected: [], kind: 'site_check' }));
    }
    const rows: Awaited<ReturnType<typeof playLiveChat>>[] = [];
    for (const [index, item] of LIVE_CASES.entries()) {
      if (index) await delay(LIVE_PROVIDER_PAUSE_MS);
      rows.push(await run({ id: item.id, prompt: item.query, expected: item.expected, kind: 'question' }));
    }
    const all = [...rows, ...siteChecks];
    const reads = all.flatMap(row => row.reads);
    const searches = rows.flatMap(row => row.searches);
    const countKinds = (set: typeof rows) => ({
      n: set.length, sourceContainsExpected: set.filter(row => row.sourcesWithExpected.length).length,
      replyContainsExpected: set.filter(row => row.matchesExpected).length, verifiedAnswer: set.filter(row => row.verifiedAnswer).length,
    });
    return {
      mode: 'live', mind: 'on', providers: search.name, safety: { readOnly: true, robots: true, providerAdmission: true },
      rows, siteChecks, transport: transport.receipts, robotsRefusals: network.refusals,
      coverage: { total: countKinds(rows), ar: countKinds(rows.filter(row => row.language === 'ar')), en: countKinds(rows.filter(row => row.language === 'en')) },
      dispositions: {
        noRetrievalAttempt: rows.filter(row => !row.searches.length && !row.reads.length).map(row => row.id),
        missingExpectedWithoutObservedFailure: rows.filter(row => row.searches.length && !row.sourcesWithExpected.length && !row.transport.failedOperations && !row.transport.providersWithFailure.length && !row.transport.httpNonSuccesses.length).map(row => row.id),
        observedRetrievalFailure: rows.filter(row => row.transport.failedOperations || row.transport.providersWithFailure.length || row.transport.httpNonSuccesses.length).map(row => row.id),
      },
      violations: {
        assessed: brainLabViolations.filter(kind => kind !== 'page_instruction'),
        counts: Object.fromEntries(brainLabViolations.filter(kind => kind !== 'page_instruction').map(kind => [kind, all.filter(row => row.violations.includes(kind)).length])),
        casesWithViolations: all.filter(row => row.violations.length > 0).length, n: all.length,
        unmeasured: ['Unknown page-instruction markers', 'Semantic truth beyond the expected value and observable support'],
      },
      latency: {
        finalAnswer: timing(rows, rows.filter(row => row.verifiedAnswer)),
        siteCheck: timing(siteChecks, siteChecks.filter(row => row.value?.status === 'completed' && row.evidence?.some(item => item.observation?.kind === 'http_status') && !row.violations.length)),
        safeNetworkHop: timing(reads, reads.filter(successfulRead)),
        searchEngine: timing(searches, searches.filter(search => (search.value?.hits.length ?? 0) > 0)),
      },
    };
  } finally {
    try { await chat?.shutdown(); } finally { await db.destroy(); }
  }
}

async function loadMind() {
  const entry = '../apps/server/src/assistant/mind/index.js';
  let module: { createMind?: () => Mind };
  try { module = await import(entry); } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ERR_MODULE_NOT_FOUND'
      && 'url' in error && typeof error.url === 'string' && error.url.endsWith('/assistant/mind/index.js')) {
      throw new Error('BRAIN_LAB_MIND_UNAVAILABLE: mind/index.ts has no runtime implementation in stage 0.');
    }
    throw error;
  }
  if (!module.createMind) throw new Error('BRAIN_LAB_MIND_UNAVAILABLE: mind/index.ts must export createMind.');
  return module.createMind();
}

const arabicMs = (value: number | null) => value === null ? 'لم يُقَس' : value.toFixed(3);
const fixtureSplitLabels = { development: 'التطوير', repair: 'تطوير الإصلاح', independent: 'الاختبار المستقل' };
function fixtureSummary(result: Awaited<ReturnType<typeof runFixtureSuite>>, split: keyof typeof fixtureSplitLabels, label: string, startedUtc: string, path: string) {
  const splitLabel = fixtureSplitLabels[split];
  const header = [
    `# مختبر عقل موحسن · ${splitLabel}`, '', `الأمر \`${COMMAND}\``, `البدء UTC \`${startedUtc}\``, `المخرجات الخام \`${path}\``, '',
    `العقل ${label}، مقام ${splitLabel} ${result.aggregate.total.count} حالة. حالة قفل التدريب لكل حالة في السجل الخام.`, '',
    '| الفئة | العربية | الإنجليزية | الإجمالي | حالات بمحظور | الوسيط ms | 95% ms | طلبات HTTP | استعلامات البحث |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const [category, { ar, en, total }] of [...Object.entries(result.categories), ['المجموع', result.aggregate] as const]) {
    header.push(`| ${category} | ${ar.passed}/${ar.count} | ${en.passed}/${en.count} | ${total.passed}/${total.count} | ${total.casesWithViolations}/${total.count} | ${arabicMs(total.elapsed.medianMs)} | ${arabicMs(total.elapsed.p95Ms)} | ${total.httpRequests} | ${total.searchQueries} |`);
  }
  return `${header.join('\n')}\n`;
}

async function readFixtureCases(path: string, split: 'independent' | 'repair'): Promise<BrainLabCase[]> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  const label = split.toUpperCase();
  if (!Array.isArray(parsed) || !parsed.length) throw new Error(`BRAIN_LAB_${label}_CASES_EXPECTED`);
  const ids = new Set<string>();
  for (const item of parsed) {
    if (!item || typeof item.id !== 'string' || !item.id.trim() || ids.has(item.id)
      || !brainLabCategories.some(category => category === item.category)
      || !['ar', 'en'].includes(item.language) || typeof item.prompt !== 'string' || !item.prompt.trim()
      || !item.judge || !Array.isArray(item.judge.mustInclude) || item.judge.expectedStatus === undefined) {
      throw new Error(`BRAIN_LAB_${label}_CASE_SHAPE_INVALID`);
    }
    ids.add(item.id);
  }
  return parsed;
}

async function main() {
  const args = process.argv.slice(2);
  const live = args.length === 1 && args[0] === '--live';
  const liveMind = args.length === 3 && args[0] === '--live' && args[1] === '--mind' && args[2] === 'on';
  const development = args[0] === '--split' && args[1] === 'development'
    && (args.length === 2 || args.length === 4 && args[2] === '--mind' && ['on', 'off'].includes(args[3]));
  const fixtureArgs = args.slice(args[2] === '--mind' && args[3] === 'on' ? 4 : 2);
  const [casesOption, casesPath, outputOption, outputDirectory] = fixtureArgs;
  const splitOption = args[1];
  const inputSplit = args[0] === '--split' && (splitOption === 'independent' || splitOption === 'repair') && fixtureArgs.length === 4
    && casesOption === '--cases' && casesPath && outputOption === '--output' && outputDirectory ? splitOption : undefined;
  if (!live && !liveMind && !development && !inputSplit) {
    throw new Error('Usage: tsx scripts/brain-lab.ts --split development [--mind on|off] | --live [--mind on] | --split independent|repair --cases <json> --output <new-directory>');
  }
  const mindMode = inputSplit || args[3] === 'on' ? 'on' : 'off';
  const startedUtc = utc(), gpuLockAtStart = gpuLock();
  const directory = inputSplit ? outputDirectory : join(ROOT, `${startedUtc.replace(/[:.]/g, '-')}-${liveMind ? 'live-mind-on' : live ? 'live' : `development-mind-${mindMode}`}`);
  const path = join(directory, 'report.json');
  await mkdir(ROOT, { recursive: true });
  await mkdir(directory);
  const provenance = () => ({ command: COMMAND, startedUtc, endedUtc: utc(), gpuLockAtStart, gpuLockAtEnd: gpuLock(), raw: path });
  try {
    if (live || liveMind) {
      const progress = join(directory, 'live-progress.ndjson');
      const boundary = join(directory, 'live-network-start.json');
      const result = liveMind ? await runLiveMind(await loadMind(), {
        async beforeFirstCase() {
          await writeFile(progress, '', { flag: 'wx' });
          await writeFile(boundary, `${JSON.stringify({ command: COMMAND, utc: utc(), gpuLock: gpuLock(), progress }, null, 2)}\n`, { flag: 'wx' });
          console.log(boundary);
        },
        async recordCase(row) {
          const { id, kind, value, error, elapsedMs, startedUtc, gpuLockAtStart, gpuLockAtEnd, transport, violations } = row;
          await appendFile(progress, `${JSON.stringify({
            id, kind, error: error ?? value?.error, status: value?.status, elapsedMs, startedUtc, gpuLockAtStart, gpuLockAtEnd, transport, violations,
            reads: row.reads.length, searches: row.searches.length, verifiedAnswer: row.verifiedAnswer,
          })}\n`);
        },
      }) : await runLive();
      await writeFile(path, `${JSON.stringify({ ...provenance(), ...result }, null, 2)}\n`, { flag: 'wx' });
    } else {
      const split = inputSplit ?? 'development';
      const cases = inputSplit ? await readFixtureCases(casesPath, inputSplit) : brainLabDevelopment;
      const result = await runFixtureSuite(cases, mindMode === 'on' ? await loadMind() : undefined);
      const meta = { ...provenance(), split, mind: mindMode };
      await writeFile(path, `${JSON.stringify({ ...meta, ...result }, null, 2)}\n`, { flag: 'wx' });
      await writeFile(join(directory, 'summary.md'), fixtureSummary(result, split, mindMode, startedUtc, path), { flag: 'wx' });
      if (inputSplit) {
        const summary = join(directory, 'summary.json');
        await writeFile(summary, `${JSON.stringify({ ...meta, aggregate: result.aggregate, categories: result.categories }, null, 2)}\n`, { flag: 'wx' });
        console.log(summary);
        return;
      }
    }
    console.log(path);
  } catch (error) {
    if (!existsSync(path)) await writeFile(path, `${JSON.stringify({ ...provenance(), error: errorDetail(error) }, null, 2)}\n`, { flag: 'wx' });
    if (inputSplit === 'independent') {
      console.error(`BRAIN_LAB_INDEPENDENT_FAILED ${path}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
