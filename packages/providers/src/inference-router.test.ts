import { describe, expect, it, vi } from 'vitest';
import { InferenceRouter, ProviderError, UsageMonitor, type ModelRequest, type ModelResult, type RouteCandidate, type RouterPolicy } from './index.js';

type Step = ModelResult | ProviderError | ((request: ModelRequest) => Promise<ModelResult>);
const ok = (text = 'done', model = 'm'): ModelResult => ({ text, model, usage: { inputTokens: 10, outputTokens: 2 } });
const rejected = (code: string, status?: number, retryable = false, extra: Partial<ProviderError> = {}) => Object.assign(new ProviderError(code, code, retryable, status), extra);
const rateLimited = (retryAfterMs?: number) => rejected('RATE_LIMITED', 429, true, { usage: { inputTokens: 0, outputTokens: 0 }, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });

function candidate(key: string, cost: 'free' | 'paid', steps: Step[], capabilities: RouteCandidate['capabilities'] = {}) {
  const calls: ModelRequest[] = [];
  const generate = vi.fn(async (request: ModelRequest) => {
    calls.push(request);
    const step = steps.length > 1 ? steps.shift()! : steps[0]!;
    if (typeof step === 'function') return step(request);
    if (step instanceof ProviderError) throw step;
    return step;
  });
  const providerId = key.slice(0, key.indexOf(':')), model = key.slice(key.indexOf(':') + 1);
  const built: RouteCandidate = { key, providerId, model, cost, capabilities, provider: { id: providerId, generate } };
  return { candidate: built, calls, generate };
}
const policy = (overrides: Partial<RouterPolicy> = {}): RouterPolicy => ({ freeOnly: false, automaticFallback: true, allowPaidFallback: false, baseBackoffMs: 1, maxBackoffMs: 20, ...overrides });
const request: ModelRequest = { goal: 'decide the next step' };

