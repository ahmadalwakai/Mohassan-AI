import { ProviderError, type ModelProvider, type ModelRequest, type ModelResult } from './index.js';
import { MAX_AUTOMATIC_RETRY_DELAY_MS, validatedRetryAfterMs, waitForRetryAfter } from './retry.js';
import { UsageMonitor } from './usage-monitor.js';
import type { StreamEvent } from './freellmapi.js';

export type CandidateCost = 'free' | 'paid';

export interface RouteCandidate {
  /** Unique and stable, e.g. `freellmapi:auto` or `groq:openai/gpt-oss-20b`. */
  key: string;
  providerId: string;
  model: string;
  cost: CandidateCost;
  provider: ModelProvider & { stream?: (request: ModelRequest) => AsyncGenerator<StreamEvent, void, void> };
  /** `false` = verified unsupported, `true` = advertised, `null`/absent = not reported. */
  capabilities?: { structured?: boolean | null; vision?: boolean | null; tools?: boolean | null };
}

export interface RouterPolicy {
  freeOnly: boolean;
  /** Switch to another candidate when one fails. Bounded retries of the same candidate still apply. */
  automaticFallback: boolean;
  /** Moving from a free candidate to a paid one mid-request needs explicit consent. */
  allowPaidFallback: boolean;
  maxAttempts?: number;
  maxTransientRetries?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

export interface RouteRequirements {
  /** Native tool calling. This project's agent uses structured output instead. */
  tools?: boolean;
  /** Rough token need; a candidate whose verified token window is smaller is skipped. */
  estimatedTokens?: number;
}

export interface AttemptRecord { candidate: string; outcome: 'success' | 'retry' | 'rate_limited' | 'quota_exhausted' | 'failure' | 'invalid_output'; code?: string }

export interface RoutedResult extends ModelResult { candidate: string; providerId: string; cost: CandidateCost; attempts: AttemptRecord[] }

export interface RouteOptions<T = unknown> {
  requires?: RouteRequirements;
  /** Called before each upstream call; the returned token is passed back to onSettled. */
  onAttempt?: (candidate: RouteCandidate, attempt: number) => Promise<T> | T;
  onSettled?: (token: T, candidate: RouteCandidate, outcome: { ok: true; result: ModelResult; valid: boolean } | { ok: false; error: unknown }) => Promise<void> | void;
  /** For structured output: a free candidate returning unusable text is replaced by the next free one. */
  validate?: (text: string) => boolean;
}

type FailureClass = 'abort' | 'fatal' | 'rate' | 'quota' | 'transient' | 'candidate' | 'unknown';

const CANDIDATE_CODES = new Set(['AUTHENTICATION_FAILED', 'PERMISSION_DENIED', 'MODEL_UNAVAILABLE', 'CAPABILITY_UNAVAILABLE', 'NOT_CONFIGURED', 'GATEWAY_UNREACHABLE']);
const UNKNOWN_CODES = new Set(['ABORTED', 'NETWORK_ERROR', 'INVALID_RESPONSE', 'INCOMPLETE_RESPONSE', 'MODEL_MISMATCH', 'RESPONSE_TOO_LARGE', 'STREAM_STALLED', 'STREAM_INTERRUPTED']);
const zeroUsage = (error: ProviderError) => error.usage?.inputTokens === 0 && error.usage?.outputTokens === 0;

function classify(error: unknown, signal?: AbortSignal): FailureClass {
  if (signal?.aborted) return 'abort';
  if (!(error instanceof ProviderError)) return 'fatal';
  if (error.code === 'RATE_LIMITED' && error.httpStatus === 429) return 'rate';
  if (error.code === 'QUOTA_EXHAUSTED') return 'quota';
  if (error.code === 'UPSTREAM_ERROR' && error.httpStatus !== undefined && [502, 503, 504].includes(error.httpStatus) && zeroUsage(error)) return 'transient';
  if (CANDIDATE_CODES.has(error.code)) return 'candidate';
  // A schema rejection carries the model's text; the caller may recover it without another call.
  if (error.code === 'REQUEST_REJECTED') return error.failedGeneration ? 'fatal' : 'candidate';
  if (UNKNOWN_CODES.has(error.code) || error.code === 'UPSTREAM_ERROR') return 'unknown';
  return 'fatal';
}

const CANDIDATE_COOLDOWN_MS: Record<string, number> = {
  GATEWAY_UNREACHABLE: 30_000, CAPABILITY_UNAVAILABLE: 60_000, MODEL_UNAVAILABLE: 300_000,
  NOT_CONFIGURED: 300_000, AUTHENTICATION_FAILED: 600_000, PERMISSION_DENIED: 600_000,
};

/**
 * Picks an eligible candidate, honours known cool-downs, retries confirmed transient
 * rejections with bounded exponential backoff, and moves to the next compatible candidate
 * when one is rate-limited, out of quota or unusable. Every loop is bounded by maxAttempts.
 */
export class InferenceRouter {
  private readonly maxAttempts: number;
  private readonly maxTransientRetries: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;

