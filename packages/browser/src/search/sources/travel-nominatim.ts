import { createHash } from 'node:crypto';
import { BrowserError, SafeNetwork, type SafeResponse } from '../../network.js';
import type { SearchHit } from '../../research.js';
import { publicSearchText } from '../local-index.js';
import { SearchProviderFailure, searchRetryAfter } from '../providers.js';
import { RobotsPolicy } from '../robots.js';
import type { PlannedProvider } from '../source-plan.js';
import { parseTravelQuery } from './travel-query.js';

// Search API and output, checked 2026-11-27:
// https://nominatim.org/release-docs/latest/api/Search/
// https://nominatim.org/release-docs/latest/api/Output/
const ORIGIN = 'https://nominatim.openstreetmap.org';
const USAGE_POLICY = 'https://operations.osmfoundation.org/policies/nominatim/';
// https://www.openstreetmap.org/copyright (checked 2026-11-27).
const ATTRIBUTION = '© OpenStreetMap contributors (ODbL 1.0), https://www.openstreetmap.org/copyright';
const REQUEST_INTERVAL = 1000;
const RESULT_LIMIT = 5;
const CACHE_SIZE = 200;
// Local cache lifetimes. Refresh an empty result sooner than a resolved place.
const PLACE_TTL = 24 * 60 * 60 * 1000;
const EMPTY_TTL = 60 * 1000;
// Nominatim address tags (checked 2026-11-27):
// https://github.com/osm-search/Nominatim/blob/6f81fa6a1bc46ddb1da94fdd60e3f64b152784b5/settings/address-levels.json
const ADMIN_PARTS = [
  'neighbourhood', 'quarter', 'suburb', 'city_district', 'borough', 'hamlet', 'village', 'town', 'city',
  'municipality', 'district', 'county', 'state_district', 'province', 'state', 'region', 'country',
];

// One process-wide limit, including robots requests. Cache misses never queue behind a different search.
let active = false;
let nextRequestAt = -Infinity;
let retryUntil = -Infinity;
let retryKind: 'rate_limited' | 'unavailable' = 'rate_limited';
const cache = new Map<string, { until: number; hits: SearchHit[] }>();

type RequestOptions = NonNullable<Parameters<SafeNetwork['request']>[1]>;

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    function abort() {
      clearTimeout(timer);
      reject(signal?.reason);
    }
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

async function request(network: SafeNetwork, url: string, options: RequestOptions, now: () => number): Promise<SafeResponse> {
  const response = await network.request(url, {
    ...options,
    allowedOrigins: [ORIGIN],
    async beforeDispatch() {
      while (nextRequestAt > now()) await wait(nextRequestAt - now(), options.signal);
      options.signal?.throwIfAborted();
      nextRequestAt = now() + REQUEST_INTERVAL;
    },
  });
  const retry = response.headers['retry-after'];
  if (response.status === 429 || response.status === 503 && retry !== undefined) {
    const receivedAt = now();
    const retryAfterMs = searchRetryAfter(retry, receivedAt);
    retryKind = response.status === 429 ? 'rate_limited' : 'unavailable';
    retryUntil = receivedAt + retryAfterMs;
    throw new SearchProviderFailure(retryKind, retryAfterMs);
  }
  return response;
}

class RobotsNetwork extends SafeNetwork {
  failure?: SearchProviderFailure;

  constructor(private readonly network: SafeNetwork, private readonly now: () => number) {
    super(network.policy);
  }

  override validate(input: string): URL {
    return this.network.validate(input, [ORIGIN]);
  }

  override async request(input: string, options: RequestOptions = {}): Promise<SafeResponse> {
    if (this.validate(input).pathname !== '/robots.txt') throw new SearchProviderFailure('unavailable');
    try {
      const response = await request(this.network, input, options, this.now);
      // An absent file supplies no restrictions. An access or service error does not establish permission.
      if (response.status >= 400 && ![404, 410].includes(response.status)) throw new SearchProviderFailure('unavailable');
      return response;
    } catch (error) {
      if (error instanceof SearchProviderFailure) this.failure = error;
      throw error;
    }
  }
}

function text(value: unknown, limit: number): string {
  return typeof value === 'string' ? publicSearchText(value).replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, limit) : '';
}

function coordinate(value: unknown, max: number): string | null {
  return typeof value === 'string' && /^-?\d{1,3}(?:\.\d{1,18})?$/u.test(value) && Math.abs(Number(value)) <= max ? value : null;
}

