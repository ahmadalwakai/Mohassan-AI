import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentBrowser, SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { createConversationShadow, type ConversationShadowLine } from '../apps/server/src/assistant/conversation-state-shadow.js';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';

const owner = 'isolated-conversation-decides-owner';
const flag = 'MOHASSAN_CONVERSATION_SHADOW';
const companyQuestion = 'من هو مؤسس شركة مايكروسوفت؟';
const birthQuestion = 'متى ولد؟';
const capitalQuestion = 'ما عاصمة مصر؟';
const reasonQuestion = 'لماذا هي العاصمة؟';

// Regression phrases come from the requested examples and the 2026-11-23 quality report.
// Source text is reused from the report, origin/fix/chat-reasoning-gaps and existing source/layout tests.
const sources = [
  { name: 'مايكروسوفت', text: 'بيل غيتس وبول ألين هما المؤسسان.\nتأسست شركة مايكروسوفت العملاقة من قبل بيل غيتس وبول ألين في 4 نيسان من عام 1975م.' },
  { name: 'بيل غيتس', text: 'وُلد بيل غيتس في 28 أكتوبر 1955 في سياتل بولاية واشنطن.' },
  { name: 'مصر', text: 'مصر دولة عربية تقع في الركن الشمالي الشرقي من أفريقيا. عاصمة مصر هي القاهرة.' },
  { name: 'القاهرة', text: 'عاصمة مصر هي القاهرة وأكبر مدنها.\nثم أعقبه الإخشيديون، حتى انتزعها منهم الفاطميون وجعلوا عاصمتهم القاهرة التي أسسها المعز لدين الله.',
    title: 'عاصمة مصر - facts.example', url: 'https://facts.example/egypt' },
].map(source => ({ ...source, title: source.title ?? `${source.name} - ويكيبيديا`,
  url: source.url ?? `https://ar.wikipedia.org/wiki/${encodeURIComponent(source.name.replaceAll(' ', '_'))}` }));