  constructor(
    private readonly candidates: readonly RouteCandidate[],
    private readonly policy: RouterPolicy,
    private readonly monitor: UsageMonitor = new UsageMonitor(),
    private readonly deps: { inflight?: Map<string, Promise<RoutedResult>>; random?: () => number; now?: () => number } = {},
  ) {
    const keys = new Set<string>();
    for (const candidate of candidates) {
      if (keys.has(candidate.key)) throw new ProviderError('NOT_CONFIGURED', `مرشح النموذج مكرر: ${candidate.key}`);
      keys.add(candidate.key);
    }
    this.maxAttempts = Math.min(Math.max(policy.maxAttempts ?? 4, 1), 8);
    this.maxTransientRetries = Math.min(Math.max(policy.maxTransientRetries ?? 2, 0), 4);
    this.baseBackoffMs = Math.min(Math.max(policy.baseBackoffMs ?? 500, 0), 10_000);
    this.maxBackoffMs = Math.min(Math.max(policy.maxBackoffMs ?? 8000, this.baseBackoffMs), MAX_AUTOMATIC_RETRY_DELAY_MS);
  }

  private now() { return this.deps.now?.() ?? Date.now(); }

  /** Filtering out a free candidate must not turn its paid fallback into a primary. */
  private isPaidFallback(candidate: RouteCandidate) {
    return candidate.cost === 'paid' && this.candidates.slice(0, this.candidates.indexOf(candidate)).some(entry => entry.cost === 'free');
  }

  /** Why each candidate can or cannot serve this request, in priority order. */
  eligibility(request: ModelRequest, requires: RouteRequirements = {}): { candidate: RouteCandidate; eligible: boolean; reason?: string }[] {
    return this.candidates.map(candidate => {
      const capabilities = candidate.capabilities ?? {};
      if (this.policy.freeOnly && candidate.cost !== 'free') return { candidate, eligible: false, reason: 'free_only' };
      if (request.structured && capabilities.structured === false) return { candidate, eligible: false, reason: 'no_structured_output' };
      if (request.image && capabilities.vision === false) return { candidate, eligible: false, reason: 'no_vision' };
      if (requires.tools && capabilities.tools !== true) return { candidate, eligible: false, reason: 'no_tools' };
      if (this.monitor.blockedUntil(candidate.key) > this.now()) return { candidate, eligible: false, reason: 'cooling_down' };
      const window = requires.estimatedTokens ? this.monitor.tokenWindow(candidate.providerId, candidate.model) : null;
      if (window && window.remaining < requires.estimatedTokens!) return { candidate, eligible: false, reason: 'token_window' };
      return { candidate, eligible: true };
    });
  }

  generate<T>(request: ModelRequest, options: RouteOptions<T> = {}): Promise<RoutedResult> {
    const key = request.idempotencyKey;
    const inflight = this.deps.inflight;
    if (key && inflight) {
      const existing = inflight.get(key);
      if (existing) return existing;
      const run = this.run(request, options).finally(() => { if (inflight.get(key) === run) inflight.delete(key); });
      inflight.set(key, run);
      return run;
    }
    return this.run(request, options);
  }

  private noneLeft(reasons: string[], last?: unknown): ProviderError {
    const unique = [...new Set(reasons)].slice(0, 8);
    const error = new ProviderError('NO_ELIGIBLE_PROVIDER', `لا يوجد مزود نموذج مؤهل متبقٍ لهذا الطلب${unique.length ? ` (${unique.join('، ')})` : ''}.`,
      last instanceof ProviderError && ['RATE_LIMITED', 'QUOTA_EXHAUSTED', 'GATEWAY_UNREACHABLE'].includes(last.code));
    if (last instanceof ProviderError) {
      if (last.retryAfterMs !== undefined) error.retryAfterMs = last.retryAfterMs;
      error.cause = last;
    }
    return error;
  }

  private backoff(retry: number, retryAfterMs: number | undefined): number | null {
    const exponential = Math.min(this.maxBackoffMs, this.baseBackoffMs * 2 ** retry);
    const jittered = Math.round(exponential * (0.5 + (this.deps.random?.() ?? Math.random()) / 2));
    const wait = Math.max(jittered, retryAfterMs ?? 0);
    // A provider delay longer than the budget is never shortened; the caller moves on instead.
    return wait > this.maxBackoffMs && (retryAfterMs ?? 0) > this.maxBackoffMs ? null : wait;
  }

