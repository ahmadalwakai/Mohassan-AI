import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentBrowser, SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import type { BrainState } from '../apps/server/src/assistant/brain.js';
import { decideRequestRoute } from '../apps/server/src/assistant/routing-decision.js';
import { parseUserRequestConstraints, requestCapabilityAllowed } from '../apps/server/src/assistant/request-scope.js';

const OWNER = 'isolated-runtime-constraints-owner';
const PRIVATE_CONTEXT = 'SYNTHETIC_PRIVATE_RUNTIME_CONTEXT';
type RuntimeKind = 'overview' | 'generation' | 'browser' | 'computation';
interface Case { request: string; kind: 'runtime' | 'compute' | 'recall'; runtimeKind?: RuntimeKind }
interface Fixture {
  database: Awaited<ReturnType<typeof createDatabase>>;
  control: Awaited<ReturnType<typeof createCommandChatControl>>;
  calls: { queries: string[]; memoryQueries: string[]; writes: number; pc: number; browser: number; memoryContext: number; learningContext: number };
}
const fixtures: Fixture[] = [];
const cases: Case[] = [
  { request: 'What is your current brain?', kind: 'runtime', runtimeKind: 'overview' },
  { request: 'Do not search the web. What is your current brain?', kind: 'runtime', runtimeKind: 'overview' },
  { request: 'What model are you using?', kind: 'runtime', runtimeKind: 'generation' },
  { request: 'Do not search the web. What model are you using?', kind: 'runtime', runtimeKind: 'generation' },
  { request: 'لا تستخدم الكمبيوتر؛ ما هو الدماغ الحالي؟', kind: 'runtime', runtimeKind: 'overview' },
  { request: 'Do not use my memory. Is browser access available?', kind: 'runtime', runtimeKind: 'browser' },
  { request: 'Do not search the web. Is local computation available?', kind: 'runtime', runtimeKind: 'computation' },
  { request: 'لا تبحث في الويب؛ هل الحساب المحلي متاح؟', kind: 'runtime', runtimeKind: 'computation' },
  { request: 'Do not search the web. Calculate 28 * 3.', kind: 'compute' },
  { request: 'لا تستخدم الكمبيوتر؛ احسب ٢٨ * ٣.', kind: 'compute' },
  { request: 'Do not use memory. Calculate 28 * 3.', kind: 'compute' },
  { request: 'Do not save anything. What is my depot code from memory?', kind: 'recall' },
  { request: 'Do not search the web and do not save anything. Read my saved depot code from memory.', kind: 'recall' },
  { request: 'لا تستخدم الكمبيوتر؛ ما رمز المستودع في ذاكرتي؟', kind: 'recall' },
  { request: 'What brain are you using?', kind: 'runtime', runtimeKind: 'overview' },
  { request: 'Do not search the web. What brain are you using?', kind: 'runtime', runtimeKind: 'overview' },
  { request: 'لا تستخدم الكمبيوتر؛ ماهو الدماغ الحالي؟', kind: 'runtime', runtimeKind: 'overview' },
  { request: 'لا تبحث في الويب؛ ماهو النموذج الحالي؟', kind: 'runtime', runtimeKind: 'generation' },
];

/** No models, environment configuration, network, browser process or owner data. */
async function harness(): Promise<Fixture> {
  const database = await createDatabase({}); await migrate(database.db);
  expect(database.mode).toBe('embedded');
  const calls: Fixture['calls'] = { queries: [], memoryQueries: [], writes: 0, pc: 0, browser: 0, memoryContext: 0, learningContext: 0 };
  const browserIO = async () => { calls.browser++; throw new Error('No browser action belongs to an intrinsic local answer.'); };
  const browser = { setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; }, async close() {},
    act: browserIO, observe: browserIO, screen: browserIO, prepareAction: browserIO } as unknown as AgentBrowser;
  const control = await createCommandChatControl(database.db, {
    browser, brainVersion: 'B', models: { fast: [], deep: [], vision: '' }, recordExperiences: false,
    searchProvider: { name: 'isolated-runtime-public-fixture', async search(query) {
      calls.queries.push(query); return [{ title: query, url: 'https://runtime-constraints-fixture.test/public', snippet: 'Synthetic public content is not application runtime status.' }];
    } } as SearchProvider,
    async memoryContext() { calls.memoryContext++; return PRIVATE_CONTEXT; },
    async learningContext() { calls.learningContext++; return PRIVATE_CONTEXT; },
    tools: {
      memory: {
        async search(_owner, query) { calls.memoryQueries.push(query); return { text: 'Explicit synthetic evidence', evidence: ['The depot code is FR-46.', 'رمز المستودع هو FR-46.'] }; },
        async save() { calls.writes++; throw new Error('A recall or status question does not authorize a write.'); },
      },
      computer: {
        async view() { calls.pc++; throw new Error('No private computer read belongs to these local questions.'); },
        async perform() { calls.pc++; throw new Error('No computer action belongs to these local questions.'); },
      },
    },
  });
  const fixture: Fixture = { database, control, calls }; fixtures.push(fixture); return fixture;
}
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) { await fixture.control.shutdown(); await fixture.database.close(); }
});

