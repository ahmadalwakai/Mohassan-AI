import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyProviderFallback, parseRetryAfterHeader, ProviderError, validatedRetryAfterMs, waitForRetryAfter } from './index.js';

function rejection(status = 429, usage: unknown = { inputTokens: 0, outputTokens: 0 }): ProviderError {
  const error = new ProviderError(status === 429 ? 'RATE_LIMITED' : 'UPSTREAM_ERROR', 'fixture', true, status);
  error.usage = usage as ProviderError['usage'];
  return error;
}
afterEach(() => { vi.useRealTimers(); });

describe('shared fallback eligibility', () => {
  it.each([429, 503])('accepts only an explicit zero receipt for aligned HTTP %s', status => {
    expect(classifyProviderFallback(rejection(status))).toEqual({ allowed: true, reason: 'confirmed_zero_usage_rejection', retryAfterMs: 0 });
  });
  it.each([undefined, null, {}, { inputTokens: 0 }, { inputTokens: 0, outputTokens: 1 }, { inputTokens: -1, outputTokens: 0 }, { inputTokens: NaN, outputTokens: 0 }, { inputTokens: 0, outputTokens: 0, additional: true }])('rejects missing, malformed or paid usage %j', usage => {
    const error = rejection(); error.usage = usage as ProviderError['usage'];
    expect(classifyProviderFallback(error)).toEqual({ allowed: false, reason: 'not_confirmed_rejection' });
  });
  it.each([
    new Error('network outcome unknown'),
    { code: 'RATE_LIMITED', httpStatus: 429, retryable: true, usage: { inputTokens: 0, outputTokens: 0 } },
    Object.assign(new ProviderError('RATE_LIMITED', 'fixture', false, 429), { usage: { inputTokens: 0, outputTokens: 0 } }),
    Object.assign(new ProviderError('RATE_LIMITED', 'fixture', true, 503), { usage: { inputTokens: 0, outputTokens: 0 } }),
    Object.assign(new ProviderError('UPSTREAM_ERROR', 'fixture', true, 429), { usage: { inputTokens: 0, outputTokens: 0 } }),
    Object.assign(new ProviderError('NETWORK_ERROR', 'fixture', true, 503), { usage: { inputTokens: 0, outputTokens: 0 } }),
    rejection(500),
  ])('does not infer retry authorization from an arbitrary error', error => {
    expect(classifyProviderFallback(error)).toEqual({ allowed: false, reason: 'not_confirmed_rejection' });
  });
  it.each([0, 0.1, 2500, 60000])('keeps the entire permitted delay %s', retryAfterMs => {
    expect(classifyProviderFallback(Object.assign(rejection(), { retryAfterMs }))).toEqual({ allowed: true, reason: 'confirmed_zero_usage_rejection', retryAfterMs: Math.ceil(retryAfterMs) });
  });
  it.each([60000.1, 600000, Number.MAX_SAFE_INTEGER])('refuses an automatic retry sooner than the required delay %s', retryAfterMs => {
    expect(classifyProviderFallback(Object.assign(rejection(), { retryAfterMs }))).toEqual({ allowed: false, reason: 'retry_budget_exceeded', retryAfterMs: Math.ceil(retryAfterMs) });
  });
  it.each([-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, '2500'])('fails closed on malformed retry metadata %s', retryAfterMs => {
    expect(classifyProviderFallback(Object.assign(rejection(), { retryAfterMs }))).toEqual({ allowed: false, reason: 'retry_after_invalid' });
  });
  it('does not turn an invalid provider header into an absent optional header', () => {
    expect(classifyProviderFallback(Object.assign(rejection(), { retryAfterInvalid: true }))).toEqual({ allowed: false, reason: 'retry_after_invalid' });
  });
});

describe('Retry-After metadata validation', () => {
  it.each([['0', 0], ['0.0001', 1], ['2.5', 2500], ['60', 60000], ['600', 600000], [' 600 ', 600000]] as const)('preserves %s seconds without clamping', (header, delay) => {
    expect(parseRetryAfterHeader(header)).toEqual({ retryAfterMs: delay });
  });
  it.each(['', ' ', '-1', 'Infinity', 'NaN', '1e3', '2s', '99999999999999999999', '9'.repeat(129), 'Thu, 32 Nov 2026 12:00:00 GMT'])('marks malformed or overflowing header %s invalid', header => {
    expect(parseRetryAfterHeader(header)).toEqual({ retryAfterInvalid: true });
  });
  it('distinguishes an absent header and accepts a complete canonical HTTP date', () => {
    const now = Date.parse('Thu, 05 Nov 2026 12:00:00 GMT');
    expect(parseRetryAfterHeader(null, now)).toEqual({});
    expect(parseRetryAfterHeader('Thu, 05 Nov 2026 12:10:00 GMT', now)).toEqual({ retryAfterMs: 600000 });
    expect(parseRetryAfterHeader('Thu, 05 Nov 2026 11:59:00 GMT', now)).toEqual({ retryAfterMs: 0 });
    expect(validatedRetryAfterMs(undefined)).toBeUndefined();
  });
});

describe('bounded cancellable waiting', () => {
  it('waits the complete delay and releases the timer and listener on completion', async () => {
    vi.useFakeTimers();
    const controller = new AbortController(), remove = vi.spyOn(controller.signal, 'removeEventListener');
    let finished = false;
    const pending = waitForRetryAfter(2500, controller.signal).then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(2499); expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1); await pending;
    expect(finished).toBe(true); expect(vi.getTimerCount()).toBe(0); expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });
  it('cancels an active wait and clears resources without running another timer', async () => {
    vi.useFakeTimers();
    const controller = new AbortController(), reason = new Error('fixture cancelled');
    const pending = waitForRetryAfter(60000, controller.signal).catch(error => error);
    controller.abort(reason);
    expect(await pending).toBe(reason); expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects an already cancelled signal even for zero delay', async () => {
    const controller = new AbortController(), reason = new Error('already stopped'); controller.abort(reason);
    await expect(waitForRetryAfter(0, controller.signal)).rejects.toBe(reason);
  });
  it.each([60001, 600000])('refuses delay %s instead of clamping it', async delay => {
    vi.useFakeTimers();
    await expect(waitForRetryAfter(delay)).rejects.toMatchObject({ code: 'RETRY_BUDGET_EXCEEDED' });
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('refuses invalid wait %s without a timer', async delay => {
    vi.useFakeTimers();
    await expect(waitForRetryAfter(delay)).rejects.toMatchObject({ code: 'INVALID_RETRY_AFTER' });
    expect(vi.getTimerCount()).toBe(0);
  });
});
