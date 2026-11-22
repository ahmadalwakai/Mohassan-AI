import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentBrowser, SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import type { ModelRequest } from '@mohassan/providers';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import type { BrainState } from '../apps/server/src/assistant/brain.js';

const OWNER = 'isolated-model-recall-evidence-owner';
const SCALAR = 'From my memory, return my home city only.';
const AR_SCALAR = 'من ذاكرتي، ما مدينتي المفضلة؟ أعد المدينة فقط.';
const JSON_REQUEST = 'Search my memory, return JSON only with keys "color" as a string and "quantity" as a number.';
const GALLERY_JSON = 'Search my memory for the gallery card, return JSON only with keys "color" as a string and "quantity" as a number.';
const BLANK = { thought: null, plan: null, note: null, url: null, ref: null, text: null, submit: null, options: null, sensitive: null, outcome: null };
type Reply = string | { key: string; value: string | number }[];
const diagnostic = (result: { status: string; text: string; modelCalls: number; state: BrainState }) => JSON.stringify({ status: result.status,
  text: result.text, modelCalls: result.modelCalls, completionReview: result.state.completionReview,
  actionCompletionReview: result.state.actionCompletionReview });
function hostObserved(result: { state: BrainState }) {
  expect(result.state.completionReview).toMatchObject({ status: 'verified', allowCompletion: true });
  expect(result.state.supervision?.steps.flatMap(step => step.observations).some(item => item.criterionId === 'memory-answer'
    && item.kind === 'answer_evidence' && item.source === 'memory-read' && item.independentlyVerified)).toBe(true);
}

