import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentBrowser } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createJudgeShadow, type JudgeShadowLine } from '../apps/server/src/assistant/judge-shadow.js';
import { createModelCouncil } from '../apps/server/src/assistant/model-council.js';
import { createCommandChatControl, type CommandChatConfig } from '../apps/server/src/command-chat.js';
import { V5_CHAT_LABEL } from '../apps/server/src/v5-chat.js';

const owner = 'truth-publication-owner';
const member = 'truth-publication-member';
const title = 'Amber Museum';
const url = 'https://truth-checks.example.test/amber-museum';
const question = `How many stamps does the ${title} have?`;
// The museum and its inventory are fictional. The asserted count is computed from the fixture.
const stampCount = Array.from('ABCDEFGHIJKL').length;
const stampClaim = (count: number) => `The ${title} has ${count} stamps on display in its public collection for museum visitors.`;
const founder = 'Marin Alder';
const founderClaim = `${founder} founded the ${title}.`;

describe('truth checks at chat publication', () => {
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let directory: string;
  let control: Awaited<ReturnType<typeof createCommandChatControl>> | undefined;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mohassan-truth-publication-'));
    database = await createDatabase();
    await migrate(database.db);
  });
  afterEach(async () => {
    await control?.shutdown();
    control = undefined;
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    await database?.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function ask(mode: 'shadow' | 'on' | undefined, goal: string,
    config: Partial<CommandChatConfig>, user = owner) {
    vi.stubEnv('MOHASSAN_TRUTH_CHECK', mode);
    vi.stubEnv('MOHASSAN_MODEL_RELATIONS', 'off');
    const log = await mkdtemp(join(directory, 'judge-'));
    const shadow = createJudgeShadow({ logFile: join(log, 'shadow.jsonl') });
    const browser = {
      setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; },
      async act() { throw new Error('Unexpected browser action in the HTTP-only fixture'); }, async close() {},
    } as unknown as AgentBrowser;
    control = await createCommandChatControl(database.db, {
      browser, models: { fast: [], deep: [], vision: '' }, recordExperiences: false,
      judgeShadow: shadow, judgeFixForOwner: true, judgeWithholdForOwner: true,
      fullAccess: async userId => userId === owner, accountFullAccess: async userId => userId === owner,
      ...config,
    });
    const { id } = await control.create(user, { goal });
    await control.settled(id);
    await shadow.flush();
    const detail = await control.detail(user, id);
    const replies = detail.messages.filter(message => message.role === 'assistant');
    const run = await database.db.selectFrom('chat_runs').select(['id', 'status'])
      .where('conversation_id', '=', id).executeTakeFirstOrThrow();
    const lines = (await readFile(shadow.logFile, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return '';
      throw error;
    })).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as JudgeShadowLine);
    expect(detail.error).toBeNull();
    expect(replies).toHaveLength(1);
    return { reply: replies[0]!, run, lines };
  }

  it.each([
    { mode: undefined, user: owner, withheld: false },
    { mode: 'shadow', user: owner, withheld: false },
    { mode: 'on', user: owner, withheld: true },
    { mode: 'on', user: member, withheld: false },
  ] as const)('checks a fabricated count with mode $mode for $user', async ({ mode, user, withheld }) => {
    const text = stampClaim(stampCount);
    const readPage = vi.fn(async () => ({ url, title, status: 200, text }));
    const { reply, run, lines } = await ask(mode, question, {
      readPage, searchProvider: { name: 'museum-fixture', search: async () => [{ url, title, snippet: text }] },
      // Simulate a one-token phrasing error that passes the legacy word-overlap check.
      ownModel: { observe: async () => {}, phrase: async input => input.reply.replaceAll(String(stampCount), String(stampCount + 1)) },
    }, user);

    expect(readPage).toHaveBeenCalledWith(url, expect.any(AbortSignal), { live: false });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ runId: run.id, question, status: 'completed', evidence: 1, applied: withheld });
    expect(lines[0]!.reply).toContain(String(stampCount + 1));
    if (mode) expect(lines[0]!.truth).toMatchObject({ decision: 'withhold', applied: withheld });
    else expect(lines[0]).not.toHaveProperty('truth');
    if (withheld) {
      expect(reply.text).toBe(lines[0]!.withholdText);
      expect(reply.text).toContain('I could not confirm an answer');
      expect(reply.text).toContain(url);
      expect(reply.text).not.toContain(String(stampCount + 1));
      expect(run.status).toBe('partial');
    } else {
      expect(lines[0]!.decision).toBe('send');
      expect(reply.text).toBe(lines[0]!.reply);
      expect(run.status).toBe('completed');
    }
  });

  it('publishes a supported answer in active mode', async () => {
    const text = stampClaim(stampCount);
    const { reply, run, lines } = await ask('on', question, {
      readPage: async () => ({ url, title, status: 200, text }),
      searchProvider: { name: 'museum-fixture', search: async () => [{ url, title, snippet: text }] },
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]!.truth).toEqual({ decision: 'send', codes: [], applied: false });
    expect(reply.text).toBe(lines[0]!.reply);
    expect(reply.text).toContain(String(stampCount));
    expect(run.status).toBe('completed');
  });

  it('does not treat a result snippet as a page the council read', async () => {
    const readPage = vi.fn(async () => 'disallowed' as const);
    const modelCouncil = createModelCouncil({
      runner: { async run(modelId) {
        return modelId === 'reading-v3-last' ? { ok: true, output: { text: founder }, elapsedMs: 0 }
          : { ok: false, reason: 'absent', elapsedMs: 0 };
      } },
      v5: async () => founderClaim,
    });
    const { reply, run, lines } = await ask('on', `Who founded the ${title}?`, {
      readPage, modelCouncil,
      v5Chat: { ready: () => true, generate: async () => founderClaim },
      searchProvider: { name: 'museum-snippet-fixture', search: async () => [{ url, title, snippet: `${founderClaim} Its permanent collection is open to visitors.` }] },
    });

    expect(readPage.mock.calls.length).toBeGreaterThan(1);
    expect(reply.council).toMatchObject({ chosen: 'reading-v3-last', changed: true });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.reply).toContain(founder);
    expect(lines[0]!.truth).toMatchObject({ decision: 'withhold', codes: ['unread_citation'], applied: true });
    expect(reply.text).toContain('I could not confirm an answer');
    expect(reply.text).not.toContain(url);
    expect(reply.text).not.toContain(founder);
    expect(run.status).not.toBe('completed');
  });

  it.each(['shadow', 'on'] as const)('respects the %s mode on a v5 reply selected by the council', async mode => {
    const goal = `Who do you think founded the ${title}?`;
    const v5 = vi.fn(async () => founderClaim);
    const modelCouncil = createModelCouncil({
      runner: { async run() { return { ok: false, reason: 'absent', elapsedMs: 0 }; } },
      v5,
    });
    const { reply, run, lines } = await ask(mode, goal, {
      modelCouncil, v5Chat: { ready: () => true, generate: v5 },
    });

    expect(v5).toHaveBeenCalledTimes(1);
    expect(reply.council).toMatchObject({ chosen: 'chat-v5', changed: true });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.truth).toMatchObject({ decision: 'withhold', codes: ['evidence_unavailable'], applied: mode === 'on' });
    if (mode === 'on') {
      expect(reply).not.toHaveProperty('experiment');
      expect(reply.text).toBe(lines[0]!.withholdText);
      expect(reply.text).not.toContain(founder);
      expect(run.status).toBe('partial');
    } else {
      expect(reply).toMatchObject({ experiment: 'v5', text: `${founderClaim}\n\n${V5_CHAT_LABEL}` });
      expect(run.status).toBe('completed');
    }
  });
});
