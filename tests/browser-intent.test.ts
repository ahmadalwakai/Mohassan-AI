import { describe, expect, it } from 'vitest';
import { browserReadOrigins, detectBrowserOpenIntent } from '../packages/contracts/src/browser-intent';

describe('explicit browser opening intent', () => {
  it('adds only the known public Google Ads read dependencies for the exact HTTPS host', () => {
    expect(browserReadOrigins('https://ads.google.com/home/')).toEqual(['https://ads.google.com', 'https://consent.google.com', 'https://www.gstatic.com', 'https://business.google.com']);
    expect(browserReadOrigins('https://example.com/path')).toEqual(['https://example.com']);
    expect(browserReadOrigins('https://ads.google.com.other.com/')).toEqual(['https://ads.google.com.other.com']);
    expect(browserReadOrigins('http://ads.google.com/')).toEqual(['http://ads.google.com']);
    expect(browserReadOrigins('https://ads.google.com:444/')).toEqual(['https://ads.google.com:444']);
    expect(browserReadOrigins('https://accounts.google.com/')).toEqual(['https://accounts.google.com']);
    expect(browserReadOrigins('')).toEqual([]);
  });
  it('routes the owner Google Ads request and preserves an explicit HTTPS target', () => {
    expect(detectBrowserOpenIntent('افتح موقع Google Ads في المتصفح، واعرض لي لقطة من الصفحة بعد تحميلها.')).toEqual({ url: 'https://ads.google.com/home/', source: 'google_ads' });
    expect(detectBrowserOpenIntent('افتحGoogleAds')).toEqual({ url: 'https://ads.google.com/home/', source: 'google_ads' });
    expect(detectBrowserOpenIntent('Open https://example.com/path?q=ads, then show a screenshot.')).toEqual({ url: 'https://example.com/path?q=ads', source: 'explicit_url' });
  });

  it.each([
    'لا تفتح موقع Google Ads في المتصفح.',
    'لا أريد أن تفتح Google Ads الآن.',
    "Do not open https://example.com/",
    'اشرح لي كيف افتح Google Ads.',
    'How to open Google Ads?',
    'تحقق من اتصال التخزين وسلامة محرك التنفيذ.',
    'أعد خطة إعلانية لحساب Google Ads.',
    'افتح https://one.example/ و https://two.example/',
    'افتح http://example.com/',
    'افتح https://user:secret@example.com/',
  ])('does not route a negated, instructional, ambiguous or unsupported request: %s', (goal) => {
    expect(detectBrowserOpenIntent(goal)).toBeNull();
  });
});
