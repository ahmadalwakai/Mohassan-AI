import type { AgentBrowser } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { InferenceRouter, UsageMonitor } from '@mohassan/providers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildPrompt, newBrainState } from '../apps/server/src/assistant/brain.js';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';

const owner = 'reply-preference-fixture-owner';
const options = () => ({
  models: { fast: [], deep: [], vision: '' },
  browser: { setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; }, async close() {} } as unknown as AgentBrowser,
});

describe('reply preferences across real chat turns', () => {
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let chat: Awaited<ReturnType<typeof createCommandChatControl>>;

  beforeAll(async () => {
    database = await createDatabase();
    await migrate(database.db);
    chat = await createCommandChatControl(database.db, options());
  });
  afterAll(async () => { await chat?.shutdown(); await database?.close(); });

  async function answer(id: string, text: string, ownerId = owner) {
    await chat.send(ownerId, id, { text });
    await chat.settled(id);
    const message = (await chat.detail(ownerId, id)).messages.at(-1);
    expect(message?.role).toBe('assistant');
    return message!.text;
  }

  it('persists and reopens the preference, permits a one-turn override and stays account and conversation scoped', async () => {
    const { id } = await chat.create(owner);
    expect(await answer(id, 'أجب بالعربية دائماً')).toMatch(/تفضيلات الرد/u);
    await answer(id, 'من الآن إجابات مختصرة');
    for (let factor = 2; factor < 12; factor++) {
      expect(await answer(id, `Calculate ${factor} × 12`)).toMatch(new RegExp(`ناتج.*${factor * 12}`, 'u'));
    }
    await chat.shutdown();
    chat = await createCommandChatControl(database.db, options());
    expect(await answer(id, 'Calculate 37 × 24')).toMatch(/ناتج.*888/u);
    expect(await answer(id, 'Calculate 37 × 24. Answer in English.')).toMatch(/equals 888/u);
    expect(await answer(id, 'Calculate 37 × 24')).toMatch(/ناتج.*888/u);

    const other = await chat.create(owner);
    const otherOwner = await chat.create('different-reply-preference-fixture-owner');
    expect(await answer(other.id, 'Calculate 37 × 24')).toBe('37 * 24 = 888');
    expect(await answer(otherOwner.id, 'Calculate 37 × 24', 'different-reply-preference-fixture-owner')).toBe('37 * 24 = 888');

    expect(await answer(id, 'Always answer in English.')).toMatch(/updated your reply preferences/u);
    expect(await answer(id, 'لا داعي للاختصار بعد الآن')).toMatch(/updated your reply preferences/u);
    const row = await database.db.selectFrom('chat_conversations').select('reply_preferences').where('id', '=', id).executeTakeFirstOrThrow();
    expect(row.reply_preferences).toEqual({ lang: 'en' });
    expect(await answer(id, 'احسب ٣٧ × ٢٤')).toMatch(/equals 888/u);
  });

  it('asks the model to revise a wrong-language draft and trims the accepted draft before publication', async () => {
    const prompts: string[] = [];
    const first = 'ضوء القمر فوق التلال.';
    const second = 'يلمع فوق الطريق.';
    const router = new InferenceRouter([{
      key: 'reply-fixture', model: 'reply-fixture', providerId: 'reply-fixture', cost: 'free',
      provider: { id: 'reply-fixture', async generate(request) {
        prompts.push(request.goal);
        const text = prompts.length === 1 ? 'Moonlight shines over the hills.' : `${first} ${second} يغيب مع الفجر.`;
        return { model: 'reply-fixture', usage: { inputTokens: 1, outputTokens: 1 },
          text: JSON.stringify({ tool: 'answer', text, outcome: 'done', thought: null, plan: null, note: null, url: null,
            ref: null, submit: null, options: null, sensitive: null }) };
      } },
    }], { freeOnly: true, automaticFallback: false, allowPaidFallback: false, maxAttempts: 1 }, new UsageMonitor());
    const modelChat = await createCommandChatControl(database.db, { ...options(), recordExperiences: false,
      inference: { active: () => true, routerFor: () => router } });
    try {
      const { id } = await modelChat.create(owner, { goal: 'Write a poem about a silver moon in two Arabic sentences.' });
      await modelChat.settled(id);
      const { messages, error } = await modelChat.detail(owner, id);
      expect(error).toBeNull();
      expect(prompts).toHaveLength(2);
      for (const prompt of prompts) expect(prompt).toMatch(/Reply constraints for this turn\nAnswer in Arabic\. Use at most 2 sentences\./u);
      expect(messages.at(-1)?.text).toBe(`${first} ${second}`);
    } finally {
      await modelChat.shutdown();
    }
  });
});

it('puts the current constraints in the model prompt outside the six-message history', () => {
  const instruction = 'أجب بالعربية دائماً';
  const history = [{ role: 'user', text: instruction }, ...Array.from({ length: 10 }, (_, index) => ({ role: 'user', text: `Turn ${index + 1}` }))];
  const state = { ...newBrainState(), replyTurn: { constraints: { lang: 'ar' as const, sentences: 2, list: false, links: 0 } } };
  const prompt = buildPrompt({ request: 'Evaluate the next step.', page: null, history, state });
  expect(prompt).not.toContain(instruction);
  expect(prompt).toContain('Reply constraints for this turn\nAnswer in Arabic. Use at most 2 sentences. Use prose without a list. Include no links.');
});
