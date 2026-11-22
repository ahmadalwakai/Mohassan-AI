import { describe, expect, it } from 'vitest';
import { PAGE_TTL_MS, classifyPage, createPageCache, pageCacheKey } from '../apps/server/src/assistant/page-cache.js';

const page = (url: string, text = 'نص الصفحة الذي يُقرأ ويُحفظ للسؤال التالي.') => ({ url, title: 'عنوان', text, status: 200 });

describe('page cache: evidence read over HTTP is reused by site kind', () => {
  it('classifies hosts into the plan\'s four kinds', () => {
    expect(classifyPage('https://ar.wikipedia.org/wiki/طوكيو')).toBe('encyclopedia');
    expect(classifyPage('https://www.britannica.com/place/Tokyo')).toBe('encyclopedia');
    expect(classifyPage('https://docs.python.org/3/library/dataclasses.html')).toBe('documentation');
    expect(classifyPage('https://developer.mozilla.org/en-US/docs/Web')).toBe('documentation');
    expect(classifyPage('https://www.bbc.com/arabic')).toBe('news');
    expect(classifyPage('https://www.aljazeera.net/news')).toBe('news');
    expect(classifyPage('https://www.gov.uk/renew-adult-passport')).toBe('other');
    expect(PAGE_TTL_MS.encyclopedia).toBeGreaterThan(PAGE_TTL_MS.documentation);
    expect(PAGE_TTL_MS.documentation).toBeGreaterThan(PAGE_TTL_MS.news);
  });

  it('keys by address without fragment, credentials or trailing slash', () => {
    expect(pageCacheKey('https://ar.wikipedia.org/wiki/طوكيو#التاريخ')).toBe(pageCacheKey('https://ar.wikipedia.org/wiki/طوكيو/'));
    expect(pageCacheKey('https://user:pw@example.com/a?x=1')).toBe('https://example.com/a?x=1');
    expect(pageCacheKey('ftp://example.com/a')).toBeNull();
    expect(pageCacheKey('not a url')).toBeNull();
  });

  it('serves a page within its lifetime and forgets it afterwards', () => {
    let clock = Date.parse('2026-11-22T04:00:00.000Z');
    const cache = createPageCache({ now: () => clock });
    const stored = cache.put(page('https://ar.wikipedia.org/wiki/طوكيو'));
    expect(stored.fetchedAt).toBe('2026-11-22T04:00:00.000Z');
    expect(cache.get('https://ar.wikipedia.org/wiki/طوكيو#x')?.fetchedAt).toBe('2026-11-22T04:00:00.000Z');
    clock += PAGE_TTL_MS.encyclopedia - 1;
    expect(cache.get('https://ar.wikipedia.org/wiki/طوكيو')).not.toBeNull();
    clock += 2;
    expect(cache.get('https://ar.wikipedia.org/wiki/طوكيو')).toBeNull();
    expect(cache.stats()).toMatchObject({ size: 0, hits: 2, misses: 1 });
  });

  it('gives a news page a quarter of an hour and an unknown site the same', () => {
    let clock = 0;
    const cache = createPageCache({ now: () => clock });
    cache.put(page('https://www.bbc.com/arabic'));
    cache.put(page('https://www.gov.uk/renew-adult-passport'));
    clock = PAGE_TTL_MS.news - 1;
    expect(cache.get('https://www.bbc.com/arabic')).not.toBeNull();
    expect(cache.get('https://www.gov.uk/renew-adult-passport')).not.toBeNull();
    clock = PAGE_TTL_MS.news + 1;
    expect(cache.get('https://www.bbc.com/arabic')).toBeNull();
    expect(cache.get('https://www.gov.uk/renew-adult-passport')).toBeNull();
  });

  it('never serves or keeps a page read for a live fact, an empty page or an error page', () => {
    const cache = createPageCache({ now: () => 0 });
    cache.put(page('https://gold.example/price'), { live: true });
    expect(cache.get('https://gold.example/price')).toBeNull();
    cache.put(page('https://gold.example/price'));
    expect(cache.get('https://gold.example/price', { live: true })).toBeNull();
    expect(cache.get('https://gold.example/price')).not.toBeNull();
    cache.put(page('https://empty.example/', '   '));
    expect(cache.get('https://empty.example/')).toBeNull();
    cache.put({ ...page('https://missing.example/'), status: 404 });
    expect(cache.get('https://missing.example/')).toBeNull();
  });

  it('drops the least recently used page when full and trims oversized text', () => {
    const cache = createPageCache({ now: () => 0, maxEntries: 2 });
    cache.put(page('https://a.example/'));
    cache.put(page('https://b.example/'));
    expect(cache.get('https://a.example/')).not.toBeNull();
    cache.put(page('https://c.example/'));
    expect(cache.get('https://b.example/')).toBeNull();
    expect(cache.get('https://a.example/')).not.toBeNull();
    expect(cache.get('https://c.example/')).not.toBeNull();
    expect(cache.put(page('https://d.example/', 'x'.repeat(250_000))).text).toHaveLength(200_000);
  });
});
