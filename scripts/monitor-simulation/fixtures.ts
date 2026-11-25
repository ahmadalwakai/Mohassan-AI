import { createHash } from 'node:crypto';
import { SafeNetwork, type SearchProvider } from '@mohassan/browser';
import type { MonitorSpec } from '@mohassan/contracts';
import type { Kysely } from 'kysely';
import type { MonitorObservation } from '../../apps/server/src/monitors/evaluation.js';
import type { createMonitorReader } from '../../apps/server/src/monitors/sources.js';

export const minute = 60_000;
export const hour = 60 * minute;
export const day = 24 * hour;
export const week = 7 * day;
const epoch = Date.UTC(2026, 10, 2); // Arbitrary virtual Monday, not a sample of production traffic.
const site = 'https://publisher.example.test';
const runId = '00000000-0000-4000-8000-000000000001';

export const classes = [
  'plain-page', 'structured-offer', 'arabic-page', 'weekly-feed', 'recurring-feed', 'currency', 'weather', 'search', 'run',
] as const;
export const phase2Classes = ['pull-request', 'github-ci', 'github-release', 'pdf-revision', 'visual-noise'] as const;
export type Phase2SourceClass = typeof phase2Classes[number];
export type SourceClass = typeof classes[number] | Phase2SourceClass;
export type SeedBank = 'tuning' | 'held-out';
export const seedCounts = { tuning: 32, 'held-out': 64 } as const;
type Schedule = 'poisson' | 'daily' | 'weekly' | 'burst';

// All parameters describe synthetic scenarios and can be changed without editing the oracle.
export const parameters = {
  noSustainedChangeProbability: 0.2,
  outageProbability: 0.18,
  redirectProbability: 0.35,
  deadlineProbability: 0.3,
  noisePeriodMs: 71 * minute,
  thresholdFlapMs: 23 * minute,
  poissonMeanMs: 5 * hour,
  dailyPhaseMs: 9 * hour,
  dailyJitterMs: 18 * minute,
  weeklyPhaseMs: 5 * day + 11 * hour,
  weeklyJitterMs: 35 * minute,
  burstMeanMs: 40 * hour,
  burstSpacingMs: 45 * minute,
  warmupMs: 48 * hour,
  minOutageMs: 40 * minute,
  maxOutageMs: 110 * minute,
  moveProbability: 0.5,
} as const;

export function random(bank: SeedBank, trial: number, source: SourceClass, replication?: string) {
  const domain = replication ? `${bank}/replication/${replication}` : bank;
  let counter = 0;
  return () => {
    // Counter-mode SHA-256 from FIPS 180-4. Map uint32 samples to open interval (0, 1).
    // https://csrc.nist.gov/pubs/fips/180-4/upd1/final
    const hash = createHash('sha256').update(`mohassan-monitors-simulation/v1/${domain}/${trial}/${source}/${counter++}`).digest();
    return (hash.readUInt32BE() + 0.5) / 2 ** 32;
  };
}

