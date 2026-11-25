import { AsyncLocalStorage } from 'node:async_hooks';
import {
  BrowserError, publicSearchScan, publicSearchText, RobotsPolicy, safeResumeUrl, SafeNetwork, SearchEngine, searchRetryAfter,
  SqlSearchStore, type SafeResponse, type SearchProvider,
} from '@mohassan/browser';
import type { LivePlace, MonitorSpec } from '@mohassan/contracts';
import type { Kysely } from 'kysely';
import { parse } from 'parse5';
import { resolvePlace } from '../live-data/places.js';
import { getRateValue } from '../live-data/rates.js';
import { createLiveRequestClient, fetchPublicData } from '../live-data/request.js';
import { getCurrentWeatherMetric } from '../live-data/weather.js';
import type { MonitorObservation } from './evaluation.js';
import { findMonitorDiscoveries, sitemapEntriesForPage, type MonitorDiscoveries, type MonitorDiscoveryCache, type MonitorFeedCache } from './feed-discovery-v2.js';
import { parseMonitorFeedXml } from './feed-xml-v2.js';
import { cleanMonitorText, observePage } from './page.js';
import { observePageV2, type MonitorPageAnchor, type MonitorPageCandidate, type MonitorPageRelocation } from './page-v2.js';

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;
const MAX_PAGE_BYTES = 2_000_000;
const MAX_XML_BYTES = 512 * 1024;
const MAX_SEARCH_RESULTS = 10;
const ROBOTS_CACHE_DURATION_MS = 60 * 60_000;
const MAX_ROBOTS_HOSTS = 200;
const MAX_ROBOTS_DELAY_MS = 30 * 24 * 60 * 60_000;
const TRANSIENT_NETWORK = new Set(['BROWSER_DNS_FAILED', 'BROWSER_FETCH_FAILED']);

export interface MonitorSourceCache {
  url: string;
  etag?: string;
  lastModified?: string;
  anchor?: MonitorPageAnchor;
  discovery?: MonitorDiscoveryCache;
}
export type MonitorReadResult =
  | { kind: 'value'; observation: MonitorObservation; cache?: MonitorSourceCache; publicationTimes?: string[]; relocation?: MonitorPageRelocation }
  | { kind: 'unchanged'; cache?: MonitorSourceCache; publicationTimes?: string[] }
  | { kind: 'clarify'; candidates: MonitorPageCandidate[]; confidence: number; url: string; cache?: MonitorSourceCache }
  | { kind: 'unsafe-target'; confidence: number; url: string }
  | { kind: 'missing'; url?: string }
  | { kind: 'unreachable'; url?: string }
  | { kind: 'deferred'; at: number };

export interface MonitorReadOptions {
  ownerId: string;
  signal?: AbortSignal;
  cache?: MonitorSourceCache;
  preview?: boolean;
  v2?: boolean;
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
  if (!safeResumeUrl(checked.href)) throw new BrowserError('MONITOR_URL_DENIED', 'The source address contains private access material.');
  return checked;
}

function validators(response: SafeResponse, url: string, old?: MonitorSourceCache): MonitorSourceCache {
  const cache: MonitorSourceCache = old ? { ...old } : { url };
  const etag = response.headers.etag;
  const modified = response.headers['last-modified'];
  if (etag && etag.length <= 512 && /^(?:W\/)?"[^"\r\n]*"$/u.test(etag)) cache.etag = etag;
  if (modified && modified.length <= 64 && Number.isFinite(Date.parse(modified))) cache.lastModified = modified;
  return cache;
}

function conditionalHeaders(cache: Pick<MonitorSourceCache, 'etag' | 'lastModified'> | undefined) {
  return {
    ...(cache?.etag && { 'if-none-match': cache.etag }),
    ...(cache?.lastModified && { 'if-modified-since': cache.lastModified }),
  };
}

