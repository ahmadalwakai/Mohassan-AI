import { BrowserError, type SafeNetwork, type SafeResponse } from '../../network.js';
import type { SearchHit } from '../../research.js';
import { safeResumeUrl } from '../../session-state.js';
import { publicSearchScan, publicSearchText } from '../local-index.js';
import { SearchProviderFailure, type SearchQuery } from '../providers.js';
import { canonicalUrl, localSearchSnippet, matchesSearchPhrases, searchTokens } from '../ranking.js';
import { RobotsPolicy } from '../robots.js';
import type { PlannedProvider } from '../source-plan.js';
import { decodeSiteText, homepageLinks, htmlSearchEntries, htmlSource, requiresAccount } from './site-search-html.js';
import { SiteVisit, type SiteAdmission } from './site-search-network.js';
import { expandOpenSearch, feedEntries, openSearchTemplates, sitemapEntries, type OpenSearchTemplate } from './site-search-xml.js';

const TTL_MS = 60 * 60 * 1000;
const QUERY_TIME_MS = 10_000; // Leave time for the search engine's outer deadline.
const MAX_HOSTS_IN_FLIGHT = 4;
const MAX_CACHED_HOSTS = 32;
const MAX_SITEMAPS_PER_QUERY = 3;
const MAX_CACHED_SITEMAPS = 8;
const HTML = 'text/html, application/xhtml+xml';
const FEEDS = 'application/rss+xml, application/atom+xml, application/xml, text/xml';
const DESCRIPTION = 'application/opensearchdescription+xml, application/xml, text/xml';
const SITEMAPS = 'application/xml, text/xml, application/gzip';

type Sitemap = NonNullable<ReturnType<typeof sitemapEntries>>;
type Discovered<T> = { url: string; data: T };
type Cached<T> = { until: number; value: T };
type Home = ReturnType<typeof homepageLinks>;
type SitemapCache = Map<string, Cached<Discovered<Sitemap | null>>>;
type HostState = SiteAdmission & {
  active: boolean;
  homes: Map<string, Cached<Discovered<Home>>>;
  descriptions: Map<string, Cached<Discovered<OpenSearchTemplate[]>>>;
};

function cache<T>(entries: Map<string, Cached<T>>, key: string, value: T, now: number, capacity: number): T {
  entries.delete(key);
  if (entries.size >= capacity) entries.delete(entries.keys().next().value!);
  entries.set(key, { value, until: now + TTL_MS });
  return value;
}

function isHtml(response: SafeResponse): boolean {
  const type = response.headers['content-type'];
  return !type || /^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/i.test(type);
}

function decoded(response: SafeResponse, encoding?: string): string {
  const text = decodeSiteText(response, encoding);
  if (text === undefined) throw new SearchProviderFailure('unavailable');
  if (isHtml(response) && requiresAccount(text)) throw new SearchProviderFailure('needs_account');
  return text;
}

function overlap(query: SearchQuery, ...texts: string[]): number {
  const words = new Set(texts.flatMap(searchTokens));
  return query.tokens.filter(token => words.has(token)).length;
}

function matches(query: SearchQuery, title: string, text: string): boolean {
  return overlap(query, title, text) >= Math.min(3, Math.ceil(query.tokens.length / 2)) && matchesSearchPhrases(query, title, text);
}

function rankSitemap(query: SearchQuery, entries: Sitemap['entries']): Sitemap['entries'] {
  return entries.map(entry => {
    const url = new URL(entry.url);
    return { entry, score: overlap(query, publicSearchScan(url.pathname + url.search)) };
  })
    .sort((left, right) => right.score - left.score || right.entry.updated - left.entry.updated)
    .map(row => row.entry);
}

function asSiteFailure(error: unknown): SearchProviderFailure {
  return error instanceof SearchProviderFailure ? error : new SearchProviderFailure('unavailable');
}

class HostSearch {
  private matchedMethod = false;
  private failures: SearchProviderFailure[] = [];

  constructor(
    private visit: SiteVisit,
    private state: HostState,
    private sitemaps: SitemapCache,
    private now: () => number,
    private signal: AbortSignal,
    private query: SearchQuery,
    private limit: number,
  ) {}

  private async attempt<T>(load: () => Promise<T>): Promise<T | undefined> {
    this.signal.throwIfAborted();
    try { return await load(); }
    catch (error) {
      this.signal.throwIfAborted();
      const failure = asSiteFailure(error);
      if (failure.kind === 'rate_limited' || failure.retryAfterMs > 0) throw failure;
      this.failures.push(failure);
      return undefined;
    }
  }

