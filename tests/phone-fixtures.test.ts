import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ChatConversationSchema, ChatConversationSummarySchema } from '@mohassan/contracts';
import { WASLA_PHONE_FIELDS } from '../apps/server/src/wasla.ts';

/**
 * tests/fixtures/phone/ holds real exchanges recorded from the server by
 * scripts/phone-fixtures.ts. The iPhone app (Swift checks) and the computer
 * service (pytest) read the same files. This side proves each recorded body is
 * exactly what the contract promises the phone, with nothing extra.
 */
const DIR = join(import.meta.dirname, 'fixtures', 'phone');
const Envelope = z.object({
  capturedAt: z.string(), sourceCommit: z.string(),
  request: z.object({ method: z.enum(['GET', 'POST', 'DELETE']), url: z.string(), body: z.unknown().optional() }).strict(),
  response: z.object({ status: z.number().int(), body: z.unknown() }).strict(),
}).strict();
const PhoneConversation = ChatConversationSchema.pick(Object.fromEntries(WASLA_PHONE_FIELDS.map(key => [key, true])) as Record<(typeof WASLA_PHONE_FIELDS)[number], true>).strict();
// `configured` says whether the server has a chat model; the phone ignores it.
const PhoneList = z.object({ conversations: z.array(ChatConversationSummarySchema), configured: z.boolean().optional() }).strict();
const Fault = z.object({ error: z.object({ code: z.string(), message: z.string() }).strict() }).strict();

async function fixtures() {
  const files = (await readdir(DIR)).filter(name => name.endsWith('.json') && name !== 'index.json').sort();
  const entries = await Promise.all(files.map(async name => ({ name: name.replace(/\.json$/, ''), ...Envelope.parse(JSON.parse(await readFile(join(DIR, name), 'utf8'))) })));
  return entries;
}

