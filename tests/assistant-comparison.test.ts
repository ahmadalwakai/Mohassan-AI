import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AgentBrowser, type SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import { comparePages, comparisonQuestion } from '../apps/server/src/assistant/comparison.js';
import { judge } from '../apps/server/src/assistant/judge.js';

const owner = 'isolated-comparison-owner';
const sources = [
  { name: 'مصر', text: 'تبلغ مساحة مصر الإجمالية 1,001,450 كيلومتر مربع. يمر نهر النيل عبر مصر.' },
  { name: 'السعودية', text: 'تبلغ مساحة السعودية الإجمالية 2.15 مليون كيلومتر مربع. تقع السعودية في شبه الجزيرة العربية.' },
  { name: 'Bill Gates', text: 'Bill Gates was born on October 28, 1955. He co-founded Microsoft in 1975.' },
  { name: 'Steve Jobs', text: 'Steve Jobs was born on February 24, 1955. He co-founded Apple in 1976.' },
  { name: 'ألمانيا', text: 'يبلغ عدد سكان ألمانيا 84 مليون نسمة. تقع ألمانيا في وسط أوروبا.' },
  { name: 'فرنسا', text: 'يبلغ عدد سكان فرنسا 68 مليون نسمة. تقع فرنسا في غرب أوروبا.' },
  { name: 'Carter', text: 'Carter Inc. was founded in 1994. Carter employed 6,000 people in 2020.' },
  { name: 'Denton', text: 'The Denton plant employs 80 people. Denton Inc. operates facilities at several other sites.' },
  { name: 'Jupiter', text: 'Jupiter has 95 moons. It is a gas giant in the outer solar system.' },
  { name: 'Mars', text: 'Mars has 2 moons. It is a rocky planet in the solar system.' },
].map((source, index) => ({ ...source, url: `https://reference.test/article-${index}` }));

describe('comparison evidence', () => {
  it.each([
    ['Which has more moons, Earth or Mars?', 'Earth and its environment are being monitored by a mission that discovered 50 moons near Saturn.', 'Mars has 2 moons.'],
    ['Which is older, Alpha or Beta?', 'Alpha was not founded in 1900.', 'Beta was founded in 1950.'],
    ['Which is bigger, Alpha or Beta?', 'Alpha reported that its neighbor has an area of 7 square kilometres.', 'Beta covers an area of 5 square kilometres.'],
  ])('ignores the unsupported operand in %s', (question, left, right) => {
    const comparison = comparisonQuestion(question)!;
    const pages = [left, right].map((text, index) => ({ text, title: comparison.subjects[index]!, url: `https://reference.test/subject-${index}` }));
    expect(comparePages(comparison, pages, 'en')).toBeNull();
  });

  it('answers a size comparison when matching dimensions agree and declines when they disagree', () => {
    const question = comparisonQuestion('Which is bigger, Alpha or Beta?')!;
    const first = { title: 'Alpha', url: 'https://reference.test/alpha', text: 'Alpha has a length of 5 metres. Alpha has a mass of 10 kilograms.' };
    const second = { title: 'Beta', url: 'https://reference.test/beta', text: 'Beta has a length of 300 cm. Beta has a mass of 8 kilograms.' };
    expect(comparePages(question, [first, second], 'en')?.result).toBe('Alpha is longer than Beta.');
    expect(comparePages(question, [first, { ...second, text: second.text.replace('8 kilograms', '12 kilograms') }], 'en')).toBeNull();
  });
});

describe('a two-subject comparison through model-free chat', () => {
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let control: Awaited<ReturnType<typeof createCommandChatControl>>;

  beforeAll(async () => {
    database = await createDatabase();
    await migrate(database.db);
    const browser = {
      setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; },
      async act() { throw new Error('Unexpected browser action'); },
      async close() {},
    } as unknown as AgentBrowser;
    const searchProvider: SearchProvider = {
      name: 'isolated-comparison-search',
      async search(query) {
        return sources.filter(source => query.includes(source.name)).map(source => ({ title: source.name, url: source.url, snippet: source.text }));
      },
    };
    control = await createCommandChatControl(database.db, {
      models: { fast: [], deep: [], vision: '' }, browser, searchProvider,
      readPage: async url => {
        const found = sources.find(source => source.url === url);
        return found ? { url, title: found.name, text: found.text, status: 200 } : null;
      },
      judgeShadow: { logFile: '', observe: judge, async flush() {} }, judgeWithholdForOwner: true, judgeFixForOwner: true,
    });
  });

  afterAll(async () => { await control?.shutdown(); await database?.close(); });

  async function ask(goal: string) {
    const { id } = await control.create(owner, { goal });
    await control.settled(id);
    const detail = await control.detail(owner, id);
    expect(detail.error).toBeNull();
    const run = await database.db.selectFrom('chat_runs').select('status').where('conversation_id', '=', id).executeTakeFirstOrThrow();
    return { reply: detail.messages.filter(message => message.role === 'assistant').at(-1)?.text ?? '', status: run.status };
  }

  it('compares areas on the same scale and cites both observations', async () => {
    const { reply, status } = await ask('أيهما أكبر مساحة، مصر أم السعودية؟');
    expect(reply).toMatch(/^السعودية أكبر مساحة/u);
    expect(reply).toContain('1,001,450 كيلومتر مربع');
    expect(reply).toContain('2.15 مليون كيلومتر مربع');
    expect(reply).toContain(sources[0].url);
    expect(reply).toContain(sources[1].url);
    expect(status).toBe('completed');
  });

  it('picks the earlier birth when the people were born in the same year', async () => {
    const { reply, status } = await ask('Which is older, Bill Gates or Steve Jobs?');
    expect(reply).toMatch(/^Steve Jobs is older/u);
    expect(reply).toContain('October 28, 1955');
    expect(reply).toContain('February 24, 1955');
    expect(status).toBe('completed');
  });

  it('answers which subject has more people from both populations', async () => {
    const { reply, status } = await ask('أيهما أكثر سكانًا، ألمانيا أم فرنسا؟');
    expect(reply).toMatch(/^ألمانيا أكثر سكانًا/u);
    expect(reply).toContain('84 مليون نسمة');
    expect(reply).toContain('68 مليون نسمة');
    expect(status).toBe('completed');
  });

  it('compares a named count even when the comma before the alternatives is omitted', async () => {
    const { reply, status } = await ask('Which has more moons Jupiter or Mars?');
    expect(reply).toMatch(/^Jupiter has more moons than Mars/u);
    expect(reply).toContain('95 moons');
    expect(reply).toContain('2 moons');
    expect(status).toBe('completed');
  });

  it('compares the area when requested with more instead of bigger', async () => {
    const { reply, status } = await ask('أيهما أكثر مساحةً مصر أم السعودية؟');
    expect(reply).toMatch(/^السعودية أكبر مساحة/u);
    expect(status).toBe('completed');
  });

  it('keeps an honest no-answer when a page omits the comparable date', async () => {
    const { reply, status } = await ask('Which is older, Denton or Carter?');
    expect(reply).toContain('I could not compare');
    expect(reply).not.toContain('is older');
    expect(status).toBe('partial');
  });
});
