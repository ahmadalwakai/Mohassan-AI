import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AgentAction, type AgentAuthority, type AgentBrowser, type AgentPage } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { InferenceRouter, ProviderError, UsageMonitor, type ModelRequest, type ModelResult } from '@mohassan/providers';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import type { BrainState } from '../apps/server/src/assistant/brain.js';

const OWNER = 'isolated-model-recovery-owner';
const ADDRESS = 'https://model-recovery-fixture.test/catalogue';
const GOAL = 'اضغط رابط Catalogue في الصفحة الحالية';
const ANSWER = 'The public catalogue was opened. Further verification remains.';
const MODEL = 'model-recovery-script';
const SMALL = 'model-recovery-small', LARGE = 'model-recovery-large';
const BLANK = { thought: null, plan: null, note: null, url: null, ref: null, text: null, submit: null, options: null, sensitive: null, outcome: null };
const fixtures: Array<{ control: Awaited<ReturnType<typeof createCommandChatControl>>; database: Awaited<ReturnType<typeof createDatabase>> }> = [];

const limited = () => Object.assign(new ProviderError('RATE_LIMITED', 'Synthetic zero-usage refusal.', true, 429), {
  usage: { inputTokens: 0, outputTokens: 0 },
  // Keep the real router eligible during accelerated test timers; the controller
  // must still request its own complete 30/45/60-second backoff.
  retryAfterMs: 0,
});
const answer = (): ModelResult => ({ model: MODEL, usage: { inputTokens: 2, outputTokens: 3 },
  text: JSON.stringify({ ...BLANK, tool: 'answer', text: ANSWER, outcome: 'partial' }) });

async function fixture(next: (call: number, request: ModelRequest, model: string) => ModelResult | Promise<ModelResult>, options: { mixedFreeCandidates?: boolean } = {}) {
  const database = await createDatabase({}); await migrate(database.db);
  const actions: AgentAction[] = [], requests: ModelRequest[] = [];
  const candidates: Array<{ model: string; request: ModelRequest }> = [];
  let clock = Date.now();
  const page = (): AgentPage => ({ id: `model-page-${actions.length}`, url: ADDRESS, title: 'Public catalogue',
    text: 'The fixture public catalogue description is available.', observedAt: new Date().toISOString(), documentStatus: 200,
    hash: (actions.length ? 'b' : 'a').repeat(24),
    elements: [{ ref: 'e1', role: 'link', label: 'Catalogue', href: `${ADDRESS}/list`, inViewport: true }],
    signals: { captcha: false, password: false, otp: false, card: false }, scroll: { top: 0, height: 200, viewport: 800 } });
  const browser = {
    setCheckpointStore() {}, async bindAccount() {}, async bindRecoveryCheckpoint() {}, async close() {},
    async hasPage() { return true; }, async observe() { return { page: page(), changed: false }; },
    async prepareAction() { return null; }, async screen() { return null; },
    async act(_owner: string, _id: string, action: AgentAction, authority: AgentAuthority) {
      await authority.assertActive(); actions.push(action); return { page: page(), changed: true };
    },
  } as unknown as AgentBrowser;
  const mixed = options.mixedFreeCandidates === true;
  const monitor = new UsageMonitor({ now: () => clock });
  const router = new InferenceRouter((mixed ? [SMALL, LARGE] : [MODEL]).map(model => ({ key: model, model, providerId: model, cost: mixed ? 'free' as const : 'paid' as const, provider: {
    id: model, async generate(request: ModelRequest) {
      requests.push(request);
      candidates.push({ model, request });
      if (requests.length === 1) return { model, usage: { inputTokens: 2, outputTokens: 3 }, text: JSON.stringify({ ...BLANK, tool: 'click', ref: 'e1' }) };
      return next(requests.length, request, model);
    },
  } })), { freeOnly: mixed, automaticFallback: mixed, allowPaidFallback: false, maxAttempts: mixed ? 2 : 1, maxTransientRetries: 0 }, monitor, { now: () => clock });
  const control = await createCommandChatControl(database.db, { browser, recordExperiences: false,
    models: { fast: [], deep: [], vision: '' }, inference: { active: () => true, routerFor: () => router } });
  fixtures.push({ control, database });
  const result = async (id: string) => {
    await control.settled(id);
    const runs = await database.db.selectFrom('chat_runs').selectAll().where('conversation_id', '=', id).execute();
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    const detail = await control.detail(OWNER, id);
    expect(detail.messages.filter(message => message.role === 'user').map(message => message.text)).toEqual([GOAL]);
    return { detail, run, state: run.state as BrainState,
      receipts: await database.db.selectFrom('chat_model_receipts').selectAll().where('run_id', '=', run.id).execute() };
  };
  return { database, control, requests, actions, candidates, router, monitor, result, advanceClock: (milliseconds: number) => { clock += milliseconds; } };
}