describe('phone fixtures', () => {
  it('are recorded from a real server and listed in the index', async () => {
    const entries = await fixtures();
    expect(entries.length).toBeGreaterThanOrEqual(20);
    const index = JSON.parse(await readFile(join(DIR, 'index.json'), 'utf8'));
    expect(index.generator).toBe('scripts/phone-fixtures.ts');
    expect([...index.fixtures.map((item: { file: string }) => item.file)].sort()).toEqual(entries.map(entry => entry.name).sort());
    for (const entry of entries) expect(entry.sourceCommit, entry.name).toBe(index.sourceCommit);
  });

  it('every conversation the phone reads matches the contract, with no browser block or decision log', async () => {
    const details = (await fixtures()).filter(entry => entry.response.status === 200 && /^(detail-|create$|create-replayed$|messages-|approve-|respond-|cancel$)/.test(entry.name));
    expect(details.length).toBeGreaterThanOrEqual(10);
    for (const entry of details) {
      const parsed = PhoneConversation.safeParse(entry.response.body);
      expect(parsed.success, `${entry.name}: ${parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 3))}`).toBe(true);
      const text = JSON.stringify(entry.response.body);
      for (const banned of ['recoveryToken', 'screenUrl', '"browser"', '"decisions"', '"goal"', 'browserAccount']) expect(text, `${entry.name} leaks ${banned}`).not.toContain(banned);
    }
  });

  it('records each state the phone must render', async () => {
    const byName = Object.fromEntries((await fixtures()).map(entry => [entry.name, entry.response.body as any]));
    expect(byName['detail-completed'].status).toBe('idle');
    expect(byName['detail-completed'].messages.at(-1).text).toContain('345');
    expect(byName['detail-completed-follow-up'].messages.at(-1).text).toContain('120');
    expect(byName['detail-greeting'].status).toBe('idle');
    expect(byName['detail-unconfirmed-sign-in'].status).toBe('idle');
    expect(byName['detail-question-fields'].status).toBe('waiting_user');
    // Several questions in one card: the web and the phone send the answers with the question's id (messages-field-answers).
    expect(byName['detail-question-fields'].question.fields.map((field: { id: string }) => field.id)).toEqual(['to', 'kind', 'details', 'from']);
    expect(byName['detail-question-fields'].question.options).toEqual([{ id: 'stop', label: 'توقف هنا' }]);
    expect(byName['detail-completed-letter'].status).toBe('idle');
    expect(byName['detail-completed-letter'].messages.at(-1).text).toContain('الأستاذ خالد');
    expect(byName['detail-approval'].status).toBe('waiting_approval');
    expect(byName['detail-approval'].approval.detail).toContain('POST /consent');
    expect(byName['detail-approval-refused'].status).toBe('idle');
    // Cancelling returns the conversation to idle; only the run is marked cancelled.
    expect(byName['detail-cancelled'].status).toBe('idle');
    expect(byName['detail-stopped'].status).toBe('idle');
    for (const failed of ['detail-failed-blocked-address']) {
      expect(byName[failed].status, failed).toBe('failed');
      expect(typeof byName[failed].error, failed).toBe('string');
      expect(byName[failed].error.length, failed).toBeGreaterThan(10);
    }
  });

  it('lists and errors keep their shapes', async () => {
    const byName = Object.fromEntries((await fixtures()).map(entry => [entry.name, entry]));
    expect(PhoneList.safeParse(byName['list-empty']!.response.body).success).toBe(true);
    expect((byName['list-empty']!.response.body as { conversations: unknown[] }).conversations).toEqual([]);
    const list = PhoneList.parse(byName['list']!.response.body);
    expect(list.conversations.length).toBeGreaterThanOrEqual(5);
    expect(byName['status']!.response.body).toEqual({ ok: true, bridge: 'mohassan' });
    expect(byName['delete']!.response.body).toEqual({ ok: true });
    expect(byName['campaign-events']!.response.body).toEqual({ taskId: null, lastSeq: 0, events: [] });
    for (const [name, status, code] of [['error-not-found', 404, 'CHAT_NOT_FOUND'], ['error-deleted', 404, 'CHAT_NOT_FOUND'], ['error-invalid-id', 400, 'VALIDATION_ERROR'], ['error-question-changed', 409, 'CHAT_QUESTION_CHANGED'], ['error-approval-changed', 409, 'CHAT_APPROVAL_CHANGED'], ['error-request-reused', 409, 'CLIENT_REQUEST_REUSED']] as const) {
      const entry = byName[name]!;
      expect(entry.response.status, name).toBe(status);
      expect(Fault.parse(entry.response.body).error.code, name).toBe(code);
    }
  });

  it('request keys: a resend returns the first result, a reused key is refused, a lookup says what happened', async () => {
    const byName = Object.fromEntries((await fixtures()).map(entry => [entry.name, entry]));
    const key = (name: string) => (byName[name]!.request.body as { clientRequestId?: string }).clientRequestId;
    expect(key('create-replayed')).toBe(key('create'));
    expect(byName['create-replayed']!.response.status).toBe(200);
    expect((byName['create-replayed']!.response.body as { id: string }).id).toBe((byName['create']!.response.body as { id: string }).id);
    expect(key('error-request-reused')).toBe(key('create'));
    // The phone answers a field card as the web does: the answers in the card's order, with the question's id.
    const card = byName['detail-question-fields']!.response.body as { id: string; question: { id: string; fields: { id: string }[] } };
    const sent = byName['messages-field-answers']!.request.body as { questionId: string; answers: { fieldId: string; value: string }[] };
    expect(sent.questionId).toBe(card.question.id);
    expect(sent.answers.map(answer => answer.fieldId)).toEqual(card.question.fields.map(field => field.id));
    expect(byName['messages-field-answers']!.response.status).toBe(200);
    expect(byName['request-done']!.response.body).toEqual({ known: true, kind: 'messages', state: 'done', conversationId: card.id });
    expect(byName['request-unknown']!.response.body).toEqual({ known: false });
    // Every recorded phone request that changes something carries its key, as the app sends it; stopping needs none.
    for (const entry of Object.values(byName)) {
      if (entry.request.method !== 'POST' || entry.request.url.endsWith('/cancel')) continue;
      expect(typeof key(entry.name), entry.name).toBe('string');
    }
  });
});
