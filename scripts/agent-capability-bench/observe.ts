import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { BrowserError, readableSource, type AgentBrowser, type AgentPage, type SearchProvider } from '@mohassan/browser';
import type { ChatConversation } from '@mohassan/contracts';
import { createDatabase, migrate } from '@mohassan/database';
import { describeDesktopCommand, parseDesktopCommand, type DesktopOutcome } from '@mohassan/desktop';
import { createMemoryControl, memoryMigration } from '@mohassan/memory';
import { migrateAuth } from '../../apps/server/src/auth.js';
import type { BrainState, TrailEntry } from '../../apps/server/src/assistant/brain.js';
import { judge } from '../../apps/server/src/assistant/judge.js';
import { withoutFigures } from '../../apps/server/src/assistant/readable-page.js';
import { createSkillReader } from '../../apps/server/src/assistant/skill-reader.js';
import { createAssistantTools, type AssistantTools } from '../../apps/server/src/assistant/tools.js';
import { createCommandChatControl, type CommandChatConfig } from '../../apps/server/src/command-chat.js';
import { createDocumentControl, migrateDocuments } from '../../apps/server/src/documents.js';

const text = z.string().min(1);
const fixtureUrl = z.url({ protocol: /^https?$/u }).refine(value => {
  if (!URL.canParse(value)) return false;
  const { username, password } = new URL(value);
  return !username && !password;
});
const recordedSearch = z.strictObject({ query: text, results: z.array(z.strictObject({ title: text, url: fixtureUrl, snippet: z.string() })).max(30) });
const pageElement = z.strictObject({ ref: text, role: text, label: z.string(), href: fixtureUrl.optional(), inViewport: z.boolean() });
const recordedPage = z.strictObject({
  url: fixtureUrl, status: z.number().int().min(200).max(599).optional(), title: text.optional(), text: z.string().optional(),
  html: z.string().max(524_288).optional(), robotsDenied: z.boolean().optional(), elements: z.array(pageElement).max(60).optional(),
}).refine(page => Boolean(page.html) !== Boolean(page.title && page.text !== undefined), 'Supply HTML or a title and recorded readable text.');
const recordedDesktop = z.strictObject({
  command: z.object({ kind: text }).catchall(z.union([z.string(), z.number(), z.boolean(), z.null()])), approved: z.boolean(),
  outcome: z.strictObject({ status: z.enum(['completed', 'partial', 'blocked', 'needs_approval']), text: text,
    approval: z.strictObject({ prompt: text, detail: text, label: text }).optional() }),
}).refine(item => (item.outcome.status === 'needs_approval') === Boolean(item.outcome.approval));

export const caseFixtureSchema = z.strictObject({
  searches: z.array(recordedSearch).max(60).optional(), pages: z.array(recordedPage).max(60).optional(),
  memories: z.array(z.strictObject({ title: text.max(80), content: text.max(4000) })).max(40).optional(),
  knowledge: z.array(z.strictObject({ title: text.max(300), text: text.max(20_000), source: text.max(500) })).max(40).optional(),
  desktop: z.array(recordedDesktop).max(20).optional(),
  ads: z.strictObject({ status: text, report: text.optional() }).optional(),
  skills: z.array(z.strictObject({ id: text, slug: text, name: text, description: text, category: text,
    version: text, contentHash: z.string().regex(/^[a-f0-9]{64}$/u), instructions: text })).max(80).optional(),
  member: z.boolean().optional(),
}).superRefine((fixture, context) => {
  const distinct = [
    { key: 'searches', values: (fixture.searches ?? []).map(search => normalizeQuery(search.query)) },
    { key: 'pages', values: (fixture.pages ?? []).map(page => URL.canParse(page.url) ? new URL(page.url).href : page.url) },
    { key: 'desktop', values: (fixture.desktop ?? []).map(({ command, approved }) => JSON.stringify([approved, Object.entries(command).sort(([left], [right]) => left.localeCompare(right))])) },
    { key: 'skills', values: (fixture.skills ?? []).map(skill => skill.id) },
  ];
  for (const { key, values } of distinct) {
    if (new Set(values).size !== values.length) context.addIssue({ code: 'custom', path: [key], message: 'Fixture lookup keys must be unique.' });
  }
});

