import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentBrowser, SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createJudgeShadow, type JudgeShadowLine } from '../apps/server/src/assistant/judge-shadow.js';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';

const owner = 'truth-checks-integration-owner';
const question = 'How many people live in Japan?';
const primary = 'https://japan-statistics.example/population';
const conflicting = 'https://population-bulletin.example/japan';
const originalClaim = 'Japan has a population of 123 million people.';

// Agent-written development cases with deliberately conflicting, fictional evidence pages.
describe('truth checks through the command-chat controller', () => {
  let database: Awaited<ReturnType<typeof createDatabase>>;

  beforeAll(async () => {
    database = await createDatabase();
    await migrate(database.db);
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => { await database?.close(); });

  it.each([false, true])('records both decisions and persists the appropriate reply when flag is %s', async enabled => {
    vi.stubEnv('MOHASSAN_JUDGE_TRUTH', enabled ? '1' : undefined);
    const directory = await mkdtemp(join(tmpdir(), 'mohassan-truth-chat-'));
    const shadow = createJudgeShadow({ logFile: join(directory, 'judge.jsonl') });
    const searchProvider: SearchProvider = {
      name: 'truth-chat-fixtures',
      async search() {
        return [
          { url: primary, title: 'Japan', snippet: originalClaim },
          { url: 'https://japan-statistics.example/related', title: 'Japan population notes', snippet: '' },
          { url: 'https://japan-statistics.example/references', title: 'Japan population references', snippet: '' },
          { url: conflicting, title: 'Japan population bulletin', snippet: '' },
        ];
      },
    };
    const readPage = vi.fn(async (url: string) => {
      if (url === primary) return { url, title: 'Japan', status: 200, text: originalClaim };
      if (url === conflicting) return { url, title: 'Japan population bulletin', status: 200,
        text: 'Japan has a population of 125 million people. Census analysts published their estimate in the national demographic bulletin.' };
      return 'disallowed' as const;
    });
    const browser = {
      setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; },
      async act() { throw new Error('Unexpected browser action in HTTP reading fixture'); }, async close() {},
    } as unknown as AgentBrowser;
    let control: Awaited<ReturnType<typeof createCommandChatControl>> | undefined;
    try {
      control = await createCommandChatControl(database.db, { browser, models: { fast: [], deep: [], vision: '' }, readPage,
        searchProvider, judgeShadow: shadow, judgeFixForOwner: true, judgeWithholdForOwner: true, fullAccess: async () => true });
      const { id } = await control.create(owner, { goal: question });
      await control.settled(id);
      await shadow.flush();

      const detail = await control.detail(owner, id);
      const stored = detail.messages.filter(message => message.role === 'assistant');
      const run = await database.db.selectFrom('chat_runs').select(['id', 'status']).where('conversation_id', '=', id).executeTakeFirstOrThrow();
      const entries = (await readFile(shadow.logFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as JudgeShadowLine);

      expect(detail.error).toBeNull();
      expect(stored).toHaveLength(1);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ conversationId: id, runId: run.id, question,
        decision: 'send', applied: false, status: 'completed',
        truth: { decision: 'withhold', source: 'conflict', codes: ['source_conflict'], lookup: true, applied: enabled } });
      expect(entries[0]!.reply).toContain(originalClaim);
      expect(readPage.mock.calls.filter(([url]) => url === conflicting)).toHaveLength(1);
      if (enabled) {
        expect(stored[0]!.text).toContain('وجدت قيمًا مختلفة');
        expect(stored[0]!.text).toContain(conflicting);
        expect(stored[0]!.text).not.toContain('123 million');
        expect(stored[0]!.text).not.toContain('125 million');
        expect(run.status).toBe('partial');
      } else {
        expect(stored[0]!.text).toBe(entries[0]!.reply);
        expect(run.status).toBe('completed');
      }
    } finally {
      await control?.shutdown();
      await shadow.flush();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
