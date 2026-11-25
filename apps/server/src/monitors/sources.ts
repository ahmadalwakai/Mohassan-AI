import { AsyncLocalStorage } from 'node:async_hooks';
import {
  BrowserError, publicSearchScan, publicSearchText, RobotsPolicy, safeResumeUrl, SafeNetwork, SearchEngine, searchRetryAfter,
  SqlSearchStore, type SafeResponse, type SearchProvider,
} from '@mohassan/browser';
import type { LivePlace, MonitorSpec } from '@mohassan/contracts';
import type { Kysely } from 'kysely';
import { resolvePlace } from '../live-data/places.js';
import { getRateValue } from '../live-data/rates.js';
import { createLiveRequestClient, fetchPublicData } from '../live-data/request.js';
import { getCurrentWeatherMetric } from '../live-data/weather.js';
import { monitorContainsCredentials, monitorSourceContainsCredentials, redactMonitorEvidence } from './credential-privacy.js';
import type { MonitorObservation } from './evaluation.js';
import { cleanMonitorText, observePage } from './page.js';

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;
const MAX_PAGE_BYTES = 2_000_000;
const MAX_SEARCH_RESULTS = 10;
const ROBOTS_CACHE_DURATION_MS = 60 * 60_000;
const MAX_ROBOTS_HOSTS = 200;
const MAX_ROBOTS_DELAY_MS = 30 * 24 * 60 * 60_000;
const TRANSIENT_NETWORK = new Set(['BROWSER_DNS_FAILED', 'BROWSER_FETCH_FAILED']);

export interface MonitorSourceCache { url: string; etag?: string; lastModified?: string }
export type MonitorReadResult =
  | { kind: 'value'; observation: MonitorObservation; cache?: MonitorSourceCache }
  | { kind: 'unchanged'; cache?: MonitorSourceCache }
  | { kind: 'missing'; url?: string }
  | { kind: 'unreachable'; url?: string }
  | { kind: 'deferred'; at: number };

export interface MonitorReadOptions {
  ownerId: string;
  signal?: AbortSignal;
  cache?: MonitorSourceCache;
  preview?: boolean;
  /** A null result admits this logical source check. A time defers it to the shared host's next slot. */
  reserveHost?: (hostname: string, minimumMs?: number) => Promise<number | null>;
  extendHost?: (hostname: string, minimumMs: number) => Promise<void>;
}

type NetworkOptions = NonNullable<Parameters<SafeNetwork['request']>[1]>;
type ReadContext = {
  options: MonitorReadOptions;
  hosts: Map<string, Promise<void>>;
  unreachableRobots: Set<string>;
  deferredAt?: number;
};

function validateUrl(network: SafeNetwork, input: string, allowedOrigins?: readonly string[]): URL {
  const checked = network.validate(input, allowedOrigins);
  if (monitorContainsCredentials(input) || monitorContainsCredentials(checked.href) || !safeResumeUrl(checked.href)) {
    throw new BrowserError('MONITOR_URL_DENIED', 'The source address contains private access material.');
  }
  return checked;
}

function validators(response: SafeResponse, url: string, old?: MonitorSourceCache): MonitorSourceCache {
  const cache: MonitorSourceCache = old ? { ...old } : { url };
  const etag = response.headers.etag;
  const modified = response.headers['last-modified'];
  if (etag && !monitorContainsCredentials(etag) && etag.length <= 512 && /^(?:W\/)?"[^"\r\n]*"$/u.test(etag)) cache.etag = etag;
  if (modified && modified.length <= 64 && Number.isFinite(Date.parse(modified))) cache.lastModified = modified;
  return cache;
}

function publicQuery(query: string): string {
  const normalized = cleanMonitorText(query);
  const decoded = publicSearchScan(normalized);
  if (monitorContainsCredentials(normalized) || publicSearchText(normalized) !== normalized || publicSearchText(decoded) !== decoded
      || (decoded.match(/https?:\/\/\S+/giu) ?? []).some(url => !safeResumeUrl(url))) {
    throw new BrowserError('MONITOR_QUERY_DENIED', 'Use a public search query without access credentials.');
  }
  return normalized;
}

