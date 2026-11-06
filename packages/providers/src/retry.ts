import { z } from 'zod';
import { ProviderError } from './index.js';

export const MAX_AUTOMATIC_RETRY_DELAY_MS = 60_000;
const ZeroUsageSchema = z.object({ inputTokens: z.literal(0), outputTokens: z.literal(0) }).strict();

/** Keep the original valid delay: an oversized delay must never become an early retry. */
export function validatedRetryAfterMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && Number.isSafeInteger(Math.ceil(value))
    ? Math.ceil(value) : undefined;
}

export function parseRetryAfterHeader(value: string | null, now = Date.now()): { retryAfterMs?: number; retryAfterInvalid?: true } {
  if (value === null) return {};
  const header = value.trim();
  if (!header || header.length > 128) return { retryAfterInvalid: true };
  let delay: number | undefined;
  if (/^\d+(?:\.\d+)?$/.test(header)) {
    delay = validatedRetryAfterMs(Number(header) * 1000);
  } else if (/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(header)) {
    const timestamp = Date.parse(header);
    if (Number.isFinite(timestamp) && new Date(timestamp).toUTCString() === header) {
      delay = validatedRetryAfterMs(Math.max(0, timestamp - now));
    }
  }
  return delay === undefined ? { retryAfterInvalid: true } : { retryAfterMs: delay };
}

export type ProviderFallbackDecision =
  | { allowed: true; reason: 'confirmed_zero_usage_rejection'; retryAfterMs: number }
  | { allowed: false; reason: 'not_confirmed_rejection' | 'retry_after_invalid' | 'retry_budget_exceeded'; retryAfterMs?: number };

/** Eligibility only; callers still enforce configured distinct models and at most two calls. */
export function classifyProviderFallback(error: unknown): ProviderFallbackDecision {
  if (!(error instanceof ProviderError) || error.retryable !== true
    || !(error.code === 'RATE_LIMITED' && error.httpStatus === 429 || error.code === 'UPSTREAM_ERROR' && error.httpStatus === 503)
    || !ZeroUsageSchema.safeParse(error.usage).success) return { allowed: false, reason: 'not_confirmed_rejection' };
  const delay = validatedRetryAfterMs(error.retryAfterMs);
  if (error.retryAfterInvalid === true || error.retryAfterMs !== undefined && delay === undefined) {
    return { allowed: false, reason: 'retry_after_invalid' };
  }
  if (delay !== undefined && delay > MAX_AUTOMATIC_RETRY_DELAY_MS) {
    return { allowed: false, reason: 'retry_budget_exceeded', retryAfterMs: delay };
  }
  return { allowed: true, reason: 'confirmed_zero_usage_rejection', retryAfterMs: delay ?? 0 };
}

/** Wait the full allowed delay, releasing the timer/listener on either completion or cancellation. */
export async function waitForRetryAfter(delayMs: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const delay = validatedRetryAfterMs(delayMs);
  if (delay === undefined) throw new ProviderError('INVALID_RETRY_AFTER', 'مهلة إعادة المحاولة غير صالحة.');
  if (delay > MAX_AUTOMATIC_RETRY_DELAY_MS) throw new ProviderError('RETRY_BUDGET_EXCEEDED', 'مهلة المزود تتجاوز الانتظار التلقائي المسموح؛ لم تتكرر المحاولة.');
  if (delay === 0) return;
  await new Promise<void>((resolve, reject) => {
    const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, delay);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
