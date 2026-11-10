import type { CampaignFailureCategory, CampaignRecoveryStrategy } from '@mohassan/contracts';
import { MAX_AUTOMATIC_RETRY_DELAY_MS, waitForRetryAfter } from '@mohassan/providers';

/**
 * Adaptive recovery. A failure is first named, then the name picks the strategy.
 * Only a transient failure of a step that changes nothing outside is ever repeated,
 * within a fixed number of attempts and never sooner than the provider asked.
 * Sign-in, permission, policy and validation failures are reported, not retried.
 */
export interface ClassifiedFailure {
  category: CampaignFailureCategory;
  code: string;
  /** Safe to show: the module's own message, never a provider's raw text. */
  message: string;
  /** True only when repeating the same request can succeed without anyone acting. */
  retryable: boolean;
  retryAfterMs: number | null;
  strategy: CampaignRecoveryStrategy;
}

type Rule = readonly [CampaignFailureCategory, CampaignRecoveryStrategy, boolean];
const RULES: Readonly<Record<string, Rule>> = Object.freeze({
  GOOGLE_ADS_UNAUTHORIZED: ['authentication', 'reauthenticate', false], GOOGLE_ADS_DISCONNECTED: ['authentication', 'reauthenticate', false], GOOGLE_ADS_OAUTH_FAILED: ['authentication', 'reauthenticate', false], ADS_CONNECT_REQUIRED: ['authentication', 'reauthenticate', false],
  GOOGLE_ADS_NOT_CONFIGURED: ['permissions', 'stop_and_report', false], GOOGLE_ADS_PERMISSION_DENIED: ['permissions', 'stop_and_report', false], GOOGLE_ADS_FORBIDDEN: ['permissions', 'stop_and_report', false], GOOGLE_ADS_ACCESS_LEVEL: ['permissions', 'stop_and_report', false],
  GOOGLE_ADS_ACCOUNT_DISABLED: ['permissions', 'stop_and_report', false], GOOGLE_ADS_PUBLISHING_CLOSED: ['permissions', 'stop_and_report', false], GOOGLE_ADS_APPROVAL_REQUIRED: ['permissions', 'ask_owner', false], GOOGLE_ADS_APPROVAL_MISMATCH: ['permissions', 'ask_owner', false],
  GOOGLE_ADS_AUTHORITY_REQUIRED: ['permissions', 'stop_and_report', false], ADS_CREATION_NOT_REQUESTED: ['permissions', 'ask_owner', false],
  GOOGLE_ADS_RATE_LIMITED: ['quota', 'wait_retry_after', true], GOOGLE_ADS_DAILY_QUOTA: ['quota', 'stop_and_report', false],
  GOOGLE_ADS_UNAVAILABLE: ['network', 'retry_with_backoff', true],
  GOOGLE_ADS_OUTCOME_UNKNOWN: ['verification', 'reconcile_by_readback', false], GOOGLE_ADS_READBACK_AMBIGUOUS: ['verification', 'reconcile_by_readback', false], GOOGLE_ADS_PAUSED_UNCONFIRMED: ['verification', 'reconcile_by_readback', false],
  GOOGLE_ADS_QUALITY_REJECTED: ['verification', 'correct_and_revalidate', false], GOOGLE_ADS_VERIFICATION_REJECTED: ['verification', 'stop_and_report', false], GOOGLE_ADS_REJECTED: ['policy', 'stop_and_report', false],
  GOOGLE_ADS_IDEMPOTENCY: ['verification', 'stop_and_report', false], GOOGLE_ADS_STATE: ['verification', 'stop_and_report', false], GOOGLE_ADS_DRAFT_MISSING: ['verification', 'stop_and_report', false],
  ASSISTANT_INPUT: ['schema', 'correct_and_revalidate', false],
  RATE_LIMITED: ['quota', 'wait_retry_after', true], QUOTA_EXHAUSTED: ['quota', 'stop_and_report', false],
  UPSTREAM_ERROR: ['provider', 'retry_with_backoff', true], NO_ELIGIBLE_PROVIDER: ['provider', 'stop_and_report', false], ASSISTANT_MODEL_BUSY: ['provider', 'stop_and_report', false],
  NETWORK_ERROR: ['network', 'retry_with_backoff', true], ABORTED: ['network', 'stop_and_report', false],
  INVALID_RESPONSE: ['model_output', 'correct_and_revalidate', false], INCOMPLETE_RESPONSE: ['model_output', 'correct_and_revalidate', false], MODEL_MISMATCH: ['model_output', 'stop_and_report', false], CHAT_MODEL_INVALID: ['model_output', 'stop_and_report', false],
});

const validDelay = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.ceil(value) : null;