export type CapabilityCaseFixture = z.infer<typeof caseFixtureSchema>;
export interface CapabilityTurnInput {
  text: string;
  fields?: Readonly<Record<string, string>>;
  answerQuestion?: boolean;
  approve?: boolean;
}
export interface CapabilityCaseInput {
  id: string;
  fixture?: CapabilityCaseFixture;
  turns: readonly CapabilityTurnInput[];
}
export interface CapabilityToolCall {
  tool: string;
  argument?: string;
  outcome: 'recorded' | 'failed' | 'missing_fixture' | 'denied';
}
export interface CapabilityTurnObservation {
  answer: string;
  questionCount: number;
  questionFields: string[];
  status: string | null;
  conversationStatus: string | null;
  source: string | null;
  operation: string | null;
  understanding: string | null;
  route: string | null;
  handler: string | null;
  routeReason: string | null;
  steps: number;
  toolCalls: CapabilityToolCall[];
  boundaryCalls: CapabilityToolCall[];
  planSteps: { tool: string; state: string }[];
  verdict: string | null;
  verification: {
    status: NonNullable<NonNullable<ChatConversation['run']>['verification']>['status'] | null;
    evidence: string[];
    independentEvidence: string[];
    reviewStatus: string | null;
  };
  fixtureMisses: number;
  modelCalls: number;
  unexpectedEffects: number;
  latencyMs: number;
  error?: 'fixture_setup' | 'dispatch' | 'missing_question' | 'missing_approval' | 'timeout' | 'observation' | 'chat_failed';
}
export interface CapabilityCaseObservation {
  setupMs: number;
  turns: CapabilityTurnObservation[];
}

type ObserveCase = (item: CapabilityCaseInput) => Promise<CapabilityCaseObservation>;
type RecordCall = (tool: string, outcome: CapabilityToolCall['outcome'], argument?: string) => void;
type Database = Awaited<ReturnType<typeof createDatabase>>;
type Documents = ReturnType<typeof createDocumentControl>;
const normalizeQuery = (query: string) => query.normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase();
const fixturesOnly = () => new BrowserError('CAPABILITY_FIXTURE_ONLY', 'This action has no authorized fixture.', 403);
const nowIso = () => new Date().toISOString();
let observerActive = false;

