import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AgentBrowser, type AgentAction, type AgentPage, type SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import { createJudgeShadow, judgeSettings, type JudgeShadowLine } from '../apps/server/src/assistant/judge-shadow.js';

// The judge in production (owner, 2026-11-22: «نعم شغله»): on as in the labs, the same fix and withhold for the owner,
// a log that holds no member's words, and a log folder the service may not be able to write.
describe('where and how the judge runs', () => {
  const cwd = join('srv', 'app');
  it('is on in production, with the owner-only text log, in the folder the service names', () => {
    expect(judgeSettings(true, { MOHASSAN_JUDGE_LOG_DIR: join('var', 'lib', 'mohassan', 'judge') }, cwd)).toEqual({
      enabled: true, logFile: join('var', 'lib', 'mohassan', 'judge', 'shadow.jsonl'), fixForOwner: true, withholdForOwner: true, logText: 'owner' });
    // No folder named: the working directory's own data folder, as in the labs.
    expect(judgeSettings(true, {}, cwd).logFile).toBe(join(cwd, '.data', 'judge', 'shadow.jsonl'));
  });
  it('keeps every line whole outside production, as before', () => {
    expect(judgeSettings(false, {}, cwd)).toEqual({ enabled: true, logFile: join(cwd, '.data', 'judge', 'shadow.jsonl'), fixForOwner: true, withholdForOwner: true, logText: 'all' });
  });
  it('is turned off, or stopped from changing a reply, by the same three switches in both modes', () => {
    for (const production of [true, false]) {
      expect(judgeSettings(production, { MOHASSAN_JUDGE_SHADOW: '0' }, cwd).enabled).toBe(false);
      expect(judgeSettings(production, { MOHASSAN_JUDGE_FIX: '0', MOHASSAN_JUDGE_WITHHOLD: '0' }, cwd)).toMatchObject({ enabled: true, fixForOwner: false, withholdForOwner: false });
      expect(judgeSettings(production, { VITEST: 'true' }, cwd).enabled).toBe(false);
    }
  });
});

