import { describe, expect, it, vi } from 'vitest';
import { createTruthSecondSource, independentTruthPages } from '../apps/server/src/assistant/truth-second-source.js';
import { PAGE_TTL_MS } from '../apps/server/src/assistant/page-cache.js';

// Agent-written development cases with an injected HTTP reader. No live services.
const primary = { url: 'https://records.museum.example/riverside', quote: 'The Riverside museum opened in 1986 after a council vote.' };
const alternateUrl = 'https://chronicle.example/history/riverside';
const alternate = {
  url: alternateUrl,
  title: 'Riverside museum through the years',
  text: 'Visitors first entered the Riverside museum in 1986, when the city opened the building to the public.',
  status: 200,
};
const request = { ownerId: 'owner-a', pages: [primary], candidates: [{ url: alternateUrl }] };

describe('truth check source independence', () => {
  it('groups subdomains, country-domain aliases and Wikimedia sibling projects', () => {
    const page = (url: string) => ({ url, quote: primary.quote });
    expect(independentTruthPages(primary, page('https://stories.museum.example/archives'))).toBe(false);
    expect(independentTruthPages(page('https://www.chronicle.com/history'), page('https://city.chronicle.co.uk/archive'))).toBe(false);
    expect(independentTruthPages(page('https://ar.wikipedia.org/wiki/Riverside'), page('https://www.wikidata.org/entity/Riverside'))).toBe(false);
    expect(independentTruthPages(primary, page('https://www.google.com/search?q=riverside'))).toBe(false);
    expect(independentTruthPages(primary, page(alternateUrl))).toBe(true);
  });

  it('rejects long copied passages hosted by another publisher', () => {
    const paragraph = 'The night before the opening a group of volunteers tested every exhibit and carried the last boxes from the temporary archive through the main entrance into the new gallery.';
    expect(independentTruthPages({ ...primary, quote: `News. ${paragraph}` }, { url: alternateUrl, quote: `Archive. ${paragraph.toUpperCase()}` })).toBe(false);
  });
});

