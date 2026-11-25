import { BrowserPremiumBriefSchema } from '@mohassan/contracts';
import { describe, expect, it } from 'vitest';
import { browserPremiumBrief } from '../apps/server/src/assistant/browser-premium-brief.ts';

describe('browser task brief', () => {
  it('summarizes a read-only task using domains and existing browser actions', () => {
    expect(BrowserPremiumBriefSchema.parse(browserPremiumBrief('افتح https://example.org/guide ثم اقرأ الصفحة'))).toEqual({
      sites: ['example.org'], summary: 'سأفتح الصفحة وأقرأ محتواها.', needs: ['login', 'code'], requiresStart: false,
    });
    expect(browserPremiumBrief('افتح ويكيبيديا')).toMatchObject({ sites: ['www.wikipedia.org'] });
    expect(browserPremiumBrief('Read the page', 'https://example.org')).toMatchObject({ sites: ['example.org'], requiresStart: false });
  });

  it('requests an explicit start for authentication and page actions with side effects', () => {
    expect(browserPremiumBrief('افتح https://example.org/session/login?return=private-value ثم اقرأ الصفحة')).toMatchObject({
      sites: ['example.org'], needs: ['login', 'code'], requiresStart: true,
    });
    expect(browserPremiumBrief('open https://example.org then click Publish')).toMatchObject({
      sites: ['example.org'], needs: ['login', 'code', 'approval'], requiresStart: true,
    });
    expect(browserPremiumBrief('click Save', 'https://example.org')).toMatchObject({
      sites: ['example.org'], needs: ['login', 'code', 'approval'], requiresStart: true,
    });
    expect(JSON.stringify(browserPremiumBrief('open https://example.org/login?return=private-value'))).not.toContain('private-value');
  });

  it('leaves ordinary turns, literal requests and explicit navigation prohibitions in the chat', () => {
    expect(browserPremiumBrief('ما عاصمة اليابان؟')).toBeNull();
    expect(browserPremiumBrief('اقرأ الصفحة')).toBeNull();
    expect(browserPremiumBrief('لا تفتح https://example.org')).toBeNull();
    expect(browserPremiumBrief('open https://username:password@example.org')).toBeNull();
  });
});
