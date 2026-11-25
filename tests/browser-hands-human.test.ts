import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  BROWSER_HANDS_SENSITIVE_FIELD_SCRIPT,
  browserHumanStep,
  BrowserHumanStepError,
  detectBrowserHumanStep,
  isBrowserPaymentConfirmation,
  sensitiveBrowserField,
  waitForBrowserHumanProgress,
  type BrowserHumanPage,
} from '../packages/browser/src/browser-hands-human.js';
import { BrowserError } from '../packages/browser/src/network.js';

const site = 'https://example.test';
const page = (rest: Partial<BrowserHumanPage> = {}): BrowserHumanPage => ({
  url: site + '/member',
  title: 'Account',
  text: 'Account overview',
  elements: [],
  signals: { captcha: false, password: false, otp: false, card: false },
  ...rest,
});
const wait = (rest: Partial<Parameters<typeof waitForBrowserHumanProgress<BrowserHumanPage>>[0]> = {}) => waitForBrowserHumanProgress({
  step: browserHumanStep('login', site),
  originalUrl: site + '/member',
  observe: async () => page(),
  intervalMs: 1,
  timeoutMs: 150,
  ...rest,
});

describe('browser human-step signals', () => {
  it('classifies secret field metadata identically on the host and in the browser', () => {
    const browserClassifier = runInNewContext(BROWSER_HANDS_SENSITIVE_FIELD_SCRIPT) as typeof sensitiveBrowserField;
    const cases = [
      [{ type: 'password' }, 'login'],
      [{ type: 'password', autocomplete: 'one-time-code' }, 'code'],
      [{ label: 'One-time password' }, 'code'],
      [{ label: 'رَمْز التحقق' }, 'code'],
      [{ autocomplete: 'section-card cc-csc' }, 'payment'],
      [{ name: 'nationalIdNumber' }, 'identity'],
      [{ label: 'رقم الإقامة' }, 'identity'],
      [{ label: 'رقم البطاقة القومية' }, 'identity'],
      [{ label: 'Postal code' }, null],
      [{ label: 'كود الخصم' }, null],
      [{ name: 'email' }, null],
    ] as const;
    for (const [field, expected] of cases) {
      expect(sensitiveBrowserField(field)).toBe(expected);
      expect(browserClassifier(field)).toBe(expected);
    }
  });

  it('recognizes HTTP authentication failures, explicit sign-in and an identity provider', () => {
    for (const observed of [
      page({ documentStatus: 401 }),
      page({ documentStatus: 403 }),
      page({ text: 'Sign in to continue' }),
      page({ url: 'https://accounts.google.com/signin?continue=private', text: '' }),
      page({ elements: [{ label: '', role: 'textbox', field: 'password' }] }),
    ]) {
      const step = detectBrowserHumanStep(observed);
      expect(step).toMatchObject({ reason: 'login', kind: 'login', site: new URL(observed.url).host });
      expect(step?.prompt).toContain('تسجيل الدخول يدويًا');
      expect(step?.prompt).not.toContain('?');
    }
  });

  it('prefers a specific code, bot check or payment step to an authentication fallback', () => {
    expect(detectBrowserHumanStep(page({ documentStatus: 401, text: 'أدخل رمز التحقق' }))).toMatchObject({ kind: 'code', reason: 'code' });
    expect(detectBrowserHumanStep(page({ documentStatus: 403, title: 'Just a moment…', text: 'Verifying you are human' }))).toMatchObject({ kind: 'hands_on', reason: 'bot_check' });
    expect(detectBrowserHumanStep(page({ text: 'CAPTCHA' }))).toMatchObject({ reason: 'bot_check' });
    expect(detectBrowserHumanStep(page({ url: site + '/checkout', elements: [{ label: 'Pay now', role: 'button' }] }))).toMatchObject({ kind: 'hands_on', reason: 'payment' });
    expect(detectBrowserHumanStep(page({ elements: [{ label: 'Card number', role: 'textbox' }] }))).toMatchObject({ reason: 'payment' });
    expect(isBrowserPaymentConfirmation('ادفع الآن')).toBe(true);
    expect(isBrowserPaymentConfirmation('Pay £12.34')).toBe(true);
  });

  it('keeps ordinary links, national ID forms and promotional codes out of page-wide handovers', () => {
    const ordinary = page({ elements: [
      { label: 'Sign in', role: 'link' },
      { label: 'Checkout', role: 'link' },
      { label: 'Verification code', role: 'link' },
      { label: 'رقم الهوية', role: 'textbox', match: { humanOnly: 'identity' } },
      { label: 'كود الخصم', role: 'textbox', field: 'otp' },
      { label: 'الرمز البريدي', role: 'textbox', field: 'otp' },
    ] });
    expect(detectBrowserHumanStep(ordinary)).toBeNull();
    expect(isBrowserPaymentConfirmation('See payment options')).toBe(false);
    expect(detectBrowserHumanStep(page({
      title: 'Accessibility guide', signals: { ...ordinary.signals, captcha: true },
      text: 'Accessible security workflows describe multiple ways to confirm who is interacting. Some widgets use the phrase “verify you are human.”',
    }))).toBeNull();
    expect(new BrowserHumanStepError(browserHumanStep('identity', site))).toMatchObject({ code: 'AGENT_HUMAN_STEP', step: { reason: 'identity' } });
  });
});

describe('browser human-step continuation', () => {
  it('waits through the same wall, an unreadable moment, an unrelated origin and a loading page', async () => {
    const wall = page({ documentStatus: 401 });
    const clear = page();
    const observations = [wall, new BrowserError('AGENT_PAGE_UNREADABLE', ''), page({ url: 'https://unrelated.example.test/', title: 'Home' }),
      page({ title: 'Loading…', text: '' }), clear, clear];
    let count = 0;
    await expect(wait({ observe: async () => {
      const observation = observations[count++];
      if (observation instanceof Error) throw observation;
      return observation ?? null;
    } })).resolves.toEqual({ status: 'clear', page: clear });
    expect(count).toBe(observations.length);
  });

  it('returns a new human-only step and recognizes navigation back from an identity provider', async () => {
    const verification = page({ text: 'Enter the verification code' });
    await expect(wait({ observe: async () => verification })).resolves.toMatchObject({
      status: 'next', page: verification, step: { reason: 'code' },
    });
    const provider = 'https://tenant.auth0.com';
    const providerProfile = page({ url: provider + '/profile' });
    const clear = page();
    const observations = [providerProfile, providerProfile, clear, clear];
    let count = 0;
    await expect(wait({
      step: browserHumanStep('login', provider),
      originalUrl: provider + '/login',
      targetUrl: clear.url,
      observe: async () => observations[count++] ?? null,
    })).resolves.toEqual({ status: 'clear', page: clear });
    expect(count).toBe(4);
  });

  it('keeps the task paused while a task-specific control remains and reports expiry in Arabic', async () => {
    const result = await wait({
      step: browserHumanStep('payment', site),
      isStillBlocked: () => true,
      timeoutMs: 20,
    });
    expect(result).toMatchObject({ status: 'timeout', message: expect.stringContaining('الدفع في example.test') });
  });

  it('bounds a stalled observation and propagates cancellation', async () => {
    const observe = async (): Promise<BrowserHumanPage> => new Promise(() => {});
    await expect(wait({ observe, timeoutMs: 20 })).resolves.toMatchObject({ status: 'timeout' });
    const controller = new AbortController();
    const waiting = wait({ observe, signal: controller.signal });
    const reason = new Error('aborted by owner');
    controller.abort(reason);
    await expect(waiting).rejects.toBe(reason);
  });
});
