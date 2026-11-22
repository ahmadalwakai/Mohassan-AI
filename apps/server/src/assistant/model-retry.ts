import { classifyProviderFallback, ProviderError, validatedRetryAfterMs } from '@mohassan/providers';
import { z } from 'zod';

export const MAX_MODEL_RETRIES = 3;
/** Deferred host recovery has its own budget; immediate provider fallback stays unchanged. */
export const MAX_MODEL_RECOVERY_DELAY_MS = 300_000;
const BACKOFF_MS = [30_000, 45_000, 60_000] as const;
const MAX_ERROR_DEPTH = 4;
const ZeroUsageSchema = z.object({ inputTokens: z.literal(0), outputTokens: z.literal(0) }).strict();

/** Host evidence from router eligibility, never provider text or a model decision. */
export interface ModelRetryCooldown {
  reason: 'RATE_LIMITED' | 'UPSTREAM_ERROR';
  retryAfterMs: number;
  noRequestSent: true;
}
export interface ModelRetryContext {
  /** Retries already consumed across the current run; callers persist this counter. */
  retries: number;
  remainingMs: number;
  cooldown?: ModelRetryCooldown;
  /** Host router proof that this rejected free candidate is absent from the retry route. */
  excludedCause?: 'REQUEST_REJECTED';
}
export type ModelRetryReview =
  | { retry: true; delayMs: number; reason: 'zero_usage_rejection' | 'known_cooldown' }
  | { retry: false; reason: 'invalid_budget' | 'retry_limit' | 'unsafe_rejection' | 'invalid_error_chain'
      | 'mixed_causes' | 'invalid_cooldown' | 'invalid_retry_after' | 'delay_limit' | 'run_deadline' };

/**
 * Eligibility for repeating only the unanswered model request. This neither waits
 * nor authorizes replay of a tool, and it never resets the run's action receipts.
 */
export function reviewModelRetry(error: unknown, context: ModelRetryContext): ModelRetryReview {
  const refuse = (reason: Extract<ModelRetryReview, { retry: false }>['reason']): ModelRetryReview => ({ retry: false, reason });
  if (!Number.isSafeInteger(context.retries) || context.retries < 0
    || !Number.isSafeInteger(context.remainingMs) || context.remainingMs < 0) return refuse('invalid_budget');
  if (context.retries >= MAX_MODEL_RETRIES) return refuse('retry_limit');
  if (context.excludedCause !== undefined && context.excludedCause !== 'REQUEST_REJECTED') return refuse('unsafe_rejection');

  const chain: ProviderError[] = [];
  const seen = new Set<ProviderError>();
  let current: unknown = error;
  let rejection: ProviderError | undefined;
  for (;;) {
    if (!(current instanceof ProviderError) || seen.has(current) || chain.length >= MAX_ERROR_DEPTH) return refuse('invalid_error_chain');
    seen.add(current);
    chain.push(current);
    if (current.code !== 'NO_ELIGIBLE_PROVIDER') { rejection = current; break; }
    if (current.cause === undefined) break;
    current = current.cause;
  }

  const cooldown = context.cooldown;
  if (cooldown !== undefined && (!cooldown || cooldown.noRequestSent !== true
    || !['RATE_LIMITED', 'UPSTREAM_ERROR'].includes(cooldown.reason)
    || validatedRetryAfterMs(cooldown.retryAfterMs) === undefined)) return refuse('invalid_cooldown');
  const reasonCode = rejection?.code ?? cooldown?.reason;
  if (reasonCode !== 'RATE_LIMITED' && reasonCode !== 'UPSTREAM_ERROR') return refuse('unsafe_rejection');
  let providerDelay = cooldown ? validatedRetryAfterMs(cooldown.retryAfterMs)! : 0;
  for (const item of chain) {
    if (item.causes !== undefined && (!Array.isArray(item.causes) || item.causes.length > 8
      || !(item.causes.every(code => code === reasonCode
          || Boolean(rejection) && context.excludedCause === 'REQUEST_REJECTED' && code === context.excludedCause)
        || !rejection && cooldown && item.causes.every(code => code === 'COOLING_DOWN')))) return refuse('mixed_causes');
    if (item.failedGeneration !== undefined || item.usage !== undefined && !ZeroUsageSchema.safeParse(item.usage).success) return refuse('unsafe_rejection');
    const delay = validatedRetryAfterMs(item.retryAfterMs);
    if (item.retryAfterInvalid === true || item.retryAfterMs !== undefined && delay === undefined) return refuse('invalid_retry_after');
    providerDelay = Math.max(providerDelay, delay ?? 0);
  }

  let reason: Extract<ModelRetryReview, { retry: true }>['reason'];
  if (rejection) {
    // A cooldown cannot make an actual request with unknown usage safe to repeat.
    const fallback = classifyProviderFallback(rejection);
    // Exceeding immediate fallback's 60 seconds does not invalidate its strict
    // zero-usage rejection proof. The host applies its separate delay limit below.
    if (!fallback.allowed && fallback.reason !== 'retry_budget_exceeded') return refuse('unsafe_rejection');
    reason = 'zero_usage_rejection';
  } else {
    if (!cooldown) return refuse('unsafe_rejection');
    reason = 'known_cooldown';
  }
  const delayMs = Math.max(BACKOFF_MS[context.retries]!, providerDelay);
  if (delayMs > MAX_MODEL_RECOVERY_DELAY_MS) return refuse('delay_limit');
  // Equality leaves no time for another request before the run's deadline.
  if (delayMs >= context.remainingMs) return refuse('run_deadline');
  return { retry: true, delayMs, reason };
}
