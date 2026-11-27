import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SafeNetwork, type SafeResponse } from '../../network.js';
import { SearchEngine } from '../engine.js';
import { compileQuery } from '../ranking.js';
import type { SourcePlan } from '../source-plan.js';
import { parseNewsFeed } from './news-feed.js';
import { newsProviders } from './news.js';

const fixture = (file: string) => readFileSync(new URL(`./fixtures/news/${file}`, import.meta.url), 'utf8');
const DOC = 'https://api.gdeltproject.org/api/v2/doc/doc';
const SHEHAB = 'https://shehabnews.net/ar/rss';
const MENAFN = 'https://menafn.com/rss/menafn_menatopstoriesar.xml';
const VOA = 'https://www.voanews.com/api/';
const GENEVA = 'https://www.ungeneva.org/en/news-media/press-items-list/rss.xml';
const NOW = Date.parse('2026-11-27T02:00:00Z');
const signal = () => new AbortController().signal;

// GDELT DOC HTTP captures, 2026-11-27. The JSON keeps the consumed fields.
// http://api.gdeltproject.org/api/v2/doc/doc?query=sourcelang%3Aarabic&mode=artlist&format=json&maxrecords=5&timespan=1d&sort=datedesc
// http://api.gdeltproject.org/api/v2/doc/doc?query=climate+sourcelang%3Aenglish&mode=artlist&format=json&maxrecords=5&timespan=1d
const gdeltArabic = fixture('gdelt-ar.json');
const gdeltLimited = fixture('gdelt-429.txt');
const emptyArticles = JSON.stringify({ ...JSON.parse(gdeltArabic), articles: [] });

type Stub = { status: number; body: string | Buffer; headers?: Record<string, string> };

class FixtureNetwork extends SafeNetwork {
  readonly requests: string[] = [];
  readonly robots = new Map<string, string>();
  readonly responses = new Map<string, Stub>([
    [DOC, { status: 200, body: gdeltArabic }],
    [SHEHAB, { status: 200, body: fixture('shehab-ar.xml') }],
    [MENAFN, { status: 200, body: Buffer.from('\ufeff' + fixture('menafn-ar.xml').replace('encoding="UTF-8"', 'encoding="utf-16"'), 'utf16le') }],
    [VOA, { status: 200, body: fixture('voice-of-america.xml') }],
    [GENEVA, { status: 200, body: fixture('un-geneva.xml') }],
  ]);

  override async request(input: string, options: Parameters<SafeNetwork['request']>[1]): Promise<SafeResponse> {
    options?.signal?.throwIfAborted();
    const url = this.validate(input, options?.allowedOrigins);
    this.requests.push(url.href);
    const response = url.pathname === '/robots.txt'
      ? { status: 200, body: this.robots.get(url.origin) ?? 'User-agent: *\nDisallow:' }
      : this.responses.get(url.origin + url.pathname);
    if (!response) throw new Error(`Missing fixture for ${url.origin}${url.pathname}`);
    return { url: url.href, status: response.status, body: Buffer.from(response.body), headers: response.headers ?? {} };
  }
}

function setup() {
  let current = NOW;
  const now = () => current;
  const network = new FixtureNetwork();
  const providers = newsProviders(network, now);
  const get = (url: string, language?: string) => providers.find(provider =>
    provider.planned.hosts.includes(new URL(url).hostname) && (!language || provider.planned.languages.includes(language as 'ar' | 'en')))!;
  return { network, providers, get, now, advance: (ms: number) => { current += ms; } };
}

