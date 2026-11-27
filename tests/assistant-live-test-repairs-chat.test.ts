import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AgentAction, AgentBrowser, AgentPage, SearchHit, SearchOutcome, SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import { createSkillReader, type SkillReaderCandidate } from '../apps/server/src/assistant/skill-reader.js';

/**
 * The live functional test of 2026-11-23, case by case, through the real chat controller with no model (as production
 * runs). Only the edges are stand-ins: the browser page, the search provider, the page reader and the skill store. The
 * wordings beyond the live ones, the operands and the pages are this test's own.
 */
const OWNER = 'isolated-live-repairs-owner';
const OTHER_OWNER = 'isolated-live-repairs-other-owner';
const exampleDomain: AgentPage = {
  id: 'https://example.com/', url: 'https://example.com/', title: 'Example Domain', hash: 'example-domain',
  // The browser joins a page's text into one line (agent-browser.ts clean()); the live example.com read this way.
  text: 'Example Domain This domain is for use in documentation examples without needing permission. Avoid use in operations. Learn more',
  elements: [{ ref: 'a1', role: 'link', label: 'Learn more', href: 'https://iana.org/domains/example', inViewport: true }],
  signals: { captcha: false, password: false, otp: false, card: false }, scroll: { top: 0, height: 600, viewport: 600 },
  observedAt: '2026-11-23T03:00:00.000Z', documentStatus: 200,
};
const pages: Record<string, { title: string; text: string }> = {
  'https://en.wikipedia.org/wiki/rain': { title: 'Rain - Wikipedia', text: 'Rain is water droplets that have condensed from atmospheric water vapor.\nRain falls because the water droplets in a cloud grow too heavy for the rising air to hold them up.\nRain is a major component of the water cycle.\n' },
  'https://www.iana.org/help/example-domains': { title: 'Example Domains', text: 'Example Domains\nAs described in RFC 2606 and RFC 6761, a number of example domains such as example.com and example.org are maintained by IANA for documentation purposes.\nThese domains may be used as illustrative examples in documents without prior coordination with us.\n' },
  'https://en.wikipedia.org/wiki/Reserved_top-level_domains': { title: 'Reserved top-level domains - Wikipedia', text: 'Reserved top-level domains are domain names set aside for testing and documentation.\nThe reserved test domains include .test, .example, .invalid and .localhost.\n' },
};
const softwareTesting: SkillReaderCandidate = {
  id: 'skill-software-testing', slug: 'software-testing', name: 'اختبارات الكود والبرمجيات', category: 'engineering', version: '1.1.0', contentHash: 'a'.repeat(64),
  description: 'Writing, choosing and fixing automated tests: unit tests, integration tests, end-to-end tests, QA test plans and flaky tests.',
};