function placeHit(value: unknown, language: 'ar' | 'en'): SearchHit {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SearchProviderFailure('invalid_response');
  const place = value as Record<string, unknown>;
  const displayName = text(place.display_name, 600);
  const lat = coordinate(place.lat, 90), lon = coordinate(place.lon, 180);
  if (!displayName || lat === null || lon === null) throw new SearchProviderFailure('invalid_response');

  const osmId = typeof place.osm_id === 'string' || typeof place.osm_id === 'number' ? String(place.osm_id) : '';
  const osmType = place.osm_type;
  const url = (osmType === 'node' || osmType === 'way' || osmType === 'relation') && /^[1-9]\d*$/u.test(osmId)
    ? `https://www.openstreetmap.org/${osmType}/${osmId}`
    : `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}&zoom=14`;

  const address = place.address && typeof place.address === 'object' && !Array.isArray(place.address)
    ? place.address as Record<string, unknown>
    : {};
  const parts = ADMIN_PARTS.map(key => text(address[key], 160)).filter(Boolean);
  const hierarchy = [...new Set(parts)].join(language === 'ar' ? '، ' : ', ').slice(0, 900);
  const location = hierarchy ? `${language === 'ar' ? 'التسلسل الإداري' : 'Administrative hierarchy'}: ${hierarchy}. ` : '';
  const coordinates = `${language === 'ar' ? 'الإحداثيات' : 'Coordinates'}: ${lat}, ${lon}.`;
  return { title: displayName.slice(0, 240), url, snippet: `${displayName}. ${location}${coordinates} ${ATTRIBUTION}` };
}

function placeHits(response: SafeResponse, language: 'ar' | 'en'): SearchHit[] {
  if (!/^application\/json(?:\s*;|$)/iu.test(response.headers['content-type'] ?? '')) {
    throw new SearchProviderFailure('invalid_response');
  }
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.body));
  } catch {
    throw new SearchProviderFailure('invalid_response');
  }
  if (!Array.isArray(data)) throw new SearchProviderFailure('invalid_response');
  return data.slice(0, RESULT_LIMIT).map(place => placeHit(place, language));
}

export function nominatimProvider(network: SafeNetwork, now: () => number): PlannedProvider {
  const robotsNetwork = new RobotsNetwork(network, now);
  const robots = new RobotsPolicy(robotsNetwork, now);
  const agent = network.policy.userAgent?.trim().split(/[\s/]/u, 1)[0] || 'MohassanAI-Research';
  return {
    name: 'OpenStreetMap Nominatim',
    coverage: 'web',
    accessBasis: 'documented_api',
    supports: query => parseTravelQuery(query)?.purpose === 'place',
    planned: {
      domains: ['travel'], languages: ['ar', 'en'], access: 'documented_api',
      contract: { url: USAGE_POLICY, checked: '2026-11-27' },
      hosts: ['nominatim.openstreetmap.org', 'www.openstreetmap.org'],
    },
    cooldownMs: () => Math.max(0, nextRequestAt - now(), retryUntil - now()),
    async search(query, limit, signal) {
      signal.throwIfAborted();
      const place = parseTravelQuery(query);
      if (place?.purpose !== 'place') return [];
      const count = Math.max(1, Math.min(RESULT_LIMIT, Number.isFinite(limit) ? Math.floor(limit) : RESULT_LIMIT));
      const subject = place.subject.replace(/\s+/gu, ' ');
      const key = createHash('sha256').update(JSON.stringify([query.language, subject])).digest('hex');
      const cached = cache.get(key);
      if (cached && cached.until > now()) return cached.hits.slice(0, count).map(hit => ({ ...hit }));
      if (cached) cache.delete(key);

      if (retryUntil > now()) throw new SearchProviderFailure(retryKind, retryUntil - now());
      if (active || nextRequestAt > now()) {
        throw new SearchProviderFailure('rate_limited', Math.max(1, nextRequestAt - now()));
      }
      active = true;
      try {
        const url = new URL('/search', ORIGIN);
        url.search = new URLSearchParams({ q: subject, format: 'jsonv2', addressdetails: '1', limit: String(RESULT_LIMIT),
          'accept-language': query.language }).toString();
        robotsNetwork.failure = undefined;
        // The public host's robots.txt disallowed /search when checked on 2026-11-27.
        // https://nominatim.openstreetmap.org/robots.txt
        await robots.assertAllowed(url.href, signal, agent);
        const response = await request(network, url.href, { signal, maxBytes: 512_000, headers: { accept: 'application/json' } }, now);
        signal.throwIfAborted();
        if (response.status !== 200) throw new SearchProviderFailure('unavailable');
        const hits = placeHits(response, query.language);
        if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value!);
        cache.set(key, { hits, until: now() + (hits.length ? PLACE_TTL : EMPTY_TTL) });
        return hits.slice(0, count).map(hit => ({ ...hit }));
      } catch (error) {
        signal.throwIfAborted();
        if (robotsNetwork.failure) throw robotsNetwork.failure;
        if (error instanceof SearchProviderFailure || error instanceof BrowserError && error.code === 'RESEARCH_ROBOTS_DENIED') throw error;
        throw new SearchProviderFailure('unavailable');
      } finally {
        active = false;
      }
    },
  };
}
