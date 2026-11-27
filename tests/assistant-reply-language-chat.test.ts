import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BrowserEngine, BrowserError, SafeNetwork, SearchEngine, SearchProviderFailure,
  type AgentBrowser, type SearchOutcome, type SearchProvider,
} from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import { mergePublicQueryTerms } from '../apps/server/src/assistant/public-query-provenance.js';
import { replyLanguage } from '../apps/server/src/assistant/reply-check.js';

const owner = 'isolated-reply-language-owner';
const languages = [
  { lang: 'en', web: 'What is the capital of Japan?', lookup: 'Search for capital of Japan', recall: 'From my memory, return my home city only.' },
  { lang: 'ar', web: 'ما عاصمة اليابان؟', lookup: 'ابحث عن عاصمة اليابان', recall: 'من ذاكرتي، ما مدينتي المفضلة؟ أعد المدينة فقط.' },
] as const;
const searchCases = [...languages, { lang: 'ar', web: 'ابحث عن capital of Japan' }] as const;
type Language = typeof languages[number]['lang'];
type Control = Awaited<ReturnType<typeof createCommandChatControl>>;

// The English wording is exercised alongside the fixed Arabic messages from the production revision.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/command-chat.ts#L4062-L4065 (retrieved 2026-11-27)
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/packages/browser/src/engine.ts#L120 (retrieved 2026-11-27)
const terminalText = {
  en: { unexpected: /something went wrong/iu, stale: /session.*(?:ended|expired)/iu },
  ar: { unexpected: /حدث خطأ أثناء العمل/u, stale: /انتهت جلسة التشغيل/u },
};

function expectLanguage(text: string, lang: Language, expected: RegExp) {
  expect(text).toMatch(expected);
  expect(replyLanguage(text).replyLang).toBe(lang);
  if (lang === 'en') expect(text).not.toMatch(/\p{Script=Arabic}/u);
}

function assistantText(result: Awaited<ReturnType<Control['detail']>>) {
  return result.messages.filter(message => message.role === 'assistant').at(-1)?.text ?? '';
}

