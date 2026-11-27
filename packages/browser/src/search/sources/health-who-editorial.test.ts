import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { SafeNetwork, type SafeResponse } from '../../network.js';
import { compileQuery } from '../ranking.js';
import { createHealthRequester } from './health-network.js';
import { createWhoEditorialProviders } from './health-who-editorial.js';

const origin = 'https://www.who.int';
const zone = '/news-room/fact-sheets/detail/asthma';
const arabicIndex = '/ar/news-room/fact-sheets';
const kidney = `${arabicIndex}/detail/kidney-disease`;
const sitemapPath = '/sitemap/sitemap.gz';
const newsEnglish = '/rss-feeds/news-english.xml';
const newsArabic = '/rss-feeds/news-arabic.xml';
const signal = new AbortController().signal;
const fixture = (name: string) => readFileSync(new URL(`./fixtures/health/${name}`, import.meta.url));

class WhoNetwork extends SafeNetwork {
  readonly calls: string[] = [];
  responses = new Map<string, { status?: number; headers: Record<string, string>; body: Buffer }>([
    ['/robots.txt', { headers: { 'content-type': 'text/plain' }, body: fixture('who-robots.txt') }],
    [sitemapPath, { headers: { 'content-type': 'application/octet-stream' }, body: gzipSync(fixture('who-sitemap.xml')) }],
    [zone, { headers: { 'content-type': 'text/html' }, body: fixture('who-asthma-en.html') }],
    [`/ar${zone}`, { headers: { 'content-type': 'text/html' }, body: fixture('who-asthma-ar.html') }],
    [arabicIndex, { headers: { 'content-type': 'text/html' }, body: fixture('who-fact-index-ar.html') }],
    [kidney, { headers: { 'content-type': 'text/html' }, body: fixture('who-kidney-ar.html') }],
    [newsEnglish, { headers: { 'content-type': 'application/rss+xml' }, body: fixture('who-news-en.xml') }],
    [newsArabic, { headers: { 'content-type': 'application/rss+xml' }, body: fixture('who-news-ar.xml') }],
  ]);

  override async request(input: string, options?: Parameters<SafeNetwork['request']>[1]): Promise<SafeResponse> {
    this.validate(input, [origin]);
    options?.signal?.throwIfAborted();
    const path = new URL(input).pathname;
    this.calls.push(path);
    const response = this.responses.get(path);
    if (!response) throw new Error(`Unexpected WHO request to ${path}`);
    return { status: 200, ...response, url: input };
  }
}

function setup(network = new WhoNetwork()) {
  const now = () => Date.UTC(2026, 10, 27);
  const [facts, news] = createWhoEditorialProviders(createHealthRequester(network, now), now);
  return { network, facts, news };
}

describe('WHO editorial sources', () => {
  it('reads published same-topic Arabic and English fact sheets from the named sitemap', async () => {
    const { network, facts } = setup();
    const arabic = compileQuery('ما أعراض الربو؟');
    expect(facts.supports(arabic)).toBe(true);
    await expect(facts.search(arabic, 1, signal)).resolves.toEqual([{
      title: 'الربو',
      url: `${origin}/ar${zone}`,
      snippet: expect.stringContaining('الربو مرض من الأمراض غير السارية'),
      sourceOrganization: 'World Health Organization',
      publishedAt: '2026-04-28',
    }]);
    await expect(facts.search(compileQuery('What are the symptoms of asthma?'), 1, signal)).resolves.toEqual([{
      title: 'Asthma',
      url: origin + zone,
      snippet: expect.stringContaining('Symptoms can include coughing'),
      sourceOrganization: 'World Health Organization',
      publishedAt: '2026-04-28',
    }]);
    expect(network.calls).toEqual(['/robots.txt', sitemapPath, `/ar${zone}`, zone]);
  });

  it('uses the sitemap-linked WHO Arabic fact-sheet directory for a topic without an English mapping', async () => {
    const { network, facts } = setup();
    await expect(facts.search(compileQuery('ما أعراض أمراض الكلى؟'), 1, signal)).resolves.toEqual([{
      title: 'أمراض الكلى',
      url: origin + kidney,
      snippet: expect.stringContaining('تشمل أمراض الكلى'),
      sourceOrganization: 'World Health Organization',
      publishedAt: '2026-04-20',
    }]);
    expect(network.calls).toEqual(['/robots.txt', sitemapPath, arabicIndex, kidney]);
  });

  it('keeps the query language in the published WHO news feeds and retains attribution and dates', async () => {
    const { network, news } = setup();
    await expect(news.search(compileQuery('أخبار السمنة'), 5, signal)).resolves.toEqual([{
      title: 'القادة يلتزمون بتسريع العمل على الوقاية من السمنة ومكافحتها',
      url: `${origin}/ar/news-room/07-06-1448-leaders-commit-to-accelerate-action-on-obesity-prevention-and-control`,
      snippet: expect.stringContaining('انضمت حكومة إسبانيا'),
      sourceOrganization: 'World Health Organization',
      publishedAt: '2026-11-17',
    }]);
    await expect(news.search(compileQuery('COVID-19 mental health news'), 5, signal)).resolves.toEqual([{
      title: 'COVID-19 disrupting mental health services in most countries, WHO survey',
      url: `${origin}/news/item/05-10-2020-covid-19-disrupting-mental-health-services-in-most-countries-who-survey`,
      snippet: expect.stringContaining('The COVID-19 pandemic has disrupted'),
      sourceOrganization: 'World Health Organization',
      // The linked article's byline gives 5 October, although the feed gives 6 October.
      publishedAt: '2020-10-05',
    }]);
    expect(network.calls).toEqual(['/robots.txt', newsArabic, newsEnglish]);
  });

  it('returns an empty result for an unmatched topic', async () => {
    const { facts, news } = setup();
    const query = compileQuery('cholera');
    await expect(facts.search(query, 5, signal)).resolves.toEqual([]);
    await expect(news.search(query, 5, signal)).resolves.toEqual([]);
  });

  it('propagates a feed Retry-After and applies it to both WHO sources', async () => {
    const { network, facts, news } = setup();
    network.responses.set(newsEnglish, { status: 429, headers: { 'retry-after': '37' }, body: Buffer.alloc(0) });
    await expect(news.search(compileQuery('asthma news'), 1, signal)).rejects.toMatchObject({
      kind: 'rate_limited', retryAfterMs: 37_000,
    });
    await expect(facts.search(compileQuery('ما أعراض الربو؟'), 1, signal)).rejects.toMatchObject({
      kind: 'rate_limited', retryAfterMs: 37_000,
    });
    expect(network.calls).toEqual(['/robots.txt', newsEnglish]);
  });
});
