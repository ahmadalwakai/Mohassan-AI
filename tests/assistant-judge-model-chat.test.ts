import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDatabase, migrate } from '@mohassan/database';
import type { AgentBrowser } from '@mohassan/browser';
import { createJudgeShadow, type JudgeShadowLine } from '../apps/server/src/assistant/judge-shadow.js';
import type { CouncilOutcome } from '../apps/server/src/assistant/model-council.js';
import { createCommandChatControl, type CommandChatConfig } from '../apps/server/src/command-chat.js';
import { V5_CHAT_LABEL } from '../apps/server/src/v5-chat.js';

const owner = 'judge-model-chat-owner';
const goal = 'What do you think about teamwork?';
const modelText = 'Hello, Shivawn!\n\nA steady team shares the work.';

describe('judge shadow for model replies in chat', () => {
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let directory: string;
  let control: Awaited<ReturnType<typeof createCommandChatControl>> | undefined;
  const unexpectedBrowserCall = async () => { throw new Error('Unexpected fixture browser call'); };
  const browser = {
    setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; },
    async close() {}, async dropHeld() {}, act: unexpectedBrowserCall, observe: unexpectedBrowserCall,
  } as unknown as AgentBrowser;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mohassan-judge-model-chat-'));
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
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function reply(config: Pick<CommandChatConfig, 'v5Chat' | 'modelCouncil'>) {
    vi.stubEnv('MOHASSAN_CONVERSATION_REVIEW_APPLY', '1');
    const judgeShadow = createJudgeShadow({ logFile: join(directory, `${randomUUID()}.jsonl`) });
    control = await createCommandChatControl(database.db, {
      browser, models: { fast: [], deep: [], vision: '' }, recordExperiences: false,
      fullAccess: async id => id === owner, accountFullAccess: async id => id === owner,
      judgeShadow, judgeFixForOwner: true, judgeWithholdForOwner: true, judgeLogText: 'owner', ...config,
    });
    const { id } = await control.create(owner);
    await database.db.insertInto('chat_messages').values({
      id: randomUUID(), conversation_id: id, role: 'user', text: 'My name is Siobhán, not Shivawn.', created_at: new Date(0),
    }).execute();
    await control.send(owner, id, { text: goal });
    await control.settled(id);
    const conversation = await control.detail(owner, id);
    expect(conversation.error).toBeNull();
    const message = conversation.messages.at(-1)!;
    expect(message.role).toBe('assistant');
    await judgeShadow.flush();
    const lines = (await readFile(judgeShadow.logFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as JudgeShadowLine);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      conversationId: id, runId: conversation.run?.id, reply: message.text, status: 'completed', textKept: true, applied: false,
      conversationReview: { action: 'note', applied: false, findings: expect.arrayContaining([{ check: 'preferences', code: 'name_spelling' }]) },
    });
    return { message, line: lines[0]! };
  }

  it('logs the v5 last-resort reply once, including its existing label', async () => {
    const generate = vi.fn(async () => modelText);
    const { message, line } = await reply({ v5Chat: { ready: () => true, generate } });
    expect(generate).toHaveBeenCalledOnce();
    expect(message).toMatchObject({ text: `${modelText}\n\n${V5_CHAT_LABEL}`, experiment: 'v5' });
    expect(line.origin).toBe('chat-v5');
  });

  it.each(['reading-v3-last', 'chat-v5'])('logs the full council reply from %s once', async chosen => {
    const text = chosen === 'chat-v5' ? modelText : `**الموضوع:** Teamwork\n\n${modelText}\n\nSource: https://judge-council.test/teamwork`;
    const deliberate = vi.fn(async (): Promise<CouncilOutcome> => ({
      text, status: 'completed', chosen, changed: true,
      evidence: [{ kind: 'page', text: modelText, url: 'https://judge-council.test/teamwork' }],
      council: { version: 1, chosen, changed: true, reason: 'Fixture choice', elapsedMs: 0, members: [] },
    }));
    const { message, line } = await reply({ modelCouncil: { deliberate } });
    expect(deliberate).toHaveBeenCalledOnce();
    expect(message.text).toBe(chosen === 'chat-v5' ? `${text}\n\n${V5_CHAT_LABEL}` : text);
    expect(line).toMatchObject({ origin: chosen, evidence: 1 });
    if (chosen === 'reading-v3-last') expect(line).toMatchObject({ decision: 'fix', fixedReply: expect.stringContaining('**Subject:** Teamwork') });
  });
});
