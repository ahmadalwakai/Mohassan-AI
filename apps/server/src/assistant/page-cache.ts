/**
 * Evidence cache for pages read over HTTP (docs/MOHASSAN-DEVELOPMENT-PLAN-2026-11-22.md §5.2, P4).
 *
 * A question answered from a page read a minute ago does not fetch the page again. How long a page may
 * serve depends on what kind of site it is: an encyclopedia article changes rarely, documentation daily,
 * a news front page by the quarter hour. A page read for a live fact (a price, the weather, a score) is
 * never served from here: the caller says so and the cache steps aside. Every entry keeps the time it was
 * fetched, so a reply can say how old its evidence is. Bounded, in memory, per server process.
 */
import type { SelectionBlock } from './selection/page-structure.js';

export interface CachedPage { url: string; title: string; text: string; status: number; fetchedAt: string; blocks?: readonly SelectionBlock[] }
export type PageClass = 'encyclopedia' | 'documentation' | 'news' | 'other';

/** Lifetimes proposed in the plan (§5.2 P4); the owner fixes them after the Phase 2 measurement. */
export const PAGE_TTL_MS: Record<PageClass, number> = {
  encyclopedia: 7 * 24 * 60 * 60_000,
  documentation: 24 * 60 * 60_000,
  news: 15 * 60_000,
  other: 15 * 60_000,
};
const MAX_ENTRIES = 300;
const MAX_TEXT_CHARS = 200_000;

const ENCYCLOPEDIA = /(?:^|\.)(?:wikipedia|wiktionary|wikidata|britannica|marefa)\.(?:org|com)$|(?:^|\.)wikipedia\.org$/i;
const DOCUMENTATION = /^docs?\.|^developer\.|^learn\.|(?:^|\.)readthedocs\.io$|^nodejs\.org$|^developer\.mozilla\.org$|^python\.org$|(?:^|\.)github\.(?:com|io)$|^stackoverflow\.com$|(?:^|\.)stackexchange\.com$/i;
const NEWS = /(?:^|\.)(?:bbc|aljazeera|alarabiya|reuters|apnews|cnn|theguardian|nytimes|skynewsarabia|france24|dw|spa|wam|kuna|alriyadh|okaz|aawsat|alhurra)\.(?:com|co\.uk|net|org|ae|sa|gov\.sa)$|(?:^|\.)news\./i;

export function classifyPage(url: string): PageClass {
  const host = URL.parse(url)?.hostname.toLowerCase() ?? '';
  if (ENCYCLOPEDIA.test(host)) return 'encyclopedia';
  if (DOCUMENTATION.test(host)) return 'documentation';
  if (NEWS.test(host)) return 'news';
  return 'other';
}

/** The cache key: scheme, host and path with the query, without the fragment or a trailing slash. */
export function pageCacheKey(url: string): string | null {
  const parsed = URL.parse(url);
  if (!parsed || !/^https?:$/.test(parsed.protocol)) return null;
  parsed.hash = '';
  parsed.username = '';
  parsed.password = '';
  return parsed.href.replace(/\/$/, '');
}

export function createPageCache(options: { now?: () => number; maxEntries?: number } = {}) {
  const now = options.now ?? Date.now;
  const limit = options.maxEntries ?? MAX_ENTRIES;
  const entries = new Map<string, { page: CachedPage; expiresAt: number }>();
  let hits = 0, misses = 0;
  return {
    /** The cached page, or null when absent, expired, or asked for a live fact. */
    get(url: string, options: { live?: boolean } = {}): CachedPage | null {
      if (options.live) { misses++; return null; }
      const key = pageCacheKey(url);
      const entry = key ? entries.get(key) : undefined;
      if (!entry) { misses++; return null; }
      if (entry.expiresAt <= now()) { entries.delete(key!); misses++; return null; }
      // Refresh the insertion order: the least recently used entry goes first when the cache is full.
      entries.delete(key!);
      entries.set(key!, entry);
      hits++;
      return entry.page;
    },
    /** Stores a readable page under its class's lifetime; a live fact, an empty page or an oversized one is not kept. */
    put(page: Omit<CachedPage, 'fetchedAt'> & { fetchedAt?: string }, options: { live?: boolean } = {}): CachedPage {
      const stored: CachedPage = { ...page, text: page.text.slice(0, MAX_TEXT_CHARS), fetchedAt: page.fetchedAt ?? new Date(now()).toISOString() };
      const key = pageCacheKey(page.url);
      if (options.live || !key || !stored.text.trim() || page.status >= 400) return stored;
      if (entries.size >= limit) entries.delete(entries.keys().next().value!);
      entries.set(key, { page: stored, expiresAt: now() + PAGE_TTL_MS[classifyPage(page.url)] });
      return stored;
    },
    clear(): void { entries.clear(); },
    stats(): { size: number; hits: number; misses: number } { return { size: entries.size, hits, misses }; },
  };
}
export type PageCache = ReturnType<typeof createPageCache>;
