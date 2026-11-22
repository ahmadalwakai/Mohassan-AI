import { describe, expect, it } from 'vitest';
import { classifyProviderFallback, MAX_AUTOMATIC_RETRY_DELAY_MS, ProviderError } from '@mohassan/providers';
import { MAX_MODEL_RECOVERY_DELAY_MS, MAX_MODEL_RETRIES, reviewModelRetry, type ModelRetryContext } from '../apps/server/src/assistant/model-retry.ts';

const context = (overrides: Partial<ModelRetryContext> = {}): ModelRetryContext => ({ retries: 0, remainingMs: 900_000, ...overrides });
const rejection = (status = 429, retryAfterMs?: number): ProviderError => Object.assign(
  new ProviderError(status === 429 ? 'RATE_LIMITED' : 'UPSTREAM_ERROR', 'upstream text is not policy', true, status),
  { usage: { inputTokens: 0, outputTokens: 0 }, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) },
);
const none = (causes: string[] = [], cause?: unknown) => Object.assign(new ProviderError('NO_ELIGIBLE_PROVIDER', 'fixture'), { causes, ...(cause === undefined ? {} : { cause }) });

describe('model request retry policy', () => {
  it.each([429, 503])('permits only a confirmed zero-usage HTTP %s rejection', status => {
    expect(reviewModelRetry(rejection(status), context())).toEqual({ retry: true, delayMs: 30_000, reason: 'zero_usage_rejection' });
  });

  it('spends the run-wide three-retry budget with backoff even without a provider header', () => {
    expect(MAX_MODEL_RETRIES).toBe(3);
    for (const [retries, delayMs] of [30_000, 45_000, 60_000].entries()) {
      expect(reviewModelRetry(rejection(), context({ retries }))).toEqual({ retry: true, delayMs, reason: 'zero_usage_rejection' });
    }
    expect(reviewModelRetry(rejection(), context({ retries: 3 }))).toEqual({ retry: false, reason: 'retry_limit' });
    expect(reviewModelRetry(rejection(), context({ retries: 30 }))).toEqual({ retry: false, reason: 'retry_limit' });
  });

  it('honors the longest valid delay across routed wrappers without shortening or mutating it', () => {
    const leaf = rejection(429, 35_000.1);
    const outer = Object.assign(none(['RATE_LIMITED'], leaf), { retryAfterMs: 52_000 });
    Object.freeze(leaf.usage); Object.freeze(leaf); Object.freeze(outer.causes); Object.freeze(outer);
    expect(reviewModelRetry(outer, context())).toEqual({ retry: true, delayMs: 52_000, reason: 'zero_usage_rejection' });
    expect(reviewModelRetry(leaf, context())).toMatchObject({ retry: true, delayMs: 35_001 });
    expect(leaf.retryAfterMs).toBe(35_000.1);
    expect(outer.retryAfterMs).toBe(52_000);
  });

  it.each([300_000.1, 300_001, 3_600_000])('refuses provider delay %s rather than retrying before it', delay => {
    expect(reviewModelRetry(rejection(429, delay), context())).toEqual({ retry: false, reason: 'delay_limit' });
    expect(reviewModelRetry(Object.assign(none(['RATE_LIMITED'], rejection()), { retryAfterMs: delay }), context())).toEqual({ retry: false, reason: 'delay_limit' });
  });

  it.each([429, 503])('honors a long confirmed HTTP %s refusal within the separate host recovery budget', status => {
    expect(MAX_MODEL_RECOVERY_DELAY_MS).toBe(300_000);
    expect(MAX_AUTOMATIC_RETRY_DELAY_MS).toBe(60_000);
    for (const delayMs of [82_000, 120_000, 300_000]) {
      expect(classifyProviderFallback(rejection(status, delayMs))).toMatchObject({ allowed: false, reason: 'retry_budget_exceeded', retryAfterMs: delayMs });
      expect(reviewModelRetry(rejection(status, delayMs), context())).toEqual({ retry: true, delayMs, reason: 'zero_usage_rejection' });
      const leaf = rejection(status, delayMs);
      expect(reviewModelRetry(none([leaf.code], leaf), context())).toEqual({ retry: true, delayMs, reason: 'zero_usage_rejection' });
    }
  });

  it('does not turn a long retry header into proof of zero usage or valid authentication', () => {
    const unknown = rejection(429, 82_000); unknown.usage = undefined;
    const paid = rejection(503, 82_000); paid.usage = { inputTokens: 2, outputTokens: 0 };
    const auth = Object.assign(new ProviderError('AUTHENTICATION_FAILED', 'fixture', false, 401), { retryAfterMs: 82_000, usage: { inputTokens: 0, outputTokens: 0 } });
    const quota = Object.assign(new ProviderError('QUOTA_EXHAUSTED', 'fixture', true, 429), { retryAfterMs: 82_000, usage: { inputTokens: 0, outputTokens: 0 } });
    for (const error of [unknown, paid, auth, quota]) expect(reviewModelRetry(error, context()).retry).toBe(false);
  });

  it('respects the remaining run deadline for the actual 82-second retry and the five-minute boundary', () => {
    expect(reviewModelRetry(rejection(429, 82_000), context({ remainingMs: 82_000 }))).toEqual({ retry: false, reason: 'run_deadline' });
    expect(reviewModelRetry(rejection(429, 82_000), context({ remainingMs: 82_001 }))).toMatchObject({ retry: true, delayMs: 82_000 });
    expect(reviewModelRetry(rejection(429, 300_000), context({ remainingMs: 300_000 }))).toEqual({ retry: false, reason: 'run_deadline' });
    expect(reviewModelRetry(rejection(429, 300_000), context({ remainingMs: 300_001 }))).toMatchObject({ retry: true, delayMs: 300_000 });
  });

  it.each([undefined, null, {}, { inputTokens: 0 }, { inputTokens: 1, outputTokens: 0 }, { inputTokens: 0, outputTokens: 1 }, { inputTokens: 0, outputTokens: 0, extra: true }])('refuses missing, malformed or nonzero usage %j', usage => {
    const error = rejection(); error.usage = usage as ProviderError['usage'];
    expect(reviewModelRetry(error, context()).retry).toBe(false);
    expect(reviewModelRetry(none(['RATE_LIMITED'], error), context()).retry).toBe(false);
  });

  it.each([
    ['RATE_LIMITED', 503, true], ['UPSTREAM_ERROR', 429, true], ['UPSTREAM_ERROR', 502, true],
    ['RATE_LIMITED', 429, false], ['QUOTA_EXHAUSTED', 429, true], ['AUTHENTICATION_FAILED', 401, false],
    ['NOT_CONFIGURED', 503, true], ['NETWORK_ERROR', 503, true], ['TIMEOUT', 503, true],
  ] as const)('does not widen rejection eligibility for %s/%s/retryable=%s', (code, status, retryable) => {
    const error = Object.assign(new ProviderError(code, 'RATE_LIMITED retry after 1 second', retryable, status), { usage: { inputTokens: 0, outputTokens: 0 } });
    expect(reviewModelRetry(error, context()).retry).toBe(false);
  });

  it.each([-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, '30000'])('refuses malformed retry-after metadata %j at any depth', value => {
    const error = rejection(); error.retryAfterMs = value as number;
    expect(reviewModelRetry(error, context())).toEqual({ retry: false, reason: 'invalid_retry_after' });
    expect(reviewModelRetry(Object.assign(none(['RATE_LIMITED'], rejection()), { retryAfterMs: value }), context())).toEqual({ retry: false, reason: 'invalid_retry_after' });
  });

  it('does not erase malformed-header or generated-output evidence', () => {
    expect(reviewModelRetry(Object.assign(rejection(), { retryAfterInvalid: true }), context()).retry).toBe(false);
    expect(reviewModelRetry(Object.assign(none(['RATE_LIMITED'], rejection()), { retryAfterInvalid: true }), context()).retry).toBe(false);
    expect(reviewModelRetry(Object.assign(rejection(), { failedGeneration: '{"tool":"click"}' }), context()).retry).toBe(false);
  });

  it.each([['RATE_LIMITED', 'AUTHENTICATION_FAILED'], ['RATE_LIMITED', 'QUOTA_EXHAUSTED'], ['RATE_LIMITED', 'NETWORK_ERROR'], ['RATE_LIMITED', 'UPSTREAM_ERROR'], ['COOLING_DOWN']].map(causes => ({ causes })))('refuses mixed or unspecified routed causes $causes', ({ causes }) => {
    expect(reviewModelRetry(none(causes, rejection()), context())).toEqual({ retry: false, reason: 'mixed_causes' });
  });

  it.each([429, 503])('accepts an excluded request-rejected candidate only beside a confirmed HTTP %s zero-usage leaf', status => {
    const leaf = rejection(status);
    const mixed = none(['REQUEST_REJECTED', leaf.code], leaf);
    expect(reviewModelRetry(mixed, context())).toEqual({ retry: false, reason: 'mixed_causes' });
    expect(reviewModelRetry(mixed, context({ excludedCause: 'REQUEST_REJECTED' }))).toEqual({ retry: true, delayMs: 30_000, reason: 'zero_usage_rejection' });
    expect(mixed.causes).toEqual(['REQUEST_REJECTED', leaf.code]);
  });

  it('does not use an exclusion proof to excuse unknown leaf usage, nonzero parent usage or generated output', () => {
    const proof = context({ excludedCause: 'REQUEST_REJECTED' });
    const unknown = rejection(); unknown.usage = undefined;
    expect(reviewModelRetry(none(['REQUEST_REJECTED', 'RATE_LIMITED'], unknown), proof).retry).toBe(false);
    const mixed = () => none(['REQUEST_REJECTED', 'RATE_LIMITED'], rejection());
    for (const usage of [{ inputTokens: 1, outputTokens: 0 }, null, { inputTokens: 0 }]) {
      expect(reviewModelRetry(Object.assign(mixed(), { usage }), proof).retry).toBe(false);
    }
    expect(reviewModelRetry(Object.assign(mixed(), { failedGeneration: 'untrusted output' }), proof).retry).toBe(false);
    expect(reviewModelRetry(new ProviderError('REQUEST_REJECTED', 'fixture', true, 400), proof).retry).toBe(false);
  });

  it.each(['QUOTA_EXHAUSTED', 'AUTHENTICATION_FAILED', 'NOT_CONFIGURED', 'NETWORK_ERROR', 'UPSTREAM_ERROR'])('does not exclude any additional mixed cause %s', cause => {
    expect(reviewModelRetry(none(['REQUEST_REJECTED', 'RATE_LIMITED', cause], rejection()), context({ excludedCause: 'REQUEST_REJECTED' })))
      .toEqual({ retry: false, reason: 'mixed_causes' });
  });

  it('does not admit the excluded cause through cooldown evidence without a real zero-usage leaf', () => {
    const cooldown = { reason: 'RATE_LIMITED' as const, noRequestSent: true as const, retryAfterMs: 30_000 };
    expect(reviewModelRetry(none(['REQUEST_REJECTED', 'RATE_LIMITED']), context({ excludedCause: 'REQUEST_REJECTED', cooldown })))
      .toEqual({ retry: false, reason: 'mixed_causes' });
    expect(reviewModelRetry(rejection(), context({ excludedCause: 'AUTHENTICATION_FAILED' as 'REQUEST_REJECTED' })).retry).toBe(false);
  });

  it('accepts a bounded same-cause chain but refuses cycles, excessive nesting, and fabricated errors', () => {
    let error: ProviderError = rejection();
    for (let index = 0; index < 3; index++) error = none(['RATE_LIMITED'], error);
    expect(reviewModelRetry(error, context()).retry).toBe(true);
    expect(reviewModelRetry(none(['RATE_LIMITED'], error), context())).toEqual({ retry: false, reason: 'invalid_error_chain' });
    const cycle = none(['RATE_LIMITED']); cycle.cause = cycle;
    for (const value of [cycle, none(['RATE_LIMITED'], new Error('429')), new Error('RATE_LIMITED'), { code: 'RATE_LIMITED', retryable: true, httpStatus: 429, usage: { inputTokens: 0, outputTokens: 0 } }]) {
      expect(reviewModelRetry(value, context())).toEqual({ retry: false, reason: 'invalid_error_chain' });
    }
  });

  it.each(['RATE_LIMITED', 'UPSTREAM_ERROR'] as const)('allows a trusted no-request cooldown for %s without inventing usage', reason => {
    const cooldown = { reason, noRequestSent: true as const, retryAfterMs: 48_000 };
    expect(reviewModelRetry(none([reason]), context({ cooldown }))).toEqual({ retry: true, delayMs: 48_000, reason: 'known_cooldown' });
    expect(reviewModelRetry(none(['COOLING_DOWN']), context({ cooldown }))).toEqual({ retry: true, delayMs: 48_000, reason: 'known_cooldown' });
    expect(reviewModelRetry(none(['COOLING_DOWN', reason]), context({ cooldown }))).toEqual({ retry: false, reason: 'mixed_causes' });
    expect(reviewModelRetry(none(), context({ cooldown }))).toMatchObject({ retry: true, reason: 'known_cooldown' });
    expect(reviewModelRetry(none([reason]), context())).toMatchObject({ retry: false });
  });

  it('never uses cooldown evidence to excuse an actual request with unknown usage or a different failure', () => {
    const cooldown = { reason: 'RATE_LIMITED' as const, noRequestSent: true as const, retryAfterMs: 30_000 };
    const unknownUsage = rejection(); unknownUsage.usage = undefined;
    for (const error of [unknownUsage, none(['RATE_LIMITED'], unknownUsage), none(['QUOTA_EXHAUSTED']), none(['NOT_CONFIGURED']), new ProviderError('QUOTA_EXHAUSTED', 'fixture')]) {
      expect(reviewModelRetry(error, context({ cooldown })).retry).toBe(false);
    }
  });

  it.each([
    { reason: 'RATE_LIMITED', noRequestSent: false, retryAfterMs: 30_000 },
    { reason: 'RATE_LIMITED', retryAfterMs: 30_000 },
    { reason: 'RATE_LIMITED', noRequestSent: true },
    { reason: 'RATE_LIMITED', noRequestSent: true, retryAfterMs: -1 },
    { reason: 'RATE_LIMITED', noRequestSent: true, retryAfterMs: '30000' },
    { reason: 'QUOTA_EXHAUSTED', noRequestSent: true, retryAfterMs: 30_000 },
  ])('requires explicit valid host cooldown evidence %j', cooldown => {
    expect(reviewModelRetry(none(['RATE_LIMITED']), context({ cooldown: cooldown as ModelRetryContext['cooldown'] }))).toEqual({ retry: false, reason: 'invalid_cooldown' });
  });

  it('does not clamp cooldown delays to the automatic limit or the run deadline', () => {
    const cooldown = { reason: 'RATE_LIMITED' as const, noRequestSent: true as const, retryAfterMs: 300_001 };
    expect(reviewModelRetry(none(['RATE_LIMITED']), context({ cooldown }))).toEqual({ retry: false, reason: 'delay_limit' });
    expect(reviewModelRetry(rejection(), context({ remainingMs: 30_000 }))).toEqual({ retry: false, reason: 'run_deadline' });
    expect(reviewModelRetry(rejection(), context({ remainingMs: 29_999 }))).toEqual({ retry: false, reason: 'run_deadline' });
    expect(reviewModelRetry(rejection(), context({ remainingMs: 30_001 })).retry).toBe(true);
  });

  it('preserves a longer trusted host cooldown even beside a zero-usage rejection with a shorter header', () => {
    const cooldown = { reason: 'RATE_LIMITED' as const, noRequestSent: true as const, retryAfterMs: 45_000 };
    expect(reviewModelRetry(rejection(429, 0), context({ cooldown }))).toEqual({ retry: true, delayMs: 45_000, reason: 'zero_usage_rejection' });
    expect(reviewModelRetry(rejection(429, 0), context({ cooldown: { ...cooldown, retryAfterMs: 300_001 } })))
      .toEqual({ retry: false, reason: 'delay_limit' });
  });

  it('honors a trusted 82-second or five-minute cooldown without shortening it to the immediate fallback limit', () => {
    for (const delayMs of [82_000, 300_000]) {
      const cooldown = { reason: 'RATE_LIMITED' as const, noRequestSent: true as const, retryAfterMs: delayMs };
      expect(reviewModelRetry(none(['RATE_LIMITED']), context({ cooldown }))).toEqual({ retry: true, delayMs, reason: 'known_cooldown' });
      expect(reviewModelRetry(rejection(429, 0), context({ cooldown }))).toEqual({ retry: true, delayMs, reason: 'zero_usage_rejection' });
    }
  });

  it.each([
    { retries: -1 }, { retries: 0.5 }, { retries: NaN }, { remainingMs: Infinity }, { remainingMs: -1 }, { remainingMs: NaN },
  ])('rejects an invalid host budget %j', override => {
    expect(reviewModelRetry(rejection(), context(override))).toEqual({ retry: false, reason: 'invalid_budget' });
  });
});
