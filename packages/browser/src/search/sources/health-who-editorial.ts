import { parse, type DefaultTreeAdapterTypes } from 'parse5';
import { SearchProviderFailure, type SearchQuery } from '../providers.js';
import { searchTokens } from '../ranking.js';
import type { PlannedProvider } from '../source-plan.js';
import { englishHealthTopic, isKnownHealthTopic } from './health-topics.js';
import { healthLimit, healthPlain, isHealthQuestion, type HealthHit, type HealthRequester } from './health-utils.js';

const whoOrigin = 'https://www.who.int';
const sourceOrganization = 'World Health Organization';
// WHO's public website permits attributed, limited educational and non-commercial reuse.
// https://www.who.int/about/policies/terms-of-use (2026-11-27)
// https://www.who.int/robots.txt (2026-11-27)
const contract = { url: 'https://www.who.int/about/policies/terms-of-use', checked: '2026-11-27' };
// Child listed at https://www.who.int/sitemaps/sitemapindex.xml, with English and Arabic alternate URLs (2026-11-27).
const factSheetSitemap = new URL('/sitemap/sitemap.gz', whoOrigin);
// Native RSS documents returned by WHO at both URLs (2026-11-27).
const newsFeeds = {
  ar: new URL('/rss-feeds/news-arabic.xml', whoOrigin),
  en: new URL('/rss-feeds/news-english.xml', whoOrigin),
};
const factSheetPath = /^\/(?:(ar|en)\/)?news-room\/fact-sheets\/detail\/[^/]+\/?$/;
const arabicFactSheetIndex = /^\/ar\/news-room\/fact-sheets\/?$/;
const newsPath = /^\/(?:(ar|en)\/)?(?:news\/item|news-room(?:\/detail)?)\/[^/]+\/?$/;
const requestWords = new Set(searchTokens('symptoms symptom side effects treatment treatments diagnosis spread news updates information health who ما أعراض علاج علاجها آثار جانبية كيف ينتشر أخبار خبر صحة معلومات منظمة الصحة العالمية'));
const sitemapMaxBytes = 18_000_000;
const sitemapTtl = 60 * 60 * 1000;
const newsMaxBytes = 2_000_000;
const snippetLimit = 180;
const factSheetReadLimit = 4;
type Language = SearchQuery['language'];
type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;
interface FactSheetIndex {
  urls: URL[];
  arabicIndex?: URL;
}

function whoUrl(raw: string, path: RegExp, base?: URL): URL | undefined {
  try {
    const url = new URL(raw, base);
    if (url.origin === whoOrigin && !url.username && !url.password && !url.search && !url.hash && path.test(url.pathname)) return url;
  } catch {
    return undefined;
  }
}

function supportsWhoSite(query: SearchQuery): boolean {
  return !query.sites.length || query.sites.some(site => site === 'who.int' || site === 'www.who.int');
}

function subjectTerms(text: string): string[] {
  return [...new Set(searchTokens(text))].filter(token => !requestWords.has(token));
}

function isWhoHealthQuery(query: SearchQuery): boolean {
  return isHealthQuestion(query) || Boolean(englishHealthTopic(query.retrievalQuestion))
    || isKnownHealthTopic(subjectTerms(query.retrievalQuestion).join(' '));
}

function score(terms: string[], text: string): number {
  const body = new Set(searchTokens(text));
  return terms.filter(term => body.has(term)).length;
}

function xmlDocument(body: string, tag: 'rss' | 'urlset'): void {
  // These extracts consume only literal RSS/sitemap fields and never resolve XML entities or external input.
  const normalized = body.trimStart().replace(/^<\?xml[^?]*\?>/, '').replace(/^\s*<!--[\s\S]*?-->/, '').trim();
  if (!new RegExp(`^<${tag}(?:\\s|>)`).test(normalized) || !normalized.endsWith(`</${tag}>`)
    || /<!DOCTYPE|<!ENTITY/i.test(normalized)) throw new SearchProviderFailure('invalid_response');
}

function factSheetUrls(body: string): FactSheetIndex {
  xmlDocument(body, 'urlset');
  const urls = new Map<string, URL>();
  let arabicIndex: URL | undefined;
  for (const match of body.matchAll(/<loc>\s*([^<]{1,2500})<\/loc>|<xhtml:link\s+rel="alternate"\s+hreflang="(?:ar|en)"\s+href="([^"]{1,2500})"\s*\/>/g)) {
    const candidate = (match[1] ?? match[2]).trim();
    if (!candidate.includes('/news-room/fact-sheets')) continue;
    arabicIndex ??= whoUrl(candidate, arabicFactSheetIndex);
    const url = whoUrl(candidate, factSheetPath);
    if (url) urls.set(url.href, url);
  }
  return { urls: [...urls.values()], arabicIndex };
}

