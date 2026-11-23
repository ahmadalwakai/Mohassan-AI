import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AgentBrowser, type AgentAction, type SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import { createJudgeShadow, type JudgeShadowLine } from '../apps/server/src/assistant/judge-shadow.js';

/**
 * The gaps the live audit of 2026-11-22 found, through the real chat controller with no model and the pre-send judge on
 * (artifacts/agent-gaps-2026-11-22/audit-head-3959084): a question about a fact of the owner's own is read from memory and
 * never searched for in public; a request that forbids the web gets a reply, not a failed run; several questions in one
 * message are asked one after another; and an answer the judge would refuse is corrected from another page before it is sent.
 */
const owner = 'isolated-agent-cycle-owner';
const wiki = (title: string, lang = 'ar') => `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title)}`;
const france = wiki('فرنسا');
const museum = 'https://agent-cycle-fixtures.test/museum-visits';
const guide = 'https://agent-cycle-fixtures.test/japan-travel';
const pages: Record<string, { title: string; text: string }> = {
  [france]: { title: 'فرنسا - ويكيبيديا', text: 'فرنسا دولة في أوروبا الغربية، عاصمتها باريس وهي أكبر مدنها وأهمها.\nيبلغ عدد سكان فرنسا نحو 68 مليون نسمة حسب تقديرات سنة 2025.\nتشتهر فرنسا بمطبخها ومتاحفها ومعالمها التاريخية الكثيرة.\n' },
  // A page the first brain accepts (its title and sentence carry «best», «time» and «visit») that never names Japan.
  [museum]: { title: 'Best time to visit museums', text: 'The best time to visit the museum is early on a weekday morning, when the halls are quiet. Guided tours start at ten.' },
  [guide]: { title: 'Japan travel notes', text: 'The best time to visit Japan is spring, from late March to early April, when the cherry trees bloom. Autumn brings clear skies and red leaves across Japan.' },
};

