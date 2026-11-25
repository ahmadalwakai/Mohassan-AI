import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentAction, AgentBrowser, AgentPage } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import { evaluateLocalComputation } from '../apps/server/src/assistant/local-computation.js';
import { parseHands } from '../apps/server/src/assistant/hands.js';
import { createJudgeShadow } from '../apps/server/src/assistant/judge-shadow.js';

const owner = 'isolated-reasoning-owner';
const page: AgentPage = {
  id: 'route-lengths', url: 'https://lengths.example/', title: 'Route lengths', hash: 'route-lengths',
  text: 'Pine: Length: 12 m. Birch: Length: 16 m. Ash: Length: 5 m.',
  elements: [], signals: { captcha: false, password: false, otp: false, card: false },
  scroll: { top: 0, height: 1000, viewport: 800 }, observedAt: '2026-11-22T16:00:00.000Z',
};
const feePage: AgentPage = {
  ...page, id: 'hire-rates', url: 'https://equipment.example/rates', title: 'Equipment hire rates', hash: 'hire-rates',
  text: 'Hiring a canoe costs 14 pounds per hour. Hiring a kayak costs 19 pounds per hour.',
};

describe('extended reasoning in the existing chat routes', () => {
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let control: Awaited<ReturnType<typeof createCommandChatControl>>;
  const pages = new Map<string, AgentPage>();
  let logDirectory: string;
  let judgeShadow: ReturnType<typeof createJudgeShadow>;
  const search = vi.fn(async () => { throw new Error('Reasoning must not send a search query.'); });
  const act = vi.fn(async (_owner: string, id: string, action: AgentAction) => {
    const opened = action.kind === 'open' && [page, feePage].find(candidate => new URL(action.text!).href === candidate.url);
    if (!opened) throw new Error('Unexpected browser action');
    pages.set(id, opened);
    return { page: opened, changed: true };
  });

  beforeAll(async () => {
    logDirectory = await mkdtemp(join(tmpdir(), 'mohassan-reasoning-chat-'));
    judgeShadow = createJudgeShadow({ logFile: join(logDirectory, 'judge.jsonl') });
    database = await createDatabase();
    await migrate(database.db);
    const browser = {
      setCheckpointStore() {}, async bindAccount() {}, async hasPage(_owner: string, id: string) { return pages.has(id); },
      async observe(_owner: string, id: string) { return { page: pages.get(id)!, changed: false }; },
      act, async close() {},
    } as unknown as AgentBrowser;
    control = await createCommandChatControl(database.db, { models: { fast: [], deep: [], vision: '' }, browser, recordExperiences: false,
      searchProvider: { name: 'reasoning-must-not-search', search }, judgeShadow, judgeFixForOwner: true, judgeWithholdForOwner: true });
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await control?.shutdown();
    await database?.close();
    await judgeShadow?.flush();
    if (logDirectory) await rm(logDirectory, { recursive: true, force: true });
  });

  async function ask(goal: string, existing?: string) {
    const id = existing ?? (await control.create(owner, { goal })).id;
    if (existing) await control.send(owner, id, { text: goal });
    await control.settled(id);
    const detail = await control.detail(owner, id);
    const run = await database.db.selectFrom('chat_runs').select(['id', 'status', 'state'])
      .where('conversation_id', '=', id).orderBy('created_at', 'desc').executeTakeFirstOrThrow();
    expect(detail.error).toBeNull();
    return { id, text: detail.messages.filter(message => message.role === 'assistant').at(-1)?.text ?? '', run };
  }

  it('leaves ranking and legacy arithmetic on their former routes by default', () => {
    vi.stubEnv('MOHASSAN_REASONING', undefined);
    expect(evaluateLocalComputation('two and a half million')).toBeNull();
    expect(parseHands('Which is longer on this page: Pine or Birch?')).toBeNull();
    expect(evaluateLocalComputation('Calculate 7 * 6')?.evidence[0]?.value).toBe('42');
  });

  it('answers number words and inline comparisons through the local calculation route', async () => {
    vi.stubEnv('MOHASSAN_REASONING', '1');
    for (const [request, expected] of [
      ['two and a half million', '2500000'],
      ['Which is older: Sam 31 years or Lee 40 years?', 'Lee'],
    ]) {
      const { text, run } = await ask(request);
      expect(text.replace(/[,٬]/gu, '')).toContain(expected);
      expect(run.status).toBe('completed');
      expect(run.state.trail).toMatchObject([{ action: 'calculate' }]);
      expect(await database.db.selectFrom('chat_model_receipts').select('id').where('run_id', '=', run.id).execute()).toEqual([]);
    }
    expect(act).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  it('returns a local gap for an explicitly current exchange rate', async () => {
    vi.stubEnv('MOHASSAN_REASONING', '1');
    const { text, run } = await ask('Convert 50 USD to EUR at the current exchange rate');
    expect(text).toContain('current exchange rate is unavailable');
    expect(run.status).toBe('blocked');
    expect(search).not.toHaveBeenCalled();
  });

  it('certifies spoken arithmetic through the local calculator', async () => {
    vi.stubEnv('MOHASSAN_REASONING', '1');
    for (const [request, equation] of [
      ['أحسب لنا ناتج ١٧ ضرب ٤', '17 * 4 = 68'],
      ['احسبلي ٢٥ في المئة من ٧٢', '25 % * 72 = 18'],
      ['لو ضربنا سبعة في ١٢، كام الناتج؟', '(7) * (12) = 84'],
      ['If we divide twenty-four by eight, what is the result?', '(24) / (8) = 3'],
      ['قديش يوم بين ٢٠٢٠-٠٢-٢٧ و٢٠٢٠-٠٣-٠١؟', 'من 2020-02-27 إلى 2020-03-01 = 3 يوم'],
      ['ما هو تاريخ ٤ أيام بعد ٢٠٢٠-٠٢-٢٧؟', '2020-02-27 + 4 ايام = 2020-03-02'],
      ['A rectangle is 70 centimetres long and 40 centimetres wide. Calculate its area.', '70 × 40 = 2800 cm²'],
    ]) {
      const { text, run } = await ask(request);
      expect(run.status).toBe('completed');
      expect(text).toContain(equation);
      expect(run.state.trail).toMatchObject([{ action: 'calculate' }]);
      expect(run.state.supervision?.contract.criteria).toMatchObject([{ id: 'computed-answer' }]);
    }
    expect(act).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  it('shows the evaluator’s intermediate steps when asked and preserves exact consumption', async () => {
    const request = 'Compute (9 minus 2) times 6 plus 4, and show your work, thanks.';
    const result = evaluateLocalComputation(request);
    expect(result?.consumption).toMatchObject({ complete: true, sourceLength: request.length, remainder: [] });
    expect(result?.evidence.at(-1)).toMatchObject({ source: 'computed', value: '46', quote: result?.text });
    const { text, run } = await ask(request);
    expect(run.status).toBe('completed');
    expect(text).toContain('9 − 2 = 7\n7 × 6 = 42\n42 + 4 = 46');
    const arabic = evaluateLocalComputation('احسب ١٢٫٥٪ من ٥٦، ووضحلي الخطوات');
    expect(arabic?.text).toContain('12.5 ÷ 100 = 0.125\n0.125 × 56 = 7');
    expect(evaluateLocalComputation('Compute (1 / 7) × 7, show the steps.')?.text).toContain('1 ÷ 7 ≈ 0.142857142857143');
    expect(evaluateLocalComputation('Compute -((4 - 2) × 3), show the steps.')?.text).toMatch(/ = -6$/u);
    expect(evaluateLocalComputation('Compute (8 + 2) × 9 then email it, and show the steps.')).toBeNull();
  });

  it('ranks observed page fields and cites the values through the browser route', async () => {
    vi.stubEnv('MOHASSAN_REASONING', '1');
    const { id, text, run } = await ask('Open https://lengths.example and tell me which is longer on the page: Pine or Birch?');
    expect(text).toContain('Pine');
    expect(text).toContain('Birch');
    expect(text).toContain('12 m');
    expect(text).toContain('16 m');
    expect(text).toContain(page.url);
    expect(run.status).toBe('completed');
    expect(act).toHaveBeenCalledTimes(1);
    const gap = await ask('Which is longer on this page: Pine or Fir?', id);
    expect(gap.text).toContain('Fir');
    expect(gap.text).toContain('12 m');
    expect(gap.text).toContain(page.url);
    expect(gap.run.status).not.toBe('completed');
    expect(act).toHaveBeenCalledTimes(1);
    expect(search).not.toHaveBeenCalled();
  });

  it('plans one explicit open and compares figures in the returned page prose', async () => {
    const request = `Please visit ${feePage.url}. Compare the hourly prices for a canoe and a kayak.`;
    vi.stubEnv('MOHASSAN_REASONING', '0');
    expect(parseHands(request)).toBeNull();
    vi.stubEnv('MOHASSAN_REASONING', '1');
    expect(parseHands(request)).toMatchObject([{ kind: 'open', url: feePage.url }, { kind: 'ask_page' }]);
    expect(parseHands(`Visit ${feePage.url} and compare the prices, then send the result.`)).toBeNull();
    expect(parseHands(`Visit ${feePage.url} and compare the prices, and click Rent.`)).toBeNull();
    expect(parseHands(`Visit ${feePage.url} and compare the prices and rent the cheapest.`)).toBeNull();
    expect(parseHands('Compare the prices on this page, and click Rent.')).toBeNull();
    act.mockClear();
    const { text, run } = await ask(request);
    expect(run.status).toBe('completed');
    expect(text).toContain('Hiring a canoe costs 14 pounds per hour.');
    expect(text).toContain('Hiring a kayak costs 19 pounds per hour.');
    expect(text).toContain(feePage.url);
    expect(act).toHaveBeenCalledTimes(1);
    expect(search).not.toHaveBeenCalled();
  });

  it('uses the previous user turn when the comparison explicitly points to those values', async () => {
    vi.stubEnv('MOHASSAN_REASONING', '1');
    const { id } = await ask('Saffron: Length: 8 m; Cedar: Length: 13 m');
    act.mockClear();
    search.mockClear();
    const { text, run } = await ask('Using the figures above, which is longer: Saffron or Cedar?', id);
    expect(run.status).toBe('completed');
    expect(run.state.routing).toMatchObject({ route: 'compute', handler: 'local_computation' });
    expect(text.split('\n')[0]).toContain('Cedar');
    expect(text).toContain('Saffron: Length: 8 m');
    expect(text).toContain('Cedar: Length: 13 m');
    expect(act).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });
});
