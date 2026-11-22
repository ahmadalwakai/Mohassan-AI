import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentBrowser, SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { createMemoryControl, memoryMigration } from '@mohassan/memory';
import { migrateAuth } from '../apps/server/src/auth.js';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import { createAssistantTools } from '../apps/server/src/assistant/tools.js';
import type { BrainState } from '../apps/server/src/assistant/brain.js';

const EN_QUESTION = 'From my memory, return my preferred language only.';
const AR_QUESTION = 'من ذاكرتي، أعد لغتي المفضلة فقط.';

/** Development audit: synthetic local user statements, real domain/tool/controller;
 * no providers, training, owner data, network, browser or native input. */
describe('saving and ordinarily recalling supported language preferences', () => {
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let domain: ReturnType<typeof createMemoryControl>;
  const controls = new Map<boolean, Awaited<ReturnType<typeof createCommandChatControl>>>();
  let writes = 0, reconciles = 0, legacyCreates = 0;
  let modelCalls = 0, proposedValue = '';
  const searches: Array<{ owner: string; query: unknown; contents: string[] }> = [];
  const forbidden = vi.fn(async (): Promise<never> => { throw new Error('This language-preference audit has no external/model/work effects.'); });
  let ownerNumber = 0;

  beforeAll(async () => {
    database = await createDatabase({}); expect(database.mode).toBe('embedded');
    await migrateAuth(database.db); await migrate(database.db); await memoryMigration(database.db);
    domain = createMemoryControl(database.db);
    const tools = createAssistantTools({
      memory: {
        async create(owner, input) { legacyCreates++; return domain.create(owner, input); },
        async search(owner, input, options) {
          expect(options).toEqual({ readOnly: true });
          const result = await domain.search(owner, input, options);
          searches.push({ owner, query: input, contents: result.items.map(item => item.content) });
          return result;
        },
        async writeExact(owner, input, options) { writes++; return domain.writeExact(owner, input, options); },
        async reconcileExact(owner, input, options) { reconciles++; return domain.reconcileExact(owner, input, options); },
      },
      coding: { available: false, workspace: forbidden },
      studio: { workspace: forbidden, detail: forbidden }, studioChange: false,
      runtime: { createTask: forbidden, approve: forbidden, cancel: forbidden, detail: forbidden },
      windows: { enabled: false, view: forbidden, act: forbidden, command: forbidden },
    });
    for (const configured of [false, true]) controls.set(configured, await createCommandChatControl(database.db, {
      browser: { setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; }, async close() {},
        act: forbidden, observe: forbidden, screen: forbidden, prepareAction: forbidden } as unknown as AgentBrowser,
      tools: { memory: tools.memory }, recordExperiences: false, fullAccess: async () => true,
      models: configured ? { fast: ['synthetic-language-recall-model'], deep: ['synthetic-language-recall-model'], vision: '' } : { fast: [], deep: [], vision: '' },
      searchProvider: { name: 'forbidden-language-preference-network', search: forbidden } as SearchProvider,
      createProvider: model => ({ id: 'synthetic-language-recall-model', async generate() {
        if (!configured) return forbidden(); modelCalls++;
        return { model, usage: { inputTokens: 1, outputTokens: 1 }, text: JSON.stringify({ tool: 'answer', text: proposedValue,
          thought: null, plan: null, note: null, url: null, ref: null, submit: null, options: null, sensitive: null, outcome: 'done' }) };
      } }),
    }));
  });
  afterAll(async () => { for (const control of controls.values()) await control.shutdown(); await database?.close(); });

  async function run(owner: string, request: string, configured = false) {
    const control = controls.get(configured)!;
    const { id } = await control.create(owner, { goal: request }); await control.settled(id);
    const detail = await control.detail(owner, id);
    const row = await database.db.selectFrom('chat_runs').select(['status', 'state']).where('conversation_id', '=', id).executeTakeFirstOrThrow();
    expect(detail.error).toBeNull();
    return { status: row.status as string, state: row.state as BrainState,
      text: detail.messages.filter(message => message.role === 'assistant').at(-1)?.text ?? '' };
  }
  async function rows(owner: string) {
    const [items, operations, evidence] = await Promise.all([
      database.db.selectFrom('memory_items').selectAll().where('owner_id', '=', owner).execute(),
      database.db.selectFrom('memory_exact_operations').selectAll().where('owner_id', '=', owner).execute(),
      database.db.selectFrom('memory_evidence').selectAll().where('owner_id', '=', owner).execute(),
    ]);
    return { items, operations, evidence };
  }
  async function saveThenRecall(request: string, payload: string, question: string, configured = false, answer = '', expectModel = configured) {
    const owner = `isolated-language-preference-owner-${++ownerNumber}`;
    await database.db.insertInto('user').values({ id: owner, name: 'Synthetic language-preference owner', email: `${owner}@example.test` }).execute();
    const beforeWrite = writes, beforeRead = reconciles, beforeLegacy = legacyCreates, beforeSearch = searches.length, beforeModels = modelCalls;
    forbidden.mockClear();
    const saved = await run(owner, request, configured), before = await rows(owner);
    expect(saved.status, saved.text).toBe('completed'); expect(saved.state.userFactMemory?.phase).toBe('verified');
    expect(before.items).toHaveLength(1); expect(before.items[0]).toMatchObject({ content: payload, confidence_kind: 'user_asserted' });
    expect(before.operations).toHaveLength(1); expect(before.evidence).toHaveLength(1);
    expect(before.evidence[0]).toMatchObject({ kind: 'manual', trust: 'manual' });
    expect(writes - beforeWrite).toBe(1); expect(reconciles - beforeRead).toBe(1);
    expect(modelCalls - beforeModels).toBe(0);
    // A separate conversation proves recall from saved storage, not previous assistant wording.
    proposedValue = answer;
    const recalled = await run(owner, question, configured);
    expect(await rows(owner)).toEqual(before);
    expect(writes - beforeWrite).toBe(1); expect(reconciles - beforeRead).toBe(1);
    expect(legacyCreates - beforeLegacy).toBe(0); expect(searches.length - beforeSearch).toBe(1);
    expect(expectModel ? modelCalls > beforeModels : modelCalls === beforeModels).toBe(true);
    expect(forbidden).not.toHaveBeenCalled();
    expect(await database.db.selectFrom('experiences').select('source_id').execute()).toEqual([]);
    return { ...recalled, search: searches.at(-1), savedKind: saved.state.userFactMemory?.receipt.statementKind };
  }

  it.each([
    { id: 'native-en', request: 'Remember that I prefer Arabic.', payload: 'I prefer Arabic.', question: EN_QUESTION, expected: 'Arabic' },
    { id: 'native-ar', request: 'تذكر أنني أفضل العربية', payload: 'أنني أفضل العربية', question: AR_QUESTION, expected: 'العربية' },
    { id: 'explicit-en', request: 'Remember exactly this note: "My preferred language is Arabic."', payload: 'My preferred language is Arabic.', question: EN_QUESTION, expected: 'Arabic' },
    { id: 'explicit-ar', request: 'احفظ في ذاكرتي النص التالي: «لغتي المفضلة هي العربية.»', payload: 'لغتي المفضلة هي العربية.', question: AR_QUESTION, expected: 'العربية' },
  ])('returns the exact preferred-language value after a real save: $id', async entry => {
    const result = await saveThenRecall(entry.request, entry.payload, entry.question);
    const diagnostics = JSON.stringify({ status: result.status, text: result.text, search: result.search, savedKind: result.savedKind,
      review: result.state.completionReview });
    expect(result.text, diagnostics).toBe(entry.expected);
    expect(result.status, diagnostics).toBe('completed');
  });

  it.each([
    { id: 'wrong-colour-field', payload: 'My favourite colour is blue.' },
    { id: 'ordinary-fruit-preference', payload: 'I prefer mangoes.' },
  ])('does not reinterpret a different field/preference as a language: $id', async ({ payload }) => {
    const result = await saveThenRecall(`Remember exactly this note: "${payload}"`, payload, EN_QUESTION);
    expect(result.status, JSON.stringify({ text: result.text, search: result.search })).not.toBe('completed');
    expect(result.text).not.toBe('blue'); expect(result.text).not.toBe('mangoes');
    expect(result.text).not.toBe(payload);
  });

  it.each([
    { id: 'en', request: 'Remember that I prefer Arabic.', payload: 'I prefer Arabic.', question: EN_QUESTION, expected: 'Arabic' },
    { id: 'ar', request: 'تذكر أنني أفضل العربية', payload: 'أنني أفضل العربية', question: AR_QUESTION, expected: 'العربية' },
  ])('verifies a configured model value against the same real saved preference: $id', async entry => {
    const result = await saveThenRecall(entry.request, entry.payload, entry.question, true, entry.expected);
    expect(result.status, JSON.stringify({ text: result.text, review: result.state.completionReview })).toBe('completed');
    expect(result.text).toBe(entry.expected);
    expect(result.state.completionReview?.allowCompletion).toBe(true);
  });
  it('does not accept a configured model choosing another language than the stored assertion', async () => {
    const result = await saveThenRecall('Remember that I prefer Arabic.', 'I prefer Arabic.', EN_QUESTION, true, 'English');
    expect(result.search?.contents).toContain('I prefer Arabic.');
    expect(result.status).not.toBe('completed'); expect(result.text).not.toBe('English');
  });
  it('does not accept a configured model treating a stored fruit preference as language evidence', async () => {
    const result = await saveThenRecall('Remember exactly this note: "I prefer mangoes."', 'I prefer mangoes.', EN_QUESTION, true, 'mangoes');
    expect(result.search?.contents).toContain('I prefer mangoes.');
    expect(result.status).not.toBe('completed'); expect(result.text).not.toBe('mangoes');
  });
  it.each([
    { id: 'formatted after one model reply', question: EN_QUESTION, expectedModels: 1 },
    { id: 'unformatted without a model reply', question: 'From my memory, what is my preferred language?', expectedModels: 0 },
  ])('publishes the host partial with both real conflicting language assertions: $id', async ({ question, expectedModels }) => {
    const owner = `isolated-language-preference-owner-${++ownerNumber}`;
    await database.db.insertInto('user').values({ id: owner, name: 'Synthetic conflicting-language owner', email: `${owner}@example.test` }).execute();
    const beforeWrites = writes, beforeRead = reconciles, beforeModels = modelCalls, beforeSearch = searches.length, beforeLegacy = legacyCreates;
    forbidden.mockClear();
    for (const language of ['Arabic', 'English']) {
      const saved = await run(owner, `Remember that I prefer ${language}.`, true);
      expect(saved.status).toBe('completed'); expect(saved.state.userFactMemory?.phase).toBe('verified');
    }
    expect(modelCalls).toBe(beforeModels);
    const before = await rows(owner); expect(before.items).toHaveLength(2);
    proposedValue = 'Arabic';
    const result = await run(owner, question, true);
    expect(result.status, JSON.stringify({ text: result.text, review: result.state.completionReview })).toBe('partial');
    expect(result.text).toContain('I prefer Arabic'); expect(result.text).toContain('I prefer English');
    expect(result.text).toContain('The saved language preferences conflict; I could not verify one current preference.');
    expect(result.state.completionReview?.allowCompletion).toBe(false);
    expect(result.state.supervision?.steps.flatMap(step => step.observations).some(observation => observation.kind === 'answer_evidence'
      && observation.source === 'memory-read' && observation.independentlyVerified)).toBe(false);
    expect(modelCalls - beforeModels).toBe(expectedModels); expect(searches.length - beforeSearch).toBe(1);
    expect(writes - beforeWrites).toBe(2); expect(reconciles - beforeRead).toBe(2); expect(legacyCreates - beforeLegacy).toBe(0);
    expect(await rows(owner)).toEqual(before); expect(forbidden).not.toHaveBeenCalled();
  });
  it.each([
    { id: 'en', request: 'Remember that I prefer Arabic.', payload: 'I prefer Arabic.', question: 'From my memory, what is my preferred language?',
      expected: 'From memory: «I prefer Arabic»' },
    { id: 'ar', request: 'تذكر أنني أفضل العربية', payload: 'أنني أفضل العربية', question: 'من ذاكرتي، ما لغتي المفضلة؟',
      expected: 'من الذاكرة: «أنني أفضل العربية»' },
  ])('answers a configured unformatted self question from one actual read and zero generations: $id', async entry => {
    const result = await saveThenRecall(entry.request, entry.payload, entry.question, true, '', false);
    expect(result.status).toBe('completed'); expect(result.text).toBe(entry.expected);
    expect(result.state.completionReview).toMatchObject({ status: 'verified', allowCompletion: true });
    const observations = result.state.supervision?.steps.flatMap(step => step.observations)
      .filter(observation => observation.kind === 'answer_evidence' && observation.source === 'memory-read');
    expect(observations).toHaveLength(1);
    expect(observations?.[0]).toMatchObject({ independentlyVerified: true, outcome: 'confirmed' });
  });
});
