import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentBrowser, SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import type { BrainState } from '../apps/server/src/assistant/brain.js';
import { assessRecallCoverage } from '../apps/server/src/assistant/mind/recall-coverage.js';

const OWNER = 'isolated-json-memory-subject-owner';
const REQUEST = 'From my memory, return my HOME CITY as JSON only with key "city" as a string.';
const KEY_REQUEST = 'From my memory, return JSON only with key "workshop_city" as a string.';
const TWO_KEYS = 'From my memory, return JSON only with keys "home_city" as a string and "workshop_city" as a string.';
const HOME = 'My home city is Bristol.', WORKSHOP = 'My workshop city is Leeds.';
const BLANK = { thought: null, plan: null, note: null, url: null, ref: null, text: null, submit: null, options: null, sensitive: null, outcome: null };
const evidence = (...quotes: string[]) => quotes.map(quote => ({ quote }));

describe('JSON recall coverage retains both the requested subject and key-specific subjects', () => {
  it('does not certify a workshop city as the requested home city under a generic JSON key', () => {
    const coverage = assessRecallCoverage(REQUEST, evidence(WORKSHOP));
    expect(coverage.status, JSON.stringify(coverage)).not.toBe('complete'); expect(coverage.matchedEvidenceIndices).toEqual([]);
  });
  it('retains the explicit primary subject when selecting among otherwise matching city fields', () => {
    const coverage = assessRecallCoverage(REQUEST, evidence(WORKSHOP, HOME));
    expect(coverage.status).toBe('complete'); expect(coverage.matchedEvidenceIndices).toEqual([1]); expect(coverage.subjectTerms).toContain('home');
  });
  it('retains a bound context subject when the current JSON key is generic', () => {
    const coverage = assessRecallCoverage('From my memory, return JSON only with key "city" as a string.', evidence(WORKSHOP), { contextTopic: 'my home city' });
    expect(coverage.status, JSON.stringify(coverage)).not.toBe('complete'); expect(coverage.matchedEvidenceIndices).toEqual([]);
  });
  it('accepts exact home-city evidence for the generic city output key', () => {
    expect(assessRecallCoverage(REQUEST, evidence(HOME))).toMatchObject({ status: 'complete', matchedEvidenceIndices: [0] });
  });
  it('preserves an explicit different entity in a key when there is no competing primary subject', () => {
    expect(assessRecallCoverage(KEY_REQUEST, evidence(HOME)).status).not.toBe('complete');
    expect(assessRecallCoverage(KEY_REQUEST, evidence(WORKSHOP))).toMatchObject({ status: 'complete', matchedEvidenceIndices: [0] });
  });
  it('does not spread both key-specific subjects onto every field in a two-entity JSON request', () => {
    const coverage = assessRecallCoverage(TWO_KEYS, evidence(WORKSHOP, HOME));
    expect(coverage.status).toBe('complete'); expect(coverage.matches).toEqual([
      { property: 'city', evidenceIndices: [1] }, { property: 'city', evidenceIndices: [0] },
    ]);
  });
  it('does not silently let an explicitly different key subject override the requested home subject', () => {
    const coverage = assessRecallCoverage('From my memory, return my home city as JSON only with key "workshop_city" as a string.', evidence(WORKSHOP));
    expect(coverage.status, JSON.stringify(coverage)).not.toBe('complete');
  });
});

