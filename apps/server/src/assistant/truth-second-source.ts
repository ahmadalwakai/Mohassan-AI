import { isIP } from 'node:net';
import { canonicalUrl, publicSearchScan, publicSearchText, safeResumeUrl, type SearchHit } from '@mohassan/browser';
import type { CommandChatConfig } from '../command-chat.js';
import { isDisambiguationPage, isDisambiguationTitle } from './answer-check.js';
import { readableOverHttp } from './hands.js';
import { classifyPage, pageCacheKey, PAGE_TTL_MS } from './page-cache.js';
import { describeSearchDestination } from './public-query-provenance.js';

type Source = { readonly url: string; readonly quote: string; readonly title?: string };
type Candidate = Pick<SearchHit, 'url'> & Partial<Pick<SearchHit, 'title'>>;

export interface SecondSourceInput {
  ownerId: string;
  /** Sources that already support the answer. */
  pages: readonly Source[];
  /** Prior public search results for this question, supplied in their ranked order. */
  candidates: readonly Candidate[];
  /** Other pages already inspected while answering the question. */
  observedUrls?: readonly string[];
  signal?: AbortSignal;
  live?: boolean;
}

const MAX_CANDIDATES = 8;
const MAX_CACHE_ENTRIES = 128;
const MAX_QUOTE_CHARS = 50_000;
const READ_DEADLINE_MS = 2_000;
const COPIED_PASSAGE_WORDS = 24;

function publisher(value: string): string | undefined {
  const url = URL.parse(value);
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
  const host = url.hostname.toLowerCase().replace(/\.$/u, '');
  const labels = host.split('.');
  if (labels.length < 2 || isIP(host)) return;
  // Common country-code suffixes, e.g. co.uk and com.au. Comparing the label
  // across suffixes also groups publishers that operate country-specific sites.
  const delegated = labels.length > 2 && /^[a-z]{2}$/u.test(labels.at(-1)!)
    && /^(?:ac|asn|asso|co|com|edu|firm|gen|go|gob|gov|id|ind|ltd|mil|ne|net|nom|or|org|plc|res|sch|web)$/u.test(labels.at(-2)!);
  const name = labels.at(delegated ? -3 : -2);
  return /^(?:wikipedia|wikimedia|wikidata|wikinews|wiktionary|wikisource|wikiquote|wikibooks|wikiversity|wikivoyage|mediawiki)$/u.test(name ?? '') ? 'wikimedia' : name;
}