function makeRecordedWeb(fixture: CapabilityCaseFixture, record: RecordCall) {
  const searches = new Map((fixture.searches ?? []).map(entry => [normalizeQuery(entry.query), entry.results]));
  const pages = new Map((fixture.pages ?? []).map(page => [new URL(page.url).href, page]));
  const searchProvider: SearchProvider = {
    name: 'capability-bench-recorded-search',
    async search(query, limit, signal) {
      signal?.throwIfAborted();
      const found = searches.get(normalizeQuery(query));
      record('search', found ? 'recorded' : 'missing_fixture', query);
      return found?.slice(0, limit) ?? [];
    },
  };
  const fetchPage: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    request.signal.throwIfAborted();
    const found = request.method === 'GET' ? pages.get(request.url) : undefined;
    if (!found || found.robotsDenied) throw fixturesOnly();
    const status = found.status ?? 200;
    const content = found.html ?? found.text ?? '';
    return new Response([204, 205, 304].includes(status) ? null : content, {
      status, headers: { 'content-type': found.html ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8' },
    });
  };
  const readPage: NonNullable<CommandChatConfig['readPage']> = async (url, signal) => {
    const canonicalUrl = new URL(url).href;
    const found = pages.get(canonicalUrl);
    if (!found) { record('read', 'missing_fixture', url); return null; }
    if (found.robotsDenied) { record('read', 'recorded', url); return 'disallowed'; }
    record('read', 'recorded', url);
    const response = await fetchPage(canonicalUrl, { signal });
    if (!response.ok) return null;
    const body = await response.text();
    const article = found.html ? readableSource(withoutFigures(body), canonicalUrl) : { title: found.title!, text: body };
    return { url: canonicalUrl, title: article.title, text: article.text, status: response.status, fetchedAt: nowIso() };
  };
  let current: AgentPage | null = null;
  const history: AgentPage[] = [];
  const browser: Pick<AgentBrowser, 'setCheckpointStore' | 'bindAccount' | 'hasPage' | 'act' | 'observe' | 'screen' | 'prepareAction' | 'dropHeld' | 'closeConversation' | 'close' | 'captureEvidence'> = {
    setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return current !== null; },
    async prepareAction() { return null; }, async dropHeld() {}, async closeConversation() { current = null; },
    async close() { current = null; },
    async screen() { record('browser_screen', 'missing_fixture'); return null; },
    async captureEvidence() { record('browser_capture', 'missing_fixture'); return { status: 'unavailable', reason: 'capture_failed' }; },
    async observe() {
      if (!current) { record('observe', 'missing_fixture'); throw fixturesOnly(); }
      record('observe', 'recorded');
      return { page: { ...current, id: randomUUID(), observedAt: nowIso() }, changed: false };
    },
    async act(_ownerId, _conversationId, action) {
      const target = action.kind === 'open' ? action.text : action.kind === 'click' ? current?.elements.find(el => el.ref === action.ref)?.href : undefined;
      if (target) {
        const canonicalUrl = new URL(/^[a-z][a-z0-9+.-]*:\/\//iu.test(target) ? target : `https://${target}`).href;
        const found = pages.get(canonicalUrl);
        if (!found) { record(action.kind, 'missing_fixture', target); throw fixturesOnly(); }
        const status = found.status ?? 200;
        const article = found.html ? readableSource(withoutFigures(found.html), canonicalUrl) : { title: found.title!, text: found.text! };
        if (current) history.push(current);
        current = { id: randomUUID(), url: canonicalUrl, title: article.title, text: article.text, elements: found.elements ?? [],
          hash: createHash('sha256').update(JSON.stringify(found)).digest('hex'), observedAt: nowIso(), documentStatus: status,
          signals: { captcha: false, password: false, otp: false, card: false }, scroll: { top: 0, height: 1200, viewport: 600 } };
      } else if (action.kind === 'back' && history.length) {
        current = history.pop()!;
      } else if (action.kind === 'scroll' && current) {
        current = { ...current, scroll: { ...current.scroll, top: action.text === 'up' ? 0 : current.scroll.height - current.scroll.viewport } };
      } else {
        record(action.kind, 'denied');
        throw fixturesOnly();
      }
      record(action.kind, 'recorded', target);
      return { page: current!, changed: true };
    },
  };
  return { browser: browser as AgentBrowser, searchProvider, readPage };
}

function memoryAndInventory(database: Database, record: RecordCall) {
  const memory = createMemoryControl(database.db);
  const forbidden = async (): Promise<never> => { throw fixturesOnly(); };
  const tools = createAssistantTools({
    memory: {
      ...memory,
      async search(...args) { record('memory_search', 'recorded'); return memory.search(...args); },
      async create(...args) { record('memory_save', 'recorded'); return memory.create(...args); },
      async writeExact(...args) { record('memory_write_exact', 'recorded'); return memory.writeExact(...args); },
      async reconcileExact(...args) { record('memory_reconcile_exact', 'recorded'); return memory.reconcileExact(...args); },
    },
    coding: { available: false, async workspace() { record('workspace_list', 'recorded'); return { projects: [] }; } },
    studio: { async workspace() { return { sessions: [] }; }, detail: forbidden }, studioChange: false,
    runtime: { createTask: forbidden, approve: forbidden, cancel: forbidden, detail: forbidden },
    windows: { enabled: false, view: forbidden, act: forbidden, command: forbidden },
  });
  return { memory, tools };
}