export function classifyFailure(error: unknown): ClassifiedFailure {
  const failure = (error ?? {}) as { name?: unknown; code?: unknown; message?: unknown; statusCode?: unknown; httpStatus?: unknown; retryable?: unknown; retryAfterMs?: unknown; options?: { retryAfterSeconds?: unknown } };
  const code = typeof failure.code === 'string' && /^[A-Z][A-Z0-9_]{1,59}$/.test(failure.code) ? failure.code : null;
  const status = [failure.statusCode, failure.httpStatus].find((value): value is number => typeof value === 'number') ?? 0;
  const seconds = validDelay(failure.options?.retryAfterSeconds);
  const retryAfterMs = validDelay(failure.retryAfterMs) ?? (seconds === null ? null : seconds * 1000);
  // Only a typed module error carries a message written for the owner.
  const message = code && typeof failure.message === 'string' ? failure.message.slice(0, 600) : 'حدث خطأ غير متوقع أثناء العمل.';
  const make = ([category, strategy, retryable]: Rule, name: string): ClassifiedFailure => {
    // A provider error says for itself whether it may be repeated; the table cannot overrule a "no".
    const allowed = retryable && failure.retryable !== false;
    // A wait longer than the automatic budget is the owner's decision, not a silent sleep.
    const tooLong = retryAfterMs !== null && retryAfterMs > MAX_AUTOMATIC_RETRY_DELAY_MS;
    return { category, code: name, message, retryable: allowed && !tooLong, retryAfterMs, strategy: allowed && tooLong ? 'stop_and_report' : allowed || !retryable ? strategy : 'stop_and_report' };
  };
  if (code && RULES[code]) return make(RULES[code], code);
  if (failure.name === 'ZodError') return make(['schema', 'correct_and_revalidate', false], 'SCHEMA_INVALID');
  if (failure.name === 'TimeoutError' || failure.name === 'AbortError') return make(['network', 'stop_and_report', false], 'TIMEOUT');
  if (status === 401) return make(['authentication', 'reauthenticate', false], code ?? 'UNAUTHENTICATED');
  if (status === 403) return make(['permissions', 'stop_and_report', false], code ?? 'FORBIDDEN');
  if (status === 429) return make(['quota', 'wait_retry_after', true], code ?? 'RATE_LIMITED');
  if (status >= 500) return make(['network', 'retry_with_backoff', true], code ?? 'UNAVAILABLE');
  return make(['unknown', 'stop_and_report', false], code ?? 'UNEXPECTED');
}

/** What the owner can do next, by category. Fixed text: nothing from a provider or a model reaches it. */
export const FAILURE_ACTIONS: Readonly<Record<CampaignFailureCategory, string>> = Object.freeze({
  schema: 'أكمل الحقول الناقصة أو صحّحها ثم أعد الطلب.',
  character_limit: 'اختصر النص المذكور إلى الحد المسموح ثم أعد الفحص.',
  factual_claim: 'احذف الادعاء، أو أكّد أنه صحيح بكتابته في طلبك أو في صفحة الهبوط.',
  landing_page: 'تأكد أن صفحة الهبوط تعمل على HTTPS وبلغة الإعلان ثم أعد الطلب.',
  provider: 'النموذج غير متاح الآن. أرسل «تابع» بعد قليل.',
  model_output: 'أعاد النموذج ردًا غير صالح. أرسل «تابع» للمحاولة من جديد.',
  authentication: 'سجّل الدخول إلى Google من جديد ثم أكمل.',
  permissions: 'هذه الخطوة تحتاج صلاحية أو بوابة غير مفتوحة. راجع قسم Google Ads في الأدوات المتقدمة.',
  quota: 'بلغنا حد الطلبات. انتظر المدة المذكورة ثم أعد الطلب.',
  network: 'تعذر الاتصال. تحقق من الشبكة ثم أرسل «تابع».',
  verification: 'راجع حالة الحملة في قسم Google Ads قبل أي طلب جديد.',
  policy: 'رفضت Google هذا النص أو الإعداد. عدّله وفق السبب المذكور ثم أعد الطلب.',
  unknown: 'أرسل «تابع»، وإن تكرر الخطأ راجع قسم Google Ads.',
});

export interface RecoveryOptions {
  signal: AbortSignal;
  /** Total calls, the first one included. */
  maxAttempts?: number;
  baseMs?: number;
  capMs?: number;
  random?: () => number;
  /** Rejects when the signal aborts, and releases its timer either way. */
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  /** A further veto, for example when the step has already written something outside. */
  mayRetry?: (failure: ClassifiedFailure, attempt: number) => boolean;
  onRetry?: (failure: ClassifiedFailure, attempt: number, delayMs: number) => Promise<void> | void;
}

export const DEFAULT_RECOVERY_ATTEMPTS = 3;

/** Exponential backoff with jitter. A provider's Retry-After is honored in full and never shortened. */
export function backoffDelay(attempt: number, failure: Pick<ClassifiedFailure, 'retryAfterMs'>, options: Pick<RecoveryOptions, 'baseMs' | 'capMs' | 'random'> = {}): number {
  const jittered = Math.min(options.capMs ?? 8000, (options.baseMs ?? 500) * 2 ** (attempt - 1)) * (0.5 + (options.random ?? Math.random)() / 2);
  return Math.ceil(Math.max(jittered, failure.retryAfterMs ?? 0));
}

/**
 * Runs `operation`, repeating it only for failures classified as transient. The
 * caller must pass an operation that is safe to repeat; anything that writes
 * outside must be guarded by `mayRetry` or not routed through here at all.
 */
export async function withRecovery<T>(operation: (attempt: number) => Promise<T>, options: RecoveryOptions): Promise<T> {
  const maxAttempts = Math.max(1, Math.min(options.maxAttempts ?? DEFAULT_RECOVERY_ATTEMPTS, 6));
  const sleep = options.sleep ?? waitForRetryAfter;
  for (let attempt = 1; ; attempt += 1) {
    options.signal.throwIfAborted();
    try { return await operation(attempt); } catch (error) {
      options.signal.throwIfAborted();
      const failure = classifyFailure(error);
      if (!failure.retryable || attempt >= maxAttempts || options.mayRetry?.(failure, attempt) === false) throw error;
      const delay = backoffDelay(attempt, failure, options);
      if (delay > MAX_AUTOMATIC_RETRY_DELAY_MS) throw error;
      await options.onRetry?.(failure, attempt, delay);
      await sleep(delay, options.signal);
    }
  }
}