describe('the task cycle without a model, through the real chat controller', () => {
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let control: Awaited<ReturnType<typeof createCommandChatControl>>;
  let directory: string;
  let shadow: ReturnType<typeof createJudgeShadow>;
  let notes: string[] = [];
  const queries: string[] = [], reads: string[] = [], memoryQueries: string[] = [], actions: AgentAction[] = [];

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mohassan-agent-cycle-'));
    shadow = createJudgeShadow({ logFile: join(directory, 'shadow.jsonl') });
    database = await createDatabase();
    await migrate(database.db);
    const browser = {
      setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; },
      async observe() { throw new Error('No browser page should be observed'); },
      async act(_owner: string, _conversation: string, action: AgentAction) { actions.push(action); throw new Error(`Unexpected browser action: ${action.kind}`); },
      async close() {},
    } as unknown as AgentBrowser;
    const searchProvider: SearchProvider = {
      name: 'isolated-agent-cycle-search',
      async search(query) {
        queries.push(query);
        if (/visit/iu.test(query)) return [{ title: pages[museum]!.title, url: museum, snippet: pages[museum]!.text }, { title: pages[guide]!.title, url: guide, snippet: pages[guide]!.text }];
        return [{ title: 'فرنسا', url: france, snippet: 'فرنسا دولة في أوروبا الغربية عاصمتها باريس وعدد سكانها' }];
      },
    };
    control = await createCommandChatControl(database.db, {
      models: { fast: [], deep: [], vision: '' }, browser, searchProvider,
      readPage: async url => { reads.push(url); const found = pages[url]; return found ? { url, title: found.title, text: found.text, status: 200 } : null; },
      tools: { memory: { async search(_owner: string, query: string) { memoryQueries.push(query); return { text: notes.join('\n'), evidence: notes }; }, async save() { return 'saved'; } } },
      judgeShadow: shadow, judgeFixForOwner: true, judgeWithholdForOwner: true,
    });
  });
  afterAll(async () => { await control?.shutdown(); await database?.close(); await rm(directory, { recursive: true, force: true }); });
  beforeEach(() => { queries.length = 0; reads.length = 0; memoryQueries.length = 0; actions.length = 0; notes = []; });

  async function ask(goal: string) {
    const { id } = await control.create(owner, { goal });
    await control.settled(id);
    const detail = await control.detail(owner, id);
    const run = await database.db.selectFrom('chat_runs').select('status').where('conversation_id', '=', id).executeTakeFirstOrThrow();
    await shadow.flush();
    const verdicts = (await readFile(shadow.logFile, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as JudgeShadowLine).filter(line => line.conversationId === id);
    return { id, detail, reply: detail.messages.filter(message => message.role === 'assistant').at(-1)?.text ?? '', status: run.status, steps: detail.steps.map(step => step.text), verdicts };
  }

  it('asks the two questions of one message one after another, the second about the page the first was read from', async () => {
    const { detail, reply, status, verdicts } = await ask('ما عاصمة فرنسا؟ ثم كم عدد سكانها؟');
    expect(detail.error).toBeNull();
    expect(queries).toEqual(['ما عاصمة فرنسا', 'كم عدد سكان فرنسا']);
    expect(actions).toEqual([]);
    const [first, second] = reply.split('\n\n**كم عدد سكانها؟**\n');
    expect(first).toMatch(/^\*\*ما عاصمة فرنسا؟\*\*\n/u);
    expect(first).toContain('عاصمتها باريس');
    expect(second).toContain('يبلغ عدد سكان فرنسا نحو 68 مليون نسمة');
    expect(status).toBe('completed');
    // Each part was judged on its own question, the second with the first as the turn before it; the joined reply was not judged again.
    expect(verdicts.map(line => [line.question, line.previous, line.decision])).toEqual([['ما عاصمة فرنسا؟', null, 'send'], ['كم عدد سكانها؟', 'ما عاصمة فرنسا؟', 'send']]);
  });

  it('answers a request that forbids the web with a reply, and searches nothing', async () => {
    const { detail, reply, status, steps } = await ask('لا تبحث في الويب. ما عاصمة فرنسا؟');
    expect(detail.error).toBeNull();
    expect(detail.status).toBe('idle');
    expect(queries).toEqual([]);
    expect(reads).toEqual([]);
    expect(reply).toBe('لم أبحث في الويب لأن طلبك يمنع ذلك، ولا أجيب عن هذا السؤال دون بحث. أرسل السؤال من غير المنع فأبحث وأذكر المصدر.');
    expect(steps).toEqual(['لم يُجرَ بحث: الطلب يمنعه']);
    expect(status).toBe('blocked');
  });

  it('reads a fact of the owner\'s own from memory and never searches for it in public', async () => {
    notes = ['مدينتي المفضلة هي مسقط'];
    const found = await ask('ما هي مدينتي المفضلة؟');
    expect(found.detail.error).toBeNull();
    expect(found.reply).toContain('مسقط');
    expect(found.steps).toContain('memory_search');
    expect(found.status).toBe('completed');
    expect(queries).toEqual([]);
    expect(memoryQueries.length).toBeGreaterThan(0);
  });

  it.each(['ما هو رقم جوالي؟', 'ما هي أسعار منتجاتي؟', 'ما هي لغتي المفضلة؟'])('says %s is not in memory instead of searching the web', async request => {
    const missing = await ask(request);
    expect(missing.detail.error).toBeNull();
    expect(missing.reply).toContain('لم أجد');
    expect(missing.status).toBe('blocked');
    expect(queries).toEqual([]);
    expect(reads).toEqual([]);
  });

  it('still searches the web for a public question whose last word only looks owned', async () => {
    await ask('كم عمر ميسي؟');
    expect(queries[0]).toBe('كم عمر ميسي');
    expect(memoryQueries).toEqual([]);
  });

  it('corrects an answer the judge would refuse by reading the next page, before anything is sent', async () => {
    const { detail, reply, status, steps, verdicts } = await ask('What is the best time to visit Japan?');
    expect(detail.error).toBeNull();
    expect(reads).toEqual(expect.arrayContaining([museum, guide]));
    expect(steps).toContain('Correction: the first source does not answer; reading another');
    expect(reply).toMatch(/^The best time to visit Japan is spring/u);
    expect(reply).toContain('Japan travel notes');
    expect(reply).not.toContain('museum');
    expect(status).toBe('completed');
    // One verdict for the reply that went out: the refused first reading was never sent, so it is not in the log.
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({ decision: 'send', applied: false });
  });
});
