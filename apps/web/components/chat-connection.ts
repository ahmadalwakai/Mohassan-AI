// Foreground cadence and the hidden-tab cadence used to set the retry cap (retrieved 2026-11-27).
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/apps/web/components/assistant-app.tsx#L43-L48
export const POLL_INTERVAL_MS = 450;
export const MAX_POLL_BACKOFF_MS = 2 * 15_000;

export const OFFLINE_MESSAGE = "أنت غير متصل بالإنترنت. ستُستأنف المحادثة عند عودة الاتصال.";
export const OFFLINE_REQUEST_MESSAGE = "تعذّر إتمام الطلب بسبب انقطاع الاتصال. أعد المحاولة.";
const requestFailed = "تعذر إتمام الطلب. حاول مجددًا.";
const timedOut = "انتهت مهلة الاتصال. حاول مجددًا.";

export class ChatHttpError extends Error {
  constructor(readonly status: number, serverMessage?: unknown, readonly code?: unknown) {
    super(typeof serverMessage === "string" ? serverMessage : "");
  }
}

export function isSessionExpired(error: unknown): boolean {
  return error instanceof ChatHttpError && error.status === 401;
}

function arabicDetail(message: unknown): string | undefined {
  return typeof message === "string" && /\p{Script=Arabic}/u.test(message) ? message : undefined;
}

export function chatHttpErrorMessage(status: number, details?: { message?: unknown; code?: unknown } | null, fallback = requestFailed): string {
  // HTTP status semantics (retrieved 2026-11-27).
  // https://www.rfc-editor.org/rfc/rfc9110.html#section-15
  // https://www.rfc-editor.org/rfc/rfc6585.html#section-4
  if (status === 401) return "انتهت جلسة تسجيل الدخول. سجّل الدخول مجددًا للمتابعة.";
  if (status === 403) return arabicDetail(details?.message) ?? "ليست لديك صلاحية لتنفيذ هذا الطلب.";
  if (status === 408 || status === 504) return timedOut;
  if (status === 429) {
    // Member quota messaging (retrieved 2026-11-27).
    // https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/apps/server/src/member-run-quota.ts#L32-L37
    const quotaMessage = details?.code === "MEMBER_DAILY_LIMIT" ? arabicDetail(details.message) : undefined;
    return quotaMessage ?? "طلبات كثيرة متتابعة. انتظر قليلًا ثم حاول مجددًا.";
  }
  if (status >= 500 && status < 600) return "الخدمة غير متاحة مؤقتًا. حاول مجددًا بعد قليل.";
  return arabicDetail(details?.message) ?? fallback;
}

export function chatErrorMessage(error: unknown, offline = false): string {
  if (error instanceof ChatHttpError) return chatHttpErrorMessage(error.status, error);
  if (offline) return OFFLINE_REQUEST_MESSAGE;
  // Timeout and Fetch network errors (retrieved 2026-11-27).
  // https://dom.spec.whatwg.org/#dom-abortsignal-timeout
  // https://fetch.spec.whatwg.org/#fetch-method
  if (error instanceof Error && error.name === "TimeoutError") return timedOut;
  if (error instanceof TypeError) return "تعذر الاتصال بالخدمة. تحقق من اتصالك بالإنترنت وحاول مجددًا.";
  return error instanceof Error ? arabicDetail(error.message) ?? requestFailed : requestFailed;
}

// Equal jitter, with the retry window doubled after the first failure (retrieved 2026-11-27).
// https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
export function pollBackoffMs(failures: number, random: number): number {
  const windowMs = Math.min(MAX_POLL_BACKOFF_MS, POLL_INTERVAL_MS * 2 ** failures);
  return Math.floor(windowMs * (1 + random) / 2);
}
