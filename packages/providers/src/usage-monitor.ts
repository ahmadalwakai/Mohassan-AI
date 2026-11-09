/**
 * In-process inference telemetry. Every structure is bounded so a long-running server
 * cannot grow memory without limit. Numbers here are observations of this process since
 * it started; durable history lives in the callers' receipts.
 */

export type InferenceEventKind = 'success' | 'rate_limited' | 'quota_exhausted' | 'failure' | 'fallback' | 'paid_fallback_blocked' | 'non_free_route' | 'retry';

export interface InferenceEvent {
  at: string;
  kind: InferenceEventKind;
  provider: string;
  model: string;
  code?: string;
  /** For fallbacks: the candidate the router moved to. */
  to?: string;
  detail?: string;
}

/**
 * `verified` comes straight from a provider or gateway response (rate-limit headers,
 * the gateway's usage ledger). `estimated` is computed locally and may be wrong.
 */
export interface KnownQuota {
  provider: string;
  model: string | null;
  metric: 'tokens' | 'requests';
  remaining: number | null;
  limit: number | null;
  resetAt: string | null;
  source: 'verified' | 'estimated';
  observedAt: string;
  note: string;
}

export interface ModelCounters {
  provider: string;
  model: string;
  day: string;
  requests: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  estimatedTokens: number;
  /** null when no price is configured for a paid model. */
  estimatedCostUsd: number | null;
}

export interface UsageSnapshot {
  since: string;
  active: { provider: string; model: string; at: string } | null;
  requestsLastMinute: number;
  today: ModelCounters[];
  totals: { inputTokens: number; outputTokens: number; totalTokens: number; requests: number; failures: number; estimatedCostUsd: number | null };
  quotas: KnownQuota[];
  events: InferenceEvent[];
}

export interface PriceTable { [provider: string]: { inputPerMTok: number; outputPerMTok: number } | undefined }

const MAX_EVENTS = 200;
const MAX_RECENT = 2000;
const MAX_COUNTER_KEYS = 500;
const MAX_QUOTAS = 100;

const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);

export class UsageMonitor {
  private readonly started: string;
  private readonly events: InferenceEvent[] = [];
  private readonly recent: number[] = [];
  private readonly counters = new Map<string, ModelCounters>();
  private readonly quotas = new Map<string, KnownQuota>();
  private readonly blocks = new Map<string, number>();
  private active: UsageSnapshot['active'] = null;

  constructor(private readonly options: { prices?: PriceTable; freeProviders?: string[]; now?: () => number } = {}) {
    this.started = new Date(this.now()).toISOString();
  }

  private now() { return this.options.now?.() ?? Date.now(); }

  private counter(provider: string, model: string): ModelCounters {
    const day = utcDay(this.now());
    const key = `${day}\u0000${provider}\u0000${model}`;
    let entry = this.counters.get(key);
    if (!entry) {
      // Drop other days first, then the oldest keys, so the map stays bounded.
      for (const [existing, value] of this.counters) if (value.day !== day) this.counters.delete(existing);
      while (this.counters.size >= MAX_COUNTER_KEYS) this.counters.delete(this.counters.keys().next().value!);
      entry = { provider, model, day, requests: 0, failures: 0, inputTokens: 0, outputTokens: 0, estimatedTokens: 0, estimatedCostUsd: this.isFree(provider) ? 0 : this.options.prices?.[provider] ? 0 : null };
      this.counters.set(key, entry);
    }
    return entry;
  }

  isFree(provider: string) { return (this.options.freeProviders ?? []).includes(provider); }

  private tick() {
    const now = this.now();
    this.recent.push(now);
    while (this.recent.length && (this.recent[0]! < now - 60000 || this.recent.length > MAX_RECENT)) this.recent.shift();
  }

  event(event: Omit<InferenceEvent, 'at'>) {
    this.events.push({ ...event, at: new Date(this.now()).toISOString(), ...(event.detail ? { detail: event.detail.slice(0, 300) } : {}) });
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
  }