describe('allowed local work beside explicit current-user constraints', () => {
  it.each(cases)('completes the supported $kind request without forbidden I/O: $request', async test => {
    const fixture = await harness();
    const conversation = await fixture.control.create(OWNER, { goal: test.request });
    await fixture.control.settled(conversation.id);
    const detail = await fixture.control.detail(OWNER, conversation.id);
    const row = await fixture.database.db.selectFrom('chat_runs').selectAll().where('conversation_id', '=', conversation.id).executeTakeFirstOrThrow();
    const state = row.state as BrainState;
    expect(row.status, detail.error ?? '').toBe('completed'); expect(detail.status).toBe('idle'); expect(detail.error).toBeNull(); expect(detail.question).toBeNull();
    expect(row.goal).toBe(test.request); expect(state.requestResolution?.original).toBe(test.request); expect(state.requestResolution?.resolved).toBe(test.request);
    expect(state.supervision?.contract.objective).toBe(test.request);
    expect(state.actionCompletion?.contract.requestHash).toBe(createHash('sha256').update(test.request, 'utf8').digest('hex'));
    expect(state.actionCompletion?.contract.requirements.some(item => ['memory_write', 'computer_click', 'computer_type', 'computer_key', 'delivery'].includes(item.kind))).toBe(false);
    expect(state.requestResolution?.query).toBeNull();
    expect(fixture.calls.queries).toEqual([]); expect(fixture.calls.writes).toBe(0); expect(fixture.calls.pc).toBe(0); expect(fixture.calls.browser).toBe(0);
    expect(fixture.calls.memoryContext).toBe(0); expect(fixture.calls.learningContext).toBe(0);
    const reply = detail.messages.filter(message => message.role === 'assistant').at(-1)?.text ?? '';
    expect(reply).not.toContain(PRIVATE_CONTEXT);
    if (test.kind === 'runtime') {
      expect(state.routing).toMatchObject({ route: 'chat', handler: 'local_status', availability: 'ready', reason: 'host_runtime_status' });
      expect(reply).toMatch(/^Mohassan — /u);
      if (test.runtimeKind === 'overview') expect(reply).toMatch(/Host coordinator revision: B|منسق التطبيق: الإصدار B/u);
      if (test.runtimeKind === 'generation') expect(reply).toMatch(/not configured|غير مهيأ/u);
      if (test.runtimeKind === 'browser') expect(reply).toContain('Browser: configured; account access allowed; operation unverified');
      if (test.runtimeKind === 'computation') expect(reply).toMatch(/Local computation: configured|الحساب المحلي: مهيأ/u);
      expect(fixture.calls.memoryQueries).toEqual([]);
    } else if (test.kind === 'compute') {
      expect(reply).toContain('84'); expect(state.routing?.handler).toBe('local_computation'); expect(fixture.calls.memoryQueries).toEqual([]);
    } else {
      expect(reply).toContain('FR-46'); expect(fixture.calls.memoryQueries).toHaveLength(1);
      expect(fixture.calls.memoryQueries[0]).not.toMatch(/do not|لا تستخدم|لا تحفظ/iu);
    }
    const constraints = parseUserRequestConstraints(test.request);
    expect(state.requestResolution?.constraints ?? null).toEqual(constraints);
    if (constraints?.forbiddenCapabilities.includes('memory_read')) expect(requestCapabilityAllowed(constraints, 'memory_read')).toBe(false);
    expect(await fixture.database.db.selectFrom('chat_model_receipts').select('id').where('run_id', '=', row.id).execute()).toEqual([]);
  });
});

describe('closed runtime routing never promotes supplied data, public research or extra actions', () => {
  it.each(['ماهو النموذج الحالي', 'ماهي مواعيد المكتبة'])('accepts an exact joined question head with a lexical boundary: %s', question => {
    const constraints = parseUserRequestConstraints(`لا تستخدم الكمبيوتر؛ ${question}؟`)!;
    expect(constraints).toMatchObject({ ambiguous: false, safeActionText: question, forbiddenCapabilities: ['computer_read', 'computer_action'] });
    expect(parseUserRequestConstraints('لا تستخدم الكمبيوتر؛ ماهيأوامر افعل هذا؟')?.ambiguous).toBe(true);
  });
  it.each([
    'Do not use memory. Translate "What brain are you using?" into Arabic.',
    'Do not search the web. What brain is ChatGPT using?',
    'Do not use memory. What brain are you using? Then open the browser.',
    '"What brain are you using?"',
  ])('does not swallow the original instruction into local_status: %s', text => {
    const route = decideRequestRoute({ text, capabilities: { browser: true, search: true, memory: true, chatModel: true, writerModel: true } });
    expect(route.handler).not.toBe('local_status'); expect(route.resolution.original).toBe(text); expect(route.resolution.resolved).toBe(text);
    expect(route).not.toHaveProperty('permission'); expect(route).not.toHaveProperty('approval');
  });
});
