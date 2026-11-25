import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentBrowser, SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import { createJudgeShadow } from '../apps/server/src/assistant/judge-shadow.js';

const owner = 'isolated-local-sequence-owner';
const member = 'isolated-local-sequence-member';

// Arithmetic in Arabic words, and a calculation followed by a question about the tools, through the real chat controller
// with no model and with the judge on as for the owner in development: answered by the host, never searched for, the
// browser never opened. The wording is this test's own; the real requests were rq014, rq070 and rq039 of 2026-11-22.
describe('local answers in order through the real chat controller', () => {
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let control: Awaited<ReturnType<typeof createCommandChatControl>>;
  let directory: string;
  let judgeShadow: ReturnType<typeof createJudgeShadow>;
  const searched: string[] = [];

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mohassan-local-sequence-chat-'));
    database = await createDatabase();
    await migrate(database.db);
    const browser = {
      setCheckpointStore() {}, async bindAccount() {},
      async hasPage() { return false; },
      async observe() { throw new Error('No page in this test.'); },
      async act() { throw new Error('The browser must not open for a local answer.'); },
      async close() {},
    } as unknown as AgentBrowser;
    const searchProvider: SearchProvider = {
      name: 'isolated-local-sequence-search',
      async search(query) { searched.push(query); return []; },
    };
    judgeShadow = createJudgeShadow({ logFile: join(directory, 'judge.jsonl') });
    control = await createCommandChatControl(database.db, { browser, models: { fast: [], deep: [], vision: '' }, searchProvider,
      fullAccess: async ownerId => ownerId !== member, judgeShadow,
      judgeFixForOwner: true, judgeWithholdForOwner: true });
  });
  afterAll(async () => {
    await control?.shutdown();
    await judgeShadow?.flush();
    await database?.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function ask(account: string, goal: string) {
    const { id } = await control.create(account, { goal });
    await control.settled(id);
    const detail = await control.detail(account, id);
    expect(detail.error).toBeNull();
    const run = await database.db.selectFrom('chat_runs').select(['status']).where('conversation_id', '=', id).executeTakeFirstOrThrow();
    return { text: detail.messages.filter(message => message.role === 'assistant').at(-1)!.text, status: run.status };
  }

  it('computes an expression written in Arabic words and Arabic-Indic digits', async () => {
    const before = searched.length;
    const reply = await ask(owner, 'احسب (٢٥ زائد ١٥) قسمة على ٨');
    expect(reply.text).toBe('(25 + 15) / 8 = 5');
    expect(reply.status).toBe('completed');
    expect(searched.length).toBe(before);
  });

  it('answers a calculation and then the tools question in two sentences, in order', async () => {
    const before = searched.length;
    const reply = await ask(owner, 'كم حاصل ١٤ × ٣؟ ثم اذكر في جملتين ما الأدوات التي تستطيع استخدامها الآن');
    expect(reply.status).toBe('completed');
    const [first, second, ...rest] = reply.text.split('\n\n');
    expect(first).toBe('14 * 3 = 42');
    expect(second).toMatch(/^الأدوات التي أستطيع استخدامها الآن في هذه المحادثة: البحث في الويب/u);
    expect(second.match(/\.(?=\s|$)/gu)).toHaveLength(2);
    expect(second).toContain('ولا يتوفر لي الآن: نموذج لغوي يفهم الطلبات الحرة ويكتب');
    expect(rest).toEqual([]);
    expect(searched.length).toBe(before);
  });

  it('does not list for a member the tools the member cannot reach', async () => {
    const reply = await ask(member, 'What is 6 * 7? Then tell me briefly what tools you can use.');
    expect(reply.status).toBe('completed');
    const [first, second] = reply.text.split('\n\n');
    expect(first).toBe('6 * 7 = 42');
    const [can] = second.split('. ');
    expect(can).toMatch(/^The tools I can use now in this conversation: /u);
    expect(can).not.toContain('Google Ads');
    expect(can).not.toContain('computer');
  });
});
