import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentBrowser, SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { describeDesktopCommand, parseDesktopCommand, type DesktopCommand, type DesktopOutcome } from '@mohassan/desktop';
import { acknowledgementForms, acknowledgementThanksForms } from '../apps/server/src/assistant/acknowledgements.js';
import { emptyConversationState, understandTurn, withPending } from '../apps/server/src/assistant/conversation-state.js';
import { notWebReason } from '../apps/server/src/assistant/hands.js';
import { decideRequestRoute } from '../apps/server/src/assistant/routing-decision.js';
import type { ScratchDecisionPolicy } from '../apps/server/src/assistant/scratch-decisions.js';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';

const owner = 'isolated-acknowledgement-owner';
const mannersFlag = 'MOHASSAN_SMALL_TALK_MANNERS';

// The questions, acknowledgement regressions and Spain follow-ups are from the task report.
// Capital facts are translated from the EU country profiles, retrieved 2026-11-27.
// https://european-union.europa.eu/principles-countries-history/eu-countries/france_en
// https://european-union.europa.eu/principles-countries-history/eu-countries/spain_en
const cases = {
  ar: {
    question: 'ما عاصمة فرنسا؟', followUp: 'تمام، وإسبانيا؟', capital: 'باريس', nextCapital: 'مدريد',
    country: /إسبانيا|اسبانيا/u, oldCountry: /فرنسا/u, attribute: /عاصمة/u,
    forms: ['اوكي', 'ايوا', 'زين', 'ماشي', 'واخا', 'فهمت', 'تمام', 'طيب', 'تمام، شكرًا'],
    language: /\p{Script=Arabic}/u,
  },
  en: {
    question: 'What is the capital of France?', followUp: 'got it, and Spain?', capital: 'Paris', nextCapital: 'Madrid',
    country: /\bSpain\b/iu, oldCountry: /\bFrance\b/iu, attribute: /\bcapital\b/iu,
    forms: ['cool', 'ok', 'sure thing', 'great, thanks', 'got it'],
    language: /^[^\p{Script=Arabic}]*[a-z]/iu,
  },
} as const;

const sources = [
  { title: 'France', text: 'Paris is the capital of France. France is an EU member state.', match: cases.en.oldCountry, lang: 'en' },
  { title: 'Spain', text: 'Madrid is the capital of Spain. Spain is an EU member state.', match: cases.en.country, lang: 'en' },
  { title: 'فرنسا', text: 'باريس هي عاصمة فرنسا. فرنسا دولة عضو في الاتحاد الأوروبي.', match: cases.ar.oldCountry, lang: 'ar' },
  { title: 'إسبانيا', text: 'مدريد هي عاصمة إسبانيا. إسبانيا دولة عضو في الاتحاد الأوروبي.', match: cases.ar.country, lang: 'ar' },
].map(source => ({ ...source, url: `https://${source.lang}.wikipedia.org/wiki/${encodeURIComponent(source.title)}` }));

const search = vi.fn<SearchProvider['search']>(async query => sources.filter(source => source.match.test(query))
  .map(({ title, url, text: snippet }) => ({ title, url, snippet })));
const bindAccount = vi.fn(async () => {});
const act = vi.fn(async () => { throw new Error('Unexpected browser action'); });
const readPage = vi.fn(async (url: string) => {
  const source = sources.find(candidate => decodeURI(candidate.url) === decodeURI(url));
  return source ? { url, title: source.title, text: source.text, status: 200 } : null;
});
const modelFetch = vi.fn<typeof fetch>(async () => { throw new Error('Unexpected model request'); });
const scratchPolicy: ScratchDecisionPolicy = {
  enabled: true,
  predictAll: vi.fn(() => { throw new Error('Unexpected scratch model request'); }),
  report: vi.fn(),
};

// Synthetic desktop boundary from the existing approval test, retrieved 2026-11-27.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/tests/assistant-desktop-chat.test.ts#L73-L87
const execute = vi.fn(async (command: DesktopCommand, options: { approved: boolean }): Promise<DesktopOutcome> => {
  if (command.kind !== 'file_delete') throw new Error('Unexpected desktop command');
  return options.approved ? { status: 'completed', text: command.path } : {
    status: 'needs_approval', text: command.path, approval: { prompt: command.path, detail: command.path, label: command.path },
  };
});

let database: Awaited<ReturnType<typeof createDatabase>>;
let control: Awaited<ReturnType<typeof createCommandChatControl>>;