function words(quote: string): string[] {
  return quote.slice(0, MAX_QUOTE_CHARS).normalize('NFKC').toLowerCase().replace(/[\p{M}\u0640]/gu, '').match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Different publisher families and no long verbatim paragraph shared by the sources. */
export function independentTruthPages(left: Source, right: Source): boolean {
  const leftUrl = eligibleUrl(left.url), rightUrl = eligibleUrl(right.url);
  const first = leftUrl && publisher(leftUrl), second = rightUrl && publisher(rightUrl);
  if (!first || !second || first === second) return false;
  const original = words(left.quote), candidate = words(right.quote);
  if (original.length < COPIED_PASSAGE_WORDS || candidate.length < COPIED_PASSAGE_WORDS) return true;
  const passages = new Set<string>();
  for (let offset = 0; offset <= original.length - COPIED_PASSAGE_WORDS; offset++) {
    passages.add(original.slice(offset, offset + COPIED_PASSAGE_WORDS).join(' '));
  }
  for (let offset = 0; offset <= candidate.length - COPIED_PASSAGE_WORDS; offset++) {
    if (passages.has(candidate.slice(offset, offset + COPIED_PASSAGE_WORDS).join(' '))) return false;
  }
  return true;
}

function eligibleUrl(value: string): string | null {
  if (value.length > 2500) return null;
  const url = URL.parse(value);
  if (!url) return null;
  url.hash = '';
  const safe = safeResumeUrl(url.href);
  if (!safe || !publisher(safe)) return null;
  const scanned = publicSearchScan(safe);
  if (publicSearchText(scanned) !== scanned) return null;
  const destination = describeSearchDestination(safe);
  return destination.knownPublicEngine || destination.searchEndpoint ? null : safe;
}

function comparableUrl(url: string): string | null {
  const parsed = URL.parse(url);
  if (!parsed) return null;
  parsed.hostname = parsed.hostname.replace(/\.$/u, '');
  try { return pageCacheKey(canonicalUrl(parsed.href)); } catch { return pageCacheKey(parsed.href); }
}

function boundedQuote(text: string): string {
  if (text.length <= MAX_QUOTE_CHARS) return text.trim();
  const prefix = text.slice(0, MAX_QUOTE_CHARS);
  const end = Math.max(prefix.lastIndexOf('. '), prefix.lastIndexOf('! '), prefix.lastIndexOf('? '), prefix.lastIndexOf('؟'), prefix.lastIndexOf('\n'));
  return end < 0 ? '' : prefix.slice(0, end + 1).trim();
}

/** Uses the host's existing robots-aware HTTP reader for at most one public result. */
export function createTruthSecondSource(options: { readPage?: CommandChatConfig['readPage']; now?: () => number }) {
  const { readPage, now = Date.now } = options;
  const cache = new Map<string, { page: Source; expiresAt: number }>();
  return async ({ ownerId, pages, candidates, observedUrls = [], signal, live }: SecondSourceInput): Promise<Source | null> => {
    if (!readPage || signal?.aborted || !ownerId || !pages.length || pages.some(page => !eligibleUrl(page.url))) return null;
    const observed = new Set([...observedUrls, ...pages.map(page => page.url)].map(comparableUrl));
    const publishers = new Set(pages.map(page => publisher(page.url)));
    const urls = candidates.slice(0, MAX_CANDIDATES).flatMap(candidate => {
      if (candidate.title && isDisambiguationTitle(candidate.title)) return [];
      const url = eligibleUrl(candidate.url);
      return url && !observed.has(comparableUrl(url)) && !publishers.has(publisher(url)) ? [url] : [];
    });
    const url = urls[0];
    if (!url) return null;

    const key = JSON.stringify([ownerId, comparableUrl(url)]);
    const cached = live ? undefined : cache.get(key);
    if (cached) {
      cache.delete(key);
      if (cached.expiresAt > now()) {
        cache.set(key, cached);
        return !observed.has(comparableUrl(cached.page.url)) && pages.every(page => independentTruthPages(page, cached.page)) ? cached.page : null;
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), READ_DEADLINE_MS);
    const readSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let resolveAbort: () => void;
    const abort = new Promise<null>(resolve => { resolveAbort = () => resolve(null); });
    readSignal.addEventListener('abort', resolveAbort!, { once: true });
    try {
      const result = await Promise.race([abort, readPage(url, readSignal, { live })]);
      if (readSignal.aborted || !result || result === 'disallowed' || result.status !== 200) return null;
      const finalUrl = eligibleUrl(result.url);
      if (!finalUrl || observed.has(comparableUrl(finalUrl)) || publishers.has(publisher(finalUrl))) return null;
      const quote = boundedQuote(result.text);
      if (!readableOverHttp(quote) || isDisambiguationPage({ title: result.title, text: quote })) return null;
      const page = { url: finalUrl, quote, title: result.title };
      if (!live) {
        const time = now(), fetchedAt = result.fetchedAt ? Date.parse(result.fetchedAt) : time;
        const expiresAt = Math.min(time, fetchedAt) + PAGE_TTL_MS[classifyPage(page.url)];
        if (expiresAt > time) {
          if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
          cache.set(key, { page, expiresAt });
        }
      }
      return pages.every(primary => independentTruthPages(primary, page)) ? page : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
      readSignal.removeEventListener('abort', resolveAbort!);
    }
  };
}