function recordedDesktopPort(fixture: NonNullable<CapabilityCaseFixture['desktop']>, record: RecordCall): NonNullable<CommandChatConfig['desktop']> {
  return {
    parse: parseDesktopCommand, describe: describeDesktopCommand,
    async execute(command, { approved }): Promise<DesktopOutcome> {
      // The parser resolves named folders against the host home. Replays use a portable path.
      const home = homedir();
      const pathFields = new Set(['path', 'folder', 'root', 'parent', 'cwd', 'target']);
      const portable = Object.fromEntries(Object.entries(command).map(([key, value]) => {
        if (typeof value !== 'string' || !pathFields.has(key)) return [key, value];
        if (value === home) return [key, '~'];
        return [key, value.startsWith(`${home}${sep}`) ? `~/${value.slice(home.length + 1).split(sep).join('/')}` : value];
      }));
      const entry = fixture.find(item => item.approved === approved && isDeepStrictEqual(item.command, portable));
      record('desktop', entry ? 'recorded' : 'missing_fixture', command.kind);
      if (!entry) throw fixturesOnly();
      return entry.outcome;
    },
  };
}

function recordedAdsPort(fixture: NonNullable<CapabilityCaseFixture['ads']>, record: RecordCall): NonNullable<AssistantTools['ads']> {
  return {
    async status() { record('ads_status', 'recorded'); return fixture.status; },
    async report() {
      record('ads_report', fixture.report === undefined ? 'missing_fixture' : 'recorded');
      if (fixture.report === undefined) throw fixturesOnly();
      return fixture.report;
    },
    async draft() { record('ads_draft', 'denied'); throw fixturesOnly(); },
  };
}