beforeAll(async () => {
  database = await createDatabase({});
  await migrate(database.db);
  const browser = { setCheckpointStore() {}, bindAccount, async hasPage() { return false; }, act,
    async dropHeld() {}, async close() {} } as unknown as AgentBrowser;
  control = await createCommandChatControl(database.db, {
    models: { fast: [], deep: [], vision: '' }, browser, recordExperiences: false, fetch: modelFetch,
    searchProvider: { name: 'isolated-acknowledgement-search', search }, readPage,
    desktop: { parse: parseDesktopCommand, describe: describeDesktopCommand, execute },
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
afterAll(async () => { await control?.shutdown(); await database?.close(); });

async function settled(id: string) {
  await control.settled(id);
  const detail = await control.detail(owner, id);
  return { ...detail, reply: detail.messages.at(-1)?.text ?? '' };
}

async function start(goal: string) {
  return settled((await control.create(owner, { goal })).id);
}

async function send(id: string, text: string) {
  await control.send(owner, id, { text });
  return settled(id);
}

async function latestRun(id: string) {
  return database.db.selectFrom('chat_runs').select(['id', 'goal', 'state', 'status', 'steps'])
    .where('conversation_id', '=', id).orderBy('created_at', 'desc').executeTakeFirstOrThrow();
}

function expectNoExternalWork() {
  expect(search).not.toHaveBeenCalled();
  expect(readPage).not.toHaveBeenCalled();
  expect(bindAccount).not.toHaveBeenCalled();
  expect(act).not.toHaveBeenCalled();
  expect(modelFetch).not.toHaveBeenCalled();
}

describe.each([{ mode: 'off', value: undefined }, { mode: 'on', value: '1' }])('acknowledgements with the manners flag $mode', ({ value }) => {
  for (const language of ['ar', 'en'] as const) {
    const scenario = cases[language];

    it(`routes every sourced ${language} form and generated thanks combination without a query`, () => {
      vi.stubEnv(mannersFlag, value);
      const previous = understandTurn(emptyConversationState(), scenario.question, 'first').next;
      const acknowledgements = acknowledgementForms[language];
      const thanks = acknowledgementThanksForms[language];
      const separator = language === 'ar' ? '، ' : ', ';
      const combinations = acknowledgements.flatMap(form => thanks.flatMap(suffix => [form + separator + suffix, `${form} ${suffix}`]));
      for (const text of [...acknowledgements, ...thanks, ...combinations]) {
        const route = decideRequestRoute({ text, context: previous.base, previousTurns: 1,
          capabilities: { search: true, browser: true, chatModel: true } }, scratchPolicy);
        expect(route, text).toMatchObject({ route: 'chat', handler: 'local_conversation', availability: 'ready', publicQuery: null,
          localReply: { status: 'completed', text: expect.stringMatching(scenario.language) },
          resolution: { query: null, nextState: { topic: previous.base?.topic } } });
        expect(notWebReason(text), text).toBe('chat');
        expect(understandTurn(previous, text, 'reply'), text).toMatchObject({
          type: 'small_talk', query: null, decision: { type: 'small_talk', standalone: null },
        });
      }
      expect(scratchPolicy.predictAll).not.toHaveBeenCalled();
    });

    it.each(scenario.forms.map(text => ({ text })))('replies locally after an answer to "$text"', async ({ text }) => {
      vi.stubEnv(mannersFlag, value);
      const first = await start(scenario.question);
      expect(first.reply).toContain(scenario.capital);
      const prior = await latestRun(first.id);
      vi.clearAllMocks();

      const next = await send(first.id, text);
      expect(next).toMatchObject({ status: 'idle', question: null, error: null });
      expect(next.messages.slice(first.messages.length)).toEqual([
        expect.objectContaining({ role: 'user', text }),
        expect.objectContaining({ role: 'assistant', text: expect.stringMatching(scenario.language) }),
      ]);
      expect(next.reply.trim().split(/\s+/u).length).toBeLessThanOrEqual(8);
      expect(next.reply).not.toMatch(/[?؟]/u);
      expect(next.reply).not.toContain(scenario.capital);
      const run = await latestRun(next.id);
      expect(run).toMatchObject({ goal: text, status: 'completed', steps: 0, state: {
        routing: { route: 'chat', handler: 'local_conversation' }, agentRun: { modelCalls: 0 },
        requestResolution: { query: null }, requestContext: { topic: prior.state.requestContext.topic },
      } });
      expectNoExternalWork();
    });

    it.each([false, true])(`answers the ${language} follow-up about Spain (prior acknowledgement: %s)`, async priorAcknowledgement => {
      vi.stubEnv(mannersFlag, value);
      const first = await start(scenario.question);
      expect(first.reply).toContain(scenario.capital);
      if (priorAcknowledgement) await send(first.id, language === 'ar' ? 'تمام' : 'got it');
      vi.clearAllMocks();
      const next = await send(first.id, scenario.followUp);
      expect(next).toMatchObject({ status: 'idle', question: null, error: null });
      expect(next.reply).toContain(scenario.nextCapital);
      expect(next.messages.findLast(message => message.role === 'user')?.text).toBe(scenario.followUp);
      const queries = search.mock.calls.map(([query]) => query);
      expect(queries).not.toHaveLength(0);
      for (const query of queries) {
        expect(query).toMatch(scenario.country);
        expect(query).toMatch(scenario.attribute);
        expect(query).not.toMatch(scenario.oldCountry);
      }
      expect(await latestRun(next.id)).toMatchObject({ state: { requestResolution: { kind: 'follow_up' } } });
      expect(modelFetch).not.toHaveBeenCalled();
    });
  }

  it.each([
    { kind: 'approval', decision: 'confirmation' },
    { kind: 'question_card', decision: 'card_answer' },
  ] as const)('classifies تمام as an answer to the active $kind', ({ kind, decision }) => {
    vi.stubEnv(mannersFlag, value);
    const previous = understandTurn(emptyConversationState(), cases.ar.question, 'first').next;
    const pending = withPending(previous, { kind, id: 'active-card' });
    for (const boundAnswer of [false, true]) {
      expect(understandTurn(pending, 'تمام', 'reply', { boundAnswer })).toMatchObject({
        type: 'card_answer', next: { pending: null }, decision: { type: decision, standalone: null },
      });
    }
    if (kind === 'question_card') {
      expect(decideRequestRoute({ text: 'تمام', context: previous.base, pendingQuestion: { id: 'active-card', fields: ['place'] } }))
        .toMatchObject({ route: 'reply', handler: 'resume', publicQuery: null,
          resolution: { kind: 'answer', pendingQuestionId: 'active-card', slots: [] } });
    }
  });

  it.each(['تمام، واسبانيا؟', 'Got it. And Spain?'])('retains the capital query for %s', text => {
    vi.stubEnv(mannersFlag, value);
    const scenario = /\p{Script=Arabic}/u.test(text) ? cases.ar : cases.en;
    const previous = understandTurn(emptyConversationState(), scenario.question, 'first').next;
    const route = decideRequestRoute({ text, context: previous.base, capabilities: { search: true, browser: true } });
    expect(route).toMatchObject({ handler: 'search', resolution: { kind: 'follow_up', original: text } });
    expect(route.publicQuery).toMatch(scenario.country);
    expect(route.publicQuery).toMatch(scenario.attribute);
    expect(route.publicQuery).not.toMatch(scenario.oldCountry);
  });

  it('executes an approval only through the active card and resumes the same run', async () => {
    vi.stubEnv(mannersFlag, value);
    const waiting = await start('احذف ملف old.txt من سطح المكتب');
    expect(waiting.status).toBe('waiting_approval');
    const before = await latestRun(waiting.id);
    expect(execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'file_delete' }),
      expect.objectContaining({ approved: false }));
    await control.approve(owner, waiting.id, { approvalId: waiting.approval!.id, approved: true });
    expect(await settled(waiting.id)).toMatchObject({ status: 'idle', approval: null, error: null });
    expect(await latestRun(waiting.id)).toMatchObject({ id: before.id, status: 'completed' });
    expect(execute).toHaveBeenNthCalledWith(2, expect.objectContaining({ kind: 'file_delete' }),
      expect.objectContaining({ approved: true }));
    expect(search).not.toHaveBeenCalled();
    expect(modelFetch).not.toHaveBeenCalled();
  });

  it('keeps unbound تمام from approving a waiting action', async () => {
    vi.stubEnv(mannersFlag, value);
    const waiting = await start('احذف ملف old.txt من سطح المكتب');
    expect(waiting.status).toBe('waiting_approval');
    await send(waiting.id, 'تمام');
    expect(execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'file_delete' }),
      expect.objectContaining({ approved: false }));
  });

  it('preserves a literal place that also reads like an acknowledgement', () => {
    vi.stubEnv(mannersFlag, value);
    // City spelling from its official website, retrieved 2026-11-27.
    // https://www.nice.fr/
    const place = 'Nice';
    const previous = understandTurn(emptyConversationState(), cases.en.question, 'first').next;
    expect(decideRequestRoute({ text: place, context: previous.base, turnId: 'reply',
      pendingQuestion: { id: 'active-card', fields: ['place'] } })).toMatchObject({
      route: 'reply', handler: 'resume', publicQuery: null,
      resolution: { kind: 'answer', pendingQuestionId: 'active-card',
        slots: [{ kind: 'place', value: place, sourceTurnId: 'reply' }] },
    });
  });

  it('resumes a pending clarification through the same run', async () => {
    vi.stubEnv(mannersFlag, value);
    // Existing missing-reference fixture, retrieved 2026-11-27.
    // https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/tests/assistant-context-chat.test.ts#L151-L153
    const waiting = await start('كم سعره؟');
    expect(waiting.status).toBe('waiting_user');
    const before = await latestRun(waiting.id);
    await control.send(owner, waiting.id, { questionId: waiting.question!.id, text: cases.ar.question });
    const next = await settled(waiting.id);
    expect(next).toMatchObject({ status: 'idle', question: null, error: null });
    expect(next.reply).toContain(cases.ar.capital);
    expect(await latestRun(waiting.id)).toMatchObject({ id: before.id, status: 'completed' });
  });
});
