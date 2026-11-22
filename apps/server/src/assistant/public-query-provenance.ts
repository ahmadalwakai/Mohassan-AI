import { publicSearchScan, publicSearchText } from '@mohassan/browser';

export const MAX_PUBLIC_QUERY_TERMS = 512;
export const MAX_PUBLIC_QUERY_LENGTH = 500;
export const MAX_PUBLIC_QUERY_SOURCE_LENGTH = 8000;
const MAX_PUBLIC_SOURCE_ITEMS = 32;
const MAX_PUBLIC_SOURCE_TOTAL = 64_000;
const MAX_TERM_LENGTH = 80;

/** Syntax/function words, not arbitrary model-generated synonyms or factual entities. */
const HARMLESS_TERMS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'for', 'in', 'on', 'at', 'to', 'from', 'by', 'with',
  'search', 'official', 'website', 'site', 'source', 'sources',
  'عن', 'في', 'من', 'الي', 'علي', 'و', 'او', 'الموقع', 'الرسمي', 'مصدر', 'مصادر', 'بحث',
]);

function normalise(value: string): string {
  return publicSearchScan(value).normalize('NFKC').replace(/[\u0640\u064b-\u065f\u0670]/gu, '')
    .replace(/[أإآٱ]/gu, 'ا').replace(/ى/gu, 'ي').replace(/ة/gu, 'ه').replace(/’/gu, "'")
    .replace(/[٠-٩]/gu, digit => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/gu, digit => String(digit.charCodeAt(0) - 0x06f0)).toLowerCase();
}
function terms(value: string): string[] {
  return normalise(value).match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu) ?? [];
}
function sensitive(value: string): boolean {
  const scanned = publicSearchScan(value);
  return publicSearchText(scanned) !== scanned;
}
function validStoredTerms(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length <= MAX_PUBLIC_QUERY_TERMS && value.every(item => {
    if (typeof item !== 'string' || item.length < 1 || item.length > MAX_TERM_LENGTH) return false;
    const canonical = terms(item);
    return canonical.length === 1 && canonical[0] === item;
  });
}

/**
 * HOST-ONLY ingestion. publicText must come from explicitly public user context
 * or actual public-search result titles/snippets. A model assertion, private
 * tool output, authenticated page or arbitrary page body is not public evidence.
 * This helper checks bounds and canonical form, not the caller's provenance.
 * Invalid prior state contributes no words. Excessive/new secret-bearing source
 * items are omitted whole, never truncated into a potentially misleading token.
 */
export function mergePublicQueryTerms(existing: unknown, publicText: readonly string[]): string[] {
  const merged = new Set<string>(validStoredTerms(existing) ? existing : []);
  if (!Array.isArray(publicText) || publicText.length > MAX_PUBLIC_SOURCE_ITEMS) return [...merged];
  let length = 0;
  for (const text of publicText) {
    if (typeof text !== 'string' || text.length > MAX_PUBLIC_QUERY_SOURCE_LENGTH || length + text.length > MAX_PUBLIC_SOURCE_TOTAL || sensitive(text)) continue;
    length += text.length;
    for (const token of terms(text)) {
      if (token.length > MAX_TERM_LENGTH) continue;
      merged.delete(token); merged.add(token);
      if (merged.size > MAX_PUBLIC_QUERY_TERMS) merged.delete(merged.values().next().value!);
    }
  }
  return [...merged];
}

export interface GeneratedPublicQueryReview {
  eligible: boolean;
  reason: 'eligible' | 'invalid_request' | 'invalid_query' | 'invalid_public_terms' | 'sensitive_query' | 'unattributed_terms';
  termCount: number;
  unattributedCount: number;
}

/**
 * A necessary provenance check, not a public-source/permission grant. The host
 * must also run the source guard and normal tool/network authority. Every query
 * word needs the current user's literal request, HOST-observed public terms, or
 * the small syntax-word set above. This remains true after intervening turns;
 * the immediate previous source is deliberately not used as absence-of-taint.
 * Results contain counts/codes only, never rejected values or private snippets.
 */
export function reviewGeneratedPublicQuery(request: string, query: string, allowedTerms: unknown = []): GeneratedPublicQueryReview {
  const denied = (reason: GeneratedPublicQueryReview['reason'], termCount = 0, unattributedCount = 0): GeneratedPublicQueryReview => ({ eligible: false, reason, termCount, unattributedCount });
  if (typeof request !== 'string' || !request.trim() || request.length > MAX_PUBLIC_QUERY_SOURCE_LENGTH) return denied('invalid_request');
  if (typeof query !== 'string' || !query.trim() || query.length > MAX_PUBLIC_QUERY_LENGTH) return denied('invalid_query');
  if (!validStoredTerms(allowedTerms)) return denied('invalid_public_terms');
  if (sensitive(query)) return denied('sensitive_query');
  const proposed = [...new Set(terms(query))];
  if (!proposed.length) return denied('invalid_query');
  const allowed = new Set([...terms(request), ...allowedTerms, ...HARMLESS_TERMS]);
  const missing = proposed.filter(token => token.length > MAX_TERM_LENGTH || !allowed.has(token)).length;
  return missing ? denied('unattributed_terms', proposed.length, missing)
    : { eligible: true, reason: 'eligible', termCount: proposed.length, unattributedCount: 0 };
}