describe('the judge with production settings, through the real chat controller', () => {
  const owner = 'isolated-judge-production-owner', member = 'isolated-judge-production-member';
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let control: Awaited<ReturnType<typeof createCommandChatControl>>, blocked: Awaited<ReturnType<typeof createCommandChatControl>>;
  let directory: string;
  let shadow: ReturnType<typeof createJudgeShadow>, unwritable: ReturnType<typeof createJudgeShadow>;
  const current = new Map<string, AgentPage>();
  // Page order puts the minority sentence first and the population figure second, as the real Wikipedia page did on 2026-11-22 (rq016).
  const MOROCCO_TEXT = 'فيما انخفضت الأقلية اليهودية المغربية بين السكان بشكل كبير ويصل عددها إلى نحو 6,000 نسمة. وحسب إحصاء سنة 2024، يبلغ عدد سكان المغرب ما يقارب 37 مليون نسمة بزيادة 8 في المائة. يتحدث معظم السكان العربية والأمازيغية.';
  const URL = 'https://judge-fixtures.test/morocco-population';
  const page = (): AgentPage => ({ id: URL, hash: URL, url: URL, title: 'سكان المغرب', text: MOROCCO_TEXT, documentStatus: 200, elements: [],
    signals: { captcha: false, password: false, otp: false, card: false }, scroll: { top: 0, height: 1000, viewport: 800 }, observedAt: new Date().toISOString() });

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mohassan-judge-production-'));
    shadow = createJudgeShadow({ logFile: join(directory, 'judge', 'shadow.jsonl') });
    // A file where the log's folder should be: the folder can never be created, as under a read-only application folder.
    await writeFile(join(directory, 'blocker'), 'not a folder');
    unwritable = createJudgeShadow({ logFile: join(directory, 'blocker', 'judge', 'shadow.jsonl') });
    database = await createDatabase(); await migrate(database.db);
    const browser = {
      setCheckpointStore() {}, async bindAccount() {},
      async hasPage(_owner: string, id: string) { return current.has(id); },
      async observe(_owner: string, id: string) { return { page: current.get(id)!, changed: false }; },
      async act(_owner: string, id: string, action: AgentAction) {
        if (action.kind !== 'open') throw new Error(`Unexpected fixture action: ${action.kind}`);
        current.set(id, page());
        return { page: page(), changed: true };
      },
      async close() {},
    } as unknown as AgentBrowser;
    const searchProvider: SearchProvider = { name: 'isolated-judge-production-search', async search(query) { return [{ title: `سكان المغرب — ${query}`, url: URL, snippet: MOROCCO_TEXT }]; } };
    const base = { browser, models: { fast: [], deep: [], vision: '' }, searchProvider, fullAccess: async (ownerId: string) => ownerId !== member, judgeFixForOwner: true, judgeWithholdForOwner: true, judgeLogText: 'owner' as const };
    control = await createCommandChatControl(database.db, { ...base, judgeShadow: shadow });
    blocked = await createCommandChatControl(database.db, { ...base, judgeShadow: unwritable });
  });
  afterAll(async () => { await control?.shutdown(); await blocked?.shutdown(); await database?.close(); await rm(directory, { recursive: true, force: true }); });

  async function ask(chat: typeof control, account: string) {
    const { id } = await chat.create(account, { goal: 'كم عدد سكان المغرب؟' });
    await chat.settled(id);
    const detail = await chat.detail(account, id);
    return { id, error: detail.error, stored: detail.messages.filter(message => message.role === 'assistant').at(-1)!.text };
  }
  const logged = async (id: string) => { await shadow.flush(); return (await readFile(shadow.logFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as JudgeShadowLine).filter(line => line.conversationId === id); };

  it('applies the fix on the owner\'s account and keeps that reply\'s text in the log', async () => {
    const result = await ask(control, owner);
    expect(result.error).toBeNull();
    const [line] = await logged(result.id);
    expect(line).toMatchObject({ decision: 'fix', applied: true, textKept: true, question: 'كم عدد سكان المغرب؟' });
    expect(line!.reply.split('\n')[0]).toMatch(/^فيما انخفضت الأقلية اليهودية/u);
    expect(result.stored).toBe(line!.fixedReply);
    expect(result.stored.split('\n')[0]).toMatch(/^وحسب إحصاء سنة 2024، يبلغ عدد سكان المغرب/u);
  });

  it('leaves a member\'s reply as the chat wrote it and logs the verdict without a word of the conversation', async () => {
    const result = await ask(control, member);
    expect(result.error).toBeNull();
    expect(result.stored.split('\n')[0]).toMatch(/^فيما انخفضت الأقلية اليهودية/u);
    const lines = await logged(result.id);
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line).toMatchObject({ decision: 'fix', applied: false, textKept: false, question: '', previous: null, reply: '', fixedReply: null, withholdText: null, kind: 'answer', sourced: true, evidence: 1 });
    expect(line.codes).toContain('lead_not_best');
    expect(line.findings.length).toBeGreaterThan(0);
    for (const finding of line.findings) expect(finding).toMatchObject({ excerpt: '', detail: '' });
    expect(line.lead).toMatchObject({ line: 1, text: '' });
    expect(line.best?.text).toBe('');
    // Nothing of the question, the page or the reply is in the stored line.
    const raw = (await readFile(shadow.logFile, 'utf8')).split('\n').find(text => text.includes(result.id))!;
    for (const word of ['المغرب', 'سكان', 'اليهودية', 'إحصاء', 'نسمة']) expect(raw).not.toContain(word);
  });

  it('still judges and fixes the owner\'s reply when the log folder cannot be written, and says so once', async () => {
    const warnings = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const first = await ask(blocked, owner);
      const second = await ask(blocked, owner);
      await unwritable.flush();
      for (const result of [first, second]) {
        expect(result.error).toBeNull();
        expect(result.stored.split('\n')[0]).toMatch(/^وحسب إحصاء سنة 2024، يبلغ عدد سكان المغرب/u);
      }
      const named = warnings.mock.calls.map(call => String(call[0])).filter(text => text.includes('judge_log_unavailable'));
      expect(named).toHaveLength(1);
      expect(JSON.parse(named[0]!)).toMatchObject({ level: 'warn', event: 'judge_log_unavailable' });
    } finally { warnings.mockRestore(); }
  });
});