export const pick = (rand: () => number, min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
export const chance = (rand: () => number, probability: number) => rand() < probability;
export const iso = (time: number) => new Date(time).toISOString();
const quote = (price: number) => Number(price.toFixed(3));

function eventTimes(regime: Schedule, rand: () => number, start: number, stop: number): number[] {
  const times: number[] = [];
  function exponential(mean: number) {
    // Integrate a constant hazard to get survival exp(-t/mean); invert at 1-U.
    return Math.ceil(-Math.log1p(-rand()) * mean / minute) * minute;
  }
  switch (regime) {
    case 'poisson':
      for (let time = start + exponential(parameters.poissonMeanMs); time < stop; time += exponential(parameters.poissonMeanMs)) times.push(time);
      break;
    case 'daily':
    case 'weekly': {
      const daily = regime === 'daily';
      const frequency = daily ? day : week;
      const phase = daily ? parameters.dailyPhaseMs : parameters.weeklyPhaseMs;
      const jitter = (daily ? parameters.dailyJitterMs : parameters.weeklyJitterMs) / minute;
      const boundary = epoch + Math.floor((start - epoch) / frequency) * frequency;
      for (let time = boundary + phase; time < stop + jitter * minute; time += frequency) {
        const noisy = time + pick(rand, -jitter, jitter) * minute;
        if (noisy >= start && noisy < stop) times.push(noisy);
      }
      break;
    }
    case 'burst':
      for (let time = start + exponential(parameters.burstMeanMs); time < stop; time += exponential(parameters.burstMeanMs)) {
        const extent = pick(rand, 2, 4);
        for (let i = 0; i < extent; i++) times.push(time + i * parameters.burstSpacingMs);
      }
  }
  return [...new Set(times.filter(time => time < stop))].sort((left, right) => left - right);
}

type Wave = { at: number; value: number };
type Item = { at: number; id: string; title: string };
export interface TruthEvent { at: number; until: number; expected: string | number | boolean }

export interface Scenario {
  sourceClass: SourceClass;
  start: number;
  end: number;
  deadline?: string;
  source: MonitorSpec['source'];
  read: MonitorSpec['read'];
  condition: MonitorSpec['condition'];
  language: MonitorSpec['language'];
  truth: TruthEvent[];
  layoutChangeAt?: number;
  relocationValue?: (at: number) => number;
  lowConfidenceAt?: (at: number) => boolean;
  ports: (clock: () => number) => Parameters<typeof createMonitorReader>[0];
}

function gates(at: number, options: { etag?: boolean; modified?: boolean } = {}) {
  return {
    ...(options.etag && { etag: `"${at}"` }),
    ...(options.modified && { 'last-modified': new Date(at).toUTCString() }),
  };
}

function arabicPrice(value: number, persian: boolean) {
  const digits = persian ? '۰۱۲۳۴۵۶۷۸۹' : '٠١٢٣٤٥٦٧٨٩';
  const [whole, fractional] = value.toFixed(2).split('.');
  const grouping = whole.replace(/\B(?=(?:\d{3})+(?!\d))/gu, '٬');
  return `${grouping}٫${fractional}`.replace(/\d/gu, digit => digits[Number(digit)]);
}

function itemPage(items: readonly Item[]) {
  return `<link rel="alternate" type="application/rss+xml" href="/feed.xml"><main><h1>Press releases</h1><ul>${items.map(item => `<li><a href="/press/${item.id}">${item.title}</a></li>`).join('')}</ul></main>`;
}

function rss(items: readonly Item[]) {
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Press releases</title><link>${site}/watch</link><description>Synthetic press releases</description>${items.map(item => `<item><guid>${site}/press/${item.id}</guid><link>${site}/press/${item.id}</link><title>${item.title}</title><pubDate>${new Date(item.at).toUTCString()}</pubDate></item>`).join('')}</channel></rss>`;
}

function sitemap(items: readonly Item[]) {
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${items.map(item => `<url><loc>${site}/press/${item.id}</loc><lastmod>${iso(item.at)}</lastmod></url>`).join('')}</urlset>`;
}

function ecb(time: number, price: number) {
  return `<gesmes:Envelope xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref" xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01"><Cube><Cube time="${iso(time).slice(0, 10)}"><Cube currency="USD" rate="${price}"/></Cube></Cube></gesmes:Envelope>`;
}

function forecast(at: number, temperature: number) {
  const second = Math.floor(at / 1000);
  const days = Array.from({ length: 7 }, (_, i) => (Math.floor(at / day) + i) * day / 1000);
  return JSON.stringify({
    utc_offset_seconds: 0,
    current: { time: second, temperature_2m: temperature, apparent_temperature: temperature,
      relative_humidity_2m: 60, precipitation: 0, weather_code: 0, wind_speed_10m: 10 },
    hourly: { time: [second], temperature_2m: [temperature], precipitation_probability: [0], weather_code: [0] },
    daily: { time: days, temperature_2m_min: days.map(() => temperature - 4), temperature_2m_max: days.map(() => temperature + 4),
      precipitation_probability_max: days.map(() => 0), weather_code: days.map(() => 0) },
  });
}

export function createScenario(bank: SeedBank, trial: number, sourceClass: SourceClass, replication?: string): Scenario {
  const rand = random(bank, trial, sourceClass, replication);
  const start = epoch + pick(rand, 0, week / minute - 1) * minute;
  const end = start + week;
  const sustainedChange = !chance(rand, parameters.noSustainedChangeProbability);
  const deadline = chance(rand, parameters.deadlineProbability) ? iso(end) : undefined;
  const noiseOffset = pick(rand, 0, 20);
  const redirects = chance(rand, parameters.redirectProbability);
  const outage = chance(rand, parameters.outageProbability);
  const outageStart = start + pick(rand, 4 * hour / minute, (week - 4 * hour) / minute) * minute;
  const outageEnd = outageStart + pick(rand, parameters.minOutageMs / minute, parameters.maxOutageMs / minute) * minute;
  const offlineAt = (at: number) => outage && at >= outageStart && at < outageEnd;
  const moveAt = start + pick(rand, day / minute, 2 * day / minute) * minute;
  const currency = sourceClass === 'currency';
  const weather = sourceClass === 'weather';
  const search = sourceClass === 'search';
  const run = sourceClass === 'run';
  const arabic = sourceClass === 'arabic-page';
  const structured = sourceClass === 'structured-offer';
  const feed = sourceClass === 'weekly-feed' || sourceClass === 'recurring-feed';
  const recurring = sourceClass === 'recurring-feed';
  const useMicrodata = chance(rand, 0.5);
  const usePersian = chance(rand, 0.5);
  const moves = (arabic || structured) && chance(rand, parameters.moveProbability);
  const decoy = structured && chance(rand, 0.5);
  const regime: Schedule = recurring || structured || currency ? 'daily' : feed || search ? 'weekly' : weather ? 'burst' : 'poisson';
  const timeline = eventTimes(regime, rand, feed ? start - 4 * week : start, end);
  const inWindow = timeline.filter(at => at >= start + (regime === 'weekly' ? 2 * hour : parameters.warmupMs));
  // A sparse realization can authentically contain no qualifying change within the enrollment window.
  const mainAt = sustainedChange && inWindow.length ? inWindow[pick(rand, 0, inWindow.length - 1)] : Infinity;
  const itemTimes = sustainedChange ? (recurring ? inWindow.slice(0, 3) : Number.isFinite(mainAt) ? [mainAt] : []) : [];
  const historical = feed ? timeline.filter(at => at < start).slice(-5) : [start - week, start - day];
  const allItems = [...historical, ...itemTimes].map((at, i) => ({ at, id: `release-${i + 1}`, title: `Press release ${i + 1}` }));
  const itemsAt = (at: number) => allItems.filter(item => item.at <= at).reverse();
  const upside = weather;
  const threshold = arabic ? 2500 : currency ? 1.15 : weather ? 31 : 100;
  const width = currency ? 0.012 : weather ? 4 : 18;
  const hysteresis = currency ? 0.001 : weather ? 0.5 : 0.1;
  const sign = upside ? -1 : 1;
  const unchangedValue = quote(threshold + sign * width);
  const qualifiedValue = quote(threshold - sign * width);
  const waves: Wave[] = [{ at: start, value: unchangedValue }];
  for (const [i, at] of timeline.entries()) {
    if (at <= start || at >= mainAt) continue;
    const pulse = i % 5 === 1 && !currency ? parameters.thresholdFlapMs : 0;
    // Short excursions straddle the actual threshold and also count as valid crossing opportunities.
    const value = pulse ? quote(threshold - sign * hysteresis / 2) : quote(threshold + sign * width * (0.3 + 0.7 * rand()));
    waves.push({ at, value });
    if (pulse) waves.push({ at: Math.min(at + pulse, mainAt, timeline[i + 1] ?? end), value: unchangedValue });
  }
  if (Number.isFinite(mainAt)) waves.push({ at: mainAt, value: qualifiedValue });
  if (arabic) for (const wave of waves) wave.value = Number(wave.value.toFixed(2));
  waves.sort((left, right) => left.at - right.at);
  const stateAt = (at: number) => waves.findLast(wave => wave.at <= at) ?? waves[0];
  const runStatus = (at: number) => at >= mainAt ? 'completed' : at - start > hour ? 'running' : 'queued';
  const source: MonitorSpec['source'] = currency ? { kind: 'currency', base: 'EUR', quote: 'USD' }
    : weather ? { kind: 'weather', location: 'Synthetic observatory', latitude: 51.5, longitude: -0.1, metric: 'temperature' }
      : search ? { kind: 'search', query: 'Press releases synthetic test' }
        : run ? { kind: 'run', runId }
          : { kind: 'page', url: `${site}/watch`, ...(arabic && { anchor: 'سعر التذكرة' }), ...(structured && { anchor: 'Museum entry' }) };
  const numeric = currency || weather || arabic || structured;
  const anchors = structured ? 'price' : arabic ? 'السعر' : undefined;
  const read: MonitorSpec['read'] = numeric ? { kind: 'number', ...(anchors && { label: anchors }) }
    : feed || search ? { kind: 'items' } : run ? { kind: 'status' } : { kind: 'main' };
  const condition: MonitorSpec['condition'] = numeric ? { kind: 'crossing', direction: upside ? 'above' : 'below', value: threshold, hysteresis }
    : feed || search ? { kind: 'new-item' } : run ? { kind: 'equals', value: 'completed' } : { kind: 'change' };
  const mainText = 'The publication was approved.';
  const truth: TruthEvent[] = feed || search
    ? allItems.filter(item => itemTimes.includes(item.at)).map(item => ({ at: item.at, until: end, expected: item.title }))
    : numeric ? waves.flatMap((wave, i) => (upside ? wave.value > threshold : wave.value < threshold)
      ? [{ at: wave.at, until: waves[i + 1]?.at ?? end, expected: wave.value }] : []).filter(event => event.at < event.until)
      : Number.isFinite(mainAt) ? [{ at: mainAt, until: end, expected: run ? 'completed' : mainText }] : [];

  function pageHtml(at: number) {
    const price = stateAt(at).value;
    const moved = moves && at >= moveAt;
    const variant = Math.floor((at - start) / parameters.noisePeriodMs) + noiseOffset;
    const rotation = ['Weekend guide', 'Editor’s pick', 'Public gallery'][variant % 3];
    const headingText = arabic ? 'سعر التذكرة' : 'Museum entry';
    const heading = moved ? `<h3>${headingText}</h3>` : `<h2>${headingText}</h2>`;
    const context = arabic ? 'تذكرة دخول شخص واحد إلى المعرض' : 'Museum entry for one adult';
    const noise = `<p>Last updated: ${iso(at)}</p><aside class="carousel">${rotation}</aside>`;
    if (feed) return itemPage(itemsAt(at));
    if (!numeric) return `<main><h1>Publication</h1><p>${at >= mainAt ? mainText : 'The publication is pending.'}</p><p>${variant % 2 ? 'Editorial edition' : 'Public edition'}</p>${noise}</main>`;
    const unitBreak = decoy && moved && variant % 5 === 0 ? '<p>Other offer 2 EUR per month</p>' : '';
    const alternative = decoy ? '<section><h2>Other offers</h2><p><del>Old price: 79 USD</del></p><p>Price: 55 EUR</p></section>' : '';
    const product = { '@context': 'https://schema.org', '@type': 'Product', name: 'Museum entry', offers: [
      { '@type': 'Offer', price, priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
      ...(decoy ? [{ '@type': 'Offer', price: 55, priceCurrency: 'EUR', availability: 'https://schema.org/InStock' }] : []),
    ] };
    const json = structured && !useMicrodata ? `<script type="application/ld+json">${JSON.stringify(product)}</script>` : '';
    const microdata = structured && useMicrodata ? `<div itemscope itemtype="https://schema.org/Product"><meta itemprop="name" content="Museum entry"><div itemscope itemprop="offers" itemtype="https://schema.org/Offer"><meta itemprop="priceCurrency" content="USD"><meta itemprop="price" content="${price}"><link itemprop="availability" href="https://schema.org/InStock"></div>${decoy ? '<div itemscope itemprop="offers" itemtype="https://schema.org/Offer"><meta itemprop="priceCurrency" content="EUR"><meta itemprop="price" content="55"></div>' : ''}</div>` : '';
    const reading = arabic ? `السعر: ${arabicPrice(price, usePersian)} SAR` : `Price: ${price} USD`;
    const visibleDecoys = decoy && moved ? '<p>Price: <del>79 USD</del></p><p>Price: 55 EUR</p>' : '';
    const block = moved ? `<article><div>${heading}${visibleDecoys}<p>${reading}</p><p>${context}</p></div></article>`
      : `<section id="admission">${heading}<p>${reading}</p><p>${context}</p></section>`;
    return `${json}<main><h1>${arabic ? 'المعرض' : 'Museum admission'}</h1>${block}${microdata}${alternative}${unitBreak}${noise}</main>`;
  }

  const ports: Scenario['ports'] = clock => {
    const reply = (target: string, status: number, body = '', headers: Record<string, string> = {}) => ({
      url: target, status, headers, body: Buffer.from(body),
    });
    class FixtureNetwork extends SafeNetwork {
      override async request(target: string, options?: Parameters<SafeNetwork['request']>[1]) {
        options?.signal?.throwIfAborted();
        await options?.beforeDispatch?.();
        const at = clock();
        const url = new URL(target);
        if (![new URL(site).hostname, 'www.ecb.europa.eu', 'api.open-meteo.com'].includes(url.hostname)) throw new Error(`Unexpected fixture host ${url.hostname}`);
        if (url.pathname === '/robots.txt') return reply(target, 200, `User-agent: *\nAllow: /\n${url.hostname === new URL(site).hostname ? `Sitemap: ${site}/sitemap.xml\n` : ''}`);
        if (offlineAt(at)) return reply(target, 503);
        const wave = stateAt(at);
        if (url.hostname === 'www.ecb.europa.eu') return reply(target, 200, ecb(wave.at, wave.value), { 'content-type': 'application/xml' });
        if (url.hostname === 'api.open-meteo.com') return reply(target, 200, forecast(at, wave.value), { 'content-type': 'application/json' });
        if (redirects && at >= moveAt && url.pathname === '/watch') return reply(target, 302, '', { location: '/new-watch' });
        const items = itemsAt(at);
        const lastPublication = items[0]?.at ?? start;
        const content = url.pathname === '/feed.xml' ? rss(items) : url.pathname === '/sitemap.xml' ? sitemap(items) : undefined;
        const layoutVersion = moves && at >= moveAt ? moveAt : start;
        const textVersion = !numeric && at >= mainAt ? mainAt : start;
        const tagTime = content || feed ? lastPublication : Math.max(wave.at, layoutVersion, textVersion);
        const headers = { ...gates(tagTime, { etag: true, modified: true }), 'content-type': content ? 'application/xml' : 'text/html; charset=utf-8' };
        // Rotate noisy content for a general text watch, even though the meaningful block is unchanged.
        if ((numeric || feed) && options?.headers?.['if-none-match'] === headers.etag) return reply(target, 304, '', headers);
        if (content !== undefined) return reply(target, 200, content, headers);
        if (url.pathname === '/watch' || url.pathname === '/new-watch') return reply(target, 200, pageHtml(at), headers);
        return reply(target, 404);
      }
    }
    const query = {
      select() { return query; },
      where() { return query; },
      async executeTakeFirst() { return offlineAt(clock()) ? undefined : { status: runStatus(clock()), updated_at: new Date(clock()) }; },
    };
    const db = { selectFrom(table: string) { if (table !== 'chat_runs') throw new Error(`Unexpected fixture query ${table}`); return query; } } as unknown as Kysely<any>;
    const searchProvider: SearchProvider = {
      name: 'Synthetic public search',
      async search() {
        if (offlineAt(clock())) throw new Error('Seeded search outage');
        const tag = Math.floor((clock() - start) / parameters.noisePeriodMs) % 2;
        const items = itemsAt(clock());
        return (tag ? items : items.reverse()).map(item => ({ title: item.title, url: `${site}/press/${item.id}?utm_source=variant${tag}`, snippet: item.title }));
      },
    };
    return { db, searchProvider, network: new FixtureNetwork({ testOrigins: [site] }), clock };
  };

  return {
    sourceClass, start, end, deadline, source, read, condition, language: arabic ? 'ar' : 'en', truth, ports,
    ...(moves && { layoutChangeAt: moveAt }), relocationValue: (at: number) => stateAt(at).value,
  };
}

export function matchesEvent(event: TruthEvent, at: number, observation: MonitorObservation): boolean {
  if (event.at > at || at >= event.until) return false;
  const { expected } = event;
  if (typeof expected === 'number') return observation.value === expected;
  if (typeof expected === 'boolean') return observation.value === expected;
  if (Array.isArray(observation.value)) return observation.value.includes(expected) && observation.excerpt.includes(expected);
  return typeof observation.value === 'string' && observation.value.includes(expected) && observation.excerpt.includes(expected);
}