/** Actual configured-model controller, synthetic assertions/provider only. No network or writes. */
describe('independent model recall audit: field, subject and conflict binding', () => {
  let database: Awaited<ReturnType<typeof createDatabase>>, control: Awaited<ReturnType<typeof createCommandChatControl>>;
  let notes: string[] = [], reply: Reply = '', reads = 0, modelCalls = 0;
  const requests: ModelRequest[] = [];
  const forbidden = vi.fn(async (): Promise<never> => { throw new Error('Private recall cannot write memory, browse or search the network.'); });
  beforeAll(async () => {
    database = await createDatabase({}); expect(database.mode).toBe('embedded'); await migrate(database.db);
    control = await createCommandChatControl(database.db, {
      browser: { setCheckpointStore() {}, async bindAccount() {}, async close() {}, async hasPage() { return false; },
        act: forbidden, observe: forbidden, screen: forbidden, prepareAction: forbidden } as unknown as AgentBrowser,
      tools: { memory: { async search(owner, query) {
        expect(owner).toBe(OWNER); expect(query).toBeTruthy(); reads++;
        return { text: notes.join('\n'), evidence: [...notes] };
      }, save: forbidden } }, recordExperiences: false,
      models: { fast: ['model-recall-fixture'], deep: ['model-recall-fixture'], vision: '' },
      createProvider: model => ({ id: 'model-recall-fixture', async generate(request: ModelRequest) {
        requests.push(request); if (++modelCalls > 4) throw new Error('Bounded model recall correction allowance exhausted.');
        return { model, usage: { inputTokens: 1, outputTokens: 1 },
          text: JSON.stringify({ ...BLANK, tool: 'answer', text: reply, outcome: 'done' }) };
      } }),
      searchProvider: { name: 'forbidden-model-private-recall-network', search: forbidden } as SearchProvider,
    });
  });
  afterAll(async () => { await control?.shutdown(); await database?.close(); });
  async function run(request: string, evidence: string[], proposed: Reply) {
    notes = evidence; reply = proposed; reads = 0; modelCalls = 0; requests.length = 0; forbidden.mockClear();
    const { id } = await control.create(OWNER, { goal: request }); await control.settled(id);
    const detail = await control.detail(OWNER, id), row = await database.db.selectFrom('chat_runs').select(['status', 'state'])
      .where('conversation_id', '=', id).executeTakeFirstOrThrow();
    expect(detail.error).toBeNull(); expect(reads).toBe(1); expect(modelCalls).toBeGreaterThan(0); expect(forbidden).not.toHaveBeenCalled();
    return { status: row.status as string, state: row.state as BrainState,
      text: detail.messages.filter(message => message.role === 'assistant').at(-1)?.text ?? '', modelCalls };
  }

  it('rejects a literal city value supported only by a different subject', async () => {
    const result = await run(SCALAR, ['My home city is Bristol.', 'My workshop city is Leeds.'], 'Leeds');
    expect(result.status, diagnostic(result)).not.toBe('completed'); expect(result.text).not.toBe('Leeds');
  });
  it.each([
    ['From my memory, return my depot capacity only.', 'My depot capacity is not 20 vans.', '20'],
    ['From my memory, return my depot capacity only.', 'My depot capacity is less than 20 vans.', '20'],
    ['From my memory, return my depot capacity only.', 'My depot capacity is at least 20 vans.', '20'],
    ['ما سعة المستودع في ذاكرتي؟ اذكر الرقم فقط.', 'سعة المستودع هي ليست ٢٠ شاحنة.', '٢٠'],
    ['ما سعة المستودع في ذاكرتي؟ اذكر الرقم فقط.', 'سعة المستودع هي أقل من ٢٠ شاحنة.', '٢٠'],
    ['ما سعة المستودع في ذاكرتي؟ اذكر الرقم فقط.', 'سعة المستودع هي ٢٠ شاحنة على الأقل.', '٢٠'],
  ])('rejects a model answer that removes a numeric qualification: %s / %s', async (request, note, proposed) => {
    const result = await run(request, [note], proposed);
    expect(result.status, diagnostic(result)).not.toBe('completed');
    expect(result.text).not.toBe(proposed);
    expect(result.state.completionReview?.allowCompletion).not.toBe(true);
  });
  it.each(['Bristol', 'Leeds'])('does not silently choose %s when the same requested subject has conflicting values', async chosen => {
    const result = await run(SCALAR, ['My home city is Bristol.', 'My home city is Leeds.'], chosen);
    expect(result.status, diagnostic(result)).not.toBe('completed'); expect(result.text).not.toBe(chosen);
  });
  it('does not borrow a second field value from the same leading sentence', async () => {
    const result = await run(SCALAR, ['My home city is Bristol and my workshop city is Leeds.'], 'Leeds');
    expect(result.status, diagnostic(result)).not.toBe('completed'); expect(result.text).not.toBe('Leeds');
  });
  it('rejects correctly typed JSON whose color value actually belongs to quantity', async () => {
    const result = await run(JSON_REQUEST, ['The color is Indigo and the quantity is 21.'], [{ key: 'color', value: '21' }, { key: 'quantity', value: 21 }]);
    expect(result.status, diagnostic(result)).not.toBe('completed');
    expect(result.text).not.toBe('{"color":"21","quantity":21}');
  });
  it('rejects JSON values from the wrong card even when each literal and type is supported', async () => {
    const result = await run(GALLERY_JSON, ['The gallery card color is Indigo.', 'The gallery card quantity is 21.',
      'The workshop card color is Amber.', 'The workshop card quantity is 19.'], [{ key: 'color', value: 'Amber' }, { key: 'quantity', value: 19 }]);
    expect(result.status, diagnostic(result)).not.toBe('completed');
    expect(result.text).not.toBe('{"color":"Amber","quantity":19}');
  });
  it('does not silently select one conflicting JSON field while other requested fields agree', async () => {
    const result = await run(JSON_REQUEST, ['The color is Indigo.', 'The color is Amber.', 'The quantity is 21.'],
      [{ key: 'color', value: 'Indigo' }, { key: 'quantity', value: 21 }]);
    expect(result.status, diagnostic(result)).not.toBe('completed');
    expect(result.text).not.toBe('{"color":"Indigo","quantity":21}');
  });
  it('rejects a different Arabic city subject without inferring which city the user meant', async () => {
    const result = await run(AR_SCALAR, ['مدينتي المفضلة هي مسقط.', 'مدينة الورشة هي صحار.'], 'صحار');
    expect(result.status, diagnostic(result)).not.toBe('completed'); expect(result.text).not.toBe('صحار');
  });
  it('retains correct scalar completion with irrelevant evidence present', async () => {
    const result = await run(SCALAR, ['My home city is Bristol.', 'My workshop city is Leeds.'], 'Bristol');
    expect(result.status).toBe('completed'); expect(result.text).toBe('Bristol');
    hostObserved(result);
  });
  it('retains correct Arabic scalar completion with irrelevant evidence present', async () => {
    const result = await run(AR_SCALAR, ['مدينتي المفضلة هي مسقط.', 'مدينة الورشة هي صحار.'], 'مسقط');
    expect(result.status).toBe('completed'); expect(result.text).toBe('مسقط');
    hostObserved(result);
  });
  it('retains complete typed JSON from individually bound fields', async () => {
    const result = await run(JSON_REQUEST, ['The color is Indigo.', 'The quantity is 21.'], [{ key: 'color', value: 'Indigo' }, { key: 'quantity', value: 21 }]);
    expect(result.status).toBe('completed'); expect(JSON.parse(result.text)).toEqual({ color: 'Indigo', quantity: 21 });
    hostObserved(result);
  });
  it('accepts repeated equal values without manufacturing a conflict', async () => {
    const result = await run(SCALAR, ['My home city is Bristol.', 'My home city is Bristol.'], 'Bristol');
    expect(result.status).toBe('completed'); expect(result.text).toBe('Bristol');
    hostObserved(result);
  });
});