function elements(root: Node): Element[] {
  const result: Element[] = [];
  const pending: Node[] = [root];
  while (pending.length) {
    const node = pending.pop()!;
    if ('tagName' in node) result.push(node);
    if ('childNodes' in node) {
      for (let index = node.childNodes.length - 1; index >= 0; index--) pending.push(node.childNodes[index]);
    }
  }
  return result;
}

function attribute(node: Element, name: string): string | undefined {
  return node.attrs.find(attr => attr.name === name)?.value;
}

function elementText(root: Node): string {
  const text: string[] = [];
  const pending: Node[] = [root];
  while (pending.length) {
    const node = pending.pop()!;
    if ('value' in node) text.push(node.value);
    if ('childNodes' in node && (!('tagName' in node) || !['script', 'style', 'template'].includes(node.tagName))) {
      for (let index = node.childNodes.length - 1; index >= 0; index--) pending.push(node.childNodes[index]);
    }
  }
  return text.join(' ').replace(/\s+/g, ' ').trim();
}

function arabicFactSheetLinks(html: string, indexUrl: URL): { url: URL; label: string }[] {
  const list = elements(parse(html)).find(node => attribute(node, 'id') === 'alphabetical-nav-filter');
  if (!list) throw new SearchProviderFailure('invalid_response');
  return elements(list).flatMap(node => {
    const href = node.tagName === 'a' ? attribute(node, 'href') : undefined;
    if (!href) return [];
    const url = whoUrl(href, factSheetPath, indexUrl);
    const label = elementText(node);
    return url?.pathname.startsWith('/ar/') && label ? [{ url, label }] : [];
  });
}

function snippet(text: string): string {
  // Keep the search excerpt bounded in addition to the request and response budgets.
  const plain = healthPlain(text, snippetLimit + 1);
  const excerpt = plain.length > snippetLimit ? plain.slice(0, plain.lastIndexOf(' ')) : plain;
  return excerpt.split(' ').slice(0, 24).join(' ');
}

const dayMonthYear = /^(\d{1,2})\s+(.+?)\s+(\d{4})$/u;
function monthNames(language: Language): string[] {
  const format = new Intl.DateTimeFormat(language, {
    month: 'long', calendar: 'gregory', timeZone: 'UTC',
  });
  return Array.from({ length: 12 }, (_, month) => format.format(Date.UTC(2000, month, 1)).toLowerCase());
}
const months = { ar: monthNames('ar'), en: monthNames('en') };

function factSheetDate(text: string, language: Language): string | undefined {
  const match = dayMonthYear.exec(text.replace(/[٠-٩]/g, digit => String(digit.charCodeAt(0) - '٠'.charCodeAt(0))));
  if (!match) return;
  const [, rawDay, name, rawYear] = match;
  const day = Number(rawDay), year = Number(rawYear);
  const publishedMonth = name.toLowerCase().split('/').at(-1)?.trim() ?? '';
  const month = months[language].indexOf(publishedMonth);
  if (month < 0) return;
  return calendarDate(year, month, day);
}

function calendarDate(year: number, month: number, day: number): string | undefined {
  const date = new Date(Date.UTC(year, month, day));
  if (date.getUTCDate() === day && date.getUTCMonth() === month && date.getUTCFullYear() === year) return date.toISOString().slice(0, 10);
}

function factSheetHit(html: string, url: URL, query: SearchQuery): HealthHit | undefined {
  const nodes = elements(parse(html));
  const header = nodes.find(node => attribute(node, 'class')?.split(/\s+/).includes('sf-item-header-wrapper'));
  if (!header) return;
  const children = elements(header);
  const heading = children.find(node => node.tagName === 'h1');
  const title = heading && healthPlain(elementText(heading), 240);
  if (!title) return;
  const dateNode = children.find(node => attribute(node, 'class')?.split(/\s+/).includes('timestamp'));
  const publishedAt = dateNode && factSheetDate(elementText(dateNode), query.language);
  const article = nodes.find(node => node.tagName === 'article' && attribute(node, 'class')?.split(/\s+/).includes('sf-detail-body-wrapper'));
  const terms = searchTokens(query.retrievalQuestion);
  const passages = (article ? elements(article) : []).filter(node => node.tagName === 'p' || node.tagName === 'li')
    .map(node => elementText(node)).filter(Boolean);
  const excerpt = passages.map(text => ({ text, score: score(terms, text) }))
    .sort((first, second) => second.score - first.score)[0]?.text
    ?? nodes.find(node => node.tagName === 'meta' && attribute(node, 'name') === 'description')?.attrs.find(attr => attr.name === 'content')?.value;
  if (!excerpt) return;
  return { title, url: url.href, snippet: snippet(excerpt), sourceOrganization, ...(publishedAt && { publishedAt }) };
}

function rssField(item: string, name: 'title' | 'link' | 'description' | 'pubDate'): string {
  const text = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(item)?.[1]?.trim() ?? '';
  return text.startsWith('<![CDATA[') && text.endsWith(']]>') ? text.slice(9, -3) : healthPlain(text, 2_500);
}