/** Only the documented backoffs and explicit long-recovery fixture delays are accelerated. */
function backoffTimers(hold = false, onElapsed?: (milliseconds: number) => void) {
  const original = globalThis.setTimeout;
  const delays: number[] = [];
  let started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: any[]) => void, milliseconds?: number, ...args: any[]) => {
    if (milliseconds !== undefined && [30_000, 45_000, 60_000, 82_000, 300_000].includes(milliseconds)) {
      delays.push(milliseconds); started();
      return original(() => { onElapsed?.(milliseconds); callback(...args); }, hold ? milliseconds : 1);
    }
    return original(callback, milliseconds, ...args);
  }) as typeof setTimeout);
  return { delays, waiting };
}

afterEach(async () => {
  try { for (const item of fixtures.splice(0)) { await item.control.shutdown(); await item.database.close(); } }
  finally { vi.restoreAllMocks(); }
});

describe('model recovery preserves the current browser run', () => {
  it('resumes the observed production sequence after two successful large-model decisions and an 82-second rejection', async () => {
    const f = await fixture((call, _request, model) => {
      if (model === SMALL && call === 2) throw new ProviderError('REQUEST_REJECTED', 'Synthetic oversized input.', false, 413);
      if (model === LARGE && (call === 3 || call === 4)) return { model, usage: { inputTokens: 2, outputTokens: 3 },
        text: JSON.stringify({ ...BLANK, tool: 'wait', text: String(call) }) };
      if (model === LARGE && call === 5) throw Object.assign(limited(), { retryAfterMs: 82_000 });
      return { ...answer(), model };
    }, { mixedFreeCandidates: true });
    const timers = backoffTimers(false, milliseconds => {
      expect(milliseconds).toBe(82_000);
      expect(f.monitor.blockedBy(SMALL)).toBe('REQUEST_REJECTED');
      expect(f.monitor.blockedBy(LARGE)).toBe('RATE_LIMITED');
      f.advanceClock(milliseconds);
    });
    const { id } = await f.control.create(OWNER, { goal: GOAL });
    const result = await f.result(id);
    expect(result.detail.status, result.detail.error ?? '').toBe('idle');
    expect(result.detail.messages.at(-1)?.text).toBe(ANSWER);
    expect(result.state.modelRetries).toBe(1); expect(timers.delays).toEqual([82_000]);
    expect(f.actions.filter(action => action.kind === 'click')).toEqual([{ kind: 'click', ref: 'e1' }]);
    expect(result.receipts.filter(row => row.step === 2).map(row => [row.model, row.status]).sort()).toEqual([
      [SMALL, 'unknown'], [LARGE, 'succeeded'],
    ].sort());
    expect(result.receipts.filter(row => row.step === 3).map(row => [row.model, row.status])).toEqual([[LARGE, 'succeeded']]);
    expect(result.receipts.filter(row => row.step === 4).map(row => [row.model, row.status, row.retry_after_ms]).sort()).toEqual([
      [LARGE, 'failed', 82_000], [LARGE, 'succeeded', null],
    ].sort());
    const retriedDecision = f.candidates[4]!.request.idempotencyKey;
    expect(f.candidates.filter(call => call.request.idempotencyKey === retriedDecision).map(call => call.model)).toEqual([LARGE, LARGE]);
  });

  it.each([30_000, 82_000])('keeps the input-rejected free candidate out of the decision retry while the real %sms rate-limit cooldown expires', async retryAfterMs => {
    let rateFailures = 0;
    const f = await fixture((call, _request, model) => {
      if (model === SMALL && call === 2) throw new ProviderError('REQUEST_REJECTED', 'Synthetic oversized input.', false, 413);
      if (model === LARGE && rateFailures++ === 0) throw Object.assign(limited(), { retryAfterMs });
      return { ...answer(), model };
    }, { mixedFreeCandidates: true });
    const timers = backoffTimers(false, milliseconds => {
      // This is a real active block, rather than a zero-delay retry fixture.
      expect(f.monitor.blockedBy(LARGE)).toBe('RATE_LIMITED');
      expect(f.router.retryCooldown({ goal: 'fixture', structured: { name: 'decision', schema: {} } })).toBeNull();
      f.advanceClock(milliseconds);
    });
    const { id } = await f.control.create(OWNER, { goal: GOAL });
    const result = await f.result(id);
    expect(result.detail.status, result.detail.error ?? '').toBe('idle');
    expect(result.detail.messages.at(-1)?.text).toBe(ANSWER);
    expect(f.actions).toEqual([{ kind: 'click', ref: 'e1' }]);
    expect(result.state.modelRetries).toBe(1); expect(timers.delays).toEqual([retryAfterMs]);
    const nextDecision = f.candidates[1]!.request.idempotencyKey;
    expect(f.candidates.filter(call => call.request.idempotencyKey === nextDecision).map(call => call.model)).toEqual([SMALL, LARGE, LARGE]);
    expect(result.receipts.filter(row => row.step === 2).map(row => [row.model, row.status, row.error_code]).sort()).toEqual([
      [LARGE, 'failed', 'RATE_LIMITED'], [LARGE, 'succeeded', null], [SMALL, 'unknown', 'REQUEST_REJECTED'],
    ].sort());
  });

  it('retries a zero-usage rejection after a successful click and publishes the answer without replaying the click', async () => {
    const f = await fixture(call => { if (call === 2) throw limited(); return answer(); });
    const timers = backoffTimers();
    const { id } = await f.control.create(OWNER, { goal: GOAL });
    const result = await f.result(id);
    expect(result.detail.status, result.detail.error ?? '').toBe('idle');
    expect(result.detail.messages.at(-1)?.text).toBe(ANSWER);
    expect(result.detail.question).toBeNull();
    expect(f.actions).toEqual([{ kind: 'click', ref: 'e1' }]);
    // The accepted fast-tier answer also receives the normal host review.
    expect(f.requests).toHaveLength(4);
    expect(f.requests[1]!.goal).toBe(f.requests[2]!.goal);
    expect(f.requests[1]!.idempotencyKey).toBe(f.requests[2]!.idempotencyKey);
    expect(result.state.steps).toBe(3); expect(result.state.modelRetries).toBe(1);
    expect(timers.delays).toEqual([30_000]);
    expect(result.receipts).toHaveLength(4);
    expect(new Set(result.receipts.map(row => row.id)).size).toBe(4);
    expect(result.receipts.filter(row => row.step === 1)).toHaveLength(1);
    expect(result.receipts.filter(row => row.step === 2).map(row => row.status).sort()).toEqual(['failed', 'succeeded']);
    expect(result.receipts.filter(row => row.step === 3).map(row => row.status)).toEqual(['succeeded']);
    expect(result.receipts.find(row => row.status === 'failed')).toMatchObject({ error_code: 'RATE_LIMITED', input_tokens: 0, output_tokens: 0, usage_known: true });
  });

  it('cancels during the retry wait without another provider call or browser action', async () => {
    const f = await fixture(() => { throw limited(); });
    const timers = backoffTimers(true);
    const { id } = await f.control.create(OWNER, { goal: GOAL });
    await timers.waiting;
    const waiting = await f.control.detail(OWNER, id);
    expect(waiting.status).toBe('running'); expect(waiting.progress).toBeTruthy();
    await f.control.cancel(OWNER, id);
    const result = await f.result(id);
    expect(result.run.status).toBe('cancelled'); expect(result.detail.error).toBeNull();
    expect(f.requests).toHaveLength(2); expect(f.actions).toEqual([{ kind: 'click', ref: 'e1' }]);
    expect(result.state.modelRetries).toBe(1); expect(timers.delays).toEqual([30_000]);
  });

  it.each(['auth', 'paid_unknown'] as const)('does not automatically retry %s after the click', async failure => {
    const f = await fixture(() => { throw failure === 'auth'
      ? new ProviderError('AUTHENTICATION_FAILED', 'Synthetic rejected key.', false, 401)
      : new ProviderError('UPSTREAM_ERROR', 'Synthetic unknown paid request outcome.', true, 503); });
    const timers = backoffTimers();
    const { id } = await f.control.create(OWNER, { goal: GOAL });
    const result = await f.result(id);
    expect(result.detail.status).toBe('failed'); expect(result.detail.error).toBeTruthy();
    expect(f.requests).toHaveLength(2); expect(f.actions).toEqual([{ kind: 'click', ref: 'e1' }]);
    expect(result.state.modelRetries ?? 0).toBe(0); expect(timers.delays).toEqual([]);
  });

  it('stops after three model retries in the same run with no instruction to send a continuation', async () => {
    const f = await fixture(() => { throw limited(); });
    const timers = backoffTimers();
    const { id } = await f.control.create(OWNER, { goal: GOAL });
    const result = await f.result(id);
    expect(result.detail.status).toBe('failed'); expect(result.detail.error).toBeTruthy();
    expect(result.detail.error).not.toContain('تابع'); expect(result.detail.question).toBeNull();
    expect(result.state.modelRetries).toBe(3); expect(result.state.steps).toBe(1);
    expect(timers.delays).toEqual([30_000, 45_000, 60_000]);
    expect(f.requests).toHaveLength(5); expect(f.actions).toEqual([{ kind: 'click', ref: 'e1' }]);
    expect(result.receipts.filter(row => row.step === 2 && row.status === 'failed')).toHaveLength(4);
  });

  it('keeps the retry budget across successful intervening decisions in the same run', async () => {
    const f = await fixture(call => {
      if (call % 2 === 0) throw limited();
      return { model: MODEL, usage: { inputTokens: 2, outputTokens: 3 },
        text: JSON.stringify({ ...BLANK, tool: 'wait', text: String(call) }) };
    });
    const timers = backoffTimers();
    const { id } = await f.control.create(OWNER, { goal: GOAL });
    const result = await f.result(id);
    expect(result.detail.status).toBe('failed');
    expect(result.detail.error).not.toContain('تابع');
    expect(result.state.modelRetries).toBe(3); expect(result.state.steps).toBe(4);
    expect(timers.delays).toEqual([30_000, 45_000, 60_000]);
    expect(f.requests).toHaveLength(8);
    expect(f.actions.filter(action => action.kind === 'click')).toEqual([{ kind: 'click', ref: 'e1' }]);
    expect(result.receipts.filter(row => row.status === 'failed').map(row => row.step).sort()).toEqual([2, 3, 4, 5]);
  });
});