  private async links(url: string): Promise<Discovered<Home>> {
    const cached = this.state.homes.get(url);
    if (cached && cached.until > this.now()) {
      await this.visit.assertAllowed(url);
      if (cached.value.url !== url) await this.visit.assertAllowed(cached.value.url);
      return cached.value;
    }
    const response = await this.visit.get(url, HTML);
    if (response && !isHtml(response)) throw new SearchProviderFailure('unavailable');
    const value = response ? { url: response.url, data: homepageLinks(decoded(response), response.url) }
      : { url, data: { descriptions: [], feeds: [] } };
    return cache(this.state.homes, url, value, this.now(), 2);
  }

  private scopedLinks(links: string[], base: string): string[] {
    const scoped = links.flatMap(link => this.visit.resolve(link, base) ?? []);
    return [...new Set(scoped)];
  }

  private async description(url: string): Promise<Discovered<OpenSearchTemplate[]>> {
    const cached = this.state.descriptions.get(url);
    if (cached && cached.until > this.now()) {
      await this.visit.assertAllowed(url);
      if (cached.value.url !== url) await this.visit.assertAllowed(cached.value.url);
      return cached.value;
    }
    const response = await this.visit.get(url, DESCRIPTION);
    const value = response ? { url: response.url, data: openSearchTemplates(decoded(response)) } : { url, data: [] };
    return cache(this.state.descriptions, url, value, this.now(), 2);
  }

  private async readHits(entries: SearchHit[], base: string, checkMatch: boolean): Promise<SearchHit[]> {
    const hits = new Map<string, SearchHit>();
    const previousFailures = this.failures.length;
    for (const { title, snippet, url } of entries) {
      if (hits.size >= this.limit) break;
      const target = this.visit.resolve(url, base);
      if (!target || !title || !(checkMatch ? matches(this.query, title, snippet) : matchesSearchPhrases(this.query, title, snippet))) continue;
      const canonical = canonicalUrl(target);
      if (hits.has(canonical)) continue;
      const allowed = await this.attempt(async () => { await this.visit.assertAllowed(target); return true; });
      if (allowed) hits.set(canonical, { title, url: canonical, snippet });
    }
    if (hits.size || this.failures.length === previousFailures) this.matchedMethod = true;
    return [...hits.values()];
  }

  private async openSearch(home: Discovered<Home>): Promise<SearchHit[]> {
    const templates: { template: OpenSearchTemplate; base: string }[] = [];
    for (const url of this.scopedLinks(home.data.descriptions, home.url).slice(0, 2)) {
      const descriptor = await this.attempt(() => this.description(url));
      if (descriptor) templates.push(...descriptor.data.map(template => ({ template, base: descriptor.url })));
    }
    const feedRank = ({ template }: typeof templates[number]) => Number(template.media.includes('html'));
    const searched = new Set<string>();
    for (const { template, base } of templates.sort((a, b) => feedRank(a) - feedRank(b))) {
      if (!this.visit.canFetch) break;
      const expanded = expandOpenSearch(template, this.query, this.limit);
      const url = expanded && this.visit.resolve(expanded, base);
      if (!url || searched.has(url)) continue;
      searched.add(url);
      const found = await this.attempt(async () => {
        const response = await this.visit.get(url, template.media);
        if (!response) return [];
        const text = decoded(response, template.outputEncoding);
        const html = template.media === 'text/html' || template.media === 'application/xhtml+xml';
        if (html && !isHtml(response)) throw new SearchProviderFailure('unavailable');
        const entries = html ? htmlSearchEntries(text, response.url) : feedEntries(text, response.url);
        if (!entries) throw new SearchProviderFailure('unavailable');
        return this.readHits(entries, response.url, html);
      });
      if (found?.length) return found;
    }
    return [];
  }

  private async feeds(home: Discovered<Home>): Promise<SearchHit[]> {
    for (const url of this.scopedLinks(home.data.feeds, home.url).slice(0, 2)) {
      if (!this.visit.canFetch) break;
      const found = await this.attempt(async () => {
        const response = await this.visit.get(url, FEEDS);
        if (!response) return [];
        const entries = feedEntries(decoded(response), response.url);
        if (!entries) throw new SearchProviderFailure('unavailable');
        return this.readHits(entries, response.url, true);
      });
      if (found?.length) return found;
    }
    return [];
  }

