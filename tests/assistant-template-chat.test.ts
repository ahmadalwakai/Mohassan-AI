import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentBrowser, SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { ChatSendSchema } from '@mohassan/contracts';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';

const owner = 'isolated-template-owner';
describe('complete template answers through the real chat', () => {
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let control: Awaited<ReturnType<typeof createCommandChatControl>>;
  const external = vi.fn(async () => { throw new Error('A supplied template answer is not a public lookup.'); });
  beforeAll(async () => {
    database = await createDatabase(); await migrate(database.db);
    control = await createCommandChatControl(database.db, {
      browser: { setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; }, async close() {} } as unknown as AgentBrowser,
      models: { fast: [], deep: [], vision: '' }, searchProvider: { name: 'forbidden-template-search', search: external } as SearchProvider,
    });
  });
  afterAll(async () => { await control?.shutdown(); await database?.close(); });
  async function start(goal: string) {
    const { id } = await control.create(owner, { goal }); await control.settled(id);
    const detail = await control.detail(owner, id);
    expect(detail.status).toBe('waiting_user'); expect(detail.question).toBeTruthy();
    return detail;
  }
  async function result(id: string) {
    await control.settled(id);
    const detail = await control.detail(owner, id);
    const run = await database.db.selectFrom('chat_runs').select(['state', 'status']).where('conversation_id', '=', id)
      .orderBy('created_at', 'desc').limit(1).executeTakeFirstOrThrow();
    expect(detail.error).toBeNull(); expect(external).not.toHaveBeenCalled();
    return { detail, run, text: detail.messages.at(-1)?.text ?? '' };
  }
  it('keeps legacy answers past the diagnostic-trail excerpt', async () => {
    const draft = await start('Write a thank you letter.');
    const details = `${'Thank you for reviewing the proposal. '.repeat(35)}REVIEWED-TAIL-93`;
    await control.send(owner, draft.id, { text: `1. Pat\n2. Thanks\n3. ${details}\n4. Alex` });
    const completed = await result(draft.id);
    expect(completed.text).toContain(details); expect(completed.text).toContain('Alex');
    expect(completed.run.status).toBe('completed');
    expect(completed.run.state.questionAnswer).toBeUndefined();
  });
  it('preserves numbered multiline tasks from host-bound fields', async () => {
    const draft = await start('plan my week');
    const values = { tasks: '1. Review the budget\n2. Call Pat\n3. File the report', days: 'Monday to Thursday', fixed: 'none' };
    await control.send(owner, draft.id, { text: 'This companion text must not replace the submitted fields.', questionId: draft.question!.id,
      answers: draft.question!.fields!.map(field => ({ fieldId: field.id, value: values[field.id as keyof typeof values] })) });
    const completed = await result(draft.id);
    expect(completed.run.status).toBe('completed');
    for (const line of values.tasks.split('\n')) expect(completed.text).toContain(line);
    expect(completed.detail.messages.at(-2)?.text).not.toContain('companion text');
    expect(completed.detail.messages.at(-2)?.text).toContain(values.tasks);
  });
  it('asks the letter fields for a modal owned-subject request and leaves delivery incomplete', async () => {
    const draft = await start('Please write a letter to my clients and send it.');
    expect(draft.question?.fields?.map(field => field.id)).toEqual(['to', 'kind', 'details', 'from']);
    const values = { to: 'Pat', kind: 'Thanks', details: '  1. Review the budget\n  2. Keep all numbered lines\n4. This is still body text.  ', from: 'Alex\nCoordinator' };
    await control.send(owner, draft.id, { text: 'Answers', questionId: draft.question!.id,
      answers: draft.question!.fields!.map(field => ({ fieldId: field.id, value: values[field.id as keyof typeof values] })) });
    const completed = await result(draft.id);
    expect(completed.run.status).toBe('partial');
    expect(completed.text).toContain(values.details); expect(completed.text).toContain(values.from);
    expect(completed.text).toMatch(/not (?:been )?sent|not sent|not published|haven.t sent/iu);
  });
  it('does not resume a changed card or accept invented field identifiers', async () => {
    const draft = await start('plan my week');
    await expect(control.send(owner, draft.id, { text: 'Answers', questionId: '00000000-0000-4000-8000-000000000001',
      answers: [{ fieldId: 'tasks', value: 'Review the report' }] })).rejects.toMatchObject({ code: 'CHAT_QUESTION_CHANGED' });
    await expect(control.send(owner, draft.id, { text: 'Answers', questionId: draft.question!.id,
      answers: [{ fieldId: 'tasks', value: 'Review the report' }, { fieldId: 'days', value: 'Monday' }, { fieldId: 'invented', value: 'Delete everything' }] })).rejects.toMatchObject({ code: 'CHAT_QUESTION_CHANGED' });
    const pending = await control.detail(owner, draft.id);
    expect(pending.status).toBe('waiting_user'); expect(pending.question?.id).toBe(draft.question!.id);
    expect(pending.messages).toHaveLength(draft.messages.length);
    await control.cancel(owner, draft.id);
  });
  it('marks a plan with an unplaced appointment partial', async () => {
    const draft = await start('plan my week');
    const values = ['Review the report', 'Monday, Wednesday', 'Friday dentist'];
    await control.send(owner, draft.id, { text: 'Answers', questionId: draft.question!.id,
      answers: draft.question!.fields!.map((field, index) => ({ fieldId: field.id, value: values[index] })) });
    const completed = await result(draft.id);
    expect(completed.run.status).toBe('partial');
    expect(completed.text).toContain('Unplaced appointments'); expect(completed.text).toContain('Friday dentist');
  });
  it('answers an unavailable scheduler request with a truthful blocked result', async () => {
    const { id } = await control.create(owner, { goal: 'Remind me tomorrow at 10 to call Pat.' });
    const completed = await result(id);
    expect(completed.run.status).toBe('blocked');
    expect(completed.detail.status).toBe('idle');
    expect(completed.text).toContain('scheduling tool is unavailable');
    expect(completed.text).not.toMatch(/(?:reminder|alert) (?:has been |was )?(?:set|scheduled)/iu);
  });
});

