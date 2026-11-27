import { SafeNetwork, type SafeResponse } from '../../network.js';
import type { SearchHit } from '../../research.js';
import { SearchProviderFailure, searchRetryAfter, type SearchQuery } from '../providers.js';
import { RobotsPolicy } from '../robots.js';
import type { PlannedProvider } from '../source-plan.js';
import { matchStatisticsCountry } from './statistics-countries.js';
import { IMF_TERMS, imfStatistic } from './statistics-imf.js';
import { matchStatisticsIndicator } from './statistics-indicators.js';
import type { StatisticsObservation } from './statistics-types.js';
import { WORLD_BANK_TERMS, worldBankStatistic } from './statistics-world-bank.js';

const CHECKED = '2026-11-27';
const REQUEST_SPACING_MS = 1_000;
const MAX_BYTES = 256_000;
const numberFormat = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 21 });

type Gate = { active: boolean; next: number };
const gates = new WeakMap<SafeNetwork, Map<string, Gate>>();

function requestsFor(network: SafeNetwork, origin: string, now: () => number) {
  let networkGates = gates.get(network);
  if (!networkGates) gates.set(network, networkGates = new Map());
  let gate = networkGates.get(origin);
  if (!gate) networkGates.set(origin, gate = { active: false, next: 0 });
  const state = gate;
  const allowedOrigins = [origin];

  function retryFailure(response: SafeResponse) {
    const retry = response.headers['retry-after'];
    if (response.status !== 429 && (response.status !== 503 || retry === undefined)) return undefined;
    const receivedAt = now();
    const delay = searchRetryAfter(retry, receivedAt);
    state.next = Math.max(state.next, receivedAt + delay);
    return new SearchProviderFailure(response.status === 429 ? 'rate_limited' : 'unavailable', delay);
  }

  // RobotsPolicy interprets robots responses itself. Keep any HTTP backoff from the same origin.
  let robotsFailure: SearchProviderFailure | undefined;
  const robotsNetwork = new SafeNetwork(network.policy);
  robotsNetwork.request = async (url, options) => {
    const response = await network.request(url, { ...options, allowedOrigins });
    robotsFailure = retryFailure(response);
    return response;
  };
  const robots = new RobotsPolicy(robotsNetwork, now);

  return {
    host: new URL(origin).hostname,
    cooldownMs: () => Math.max(0, state.next - now()),
    async request(url: URL, signal: AbortSignal): Promise<unknown> {
      signal.throwIfAborted();
      const wait = state.next - now();
      if (state.active || wait > 0) {
        throw new SearchProviderFailure('rate_limited', state.active ? Math.max(REQUEST_SPACING_MS, wait) : wait);
      }
      state.active = true;
      state.next = now() + REQUEST_SPACING_MS;
      try {
        await robots.assertAllowed(url.href, signal);
        const response = await network.request(url.href, {
          allowedOrigins, signal, maxBytes: MAX_BYTES, headers: { accept: 'application/json' },
        });
        const backoff = retryFailure(response);
        signal.throwIfAborted();
        if (backoff) throw backoff;
        if (response.status !== 200) throw new SearchProviderFailure('unavailable');
        const type = response.headers['content-type'] ?? '';
        const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(type)?.[1];
        if (!/^application\/json(?:\s*;|$)/i.test(type) || charset && !/^utf-?8$/i.test(charset)
          || response.body.length > MAX_BYTES) throw new SearchProviderFailure('invalid_response');
        try {
          return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.body));
        } catch {
          throw new SearchProviderFailure('invalid_response');
        }
      } catch (error) {
        signal.throwIfAborted();
        if (robotsFailure) throw robotsFailure;
        if (error instanceof SearchProviderFailure) throw error;
        throw new SearchProviderFailure('unavailable');
      } finally {
        robotsFailure = undefined;
        state.active = false;
      }
    },
  };
}