  private async sitemap(url: string, conventional: boolean): Promise<Discovered<Sitemap | null>> {
    const cached = this.sitemaps.get(url);
    if (cached && cached.until > this.now()) {
      await this.visit.assertAllowed(url);
      if (cached.value.url !== url) await this.visit.assertAllowed(cached.value.url);
      this.sitemaps.delete(url);
      this.sitemaps.set(url, cached);
      return cached.value;
    }
    const response = await this.visit.get(url, SITEMAPS);
    const data = response && sitemapEntries(decoded(this.visit.unpackSitemap(response)));
    if (response && !data && !(conventional && isHtml(response))) throw new SearchProviderFailure('unavailable');
    return cache(this.sitemaps, url, { url: response?.url ?? url, data: data || null }, this.now(), MAX_CACHED_SITEMAPS);
  }

  private async sitemapCandidates(home: string): Promise<Sitemap['entries']> {
    const published = await this.attempt(() => this.visit.robotsSitemaps(home));
    const conventional = new URL('/sitemap.xml', home).href;
    const queue = this.scopedLinks([...(published ?? []), conventional], home);
    const seen = new Set<string>();
    const candidates: Sitemap['entries'] = [];
    while (queue.length && seen.size < MAX_SITEMAPS_PER_QUERY) {
      const target = queue.shift()!;
      if (seen.has(target) || target === conventional && candidates.length) continue;
      seen.add(target);
      const result = await this.attempt(() => this.sitemap(target, target === conventional && !published?.includes(target)));
      if (!result?.data) continue;
      const entries = result.data.entries.flatMap(entry => {
        const url = this.visit.resolve(entry.url, result.url);
        return url ? [{ ...entry, url }] : [];
      });
      if (result.data.index) queue.unshift(...rankSitemap(this.query, entries).slice(0, MAX_SITEMAPS_PER_QUERY).map(entry => entry.url));
      else if (entries.length) candidates.push(...entries);
      else this.matchedMethod = true;
    }
    return rankSitemap(this.query, candidates);
  }

  private async pages(home: string): Promise<SearchHit[]> {
    const hits = new Map<string, SearchHit>();
    const tried = new Set<string>();
    for (const { url } of await this.sitemapCandidates(home)) {
      if (!this.visit.canFetch || hits.size >= this.limit) break;
      if (tried.has(url)) continue;
      tried.add(url);
      const hit = await this.attempt(async () => {
        const response = await this.visit.get(url, HTML);
        if (!response || !isHtml(response)) return;
        const source = htmlSource(decoded(response));
        const rules = response.headers['x-robots-tag'] ?? '';
        if (!source.indexable || /\b(?:noindex|none|noai)\b/i.test(rules)) throw new SearchProviderFailure('forbidden_by_robots');
        this.matchedMethod = true;
        const allowSnippet = source.snippetAllowed && !/\b(?:nosnippet\b|max-snippet:\s*0\b)/i.test(rules);
        const content = allowSnippet ? `${source.description} ${source.text}`.trim() : '';
        if (!source.title || !matches(this.query, source.title, content)) return;
        const snippet = localSearchSnippet(this.query, source.title, content);
        if (snippet !== null) return { title: source.title, url: canonicalUrl(response.url), snippet };
      });
      if (hit) hits.set(hit.url, hit);
    }
    return [...hits.values()];
  }

  async run(root: string): Promise<SearchHit[]> {
    const home = await this.attempt(() => this.links(root));
    if (home) {
      const open = await this.openSearch(home);
      if (open.length) return open;
      const feed = await this.feeds(home);
      if (feed.length) return feed;
    }
    const hits = await this.pages(home?.url ?? root);
    if (hits.length || this.matchedMethod) return hits;
    throw preferredFailure(this.failures);
  }
}

function preferredFailure(failures: SearchProviderFailure[]): SearchProviderFailure {
  for (const kind of ['rate_limited', 'needs_account', 'forbidden_by_robots', 'unavailable'] as const) {
    const failure = failures.find(item => item.kind === kind);
    if (failure) return failure;
  }
  return new SearchProviderFailure('no_search_method');
}