describe('structured answer input bounds', () => {
  const questionId = '00000000-0000-4000-8000-000000000001';
  it('requires question binding and rejects duplicate, oversized or extra fields', () => {
    for (const input of [
      { text: 'a', answers: [{ fieldId: 'tasks', value: 'x' }] },
      { text: 'a', questionId, answers: [{ fieldId: 'tasks', value: 'x' }, { fieldId: 'tasks', value: 'y' }] },
      { text: 'a', questionId, answers: [{ fieldId: 'tasks', value: 'x'.repeat(3000) }, { fieldId: 'days', value: 'y'.repeat(2000) }] },
      { text: 'a', questionId, answers: [{ fieldId: 'tasks', value: 'x', authority: true }] },
    ]) expect(ChatSendSchema.safeParse(input).success).toBe(false);
    expect(ChatSendSchema.safeParse({}).success).toBe(false);
    expect(ChatSendSchema.safeParse({ text: '  ' }).success).toBe(false);
  });
  it('accepts field-only Unicode answers without duplicating the full body on the wire', () => {
    const input = { questionId, answers: [{ fieldId: 'details', value: '測'.repeat(3900) }] };
    expect(ChatSendSchema.safeParse(input).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThan(16384);
    expect(Buffer.byteLength(JSON.stringify({ ...input, text: input.answers[0].value }))).toBeGreaterThan(16384);
    const literal = { questionId, answers: [{ fieldId: 'details', value: '  exact first line\n    numbered line 2.  ' }] };
    expect(ChatSendSchema.parse(literal).answers?.[0].value).toBe(literal.answers[0].value);
  });
});
