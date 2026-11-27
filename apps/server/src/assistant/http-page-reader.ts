import { BrowserError, readableSource, type RobotsPolicy, type SafeNetwork } from '@mohassan/browser';
import { createPageCache } from './page-cache.js';
import { withoutFigures } from './readable-page.js';
import { isWritingPdf, readWritingPdf } from './writing/pdf-source.js';

export function createHttpPageReader(network: SafeNetwork, robots: RobotsPolicy) {
  /**
   * A search result read over HTTP for the model-free hands: robots.txt first, HTML only, a bounded time
   * (READ_PAGE_TIMEOUT_MS is a proposed value; the report counts how often it is hit). Null hands the page to the
   * hidden browser; 'disallowed' skips it there too.
   */
  const READ_PAGE_TIMEOUT_MS = 4000;
  const READ_PAGE_RETRY_TIMEOUT_MS = 10_000;
  // The network's default cap is 2 MB. Measured on 2026-11-22: ar.wikipedia «مصر» 3.01 MB, «المغرب» 3.27 MB, «السعودية»
  // 3.51 MB, en «United States» 2.98 MB; over the cap they fell to the hidden browser (9.7 s for «كم عدد سكان مصر»).
  // Over HTTP the largest took 0.8 s to fetch and 0.3 s to parse. 8 MB leaves room above the largest measured article.
  const READ_PAGE_MAX_BYTES = 8_000_000;
  // Pages read over HTTP are kept by site kind (plan §5.2 P4): an encyclopedia article for a week, documentation
  // for a day, news for a quarter of an hour. A page read for a live fact is fetched every time.
  const pageCache = createPageCache();
  return async (url: string, signal: AbortSignal, options: { live?: boolean; includePdf?: boolean } = {}) => {
    const cached = pageCache.get(url, options);
    if (cached) return cached;
    const combined = AbortSignal.any([signal, AbortSignal.timeout(READ_PAGE_TIMEOUT_MS)]);
    try { await robots.assertAllowed(url, combined); }
    catch (error) {
      if (signal.aborted) throw error;
      return error instanceof BrowserError && error.code === 'RESEARCH_ROBOTS_DENIED' ? 'disallowed' as const : null;
    }
    let response: Awaited<ReturnType<SafeNetwork['request']>>;
    try { response = await network.request(url, { signal: combined, maxBytes: READ_PAGE_MAX_BYTES }); }
    catch (error) {
      if (signal.aborted) throw error;
      // A large article on a busy machine can outlast the 4 s budget; one more try with a longer one is far cheaper
      // than the hidden browser it would otherwise fall back to (32 s measured on 2026-11-22 under full load).
      if (!combined.aborted) return null;
      try { response = await network.request(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(READ_PAGE_RETRY_TIMEOUT_MS)]), maxBytes: READ_PAGE_MAX_BYTES }); }
      catch (retryError) { if (signal.aborted) throw retryError; return null; }
    }
    const type = response.headers['content-type'] ?? '';
    if (options.includePdf && isWritingPdf(response)) return readWritingPdf(response, signal);
    if (response.status >= 400 || !/^(?:text\/html|application\/xhtml\+xml)(?:[;\s]|$)/i.test(type)) return null;
    const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(type)?.[1] ?? 'utf-8';
    let body: string;
    try { body = new TextDecoder(charset, { fatal: true }).decode(response.body); } catch { return null; }
    // Captions are not the article's sentences; joined into the text they glued onto the next one (readable-page.ts).
    const source = readableSource(withoutFigures(body), response.url);
    return pageCache.put({ url: response.url, title: source.title, text: source.text, status: response.status, links: source.links }, { ...options, responseHeaders: response.headers });
  };
}