describe('inference router', () => {
  it('fails over from a rate-limited free model to the next free model and cools the first down', async () => {
    const first = candidate('freellmapi:auto', 'free', [rateLimited(5000)]);
    const second = candidate('freellmapi:auto:fast', 'free', [ok('from second')]);
    const monitor = new UsageMonitor({ freeProviders: ['freellmapi'] });
    const result = await new InferenceRouter([first.candidate, second.candidate], policy(), monitor).generate(request);
    expect(result).toMatchObject({ text: 'from second', candidate: 'freellmapi:auto:fast', cost: 'free' });
    expect(result.attempts.map(attempt => attempt.outcome)).toEqual(['rate_limited', 'success']);
    expect(monitor.blockedUntil('freellmapi:auto')).toBeGreaterThan(Date.now());
    const snapshot = monitor.snapshot();
    expect(snapshot.events.map(event => event.kind)).toEqual(expect.arrayContaining(['rate_limited', 'fallback', 'success']));
    expect(snapshot.active).toMatchObject({ provider: 'freellmapi', model: 'auto:fast' });
    // The cooled-down candidate is skipped on the next request.
    await new InferenceRouter([first.candidate, second.candidate], policy(), monitor).generate(request);
    expect(first.generate).toHaveBeenCalledTimes(1);
  });

  it('never routes to a paid model in free-only mode', async () => {
    const free = candidate('freellmapi:auto', 'free', [rateLimited()]);
    const paid = candidate('groq:big', 'paid', [ok()]);
    const error = await new InferenceRouter([free.candidate, paid.candidate], policy({ freeOnly: true })).generate(request).catch(caught => caught);
    expect(error).toMatchObject({ code: 'NO_ELIGIBLE_PROVIDER', retryable: true });
    expect(paid.generate).not.toHaveBeenCalled();
    const none = await new InferenceRouter([paid.candidate], policy({ freeOnly: true })).generate(request).catch(caught => caught);
    expect(none.message).toContain('free_only');
  });

  it('blocks a silent free-to-paid switch unless the server allows it', async () => {
    const monitor = new UsageMonitor();
    const blocked = await new InferenceRouter([candidate('freellmapi:auto', 'free', [rateLimited()]).candidate, candidate('groq:big', 'paid', [ok()]).candidate], policy(), monitor).generate(request).catch(caught => caught);
    expect(blocked.code).toBe('NO_ELIGIBLE_PROVIDER');
    expect(monitor.snapshot().events.some(event => event.kind === 'paid_fallback_blocked')).toBe(true);
    const allowed = await new InferenceRouter([candidate('freellmapi:auto', 'free', [rateLimited()]).candidate, candidate('groq:big', 'paid', [ok('paid answer')]).candidate], policy({ allowPaidFallback: true })).generate(request);
    expect(allowed).toMatchObject({ text: 'paid answer', cost: 'paid' });
  });

  it.each(['cooling_down', 'no_structured_output'] as const)('preserves paid-fallback permission when free candidates are filtered for %s', async reason => {
    for (const allowPaidFallback of [false, true]) {
      const free = candidate('freellmapi:auto', 'free', [ok()], { structured: reason !== 'no_structured_output' });
      const paid = candidate('groq:big', 'paid', [ok('allowed fallback')], { structured: true });
      const monitor = new UsageMonitor();
      if (reason === 'cooling_down') monitor.block(free.candidate.key, 60000);
      const router = new InferenceRouter([free.candidate, paid.candidate], policy({ allowPaidFallback }), monitor);
      const result = router.generate({ ...request, structured: { name: 'decision', schema: {} } });
      if (allowPaidFallback) {
        await expect(result).resolves.toMatchObject({ candidate: 'groq:big', text: 'allowed fallback' });
        expect(paid.generate).toHaveBeenCalledTimes(1);
      } else {
        await expect(result).rejects.toMatchObject({ code: 'NO_ELIGIBLE_PROVIDER', message: expect.stringContaining('paid_fallback_blocked') });
        expect(paid.generate).not.toHaveBeenCalled();
      }
      expect(free.generate).not.toHaveBeenCalled();
    }
  });

  it.each([false, true])('preserves filtered free-candidate policy for native streams (allowPaidFallback=%s)', async allowPaidFallback => {
    const free = candidate('freellmapi:plain', 'free', [ok()], { structured: false });
    const paid = candidate('groq:big', 'paid', [ok()], { structured: true });
    const stream = vi.fn(async function* () { yield { type: 'delta' as const, text: 'allowed' }; yield { type: 'done' as const, result: ok('allowed') }; });
    paid.candidate.provider.stream = stream;
    const router = new InferenceRouter([free.candidate, paid.candidate], policy({ allowPaidFallback }));
    const consume = async () => {
      let text = '';
      for await (const event of router.stream({ ...request, structured: { name: 'decision', schema: {} } })) if (event.type === 'delta') text += event.text;
      return text;
    };
    if (allowPaidFallback) {
      await expect(consume()).resolves.toBe('allowed');
      expect(stream).toHaveBeenCalledTimes(1);
    } else {
      await expect(consume()).rejects.toMatchObject({ code: 'NO_ELIGIBLE_PROVIDER' });
      expect(stream).not.toHaveBeenCalled();
    }
    expect(free.generate).not.toHaveBeenCalled();
    expect(paid.generate).not.toHaveBeenCalled();
  });

  it('keeps direct paid-provider mode when no free candidates were configured', async () => {
    const paid = candidate('groq:fast', 'paid', [ok('direct')]);
    await expect(new InferenceRouter([paid.candidate], policy()).generate(request)).resolves.toMatchObject({ text: 'direct' });
    expect(paid.generate).toHaveBeenCalledTimes(1);
  });

  it('retries a confirmed transient rejection with bounded backoff, then recovers', async () => {
    const unavailable = rejected('UPSTREAM_ERROR', 503, true, { usage: { inputTokens: 0, outputTokens: 0 } });
    const only = candidate('freellmapi:auto', 'free', [unavailable, unavailable, ok('recovered')]);
    const result = await new InferenceRouter([only.candidate], policy({ maxTransientRetries: 2 })).generate(request);
    expect(result.text).toBe('recovered');
    expect(only.generate).toHaveBeenCalledTimes(3);
    expect(result.attempts.map(attempt => attempt.outcome)).toEqual(['retry', 'retry', 'success']);
  });

  it('stops at the attempt cap instead of looping', async () => {
    const unavailable = rejected('UPSTREAM_ERROR', 503, true, { usage: { inputTokens: 0, outputTokens: 0 } });
    const candidates = Array.from({ length: 6 }, (_, index) => candidate(`freellmapi:m${index}`, 'free', [unavailable]));
    const error = await new InferenceRouter(candidates.map(item => item.candidate), policy({ maxAttempts: 4, maxTransientRetries: 4 })).generate(request).catch(caught => caught);
    expect(error.code).toBe('NO_ELIGIBLE_PROVIDER');
    expect(candidates.reduce((sum, item) => sum + item.generate.mock.calls.length, 0)).toBe(4);
  });

  it('does not repeat a paid call whose outcome is unknown', async () => {
    const timeout = rejected('NETWORK_ERROR');
    const paid = candidate('groq:fast', 'paid', [timeout]);
    const second = candidate('groq:big', 'paid', [ok()]);
    await expect(new InferenceRouter([paid.candidate, second.candidate], policy()).generate(request)).rejects.toBe(timeout);
    expect(second.generate).not.toHaveBeenCalled();
    // A free call with an unknown outcome may move on: nothing is billed.
    const free = candidate('freellmapi:auto', 'free', [rejected('NETWORK_ERROR')]);
    const next = candidate('freellmapi:auto:fast', 'free', [ok('next')]);
    await expect(new InferenceRouter([free.candidate, next.candidate], policy()).generate(request)).resolves.toMatchObject({ text: 'next' });
  });

  it('respects the automatic fallback toggle', async () => {
    const second = candidate('freellmapi:b', 'free', [ok()]);
    const error = await new InferenceRouter([candidate('freellmapi:a', 'free', [rejected('AUTHENTICATION_FAILED', 401)]).candidate, second.candidate], policy({ automaticFallback: false })).generate(request).catch(caught => caught);
    expect(error.message).toContain('fallback_disabled');
    expect(second.generate).not.toHaveBeenCalled();
  });

  it('only offers structured or tool requests to compatible models', async () => {
    const noSchema = candidate('freellmapi:plain', 'free', [ok()], { structured: false, tools: false });
    const schema = candidate('freellmapi:json', 'free', [ok('{"tool":"answer"}')], { structured: true, tools: true });
    const result = await new InferenceRouter([noSchema.candidate, schema.candidate], policy()).generate({ ...request, structured: { name: 'decision', schema: {} } });
    expect(result.candidate).toBe('freellmapi:json');
    expect(noSchema.generate).not.toHaveBeenCalled();
    const router = new InferenceRouter([noSchema.candidate, candidate('freellmapi:unknown', 'free', [ok()]).candidate], policy());
    expect(router.eligibility(request, { tools: true }).map(row => row.reason)).toEqual(['no_tools', 'no_tools']);
    await expect(router.generate(request, { requires: { tools: true } })).rejects.toMatchObject({ code: 'NO_ELIGIBLE_PROVIDER' });
  });

  it('replaces unusable structured output from a free model, once', async () => {
    const bad = candidate('freellmapi:a', 'free', [ok('not json')]);
    const good = candidate('freellmapi:b', 'free', [ok('{"tool":"answer"}')]);
    const settled: boolean[] = [];
    const result = await new InferenceRouter([bad.candidate, good.candidate], policy()).generate(request, {
      validate: text => text.startsWith('{'),
      onSettled: (_token, _candidate, outcome) => { settled.push(outcome.ok && outcome.valid); },
    });
    expect(result.text).toBe('{"tool":"answer"}');
    expect(settled).toEqual([false, true]);
  });

  it('shares one upstream call between duplicate concurrent requests', async () => {
    let release: (value: ModelResult) => void = () => {};
    const slow = candidate('freellmapi:auto', 'free', [() => new Promise<ModelResult>(resolve => { release = resolve; })]);
    const router = new InferenceRouter([slow.candidate], policy(), new UsageMonitor(), { inflight: new Map() });
    const one = router.generate({ ...request, idempotencyKey: 'run-1:3:decision' });
    const two = router.generate({ ...request, idempotencyKey: 'run-1:3:decision' });
    await vi.waitFor(() => expect(slow.generate).toHaveBeenCalledTimes(1));
    release(ok('single'));
    expect(await one).toBe(await two);
    expect(slow.generate).toHaveBeenCalledTimes(1);
  });

  it.each(['free', 'paid'] as const)('rejects terminal invalid %s output and keeps its usage without a second call', async cost => {
    const bad = candidate('provider:a', cost, [ok('invalid decision')]);
    const unused = candidate('provider:b', cost, [ok('must not run')]);
    const monitor = new UsageMonitor();
    const settled: boolean[] = [];
    await expect(new InferenceRouter([bad.candidate, unused.candidate], policy({ automaticFallback: false }), monitor).generate(request, {
      validate: () => false,
      onSettled: (_token, _candidate, outcome) => { settled.push(outcome.ok && outcome.valid); },
    })).rejects.toMatchObject({ code: 'INVALID_RESPONSE', usage: { inputTokens: 10, outputTokens: 2 } });
    expect(settled).toEqual([false]);
    expect(bad.generate).toHaveBeenCalledTimes(1);
    expect(unused.generate).not.toHaveBeenCalled();
    expect(monitor.snapshot().events.some(event => event.kind === 'success')).toBe(false);
  });

  it('settles a throwing validator as invalid and refuses the last malformed free response', async () => {
    const bad = candidate('free:a', 'free', [ok('not json')]);
    const settled: boolean[] = [];
    await expect(new InferenceRouter([bad.candidate], policy()).generate(request, {
      validate: text => Boolean(JSON.parse(text)),
      onSettled: (_token, _candidate, outcome) => { settled.push(outcome.ok && outcome.valid); },
    })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(settled).toEqual([false]);
    expect(bad.generate).toHaveBeenCalledTimes(1);
  });

  it('retains the estimated usage and incurred cost of a rejected response', async () => {
    const bad = candidate('provider:a', 'paid', [{ ...ok('invalid'), usageEstimated: true }]);
    const monitor = new UsageMonitor({ prices: { provider: { inputPerMTok: 1, outputPerMTok: 2 } } });
    await expect(new InferenceRouter([bad.candidate], policy(), monitor).generate(request, { validate: () => false })).rejects.toMatchObject({ code: 'INVALID_RESPONSE', usage: undefined });
    const snapshot = monitor.snapshot();
    expect(snapshot.totals).toMatchObject({ inputTokens: 10, outputTokens: 2 });
    expect(snapshot.today[0]).toMatchObject({ estimatedTokens: 12, failures: 1 });
    expect(snapshot.totals.estimatedCostUsd).toBeCloseTo(0.000014);
    expect(snapshot.events.some(event => event.kind === 'success')).toBe(false);
  });

  it('records one settled receipt per attempt and stops on abort', async () => {
    const controller = new AbortController();
    const hanging = candidate('freellmapi:auto', 'free', [() => { controller.abort(); return Promise.reject(rejected('ABORTED')); }]);
    const next = candidate('freellmapi:auto:fast', 'free', [ok()]);
    const tokens: string[] = [];
    await expect(new InferenceRouter([hanging.candidate, next.candidate], policy()).generate({ ...request, signal: controller.signal }, {
      onAttempt: candidate => `receipt-${candidate.key}`,
      onSettled: token => { tokens.push(token); },
    })).rejects.toMatchObject({ code: 'ABORTED' });
    expect(tokens).toEqual(['receipt-freellmapi:auto']);
    expect(next.generate).not.toHaveBeenCalled();
  });

  it('waits out a short provider delay on the last candidate without shortening it', async () => {
    const only = candidate('freellmapi:auto', 'free', [rateLimited(15), ok('after wait')]);
    const started = Date.now();
    const result = await new InferenceRouter([only.candidate], policy({ maxBackoffMs: 50 })).generate(request);
    expect(result.text).toBe('after wait');
    expect(Date.now() - started).toBeGreaterThanOrEqual(14);
    // A delay beyond the budget is not waited out.
    const long = candidate('freellmapi:auto', 'free', [rateLimited(120_000), ok()]);
    await expect(new InferenceRouter([long.candidate], policy({ maxBackoffMs: 50 })).generate(request)).rejects.toMatchObject({ code: 'NO_ELIGIBLE_PROVIDER', retryAfterMs: 120_000 });
    expect(long.generate).toHaveBeenCalledTimes(1);
  });

  it('streams with failover only before the first delta', async () => {
    const failing = candidate('freellmapi:a', 'free', [rateLimited()]);
    async function* chunks() { yield { type: 'delta' as const, text: 'He' }; yield { type: 'delta' as const, text: 'y' }; yield { type: 'done' as const, result: ok('Hey') }; }
    const streaming = { ...candidate('freellmapi:b', 'free', [ok()]).candidate };
    streaming.provider = { ...streaming.provider, stream: () => chunks() };
    failing.candidate.provider = { ...failing.candidate.provider, stream: async function* () { throw rateLimited(); } };
    const seen: string[] = [];
    for await (const event of new InferenceRouter([failing.candidate, streaming], policy()).stream(request)) if (event.type === 'delta') seen.push(event.text);
    expect(seen.join('')).toBe('Hey');

    async function* breaks() { yield { type: 'delta' as const, text: 'partial' }; throw rejected('STREAM_INTERRUPTED'); }
    const broken = { ...candidate('freellmapi:c', 'free', [ok()]).candidate };
    broken.provider = { ...broken.provider, stream: () => breaks() };
    const backup = candidate('freellmapi:d', 'free', [ok('should not run')]);
    const run = async () => { for await (const _ of new InferenceRouter([broken, backup.candidate], policy()).stream(request)) { /* drain */ } };
    await expect(run()).rejects.toMatchObject({ code: 'STREAM_INTERRUPTED' });
    expect(backup.generate).not.toHaveBeenCalled();
  });

  it('skips a candidate whose verified token window is too small', async () => {
    const monitor = new UsageMonitor();
    monitor.setQuota({ provider: 'groq', model: 'fast', metric: 'tokens', remaining: 100, limit: null, resetAt: new Date(Date.now() + 60_000).toISOString(), source: 'verified', note: 'header' });
    const router = new InferenceRouter([candidate('groq:fast', 'paid', [ok()]).candidate, candidate('groq:big', 'paid', [ok('big')]).candidate], policy(), monitor);
    await expect(router.generate(request, { requires: { estimatedTokens: 500 } })).resolves.toMatchObject({ candidate: 'groq:big' });
  });
});

describe('usage monitor', () => {
  it('keeps every collection bounded and separates unknown cost from zero', () => {
    const monitor = new UsageMonitor({ freeProviders: ['freellmapi'] });
    for (let index = 0; index < 600; index++) monitor.recordFailure('freellmapi', `m${index}`, 'RATE_LIMITED');
    const snapshot = monitor.snapshot();
    expect(snapshot.today.length).toBeLessThanOrEqual(500);
    expect(snapshot.events.length).toBeLessThanOrEqual(50);
    expect(snapshot.totals.estimatedCostUsd).toBe(0);
    monitor.recordSuccess('groq', 'big', { inputTokens: 1000, outputTokens: 10 });
    expect(monitor.snapshot().totals.estimatedCostUsd).toBeNull();
    const priced = new UsageMonitor({ prices: { groq: { inputPerMTok: 1, outputPerMTok: 2 } } });
    priced.recordSuccess('groq', 'big', { inputTokens: 1_000_000, outputTokens: 500_000 });
    expect(priced.snapshot().totals.estimatedCostUsd).toBe(2);
  });
});