const projectionPattern = /\b(?:forecasts?|projections?|projected|projecting|predictions?|predicted|next year)\b|توقع|تنبؤ|العام المقبل|السنة المقبلة|العام القادم|السنة القادمة/iu;
const yearPatterns = /(?<![\p{L}\p{N}])(?:18|19|20|21)\d{2}(?![\p{L}\p{N}])/gu;

function lookup(query: SearchQuery) {
  const indicator = matchStatisticsIndicator(query.question);
  if (!indicator) return undefined;
  const country = matchStatisticsCountry(query.question);
  if (!country) return undefined;
  const digits = query.question.replace(/[٠-٩۰-۹]/gu, character => String(character.charCodeAt(0) & 15));
  const years = new Set(digits.match(yearPatterns)?.map(Number));
  if (years.size > 1) return undefined;
  return { country, indicator, year: years.values().next().value, projection: projectionPattern.test(query.question) };
}

function hit(query: SearchQuery, label: string, country: NonNullable<ReturnType<typeof matchStatisticsCountry>>, observation: StatisticsObservation): SearchHit {
  const ar = query.language === 'ar';
  const name = country[query.language];
  const alias = country.matched.toLowerCase() === name.toLowerCase() ? '' : ` (${country.matched})`;
  const title = `${label} — ${name}${alias}`;
  const value = numberFormat.format(observation.value);
  const unit = observation.unit[query.language];
  const qualifier = observation.projection ? (ar ? ' (توقع)' : ' (projection)')
    : observation.estimate ? (ar ? ' (قد تشمل البيانات تقديرات صندوق النقد الدولي)' : ' (data may include IMF staff estimates)') : '';
  return {
    title, url: observation.url,
    snippet: ar
      ? `${title} في ${observation.year} بلغ ${value} ${unit}${qualifier}. المصدر ${observation.source}.`
      : `${title} in ${observation.year} was ${value} ${unit}${qualifier}. Source ${observation.source}.`,
  };
}

export function statisticsProviders(network: SafeNetwork, now: () => number): PlannedProvider[] {
  const worldBank = requestsFor(network, 'https://api.worldbank.org', now);
  const imf = requestsFor(network, 'https://www.imf.org', now);
  type Lookup = NonNullable<ReturnType<typeof lookup>>;

  function provider(
    name: string, terms: string, resultHost: string, client: ReturnType<typeof requestsFor>,
    supportsIndicator: (request: Lookup) => boolean,
    searchStatistic: (request: Lookup, signal: AbortSignal) => Promise<StatisticsObservation | undefined>,
  ): PlannedProvider {
    function supported(query: SearchQuery) {
      if (query.sites.length && !query.sites.some(site => resultHost === site || resultHost.endsWith(`.${site}`))) {
        return undefined;
      }
      const request = lookup(query);
      return request && supportsIndicator(request) ? request : undefined;
    }
    return {
      name, coverage: 'web', accessBasis: 'documented_api',
      planned: {
        domains: ['official_statistics'], languages: ['ar', 'en'], access: 'documented_api',
        contract: { url: terms, checked: CHECKED }, hosts: [...new Set([resultHost, client.host])],
      },
      cooldownMs: client.cooldownMs,
      supports: query => supported(query) !== undefined,
      async search(query, limit, signal) {
        signal.throwIfAborted();
        const request = supported(query);
        if (!request || limit < 1) return [];
        const observation = await searchStatistic(request, signal);
        signal.throwIfAborted();
        return observation ? [hit(query, request.indicator[query.language], request.country, observation)] : [];
      },
    };
  }

  return [
    provider('World Bank', WORLD_BANK_TERMS, 'data.worldbank.org', worldBank,
      ({ indicator, projection }) => Boolean(indicator.worldBank) && !projection,
      ({ indicator, country, year }, signal) => worldBankStatistic(worldBank.request, country, indicator, signal, year)),
    provider('IMF DataMapper', IMF_TERMS, 'www.imf.org', imf,
      ({ indicator }) => Boolean(indicator.imf),
      ({ indicator, country, year, projection }, signal) =>
        imfStatistic(imf.request, country, indicator, signal, year, new Date(now()).getUTCFullYear(), projection)),
  ];
}