function turnQuestionCount(replies: readonly string[], detail: ChatConversation): number {
  const questionMarks = replies.reduce((count, reply) => {
    const prose = reply.replace(/```[\s\S]*?```|`[^`\n]*`|https?:\/\/[^\s)>\]]+/gu, '');
    return count + (prose.match(/[?؟]+/gu)?.length ?? 0);
  }, 0);
  // The product can display the card as both a message and a structured question. Count its fields once.
  return Math.max(questionMarks, detail.question ? Math.max(1, detail.question.fields?.length ?? 0) : 0);
}

function trailToolCalls(trail: readonly TrailEntry[]): CapabilityToolCall[] {
  return trail.flatMap(({ action, result }) => {
    if (['asked the user', 'owner correction', 'permission gate', 'requested sign-in'].includes(action)) return [];
    const [tool, ...parts] = action.trim().split(/\s+/u);
    if (!tool) return [];
    return [{ tool, ...(parts.length ? { argument: parts.join(' ') } : {}), outcome: /^failed:/iu.test(result) ? 'failed' : 'recorded' }];
  });
}

function failedTurn(error: NonNullable<CapabilityTurnObservation['error']>, calls: CapabilityToolCall[] = [], latencyMs = 0): CapabilityTurnObservation {
  return {
    answer: '', questionCount: 0, questionFields: [], status: null, conversationStatus: null, source: null, operation: null,
    understanding: null, route: null, handler: null, routeReason: null, steps: 0, toolCalls: [], boundaryCalls: calls,
    planSteps: [], verdict: null, verification: { status: null, evidence: [], independentEvidence: [], reviewStatus: null },
    fixtureMisses: calls.filter(call => call.outcome === 'missing_fixture').length, modelCalls: 0,
    unexpectedEffects: calls.filter(call => call.outcome === 'denied').length, latencyMs, error,
  };
}

async function observeCase(database: Database, documents: Documents, item: CapabilityCaseInput, timeoutMs: number): Promise<CapabilityCaseObservation> {
  const setupStart = performance.now();
  const turns: CapabilityTurnObservation[] = [];
  const fixture = item.fixture ?? {};
  const calls: CapabilityToolCall[] = [];
  const record: RecordCall = (tool, outcome, argument) => calls.push({ tool, outcome, ...(argument === undefined ? {} : { argument }) });
  const refuseFetch: typeof fetch = async () => { record('unexpected_fetch', 'denied'); throw fixturesOnly(); };
  const realFetch = globalThis.fetch;
  const ownerId = `capability-bench-${randomUUID()}`;
  let control: Awaited<ReturnType<typeof createCommandChatControl>> | undefined;
  let setupMs = 0;
  let conversationId: string | undefined;
  try {
    globalThis.fetch = refuseFetch;
    await database.db.insertInto('user').values({ id: ownerId, name: 'Capability benchmark', email: `${ownerId}@example.invalid` }).execute();
    const { memory, tools } = memoryAndInventory(database, record);
    for (const entry of fixture.memories ?? []) await memory.create(ownerId, { ...entry, layer: 'semantic' });
    if (fixture.ads) tools.ads = recordedAdsPort(fixture.ads, record);
    const web = makeRecordedWeb(fixture, record);
    const skills = fixture.skills ?? [];
    control = await createCommandChatControl(database.db, {
      ...web, tools, recordExperiences: false, models: { fast: [], deep: [], vision: '' }, fetch: refuseFetch,
      fullAccess: async () => !fixture.member, accountFullAccess: async () => !fixture.member,
      judgeShadow: { logFile: '', observe: judge, async flush() {} }, judgeFixForOwner: true, judgeWithholdForOwner: true,
      knowledgeSearch: async () => { record('knowledge_search', 'recorded'); return fixture.knowledge ?? []; },
      skillAnswer: createSkillReader({ candidates: async () => skills, instructions: async (_owner, id) => skills.find(skill => skill.id === id)?.instructions ?? '' }),
      documents: { control: documents, link: id => `https://benchmark.invalid/api/documents/${id}/content` },
      ...(fixture.desktop ? { desktop: recordedDesktopPort(fixture.desktop, record) } : {}),
    });
    setupMs = performance.now() - setupStart;
    let priorDetail: ChatConversation | undefined;
    let previousRun: { id: string; steps: number; state: BrainState; effectCount: number } | undefined;
    for (const turn of item.turns) {
      const offset = calls.length;
      const started = performance.now();
      let error: CapabilityTurnObservation['error'] = 'dispatch';
      try {
        if (!conversationId) {
          if (turn.approve !== undefined || turn.fields || turn.answerQuestion) throw fixturesOnly();
          conversationId = (await control.create(ownerId, { goal: turn.text })).id;
        } else if (turn.approve !== undefined) {
          if (!priorDetail?.approval) { error = 'missing_approval'; throw fixturesOnly(); }
          await control.approve(ownerId, conversationId, { approvalId: priorDetail.approval.id, approved: turn.approve });
        } else {
          const question = priorDetail?.question;
          if ((turn.fields || turn.answerQuestion) && !question) { error = 'missing_question'; throw fixturesOnly(); }
          const answers = turn.fields && question?.fields?.map(field => ({ fieldId: field.id, value: turn.fields![field.id] ?? '' }));
          if (turn.fields && (!answers || answers.some(answer => !answer.value) || answers.length !== Object.keys(turn.fields).length)) {
            error = 'missing_question';
            throw fixturesOnly();
          }
          await control.send(ownerId, conversationId, { text: turn.text,
            ...((turn.answerQuestion || turn.fields) && question ? { questionId: question.id } : {}), ...(answers ? { answers } : {}) });
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([control.settled(conversationId), new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => { error = 'timeout'; reject(fixturesOnly()); }, timeoutMs);
          })]);
        } finally { clearTimeout(timer); }
        const latencyMs = performance.now() - started;
        error = 'observation';
        const detail = await control.detail(ownerId, conversationId);
        if (!detail.run) throw fixturesOnly();
        const run = await database.db.selectFrom('chat_runs').select(['id', 'status', 'state', 'steps'])
          .where('id', '=', detail.run.id).executeTakeFirstOrThrow() as { id: string; status: string; state: BrainState; steps: number };
        const modelReceipts = await database.db.selectFrom('chat_model_receipts').select('id').where('run_id', '=', run.id).execute();
        const effectReceipts = await database.db.selectFrom('chat_effect_receipts').select('id').where('run_id', '=', run.id).execute();
        const oldMessages = new Set(priorDetail?.messages.map(message => message.id) ?? []);
        const replies = detail.messages.filter(message => message.role === 'assistant' && !oldMessages.has(message.id)).map(message => message.text);
        const resumedRun = previousRun?.id === run.id ? previousRun : undefined;
        const newTrail = (run.state.trail ?? []).slice(resumedRun?.state.trail.length ?? 0);
        const toolCalls = trailToolCalls(newTrail);
        const boundaryCalls = calls.slice(offset);
        const assessment = run.state.requestResolution?.sourceAssessment;
        const evidence = detail.run.evidence;
        turns.push({ answer: replies.join('\n'), questionCount: turnQuestionCount(replies, detail), questionFields: detail.question?.fields?.map(field => field.id) ?? [],
          status: run.status, conversationStatus: detail.status, source: assessment?.source ?? null, operation: assessment?.operation ?? null,
          understanding: run.state.requestResolution?.kind ?? null, route: run.state.routing?.route ?? null, handler: run.state.routing?.handler ?? null,
          routeReason: run.state.routing?.reason ?? null, steps: Math.max(run.steps - (resumedRun?.steps ?? 0), toolCalls.length), toolCalls, boundaryCalls,
          planSteps: detail.run.plan?.steps.map(step => ({ tool: step.capability, state: step.state })) ?? [], verdict: detail.run.verdict?.reason ?? null,
          verification: { status: detail.run.verification?.status ?? null, evidence: evidence.map(entry => entry.kind),
            independentEvidence: evidence.filter(entry => entry.independent).map(entry => entry.kind), reviewStatus: run.state.completionReview?.status ?? null },
          fixtureMisses: boundaryCalls.filter(call => call.outcome === 'missing_fixture').length,
          modelCalls: Math.max(detail.run.engine.modelCalls, modelReceipts.length),
          unexpectedEffects: Math.max(0, effectReceipts.length - (resumedRun?.effectCount ?? 0)) + boundaryCalls.filter(call => call.outcome === 'denied').length, latencyMs,
          ...(detail.error ? { error: 'chat_failed' as const } : {}),
        });
        priorDetail = detail;
        previousRun = { ...run, effectCount: effectReceipts.length };
      } catch {
        turns.push(failedTurn(error!, calls.slice(offset), performance.now() - started));
        break;
      }
    }
  } catch {
    turns.push(failedTurn('fixture_setup', calls));
    setupMs = performance.now() - setupStart;
  } finally {
    try { await control?.shutdown(); }
    finally { globalThis.fetch = realFetch; }
  }
  return { setupMs, turns };
}

