import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentBrowser, type AgentAction, type AgentPage, type SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import { createJudgeShadow, type JudgeShadowLine } from '../apps/server/src/assistant/judge-shadow.js';

const owner = 'isolated-judge-shadow-owner';

// The judge runs in shadow through the real chat controller: one verdict per reply the owner sees, and no reply changes.
describe('judge shadow through the real chat controller', () => {
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let control: Awaited<ReturnType<typeof createCommandChatControl>>;
  let directory: string;
  let shadow: ReturnType<typeof createJudgeShadow>;
  const current = new Map<string, AgentPage>();
  const PAGE_TEXT = 'Tokyo is the capital of Japan and its largest city by population. The capital of Japan moved from Kyoto to Tokyo in 1868 after the Meiji Restoration. Japan has forty-seven prefectures and a population of about 124 million people.';
  // Page order puts the minority sentence first and the population figure second, as the real Wikipedia page did on 2026-11-22 (rq016).
  const MOROCCO_TEXT = 'فيما انخفضت الأقلية اليهودية المغربية بين السكان بشكل كبير ويصل عددها إلى نحو 6,000 نسمة. وحسب إحصاء سنة 2024، يبلغ عدد سكان المغرب ما يقارب 37 مليون نسمة بزيادة 8 في المائة. يقع المغرب في أقصى غرب شمال أفريقيا وعاصمته الرباط.';
  // A page the first brain accepts (its title and sentence carry «best», «time» and «visit») that never names Japan: what the
  // judge is for. The live film page of 2026-11-22 06:13 no longer reaches the judge, since hands.ts refuses a page whose title
  // names nothing of the question (tests/assistant-hands-page-choice.test.ts).
  const MUSEUM_TEXT = 'The best time to visit the museum is early on a weekday morning, when the halls are quiet. Guided tours start at ten.';
  const FIXTURES: Record<string, { title: string; text: string }> = {
    'https://judge-fixtures.test/capital-of-japan': { title: 'Capital of Japan', text: PAGE_TEXT },
    'https://judge-fixtures.test/morocco-population': { title: 'سكان المغرب', text: MOROCCO_TEXT },
    'https://judge-fixtures.test/museum-visits': { title: 'Best time to visit museums', text: MUSEUM_TEXT },
  };
  const member = 'isolated-judge-shadow-member';

  const page = (url: string): AgentPage => ({
    id: url, hash: url, url, title: FIXTURES[url]?.title ?? url, text: FIXTURES[url]?.text ?? PAGE_TEXT,
    documentStatus: 200, elements: [], signals: { captcha: false, password: false, otp: false, card: false },
    scroll: { top: 0, height: 1000, viewport: 800 }, observedAt: new Date().toISOString(),
  });

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mohassan-judge-shadow-chat-'));
    shadow = createJudgeShadow({ logFile: join(directory, 'shadow.jsonl') });
    database = await createDatabase();
    await migrate(database.db);
    const browser = {
      setCheckpointStore() {}, async bindAccount() {},
      async hasPage(_owner: string, id: string) { return current.has(id); },
      async observe(_owner: string, id: string) { return { page: current.get(id)!, changed: false }; },
      async act(_owner: string, id: string, action: AgentAction) {
        if (action.kind !== 'open') throw new Error(`Unexpected fixture action: ${action.kind}`);
        const observed = page(action.text!);
        current.set(id, observed);
        return { page: observed, changed: true };
      },
      async close() {},
    } as unknown as AgentBrowser;
    const searchProvider: SearchProvider = {
      name: 'isolated-judge-shadow-search',
      async search(query) {
        const url = /المغرب/u.test(query) ? 'https://judge-fixtures.test/morocco-population' : /visit/iu.test(query) ? 'https://judge-fixtures.test/museum-visits' : 'https://judge-fixtures.test/capital-of-japan';
        return [{ title: `${FIXTURES[url]!.title} — ${query}`, url, snippet: FIXTURES[url]!.text }];
      },
    };
    // `owner` has full access; `member` does not, so the judge's fix and withhold never reach the member's replies.
    control = await createCommandChatControl(database.db, { browser, models: { fast: [], deep: [], vision: '' }, searchProvider,
      fullAccess: async ownerId => ownerId !== member, judgeShadow: shadow, judgeFixForOwner: true, judgeWithholdForOwner: true });
  });
  afterAll(async () => { await control?.shutdown(); await database?.close(); await rm(directory, { recursive: true, force: true }); });

  async function lines() {
    await shadow.flush();
    return (await readFile(shadow.logFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as JudgeShadowLine);
  }

  it('logs a verdict for a web answer and leaves the stored reply exactly as the chat wrote it', async () => {
    const { id } = await control.create(owner, { goal: 'What is the capital of Japan?' });
    await control.settled(id);
    const detail = await control.detail(owner, id);
    expect(detail.error).toBeNull();
    const stored = detail.messages.filter(message => message.role === 'assistant').at(-1)!.text;
    const mine = (await lines()).filter(line => line.conversationId === id);
    expect(mine).toHaveLength(1);
    const line = mine[0]!;
    expect(line).toMatchObject({ question: 'What is the capital of Japan?', previous: null, lang: 'en', status: 'completed' });
    expect(line.reply).toBe(stored);
    // The answer came from the fixture page in the chat's own layout (English headings for an English question since 2026-11-22):
    // a sourced answer whose lead names the capital, so the judge lets it through. The page the run read is its evidence:
    // both own sentences are found in it, so nothing is unsupported and nothing is left unmeasured.
    expect(stored).toMatch(/^Tokyo is the capital of Japan/u);
    expect(stored).toContain('**Source:**');
    expect(line).toMatchObject({ kind: 'answer', sourced: true, decision: 'send', applied: false, codes: [], fixedReply: null, evidence: 1, support: { sentences: 2, supported: 2 } });
    expect(line.lead?.line).toBe(1);
    expect(typeof line.ms).toBe('number');
  });

  it('sends the judge\'s fix on the owner\'s account: the population sentence leads, and the log keeps the reply as the chat first wrote it', async () => {
    const { id } = await control.create(owner, { goal: 'كم عدد سكان المغرب؟' });
    await control.settled(id);
    const detail = await control.detail(owner, id);
    expect(detail.error).toBeNull();
    const stored = detail.messages.filter(message => message.role === 'assistant').at(-1)!.text;
    const mine = (await lines()).filter(line => line.conversationId === id);
    expect(mine).toHaveLength(1);
    const line = mine[0]!;
    expect(line).toMatchObject({ kind: 'answer', sourced: true, decision: 'fix', applied: true, evidence: 1 });
    expect(line.codes).toContain('lead_not_best');
    expect(line.reply.split('\n')[0]).toMatch(/^فيما انخفضت الأقلية اليهودية/u);
    expect(stored).toBe(line.fixedReply);
    expect(stored.split('\n')[0]).toMatch(/^وحسب إحصاء سنة 2024، يبلغ عدد سكان المغرب/u);
    expect(stored).toContain('- فيما انخفضت الأقلية اليهودية');
    expect(stored).toContain('**المصدر:**');
    // Every sentence the owner sees was already in the reply the chat wrote: nothing was written, only reordered.
    for (const text of stored.split('\n').filter(Boolean)) expect(line.reply).toContain(text.replace(/^- /u, ''));
    // The host's own closing note («لم أتحقق من هذا الرقم في مصدر ثانٍ») follows the source line and is not looked up in the page.
    expect(line.support).toEqual({ sentences: 2, supported: 2 });
  });

  it('logs a computed reply as send and a follow-up with its previous turn', async () => {
    const { id } = await control.create(owner, { goal: 'كم يساوي 15 ضرب 23؟' });
    await control.settled(id);
    await control.send(owner, id, { text: 'كم يساوي 100 ناقص 58؟' });
    await control.settled(id);
    const mine = (await lines()).filter(line => line.conversationId === id);
    expect(mine).toHaveLength(2);
    expect(mine[0]).toMatchObject({ question: 'كم يساوي 15 ضرب 23؟', previous: null, reply: '15 * 23 = 345', kind: 'computed', decision: 'send', status: 'completed' });
    expect(mine[1]).toMatchObject({ question: 'كم يساوي 100 ناقص 58؟', previous: 'كم يساوي 15 ضرب 23؟', kind: 'computed', decision: 'send' });
    expect(mine[1]!.runId).not.toBe(mine[0]!.runId);
  });

  it('withholds a page that never names Japan for a travel question on the owner\'s account: a fixed sentence with the page link, the run ends partial', async () => {
    const { id } = await control.create(owner, { goal: 'What is the best time to visit Japan?' });
    await control.settled(id);
    const detail = await control.detail(owner, id);
    expect(detail.error).toBeNull();
    const stored = detail.messages.filter(message => message.role === 'assistant').at(-1)!.text;
    const line = (await lines()).filter(item => item.conversationId === id)[0]!;
    expect(line).toMatchObject({ kind: 'answer', decision: 'withhold', applied: true, status: 'completed' });
    expect(line.codes).toContain('subject_missing');
    expect(line.reply).toMatch(/^The best time to visit the museum/u);
    expect(stored).toBe(line.withholdText);
    expect(stored).toBe([
      'The page I found is not about the subject of your question, so I did not take an answer from it.', '',
      'The page I read: [judge-fixtures.test — Best time to visit museums](https://judge-fixtures.test/museum-visits)', '',
      'Send a suitable page link or rephrase the question.'].join('\n'));
    const run = await database.db.selectFrom('chat_runs').select(['status']).where('conversation_id', '=', id).executeTakeFirstOrThrow();
    expect(run.status).toBe('partial');
  });

  it('leaves a member\'s reply exactly as the chat wrote it, while still logging the verdict', async () => {
    const { id } = await control.create(member, { goal: 'What is the best time to visit Japan?' });
    await control.settled(id);
    const detail = await control.detail(member, id);
    const stored = detail.messages.filter(message => message.role === 'assistant').at(-1)!.text;
    const line = (await lines()).filter(item => item.conversationId === id)[0]!;
    expect(line).toMatchObject({ decision: 'withhold', applied: false });
    expect(stored).toBe(line.reply);
    expect(stored).toMatch(/^The best time to visit the museum/u);
  });

  it('logs a question card to the owner as a question, not a defect', async () => {
    const { id } = await control.create(owner, { goal: 'اكتب رسالة بريد احترافية' });
    await control.settled(id);
    const detail = await control.detail(owner, id);
    const mine = (await lines()).filter(line => line.conversationId === id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ kind: 'question', decision: 'send', status: detail.status });
    expect(mine[0]!.codes.filter(code => code !== 'evidence_unavailable')).toEqual([]);
  });
});