function publicQuery(query: string): string {
  const normalized = cleanMonitorText(query);
  const decoded = publicSearchScan(normalized);
  if (publicSearchText(normalized) !== normalized || publicSearchText(decoded) !== decoded
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
  const delays = new Map<string, { minimum: number; until: number; sitemap?: string }>();
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
        const sitemap = context?.options.v2 ? /^\s*sitemap\s*:\s*(\S{1,2048})/imu.exec(response.body.toString('utf8'))?.[1] : undefined;
        if (delays.size >= MAX_ROBOTS_HOSTS) delays.delete(delays.keys().next().value!);
        delays.set(originalRobotsHost, { minimum, until: clock() + ROBOTS_CACHE_DURATION_MS, ...(sitemap && { sitemap }) });
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
    return { value, excerpt: publicSearchText(cleanMonitorText(excerpt)).slice(0, 320),
      observedAt: new Date(clock()).toISOString(), ...(url && { url }) };
  }

  async function readXml(raw: string, previous: MonitorDiscoveryCache | undefined, options: MonitorReadOptions):
  Promise<{ cache: MonitorFeedCache; unchanged: boolean } | undefined> {
    try {
      const requestedUrl = validateUrl(network, raw).href;
      let target = requestedUrl;
      for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
        const cached = previous?.documents.find(item => item.url === target);
        const response = await publicNetwork.request(target, {
          signal: options.signal, maxBytes: MAX_XML_BYTES, headers: conditionalHeaders(cached),
        });
        if (REDIRECTS.has(response.status) && response.headers.location) {
          target = validateUrl(network, new URL(response.headers.location, target).href).href;
          continue;
        }
        if ((response.status === 429 || response.status === 503) && response.headers['retry-after']) {
          await options.extendHost?.(new URL(target).hostname, searchRetryAfter(response.headers['retry-after'], clock()));
        }
        if (response.status === 304 && cached && (cached.etag || cached.lastModified)) {
          return { cache: { ...cached, ...validators(response, target, cached), requestedUrl }, unchanged: true };
        }
        if (response.status !== 200) return;
        const text = new TextDecoder('utf-8', { fatal: true }).decode(response.body);
        const data = parseMonitorFeedXml(text);
        if (data) {
          data.entries = data.entries.flatMap(entry => {
            try {
              const url = validateUrl(network, new URL(entry.url, target).href).href;
              if (url.length > 2048) return [];
              const title = entry.title && publicSearchText(cleanMonitorText(entry.title)).slice(0, 160);
              return [{ ...entry, title, url }];
            } catch { return []; }
          });
          return { cache: { ...validators(response, target), requestedUrl, data }, unchanged: false };
        }
        return;
      }
    } catch {
      options.signal?.throwIfAborted();
      // An optional discovery can fail while a page or another discovery stays readable.
    }
  }

  async function readDiscoveredItems(spec: MonitorSpec, target: string, cache: MonitorSourceCache,
    links: MonitorDiscoveries, previous: MonitorDiscoveryCache | undefined, options: MonitorReadOptions): Promise<MonitorReadResult | undefined> {
    const [feed, sitemap] = await Promise.all([
      links.feed ? readXml(links.feed, previous, options) : undefined,
      links.sitemap ? readXml(links.sitemap, previous, options) : undefined,
    ]);
    const sitemapChildren = sitemap?.cache.data.kind === 'index' ? sitemap.cache.data.entries.flatMap(item => {
      try {
        const child = validateUrl(network, new URL(item.url, sitemap.cache.url).href);
        return child.origin === new URL(sitemap.cache.url).origin ? [child.href] : [];
      } catch { return []; }
    }) : [];
    const childLinks = [...new Set(sitemapChildren)].slice(0, 2);
    const submaps = await Promise.all(childLinks.map(link => readXml(link, previous, options)));
    const checked = [feed, sitemap, ...submaps].filter(item => item !== undefined);
    const documents = checked.map(item => item.cache);
    cache.discovery = { links, documents };
    const attempted = [links.feed, links.sitemap, ...childLinks];
    const lostDocument = previous?.documents.some(item => attempted.includes(item.requestedUrl) &&
      !documents.some(document => document.requestedUrl === item.requestedUrl && document.data.kind === item.data.kind));
    if (lostDocument) {
      const deferredAt = storage.getStore()?.deferredAt;
      return deferredAt === undefined ? { kind: 'unreachable', url: target } : { kind: 'deferred', at: deferredAt };
    }
    const validSitemaps = documents.filter(item => item.data.kind === 'sitemap');
    const sitemapEntries = validSitemaps.flatMap(item => sitemapEntriesForPage(item.data.entries, target).map(entry => ({ entry, base: item.url })));
    const validFeed = feed?.cache.data.kind === 'feed' ? feed.cache : undefined;
    const entries = [...(validFeed?.data.entries.map(entry => ({ entry, base: validFeed.url })) ?? []), ...sitemapEntries];
    if (!validFeed && !entries.length) return;
    const unique = new Map<string, { title: string; url: string; published?: string }>();
    for (const { entry, base } of entries) {
      try {
        const url = validateUrl(network, new URL(entry.url, base).href).href;
        if (url.length > 2048 || unique.has(itemIdentity(url))) continue;
        const title = publicSearchText(cleanMonitorText(entry.title ?? '')).slice(0, 160) || url;
        unique.set(itemIdentity(url), { title, url, published: entry.published });
      } catch { /* A private link cannot become evidence. */ }
    }
    const times = [...new Set(entries.flatMap(({ entry }) => entry.published ? [entry.published] : []))].sort().slice(-100);
    const publicationTimes = times.length ? { publicationTimes: times } : {};
    if (checked.every(item => item.unchanged) && previous?.documents.some(item => item.data.kind === 'feed' || item.data.kind === 'sitemap')) {
      return { kind: 'unchanged', cache, ...publicationTimes };
    }
    const selected = [...unique].sort(([, a], [, b]) => (b.published ?? '').localeCompare(a.published ?? '')).slice(0, 100);
    const values = selected.map(([, value]) => value);
    const empty = spec.language === 'ar' ? 'لا توجد عناصر منشورة حالياً.' : 'There are no published items yet.';
    return { kind: 'value', cache, ...publicationTimes, observation: {
      ...observation(values.map(item => item.title), values.map(item => item.title).join(' · ') || empty, values[0]?.url ?? target),
      itemKeys: selected.map(([key]) => key), itemUrls: values.map(item => item.url),
    } };
  }

  async function readPage(
    spec: MonitorSpec & { source: Extract<MonitorSpec['source'], { kind: 'page' }> },
    options: MonitorReadOptions,
  ): Promise<MonitorReadResult> {
    const availability = spec.read.kind === 'status' && !spec.read.label
      && spec.condition.kind === 'equals' && spec.condition.value === 'reachable';
    const discoverItems = options.v2 && spec.read.kind === 'items';
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
          headers: conditionalHeaders(cached),
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
        const cache = validators(response, target, cached);
        if (discoverItems && cache.discovery) {
          const items = await readDiscoveredItems(spec, target, cache, cache.discovery.links, cache.discovery, options);
          if (items) return items;
        }
        return { kind: 'unchanged', cache };
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
      if (options.v2) {
        const at = new Date(clock()).toISOString();
        const document = /^text\/plain/iu.test(contentType) ? undefined : parse(body);
        const cache = validators(response, target);
        if (discoverItems) {
          const policy = delays.get(new URL(target).hostname);
          const discovered = findMonitorDiscoveries(document, target, policy && policy.until > clock() ? policy.sitemap : undefined);
          const publicLink = (address: string | undefined) => {
            try { return address ? validateUrl(network, address).href : undefined; }
            catch { return undefined; }
          };
          const links = { feed: publicLink(discovered.feed), sitemap: publicLink(discovered.sitemap) };
          const items = await readDiscoveredItems(spec, target, cache, links, cached?.discovery, options);
          if (items) return items;
        }
        const result = observePageV2(body, target, contentType, spec, at, options.cache?.anchor, document);
        if (result.kind === 'value') {
          if (result.anchor) cache.anchor = result.anchor;
          return { kind: 'value', observation: result.observation, cache, ...(result.relocation && { relocation: result.relocation }) };
        }
        if (result.kind === 'clarify') return { ...result, cache };
        return result;
      }
      const value = observePage(body, target, contentType, spec, new Date(clock()).toISOString());
      return value ? { kind: 'value', observation: value, cache: validators(response, target) } : { kind: 'missing', url: target };
    }
    return { kind: 'unreachable' };
  }

  async function read(spec: MonitorSpec, options: MonitorReadOptions): Promise<MonitorReadResult> {
    const { source, language } = spec;
    options.signal?.throwIfAborted();
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
            unique.set(itemIdentity(url), { title: publicSearchText(cleanMonitorText(result.title)).slice(0, 160) || url, url });
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
