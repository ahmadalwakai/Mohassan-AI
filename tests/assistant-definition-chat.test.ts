import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentBrowser, SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { judge } from '../apps/server/src/assistant/judge.js';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';

const owner = 'isolated-definition-owner';
const bibliography = 'https://ar.wikipedia.org/wiki/ChatGPT';
const news = 'https://news.example.test/valuation';
const guide = 'https://help.example.test/chatgpt';
const englishGuide = 'https://help.example.test/en/chatgpt';
const definition = 'شات جي بي تي (بالإنجليزية: ChatGPT) هو مساعد محادثة بالذكاء الاصطناعي يجيب عن الأسئلة ويولّد نصوصًا.';
const pages: Record<string, { title: string; text: string }> = {
  [bibliography]: { title: 'ChatGPT - ويكيبيديا', text: 'المراجع\n١. «ChatGPT وتطبيقاته في التعليم والكتابة الأكاديمية الحديثة».\n٢. «كيف أعاد ChatGPT تشكيل صناعة البرمجيات العالمية».\n٣. «ChatGPT هو أبرز أسباب ارتفاع تقييم الشركة».' },
  [news]: { title: 'ChatGPT وتقييم الشركة', text: 'ارتفع تقييم الشركة المطوّرة لخدمة ChatGPT بعد جولة تمويل جديدة شارك فيها عدة مستثمرين.\nناقش المستثمرون أثر نمو ChatGPT على خطط تمويل الشركة.' },
  [guide]: { title: 'دليل ChatGPT', text: `دليل ChatGPT ${definition} ناقش المحللون أثر انتشار ChatGPT على تقييم الشركة بعد جولة تمويل جديدة.` },
  [englishGuide]: { title: 'ChatGPT guide', text: 'ChatGPT is an AI chatbot.' },
};

describe('a definition through the chat controller', () => {
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let control: Awaited<ReturnType<typeof createCommandChatControl>>;
  let results: string[];

  beforeAll(async () => {
    database = await createDatabase();
    await migrate(database.db);
    const browser = {
      setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; }, async close() {},
      async act() { throw new Error('The definition fixtures should be read without a browser.'); },
    } as unknown as AgentBrowser;
    const searchProvider: SearchProvider = {
      name: 'isolated-definition-search',
      async search() {
        return results.map(url => ({ url, title: pages[url].title, snippet: pages[url].title }));
      },
    };
    control = await createCommandChatControl(database.db, {
      browser, searchProvider, models: { fast: [], deep: [], vision: '' }, recordExperiences: false,
      judgeShadow: { logFile: '', observe: judge, async flush() {} }, judgeFixForOwner: true, judgeWithholdForOwner: true,
      readPage: async url => pages[url] ? { ...pages[url], url, status: 200 } : null,
    });
  });

  afterAll(async () => { await control?.shutdown(); await database?.close(); });

  async function ask() {
    const { id } = await control.create(owner, { goal: 'ما هو ChatGPT' });
    await control.settled(id);
    const detail = await control.detail(owner, id);
    const run = await database.db.selectFrom('chat_runs').select('status').where('conversation_id', '=', id).executeTakeFirstOrThrow();
    expect(detail.error).toBeNull();
    return { reply: detail.messages.filter(message => message.role === 'assistant').at(-1)?.text ?? '', status: run.status };
  }

  it('answers in Arabic from the defining passage, despite bibliography and news results ranking ahead of it', async () => {
    results = [bibliography, news, guide];
    const { reply, status } = await ask();
    expect(reply.split('\n')[0]).toBe(definition);
    expect(reply).toContain(`](${guide})`);
    expect(reply).not.toMatch(/الأكاديمية|تقييم الشركة|\/valuation/u);
    expect(reply).not.toContain(bibliography);
    expect(status).toBe('completed');
  });

  it('reports a partial result when the only evidence is bibliography and news', async () => {
    results = [bibliography, news];
    const { reply, status } = await ask();
    expect(reply).toContain('لم أجد');
    expect(reply).not.toContain('**المصدر:**');
    expect(reply).not.toMatch(/الأكاديمية|تقييم الشركة/u);
    expect(status).toBe('partial');
  });

  it('uses the Arabic definition when an English definition ranks before it', async () => {
    results = [englishGuide, guide];
    const { reply, status } = await ask();
    expect(reply.split('\n')[0]).toBe(definition);
    expect(reply).toContain(`](${guide})`);
    expect(reply).not.toContain(englishGuide);
    expect(status).toBe('completed');
  });

  it('explains the language limitation if the only direct definition is in English', async () => {
    results = [englishGuide];
    const { reply, status } = await ask();
    expect(reply).toContain('تعريفًا مباشرًا بالعربية');
    expect(reply).not.toContain(englishGuide);
    expect(status).toBe('partial');
  });
});
