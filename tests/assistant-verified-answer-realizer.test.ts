import type { AgentBrowser } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { judge } from '../apps/server/src/assistant/judge.js';
import { evaluateLocalComputation } from '../apps/server/src/assistant/local-computation.js';
import { parseExchangeRateTable, reasonCurrency } from '../apps/server/src/assistant/reasoning/currency.js';
import { realizeVerifiedComputation } from '../apps/server/src/assistant/verified-answer-realizer.js';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';

const flag = 'MOHASSAN_ANSWER_REALIZER';
const evaluatedAt = new Date(0);

function calculation(request: string) {
  const result = evaluateLocalComputation(request, evaluatedAt);
  if (!result) throw new Error(`Expected a calculation for ${request}`);
  return result;
}

function numericLiterals(reply: string) {
  return reply.match(/\d{4}-\d{2}-\d{2}|[+−-]?\d+(?:\.\d+)?/gu);
}

afterEach(() => vi.unstubAllEnvs());

describe('verified answer realization', () => {
  it.each([
    'Calculate -12 + 5.', 'احسب ١٢ + ٥',
    'Convert 3.75 kilograms to grams.', 'حوّل ٣٫٧٥ كيلوجرام إلى جرام.',
    'What day of the week was 2024-02-29?', 'أي يوم يوافق 2024-02-29؟',
    'How many days between 2024-02-28 and 2024-03-01?', 'كم يوما بين 2024-02-28 و2024-03-01؟',
    'What day is 3 days after 2026-11-21?',
  ])('preserves every numeric literal in the calculator proof for %s', request => {
    vi.stubEnv(flag, '1');
    const result = calculation(request);
    const reply = realizeVerifiedComputation(result, result.text, 'fixture');
    expect(result.status).toBe('completed');
    expect(reply).not.toBe(result.text);
    expect(numericLiterals(reply)).toEqual(numericLiterals(result.text));
    if (result.consumption?.kind === 'weekday') expect(reply).toContain(result.evidence[0].value);
  });

  it.each(['ar', 'en'] as const)('keeps the %s currency snapshot name, date and numbers', language => {
    vi.stubEnv(flag, '1');
    const source = 'Fixture Exchange Ledger';
    const asOf = evaluatedAt.toISOString().slice(0, 10);
    const rates = parseExchangeRateTable({ base: 'USD', rates: { EUR: String(2 / 3).slice(0, 8) }, asOf, source });
    const result = reasonCurrency(language === 'ar' ? 'حول 45 USD إلى EUR' : 'Convert 45 USD to EUR', language, rates);
    if (!result) throw new Error('Expected a currency calculation');
    const reply = realizeVerifiedComputation(result, result.text, 'fixture');
    expect(result.status).toBe('completed');
    expect(reply).not.toBe(result.text);
    expect(reply).toContain(language === 'ar' ? 'نحو' : 'approximately');
    expect(numericLiterals(reply)).toEqual(numericLiterals(result.text));
    expect(reply.match(/USD|EUR/gu)).toEqual(result.text.match(/USD|EUR/gu));
    const originalSourceLine = result.text.split('\n')[1];
    expect(originalSourceLine).toContain(source);
    expect(originalSourceLine).toContain(asOf);
    expect(reply.split('\n')[1]).toBe(originalSourceLine);
  });

  it.each([
    'Calculate 12 + 5. Only the result.', 'Calculate 12 + 5 and show the steps.',
    'What time is it in Tokyo?', 'Calculate 12 + 5 and save the result.', 'احسب ٧ ÷ ٠',
  ])('leaves the existing reply for %s intact with the flag on', request => {
    vi.stubEnv(flag, '1');
    const result = calculation(request);
    expect(realizeVerifiedComputation(result, result.text, 'fixture')).toBe(result.text);
  });

  it('keeps altered or unverified replies intact with the flag on', () => {
    vi.stubEnv(flag, '1');
    const result = calculation('Calculate 12 + 5.');
    const redacted = result.text.replace('12', '[redacted]');
    expect(realizeVerifiedComputation(result, redacted, 'fixture')).toBe(redacted);
    expect(realizeVerifiedComputation({ ...result, claims: [] }, result.text, 'fixture')).toBe(result.text);
  });

  it('leaves the chat reply unchanged by default and sends the realized reply to the judge when enabled', async () => {
    const database = await createDatabase();
    let control: Awaited<ReturnType<typeof createCommandChatControl>> | undefined;
    try {
      await migrate(database.db);
      const browser = {
        setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; }, async close() {},
      } as unknown as AgentBrowser;
      const observe = vi.fn(judge);
      control = await createCommandChatControl(database.db, {
        models: { fast: [], deep: [], vision: '' }, browser,
        judgeShadow: { logFile: 'unused-fixture-path', observe, async flush() {} },
      });
      const request = 'Calculate 12 + 5.';
      const original = calculation(request).text;
      const owner = 'verified-answer-realizer-owner';
      for (const setting of [undefined, '0', '1']) {
        vi.stubEnv(flag, setting);
        const { id } = await control.create(owner, { goal: request });
        await control.settled(id);
        const { messages } = await control.detail(owner, id);
        const reply = messages.at(-1)?.text;
        if (setting !== '1') expect(reply).toBe(original);
        else {
          expect(reply).not.toBe(original);
          expect(numericLiterals(reply ?? '')).toEqual(numericLiterals(original));
        }
        expect(observe).toHaveBeenLastCalledWith(expect.objectContaining({ conversationId: id, reply, status: 'completed' }));
        const run = await database.db.selectFrom('chat_runs').select(['status', 'state']).where('conversation_id', '=', id).executeTakeFirstOrThrow();
        expect(run.status).toBe('completed');
        expect(run.state.completionReview).toMatchObject({ allowCompletion: true, criteria: [{ id: 'computed-answer', status: 'verified' }] });
      }
    } finally {
      await control?.shutdown();
      await database.close();
    }
  });
});
