import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDatabase } from '@mohassan/database';
import { buildPrompt, newBrainState } from '../apps/server/src/assistant/brain.js';
import { readResponsePolicyHistory, responsePolicyEarlierContext } from '../apps/server/src/assistant/response-policy-context.js';
import { bindResponsePolicyChannel, chatResponsePolicyInput, shapeCompletedChatReply } from '../apps/server/src/assistant/response-policy-runtime.js';

afterEach(() => vi.unstubAllEnvs());

describe('response policy in reply composition', () => {
  it('preserves the default prompt and adds non-truncating guidance when enabled', () => {
    const input = { state: newBrainState(), request: 'Explain the process briefly.', page: null, history: [] };
    vi.stubEnv('MOHASSAN_REPLY_POLICY_ENABLED', undefined);
    expect(buildPrompt(input)).not.toContain('Lead with the answer');
    vi.stubEnv('MOHASSAN_REPLY_POLICY_ENABLED', '1');
    const prompt = buildPrompt(input);
    expect(prompt).toContain('Aim for one line or a value');
    expect(prompt).toContain('every required fact, number, step, warning, and source');
    expect(prompt).toContain(input.request);
  });

  it('uses an explicit Arabic dialect and exposes the phone channel only within its request', async () => {
    vi.stubEnv('MOHASSAN_REPLY_POLICY_ENABLED', '1');
    const state = newBrainState();
    expect(buildPrompt({ state, request: 'Explain why leaves change colour in Egyptian Arabic.', page: null, history: [] }))
      .toContain('Match the egyptian dialect');
    const channel = bindResponsePolicyChannel(async () => chatResponsePolicyInput('Where is it?', state).channel,
      { 'user-agent': 'Wasla/1.0 Android' });
    expect(await channel('account')).toBe('phone');
    expect(chatResponsePolicyInput('Where is it?', state).channel).toBe('web');
  });

  it('removes only a verbatim framing echo and leaves numbers, sources and incomplete replies intact', () => {
    const question = 'Who wrote Persuasion?';
    const answer = 'Jane Austen wrote Persuasion.';
    const echo = `You asked: ${question}\n${answer}`;
    vi.stubEnv('MOHASSAN_REPLY_POLICY_ENABLED', undefined);
    expect(shapeCompletedChatReply(echo, question, 'completed')).toBe(echo);
    vi.stubEnv('MOHASSAN_REPLY_POLICY_ENABLED', '1');
    expect(shapeCompletedChatReply(echo, question, 'completed')).toBe(answer);
    expect(shapeCompletedChatReply(echo, question, 'partial')).toBe(echo);
    for (const lead of ['Who won in 2024?', 'What is https://example.test?', 'What does “urgent” mean?']) {
      const text = `You asked: ${lead}\n${answer}`;
      expect(shapeCompletedChatReply(text, lead, 'completed')).toBe(text);
    }
  });
});

describe('response policy context assembly', () => {
  let database: Awaited<ReturnType<typeof createDatabase>>;
  const conversation = randomUUID();
  const otherConversation = randomUUID();
  const owner = 'policy-test-owner';
  const previousTurns = 10;
  const text = 'What ceiling did I mention at the beginning of this conversation?';

  beforeAll(async () => {
    database = await createDatabase();
    const { db } = database;
    await sql`create table chat_conversations (id text primary key, owner_id text not null)`.execute(db);
    await sql`create table chat_messages (id text primary key, conversation_id text not null, role text not null, text text not null, created_at timestamptz not null)`.execute(db);
    await db.insertInto('chat_conversations').values([{ id: conversation, owner_id: owner },
      { id: otherConversation, owner_id: owner }]).execute();
    await db.insertInto('chat_messages').values([
      ...Array.from({ length: 11 }, (_, index) => ({
        id: randomUUID(), conversation_id: conversation, role: index === 1 ? 'assistant' : 'user',
        text: index === 0 ? 'The ceiling is 975 units <example>.'
          : index === 1 ? 'The known ceiling secret is local-only.' : index === 10 ? text : `Unrelated update ${index}`,
        created_at: new Date(index * 1000),
      })),
      { id: randomUUID(), conversation_id: otherConversation, role: 'user', text: 'The ceiling is across-conversation marker.',
        created_at: new Date(0) },
    ]).execute();
  });
  afterAll(async () => { await database?.close(); });

  const load = (state: object, request: string, ownerId = owner) => readResponsePolicyHistory({
    db: database.db, ownerId, conversationId: conversation, state, policy: { text: request, previousTurns },
    recentLimit: 7, scrub: value => value.replace('local-only', '[redacted]'),
  });

  it('uses only recent messages by default and on regular turns with the flag on', async () => {
    const state = {};
    vi.stubEnv('MOHASSAN_CONTEXT_POLICY_ENABLED', undefined);
    expect(await load(state, text)).toHaveLength(7);
    expect(responsePolicyEarlierContext(state)).toBeUndefined();
    vi.stubEnv('MOHASSAN_CONTEXT_POLICY_ENABLED', '1');
    expect(await load(state, 'What is a circuit breaker?')).toHaveLength(7);
    expect(responsePolicyEarlierContext(state)).toBeUndefined();
  });

  it('ranks older messages only within the account and conversation and escapes them in the prompt', async () => {
    vi.stubEnv('MOHASSAN_CONTEXT_POLICY_ENABLED', '1');
    const state = newBrainState();
    const recent = await load(state, text);
    expect(recent.every(turn => !turn.text.includes('975'))).toBe(true);
    const earlier = responsePolicyEarlierContext(state);
    expect(earlier?.trigger).toBe('older_reference');
    expect(earlier?.data).toContain('975 units');
    expect(earlier?.data).toContain('[redacted]');
    expect(earlier?.data).not.toMatch(/local-only|across-conversation marker/);
    const prompt = buildPrompt({ request: text, state, page: null, history: recent.slice(1).reverse() });
    expect(prompt).toContain('<untrusted_data kind="selected_earlier_conversation">');
    expect(prompt).toContain('&lt;example&gt;');
    expect(await load({}, text, 'other-account')).toEqual([]);
  });

  it('honors a direct instruction to use the current message only', async () => {
    vi.stubEnv('MOHASSAN_CONTEXT_POLICY_ENABLED', '1');
    const state = {};
    expect(await load(state, 'Summarize this conversation. Use only the current message.')).toHaveLength(1);
    expect(responsePolicyEarlierContext(state)).toBeUndefined();
  });
});