  recordSuccess(provider: string, model: string, usage: { inputTokens: number; outputTokens: number }, estimated = false) {
    this.tick();
    const entry = this.counter(provider, model);
    entry.requests += 1;
    entry.inputTokens += usage.inputTokens;
    entry.outputTokens += usage.outputTokens;
    if (estimated) entry.estimatedTokens += usage.inputTokens + usage.outputTokens;
    const price = this.options.prices?.[provider];
    if (price && entry.estimatedCostUsd !== null) entry.estimatedCostUsd += (usage.inputTokens * price.inputPerMTok + usage.outputTokens * price.outputPerMTok) / 1_000_000;
    this.active = { provider, model, at: new Date(this.now()).toISOString() };
    this.event({ kind: 'success', provider, model });
  }

  recordFailure(provider: string, model: string, code: string, usage?: { inputTokens: number; outputTokens: number }, estimated = false) {
    this.tick();
    const entry = this.counter(provider, model);
    entry.requests += 1;
    entry.failures += 1;
    if (usage) {
      entry.inputTokens += usage.inputTokens; entry.outputTokens += usage.outputTokens;
      if (estimated) entry.estimatedTokens += usage.inputTokens + usage.outputTokens;
      const price = this.options.prices?.[provider];
      if (price && entry.estimatedCostUsd !== null) entry.estimatedCostUsd += (usage.inputTokens * price.inputPerMTok + usage.outputTokens * price.outputPerMTok) / 1_000_000;
    }
    const kind: InferenceEventKind = code === 'RATE_LIMITED' ? 'rate_limited' : code === 'QUOTA_EXHAUSTED' ? 'quota_exhausted' : 'failure';
    this.event({ kind, provider, model, code });
  }

  setQuota(quota: Omit<KnownQuota, 'observedAt'>) {
    const key = `${quota.provider}\u0000${quota.model ?? ''}\u0000${quota.metric}`;
    this.quotas.delete(key);
    this.quotas.set(key, { ...quota, observedAt: new Date(this.now()).toISOString() });
    while (this.quotas.size > MAX_QUOTAS) this.quotas.delete(this.quotas.keys().next().value!);
  }

  /** A verified token window that is still open, or null when none is known. */
  tokenWindow(provider: string, model: string): { remaining: number; resetAt: number } | null {
    const quota = this.quotas.get(`${provider}\u0000${model}\u0000tokens`);
    if (!quota || quota.source !== 'verified' || quota.remaining === null || !quota.resetAt) return null;
    const resetAt = Date.parse(quota.resetAt);
    return Number.isFinite(resetAt) && resetAt > this.now() ? { remaining: quota.remaining, resetAt } : null;
  }

  /** Cool-down for a candidate after a rate limit, quota or health failure. */
  block(key: string, milliseconds: number) {
    const until = this.now() + Math.max(0, Math.min(milliseconds, 86_400_000));
    this.blocks.set(key, Math.max(until, this.blocks.get(key) ?? 0));
    if (this.blocks.size > MAX_COUNTER_KEYS) for (const [entry, value] of this.blocks) if (value <= this.now()) this.blocks.delete(entry);
  }

  blockedUntil(key: string): number {
    const until = this.blocks.get(key) ?? 0;
    if (until && until <= this.now()) { this.blocks.delete(key); return 0; }
    return until;
  }

  clearBlock(key: string) { this.blocks.delete(key); }

  snapshot(): UsageSnapshot {
    const day = utcDay(this.now());
    const today = [...this.counters.values()].filter(entry => entry.day === day).map(entry => ({ ...entry }));
    const known = today.map(entry => entry.estimatedCostUsd);
    const now = this.now();
    return {
      since: this.started,
      active: this.active,
      requestsLastMinute: this.recent.filter(at => at >= now - 60000).length,
      today,
      totals: {
        inputTokens: today.reduce((sum, entry) => sum + entry.inputTokens, 0),
        outputTokens: today.reduce((sum, entry) => sum + entry.outputTokens, 0),
        totalTokens: today.reduce((sum, entry) => sum + entry.inputTokens + entry.outputTokens, 0),
        requests: today.reduce((sum, entry) => sum + entry.requests, 0),
        failures: today.reduce((sum, entry) => sum + entry.failures, 0),
        // Any paid model without a configured price makes the total unknown, not zero.
        estimatedCostUsd: known.some(value => value === null) ? null : Math.round(known.reduce<number>((sum, value) => sum + (value ?? 0), 0) * 1e6) / 1e6,
      },
      quotas: [...this.quotas.values()],
      events: this.events.slice(-50).reverse(),
    };
  }
}