/** Named-site retrieval through publisher-disclosed OpenSearch, feeds and sitemaps. */
export function siteSearchProviders(network: SafeNetwork, now: () => number): PlannedProvider[] {
  const robots = new RobotsPolicy(network, now);
  const hosts = new Map<string, HostState>();
  // Absolute URLs preserve per-origin scope while a shared cap keeps large indexes bounded in memory.
  const sitemaps: SitemapCache = new Map();

  async function searchHost(host: string, query: SearchQuery, limit: number, signal: AbortSignal): Promise<SearchHit[]> {
    const key = host.replace(/^www\./i, '');
    let state = hosts.get(key);
    if (!state) {
      if (hosts.size >= MAX_CACHED_HOSTS) {
        const evict = [...hosts].find(([, entry]) => !entry.active && Math.max(entry.blockedUntil, entry.nextRequest) <= now());
        if (!evict) throw new SearchProviderFailure('rate_limited');
        hosts.delete(evict[0]);
      }
      state = { active: false, lastRequest: -Infinity, nextRequest: -Infinity, blockedUntil: -Infinity, blockedKind: 'unavailable', homes: new Map(), descriptions: new Map() };
    }
    if (state.active) throw new SearchProviderFailure('rate_limited');
    const backoff = state.blockedUntil - now();
    if (backoff > 0) throw new SearchProviderFailure(state.blockedKind, backoff);
    hosts.delete(key);
    hosts.set(key, state);
    state.active = true;
    try {
      const visit = new SiteVisit(network, robots, state, now, signal, host);
      const root = visit.resolve('/', `https://${host}/`);
      if (!root) throw new SearchProviderFailure('unavailable');
      return await new HostSearch(visit, state, sitemaps, now, signal, query, limit).run(root);
    } finally {
      state.active = false;
    }
  }

  return [{
    name: 'Named site search', coverage: 'web', accessBasis: 'public_search',
    planned: {
      domains: ['general_web'], languages: ['ar', 'en'], access: 'opensearch', hosts: [],
      contract: {
        url: 'https://github.com/dewitt/opensearch/blob/master/opensearch-1-1-draft-6.md',
        // Sitemaps fallback contract: https://www.sitemaps.org/protocol.html (also checked 2026-11-27).
        checked: '2026-11-27',
      },
    },
    supports: query => query.sites.length > 0,
    async search(query, limit, signal) {
      signal.throwIfAborted();
      if (!query.sites.length) return [];
      const publicQuery = query.question.normalize('NFKC').replace(/\p{Cf}/gu, '');
      const scanned = publicSearchScan(publicQuery);
      if (publicSearchText(publicQuery) !== publicQuery || publicSearchText(scanned) !== scanned
          || (scanned.match(/https?:\/\/\S+/gi) ?? []).some(url => !safeResumeUrl(url))) {
        throw new BrowserError('RESEARCH_QUERY_SECRET', 'أزل بيانات الاعتماد من الاستعلام قبل البحث العام.', 400);
      }
      const maximum = Math.max(1, Math.min(20, Number.isFinite(limit) ? Math.floor(limit) : 5));
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), QUERY_TIME_MS);
      const combined = AbortSignal.any([signal, deadline.signal]);
      const pending = [...new Map(query.sites.map(host => [host.replace(/^www\./i, ''), host]))].map(([, host], index) => ({ host, index }));
      const results: (SearchHit[] | SearchProviderFailure)[] = [];
      const aborted = () => finish();
      let finish: () => void;
      const cancellation = new Promise<void>(resolve => { finish = resolve; });
      combined.addEventListener('abort', aborted, { once: true });
      const worker = async () => {
        while (pending.length && !combined.aborted) {
          const { host, index } = pending.shift()!;
          try { results[index] = await searchHost(host, query, maximum, combined); }
          catch (error) { results[index] = asSiteFailure(error); }
        }
      };
      try {
        await Promise.race([Promise.all(pending.slice(0, MAX_HOSTS_IN_FLIGHT).map(worker)), cancellation]);
        signal.throwIfAborted();
        const hits = new Map<string, SearchHit>();
        const failures: SearchProviderFailure[] = [];
        for (const result of results) {
          if (Array.isArray(result)) for (const hit of result) hits.set(hit.url, hit);
          else if (result) failures.push(result);
        }
        if (hits.size) return [...hits.values()].slice(0, maximum);
        if (deadline.signal.aborted) failures.push(new SearchProviderFailure('unavailable'));
        if (failures.length) throw preferredFailure(failures);
        return [];
      } finally {
        clearTimeout(timer);
        combined.removeEventListener('abort', aborted);
      }
    },
  }];
}
