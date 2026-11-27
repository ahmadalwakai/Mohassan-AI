import { expect, it, vi } from 'vitest';
import type { AgentBrowser, AgentPage, SearchHit } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { articleUrl, runHands, webQuestion, type HandsIO, type HandsRead } from '../apps/server/src/assistant/hands.js';
import { judge } from '../apps/server/src/assistant/judge.js';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';

// Caldrin, its page text and the hosts in this test are synthetic.
const title = 'Caldrin';
const question = `What is ${title}?`;
const named = articleUrl(title, 'en');
const quote = 'Caldrin is a fictional workshop where glass lanterns are assembled by hand.';
const hit = (url: string, heading = title): SearchHit => ({ url, title: heading, snippet: heading });

function harness(hits: SearchHit[], answer?: SearchHit) {
  const read = vi.fn(async (url: string): Promise<HandsRead> => {
    if (url !== answer?.url) return { kind: 'rate-limited', retryAfterMs: 60_000 };
    const page: AgentPage = {
      id: url, url, title: answer.title, text: quote, elements: [],
      signals: { captcha: false, password: false, otp: false, card: false },
      scroll: { top: 0, height: 0, viewport: 0 }, hash: url,
      documentStatus: 200, observedAt: new Date(0).toISOString(),
    };
    return { kind: 'page', page };
  });
  const act = vi.fn(async () => { throw new Error('Unexpected hidden browser action'); });
  const complete = vi.fn(async () => {});
  const io: HandsIO = {
    read, act, complete, search: async () => hits, page: async () => null, prepare: async () => null,
    settle: async page => page, pause: async () => {}, step: async () => {}, approve: async () => {}, hold: async () => {},
  };
  return { io, act, read, complete };
}

it('skips rate-limited pages and reads the next result without opening the browser', async () => {
  const busy = ['one', 'two', 'three'].map(name => hit(`https://${name}.example/caldrin`));
  const answer = hit('https://workshop.example/caldrin');
  const { io, act, read } = harness([hit(named), ...busy, answer], answer);

  const outcome = await runHands({ steps: webQuestion(question)!, next: 0 }, io);

  expect(outcome).toMatchObject({ kind: 'done', status: 'completed', text: expect.stringContaining(quote) });
  expect(read.mock.calls.flat()).toEqual([named, ...busy.map(item => item.url), answer.url]);
  expect(act).not.toHaveBeenCalled();
});

it.each([
  { query: question, hits: [hit(named)], message: 'temporarily busy and limiting requests' },
  { query: 'ما هي كالدرين؟', hits: [], message: 'مشغولة مؤقتًا وتحدّ من الطلبات' },
])('reports unavailable reads in the question language for $query', async ({ query, hits, message }) => {
  const { io, act, read, complete } = harness(hits);

  const outcome = await runHands({ steps: webQuestion(query)!, next: 0 }, io);

  expect(outcome).toMatchObject({ kind: 'done', status: 'partial', text: expect.stringContaining(message), rateLimited: true });
  expect(read).toHaveBeenCalledTimes(1);
  expect(act).not.toHaveBeenCalled();
  expect(complete).toHaveBeenCalledWith(0, 'partial');
});

it('reports the busy results when the speculative article address had no page', async () => {
  const result = hit('https://workshop.example/caldrin');
  const { io, act, read } = harness([result]);
  read.mockResolvedValueOnce({ kind: 'unreadable' });

  const outcome = await runHands({ steps: webQuestion(question)!, next: 0 }, io);

  expect(outcome).toMatchObject({ kind: 'done', status: 'partial', text: expect.stringContaining('temporarily busy and limiting requests') });
  expect(read.mock.calls.flat()).toEqual([named, result.url]);
  expect(act).not.toHaveBeenCalled();
});

it('passes a typed 429 through chat and preserves the busy reply when sources cannot answer', async () => {
  const database = await createDatabase();
  let control: Awaited<ReturnType<typeof createCommandChatControl>> | undefined;
  const owner = 'web-evidence-rate-limit-owner';
  const busy = hit('https://busy.example/caldrin');
  const answer = hit('https://workshop.example/caldrin');
  const secondSubject = 'Brindle';
  const secondBusy = hit('https://busy.example/brindle', secondSubject);
  const secondQuestion = `What is ${secondSubject}?`;
  const busyText = 'temporarily busy and limiting requests';
  const act = vi.fn(async () => { throw new Error('Unexpected hidden browser action'); });
  const deliberate = vi.fn(async () => { throw new Error('Unexpected model invocation'); });
  const observe = vi.fn(judge);
  const browser = {
    setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; },
    async observe() { throw new Error('Unexpected hidden browser observation'); }, act, async close() {},
  } as unknown as AgentBrowser;
  const readPage = vi.fn(async (url: string) => url === answer.url
    ? { url, title, text: quote, status: 200, fetchedAt: new Date(0).toISOString() }
    : { kind: 'rate-limited' as const, retryAfterMs: 60_000 });

  try {
    await migrate(database.db);
    control = await createCommandChatControl(database.db, {
      models: { fast: [], deep: [], vision: '' }, browser, readPage,
      searchProvider: { name: 'synthetic-search', search: async query => /brindle/iu.test(query) ? [secondBusy] : [busy, answer] },
      judgeShadow: { logFile: 'unused-fixture-path', observe, async flush() {} }, judgeWithholdForOwner: true,
      modelCouncil: { deliberate },
    });
    const { id } = await control.create(owner, { goal: question });
    await control.settled(id);
    const detail = await control.detail(owner, id);

    expect(detail.error).toBeNull();
    expect(detail.messages.at(-1)?.text).toContain(quote);
    expect(detail.browser).toBeNull();
    expect(readPage.mock.calls.map(([url]) => url)).toEqual([named, busy.url, answer.url]);

    deliberate.mockClear();
    const allBusy = await control.create(owner, { goal: secondQuestion });
    await control.settled(allBusy.id);
    const allBusyDetail = await control.detail(owner, allBusy.id);
    expect(allBusyDetail.error).toBeNull();
    expect(allBusyDetail.messages.at(-1)?.text).toContain(busyText);
    expect(deliberate).not.toHaveBeenCalled();

    const compound = await control.create(owner, { goal: `${question} Then ${secondQuestion.toLowerCase()}` });
    await control.settled(compound.id);
    const compoundDetail = await control.detail(owner, compound.id);
    expect(compoundDetail.error).toBeNull();
    expect(compoundDetail.messages.at(-1)?.text).toContain(quote);
    expect(compoundDetail.messages.at(-1)?.text).toContain(busyText);
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ reply: expect.stringContaining(busyText), status: 'partial' }));
    expect(act).not.toHaveBeenCalled();
  } finally {
    await control?.shutdown();
    await database.close();
  }
});
