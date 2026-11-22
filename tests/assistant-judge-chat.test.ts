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

  const page = (url: string, title: string): AgentPage => ({
    id: url, hash: url, url, title, text: PAGE_TEXT,
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
        const observed = page(action.text!, 'Capital of Japan');
        current.set(id, observed);
        return { page: observed, changed: true };
      },
      async close() {},
    } as unknown as AgentBrowser;
    const searchProvider: SearchProvider = {
      name: 'isolated-judge-shadow-search',
      async search(query) {
        const url = 'https://judge-fixtures.test/capital-of-japan';
        return [{ title: `Capital of Japan — ${query}`, url, snippet: PAGE_TEXT }];
      },
    };
    control = await createCommandChatControl(database.db, { browser, models: { fast: [], deep: [], vision: '' }, searchProvider, judgeShadow: shadow });
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
    expect(line).toMatchObject({ question: 'What is the capital of Japan?', previous: null, lang: 'en', evidence: 0, support: null, status: 'completed' });
    expect(line.reply).toBe(stored);
    // The answer came from the fixture page in the chat's own layout (English headings for an English question since 2026-11-22):
    // a sourced answer whose lead names the capital, so the judge lets it through and notes only that no evidence text was passed.
    expect(stored).toMatch(/^Tokyo is the capital of Japan/u);
    expect(stored).toContain('**Source:**');
    expect(line).toMatchObject({ kind: 'answer', sourced: true, decision: 'send', codes: ['evidence_unavailable'], fixedReply: null });
    expect(line.lead?.line).toBe(1);
    expect(typeof line.ms).toBe('number');
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