const SEARCH_HOSTS = new Set(['google.com', 'google.co.uk', 'bing.com', 'cn.bing.com', 'duckduckgo.com', 'html.duckduckgo.com', 'lite.duckduckgo.com', 'search.brave.com', 'search.yahoo.com', 'ecosia.org', 'startpage.com', 'yandex.com', 'yandex.ru', 'baidu.com', 'm.baidu.com']);
const SEARCH_KEYS = new Set(['q', 'query', 'search', 'search_query']);
const ENGINE_KEYS: ReadonlyArray<readonly [string, readonly string[]]> = [['search.yahoo.com', ['p']], ['yandex.com', ['text']], ['yandex.ru', ['text']], ['baidu.com', ['wd', 'word']]];
const SEARCH_PATH = /(?:^|\/)(?:search(?:[-_]results)?|results|find)(?:\/|\.|$)/iu;

interface SearchDestination {
  knownPublicEngine: boolean;
  searchEndpoint: boolean;
  parameters: URLSearchParams[];
  engineKeys: string[];
}

function searchDestination(value: string): SearchDestination | null {
  if (typeof value !== 'string' || value.length > 2500) throw new Error('PUBLIC_SEARCH_URL_LIMIT');
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  // Public Google search is not Gmail, Docs or Accounts merely because those
  // applications share google.com. The same distinction applies elsewhere.
  const host = url.hostname.toLowerCase().replace(/\.$/u, '').replace(/^www\./u, '');
  const knownPublicEngine = SEARCH_HOSTS.has(host);
  const fragment = url.hash.slice(1), fragmentPath = fragment.includes('?') ? fragment.slice(0, fragment.indexOf('?')) : '';
  const searchPath = SEARCH_PATH.test(publicSearchScan(url.pathname)) || SEARCH_PATH.test(publicSearchScan(fragmentPath));
  const engineKeys = ENGINE_KEYS.filter(([known]) => host === known).flatMap(([, keys]) => [...keys]);
  const hashQuery = fragment.includes('?') ? fragment.slice(fragment.indexOf('?') + 1) : fragment;
  const parameters = [url.searchParams, new URLSearchParams(hashQuery)];
  const operand = parameters.some(group => [...group.keys()].some(rawKey => {
    const key = rawKey.toLowerCase();
    return key === 'search' || key === 'search_query' || knownPublicEngine && (SEARCH_KEYS.has(key) || engineKeys.includes(key));
  }));
  return { knownPublicEngine, searchEndpoint: searchPath || operand, parameters, engineKeys };
}

/** Classification only: neither flag grants navigation or authenticated form authority. */
export function describeSearchDestination(value: string): { knownPublicEngine: boolean; searchEndpoint: boolean } {
  const destination = searchDestination(value);
  return { knownPublicEngine: destination?.knownPublicEngine ?? false, searchEndpoint: destination?.searchEndpoint ?? false };
}

/**
 * Extract all search operands for review, including duplicate parameters and
 * encoded keys. Values are never truncated. Recognises known public engines,
 * structural search/results paths, and explicit search/search_query parameters.
 * An empty result does NOT certify that an arbitrary URL is free of private
 * data: opaque paths, other parameter names and general navigation require the
 * host's existing URL/network/action policy. This is not universal URL DLP.
 */
export function extractPublicSearchQueries(value: string): string[] {
  const destination = searchDestination(value);
  if (!destination) return [];
  const result: string[] = [];
  for (const group of destination.parameters) {
    for (const [rawKey, rawValue] of group) {
      const key = rawKey.toLowerCase();
      if ((!SEARCH_KEYS.has(key) && !destination.engineKeys.includes(key)) || (!destination.knownPublicEngine && !destination.searchEndpoint && key !== 'search' && key !== 'search_query')) continue;
      const query = publicSearchScan(rawValue).trim();
      if (query) result.push(query);
    }
  }
  return result;
}

/** Recognises a field; the host must separately establish its destination/scope. */
export function isSearchEntryElement(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const element = value as { role?: unknown; label?: unknown; field?: unknown; disabled?: unknown };
  if (element.disabled === true || ['password', 'otp', 'card'].includes(String(element.field ?? ''))) return false;
  if (element.role === 'searchbox') return true;
  if (!['textbox', 'combobox'].includes(String(element.role ?? '')) || typeof element.label !== 'string' || element.label.length > 300) return false;
  return /\b(?:search|find)\b|(?:^|\s)(?:بحث|ابحث|البحث)(?=\s|$)/iu.test(normalise(element.label));
}