describe('truth check second source reader', () => {
  it('reads only one eligible ranked hit and returns literal page text, not the title', async () => {
    const readPage = vi.fn(async () => alternate);
    const read = createTruthSecondSource({ readPage });
    const result = await read({
      ...request,
      observedUrls: ['https://library.example/history'],
      candidates: [
        { url: 'https://stories.museum.example/more' },
        { url: 'https://library.example/history?utm_source=results#opening' },
        { url: 'https://www.google.com/search?q=museum' },
        { url: 'https://catalog.example/entry?token=example-value' },
        { url: 'https://places.example/riverside', title: 'Riverside (disambiguation)' },
        { url: alternateUrl },
        { url: 'https://archive.example/museum' },
      ],
    });
    expect(readPage).toHaveBeenCalledExactlyOnceWith(alternateUrl, expect.any(AbortSignal), { live: undefined });
    expect(result).toEqual({ url: alternateUrl, title: alternate.title, quote: alternate.text });
  });

  it('bounds candidate selection and skips reads without a supporting publisher', async () => {
    const readPage = vi.fn(async () => alternate);
    const read = createTruthSecondSource({ readPage });
    const samePublisher = Array.from({ length: 8 }, (_, index) => ({ url: `https://records.museum.example/page-${index}` }));
    expect(await read({ ...request, candidates: [...samePublisher, ...request.candidates] })).toBeNull();
    expect(await read({ ...request, pages: [] })).toBeNull();
    expect(await createTruthSecondSource({})(request)).toBeNull();
    expect(readPage).not.toHaveBeenCalled();
  });

  it.each([
    { result: 'disallowed' as const },
    { result: null },
    { result: { ...alternate, status: 302 } },
    { result: { ...alternate, text: 'Please enable JavaScript to continue. Browser check in progress.' } },
    { result: { ...alternate, text: 'Riverside may refer to several towns, districts and other locations.' } },
    { result: { ...alternate, url: 'https://records.museum.example/another' } },
  ])('returns no evidence for an ineligible read %# and leaves the next hit unread', async ({ result }) => {
    const readPage = vi.fn(async () => result);
    const read = createTruthSecondSource({ readPage });
    expect(await read({ ...request, candidates: [...request.candidates, { url: 'https://archive.example/museum' }] })).toBeNull();
    expect(readPage).toHaveBeenCalledTimes(1);
  });

  it('keeps a bounded excerpt ending at a sentence boundary', async () => {
    const readPage = vi.fn(async () => ({ ...alternate, text: `${alternate.text}\n${'unfinished '.repeat(5_000)}` }));
    const result = await createTruthSecondSource({ readPage })(request);
    expect(result?.quote).toBe(alternate.text);
  });

  it('caches per owner, expires from the original fetched time, and bypasses the cache for live readings', async () => {
    let now = Date.parse('2025-07-12T13:00:00Z');
    const fetchedAt = new Date(now - 30_000).toISOString();
    const readPage = vi.fn(async () => ({ ...alternate, fetchedAt }));
    const read = createTruthSecondSource({ readPage, now: () => now });
    expect(await read(request)).not.toBeNull();
    expect(await read(request)).not.toBeNull();
    expect(readPage).toHaveBeenCalledTimes(1);

    expect(await read({ ...request, ownerId: 'owner-b' })).not.toBeNull();
    expect(await read({ ...request, live: true })).not.toBeNull();
    expect(readPage).toHaveBeenLastCalledWith(alternateUrl, expect.any(AbortSignal), { live: true });
    expect(await read(request)).not.toBeNull();
    expect(readPage).toHaveBeenCalledTimes(3);

    now = Date.parse(fetchedAt) + PAGE_TTL_MS.other;
    expect(await read(request)).not.toBeNull();
    expect(readPage).toHaveBeenCalledTimes(4);
  });

  it('rechecks cached pages against the current primary and observed URLs', async () => {
    const redirected = 'https://city-news.example/museum';
    const readPage = vi.fn(async () => ({ ...alternate, url: redirected }));
    const read = createTruthSecondSource({ readPage });
    expect(await read(request)).not.toBeNull();
    expect(await read({ ...request, observedUrls: [redirected] })).toBeNull();
    expect(await read({ ...request, pages: [{ ...primary, url: 'https://city-news.example/other' }] })).toBeNull();
    expect(readPage).toHaveBeenCalledTimes(1);
  });

  it('evicts the oldest unused cached read at capacity', async () => {
    const readPage = vi.fn(async (url: string) => ({ ...alternate, url }));
    const read = createTruthSecondSource({ readPage });
    await read(request);
    for (let index = 0; index < 128; index++) {
      await read({ ...request, candidates: [{ url: `https://chronicle.example/district/${index}` }] });
    }
    await read(request);
    expect(readPage).toHaveBeenCalledTimes(130);
  });

  it('bounds a non-cooperative reader and follows cancellation, including before dispatch', async () => {
    vi.useFakeTimers();
    try {
      const readPage = vi.fn((_url: string, _signal: AbortSignal) => new Promise<null>(() => {}));
      const read = createTruthSecondSource({ readPage });
      const timedOut = read(request);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await timedOut).toBeNull();
      expect(readPage.mock.calls[0]?.[1].aborted).toBe(true);

      const controller = new AbortController();
      const cancelled = read({ ...request, signal: controller.signal });
      controller.abort();
      expect(await cancelled).toBeNull();
      expect(readPage.mock.calls[1]?.[1].aborted).toBe(true);
      expect(await read({ ...request, signal: controller.signal })).toBeNull();
      expect(readPage).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns no evidence when the reader fails', async () => {
    const readPage = vi.fn(async () => { throw new Error('offline'); });
    expect(await createTruthSecondSource({ readPage })(request)).toBeNull();
  });
});
