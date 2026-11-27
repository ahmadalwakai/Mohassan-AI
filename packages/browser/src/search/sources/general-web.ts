import { z } from 'zod';
import { BRAVE_WEB_SEARCH_URL, type SafeNetwork, type SafeResponse } from '../../network.js';
import type { SearchHit } from '../../research.js';
import { safeResumeUrl } from '../../session-state.js';
import { publicSearchScan, publicSearchText } from '../local-index.js';
import { plain, SearchProviderFailure, searchRetryAfter, type SearchProviderContext } from '../providers.js';
import { requestsWikipedia } from '../ranking.js';
import { RobotsPolicy } from '../robots.js';
import type { PlannedProvider } from '../source-plan.js';
import { BRAVE_RATE_LIMIT_WINDOW_MS } from '../store.js';

// Request and response fields from Brave's Web Search API reference, checked 2026-11-27.
const CONTRACT_URL = 'https://api-dashboard.search.brave.com/api-reference/web/search/post';
const BRAVE_ORIGIN = new URL(BRAVE_WEB_SEARCH_URL).origin;
const locales = { ar: { search_lang: 'ar', country: 'ALL' }, en: { search_lang: 'en', country: 'US' } } as const;
const envelope = z.object({ type: z.literal('search'), web: z.object({ results: z.array(z.unknown()) }).nullish() });
const webResult = z.object({ title: z.string(), url: z.string(), description: z.unknown().optional(),
  page_age: z.unknown().optional(), age: z.unknown().optional() });

function headerList(value: string | undefined): string[] {
  return value?.split(',').map(part => part.trim()) ?? [];
}

// Windows are aligned by position, with reset values in seconds from receipt.
// https://api-dashboard.search.brave.com/documentation/guides/rate-limiting (checked 2026-11-27)
function quotaCooldown(headers: Record<string, string>): number | undefined {
  const limits = headerList(headers['x-ratelimit-limit']);
  const policies = headerList(headers['x-ratelimit-policy']);
  const remaining = headerList(headers['x-ratelimit-remaining']);
  return headerList(headers['x-ratelimit-reset']).reduce<number | undefined>((longest, reset, index) => {
    const limit = limits[index] || /^(\d+);w=\d+$/.exec(policies[index] ?? '')?.[1];
    if (limit === '0' || remaining[index] !== '0' || !/^\d+$/.test(reset)) return longest;
    return Math.max(longest ?? 0, Math.min(Number(reset) * 1000, BRAVE_RATE_LIMIT_WINDOW_MS));
  }, undefined);
}

export function generalWebProviders(network: SafeNetwork, now: () => number): PlannedProvider[] {
  const key = process.env.BRAVE_SEARCH_API_KEY?.trim();
  const roles = process.env.SEARCH_GENERAL_WEB_ROLES?.trim() || 'owner';
  if (process.env.SEARCH_GENERAL_WEB_PROVIDER?.trim() !== 'brave' || !key || !/^[\x21-\x7e]+$/.test(key)
    || (roles !== 'owner' && roles !== 'all')) return [];

  const robots = new RobotsPolicy(network, now);
  const scannedKey = publicSearchScan(key);
  const containsKey = (text: string) => text.includes(key) || publicSearchScan(text).includes(scannedKey);
  const allowed = (context?: SearchProviderContext) => context?.role === 'owner' || roles === 'all' && context?.role === 'member';
  let nextAllowedAt = 0;
  const cooldownMs = () => Math.max(0, nextAllowedAt - now());

  return [{
    name: 'Brave Search', coverage: 'web', accessBasis: 'documented_api', allowsAccount: allowed, cacheResults: false,
    planned: { domains: ['general_web'], languages: ['ar', 'en'], access: 'documented_api',
      contract: { url: CONTRACT_URL, checked: '2026-11-27' }, hosts: [] },
    supports: (query, context) => allowed(context) && query.intent === 'general' && !query.sites.length && !requestsWikipedia(query),
    cooldownMs,
    async search(query, limit, signal, context) {
      if (!allowed(context) || query.sites.length) return [];
      const q = query.retrievalQuestion;
      const scannedQuery = publicSearchScan(q);
      // Truncating could change a quoted phrase or a search operator.
      if (!q || q.length > 600 || q.split(/\s+/u).length > 75 || containsKey(q) || publicSearchText(scannedQuery) !== scannedQuery) {
        throw new SearchProviderFailure('unavailable');
      }
      const count = Math.max(1, Math.min(20, Number.isFinite(limit) ? Math.floor(limit) : 5));
      const pending = cooldownMs();
      if (pending) throw new SearchProviderFailure('rate_limited', pending);

      const body = JSON.stringify({ q, ...locales[query.language], count, result_filter: ['web'], text_decorations: false });
      let response: SafeResponse;
      try {
        await robots.assertAllowed(BRAVE_WEB_SEARCH_URL, signal);
        response = await network.request(BRAVE_WEB_SEARCH_URL, {
          method: 'POST', body, signal, allowedOrigins: [BRAVE_ORIGIN],
          headers: { accept: 'application/json', 'content-type': 'application/json', 'x-subscription-token': key },
        });
      } catch {
        throw new SearchProviderFailure('unavailable');
      }

      const receivedAt = now();
      const quotaDelay = quotaCooldown(response.headers);
      const retryAfter = response.headers['retry-after'];
      const retryDelay = retryAfter === undefined ? undefined : searchRetryAfter(retryAfter, receivedAt);
      const delay = Math.max(quotaDelay ?? 0, retryDelay ?? 0,
        response.status === 429 && quotaDelay === undefined && retryDelay === undefined ? searchRetryAfter(undefined, receivedAt) : 0);
      nextAllowedAt = Math.max(nextAllowedAt, receivedAt + delay);
      if (response.status === 429) throw new SearchProviderFailure('rate_limited', delay);
      if (response.status !== 200) throw new SearchProviderFailure('unavailable', delay);

      try {
        const parsed = envelope.parse(JSON.parse(response.body.toString('utf8')));
        const hits: SearchHit[] = [];
        for (const candidate of parsed.web?.results ?? []) {
          const item = webResult.safeParse(candidate);
          if (!item.success) continue;
          const { title: rawTitle, url: rawUrl, description, page_age, age } = item.data;
          const title = plain(rawTitle, 240), snippet = plain(description), pageAge = plain(page_age, 80) || plain(age, 80);
          if (!title || [rawUrl, title, snippet, pageAge].some(containsKey)) continue;
          let url: string;
          try { url = network.validate(rawUrl).href; } catch { continue; }
          if (!safeResumeUrl(url, [key])) continue;
          hits.push({ title: publicSearchText(title), url, snippet: publicSearchText(snippet), ...(pageAge ? { pageAge: publicSearchText(pageAge) } : {}) });
          if (hits.length === count) break;
        }
        return hits;
      } catch {
        throw new SearchProviderFailure('invalid_response');
      }
    },
  }];
}
