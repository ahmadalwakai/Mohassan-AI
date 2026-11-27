import { parseFragment, type DefaultTreeAdapterTypes } from 'parse5';
import { BrowserError, type SafeNetwork } from '../../network.js';
import type { SearchHit } from '../../research.js';
import { safeResumeUrl } from '../../session-state.js';
import { publicSearchScan, publicSearchText } from '../local-index.js';
import { SearchProviderFailure, searchRetryAfter, type SearchQuery } from '../providers.js';
import { canonicalUrl, matchesSearchPhrases } from '../ranking.js';
import { RobotsPolicy } from '../robots.js';
import type { PlannedProvider, SourcePlan } from '../source-plan.js';
import { PROVIDER_INTERVALS } from '../store.js';
import { parseNewsFeed } from './news-feed.js';
import { hasNewsWording, newsRelevance, newsTimePeriod, newsTopicTokens, mergeNewsHits, newsEvidence, type NewsHit } from './news-ranking.js';

const GDELT = 'https://api.gdeltproject.org/api/v2/doc/doc';
const GDELT_DOCS = 'https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/';
// Checked 2026-11-27. Terms require GDELT Project attribution and a homepage link.
// https://www.gdeltproject.org/about.html#termsofuse
// Official rate-limit announcement and live HTTP 429 body (one request every 5 seconds).
// https://blog.gdeltproject.org/ukraine-api-rate-limiting-web-ngrams-3-0/
const GDELT_CHECKED = '2026-11-27';
const GDELT_NAME = 'GDELT DOC 2.0';
const GDELT_INTERVAL = PROVIDER_INTERVALS[GDELT_NAME];
// Documented ArtList limit (GDELT_DOCS, checked 2026-11-27).
const GDELT_MAX_RECORDS = 250;
const GDELT_ATTRIBUTION = 'GDELT Project (https://www.gdeltproject.org/)';

interface Feed {
  outlet: string;
  language: SourcePlan['language'];
  url: string;
  contract: string;
  checked: string;
  cacheMs?: number;
  articlePath?: string;
}

const feeds: readonly Feed[] = [
  // Publisher links its RSS feeds in https://shehabnews.net/ar/faq.
  // Terms §2/§5 allow RSS and attributed excerpts. https://shehabnews.net/robots.txt
  {
    outlet: 'Shehab News Agency', language: 'ar',
    url: 'https://shehabnews.net/ar/rss',
    contract: 'https://shehabnews.net/ar/terms', checked: '2026-11-27',
  },
  // Published reader feed. Its RSS ttl is 60 minutes. https://www.voanews.com/robots.txt
  // VOA copyright and attribution terms: https://www.voanews.com/p/5338.html
  {
    outlet: 'Voice of America', language: 'en',
    url: 'https://www.voanews.com/api/',
    contract: 'https://www.voanews.com/rssfeeds', checked: '2026-11-27', cacheMs: 60 * 60_000,
  },
  // Reader reuse with attribution and original links. https://menafn.com/robots.txt
  {
    outlet: 'MENAFN.com', language: 'ar',
    url: 'https://menafn.com/rss/menafn_menatopstoriesar.xml',
    contract: 'https://menafn.com/arabic/Rss', checked: '2026-11-27',
  },
  // Publisher provides RSS for readers and websites. https://www.ungeneva.org/robots.txt
  {
    outlet: 'UN Geneva', language: 'en',
    url: 'https://www.ungeneva.org/en/news-media/press-items-list/rss.xml',
    contract: 'https://www.ungeneva.org/en/news-media/rss', checked: '2026-11-27', cacheMs: 15 * 60_000, articlePath: '/en/',
  },
];

const DAY = 86_400_000;
const MAX_BYTES = 1_000_000;
const FEED_CACHE_MS = 5 * 60_000;
type NewsQuery = SearchQuery & { plan?: SourcePlan };
type TimeWindow = { start: number; end: number };
type Article = { title: string; url: string; summary: string; date: number; kind: 'published' | 'updated' | 'indexed' };
type Gate = { active: boolean; next: number };