function newsPublicationDate(url: URL, feedDate: string, language: Language): string | undefined {
  // The English path date matches the article byline even when RSS pubDate is later.
  // https://www.who.int/news/item/05-10-2020-covid-19-disrupting-mental-health-services-in-most-countries-who-survey (2026-11-27)
  const englishPathDate = language === 'en' ? /\/(\d{2})-(\d{2})-(\d{4})-/.exec(url.pathname) : null;
  if (englishPathDate) {
    const [, day, month, year] = englishPathDate;
    return calendarDate(Number(year), Number(month) - 1, Number(day));
  }
  const published = Date.parse(feedDate);
  if (Number.isFinite(published)) return new Date(published).toISOString().slice(0, 10);
}

function rssHits(body: string, language: Language): HealthHit[] {
  xmlDocument(body, 'rss');
  if (!/<channel>[\s\S]*<\/channel>/.test(body)) throw new SearchProviderFailure('invalid_response');
  const hits: HealthHit[] = [];
  for (const [, item] of body.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const url = whoUrl(rssField(item, 'link'), newsPath);
    if (!url || (newsPath.exec(url.pathname)?.[1] ?? 'en') !== language) continue;
    const title = healthPlain(rssField(item, 'title'), 240);
    const text = snippet(rssField(item, 'description'));
    if (!title || !text) continue;
    const publishedAt = newsPublicationDate(url, rssField(item, 'pubDate'), language);
    hits.push({ title, url: url.href, snippet: text, sourceOrganization, ...(publishedAt && { publishedAt }) });
  }
  return hits;
}

export function createWhoEditorialProviders(request: HealthRequester, now: () => number): PlannedProvider[] {
  let sitemap: (FactSheetIndex & { until: number; arabicLinks?: { url: URL; label: string }[] }) | undefined;
  return [{
    name: 'WHO Fact Sheets',
    coverage: 'web',
    accessBasis: 'public_search',
    planned: { domains: ['health'], languages: ['ar', 'en'], access: 'sitemap', contract, hosts: ['www.who.int'] },
    supports: query => supportsWhoSite(query) && (isWhoHealthQuery(query) || query.sites.length > 0),
    async search(query, limit, signal) {
      if (!supportsWhoSite(query)) return [];
      const topic = query.language === 'ar' ? englishHealthTopic(query.retrievalQuestion) : undefined;
      const terms = subjectTerms(topic ?? query.retrievalQuestion);
      if (!terms.length) return [];
      if (!sitemap || sitemap.until <= now()) {
        const body = await request(factSheetSitemap, signal, { gzip: true, allowAttachment: true, maxBytes: sitemapMaxBytes });
        sitemap = { ...factSheetUrls(body), until: now() + sitemapTtl };
      }
      let links = sitemap.urls.filter(url => (factSheetPath.exec(url.pathname)?.[1] ?? 'en') === query.language)
        .map(url => ({ url, label: url.pathname.split('/').filter(Boolean).at(-1) ?? '' }));
      if (query.language === 'ar' && !topic && sitemap.arabicIndex) {
        const index = sitemap;
        const url = sitemap.arabicIndex;
        index.arabicLinks ??= arabicFactSheetLinks(await request(url, signal, { accept: 'text/html' }), url);
        links = index.arabicLinks;
      }
      const matches = links.map(({ url, label }) => ({ url, label, relevance: score(terms, label) }))
        .filter(item => item.relevance > 0)
        .sort((first, second) => second.relevance - first.relevance || first.label.length - second.label.length);
      const hits: HealthHit[] = [];
      for (const { url } of matches.slice(0, Math.min(factSheetReadLimit, healthLimit(limit)))) {
        const html = await request(url, signal, { accept: 'text/html' });
        const hit = factSheetHit(html, url, query);
        if (hit) hits.push(hit);
      }
      return hits;
    },
  }, {
    name: 'WHO News',
    coverage: 'web',
    accessBasis: 'public_search',
    planned: { domains: ['health'], languages: ['ar', 'en'], access: 'feed', contract, hosts: ['www.who.int'] },
    supports: query => supportsWhoSite(query) && (query.timeSensitive || /\bnews\b|أخبار|اخبار/iu.test(query.question))
      && (isWhoHealthQuery(query) || query.sites.length > 0),
    async search(query, limit, signal) {
      if (!supportsWhoSite(query)) return [];
      const body = await request(newsFeeds[query.language], signal, { accept: 'application/rss+xml', maxBytes: newsMaxBytes });
      const terms = subjectTerms(query.retrievalQuestion);
      return rssHits(body, query.language)
        .map(hit => ({ hit, relevance: 2 * score(terms, hit.title) + score(terms, hit.snippet) }))
        .filter(item => !terms.length || item.relevance > 0)
        .sort((first, second) => second.relevance - first.relevance
          || (second.hit.publishedAt ?? '').localeCompare(first.hit.publishedAt ?? ''))
        .slice(0, healthLimit(limit))
        .map(item => item.hit);
    },
  }];
}
