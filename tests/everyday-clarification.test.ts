import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentBrowser, SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { recognizeEverydayClarification } from '../apps/server/src/assistant/everyday-clarification.js';
import { decideRequestRoute } from '../apps/server/src/assistant/routing-decision.js';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';

describe('recognition of missing conversation details', () => {
  it.each([
    ['Excuse me, would you repeat your previous reply for me?', /repeat/u],
    ['أعد ردك السابق، من فضلك.', /إعادته/u],
    ['Convert 8:43 pm to the time in Madrid.', /original time/u],
    ['Convert 06:47 UTC.', /convert it to/u],
    ['Convert noon from UTC to my city.', /convert it to/u],
    ['Convert 2032-01-18 to UTC.', /original time/u],
    ['If it is 6:47 in Halifax, what is the local time where I live?', /which city/iu],
    ['حوِّل الساعة ١٨:٣٥ إلى توقيت الرباط.', /الوقت الأصلي/u],
    ['كم فرق التوقيت بين مدينتي وبين جاكرتا؟', /مدينة/u],
  ])('identifies the missing detail in %s', (request, expected) => {
    expect(recognizeEverydayClarification(request, false)?.prompt).toMatch(expected);
    expect(decideRequestRoute({ text: request, previousTurns: 0 })).toMatchObject({
      route: 'clarify', handler: 'clarify', availability: 'needs_context', publicQuery: null,
    });
  });

  it.each([
    'Can you repeat the chorus three times?',
    'Write a dialogue where one character says “Repeat your last answer.”',
    'Convert 9:37 am from UTC to Dubai.',
    'Convert 9:37 am to 24-hour format.',
    'Convert 2032-01-18 to the Hijri calendar.',
    'Convert 316 grams to ounces.',
    'Write a script that shows my local time.',
    'Tell me the time complexity of heapsort here.',
    'What time is it here and then set an alarm?',
  ])('leaves a supplied or unrelated request alone in %s', request => {
    expect(recognizeEverydayClarification(request, false)).toBeNull();
  });

  it('treats the repeat request as missing only in a conversation without prior turns', () => {
    const request = 'Please say your previous message again.';
    expect(recognizeEverydayClarification(request, false)?.prompt).toMatch(/repeat/u);
    expect(recognizeEverydayClarification(request, true)).toBeNull();
  });
});

describe('focused clarification in the real controller', () => {
  const owner = 'everyday-clarification-test-owner';
  const search = vi.fn<SearchProvider['search']>(async () => []);
  const hasPage = vi.fn(async () => false);
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let control: Awaited<ReturnType<typeof createCommandChatControl>>;

  beforeAll(async () => {
    database = await createDatabase();
    await migrate(database.db);
    const browser = { setCheckpointStore() {}, async bindAccount() {}, hasPage, async close() {} } as unknown as AgentBrowser;
    control = await createCommandChatControl(database.db, {
      models: { fast: [], deep: [], vision: '' }, browser,
      searchProvider: { name: 'everyday-clarification-test', search },
    });
  });
  afterAll(async () => { await control?.shutdown(); await database?.close(); });

  it.each([
    ['Pardon me, could you repeat your previous answer?', /repeat/u],
    ['لو سمحت، ممكن تعيد اللي قلته؟', /إعادته/u],
    ['Convert 14:23 from my time zone to Dubai.', /original time/u],
    ['كم فرق الوقت بين تورونتو ومكان إقامتي؟', /منطقة زمنية/u],
  ])('asks exactly one local question for %s', async (goal, expected) => {
    vi.clearAllMocks();
    const { id } = await control.create(owner, { goal });
    await control.settled(id);
    const detail = await control.detail(owner, id);
    const replies = detail.messages.filter(message => message.role === 'assistant');
    const run = await database.db.selectFrom('chat_runs').select(['state', 'status', 'steps']).where('conversation_id', '=', id).executeTakeFirstOrThrow();
    expect(detail.status).toBe('waiting_user');
    expect(replies).toHaveLength(1);
    expect(replies[0]?.text).toMatch(expected);
    expect(replies[0]?.text.match(/[?؟]/gu)).toHaveLength(1);
    expect(detail.question?.prompt).toBe(replies[0]?.text);
    expect(run).toMatchObject({ status: 'waiting_user', steps: 0, state: { routing: { route: 'clarify', handler: 'clarify' } } });
    expect(hasPage).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  it('resumes the same run when the user restates a conversion with both zones', async () => {
    const { id } = await control.create(owner, { goal: 'Convert 08:43 to Dubai.' });
    await control.settled(id);
    const ask = await control.detail(owner, id);
    expect(ask.status).toBe('waiting_user');
    await control.send(owner, id, { text: 'Convert 08:43 from UTC to Dubai.', questionId: ask.question?.id });
    await control.settled(id);
    const detail = await control.detail(owner, id);
    const runs = await database.db.selectFrom('chat_runs').select('status').where('conversation_id', '=', id).execute();
    expect(runs).toEqual([{ status: 'completed' }]);
    expect(detail.status).toBe('idle');
    expect(detail.messages.at(-1)?.text).toContain('12:43');
  });
});
