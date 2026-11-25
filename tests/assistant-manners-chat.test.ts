import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentBrowser, SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import { mannersRequestHash, prepareMannersTurn } from '../apps/server/src/assistant/manners/chat.js';
import type { JudgeShadow } from '../apps/server/src/assistant/judge-shadow.js';

describe('manners in the chat controller', () => {
  const owner = 'manners-fixture-owner';
  const flag = 'MOHASSAN_SMALL_TALK_MANNERS';
  const search = vi.fn<SearchProvider['search']>(async () => []);
  const bindAccount = vi.fn(async () => {});
  const act = vi.fn(async () => { throw new Error('Unexpected browser action'); });
  const judge = vi.fn<JudgeShadow['observe']>(() => null);
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let control: Awaited<ReturnType<typeof createCommandChatControl>>;

  beforeAll(async () => {
    database = await createDatabase();
    await migrate(database.db);
    const browser = { setCheckpointStore() {}, bindAccount, async hasPage() { return false; }, act, async close() {} } as unknown as AgentBrowser;
    control = await createCommandChatControl(database.db, {
      models: { fast: [], deep: [], vision: '' }, browser,
      searchProvider: { name: 'manners-fixture-search', search },
      judgeShadow: { logFile: 'unused-fixture-path', observe: judge, async flush() {} }, judgeWithholdForOwner: true,
    });
  });
  afterAll(async () => { await control?.shutdown(); await database?.close(); });
  beforeEach(() => {
    vi.stubEnv(flag, '1');
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function ask(goal: string) {
    const { id } = await control.create(owner, { goal });
    await control.settled(id);
    const detail = await control.detail(owner, id);
    const run = await database.db.selectFrom('chat_runs').select(['id', 'goal', 'state', 'status', 'steps']).where('conversation_id', '=', id).executeTakeFirstOrThrow();
    return { id, detail, run, reply: detail.messages.filter(message => message.role === 'assistant').at(-1)?.text ?? '' };
  }

  it('defaults off while logging only classification metadata', async () => {
    vi.stubEnv(flag, undefined);
    const shadow = vi.spyOn(console, 'info').mockImplementation(() => {});
    const goal = 'Hey Mohassan! Calculate 47 × 6.';
    expect(prepareMannersTurn(goal, true)).toBeNull();
    expect(shadow).toHaveBeenCalledWith(expect.stringContaining('"active":false'));
    expect(shadow.mock.calls.flat().join()).not.toContain('47');
    const { run, detail } = await ask(goal);
    expect(run.goal).toBe(goal);
    expect(run.state).not.toHaveProperty('mannersClause');
    expect(detail.messages[0]?.text).toBe(goal);
  });

  it('answers a dialect greeting before clarification, without withholding or using any tool', async () => {
    judge.mockReturnValueOnce({ decision: 'withhold', withholdText: 'withheld' } as ReturnType<JudgeShadow['observe']>);
    const { detail, run, reply } = await ask('شلونك اليوم يا موحسن؟');
    expect(detail.status).toBe('idle');
    expect(detail.question).toBeNull();
    expect(run).toMatchObject({ status: 'completed', steps: 0, state: { routing: { route: 'chat', handler: 'local_conversation' } } });
    expect(reply).toMatch(/\p{Script=Arabic}/u);
    expect(bindAccount).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
    expect(act).not.toHaveBeenCalled();
    expect(judge).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ reply, applyWithhold: false }));
  });

  it.each([
    ['I wanted to thank you again, Mohassan.', /welcome|happy to help/iu],
    ['أراك غدًا يا موحسن!', /اللقاء|السلامة|طيب/u],
    ['Kindly, how should I refer to you?', /^Mohassan$/u],
    ['أنت روبوت ولا إنسان يا موحسن؟', /الذكاء الاصطناعي/u],
  ] as const)('completes %s as local chat with the manners flag unset', async (goal, expected) => {
    vi.stubEnv(flag, undefined);
    const { detail, run, reply } = await ask(goal);
    expect(detail).toMatchObject({ status: 'idle', question: null });
    expect(detail.messages).toHaveLength(2);
    expect(run).toMatchObject({ status: 'completed', steps: 0, state: { routing: { route: 'chat', handler: 'local_conversation' } } });
    expect(reply).toMatch(expected);
    expect(bindAccount).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
    expect(act).not.toHaveBeenCalled();
  });

  it('publishes the greeting at admission while the normal task is still running', async () => {
    let release = () => {};
    const blocked = new Promise<void>(resolve => { release = resolve; });
    bindAccount.mockImplementationOnce(() => blocked);
    const goal = 'Hello! Calculate 19 × 4.';
    const admitted = await control.create(owner, { goal });
    try {
      expect(admitted.status).toBe('running');
      expect(admitted.messages).toEqual([expect.objectContaining({ role: 'user', text: goal }),
        expect.objectContaining({ role: 'assistant', text: expect.stringMatching(/^(?:Hi|Hello)/u) })]);
    } finally {
      release();
      await control.settled(admitted.id);
    }
    expect((await control.detail(owner, admitted.id)).messages.at(-1)?.text).toContain('76');
  });

  it.each([
    ['Hey Mohassan! Calculate 47 × 6.', 'Calculate 47 × 6.', '282'],
    ['احسب ١٥ × ٤، شكرًا.', 'احسب ١٥ × ٤', '60'],
  ])('acknowledges the social clause and completes the original task in %s', async (goal, task, value) => {
    const { detail, run, reply } = await ask(goal);
    expect(detail.messages).toHaveLength(3);
    expect(detail.messages[0]?.text).toBe(goal);
    expect(run).toMatchObject({ goal: task, status: 'completed', state: { routing: { route: 'compute' }, trail: [{ action: 'calculate' }] } });
    const clause = detail.messages[1]?.text;
    expect(clause).toBeTruthy();
    expect(clause).not.toContain('?');
    expect(clause).not.toContain('؟');
    expect(reply).toContain(value);
    expect(judge).toHaveBeenCalledWith(expect.objectContaining({ question: task, reply: expect.stringContaining(value) }));
    expect(search).not.toHaveBeenCalled();
    expect(act).not.toHaveBeenCalled();
  });

  it('acknowledges once while the task asks for a missing value and then resumes it', async () => {
    const { id, detail, run, reply } = await ask('Thanks! Add 12 to it.');
    expect(run).toMatchObject({ status: 'waiting_user', goal: 'Add 12 to it.' });
    expect(reply).toBe(detail.question?.prompt);
    const clause = detail.messages[1]!.text;
    await control.send(owner, id, { text: '30' });
    await control.settled(id);
    const resumed = await control.detail(owner, id);
    expect(resumed.status).toBe('idle');
    expect(resumed.messages.at(-1)?.text).toContain('42');
    expect(resumed.messages.filter(message => message.role === 'assistant' && message.text === clause)).toHaveLength(1);
  });

  it('keeps the task answer byte-for-byte when the user requests only the value', async () => {
    const task = 'Calculate 12 × 11. Only the result.';
    const plain = await ask(task);
    const social = await ask(`Hi! ${task}`);
    expect(social.detail.messages).toHaveLength(3);
    expect(social.reply).toBe('132');
    expect(social.reply).toBe(plain.reply);
  });

  it('preserves quoted task data and does not turn a prohibition into a tool request', async () => {
    expect(prepareMannersTurn('Hi! Translate “شكراً!” into English.', true)?.request).toBe('Translate “شكراً!” into English.');
    const { run } = await ask('Thanks! Do not search the web.');
    expect(run.state.trail).toEqual([]);
    const constrained = await ask('Hi! Calculate 47 × 6. Do not search the web.');
    expect(constrained.reply).toContain('282');
    expect(constrained.run.status).toBe('completed');
    expect(search).not.toHaveBeenCalled();
    expect(act).not.toHaveBeenCalled();
  });

  it('acknowledges appreciation before refusing a device request without tools', async () => {
    vi.stubEnv('MOHASSAN_REFUSAL_POLICY', '1');
    const goal = 'I appreciate your feedback. Would you mind switching off the porch light?';
    const { detail, run, reply } = await ask(goal);
    expect(detail.messages[0]).toMatchObject({ role: 'user', text: goal });
    expect(detail.messages[1]).toMatchObject({ role: 'assistant', text: expect.stringMatching(/welcome|happy to help|glad/iu) });
    expect(run).toMatchObject({ goal: 'Would you mind switching off the porch light?', status: 'blocked', steps: 0,
      state: { routing: { route: 'unsupported', reason: 'request_refused' }, trail: [] } });
    expect(reply).toMatch(/can't|cannot|unable/iu);
    expect(bindAccount).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
    expect(act).not.toHaveBeenCalled();
  });

  it('binds the task to the exact input and leaves schema-trimmed bytes detectable', () => {
    const task = 'Remember exactly this note: "Résumé e\u0301."';
    const displayed = `Hi! ${task}`;
    const hash = (text: string) => createHash('sha256').update(text).digest('hex');
    expect(mannersRequestHash(hash(displayed), displayed, task)).toBe(hash(task));
    expect(mannersRequestHash(hash(` ${displayed} `), displayed, task)).toBe(hash(` ${displayed} `));
  });
});
