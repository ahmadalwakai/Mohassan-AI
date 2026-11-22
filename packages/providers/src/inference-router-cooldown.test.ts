import { describe, expect, it, vi } from 'vitest';
import { classifyProviderFallback, freeLLMAPIError, InferenceRouter, ProviderError, UsageMonitor, type ModelRequest, type RouteCandidate, type RouterPolicy } from './index.js';

const request: ModelRequest = { goal: 'decide the next step' };
const policy = (overrides: Partial<RouterPolicy> = {}): RouterPolicy => ({
  freeOnly: false, automaticFallback: true, allowPaidFallback: false,
  maxAttempts: 1, maxTransientRetries: 0, ...overrides,
});
function candidate(key: string, code = 'RATE_LIMITED', status = 429, cost: 'free' | 'paid' = 'free', retryAfterMs?: number): RouteCandidate {
  const generate = vi.fn(async () => {
    throw Object.assign(new ProviderError(code, 'provider refused', true, status), {
      usage: { inputTokens: 0, outputTokens: 0 }, ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  });
  return { key, providerId: key.split(':')[0]!, model: key.slice(key.indexOf(':') + 1), cost, provider: { id: key.split(':')[0]!, generate } };
}
function setup(candidates: RouteCandidate[], overrides: Partial<RouterPolicy> = {}) {
  let now = 1_800_000_000_000;
  const monitor = new UsageMonitor({ now: () => now });
  const router = new InferenceRouter(candidates, policy(overrides), monitor, { now: () => now });
  return { monitor, router, advance: (milliseconds: number) => { now += milliseconds; } };
}

describe('inference router retry cooldown', () => {
  it('does not restart a multi-candidate queue when automatic fallback is disabled', () => {
    const { router } = setup([candidate('free:a'), candidate('free:b')], { automaticFallback: false });
    expect(router.allowsDeferredRetry(request)).toBe(false);
    const enabled = setup([candidate('free:a'), candidate('free:b')]);
    expect(enabled.router.allowsDeferredRetry(request)).toBe(true);
  });

  it('allows retry of one fixed candidate, preserving free-only and paid-fallback policy', () => {
    const free = candidate('free:a');
    const paid = candidate('paid:a', 'RATE_LIMITED', 429, 'paid');
    expect(setup([free], { automaticFallback: false }).router.allowsDeferredRetry(request)).toBe(true);
    expect(setup([free, paid], { automaticFallback: false, freeOnly: true }).router.allowsDeferredRetry(request)).toBe(true);
    expect(setup([free, paid], { automaticFallback: false, allowPaidFallback: false }).router.allowsDeferredRetry(request)).toBe(true);
    expect(setup([free, paid], { automaticFallback: false, allowPaidFallback: true }).router.allowsDeferredRetry(request)).toBe(false);
    expect(setup([paid], { automaticFallback: false, freeOnly: true }).router.allowsDeferredRetry(request)).toBe(false);
  });

  it('does not count temporary cooldown or token exclusions as fixed candidate identity', () => {
    const first = candidate('free:a');
    const { monitor, router } = setup([first, candidate('free:b')], { automaticFallback: false });
    monitor.block(first.key, 30_000, 'RATE_LIMITED');
    monitor.setQuota({ provider: first.providerId, model: first.model, metric: 'tokens', remaining: 0, limit: 10,
      resetAt: new Date(1_800_000_060_000).toISOString(), source: 'verified', note: 'test header' });
    expect(router.eligibility(request, { estimatedTokens: 5 }).filter(row => row.eligible)).toHaveLength(1);
    expect(router.allowsDeferredRetry(request, { estimatedTokens: 5 })).toBe(false);
  });

  it('uses the request capabilities for the fixed-candidate guard', () => {
    const unsupported = candidate('free:a');
    unsupported.capabilities = { structured: false, vision: false, tools: false };
    const supported = candidate('free:b');
    supported.capabilities = { structured: true, vision: true, tools: true };
    const { router } = setup([unsupported, supported], { automaticFallback: false });
    expect(router.allowsDeferredRetry({ ...request, structured: { name: 'decision', schema: {} } })).toBe(true);
    expect(router.allowsDeferredRetry({ ...request, image: { mimeType: 'image/jpeg', data: 'test' } })).toBe(true);
    expect(router.allowsDeferredRetry(request, { tools: true })).toBe(true);
  });

  it('reports the remaining 30-second rate cooldown without making or clearing a request', async () => {
    const model = candidate('free:a');
    const { monitor, router, advance } = setup([model]);
    await expect(router.generate(request)).rejects.toMatchObject({ code: 'NO_ELIGIBLE_PROVIDER' });
    expect(router.retryCooldown(request)).toEqual({ reason: 'RATE_LIMITED', retryAfterMs: 30_000, noRequestSent: true });
    advance(10_000);
    expect(router.retryCooldown(request)?.retryAfterMs).toBe(20_000);
    expect(monitor.blockedBy(model.key)).toBe('RATE_LIMITED');
    expect(model.provider.generate).toHaveBeenCalledTimes(1);
    advance(20_000);
    expect(router.retryCooldown(request)).toBeNull();
    expect(model.provider.generate).toHaveBeenCalledTimes(1);
  });

  it('preserves a provider delay beyond the caller automatic retry budget', async () => {
    const model = candidate('free:a', 'RATE_LIMITED', 429, 'free', 120_000);
    const { router } = setup([model]);
    await expect(router.generate(request)).rejects.toMatchObject({ retryAfterMs: 120_000 });
    expect(router.retryCooldown(request)?.retryAfterMs).toBe(120_000);
  });

  it('retains the cooldown after confirmed zero-usage 503 retries are exhausted', async () => {
    const { router } = setup([candidate('free:a', 'UPSTREAM_ERROR', 503)]);
    await expect(router.generate(request)).rejects.toMatchObject({ code: 'NO_ELIGIBLE_PROVIDER' });
    expect(router.retryCooldown(request)).toEqual({ reason: 'UPSTREAM_ERROR', retryAfterMs: 30_000, noRequestSent: true });
  });

  it.each(['QUOTA_EXHAUSTED', 'AUTHENTICATION_FAILED', 'MODEL_UNAVAILABLE', 'NOT_CONFIGURED', 'COOLING_DOWN', undefined])('rejects a %s cooldown', cause => {
    const { monitor, router } = setup([candidate('free:a')]);
    monitor.block('free:a', 30_000, cause);
    expect(router.retryCooldown(request)).toBeNull();
  });

  it.each(['QUOTA_EXHAUSTED', 'UPSTREAM_ERROR', undefined])('rejects mixed rate and %s cooldowns', cause => {
    const { monitor, router } = setup([candidate('free:a'), candidate('free:b')]);
    monitor.block('free:a', 30_000, 'RATE_LIMITED');
    monitor.block('free:b', 45_000, cause);
    expect(router.retryCooldown(request)).toBeNull();
  });

  it('uses the first route that can become available when all transient causes match', () => {
    const { monitor, router } = setup([candidate('free:a'), candidate('free:b')]);
    monitor.block('free:a', 45_000, 'RATE_LIMITED');
    monitor.block('free:b', 30_000, 'RATE_LIMITED');
    expect(router.retryCooldown(request)?.retryAfterMs).toBe(30_000);
  });

  it('does not report a cooldown while an allowed route is already available', () => {
    const { monitor, router } = setup([candidate('free:a'), candidate('free:b')]);
    monitor.block('free:a', 30_000, 'RATE_LIMITED');
    expect(router.retryCooldown(request)).toBeNull();
  });

  it('preserves free-only and paid-fallback exclusions', () => {
    const paid = candidate('paid:a', 'RATE_LIMITED', 429, 'paid');
    const denied = setup([paid], { freeOnly: true });
    denied.monitor.block(paid.key, 30_000, 'RATE_LIMITED');
    expect(denied.router.retryCooldown(request)).toBeNull();
    const mixed = setup([candidate('free:a'), paid]);
    mixed.monitor.block('free:a', 30_000, 'RATE_LIMITED');
    mixed.monitor.block(paid.key, 60_000, 'QUOTA_EXHAUSTED');
    expect(mixed.router.retryCooldown(request)?.retryAfterMs).toBe(30_000);
    const permitted = new InferenceRouter([candidate('free:a'), paid], policy({ allowPaidFallback: true }), mixed.monitor, { now: () => 1_800_000_000_000 });
    expect(permitted.retryCooldown(request)).toBeNull();
  });

  it.each(['structured', 'vision', 'tools', 'token_window'] as const)('keeps %s requirements while a candidate is cooling down', requirement => {
    const model = candidate('free:a');
    model.capabilities = { structured: false, vision: false, tools: false };
    const { monitor, router } = setup([model]);
    monitor.block(model.key, 30_000, 'RATE_LIMITED');
    monitor.setQuota({ provider: model.providerId, model: model.model, metric: 'tokens', remaining: 1, limit: 10,
      resetAt: new Date(1_800_000_060_000).toISOString(), source: 'verified', note: 'test header' });
    const shaped = requirement === 'structured' ? { ...request, structured: { name: 'decision', schema: {} } }
      : requirement === 'vision' ? { ...request, image: { mimeType: 'image/jpeg' as const, data: 'test' } } : request;
    expect(router.retryCooldown(shaped, requirement === 'tools' ? { tools: true } : requirement === 'token_window' ? { estimatedTokens: 5 } : {})).toBeNull();
  });

  it('does not inherit a stale transient reason when an unknown block extends it', () => {
    const { monitor, router } = setup([candidate('free:a')]);
    monitor.block('free:a', 30_000, 'RATE_LIMITED');
    monitor.block('free:a', 45_000);
    expect(monitor.blockedBy('free:a')).toBeUndefined();
    expect(router.retryCooldown(request)).toBeNull();
  });

  it('leaves cancellation unchanged and never dispatches an aborted request', async () => {
    const model = candidate('free:a');
    const { monitor, router } = setup([model]);
    monitor.block(model.key, 30_000, 'RATE_LIMITED');
    const controller = new AbortController();
    const reason = new Error('owner cancelled');
    controller.abort(reason);
    const aborted = { ...request, signal: controller.signal };
    expect(router.retryCooldown(aborted)).toBeNull();
    await expect(router.generate(aborted)).rejects.toBe(reason);
    expect(model.provider.generate).not.toHaveBeenCalled();
    expect(monitor.blockedBy(model.key)).toBe('RATE_LIMITED');
  });
});

describe('request-scoped free model recovery plan', () => {
  async function mixed(permanentStatus = 400, options: { permanentCost?: 'free' | 'paid'; retryCost?: 'free' | 'paid'; rejection?: ProviderError } = {}) {
    const permanent = candidate('free:rejected', 'REQUEST_REJECTED', permanentStatus, options.permanentCost ?? 'free');
    // The real gateway does not report usage for 400/413, unlike its 429/503.
    permanent.provider.generate = vi.fn(async () => { throw freeLLMAPIError(permanentStatus, null, null); });
    const limited = candidate('free:limited', 'RATE_LIMITED', 429, options.retryCost ?? 'free');
    let calls = 0;
    limited.provider.generate = vi.fn(async () => {
      if (calls++ === 0) throw options.rejection ?? freeLLMAPIError(429, 'rate_limit_exceeded', null);
      return { text: 'recovered', model: limited.model, usage: { inputTokens: 1, outputTokens: 1 } };
    });
    const fixture = setup([permanent, limited], { maxAttempts: 2, allowPaidFallback: true });
    const error = await fixture.router.generate(request).catch(caught => caught);
    return { ...fixture, permanent, limited, error };
  }

  it.each([400, 413])('retries only the transient free candidate after a %s and a rate refusal', async status => {
    const { router, monitor, advance, permanent, limited, error } = await mixed(status);
    expect(error).toMatchObject({ code: 'NO_ELIGIBLE_PROVIDER', causes: ['REQUEST_REJECTED', 'RATE_LIMITED'] });
    expect(error.cause.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    const plan = router.recoveryPlan(error, request);
    expect(plan?.excludedCause).toBe('REQUEST_REJECTED');
    expect(plan?.router.retryCooldown(request)).toEqual({ reason: 'RATE_LIMITED', retryAfterMs: 30_000, noRequestSent: true });
    // Both global blocks have expired. The permanently rejected candidate must
    // still be absent from every subsequent invocation of this decision child.
    advance(61_000);
    expect(monitor.blockedBy(permanent.key)).toBeUndefined();
    await expect(plan!.router.generate(request)).resolves.toMatchObject({ text: 'recovered', candidate: limited.key });
    await expect(plan!.router.generate(request)).resolves.toMatchObject({ text: 'recovered', candidate: limited.key });
    expect(permanent.provider.generate).toHaveBeenCalledTimes(1);
    expect(limited.provider.generate).toHaveBeenCalledTimes(3);
  });

  it('keeps a confirmed 503 delay in the scoped child', async () => {
    const rejection = freeLLMAPIError(503, null, '50');
    const { router, error } = await mixed(400, { rejection });
    const plan = router.recoveryPlan(error, request);
    expect(plan?.router.retryCooldown(request)).toEqual({ reason: 'UPSTREAM_ERROR', retryAfterMs: 50_000, noRequestSent: true });
  });

  it('retains the full 82-second provider cooldown after a free 400 and does not dispatch early', async () => {
    const rejection = freeLLMAPIError(429, 'rate_limit_exceeded', '82');
    expect(classifyProviderFallback(rejection)).toEqual({ allowed: false, reason: 'retry_budget_exceeded', retryAfterMs: 82_000 });
    const { router, monitor, advance, permanent, limited, error } = await mixed(400, { rejection });
    const plan = router.recoveryPlan(error, request);
    expect(plan?.excludedCause).toBe('REQUEST_REJECTED');
    expect(plan?.router.retryCooldown(request)?.retryAfterMs).toBe(82_000);
    expect(permanent.provider.generate).toHaveBeenCalledTimes(1);
    expect(limited.provider.generate).toHaveBeenCalledTimes(1);
    advance(60_000);
    expect(monitor.blockedBy(permanent.key)).toBeUndefined();
    expect(plan?.router.retryCooldown(request)?.retryAfterMs).toBe(22_000);
    advance(21_999);
    expect(plan?.router.retryCooldown(request)?.retryAfterMs).toBe(1);
    await expect(plan!.router.generate(request)).rejects.toMatchObject({ code: 'NO_ELIGIBLE_PROVIDER', causes: ['RATE_LIMITED'] });
    expect(limited.provider.generate).toHaveBeenCalledTimes(1);
    advance(1);
    expect(plan?.router.retryCooldown(request)).toBeNull();
    await expect(plan!.router.generate(request)).resolves.toMatchObject({ text: 'recovered', candidate: limited.key });
    expect(limited.provider.generate).toHaveBeenCalledTimes(2);
    expect(permanent.provider.generate).toHaveBeenCalledTimes(1);
  });

  it('does not require token capacity on the permanently excluded candidate', async () => {
    const { router, monitor, permanent, error } = await mixed();
    monitor.setQuota({ provider: permanent.providerId, model: permanent.model, metric: 'tokens', remaining: 0, limit: 10,
      resetAt: new Date(1_800_000_060_000).toISOString(), source: 'verified', note: 'test header' });
    expect(router.recoveryPlan(error, request, { estimatedTokens: 5 })?.excludedCause).toBe('REQUEST_REJECTED');
  });

  it.each(['permanentCost', 'retryCost'] as const)('rejects a paid %s participant even if paid fallback is enabled', async field => {
    const { router, error } = await mixed(400, { [field]: 'paid' });
    expect(router.recoveryPlan(error, request)).toBeNull();
  });

  it.each(['QUOTA_EXHAUSTED', 'AUTHENTICATION_FAILED', 'NETWORK_ERROR'])('does not scope away %s to permit recovery', async code => {
    const first = candidate('free:first', code, code === 'AUTHENTICATION_FAILED' ? 401 : 429);
    const last = candidate('free:last');
    const { router } = setup([first, last], { maxAttempts: 2 });
    const error = await router.generate(request).catch(caught => caught);
    expect(router.recoveryPlan(error, request)).toBeNull();
  });

  it.each(['usage', 'retryAfter', 'generation'] as const)('does not let exclusion proof override unsafe transient %s', async defect => {
    const rejection = freeLLMAPIError(429, 'rate_limit_exceeded', defect === 'retryAfter' ? 'invalid' : null);
    if (defect === 'usage') rejection.usage = undefined;
    if (defect === 'generation') rejection.failedGeneration = 'untrusted output';
    const { router, error } = await mixed(400, { rejection });
    expect(router.recoveryPlan(error, request)).toBeNull();
  });

  it('preserves fallback, request capability, token window, and cancellation constraints', async () => {
    const { router, monitor, permanent, limited, error } = await mixed();
    const noFallback = new InferenceRouter([permanent, limited], policy({ automaticFallback: false }), monitor, { now: () => 1_800_000_000_000 });
    expect(noFallback.recoveryPlan(error, request)).toBeNull();
    limited.capabilities = { structured: false };
    expect(router.recoveryPlan(error, { ...request, structured: { name: 'decision', schema: {} } })).toBeNull();
    limited.capabilities = {};
    monitor.setQuota({ provider: limited.providerId, model: limited.model, metric: 'tokens', remaining: 0, limit: 10,
      resetAt: new Date(1_800_000_060_000).toISOString(), source: 'verified', note: 'test header' });
    expect(router.recoveryPlan(error, request, { estimatedTokens: 5 })).toBeNull();
    const controller = new AbortController();
    controller.abort();
    expect(router.recoveryPlan(error, { ...request, signal: controller.signal })).toBeNull();
  });
});
