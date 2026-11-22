import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentBrowser, SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import { createJudgeShadow } from '../apps/server/src/assistant/judge-shadow.js';

const owner = 'isolated-self-knowledge-owner';
const member = 'isolated-self-knowledge-member';

// Questions about the assistant through the real chat controller, with no model: answered from the host facts, never
// searched for, and never listing for a member what the member cannot reach. The wording is this test's own.
describe('questions about the assistant through the real chat controller', () => {
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let control: Awaited<ReturnType<typeof createCommandChatControl>>;
  let directory: string;
  const searched: string[] = [];

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mohassan-self-knowledge-chat-'));
    database = await createDatabase();
    await migrate(database.db);
    const browser = {
      setCheckpointStore() {}, async bindAccount() {},
      async hasPage() { return false; },
      async observe() { throw new Error('No page in this test.'); },
      async act() { throw new Error('The browser must not open for a question about the assistant.'); },
      async close() {},
    } as unknown as AgentBrowser;
    const searchProvider: SearchProvider = {
      name: 'isolated-self-knowledge-search',
      async search(query) { searched.push(query); return []; },
    };
    // The judge runs as it does for the owner in development, so a reply it would withhold would show here.
    control = await createCommandChatControl(database.db, { browser, models: { fast: [], deep: [], vision: '' }, searchProvider,
      fullAccess: async ownerId => ownerId !== member, judgeShadow: createJudgeShadow({ logFile: join(directory, 'judge.jsonl') }),
      judgeFixForOwner: true, judgeWithholdForOwner: true });
  });
  afterAll(async () => { await control?.shutdown(); await database?.close(); await rm(directory, { recursive: true, force: true }); });

  async function ask(account: string, goal: string) {
    const { id } = await control.create(account, { goal });
    await control.settled(id);
    const detail = await control.detail(account, id);
    expect(detail.error).toBeNull();
    const run = await database.db.selectFrom('chat_runs').select(['status']).where('conversation_id', '=', id).executeTakeFirstOrThrow();
    return { text: detail.messages.filter(message => message.role === 'assistant').at(-1)!.text, status: run.status };
  }

  it('answers «what can you do» from the host facts, with no web search', async () => {
    const before = searched.length;
    const reply = await ask(owner, 'شو بتقدر تعمل؟');
    expect(reply.status).toBe('completed');
    expect(reply.text).toMatch(/^هذا ما أستطيعه الآن في هذه المحادثة/u);
    expect(reply.text).toContain('أجيب عن الأسئلة العامة من صفحات أقرؤها على الويب');
    expect(reply.text).toContain('نموذج لغوي يفهم الطلبات الحرة');
    expect(searched.length).toBe(before);
  });

  it('says plainly that it cannot create images', async () => {
    const reply = await ask(owner, 'Can you make pictures?');
    expect(reply.text).toMatch(/^No\. I cannot create images now: there is no image-generation model\./u);
    expect(reply.status).toBe('completed');
  });

  it('answers a model question without a model and names the creator', async () => {
    const reply = await ask(owner, 'Are you based on Gemini?');
    expect(reply.text).toMatch(/^No\. I’m Mohassan, and I do not run on any external AI platform\./u);
    expect(reply.text).toContain('Ahmad Alwakai is the creator and lead developer of the Mohassan application.');
  });

  it('does not list Google Ads or computer control for a member who cannot reach them', async () => {
    const reply = await ask(member, 'What are your abilities?');
    expect(reply.text).not.toContain('Prepare Google Ads campaigns.');
    expect(reply.text).not.toContain('Carry out specific commands on your computer');
  });

  it('leaves a task that names its own object to the other routes', async () => {
    const before = searched.length;
    const reply = await ask(owner, 'Who created the Eiffel Tower?');
    expect(reply.text).not.toMatch(/Ahmad Alwakai/u);
    expect(searched.length).toBeGreaterThan(before);
  });
});