// The clock identity isolates fixture clocks while sharing the production gate
// across factories in the same process.
const gdeltGates = new WeakMap<() => number, Gate>();

function timeWindow(question: string, end: number): TimeWindow {
  const today = Math.floor(end / DAY) * DAY;
  const date = new Date(today);
  switch (newsTimePeriod(question)) {
    case 'today': return { start: today, end };
    case 'yesterday': return { start: today - DAY, end: today };
    case 'week': return { start: today - ((date.getUTCDay() + 6) % 7) * DAY, end };
    case 'month': return { start: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1), end };
    default: return { start: end - 7 * DAY, end };
  }
}

function timestamp(value: number): string {
  return new Date(value).toISOString().slice(0, 19).replace(/\D/g, '');
}

function articlesFromGdelt(body: string): Article[] {
  if (!body.trim()) return [];
  let data: unknown;
  try { data = JSON.parse(body); } catch { throw new SearchProviderFailure('invalid_response'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new SearchProviderFailure('invalid_response');
  const articles = (data as { articles?: unknown }).articles;
  if (articles === undefined && !Object.keys(data).length) return [];
  if (!Array.isArray(articles)) throw new SearchProviderFailure('invalid_response');

  return articles.slice(0, GDELT_MAX_RECORDS).flatMap(item => {
    if (!item || typeof item.title !== 'string' || typeof item.url !== 'string' || typeof item.seendate !== 'string') return [];
    const seen = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(item.seendate);
    if (!seen) return [];
    const date = Date.parse(`${seen[1]}-${seen[2]}-${seen[3]}T${seen[4]}:${seen[5]}:${seen[6]}Z`);
    if (!Number.isFinite(date) || timestamp(date) !== seen.slice(1).join('')) return [];
    return [{ title: item.title, url: item.url, date, kind: 'indexed' as const, summary: '' }];
  });
}

function plain(value: string, length: number): string {
  function text(node: DefaultTreeAdapterTypes.Node): string {
    if ('value' in node) return node.value;
    if ('tagName' in node && ['script', 'style'].includes(node.tagName)) return '';
    return 'childNodes' in node ? node.childNodes.map(text).join(' ') : '';
  }
  return publicSearchText(text(parseFragment(value.slice(0, 12_000))))
    .replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim().slice(0, length);
}

function siteMatches(host: string, sites: string[]): boolean {
  return sites.some(site => host === site || host.endsWith(`.${site}`));
}

function siteAllowed(query: NewsQuery, host: string): boolean {
  const sites = query.plan?.explicitSites ?? query.sites;
  return (!sites.length || siteMatches(host, sites)) && !siteMatches(host, query.plan?.excludedSites ?? []);
}

function supportsNews(query: NewsQuery): boolean {
  return query.plan ? query.plan.domains.includes('news') : query.timeSensitive || hasNewsWording(query.question);
}

function newsHits(
  network: SafeNetwork, query: NewsQuery, window: TimeWindow, articles: Article[], outlet: string, limit: number,
): SearchHit[] {
  const terms = newsTopicTokens(query);
  const language = query.plan?.language ?? query.language;
  const candidates = articles.flatMap(article => {
    if (article.date < window.start || article.date >= window.end || !Number.isFinite(article.date)) return [];
    let url: URL;
    try { url = network.validate(canonicalUrl(article.url)); } catch { return []; }
    const host = url.hostname.replace(/\.$/u, '');
    if (!safeResumeUrl(url.href) || siteMatches(host, ['wikipedia.org']) || !siteAllowed(query, host)) return [];
    const title = plain(article.title, 240);
    const summary = plain(article.summary, 650);
    const relevance = newsRelevance(terms, title, summary);
    if (!title || (terms.length && !relevance) || !matchesSearchPhrases(query, title, summary)) return [];

    const isoDate = new Date(article.date).toISOString().replace(/\.000Z$/, 'Z');
    const label = article.kind === 'published' ? (language === 'ar' ? 'تاريخ النشر' : 'Published')
      : article.kind === 'updated' ? (language === 'ar' ? 'آخر تحديث' : 'Updated')
      : (language === 'ar' ? 'تاريخ الرصد' : 'Indexed');
    const hit: NewsHit = {
      title,
      url: url.href,
      snippet: [`${label} ${isoDate}`, outlet, summary].filter(Boolean).join(' — '),
      [newsEvidence]: { date: article.date, kind: article.kind, relevance },
    };
    return [hit];
  });
  return mergeNewsHits(candidates).slice(0, limit).map(([hit]) => hit);
}

function size(limit: number): number {
  return Math.max(1, Math.min(20, Number.isFinite(limit) ? Math.floor(limit) : 5));
}

function gdeltUrl(query: NewsQuery, window: TimeWindow, limit: number): string {
  // DOC searches English translations even when filtering for Arabic originals.
  // Arabic-only queries retrieve recent Arabic titles and match locally.
  // https://blog.gdeltproject.org/updates-doc-2-0-api/
  const topics = newsTopicTokens(query);
  const terms = topics.filter(term => /^[a-z0-9]+$/u.test(term) && term.length >= 2);
  const language = (query.plan?.language ?? query.language) === 'ar' ? 'arabic' : 'english';
  const localMatching = language === 'arabic' && topics.some(term => /\p{Script=Arabic}/u.test(term));
  const keywords = localMatching ? [] : terms.slice(0, 8).map(term => `"${term}"`);
  const url = new URL(GDELT);
  // Leave margin above the minimum for short windows at UTC midnight.
  // The exact requested window is still enforced locally.
  url.search = new URLSearchParams({
    query: [...keywords, `sourcelang:${language}`].join(' '),
    mode: 'artlist',
    format: 'json',
    sort: 'DateDesc',
    maxrecords: String(localMatching ? GDELT_MAX_RECORDS : Math.max(20, limit * 5)),
    startdatetime: timestamp(Math.min(window.start - 1000, window.end - 60 * 60_000)),
    enddatetime: timestamp(window.end),
  }).toString();
  return url.href;
}

function checkPublicQuery(query: SearchQuery): void {
  const value = query.question.normalize('NFKC').replace(/\p{Cf}/gu, '');
  const decoded = publicSearchScan(value);
  if (publicSearchText(value) !== value || publicSearchText(decoded) !== decoded ||
      (decoded.match(/https?:\/\/\S+/gi) ?? []).some(url => !safeResumeUrl(url))) {
    throw new BrowserError('RESEARCH_QUERY_SECRET', 'أزل بيانات الاعتماد من الاستعلام قبل البحث العام.', 400);
  }
}

export function newsProviders(network: SafeNetwork, now: () => number): PlannedProvider[] {
  const robots = new RobotsPolicy(network, now);
  const gdelt = gdeltGates.get(now) ?? { active: false, next: 0 };
  gdeltGates.set(now, gdelt);
  const feedBackoffs = new Map<string, number>();

  async function retrieve(url: string, signal: AbortSignal, accept: string, backoff: (delay: number) => void): Promise<string | null> {
    signal.throwIfAborted();
    const origin = new URL(url).origin;
    try {
      await robots.assertAllowed(url, signal);
      const response = await network.request(url, { signal, maxBytes: MAX_BYTES, allowedOrigins: [origin], headers: { accept } });
      signal.throwIfAborted();
      const retryHeader = response.headers['retry-after'];
      if (response.status === 429 || (response.status === 503 && retryHeader !== undefined)) {
        const retry = searchRetryAfter(retryHeader, now());
        backoff(retry);
        throw new SearchProviderFailure(response.status === 429 ? 'rate_limited' : 'unavailable', retry);
      }
      if (response.status === 404 || response.status === 410) return null;
      if (response.status !== 200) throw new SearchProviderFailure('unavailable');
      try {
        // MENAFN publishes UTF-16LE with a BOM. Other checked feeds use UTF-8.
        const [first, second] = response.body;
        const encoding = first === 0xff && second === 0xfe ? 'utf-16le'
          : first === 0xfe && second === 0xff ? 'utf-16be' : 'utf-8';
        return new TextDecoder(encoding, { fatal: true }).decode(response.body);
      }
      catch { throw new SearchProviderFailure('invalid_response'); }
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof SearchProviderFailure) throw error;
      throw new SearchProviderFailure('unavailable');
    }
  }

  const gdeltProvider: PlannedProvider = {
    name: GDELT_NAME,
    coverage: 'web',
    accessBasis: 'documented_api',
    planned: { domains: ['news'], languages: ['ar', 'en'], access: 'documented_api', contract: { url: GDELT_DOCS, checked: GDELT_CHECKED }, hosts: [new URL(GDELT).hostname] },
    supports: supportsNews,
    cooldownMs: () => Math.max(0, gdelt.next - now()),
    async search(query: NewsQuery, limit, signal) {
      signal.throwIfAborted();
      checkPublicQuery(query);
      const started = now();
      if (gdelt.active || gdelt.next > started) throw new SearchProviderFailure('rate_limited', Math.max(gdelt.active ? GDELT_INTERVAL : 0, gdelt.next - started));
      const window = timeWindow(query.question, started);
      gdelt.active = true;
      try {
        const body = await retrieve(gdeltUrl(query, window, size(limit)), signal, 'application/json',
          delay => { gdelt.next = Math.max(gdelt.next, now() + delay); });
        if (body === null) throw new SearchProviderFailure('unavailable');
        return newsHits(network, query, window, articlesFromGdelt(body), GDELT_ATTRIBUTION, size(limit));
      } finally {
        gdelt.active = false;
        gdelt.next = Math.max(gdelt.next, now() + GDELT_INTERVAL);
      }
    },
  };

  const feedProviders = feeds.map((feed): PlannedProvider => {
    const host = new URL(feed.url).hostname;
    let cached: { until: number; articles: Article[] } | undefined;
    let active = false;
    return {
      name: `${feed.outlet} RSS (${feed.language})`,
      coverage: 'web',
      accessBasis: 'documented_api',
      planned: { domains: ['news'], languages: [feed.language], access: 'feed', contract: { url: feed.contract, checked: feed.checked }, hosts: [host] },
      supports: (query: NewsQuery) => supportsNews(query) && (query.plan?.language ?? query.language) === feed.language && siteAllowed(query, host),
      cooldownMs: () => Math.max(0, (feedBackoffs.get(host) ?? 0) - now()),
      async search(query: NewsQuery, limit, signal) {
        signal.throwIfAborted();
        if (!siteAllowed(query, host) || (query.plan?.language ?? query.language) !== feed.language) return [];
        const started = now(), window = timeWindow(query.question, started);
        if (!cached || cached.until <= started) {
          const retry = (feedBackoffs.get(host) ?? 0) - started;
          if (retry > 0 || active) throw new SearchProviderFailure('rate_limited', Math.max(retry, 0));
          active = true;
          try {
            const body = await retrieve(feed.url, signal, 'application/rss+xml, application/atom+xml, application/xml, text/xml',
              delay => { feedBackoffs.set(host, Math.max(feedBackoffs.get(host) ?? 0, now() + delay)); });
            const articles = body === null ? [] : parseNewsFeed(body)
              .filter(item => !feed.articlePath || item.url.startsWith(new URL(feed.articlePath, feed.url).href))
              .map((item): Article => ({
                title: item.title,
                url: item.url,
                summary: item.summary,
                // UN Geneva uses CET/CEST. Europe/Zurich and EU rules checked 2026-11-27.
                // https://data.iana.org/time-zones/tzdb/europe
                date: Date.parse(item.date.replace(/ CEST$/u, ' +0200').replace(/ CET$/u, ' +0100')),
                kind: item.dateKind,
              }));
            cached = { articles, until: now() + (feed.cacheMs ?? FEED_CACHE_MS) };
          } finally {
            active = false;
          }
        }
        return newsHits(network, query, window, cached.articles, feed.outlet, size(limit));
      },
    };
  });
  return [gdeltProvider, ...feedProviders];
}