describe('the live functional test of 2026-11-23, through the real chat controller', () => {
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let control: Awaited<ReturnType<typeof createCommandChatControl>>;
  const current = new Map<string, AgentPage>();
  const actions: AgentAction[] = [];
  const queries: string[] = [];
  const reads: string[] = [];
  let searchMode: 'pages' | 'failed' | 'empty' = 'pages';

  beforeAll(async () => {
    database = await createDatabase();
    await migrate(database.db);
    const browser = {
      setCheckpointStore() {}, async bindAccount() {},
      async hasPage(_owner: string, id: string) { return current.has(id); },
      async observe(_owner: string, id: string) { return { page: current.get(id)!, changed: false }; },
      async act(_owner: string, id: string, action: AgentAction) {
        actions.push(action);
        if (action.kind !== 'open' || new URL(action.text!).href !== exampleDomain.url) throw new Error(`Unexpected browser action: ${action.kind} ${action.text ?? ''}`);
        current.set(id, exampleDomain);
        return { page: exampleDomain, changed: true };
      },
      async close() {},
    } as unknown as AgentBrowser;
    const hitsFor = (query: string): SearchHit[] => /reserved test domains/iu.test(query)
      ? [{ title: 'Reserved top-level domains', url: 'https://en.wikipedia.org/wiki/Reserved_top-level_domains', snippet: 'reserved test domains such as .test and .example' }]
      : /iana|example domains/iu.test(query)
      ? [{ title: 'Example Domains', url: 'https://www.iana.org/help/example-domains', snippet: 'example domains such as example.com are maintained by IANA for documentation purposes' }]
      : /rain/iu.test(query) ? [{ title: 'Rain', url: 'https://en.wikipedia.org/wiki/rain', snippet: 'Rain is water droplets' }] : [];
    // The shared engine's own outcome shape: the chat reads `execute` to tell failed providers from an empty answer.
    const searchProvider: SearchProvider & { execute(query: string): Promise<SearchOutcome> } = {
      name: 'isolated-live-repairs-search',
      async search(query) { queries.push(query); return hitsFor(query); },
      async execute(query) {
        queries.push(query);
        const hits = searchMode === 'pages' ? hitsFor(query).map((hit, at) => ({ ...hit, providers: ['isolated'], score: 10 - at, sourceRank: at })) : [];
        return { hits, fetchedAt: new Date().toISOString(), freshness: 'fresh', coverage: 'specialized_sources', limitations: [],
          failures: searchMode === 'failed' ? [{ provider: 'Wikipedia', kind: 'unavailable' }, { provider: 'Stack Exchange', kind: 'rate_limited' }] : [] } as unknown as SearchOutcome;
      },
    };
    const skillAnswer = createSkillReader({
      candidates: async () => [softwareTesting],
      instructions: async () => 'Write, choose and fix automated tests.\n1. Test behaviour, not implementation.\n2. Many fast unit tests, fewer integration tests.\nAnswer shape: a short test plan.',
    });
    control = await createCommandChatControl(database.db, {
      browser, models: { fast: [], deep: [], vision: '' }, searchProvider, skillAnswer, recordExperiences: false,
      readPage: async url => { reads.push(url); const page = pages[url]; return page ? { url, title: page.title, text: page.text, status: 200 } : null; },
    });
  });
  afterAll(async () => { await control?.shutdown(); await database?.close(); });
  beforeEach(() => { actions.length = 0; queries.length = 0; reads.length = 0; searchMode = 'pages'; });

  async function ask(goal: string, owner = OWNER) {
    const { id } = await control.create(owner, { goal });
    return result(id, owner);
  }
  async function follow(id: string, text: string, owner = OWNER) {
    await control.send(owner, id, { text });
    return result(id, owner);
  }
  async function answer(id: string, text: string, owner = OWNER) {
    const detail = await control.detail(owner, id);
    await control.send(owner, id, { text, questionId: detail.question!.id });
    return result(id, owner);
  }
  async function result(id: string, owner = OWNER) {
    await control.settled(id);
    const detail = await control.detail(owner, id);
    const run = await database.db.selectFrom('chat_runs').select(['status', 'state']).where('conversation_id', '=', id).orderBy('created_at', 'desc').executeTakeFirstOrThrow();
    const trail = ((run.state?.trail ?? []) as { action: string; result: string }[]);
    return { id, detail, status: run.status, trail, reply: detail.messages.filter(message => message.role === 'assistant').at(-1)?.text ?? '' };
  }

  it('A: calculates 37 × 24 as 888', async () => {
    const { reply, status } = await ask('Calculate 37 × 24.');
    expect(reply).toBe('37 * 24 = 888');
    expect(status).toBe('completed');
  });

  it('B: the request with a «QA test» label is still calculated, in one Arabic sentence, and no skill answers it', async () => {
    const { reply, status, trail } = await ask('QA test 2026-11-23: Calculate 37 × 24 and reply with the result in one short Arabic sentence.');
    expect(reply).toBe('ناتج 37 × 24 هو 888.');
    expect(status).toBe('completed');
    expect(trail.map(entry => entry.action)).toEqual(['calculate']);
    expect(reply).not.toContain('اختبارات الكود');
  });

  it('B: other labels, operands and languages follow the same rule', async () => {
    expect((await ask('Test case 7: compute 19 * 21 and answer in one short English sentence.')).reply).toBe('19 × 21 equals 399.');
    expect((await ask('اختبار ٥: احسب ١٢ × ٩ وأجب بجملة إنجليزية قصيرة')).reply).toBe('12 × 9 equals 108.');
    expect((await ask('QA check: what is 45 / 9? Answer in Arabic.')).reply).toBe('ناتج 45 ÷ 9 هو 5.');
  });

  it('B: a genuine question about software testing still reads the software-testing skill', async () => {
    const { reply, trail, status } = await ask('How do I write good unit tests in Python?');
    expect(trail.find(entry => entry.action === 'skill_read')?.result).toMatch(/^software-testing 1\.1\.0/u);
    expect(reply).toContain('اختبارات الكود والبرمجيات');
    expect(status).toBe('completed');
  });

  it('C: «Add 12 to your previous result» after 888 gives 900, from this conversation', async () => {
    const first = await ask('Calculate 37 × 24.');
    const next = await follow(first.id, 'Add 12 to your previous result.');
    expect(next.reply).toBe('12 + 888 = 900\n888 is the previous result in this conversation (37 * 24 = 888).');
    expect(next.status).toBe('completed');
    // And the chain goes on from the new result.
    const third = await follow(first.id, 'Multiply it by 2');
    expect(third.reply).toBe('900 * 2 = 1800\n900 is the previous result in this conversation (12 + 888 = 900).');
  });

  it('C: the same in Arabic, with other operands', async () => {
    const first = await ask('احسب 15 × 4');
    expect(first.reply).toBe('15 * 4 = 60');
    const next = await follow(first.id, 'أضف 5 إلى النتيجة السابقة');
    expect(next.reply).toBe('5 + 60 = 65\n60 هو الناتج السابق في هذه المحادثة (15 * 4 = 60).');
  });

  it('C: a fresh conversation asks which result is meant, never borrows another conversation’s, and finishes with the number given', async () => {
    await ask('Calculate 37 × 24.');
    const fresh = await ask('Add 12 to your previous result.');
    expect(fresh.detail.status).toBe('waiting_user');
    expect(fresh.detail.question?.prompt).toContain('Which result do you mean by “your previous result”?');
    expect(fresh.reply).not.toContain('900');
    const finished = await answer(fresh.id, '888');
    expect(finished.reply).toBe('12 + 888 = 900\n888 is the number you gave.');
    expect(finished.status).toBe('completed');
    // Another account with its own conversation is asked too.
    const other = await ask('Add 12 to your previous result.', OTHER_OWNER);
    expect(other.detail.status).toBe('waiting_user');
    const unreadable = await answer(other.id, 'the big one', OTHER_OWNER);
    expect(unreadable.reply).toContain('I could not read a number');
    expect(unreadable.status).toBe('blocked');
  });

  it('C: a request that names «it» but is no calculation is not asked about a result', async () => {
    const { detail } = await ask('Add 2 eggs to it');
    expect(detail.question?.prompt ?? '').not.toContain('Which result do you mean');
  });

  it('G: «Explain why rain falls in two short Arabic sentences» is searched, not refused as private', async () => {
    const { reply, status, detail } = await ask('Explain why rain falls in two short Arabic sentences.');
    expect(detail.error).toBeNull();
    expect(queries[0]).toBe('why rain falls');
    expect(reply).not.toContain('I did not search the web');
    expect(reply).toMatch(/^Rain falls because the water droplets in a cloud grow too heavy/u);
    // The page is English: the reply says so and the task is partial, not presented as an Arabic answer.
    expect(reply).toContain('You asked for the answer in Arabic, but the source I read is written in English');
    expect(status).toBe('partial');
  });

  it('H: an encyclopedia article is not the official page the request asked for, and the reply says so', async () => {
    const { reply, status } = await ask('Search the web for the official list of reserved test domains. Return the page title and source link.');
    expect(reply).toMatch(/^\*\*Page title:\*\* Reserved top-level domains\n\*\*Source link:\*\* https:\/\/en\.wikipedia\.org\/wiki\/Reserved_top-level_domains\n/u);
    expect(reply).toContain('This is not the organisation’s own page');
    expect(status).toBe('partial');
  });

  it('G: a question about the owner’s own account is still not searched', async () => {
    const { reply } = await ask('Explain why my account was blocked');
    expect(queries).toEqual([]);
    expect(reply).not.toContain('Rain');
  });

  it('H: the search is for the subject only, and the reply names the read page’s title and link', async () => {
    const { reply, status } = await ask('Search the web for the official IANA documentation about example domains. Return the page title and source link.');
    expect(queries[0]).toBe('the official IANA documentation about example domains');
    expect(reply).toBe('**Page title:** Example Domains\n**Source link:** https://www.iana.org/help/example-domains');
    expect(reads).toContain('https://www.iana.org/help/example-domains');
    expect(status).toBe('completed');
  });

  it('H: providers that did not answer are a failed request, and an empty answer is said to be one', async () => {
    searchMode = 'failed';
    const failed = await ask('Search the web for the official IANA documentation about example domains. Return the page title and source link.');
    expect(failed.reply).toContain('This is a failed request, not a search without results');
    expect(failed.reply).toContain('Wikipedia: unavailable');
    expect(failed.status).toBe('blocked');
    searchMode = 'empty';
    const empty = await ask('Search the web for the official IANA documentation about example domains. Return the page title and source link.');
    expect(empty.reply).toContain('I found no results relevant to');
    expect(empty.reply).not.toContain('failed request');
  });

  it('F: opens the page and reports its heading and first sentence from the live page', async () => {
    const { reply, status } = await ask('Open https://example.com/ and report the page heading and the first sentence from the live page.');
    expect(actions.map(action => action.kind)).toEqual(['open']);
    expect(reply).toBe('From **Example Domain** (example.com):\n\nMain heading:\n> Example Domain\n\nFirst sentence on the page:\n> This domain is for use in documentation examples without needing permission.');
    expect(status).toBe('completed');
  });

  it('I: the conversation list and detail report what this session can do, without a model', async () => {
    const listed = await control.list(OWNER);
    expect(listed.configured).toBe(false);
    expect(listed.capabilities).toMatchObject({ chatModel: false });
    expect(listed.capabilities.available).toEqual(expect.arrayContaining(['computation', 'web', 'browser', 'skills', 'planner', 'letters']));
    expect(listed.capabilities.available).not.toContain('documents');
    const { detail } = await ask('Calculate 2 + 2.');
    expect(detail.capabilities).toEqual(listed.capabilities);
  });
});