  private async run<T>(request: ModelRequest, options: RouteOptions<T>): Promise<RoutedResult> {
    const signal = request.signal;
    signal?.throwIfAborted();
    const table = this.eligibility(request, options.requires);
    const queue = table.filter(row => row.eligible).map(row => row.candidate);
    const reasons = table.filter(row => !row.eligible).map(row => `${row.candidate.key}: ${row.reason}`);
    if (!queue.length) throw this.noneLeft(reasons);
    const attempts: AttemptRecord[] = [];
    let last: unknown;
    let attempt = 0;
    let previous: RouteCandidate | null = null;

    for (let index = 0; index < queue.length && attempt < this.maxAttempts; index++) {
      const candidate = queue[index]!;
      if (previous && !this.policy.automaticFallback) { reasons.push(`${candidate.key}: fallback_disabled`); break; }
      if (this.isPaidFallback(candidate) && !this.policy.allowPaidFallback) {
        this.monitor.event({ kind: 'paid_fallback_blocked', provider: candidate.providerId, model: candidate.model });
        reasons.push(`${candidate.key}: paid_fallback_blocked`);
        continue;
      }
      if (previous) {
        this.monitor.event({ kind: 'fallback', provider: previous.providerId, model: previous.model, to: candidate.key, code: last instanceof ProviderError ? last.code : undefined });
      }
      previous = candidate;

      for (let retry = 0; attempt < this.maxAttempts; retry++) {
        signal?.throwIfAborted();
        attempt += 1;
        const token = await options.onAttempt?.(candidate, attempt) as T;
        let result: ModelResult;
        try {
          result = await candidate.provider.generate(request);
        } catch (error) {
          last = error;
          await options.onSettled?.(token, candidate, { ok: false, error });
          const kind = classify(error, signal);
          const provider = error instanceof ProviderError ? error : null;
          if (kind === 'abort') throw error;
          this.monitor.recordFailure(candidate.providerId, candidate.model, provider?.code ?? 'UNEXPECTED', provider?.usage);
          if (kind === 'fatal') throw error;
          const retryAfter = validatedRetryAfterMs(provider?.retryAfterMs);
          if (kind === 'rate' || kind === 'quota') {
            attempts.push({ candidate: candidate.key, outcome: kind === 'rate' ? 'rate_limited' : 'quota_exhausted', code: provider!.code });
            this.monitor.block(candidate.key, retryAfter ?? (kind === 'quota' ? 3_600_000 : 30_000));
            // Last candidate and a short, valid delay: wait once rather than fail.
            const alone = index === queue.length - 1 || !this.policy.automaticFallback;
            if (kind === 'rate' && alone && retry < this.maxTransientRetries && provider!.retryAfterInvalid !== true && (retryAfter ?? 0) <= this.maxBackoffMs) {
              const wait = this.backoff(retry, retryAfter);
              if (wait !== null) {
                this.monitor.event({ kind: 'retry', provider: candidate.providerId, model: candidate.model, code: provider!.code, detail: `${wait}ms` });
                await waitForRetryAfter(wait, signal);
                this.monitor.clearBlock(candidate.key);
                continue;
              }
            }
            reasons.push(`${candidate.key}: ${provider!.code}`);
            break;
          }
          if (kind === 'transient' && retry < this.maxTransientRetries) {
            const wait = this.backoff(retry, retryAfter);
            if (wait !== null) {
              attempts.push({ candidate: candidate.key, outcome: 'retry', code: provider!.code });
              this.monitor.event({ kind: 'retry', provider: candidate.providerId, model: candidate.model, code: provider!.code, detail: `${wait}ms` });
              await waitForRetryAfter(wait, signal);
              continue;
            }
          }
          attempts.push({ candidate: candidate.key, outcome: 'failure', code: provider?.code });
          if (kind === 'candidate') this.monitor.block(candidate.key, CANDIDATE_COOLDOWN_MS[provider!.code] ?? 60_000);
          // An unsettled paid call is never repeated elsewhere: its cost may already be incurred.
          if (kind === 'unknown' && candidate.cost === 'paid') throw error;
          reasons.push(`${candidate.key}: ${provider?.code ?? 'UNEXPECTED'}`);
          break;
        }

        let valid = true;
        try { valid = options.validate ? options.validate(result.text) : true; }
        catch { valid = false; }
        await options.onSettled?.(token, candidate, { ok: true, result, valid });
        if (valid) this.monitor.recordSuccess(candidate.providerId, candidate.model, result.usage, result.usageEstimated === true);
        else this.monitor.recordFailure(candidate.providerId, candidate.model, 'INVALID_RESPONSE', result.usage, result.usageEstimated === true);
        if (result.rate) this.monitor.setQuota({ provider: candidate.providerId, model: candidate.model, metric: 'tokens', remaining: result.rate.remainingTokens, limit: null, resetAt: new Date(this.now() + result.rate.resetMs).toISOString(), source: 'verified', note: 'x-ratelimit-remaining-tokens' });
        if (this.policy.freeOnly && result.routing?.platform === 'custom') {
          this.monitor.event({ kind: 'non_free_route', provider: candidate.providerId, model: result.model, detail: `routed via ${result.routing.routedVia}` });
        }
        if (!valid) {
          attempts.push({ candidate: candidate.key, outcome: 'invalid_output' });
          reasons.push(`${candidate.key}: invalid_output`);
          const invalid = new ProviderError('INVALID_RESPONSE', 'أعاد النموذج ردًا لا يطابق البنية المطلوبة.');
          if (!result.usageEstimated) invalid.usage = result.usage;
          last = invalid;
          if (candidate.cost === 'free' && this.policy.automaticFallback && index < queue.length - 1 && attempt < this.maxAttempts) break;
          // A terminal invalid response is a failed decision, even if its HTTP call
          // completed. Never return it as a successful action to another caller.
          throw invalid;
        }
        attempts.push({ candidate: candidate.key, outcome: 'success' });
        return { ...result, candidate: candidate.key, providerId: candidate.providerId, cost: candidate.cost, attempts };
      }
    }
    throw this.noneLeft(reasons, last);
  }