describe('conversation decisions through the chat controller', () => {
  let directory: string;
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let control: Awaited<ReturnType<typeof createCommandChatControl>>;
  let shadow: ReturnType<typeof createConversationShadow>;
  const queries: string[] = [];

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mohassan-conversation-decides-'));
    shadow = createConversationShadow({ logFile: join(directory, 'shadow.jsonl'), replayLog: false });
    database = await createDatabase();
    await migrate(database.db);
    const browser = { setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; }, async close() {} } as unknown as AgentBrowser;
    const searchProvider: SearchProvider = {
      name: 'isolated-conversation-decides-search',
      async search(query) {
        queries.push(query);
        return sources.filter(source => query.includes(source.name) || source.name === 'القاهرة' && query.includes('عاصمة مصر'))
          .map(source => ({ title: source.title, url: source.url, snippet: source.text }));
      },
    };
    control = await createCommandChatControl(database.db, {
      browser, models: { fast: [], deep: [], vision: '' }, searchProvider, conversationShadow: shadow, recordExperiences: false,
      readPage: async url => {
        const source = sources.find(candidate => candidate.url === url);
        return source ? { url, title: source.title, text: source.text, status: 200 } : null;
      },
    });
  });

  beforeEach(() => { queries.length = 0; });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    await control?.shutdown();
    await shadow?.flush();
    await database?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function turn(text: string, conversationId?: string) {
    const id = conversationId ?? (await control.create(owner, { goal: text })).id;
    if (conversationId) await control.send(owner, id, { text });
    await control.settled(id);
    const detail = await control.detail(owner, id);
    return { ...detail, answer: detail.messages.findLast(message => message.role === 'assistant') };
  }

  async function observations(id: string): Promise<ConversationShadowLine[]> {
    await shadow.flush();
    const log = await readFile(shadow.logFile, 'utf8');
    return log.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as ConversationShadowLine)
      .filter(line => line.conversationId === id);
  }

  it('resolves the birth question to the first named founder when enabled', async () => {
    vi.stubEnv(flag, 'decide');
    const first = await turn(companyQuestion);
    expect(first.answer?.text).toContain('بيل غيتس');
    const followup = await turn(birthQuestion, first.id);
    expect(followup.error).toBeNull();
    expect(queries).toContain('متى ولد بيل غيتس');
    expect(followup.answer?.text).toContain('28 أكتوبر 1955');
    const lines = await observations(first.id);
    expect(lines[1]).toMatchObject({ mode: 'active', decision: { type: 'follow_up', questionType: 'when' } });
    expect(lines[1]?.legacyDecision).toBeUndefined();
  });

  it('keeps the why and substitutes the capital named in the answer', async () => {
    vi.stubEnv(flag, 'decide');
    const first = await turn(capitalQuestion);
    expect(first.answer?.text).toContain('القاهرة');
    const before = queries.length;
    const followup = await turn(reasonQuestion, first.id);
    expect(followup.error).toBeNull();
    expect(queries.slice(before)).toContain('لماذا القاهرة العاصمة');
  });

  it('compares decisions with the flag unset and keeps the legacy search', async () => {
    vi.stubEnv(flag, undefined);
    const first = await turn(companyQuestion);
    const before = queries.length;
    await turn(birthQuestion, first.id);
    const lines = await observations(first.id);
    expect(queries.slice(before)).toContain(lines[1]?.legacyDecision?.query);
    expect(lines.map(line => line.text)).toEqual([companyQuestion, birthQuestion]);
    expect(lines[1]).toMatchObject({ mode: 'shadow', legacyDecision: { kind: 'new' }, agreement: { type: false },
      decision: { type: 'follow_up', questionType: 'when', hasStandalone: true,
        reference: { turnId: first.answer?.id, role: 'assistant', kind: 'person' } } });
    expect(lines[1]?.decision?.reasons.length).toBeGreaterThan(0);
    expect(lines[1]?.decision?.confidence).toBeGreaterThan(0);
  });

  it('does not project a name from an assistant message without supporting search evidence', async () => {
    vi.stubEnv(flag, 'decide');
    const first = await turn(capitalQuestion);
    await database.db.insertInto('chat_messages').values({ id: randomUUID(), conversation_id: first.id, role: 'assistant',
      text: sources[0]!.text, created_at: new Date() }).execute();
    const before = queries.length;
    await turn(birthQuestion, first.id);
    expect(queries.slice(before).some(query => query.includes('بيل غيتس'))).toBe(false);
  });

  it('keeps a second, private reference out of an otherwise public follow-up', async () => {
    vi.stubEnv(flag, 'decide');
    const privateTurn = await turn('من ذاكرتي، ما مدينتي المفضلة؟');
    await database.db.insertInto('chat_messages').values({ id: randomUUID(), conversation_id: privateTurn.id, role: 'assistant',
      text: sources[2]!.text, created_at: new Date() }).execute();
    await turn(companyQuestion, privateTurn.id);
    const before = queries.length;
    await turn('When was he born?'.replace('?', ' there?'), privateTurn.id);
    expect(queries.slice(before).some(query => query.includes('القاهرة'))).toBe(false);
    expect((await observations(privateTurn.id)).at(-1)).toMatchObject({
      decision: { type: 'follow_up', hasStandalone: true, referenceCount: 2 },
    });
  });

  it('keeps an outer prohibition on web search', async () => {
    vi.stubEnv(flag, 'decide');
    const first = await turn(capitalQuestion);
    const before = queries.length;
    await turn('لا تبحث في الويب؛ وما عملتها؟', first.id);
    expect(queries).toHaveLength(before);
  });

  it('logs an accepted card answer without the submitted answer text', async () => {
    vi.stubEnv(flag, undefined);
    const first = await turn('افتح موقعًا واعرض لي محتواه');
    expect(first.question?.options.some(option => option.id === 'stop')).toBe(true);
    await control.respond(owner, first.id, { questionId: first.question!.id, optionId: 'stop' });
    const lines = await observations(first.id);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ text: '', legacyDecision: { kind: 'answer' }, decision: { type: 'card_answer' } });
  });
});