/** Fixtures run serially because global fetch is guarded during each case. Each case has its own owner, controller and tools. */
export async function withCapabilityHarness<T>(use: (observe: ObserveCase) => Promise<T>, options: { timeoutMs?: number } = {}): Promise<T> {
  const database = await createDatabase({});
  let directory: string | undefined;
  let documents: Documents | undefined;
  try {
    if (database.mode !== 'embedded') throw new Error('CAPABILITY_BENCH_REQUIRES_EMBEDDED_DB');
    await migrateAuth(database.db);
    await migrate(database.db);
    await memoryMigration(database.db);
    await migrateDocuments(database.db);
    directory = await mkdtemp(join(tmpdir(), 'mohassan-capability-bench-'));
    documents = createDocumentControl(database.db, { dir: directory, allowedRoots: [] });
    const fixtureDocuments = documents;
    return await use(async item => {
      if (observerActive) throw new Error('CAPABILITY_BENCH_REQUIRES_SERIAL_CASES');
      observerActive = true;
      try { return await observeCase(database, fixtureDocuments, item, options.timeoutMs ?? 30_000); }
      finally { observerActive = false; }
    });
  } finally {
    try { await documents?.shutdown(); }
    finally {
      try { await database.close(); }
      finally { if (directory) await rm(directory, { recursive: true, force: true }); }
    }
  }
}