function robotsDelay(body: Buffer, agent: string): number {
  const groups: { agents: string[]; delay: number; hasRule: boolean }[] = [];
  let group: (typeof groups)[number] | undefined;
  for (const raw of body.toString('utf8').split(/\r\n|\n|\r/u)) {
    const [line] = raw.split('#', 1);
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const directive = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim().toLowerCase();
    if (directive === 'user-agent') {
      if (!group || group.hasRule) {
        group = { agents: [], delay: 0, hasRule: false };
        groups.push(group);
      }
      group.agents.push(value);
    } else if (group && ['allow', 'disallow', 'crawl-delay'].includes(directive)) {
      group.hasRule = true;
      if (directive === 'crawl-delay' && /^\d+(?:\.\d+)?$/u.test(value)) {
        group.delay = Math.max(group.delay, Math.min(Math.ceil(Number(value) * 1000), MAX_ROBOTS_DELAY_MS));
      }
    }
  }
  const specific = groups.filter(group => group.agents.includes(agent.toLowerCase()));
  const relevant = specific.length ? specific : groups.filter(group => group.agents.includes('*'));
  return relevant.reduce((delay, group) => Math.max(delay, group.delay), 0);
}

function itemIdentity(raw: string): string {
  const url = new URL(raw);
  for (const key of [...url.searchParams.keys()]) {
    if (/^(?:utm_|fbclid$|gclid$)/iu.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return url.href;
}

export function createMonitorReader({
  db, network = new SafeNetwork(), searchProvider, clock = Date.now,
}: {
  db: Kysely<any>;
  network?: SafeNetwork;
  searchProvider?: SearchProvider;
  clock?: () => number;
}) {
  const storage = new AsyncLocalStorage<ReadContext>();
  const robotsHost = new AsyncLocalStorage<string>();
  const delays = new Map<string, { minimum: number; until: number }>();
  const agent = network.policy.userAgent?.trim().split(/[\s/]/u, 1)[0] || 'MohassanAI-Research';

  async function reserveHost(hostname: string) {
    const context = storage.getStore();
    if (!context?.options.reserveHost) return;
    let reservation = context.hosts.get(hostname);
    if (!reservation) {
      const cached = delays.get(hostname);
      reservation = (cached && cached.until > clock()
        ? context.options.reserveHost(hostname, cached.minimum)
        : context.options.reserveHost(hostname)).then(next => {
        if (next === null) return;
        context.deferredAt = Math.max(next, context.deferredAt ?? 0);
        throw new BrowserError('MONITOR_HOST_DEFERRED', 'The source host is between scheduled checks.', 429);
      });
      context.hosts.set(hostname, reservation);
    }
    await reservation;
  }

  // Robots redirects and content redirects both pass through this host gate.
  // One logical check may read its robots file and requested resource on the same host.
  class HostNetwork extends SafeNetwork {
    override async request(input: string, options: NetworkOptions = {}) {
      const target = validateUrl(network, input, options.allowedOrigins);
      const originalRobotsHost = robotsHost.getStore();
      const context = storage.getStore();
      const response = await network.request(target.href, {
        ...options,
        method: 'GET',
        beforeDispatch: async () => {
          await reserveHost(target.hostname);
          await options.beforeDispatch?.();
        },
      }).catch(error => {
        if (originalRobotsHost && error instanceof BrowserError && TRANSIENT_NETWORK.has(error.code)) {
          context?.unreachableRobots.add(originalRobotsHost);
        }
        throw error;
      });
      if (originalRobotsHost && (response.status === 429 || response.status >= 500)) context?.unreachableRobots.add(originalRobotsHost);
      if (originalRobotsHost && response.status === 200) {
        const minimum = robotsDelay(response.body, agent);
        if (delays.size >= MAX_ROBOTS_HOSTS) delays.delete(delays.keys().next().value!);
        delays.set(originalRobotsHost, { minimum, until: clock() + ROBOTS_CACHE_DURATION_MS });
        if (minimum) await storage.getStore()?.options.extendHost?.(originalRobotsHost, minimum);
      }
      return response;
    }
  }

  const robotsTransport = new HostNetwork(network.policy);
  const robots = new RobotsPolicy(robotsTransport, clock);

  class PublicMonitorNetwork extends HostNetwork {
    override async request(input: string, options: NetworkOptions = {}) {
      const target = validateUrl(network, input, options.allowedOrigins);
      await robotsHost.run(target.hostname, () => robots.assertAllowed(target.href, options.signal, agent));
      return super.request(target.href, options);
    }
  }

  const publicNetwork = new PublicMonitorNetwork(network.policy);
  const search = searchProvider ?? new SearchEngine(publicNetwork, { admission: new SqlSearchStore(db, clock), now: clock });
  const live = createLiveRequestClient({ fetch: (url, init) => fetchPublicData(url, init, publicNetwork), clock });

  function observation(value: MonitorObservation['value'], excerpt: string, url?: string): MonitorObservation {
    return { value, excerpt: redactMonitorEvidence(cleanMonitorText(excerpt)).slice(0, 320),
      observedAt: new Date(clock()).toISOString(), ...(url && { url }) };
  }

  async function readPage(
    spec: MonitorSpec & { source: Extract<MonitorSpec['source'], { kind: 'page' }> },
    options: MonitorReadOptions,
  ): Promise<MonitorReadResult> {
    const availability = spec.read.kind === 'status' && !spec.read.label
      && spec.condition.kind === 'equals' && spec.condition.value === 'reachable';
    let target = validateUrl(network, spec.source.url).href;
    const unavailable = (value: string, ar: string, en: string): MonitorReadResult =>
      ({ kind: 'value', observation: observation(value, spec.language === 'ar' ? ar : en, target) });

    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      const cached = options.cache?.url === target ? options.cache : undefined;
      let response: SafeResponse;
      try {
        response = await publicNetwork.request(target, {
          signal: options.signal,
          maxBytes: MAX_PAGE_BYTES,
          headers: {
            ...(cached?.etag && !monitorContainsCredentials(cached.etag) && { 'if-none-match': cached.etag }),
            ...(cached?.lastModified && { 'if-modified-since': cached.lastModified }),
          },
        });
      } catch (error) {
        options.signal?.throwIfAborted();
        const temporary = error instanceof BrowserError && (TRANSIENT_NETWORK.has(error.code)
          || error.code === 'RESEARCH_ROBOTS_UNAVAILABLE' && storage.getStore()?.unreachableRobots.has(new URL(target).hostname));
        if (availability && options.preview && temporary) {
          return unavailable('unreachable', 'تعذّر الوصول إلى الصفحة العامة.', 'The public page is unreachable.');
        }
        throw error;
      }
      if (REDIRECTS.has(response.status) && response.headers.location) {
        target = validateUrl(network, new URL(response.headers.location, target).href).href;
        continue;
      }
      if ((response.status === 429 || response.status === 503) && response.headers['retry-after']) {
        await options.extendHost?.(new URL(target).hostname, searchRetryAfter(response.headers['retry-after'], clock()));
      }
      if (response.status === 304 && cached && (cached.etag || cached.lastModified)) {
        return { kind: 'unchanged', cache: validators(response, target, cached) };
      }
      if (availability && (response.status === 404 || response.status === 410)) {
        return unavailable('not published', `الصفحة غير منشورة (HTTP ${response.status}).`, `The page is unpublished (HTTP ${response.status}).`);
      }
      if (availability && options.preview && (response.status === 429 || response.status >= 500)) {
        return unavailable('unreachable', `تعذّر الوصول إلى الصفحة العامة (HTTP ${response.status}).`, `The public page is unreachable (HTTP ${response.status}).`);
      }
      const contentType = response.headers['content-type'] ?? '';
      if (response.status < 200 || response.status >= 300 || response.status === 202
        || !/^(?:text\/(?:html|plain)|application\/xhtml\+xml)(?:[;\s]|$)/iu.test(contentType)) {
        return { kind: 'unreachable', url: target };
      }
      const charset = /charset\s*=\s*["']?([^\s;"']+)/iu.exec(contentType)?.[1] ?? 'utf-8';
      const body = new TextDecoder(charset, { fatal: true }).decode(response.body);
      if (/<input\b[^>]{0,1000}\btype\s*=\s*["']?password\b/iu.test(body)
        || /<title[^>]*>\s*(?:just a moment|verify (?:you are|you're) human|access denied|robot check)\b/iu.test(body)) {
        return { kind: 'unreachable', url: target };
      }
      if (availability) {
        const reachable = observePage(body, target, contentType, { source: spec.source, read: { kind: 'main' } }, new Date(clock()).toISOString());
        if (!reachable) return { kind: 'missing', url: target };
        return { kind: 'value', observation: observation('reachable', reachable.excerpt, target), cache: validators(response, target) };
      }
      const value = observePage(body, target, contentType, spec, new Date(clock()).toISOString());
      return value ? { kind: 'value', observation: value, cache: validators(response, target) } : { kind: 'missing', url: target };
    }
    return { kind: 'unreachable' };
  }

  async function read(spec: MonitorSpec, options: MonitorReadOptions): Promise<MonitorReadResult> {
    const { source, language } = spec;
    options.signal?.throwIfAborted();
    if (monitorSourceContainsCredentials(source)) return { kind: 'unreachable' };
    if (source.kind === 'run') {
      const row = await db.selectFrom('chat_runs').select(['status', 'updated_at'])
        .where('owner_id', '=', options.ownerId).where('id', '=', source.runId).executeTakeFirst();
      if (!row) return { kind: 'missing' };
      return { kind: 'value', observation: observation(String(row.status), String(row.status)) };
    }
    const context: ReadContext = { options, hosts: new Map(), unreachableRobots: new Set() };
    return storage.run(context, async () => {
      try {
        if (source.kind === 'page') return await readPage({ ...spec, source }, options);
        if (source.kind === 'currency') {
          const rate = await live.run(scope => getRateValue(scope, source.base, source.quote), options.signal);
          if (!rate) return { kind: 'missing' };
          const feed = language === 'ar' ? 'مرجع البنك المركزي الأوروبي اليومي' : 'ECB daily reference rate';
          return { kind: 'value', observation: observation(Number(rate.value), `1 ${source.base} = ${rate.value} ${source.quote} · ${feed} · ${rate.asOf}`, rate.source) };
        }
        if (source.kind === 'weather') {
          const measured = await live.run(async scope => {
            const place: LivePlace | undefined = source.latitude !== undefined && source.longitude !== undefined
              ? { name: source.location, latitude: source.latitude, longitude: source.longitude, timezone: 'UTC' }
              : await resolvePlace(scope, publicQuery(source.location), language);
            if (!place) return;
            return { place, metric: await getCurrentWeatherMetric(scope, place, source.metric, new Date(clock())) };
          }, options.signal);
          if (!measured) return { kind: 'missing' };
          const { place, metric } = measured;
          if (metric.value === null) return { kind: 'missing' };
          const units = language === 'ar'
            ? { temperature: '°C', precipitation: 'ملم', wind: 'كم/س' }
            : { temperature: '°C', precipitation: 'mm', wind: 'km/h' };
          return { kind: 'value', observation: observation(metric.value, `${place.name} · ${metric.value} ${units[source.metric]} · Open-Meteo · ${metric.at}`, metric.source) };
        }

        const query = publicQuery(source.query);
        // With no owner context the search engine cannot read the private local index.
        const outcome = search instanceof SearchEngine ? await search.execute(query, MAX_SEARCH_RESULTS, options.signal) : undefined;
        const hits = outcome?.hits ?? await search.search(query, MAX_SEARCH_RESULTS, options.signal);
        if (!hits.length && outcome?.failures.length) return context.deferredAt
          ? { kind: 'deferred', at: context.deferredAt } : { kind: 'unreachable' };
        const unique = new Map<string, { title: string; url: string }>();
        for (const result of hits.slice(0, MAX_SEARCH_RESULTS)) {
          try {
            const url = validateUrl(network, result.url).href;
            unique.set(itemIdentity(url), { title: redactMonitorEvidence(cleanMonitorText(result.title)).slice(0, 160) || url, url });
          } catch { /* A private result can never become evidence. */ }
        }
        const values = [...unique.values()];
        const excerpt = values.map(item => item.title).join(' · ') || (language === 'ar' ? 'لا توجد نتائج عامة حالياً.' : 'No public results yet.');
        return { kind: 'value', observation: {
          ...observation(values.map(item => item.title), excerpt, values[0]?.url), itemKeys: [...unique.keys()], itemUrls: values.map(item => item.url),
        } };
      } catch (error) {
        options.signal?.throwIfAborted();
        if (context.deferredAt !== undefined) return { kind: 'deferred', at: context.deferredAt };
        return { kind: 'unreachable' };
      }
    });
  }

  return { read };
}
