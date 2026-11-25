import { isIP } from 'node:net';
import { SearchEngine, safeResumeUrl, type SearchProvider } from '@mohassan/browser';
import { hostOf, siteName } from '../../activity.js';
import { pageCacheKey } from '../../page-cache.js';
import type { WritingSource } from '../evidence.js';
import { writingUrl } from '../request.js';

export const MAX_EXPLANATION_SOURCES = 5;
const CANDIDATE_LIMIT = 12;
const PARALLEL_READS = 2;
const ADDRESS_CACHE_LIMIT = 128;
const ADDRESS_TTL_MS = 30_000;

interface GatherOptions {
  query: string;
  ownerId: string;
  provider: SearchProvider;
  signal: AbortSignal;
  /** Uses the writing host's original public-query check and search port. */
  search: (limit: number) => Promise<readonly string[] | null>;
  /** Uses the writing host's existing HTTP reader, which already caches successful page reads. */
  read: (url: string) => Promise<WritingSource | null>;
}

interface Address { url: string; publisher: string }
interface CachedAddresses { until: number; addresses: Address[] }

const addressCaches = new WeakMap<SearchProvider, Map<string, CachedAddresses>>();

/** A publisher-domain estimate groups regional mirrors and related subdomains conservatively. */
export function sourceIdentity(source: Pick<WritingSource, 'url'>): string | undefined {
  const url = source.url && writingUrl(source.url);
  if (!url) return undefined;
  const address = new URL(url);
  address.hostname = address.hostname.replace(/\.$/u, '');
  const host = hostOf(address.href);
  const namedSite = siteName(address.href);
  if (namedSite !== host) return namedSite;
  if (isIP(host) || host.startsWith('[')) return host;
  const labels = host.split('.');
  const secondLevelSuffix = labels.at(-1)?.length === 2
    && /^(?:ac|co|com|edu|gov|mil|net|org)$/u.test(labels.at(-2) ?? '');
  return labels.slice(secondLevelSuffix ? -3 : -2).join('.');
}

/** Match copied bodies after layout whitespace changes without treating similar wording as a copy. */
export function sourceBodyIdentity(source: WritingSource): string {
  return source.text.trim().replace(/\s+/gu, ' ');
}

function publicAddress(value: string): string | null {
  const url = writingUrl(value);
  if (!url) return null;
  const address = new URL(url);
  address.hash = '';
  return safeResumeUrl(address.href);
}

function candidates(urls: readonly string[]): Address[] {
  const seen = new Set<string>();
  const publishers = new Set<string>();
  const primary: Address[] = [], alternate: Address[] = [];
  for (const value of urls.slice(0, CANDIDATE_LIMIT)) {
    const url = publicAddress(value);
    if (!url) continue;
    const key = pageCacheKey(url);
    const publisher = sourceIdentity({ url });
    if (!key || !publisher || seen.has(key)) continue;
    seen.add(key);
    const queue = publishers.has(publisher) ? alternate : primary;
    queue.push({ url, publisher });
    publishers.add(publisher);
  }
  return [...primary, ...alternate];
}

async function searchAddresses(options: GatherOptions): Promise<Address[]> {
  // The built-in provider incorporates the current owner's index revision in its cache lookups.
  // Leave that authoritative for normal searches. Cache addresses for injected providers only.
  if (options.provider instanceof SearchEngine) return candidates(await options.search(CANDIDATE_LIMIT) ?? []);
  let cache = addressCaches.get(options.provider);
  if (!cache) {
    cache = new Map();
    addressCaches.set(options.provider, cache);
  }
  const key = JSON.stringify([options.ownerId, options.query]);
  const cached = cache.get(key);
  if (cached && cached.until > Date.now()) return cached.addresses;
  cache.delete(key);
  const addresses = candidates(await options.search(CANDIDATE_LIMIT) ?? []);
  if (addresses.length && !options.signal.aborted) {
    if (cache.size >= ADDRESS_CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    cache.set(key, { until: Date.now() + ADDRESS_TTL_MS, addresses });
  }
  return addresses;
}

/** Read bounded, distinct search results through the guarded writing port. Search hits contribute URLs only. */
export async function gatherExplanationSources(options: GatherOptions): Promise<WritingSource[]> {
  options.signal.throwIfAborted();
  const remaining = (await searchAddresses(options)).slice();
  options.signal.throwIfAborted();
  const publishers = new Set<string>();
  const bodies = new Set<string>();
  const sources: WritingSource[] = [];
  let reads = 0;
  while (remaining.length && reads < MAX_EXPLANATION_SOURCES) {
    options.signal.throwIfAborted();
    const batch: Address[] = [];
    const batchPublishers = new Set<string>();
    for (let index = 0; index < remaining.length && batch.length < Math.min(PARALLEL_READS, MAX_EXPLANATION_SOURCES - reads);) {
      const candidate = remaining[index];
      if (batchPublishers.has(candidate.publisher)) {
        index++;
        continue;
      }
      remaining.splice(index, 1);
      if (!publishers.has(candidate.publisher)) {
        batch.push(candidate);
        batchPublishers.add(candidate.publisher);
      }
    }
    reads += batch.length;
    const results = await Promise.all(batch.map(candidate => options.read(candidate.url)));
    options.signal.throwIfAborted();
    for (const source of results) {
      if (!source?.url || !publicAddress(source.url)) continue;
      const publisher = sourceIdentity(source);
      const body = sourceBodyIdentity(source);
      if (!publisher || !body || publishers.has(publisher) || bodies.has(body)) continue;
      publishers.add(publisher);
      bodies.add(body);
      sources.push(source);
    }
  }
  return sources;
}