describe('JSON requested-subject binding through actual no-model and configured-model controllers', () => {
  let database: Awaited<ReturnType<typeof createDatabase>>;
  const controls = new Map<boolean, Awaited<ReturnType<typeof createCommandChatControl>>>();
  let notes: string[] = [], proposed: Array<{ key: string; value: string }> = [], reads = 0, models = 0, forbiddenCalls = 0;
  const forbidden = async (): Promise<never> => { forbiddenCalls++; throw new Error('Private JSON recall has no network, browser or mutation capability.'); };
  beforeAll(async () => {
    database = await createDatabase({}); expect(database.mode).toBe('embedded'); await migrate(database.db);
    for (const modelReady of [false, true]) controls.set(modelReady, await createCommandChatControl(database.db, {
      browser: { setCheckpointStore() {}, async bindAccount() {}, async close() {}, async hasPage() { return false; },
        act: forbidden, observe: forbidden, screen: forbidden, prepareAction: forbidden } as unknown as AgentBrowser,
      recordExperiences: false, tools: { memory: { async search(ownerId) { expect(ownerId).toBe(OWNER); reads++; return { text: notes.join('\n'), evidence: [...notes] }; }, save: forbidden } },
      models: modelReady ? { fast: ['json-subject-fixture'], deep: ['json-subject-fixture'], vision: '' } : { fast: [], deep: [], vision: '' },
      searchProvider: { name: 'forbidden-json-subject-network', search: forbidden } as SearchProvider,
      createProvider: model => ({ id: 'isolated-json-subject-fixture', async generate() {
        if (!modelReady || ++models > 4) return forbidden();
        return { model, usage: { inputTokens: 1, outputTokens: 1 }, text: JSON.stringify({ ...BLANK, tool: 'answer', text: proposed, outcome: 'done' }) };
      } }),
    }));
  });
  afterAll(async () => { for (const control of controls.values()) await control.shutdown(); await database?.close(); });
  async function run(modelReady: boolean, request: string, actualNotes: string[], answer: Array<{ key: string; value: string }>) {
    notes = actualNotes; proposed = answer; reads = 0; models = 0; forbiddenCalls = 0;
    const control = controls.get(modelReady)!, { id } = await control.create(OWNER, { goal: request }); await control.settled(id);
    const detail = await control.detail(OWNER, id), row = await database.db.selectFrom('chat_runs').select(['status', 'state']).where('conversation_id', '=', id).executeTakeFirstOrThrow();
    expect(detail.error).toBeNull(); expect(reads).toBe(1); expect(forbiddenCalls).toBe(0);
    expect(modelReady ? models > 0 : models === 0).toBe(true);
    return { status: row.status as string, state: row.state as BrainState, text: detail.messages.filter(message => message.role === 'assistant').at(-1)?.text ?? '' };
  }
  for (const modelReady of [false, true]) {
    const label = modelReady ? 'configured model' : 'no model';
    it(`does not return a completed wrong-subject city with ${label}`, async () => {
      const r = await run(modelReady, REQUEST, [WORKSHOP], [{ key: 'city', value: 'Leeds' }]);
      expect(r.status, JSON.stringify({ text: r.text, review: r.state.completionReview })).not.toBe('completed');
      expect(r.text).not.toBe('{"city":"Leeds"}');
    });
    it(`preserves correct home-city JSON with irrelevant workshop evidence using ${label}`, async () => {
      const r = await run(modelReady, REQUEST, [WORKSHOP, HOME], [{ key: 'city', value: 'Bristol' }]);
      expect(r.status).toBe('completed'); expect(JSON.parse(r.text)).toEqual({ city: 'Bristol' });
      expect(r.state.completionReview).toMatchObject({ status: 'verified', allowCompletion: true });
    });
    it(`preserves an explicit workshop_city key using ${label}`, async () => {
      const r = await run(modelReady, KEY_REQUEST, [HOME, WORKSHOP], [{ key: 'workshop_city', value: 'Leeds' }]);
      expect(r.status).toBe('completed'); expect(JSON.parse(r.text)).toEqual({ workshop_city: 'Leeds' });
    });
    it(`preserves separate key-specific entities using ${label}`, async () => {
      const r = await run(modelReady, TWO_KEYS, [WORKSHOP, HOME], [{ key: 'home_city', value: 'Bristol' }, { key: 'workshop_city', value: 'Leeds' }]);
      expect(r.status).toBe('completed'); expect(JSON.parse(r.text)).toEqual({ home_city: 'Bristol', workshop_city: 'Leeds' });
    });
    it.each([
      { field: 'city', request: 'من ذاكرتي، أعد مدينتي المفضلة بصيغة JSON فقط بالمفتاح "city" كنص.',
        notes: ['مدينة الورشة هي صحار.', 'مدينتي المفضلة هي مسقط.'], value: 'مسقط' },
      { field: 'name', request: 'من ذاكرتي، أعد اسم شركتي كائن JSON فقط بالمفتاح "name" كنص.',
        notes: ['اسم الورشة هو النورس.', 'اسم شركتي هو شركة السرو.'], value: 'شركة السرو' },
    ])(`preserves Arabic source fields under the English $field key using ${label}`, async entry => {
      const r = await run(modelReady, entry.request, entry.notes, [{ key: entry.field, value: entry.value }]);
      expect(r.status).toBe('completed'); expect(JSON.parse(r.text)).toEqual({ [entry.field]: entry.value });
      expect(r.state.completionReview).toMatchObject({ status: 'verified', allowCompletion: true });
    });
  }
});
