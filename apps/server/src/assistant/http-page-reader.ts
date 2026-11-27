import { setTimeout as sleep } from 'node:timers/promises';
import { BrowserError, readableSource, RobotsRateLimitError, searchRetryAfter, type RobotsPolicy, type SafeNetwork } from '@mohassan/browser';
import { createPageCache, PAGE_CACHE_MAX_TEXT_CHARS, type CachedPage } from './page-cache.js';
import { withoutFigures } from './readable-page.js';
import type { WritingSource } from './writing/evidence.js';
import { isWritingPdf, readWritingPdf } from './writing/pdf-source.js';

export type RateLimitedPageRead = { kind: 'rate-limited'; retryAfterMs: number };
type ReadOptions = { live?: boolean; includePdf?: boolean };
export type HttpPageEvidence = Omit<CachedPage, 'fetchedAt'> & { fetchedAt?: string; layout?: WritingSource['layout'] };
type PageRead = HttpPageEvidence | RateLimitedPageRead | 'disallowed' | null;
export type HttpPageReader = (url: string, signal: AbortSignal, options?: ReadOptions) => Promise<PageRead>;

export function isRateLimitedPageRead(value: unknown): value is RateLimitedPageRead {
  return value !== null && typeof value === 'object' && 'kind' in value && value.kind === 'rate-limited';
}

const READ_PAGE_TIMEOUT_MS = 4000;
const READ_PAGE_RETRY_TIMEOUT_MS = 10_000;
// Spend at most a quarter of the initial read budget waiting out a rate limit.
const MAX_RATE_LIMIT_WAIT_MS = READ_PAGE_TIMEOUT_MS / 4;
// The network's default cap is 2 MB. Measured on 2026-11-22: ar.wikipedia «مصر» 3.01 MB, «المغرب» 3.27 MB, «السعودية»
// 3.51 MB, en «United States» 2.98 MB; over the cap they fell to the hidden browser (9.7 s for «كم عدد سكان مصر»).
// Over HTTP the largest took 0.8 s to fetch and 0.3 s to parse. 8 MB leaves room above the largest measured article.
const READ_PAGE_MAX_BYTES = 8_000_000;

/** Reads public evidence with robots admission, a bounded HTTP fetch, and host-wide Retry-After handling. */
export function createHttpPageReader(
  network: Pick<SafeNetwork, 'request'>,
  robots: Pick<RobotsPolicy, 'assertAllowed'>,
  { sectioned = process.env.MOHASSAN_SECTIONED_WEB_EVIDENCE === '1' }: { sectioned?: boolean } = {},
): HttpPageReader {
  const textLimit = sectioned ? PAGE_CACHE_MAX_TEXT_CHARS : undefined;
  // Pages read over HTTP are kept by site kind (plan §5.2 P4): an encyclopedia article for a week, documentation
  // for a day, news for a quarter of an hour. A page read for a live fact is fetched every time.
  const pageCache = createPageCache();
  const busyUntil = new Map<string, number>();

  function rememberRateLimit(host: string, header: string | undefined): RateLimitedPageRead {
    const now = Date.now();
    const retryAfterMs = searchRetryAfter(header, now);
    for (const [key, until] of busyUntil) if (until <= now) busyUntil.delete(key);
    busyUntil.set(host, Math.max(busyUntil.get(host) ?? now, now + retryAfterMs));
    return { kind: 'rate-limited', retryAfterMs };
  }

  function coolingDown(host: string): RateLimitedPageRead | null {
    const until = busyUntil.get(host);
    if (until === undefined) return null;
    const retryAfterMs = until - Date.now();
    if (retryAfterMs > 0) return { kind: 'rate-limited', retryAfterMs };
    busyUntil.delete(host);
    return null;
  }

  async function readOnce(url: string, host: string, signal: AbortSignal, options: ReadOptions): Promise<PageRead> {
    signal.throwIfAborted();
    const busy = coolingDown(host);
    if (busy) return busy;
    const combined = AbortSignal.any([signal, AbortSignal.timeout(READ_PAGE_TIMEOUT_MS)]);
    try { await robots.assertAllowed(url, combined); }
    catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof RobotsRateLimitError) return rememberRateLimit(host, error.retryAfter);
      return error instanceof BrowserError && error.code === 'RESEARCH_ROBOTS_DENIED' ? 'disallowed' as const : null;
    }
    signal.throwIfAborted();
    // Another read can receive a 429 while this one is waiting for robots admission.
    const busyAfterRobots = coolingDown(host);
    if (busyAfterRobots) return busyAfterRobots;
    let response: Awaited<ReturnType<SafeNetwork['request']>>;
    try { response = await network.request(url, { signal: combined, maxBytes: READ_PAGE_MAX_BYTES }); }
    catch (error) {
      if (signal.aborted) throw error;
      // A large article on a busy machine can outlast the 4 s budget; one more try with a longer one is far cheaper
      // than the hidden browser it would otherwise fall back to (32 s measured on 2026-11-22 under full load).
      if (!combined.aborted) return null;
      const busyAfterTimeout = coolingDown(host);
      if (busyAfterTimeout) return busyAfterTimeout;
      try { response = await network.request(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(READ_PAGE_RETRY_TIMEOUT_MS)]), maxBytes: READ_PAGE_MAX_BYTES }); }
      catch (retryError) { if (signal.aborted) throw retryError; return null; }
    }
    if (response.status === 429) return rememberRateLimit(host, response.headers['retry-after']);
    const type = response.headers['content-type'] ?? '';
    if (options.includePdf && isWritingPdf(response)) return readWritingPdf(response, signal);
    if (response.status >= 400 || !/^(?:text\/html|application\/xhtml\+xml)(?:[;\s]|$)/i.test(type)) return null;
    const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(type)?.[1] ?? 'utf-8';
    let body: string;
    try { body = new TextDecoder(charset, { fatal: true }).decode(response.body); } catch { return null; }
    // Captions are not the article's sentences; joined into the text they glued onto the next one (readable-page.ts).
    const source = readableSource(withoutFigures(body), response.url, textLimit);
    return pageCache.put({ url: response.url, title: source.title, text: source.text, status: response.status, links: source.links }, { ...options, responseHeaders: response.headers });
  }

  return async (url: string, signal: AbortSignal, options: ReadOptions = {}) => {
    const cached = pageCache.get(url, options);
    if (cached) return cached;
    const host = URL.parse(url)?.hostname.replace(/\.$/u, '') ?? '';
    let waitBudget = MAX_RATE_LIMIT_WAIT_MS;
    async function waitForHost(): Promise<RateLimitedPageRead | null> {
      while (true) {
        signal.throwIfAborted();
        const busy = coolingDown(host);
        if (!busy || busy.retryAfterMs > waitBudget) return busy;
        waitBudget -= busy.retryAfterMs;
        await sleep(busy.retryAfterMs, undefined, { signal });
      }
    }

    const busy = await waitForHost();
    if (busy) return busy;
    const first = await readOnce(url, host, signal, options);
    if (!isRateLimitedPageRead(first)) return first;
    const stillBusy = await waitForHost();
    if (stillBusy) return stillBusy;
    return (await readOnce(url, host, signal, options)) ?? first;
  };
}