describe('news providers', () => {
  it('declares each transport and supports news wording or time-sensitive questions without a plan', () => {
    const { providers, get } = setup();
    expect(providers.map(provider => [provider.planned.access, ...provider.planned.languages])).toEqual([
      ['documented_api', 'ar', 'en'], ['feed', 'ar'], ['feed', 'en'], ['feed', 'ar'], ['feed', 'en'],
    ]);
    expect(providers.every(provider => provider.planned.domains.join() === 'news' && provider.planned.contract.checked === '2026-11-27')).toBe(true);
    const gdelt = get(DOC);
    expect(gdelt.supports(compileQuery('news on Ukraine'))).toBe(true);
    expect(gdelt.supports(compileQuery('ما أخبار لبنان؟'))).toBe(true);
    expect(gdelt.supports(compileQuery('weather in London'))).toBe(true);
    expect(gdelt.supports(compileQuery('history of algebra'))).toBe(false);
    expect(get(VOA).supports(compileQuery('ما آخر أخبار لبنان؟'))).toBe(false);
    const plan: SourcePlan = { explicitSites: [], excludedSites: ['shehabnews.net'], domains: ['news'], reasons: [], language: 'ar', fresh: true };
    const planned = { ...compileQuery('لبنان'), plan };
    expect(get(SHEHAB).supports(planned)).toBe(false);
    expect(get(MENAFN).supports(planned)).toBe(true);
    expect(gdelt.supports({ ...planned, plan: { ...plan, domains: [] } } as typeof planned)).toBe(false);
  });

  it.each([
    ['what happened today in Ukraine?', 'english', '20261126235959', '20261127020000'],
    ['ماذا حدث اليوم في لبنان؟', 'arabic', '20261126235959', '20261127020000'],
    ['news on Ukraine yesterday', 'english', '20261125235959', '20261127000000'],
    ['ماذا حدث أمس في لبنان؟', 'arabic', '20261125235959', '20261127000000'],
    ['news on Ukraine this week', 'english', '20261122235959', '20261127020000'],
    ['أخبار لبنان هَذا الأُسبوع', 'arabic', '20261122235959', '20261127020000'],
    ['news on Ukraine this month', 'english', '20261031235959', '20261127020000'],
    ['أخبار لبنان هذا الشهر', 'arabic', '20261031235959', '20261127020000'],
    ['latest news on Ukraine', 'english', '20261120015959', '20261127020000'],
  ])('uses the UTC window for %s', async (question, language, start, end) => {
    const { network, get } = setup();
    network.responses.set(DOC, { status: 200, body: emptyArticles });
    await expect(get(DOC).search(compileQuery(question), 5, signal())).resolves.toEqual([]);
    const request = new URL(network.requests.at(-1)!);
    expect(request.searchParams.get('query')).toBe(language === 'english' ? '"ukraine" sourcelang:english' : 'sourcelang:arabic');
    expect(Object.fromEntries(request.searchParams)).toMatchObject({ mode: 'artlist', format: 'json', startdatetime: start, enddatetime: end });
  });

  it('uses recorded Arabic GDELT headlines with the index date and attribution', async () => {
    const { network, get } = setup();
    const hits = await get(DOC).search(compileQuery('أخبار الوَرّاق اليوم'), 5, signal());
    expect(hits.map(hit => hit.url)).toEqual(['https://www.vetogate.com/5779110']);
    expect(hits[0].snippet).toBe('تاريخ الرصد 2026-11-27T00:15:00Z — GDELT Project (https://www.gdeltproject.org/)');
    expect(network.requests[0]).toBe('https://api.gdeltproject.org/robots.txt');
  });

  it('honors GDELT Retry-After across factories and the five-second minimum', async () => {
    const { network, get, now, advance } = setup();
    const query = compileQuery('latest news on climate');
    const gdelt = get(DOC);
    // The recorded 429 omitted Retry-After. Exercise the optional delay-seconds
    // header with a fixture value per RFC 9110 §10.2.3, checked 2026-11-27.
    // https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.3
    network.responses.set(DOC, { status: 429, headers: { 'retry-after': '90' }, body: gdeltLimited });
    await expect(gdelt.search(query, 5, signal())).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 90_000 });
    advance(89_000);
    const replica = newsProviders(network, now).find(provider => provider.name === gdelt.name)!;
    await expect(replica.search(query, 5, signal())).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 1000 });
    expect(network.requests.filter(url => url.startsWith(DOC))).toHaveLength(1);
    advance(1000);
    network.responses.set(DOC, { status: 200, body: emptyArticles });
    await expect(replica.search(query, 5, signal())).resolves.toEqual([]);
    await expect(gdelt.search(query, 5, signal())).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 5000 });
  });

  it('rejects a diagnostic body and a blocked robots route', async () => {
    const { network, get } = setup();
    network.responses.set(DOC, { status: 200, body: 'Timespan is too short.' });
    await expect(get(DOC).search(compileQuery('latest news on climate'), 5, signal())).rejects.toMatchObject({ kind: 'invalid_response' });
    network.robots.set(new URL(VOA).origin, 'User-agent: *\nDisallow: /api/');
    await expect(get(VOA).search(compileQuery('news on Ukraine'), 5, signal())).rejects.toMatchObject({ kind: 'unavailable' });
    expect(network.requests).not.toContain(VOA);
  });

  it('matches Arabic titles and summaries and ranks equal matches by publisher date', async () => {
    const { get } = setup();
    const shehab = get(SHEHAB);
    const iran = await shehab.search(compileQuery('ما آخر أخبار ايران أمس؟'), 5, signal());
    expect(iran.map(hit => hit.snippet.split(' — ')[0])).toEqual([
      'تاريخ النشر 2026-11-26T23:21:53Z',
      'تاريخ النشر 2026-11-26T22:23:11Z',
    ]);
    const summary = await shehab.search(compileQuery('آخر أخبار اليورانيوم أمس'), 5, signal());
    expect(summary.map(hit => hit.url)).toEqual([iran[0].url]);
    expect(summary[0].title).not.toContain('اليورانيوم');
    expect(await shehab.search(compileQuery('ماذا حدث اليوم في إيران؟'), 5, signal())).toEqual([]);

    const egypt = await get(MENAFN).search(compileQuery('آخر أخبار الإسكندرية هذا الأسبوع'), 5, signal());
    expect(egypt.map(hit => hit.snippet)).toEqual([expect.stringContaining('تاريخ النشر 2026-11-25T19:07:27Z — MENAFN.com')]);
  });

  it('retrieves both English feeds with publisher dates and preserves quoted phrases', async () => {
    const { get } = setup();
    const ukraine = await get(VOA).search(compileQuery('what happened yesterday in Ukraine?'), 5, signal());
    expect(ukraine.map(hit => hit.snippet)).toEqual([expect.stringContaining('Published 2026-11-26T20:10:16Z — Voice of America')]);
    const geneva = await get(GENEVA).search(compileQuery('latest news on "Committee against Torture" this month'), 5, signal());
    expect(geneva).toHaveLength(3);
    expect(geneva[0].snippet).toContain('Published 2026-11-19T19:09:08Z — UN Geneva');
    expect(await get(VOA).search(compileQuery('news on "Ukraine China" this month'), 5, signal())).toEqual([]);
  });

  it.each([
    ['canonical URL', '?utm_source=fixture', '20261126T203000Z'],
    ['similar title', '?edition=amp', '20261126T200000Z'],
  ])('merges duplicates across providers by %s in the search engine', async (kind, search, seendate) => {
    const { network, providers, now } = setup();
    const [headline] = parseNewsFeed(fixture('voice-of-america.xml'));
    // Controlled variants of the recorded VOA article model how DOC can
    // repeat the same link with tracking or index a near-identical headline.
    const alternateTitle = kind === 'similar title' ? headline.title.replace('Documentary about', 'Documentary on') : headline.title;
    network.responses.set(DOC, { status: 200, body: JSON.stringify({ articles: [
      { title: alternateTitle, url: new URL(search, headline.url).href, seendate },
    ] }) });
    const engine = new SearchEngine(network, { providers, now, publicWeb: false });
    const outcome = await engine.execute('latest news on Ukraine', 5, signal());
    expect(outcome.hits.map(hit => hit.url)).toEqual([headline.url]);
    expect(outcome.hits[0].providers).toEqual(kind === 'canonical URL'
      ? ['GDELT DOC 2.0', 'Voice of America RSS (en)'] : ['Voice of America RSS (en)']);
    expect(outcome.hits[0].snippet).toContain('Published 2026-11-26T20:10:16Z');
  });

  it('does not fall back to Wikipedia for news when the news sources are empty', async () => {
    const { get, network, now } = setup();
    network.responses.set(DOC, { status: 200, body: emptyArticles });
    const wikipedia = {
      name: 'Wikipedia', supports: () => true, coverage: 'encyclopedia' as const, accessBasis: 'documented_api' as const,
      search: async () => [{ title: 'Climate News', url: 'https://en.wikipedia.org/wiki/Climate', snippet: 'Climate news' }],
    };
    const engine = new SearchEngine(network, { providers: [get(DOC), wikipedia], now, publicWeb: false });
    expect((await engine.execute('news about climate', 5, signal())).hits).toEqual([]);
  });

  it('leaves other sources usable when a feed disappears after its cache expires', async () => {
    const { network, get, now, advance } = setup();
    const query = 'latest news this month';
    const engine = new SearchEngine(network, { providers: [get(VOA), get(GENEVA)], now, publicWeb: false });
    expect((await engine.execute(query, 10, signal())).hits[0].providers).toEqual(['Voice of America RSS (en)']);
    network.responses.set(VOA, { status: 410, body: '' });
    advance(60 * 60_000);
    const outcome = await engine.execute(query, 10, signal());
    expect(outcome.failures).toEqual([]);
    expect(outcome.hits.length).toBeGreaterThan(0);
    expect(outcome.hits.every(hit => hit.providers.join() === 'UN Geneva RSS (en)')).toBe(true);
  });

  it('parses the recorded Atom fixture and distinguishes its update date from publication', () => {
    expect(parseNewsFeed(fixture('gov-uk.atom'))[0]).toMatchObject({
      url: expect.stringMatching(/^https:\/\/www\.gov\.uk\//), dateKind: 'updated',
    });
  });

  it('rejects feed DTDs and does not resolve external entities', () => {
    const input = fixture('voice-of-america.xml').replace('<rss ', '<!DOCTYPE rss SYSTEM "https://www.voanews.com/"><rss ');
    expect(() => parseNewsFeed(input)).toThrow('invalid_response');
  });
});