  /**
   * Streams from the first candidate that starts producing output. Failover happens only
   * before the first delta, so a consumer never receives text from two different models.
   */
  async *stream(request: ModelRequest, options: Pick<RouteOptions, 'requires'> = {}): AsyncGenerator<StreamEvent & { candidate?: string }, void, void> {
    const signal = request.signal;
    const table = this.eligibility(request, options.requires);
    const queue = table.filter(row => row.eligible).map(row => row.candidate);
    const reasons = table.filter(row => !row.eligible).map(row => `${row.candidate.key}: ${row.reason}`);
    let last: unknown;
    let previous: RouteCandidate | null = null;
    let attempt = 0;
    for (const candidate of queue) {
      if (attempt >= this.maxAttempts) break;
      if (previous && !this.policy.automaticFallback) { reasons.push(`${candidate.key}: fallback_disabled`); break; }
      if (this.isPaidFallback(candidate) && !this.policy.allowPaidFallback) {
        this.monitor.event({ kind: 'paid_fallback_blocked', provider: candidate.providerId, model: candidate.model });
        reasons.push(`${candidate.key}: paid_fallback_blocked`);
        continue;
      }
      previous = candidate;
      attempt += 1;
      let started = false;
      try {
        if (candidate.provider.stream) {
          for await (const event of candidate.provider.stream(request)) {
            if (event.type === 'delta') started = true;
            if (event.type === 'done') this.monitor.recordSuccess(candidate.providerId, candidate.model, event.result.usage, event.result.usageEstimated === true);
            yield { ...event, candidate: candidate.key };
          }
        } else {
          const result = await candidate.provider.generate(request);
          started = true;
          this.monitor.recordSuccess(candidate.providerId, candidate.model, result.usage, result.usageEstimated === true);
          yield { type: 'delta', text: result.text, candidate: candidate.key };
          yield { type: 'done', result, candidate: candidate.key };
        }
        return;
      } catch (error) {
        last = error;
        const kind = classify(error, signal);
        const provider = error instanceof ProviderError ? error : null;
        if (kind === 'abort') throw error;
        this.monitor.recordFailure(candidate.providerId, candidate.model, provider?.code ?? 'UNEXPECTED', provider?.usage);
        if (started || kind === 'fatal' || (kind === 'unknown' && candidate.cost === 'paid')) throw error;
        if (kind === 'rate' || kind === 'quota') this.monitor.block(candidate.key, validatedRetryAfterMs(provider?.retryAfterMs) ?? (kind === 'quota' ? 3_600_000 : 30_000));
        if (kind === 'candidate') this.monitor.block(candidate.key, CANDIDATE_COOLDOWN_MS[provider!.code] ?? 60_000);
        reasons.push(`${candidate.key}: ${provider?.code ?? 'UNEXPECTED'}`);
      }
    }
    throw this.noneLeft(reasons, last);
  }
}
