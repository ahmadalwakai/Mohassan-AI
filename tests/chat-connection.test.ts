import { describe, expect, it } from 'vitest';
import {
  ChatHttpError, MAX_POLL_BACKOFF_MS, POLL_INTERVAL_MS,
  chatErrorMessage, isSessionExpired, pollBackoffMs,
} from '../apps/web/components/chat-connection';

describe('Arabic chat connection errors', () => {
  // Status meanings (retrieved 2026-11-27).
  // https://www.rfc-editor.org/rfc/rfc9110.html#section-15
  // https://www.rfc-editor.org/rfc/rfc6585.html#section-4
  it.each([
    [401, 'انتهت جلسة تسجيل الدخول. سجّل الدخول مجددًا للمتابعة.'],
    [403, 'ليست لديك صلاحية لتنفيذ هذا الطلب.'],
    [408, 'انتهت مهلة الاتصال. حاول مجددًا.'],
    [429, 'طلبات كثيرة متتابعة. انتظر قليلًا ثم حاول مجددًا.'],
    [500, 'الخدمة غير متاحة مؤقتًا. حاول مجددًا بعد قليل.'],
    [503, 'الخدمة غير متاحة مؤقتًا. حاول مجددًا بعد قليل.'],
    [504, 'انتهت مهلة الاتصال. حاول مجددًا.'],
  ])('localizes HTTP %i with an unlocalized server message', (status, message) => {
    const error = new ChatHttpError(status, 'Server error details');
    expect(error.status).toBe(status);
    expect(chatErrorMessage(error)).toBe(message);
  });

  it('asks for sign-in only after HTTP 401', () => {
    expect(isSessionExpired(new ChatHttpError(401))).toBe(true);
    expect(isSessionExpired(new ChatHttpError(403))).toBe(false);
    expect(isSessionExpired(new ChatHttpError(503))).toBe(false);
    expect(isSessionExpired(new TypeError('Failed to fetch'))).toBe(false);
  });

  it.each(['Failed to fetch', 'Load failed'])('localizes a rejected fetch (%s)', (rawMessage) => {
    const error = new TypeError(rawMessage);
    expect(chatErrorMessage(error)).toBe('تعذر الاتصال بالخدمة. تحقق من اتصالك بالإنترنت وحاول مجددًا.');
    expect(chatErrorMessage(error, true)).toBe('تعذّر إتمام الطلب بسبب انقطاع الاتصال. أعد المحاولة.');
  });

  it('localizes a browser timeout', () => {
    const error = new DOMException('The operation timed out', 'TimeoutError');
    expect(chatErrorMessage(error)).toBe('انتهت مهلة الاتصال. حاول مجددًا.');
  });

  it('keeps actionable Arabic details for forbidden requests and exhausted member quotas', () => {
    const forbidden = 'هذه الخدمة غير متاحة لحسابك.';
    const quota = 'وصلت إلى حد الطلبات اليومي. حاول لاحقًا.';
    expect(chatErrorMessage(new ChatHttpError(403, forbidden))).toBe(forbidden);
    expect(chatErrorMessage(new ChatHttpError(429, quota, 'MEMBER_DAILY_LIMIT'))).toBe(quota);
    expect(chatErrorMessage(new ChatHttpError(429, quota))).not.toBe(quota);
  });

  it('falls back to Arabic for unrecognized errors and retains Arabic validation messages', () => {
    const validation = 'تحقق من الحقول المطلوبة وطول المدخلات.';
    expect(chatErrorMessage(new Error('Unexpected failure'))).toBe('تعذر إتمام الطلب. حاول مجددًا.');
    expect(chatErrorMessage(new ChatHttpError(400, validation))).toBe(validation);
    expect(chatErrorMessage(new Error(validation))).toBe(validation);
  });
});

describe('chat poll backoff', () => {
  // Equal jitter starts halfway through the exponential window (retrieved 2026-11-27).
  // https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
  it('doubles the retry delay while jitter spreads polls across the window', () => {
    expect(pollBackoffMs(1, 0)).toBe(POLL_INTERVAL_MS);
    expect(pollBackoffMs(2, 0)).toBe(2 * POLL_INTERVAL_MS);
    expect(pollBackoffMs(3, 0)).toBe(4 * POLL_INTERVAL_MS);
    expect(pollBackoffMs(3, 0.5)).toBe(6 * POLL_INTERVAL_MS);
    expect(pollBackoffMs(3, 1)).toBe(8 * POLL_INTERVAL_MS);
  });

  it('caps the exponential window and keeps retry jitter at the cap', () => {
    const firstCappedFailure = Math.ceil(Math.log2(MAX_POLL_BACKOFF_MS / POLL_INTERVAL_MS));
    expect(pollBackoffMs(firstCappedFailure - 1, 1)).toBeLessThan(MAX_POLL_BACKOFF_MS);
    expect(pollBackoffMs(firstCappedFailure, 1)).toBe(MAX_POLL_BACKOFF_MS);
    expect(pollBackoffMs(firstCappedFailure + 1, 0)).toBe(MAX_POLL_BACKOFF_MS / 2);
    expect(pollBackoffMs(Number.MAX_SAFE_INTEGER, 1)).toBe(MAX_POLL_BACKOFF_MS);
  });
});
