import { browserErrorReply, requestLanguage } from '@mohassan/contracts/reply-messages';
import { describe, expect, it } from 'vitest';
import { replyLanguage } from '../../../apps/server/src/assistant/reply-check.js';
import { BrowserEngine } from './engine.js';
import { BrowserError } from './network.js';

describe('browser engine error replies', () => {
  it('renders a stale session error in the request language and preserves its diagnostic', async () => {
    const engine = new BrowserEngine();
    const error = await engine.observe('closed-session').catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(BrowserError);
    expect(error).toMatchObject({ code: 'BROWSER_SESSION_STALE', statusCode: 409 });
    if (!(error instanceof BrowserError)) throw new Error('Expected a browser error');

    for (const [request, expected] of [['Read the page again', 'en'], ['أعد قراءة الصفحة', 'ar']] as const) {
      const message = browserErrorReply(error, requestLanguage(request));
      expect(replyLanguage(message ?? '').replyLang).toBe(expected);
      if (expected === 'ar') expect(message).toBe(error.message);
    }

    // Original diagnostic at https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/packages/browser/src/engine.ts#L120 (retrieved 2026-11-27).
    expect(error.message).toBe('انتهت جلسة التشغيل. افتح العنوان مجددًا لاستئناف القراءة بجلسة مستقلة.');
    expect(browserErrorReply(new BrowserError('BROWSER_REQUEST_LIMIT', error.message), 'en')).toBeUndefined();
  });

  it('distinguishes different diagnostics with the same form error code', () => {
    // https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/packages/browser/src/engine.ts#L169 (retrieved 2026-11-27).
    const field = new BrowserError('BROWSER_FORM_INVALID', 'قيمة القائمة غير موجودة في الحقل.');
    // https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/packages/browser/src/engine.ts#L211 (retrieved 2026-11-27).
    const form = new BrowserError('BROWSER_FORM_INVALID', 'قيمة القائمة غير موجودة في النموذج.');

    expect(browserErrorReply(field, 'en')).toContain('this field');
    expect(browserErrorReply(form, 'en')).toContain('this form');
  });

  it('localizes the snapshot Google Ads policy error and its navigation wrapper', () => {
    // https://github.com/ahmadalwakai/Mohassan-AI/blob/2a4498e1de09edf9c4a7b2847754d197e5146b85/packages/browser/src/effect-policy.ts#L42 (retrieved 2026-11-27).
    const diagnostic = 'تغييرات Google Ads تحتاج التكامل الرسمي المربوط بالحساب والموافقة والقراءة اللاحقة؛ استخدم مسار Google Ads لإعداد التغيير ومراجعته. لم يُرسل طلب المتصفح.';
    const policy = new BrowserError('GOOGLE_ADS_TYPED_API_REQUIRED', diagnostic, 403);
    const navigation = new BrowserError('BROWSER_NAVIGATION_FAILED', diagnostic, 502);

    const translated = browserErrorReply(policy, 'en') ?? '';
    expect(translated).toContain('official integration');
    expect(translated).toContain('No browser request was sent.');
    expect(replyLanguage(translated).replyLang).toBe('en');
    expect(browserErrorReply(navigation, 'en')).toBe(translated);
    expect(browserErrorReply(policy, 'ar')).toBe(diagnostic);
  });

  it('keeps the generic English navigation reply for an unlisted wrapped diagnostic', () => {
    // https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/packages/browser/src/network.ts#L51 (retrieved 2026-11-27).
    const diagnostic = 'الوجهة خارج نطاق المواقع الذي اخترته.';
    const navigation = new BrowserError('BROWSER_NAVIGATION_FAILED', diagnostic, 502);

    expect(browserErrorReply(navigation, 'en')).toContain('allowed time and scope');
    expect(browserErrorReply(navigation, 'ar')).toBeUndefined();
    expect(navigation.message).toBe(diagnostic);
  });
});
