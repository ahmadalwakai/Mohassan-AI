import { afterEach, expect, it } from 'vitest';
import { AgentBrowser, type AgentAction, type AgentPage, type SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';

/**
 * The model-free hands through the real chat controller: a question is answered by reading its sources over HTTP
 * (no browser action at all), an unsupported request gets an honest reply before any search, a refused search ends
 * as a reply rather than a failed run, and a follow-up keeps the earlier topic. Measured causes: 0-baseline §8–§9.
 */
const owner = 'isolated-http-hands-owner';
let database: Awaited<ReturnType<typeof createDatabase>> | undefined;
let control: Awaited<ReturnType<typeof createCommandChatControl>> | undefined;

afterEach(async () => {
  await control?.shutdown();
  await database?.close();
});

const japan = 'https://ar.wikipedia.org/wiki/%D8%A7%D9%84%D9%8A%D8%A7%D8%A8%D8%A7%D9%86';
const tokyo = 'https://ar.wikipedia.org/wiki/%D8%B7%D9%88%D9%83%D9%8A%D9%88';
const texts: Record<string, { title: string; text: string }> = {
  [japan]: { title: 'اليابان - ويكيبيديا', text: 'اليابان دولة جزرية في شرق آسيا، عاصمتها طوكيو وهي أكبر مدنها.\nيبلغ عدد سكان اليابان نحو 125 مليون نسمة حسب إحصاء 2023 وهو في تناقص مستمر منذ سنوات.\n' },
  [tokyo]: { title: 'طوكيو - ويكيبيديا', text: 'طوكيو عاصمة اليابان وأكبر مدنها، وتقع على الساحل الشرقي لجزيرة هونشو في منطقة كانتو الواسعة.\n' },
};

async function harness() {
  database = await createDatabase();
  await migrate(database.db);
  const queries: string[] = [];
  const actions: AgentAction[] = [];
  const reads: string[] = [];
  const searchProvider: SearchProvider = {
    name: 'isolated-public-search',
    async search(query) {
      queries.push(query);
      return [{ title: 'اليابان', url: japan, snippet: 'اليابان دولة جزرية عاصمتها طوكيو وعدد سكانها' }, { title: 'طوكيو', url: tokyo, snippet: 'طوكيو عاصمة اليابان' }];
    },
  };
  const browser = {
    setCheckpointStore() {},
    async bindAccount() {},
    async hasPage() { return false; },
    async observe() { throw new Error('No browser page should be observed'); },
    async act(_owner: string, _conversation: string, action: AgentAction) {
      actions.push(action);
      throw new Error(`Unexpected browser action: ${action.kind} ${action.text ?? ''}`);
    },
    async close() {},
  } as unknown as AgentBrowser;
  control = await createCommandChatControl(database.db, {
    models: { fast: [], deep: [], vision: '' }, browser, searchProvider,
    readPage: async url => { reads.push(url); const found = texts[url]; return found ? { url, title: found.title, text: found.text, status: 200 } : null; },
  });
  return { control, queries, actions, reads };
}

it('answers a question by reading its sources over HTTP, with no browser action', async () => {
  const { control, queries, actions, reads } = await harness();
  const { id } = await control.create(owner, { goal: 'ما عاصمة اليابان؟' });
  await control.settled(id);
  const result = await control.detail(owner, id);
  expect(result.error).toBeNull();
  expect(result.status).toBe('idle');
  expect(queries).toEqual(['ما عاصمة اليابان']);
  expect(actions).toEqual([]);
  expect(result.browser).toBeNull();
  expect(reads).toContain(japan);
  expect(result.messages.at(-1)?.text).toContain('عاصمتها طوكيو');
  expect(result.messages.at(-1)?.text).toContain('**المصدر:**');
  const runs = await database!.db.selectFrom('chat_runs').select('status').where('conversation_id', '=', id).execute();
  expect(runs.map(run => run.status)).toEqual(['completed']);
});

it('applies a saved brief preference to the real HTTP answer and keeps only the primary citation', async () => {
  const { control, queries, actions } = await harness();
  const { id } = await control.create(owner, { goal: 'من الآن إجابات مختصرة' });
  await control.settled(id);
  await control.send(owner, id, { text: 'ما عاصمة اليابان؟' });
  await control.settled(id);
  const { messages, error } = await control.detail(owner, id);
  const reply = messages.at(-1)!.text;
  expect(error).toBeNull();
  expect(reply).toContain('عاصمتها طوكيو');
  expect(reply).toContain(japan);
  expect(reply).not.toContain('يبلغ عدد سكان اليابان');
  expect(reply).not.toContain(tokyo);
  expect(queries).toEqual(['ما عاصمة اليابان']);
  expect(actions).toEqual([]);
});

it('keeps the earlier topic in a follow-up that only points at it', async () => {
  const { control, queries } = await harness();
  const { id } = await control.create(owner, { goal: 'ما عاصمة اليابان؟' });
  await control.settled(id);
  await control.send(owner, id, { text: 'وكم عدد سكانها؟' });
  await control.settled(id);
  const result = await control.detail(owner, id);
  expect(result.error).toBeNull();
  expect(queries).toHaveLength(2);
  expect(queries[1]).toContain('اليابان');
  expect(result.messages.at(-1)?.text).toContain('125 مليون');
});

it('replies with an honest limit before any search for a request it cannot perform', async () => {
  const { control, queries, actions } = await harness();
  const { id } = await control.create(owner, { goal: 'ارسم لي صورة قطة' });
  await control.settled(id);
  const result = await control.detail(owner, id);
  expect(result.error).toBeNull();
  expect(result.status).toBe('idle');
  expect(queries).toEqual([]);
  expect(actions).toEqual([]);
  expect(result.messages.at(-1)?.text).toContain('لا أرسم الصور');
  const { id: second } = await control.create(owner, { goal: 'Book me a flight to Paris next Monday' });
  await control.settled(second);
  const booking = await control.detail(owner, second);
  expect(booking.error).toBeNull();
  expect(queries).toEqual([]);
  expect(booking.messages.at(-1)?.text).toContain('I do not book, buy, call or send');
});

it('takes a description of colours after a picture request as that picture, not as a search', async () => {
  // Real request rq091 (2026-11-22): a colour-on-background description after a logo was searched on its own words
  // and answered with a physics sentence from the article «لون». Own wording here, not the set's.
  const { control, queries, actions } = await harness();
  const { id } = await control.create(owner, { goal: 'can you draw pictures?' });
  await control.settled(id);
  await control.send(owner, id, { text: 'باللون الأخضر' });
  await control.settled(id);
  await control.send(owner, id, { text: 'أخضر على خلفية رمادية' });
  await control.settled(id);
  const result = await control.detail(owner, id);
  expect(result.error).toBeNull();
  expect(result.status).toBe('idle');
  expect(queries).toEqual([]);
  expect(actions).toEqual([]);
  const replies = result.messages.filter(message => message.role === 'assistant').map(message => message.text);
  expect(replies.at(-2)).toContain('فهمت «باللون الأخضر» وصفًا لشكل الصورة');
  expect(replies.at(-1)).toContain('فهمت «أخضر على خلفية رمادية» وصفًا لشكل الصورة');
  expect(replies.at(-1)).not.toContain('**المصدر:**');
  // A real question about a colour still reads its sources, and a bare colour with no picture before it is not taken as one.
  const { id: second } = await control.create(owner, { goal: 'ما لون السماء؟' });
  await control.settled(second);
  expect(queries.length).toBeGreaterThan(0);
  const { id: third } = await control.create(owner, { goal: 'باللون الأخضر' });
  await control.settled(third);
  expect((await control.detail(owner, third)).messages.at(-1)?.text).not.toContain('وصفًا لشكل الصورة');
});

it('turns a refused public search into a reply instead of a failed run', async () => {
  const { control, queries } = await harness();
  const { id } = await control.create(owner, { goal: 'افعل شيئًا مفيدًا' });
  await control.settled(id);
  const result = await control.detail(owner, id);
  expect(result.status).toBe('idle');
  expect(result.error).toBeNull();
  expect(queries).toEqual([]);
  expect(result.messages.at(-1)?.text).toContain('لم أبحث في الويب عن');
  const runs = await database!.db.selectFrom('chat_runs').select('status').where('conversation_id', '=', id).execute();
  expect(runs.map(run => run.status)).not.toContain('failed');
});
