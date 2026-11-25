import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createConversationShadow, type ConversationShadowLine } from '../apps/server/src/assistant/conversation-state-shadow.js';

describe('conversation state v2 shadow', () => {
  let directory: string;
  beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), 'mohassan-conversation-shadow-')); });
  afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

  it('threads v2 state per conversation and logs one line per turn without touching the reply', async () => {
    const shadow = createConversationShadow({ logFile: join(directory, 'nested', 'shadow.jsonl'), now: () => new Date('2026-11-22T03:00:00Z') });
    const first = shadow.observe({ conversationId: 'c1', turnId: 'u1', text: 'ما عاصمة اليابان؟' });
    expect(first?.type).toBe('new_request');
    const second = shadow.observe({ conversationId: 'c1', turnId: 'u2', text: 'وكم عدد سكانها؟', shown: [{ label: 'طوكيو', kind: 'place' }] });
    expect(second?.type).toBe('follow_up_property');
    expect(second?.query).toBe('عدد سكان طوكيو');
    const other = shadow.observe({ conversationId: 'c2', turnId: 'u1', text: 'وكم عدد سكانها؟' });
    expect(other?.type).toBe('ambiguous');
    await shadow.flush();
    const lines = (await readFile(shadow.logFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as ConversationShadowLine);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ at: '2026-11-22T03:00:00.000Z', conversationId: 'c1', turnId: 'u1', type: 'new_request', v1: { kind: 'new', intent: 'web_search' } });
    expect(lines[1]).toMatchObject({ type: 'follow_up_property', entity: 'طوكيو', property: 'population', query: 'عدد سكان طوكيو', assumption: 'فهمتُ أن المقصود طوكيو.' });
    expect(lines[2]).toMatchObject({ conversationId: 'c2', type: 'ambiguous', needs: 'missing_reference', query: null });
    expect(typeof lines[1]!.ms).toBe('number');
  });

  it('takes a pending approval as the code\'s answer and clears it for the next turn', async () => {
    const shadow = createConversationShadow({ logFile: join(directory, 'pending.jsonl') });
    shadow.observe({ conversationId: 'c3', turnId: 'u1', text: 'افتح https://ads.google.com' });
    const answer = shadow.observe({ conversationId: 'c3', turnId: 'u2', text: 'موافق، تابع', pending: { kind: 'approval', id: 'approve-1' } });
    expect(answer?.type).toBe('card_answer');
    expect(shadow.state('c3')?.pending).toBeNull();
    const later = shadow.observe({ conversationId: 'c3', turnId: 'u3', text: 'موافق' });
    expect(later?.type).not.toBe('card_answer');
    await shadow.flush();
  });

  it('omits credential-bearing inputs from the replay journal without discarding their live decision', async () => {
    const shadow = createConversationShadow({ logFile: join(directory, 'credential.jsonl') });
    const sample = 'conversation-replay-fixture-content';
    const held = shadow.observe({ conversationId: 'fixture-conversation', turnId: 'credential-turn',
      text: `Cookie: fixture_session=${sample}` });
    expect(held).not.toBeNull();
    shadow.observe({ conversationId: 'fixture-conversation', turnId: 'ordinary-turn', text: 'What is the capital of Japan?' });
    await shadow.flush();
    const contents = await readFile(shadow.logFile, 'utf8');
    expect(contents.includes(sample)).toBe(false);
    expect(JSON.parse(contents)).toMatchObject({ turnId: 'ordinary-turn', text: 'What is the capital of Japan?' });
  });

  it('seeds a forgotten conversation from stored user turns only and evicts the oldest conversations', async () => {
    const shadow = createConversationShadow({ logFile: join(directory, 'seed.jsonl'), maxConversations: 2 });
    shadow.seed('old', [{ id: 'u1', text: 'متى مباراة الهلال؟' }]);
    const turn = shadow.observe({ conversationId: 'old', turnId: 'u2', text: 'طيب ومباراة النصر؟' });
    expect(turn?.type).toBe('follow_up_entity');
    expect(turn?.query).toBe('مباراة النصر');
    shadow.observe({ conversationId: 'a', turnId: 'u1', text: 'ما عاصمة كندا؟' });
    shadow.observe({ conversationId: 'b', turnId: 'u1', text: 'ما عاصمة مصر؟' });
    expect(shadow.state('old')).toBeUndefined();
    expect(shadow.state('a')).toBeDefined();
    expect(shadow.state('b')).toBeDefined();
    await shadow.flush();
  });

  it('rebuilds a conversation it forgot (a restart) from the user turns in its own log', async () => {
    const logFile = join(directory, 'restart.jsonl');
    const before = createConversationShadow({ logFile });
    await before.ready();
    before.observe({ conversationId: 'r1', turnId: 'u1', text: 'ما عاصمة اليابان؟' });
    before.observe({ conversationId: 'r2', turnId: 'u1', text: 'متى مباراة الهلال؟' });
    await before.flush();
    const after = createConversationShadow({ logFile });
    await after.ready();
    const japan = after.observe({ conversationId: 'r1', turnId: 'u2', text: 'وكم عدد سكانها؟' });
    expect(japan?.type).toBe('follow_up_property');
    expect(japan?.query).toBe('عدد سكان عاصمة اليابان');
    expect(after.observe({ conversationId: 'r2', turnId: 'u2', text: 'طيب ومباراة النصر؟' })?.query).toBe('مباراة النصر');
    await after.flush();
    const lines = (await readFile(logFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as ConversationShadowLine);
    expect(lines.map(line => line.seeded ?? 0)).toEqual([0, 0, 1, 1]);
    const off = createConversationShadow({ logFile, replayLog: false });
    expect(off.observe({ conversationId: 'r1', turnId: 'u3', text: 'وكم عدد سكانها؟' })?.type).toBe('ambiguous');
    await off.flush();
  });

  it('runs observeLater after the caller, in call order, and flush waits for it', async () => {
    const shadow = createConversationShadow({ logFile: join(directory, 'later.jsonl') });
    shadow.observeLater({ conversationId: 'l1', turnId: 'u1', text: 'متى مباراة الهلال؟' });
    shadow.observeLater({ conversationId: 'l1', turnId: 'u2', text: 'طيب ومباراة النصر؟' });
    expect(shadow.state('l1')).toBeUndefined();
    await shadow.flush();
    const lines = (await readFile(shadow.logFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as ConversationShadowLine);
    expect(lines.map(line => line.type)).toEqual(['new_request', 'follow_up_entity']);
    expect(shadow.state('l1')?.topics.at(-1)?.entity).toBe('النصر');
  });

  it('copies the input of observeLater before the caller changes it', async () => {
    const shadow = createConversationShadow({ logFile: join(directory, 'copy.jsonl') });
    shadow.observe({ conversationId: 'k1', turnId: 'u1', text: 'ما عاصمة اليابان؟' });
    const shown = [{ label: 'طوكيو', kind: 'place' as const }];
    shadow.observeLater({ conversationId: 'k1', turnId: 'u2', text: 'وكم عدد سكانها؟', shown });
    shown[0]!.label = 'أوساكا';
    await shadow.flush();
    const lines = (await readFile(shadow.logFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as ConversationShadowLine);
    expect(lines.at(-1)?.query).toBe('عدد سكان طوكيو');
  });

  it('never throws into the chat when the log cannot be written', async () => {
    const shadow = createConversationShadow({ logFile: join(directory, 'seed.jsonl', 'impossible', 'shadow.jsonl') });
    const turn = shadow.observe({ conversationId: 'c4', turnId: 'u1', text: 'شكرًا' });
    expect(turn?.type).toBe('small_talk');
    await expect(shadow.flush()).resolves.toBeUndefined();
  });
});
