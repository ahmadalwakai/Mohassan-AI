import { replyMessageForError, requestLanguage } from '@mohassan/contracts/reply-messages';
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
      const message = replyMessageForError(error, requestLanguage(request));
      expect(replyLanguage(message ?? '').replyLang).toBe(expected);
      if (expected === 'ar') expect(message).toBe(error.message);
    }

    // Original diagnostic at https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/packages/browser/src/engine.ts#L120 (retrieved 2026-11-27).
    expect(error.message).toBe('انتهت جلسة التشغيل. افتح العنوان مجددًا لاستئناف القراءة بجلسة مستقلة.');
  });
});