describe('fixed replies through the chat controller', () => {
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let control: Control;
  let memoryControl: Control;
  let bindBrowser: AgentBrowser['bindAccount'];
  let actBrowser: AgentBrowser['act'];
  let search: SearchProvider;
  let memoryEvidence: string[];
  const browserEngine = new BrowserEngine();
  const unavailable = async () => { throw new Error('Unexpected fixture operation'); };
  const noSearch = { name: 'fixture', search: unavailable };
  const proposedCity = 'Unrecorded city';

  beforeAll(async () => {
    actBrowser = unavailable;
    database = await createDatabase({});
    await migrate(database.db);
    const browser = {
      setCheckpointStore() {},
      async bindAccount(ownerId: string, id: string, account: string | null) { await bindBrowser(ownerId, id, account); },
      async hasPage() { return false; },
      async close() {},
      act: (...args: Parameters<AgentBrowser['act']>) => actBrowser(...args),
    } as unknown as AgentBrowser;
    const execute = async (...args: Parameters<SearchEngine['execute']>): Promise<SearchOutcome> => {
      if (!(search instanceof SearchEngine)) throw new Error('Expected an isolated search engine');
      return search.execute(...args);
    };
    control = await createCommandChatControl(database.db, {
      browser,
      models: { fast: [], deep: [], vision: '' },
      searchProvider: { name: 'fixture', search: (...args) => search.search(...args), execute } as SearchProvider,
      recordExperiences: false,
    });
    const model = 'reply-language-fixture';
    memoryControl = await createCommandChatControl(database.db, {
      browser,
      models: { fast: [model], deep: [model], vision: '' },
      createProvider: () => ({ id: model, async generate() {
        return {
          model, usage: { inputTokens: 0, outputTokens: 0 },
          text: JSON.stringify({ tool: 'answer', text: proposedCity, outcome: 'done', thought: null, plan: null,
            note: null, url: null, ref: null, submit: null, options: null, sensitive: null }),
        };
      } }),
      tools: { memory: { async search() { return { text: memoryEvidence.join('\n'), evidence: memoryEvidence }; }, save: unavailable } },
      searchProvider: noSearch,
      recordExperiences: false,
    });
  });

  afterAll(async () => {
    await memoryControl?.shutdown();
    await control?.shutdown();
    await database?.close();
  });

  async function run(chat: Control, goal: string) {
    const { id } = await chat.create(owner, { goal });
    await chat.settled(id);
    return chat.detail(owner, id);
  }

  it.each(languages)('publishes the $lang browser failure from an expired session', async ({ lang, web }) => {
    bindBrowser = async (_owner, id) => { await browserEngine.observe(id); };
    search = noSearch;
    const result = await run(control, web);
    expect(result.status).toBe('failed');
    expectLanguage(result.error ?? '', lang, terminalText[lang].stale);
  });

  // https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/packages/browser/src/agent-browser.ts#L626 (retrieved 2026-11-27)
  it.each([
    { lang: 'en', goal: 'Open https://example.com/', guidance: /check that Chromium is installed/iu },
    { lang: 'ar', goal: 'افتح https://example.com/', guidance: /(?:ثبّت|تثبيت) كروميوم/u },
  ] as const)('keeps the browser installation guidance in $lang for a bare AgentBrowser error', async ({ lang, goal, guidance }) => {
    bindBrowser = async () => {};
    search = noSearch;
    const installCommand = 'npx playwright install chromium';
    const diagnostic = `تعذر تشغيل المتصفح. ثبّت Chromium بالأمر: ${installCommand}`;
    const failure = new BrowserError('AGENT_BROWSER_UNAVAILABLE', diagnostic, 503);
    actBrowser = async (_owner, _id, action) => {
      expect(action.kind).toBe('open');
      throw failure;
    };
    try {
      const result = await run(control, goal);
      expect(result.status).toBe('failed');
      const reply = result.error ?? '';
      expect(reply).toContain(`\`${installCommand}\``);
      expectLanguage(reply, lang, guidance);
      expect(failure).toMatchObject({ code: 'AGENT_BROWSER_UNAVAILABLE', message: diagnostic, statusCode: 503 });
    } finally {
      actBrowser = unavailable;
    }
  });

  it.each(languages)('publishes the $lang generic failure for an unexpected exception', async ({ lang, web }) => {
    bindBrowser = unavailable;
    search = noSearch;
    const result = await run(control, web);
    expect(result.status).toBe('failed');
    expectLanguage(result.error ?? '', lang, terminalText[lang].unexpected);
  });

  // These requests explicitly opt in to scalar recall, so they reach the configured-model memory boundary.
  // https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/command-chat.ts#L3711-L3731 (retrieved 2026-11-27)
  it.each(languages)('publishes the $lang memory progress and empty-result reply', async ({ lang, recall }) => {
    bindBrowser = async () => {};
    memoryEvidence = [];
    const result = await run(memoryControl, recall);
    expect(result.error).toBeNull();
    const progress = result.steps.find(step => /searching memory|البحث في الذاكرة/iu.test(step.text));
    expectLanguage(progress?.text ?? '', lang, lang === 'ar' ? /البحث في الذاكرة/u : /searching memory/iu);
    expectLanguage(assistantText(result), lang, lang === 'ar' ? /لم أجد في الذاكرة/u : /find a matching value in memory/iu);
  });

  it.each(languages)('publishes the $lang memory reply when the proposed value cannot be verified', async ({ lang, recall }) => {
    bindBrowser = async () => {};
    memoryEvidence = [lang === 'ar' ? 'مدينتي المفضلة هي مسقط.' : 'My home city is Bristol.'];
    const result = await run(memoryControl, recall);
    expect(result.error).toBeNull();
    expectLanguage(assistantText(result), lang, lang === 'ar' ? /لم أتمكن من التحقق من قيمة مطابقة/u : /verify a matching value in memory/iu);
  });

  // https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/command-chat.ts#L3187 (retrieved 2026-11-27)
  it.each(searchCases)('renders provider failure kinds in $lang for $web', async ({ lang, web }) => {
    bindBrowser = async () => {};
    const reasons = ['rate_limited', 'invalid_response', 'unavailable'] as const;
    const names = lang === 'ar' ? ['المصدر الأول', 'المصدر الثاني', 'المصدر الثالث'] : ['Source one', 'Source two', 'Source three'];
    search = new SearchEngine(new SafeNetwork(), {
      providers: reasons.map((reason, index) => ({
        name: names[index]!, coverage: 'web', accessBasis: 'documented_api', supports: () => true,
        async search() { throw new SearchProviderFailure(reason); },
      })),
    });
    const result = await run(control, web);
    expect(result.error).toBeNull();
    const reply = assistantText(result);
    expectLanguage(reply, lang, lang === 'ar' ? /تعذّر البحث/u : /the search.*failed/iu);
    for (const name of names) expect(reply).toContain(name);
    if (lang === 'ar') {
      expect(reply).not.toMatch(/rate[ _]limited|invalid[ _]response|unavailable/iu);
      for (const phrase of ['تجاوز حد الطلبات', 'استجابة غير صالحة', 'غير متاح']) expect(reply).toContain(phrase);
    } else {
      for (const phrase of ['rate limited', 'invalid response', 'unavailable']) expect(reply).toContain(phrase);
    }
  });

  // https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/command-chat.ts#L3191 (retrieved 2026-11-27)
  it.each(languages)('passes the $lang indexed copy label with its fetch date to Hands', async ({ lang, lookup }) => {
    bindBrowser = async () => {};
    const fetchedAt = new Date().toISOString();
    const title = lang === 'ar' ? 'عاصمة اليابان' : 'Capital of Japan';
    const snippet = lang === 'ar' ? 'طوكيو عاصمة اليابان.' : 'Tokyo is the capital of Japan.';
    search = new SearchEngine(new SafeNetwork(), {
      providers: [], localIndex: { name: 'fixture index', async search() {
        return [{ title, snippet, url: 'https://example.com/japan', coverage: 'local_only', freshness: 'indexed_snapshot',
          fetchedAt, expiresAt: fetchedAt, contentHash: '', sourceHash: '', trust: 'untrusted' }];
      } },
    });
    const result = await run(control, lookup);
    expect(result.error).toBeNull();
    // The chat stores the observed snippet as normalized public query terms. Inspect that consumer of the formatter.
    const { state } = await database.db.selectFrom('chat_runs').select('state').where('conversation_id', '=', result.id).executeTakeFirstOrThrow();
    const label = lang === 'ar' ? 'نسخة مفهرسة بتاريخ' : 'indexed copy from';
    const otherLabel = lang === 'ar' ? 'indexed copy from' : 'نسخة مفهرسة بتاريخ';
    expect(state.publicQueryTerms).toEqual(expect.arrayContaining(mergePublicQueryTerms([], [`${label} ${fetchedAt}. ${snippet}`])));
    expect(state.publicQueryTerms).not.toEqual(expect.arrayContaining(mergePublicQueryTerms([], [otherLabel])));
  });
});
