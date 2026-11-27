import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { SafeNetwork, type SafeResponse } from '../../network.js';
import type { SearchHit } from '../../research.js';
import { SearchEngine } from '../engine.js';
import { compileQuery } from '../ranking.js';
import { statisticsProviders } from './statistics.js';
import imf from './fixtures/statistics/imf.json';

interface Recording { url: string; body: unknown }
interface WorldBankRow {
  country: { id: string };
  date: string;
  value: number | null;
}

const clock = Date.UTC(2026, 10, 27);
const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 20 });

// Fixture provenance, retrieval dates and exact requests are in fixtures/statistics/{world-bank,imf}.md.
function worldBank(name: string, country: string, code: string, selection = 'mrnev=1') {
  const url = `https://api.worldbank.org/v2/country/${country}/indicator/${code}?format=json&source=2&${selection}`;
  const path = new URL(`./fixtures/statistics/world-bank-${name}.json`, import.meta.url);
  const body = JSON.parse(readFileSync(path, 'utf8')) as [unknown, WorldBankRow[]];
  const page = `https://data.worldbank.org/indicator/${code}?locations=${body[1][0].country.id}`;
  return { url, body, page };
}

function replay(recordings: Recording[], fault?: (url: string) => Partial<SafeResponse> | undefined) {
  const bodies = new Map(recordings.map(recording => [recording.url, recording.body]));
  const network = new SafeNetwork();
  let time = clock;
  const now = () => time;
  const dispatch = vi.spyOn(network, 'request').mockImplementation(async (url, options) => {
    options?.signal?.throwIfAborted();
    const failure = fault?.(url);
    if (failure) return { url, status: 500, headers: {}, body: Buffer.alloc(0), ...failure };
    if (new URL(url).pathname === '/robots.txt') return { url, status: 404, headers: {}, body: Buffer.alloc(0) };
    if (!bodies.has(url)) throw new Error(`No recorded response for ${url}`);
    return { url, status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(bodies.get(url))) };
  });
  const providers = statisticsProviders(network, now);
  const bank = providers.find(provider => provider.name === 'World Bank')!;
  const fund = providers.find(provider => provider.name === 'IMF DataMapper')!;
  return {
    now, network, providers, bank, fund, dispatch,
    urls: () => dispatch.mock.calls.map(([url]) => url),
    advance: (duration: number) => { time += duration; },
  };
}

function hasObservation(hit: SearchHit | undefined, page: string, year: string | number, value: number | null) {
  expect(value).not.toBeNull();
  expect(hit).toMatchObject({ url: page, title: expect.any(String) });
  expect(hit?.snippet).toContain(number.format(value!));
  expect(hit?.snippet).toContain(String(year));
}

const search = (provider: ReturnType<typeof statisticsProviders>[number], text: string) =>
  provider.search(compileQuery(text), 5, new AbortController().signal);

describe('official statistics providers', () => {
  it.each([
    ['كم عدد سكان أستراليا؟', 'aus-population', 'AUS', 'SP.POP.TOTL', /سكان/u, /نسمة|شخص/u],
    ['population of Canada', 'can-population', 'CAN', 'SP.POP.TOTL', /population/i, /people/i],
    ['كم عدد سكان السعودية؟', 'sau-population', 'SAU', 'SP.POP.TOTL', /سكان/u, /نسمة|شخص/u],
    ['ما الناتج المحلي لمصر؟', 'egy-gdp', 'EGY', 'NY.GDP.MKTP.CD', /الناتج المحلي/u, /دولار/u],
    ['GDP of Japan', 'jpn-gdp', 'JPN', 'NY.GDP.MKTP.CD', /GDP/i, /dollars|US\$|USD/i],
  ])('answers %s with the recorded value, unit, year and source', async (question, name, country, code, indicator, unit) => {
    const recording = worldBank(name, country, code);
    const { bank, urls } = replay([recording]);
    expect(bank.planned).toMatchObject({
      domains: ['official_statistics'], languages: expect.arrayContaining(['ar', 'en']), access: 'documented_api',
      contract: { url: 'https://www.worldbank.org/ext/en/legal/terms-conditions/datasets', checked: '2026-11-27' },
    });
    expect(bank.supports(compileQuery(question))).toBe(true);
    const [hit] = await search(bank, question);
    const [{ date, value }] = recording.body[1];
    hasObservation(hit, recording.page, date, value);
    expect(hit.snippet).toMatch(indicator);
    expect(hit.snippet).toMatch(unit);
    expect(hit.snippet).toMatch(/world bank|البنك الدولي/iu);
    expect(urls()).toEqual(['https://api.worldbank.org/robots.txt', recording.url]);
  });

  it('uses the newest non-empty World Bank observation and leaves an explicitly missing year empty', async () => {
    const recent = worldBank('usa-life-expectancy', 'USA', 'SP.DYN.LE00.IN');
    const missing = worldBank('usa-life-expectancy-2025', 'USA', 'SP.DYN.LE00.IN', 'date=2025');
    const range = worldBank('usa-life-expectancy-2024-2025', 'USA', 'SP.DYN.LE00.IN', 'date=2024:2025');
    const [newer, earlier] = range.body[1];
    expect(Number(newer.date)).toBeGreaterThan(Number(earlier.date));
    expect(newer.value).toBeNull();
    const { bank, urls, advance } = replay([recent, missing]);
    const [hit] = await search(bank, 'life expectancy in the United States');
    hasObservation(hit, recent.page, earlier.date, earlier.value);
    expect(hit.snippet).toMatch(/years/i);
    advance(60_000);
    expect(await search(bank, `life expectancy in the United States in ${newer.date}`)).toEqual([]);
    expect(urls()).toEqual(['https://api.worldbank.org/robots.txt', recent.url, missing.url]);
  });

  it('falls through without a request for an unknown country or an unrelated subject', async () => {
    const { providers, dispatch } = replay([]);
    for (const provider of providers) {
      for (const question of ['population of Atlantis', 'كم عدد سكان أطلانتس؟', 'history of Canada']) {
        expect(provider.supports(compileQuery(question))).toBe(false);
        expect(await search(provider, question)).toEqual([]);
      }
    }
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each([
    ['inflation in Turkey', imf.turLatest, 2026, imf.turLatest.body.values.PCPIPCH.TUR['2026']],
    ['inflation forecast for Türkiye', imf.turProjection, 2027, imf.turProjection.body.values.PCPIPCH.TUR['2027']],
  ])('labels IMF projections for %s using the recorded boundary', async (question, recording, year, value) => {
    const { fund, urls } = replay([recording]);
    expect(fund.planned).toMatchObject({
      domains: ['official_statistics'], languages: expect.arrayContaining(['ar', 'en']), access: 'documented_api',
      contract: { url: 'https://www.imf.org/en/about/copyright-and-terms', checked: '2026-11-27' },
    });
    expect(year).toBeGreaterThanOrEqual(recording.body.indicators.PCPIPCH['projection-year']);
    const [hit] = await search(fund, question);
    hasObservation(hit, 'https://www.imf.org/external/datamapper/PCPIPCH@WEO/TUR', year, value);
    expect(hit.snippet).toMatch(/inflation/i);
    expect(hit.snippet).toMatch(/projection/i);
    expect(hit.snippet).toMatch(/percent|%/i);
    expect(hit.snippet).toContain('International Monetary Fund');
    expect(hit.snippet).toContain(recording.body.indicators.PCPIPCH.source);
    expect(urls()).toEqual(['https://www.imf.org/robots.txt', recording.url]);
  });

  it('preserves same-year disagreements from both official sources through the search engine', async () => {
    const bank = worldBank('tur-inflation-2025', 'TUR', 'FP.CPI.TOTL.ZG', 'date=2025');
    const { network, providers, now } = replay([bank, imf.tur2025]);
    const engine = new SearchEngine(network, { providers, now });
    const outcome = await engine.execute('inflation in Turkey in 2025', 5);
    expect(outcome.failures).toEqual([]);
    expect(outcome.hits).toHaveLength(2);
    const [{ date, value }] = bank.body[1];
    const projectedBoundary = imf.tur2025.body.indicators.PCPIPCH['projection-year'];
    const imfValue = imf.tur2025.body.values.PCPIPCH.TUR['2025'];
    expect(Number(date)).toBeLessThan(projectedBoundary);
    expect(imfValue).not.toBe(value);
    const bankHit = outcome.hits.find(hit => hit.providers.includes('World Bank'));
    const imfHit = outcome.hits.find(hit => hit.providers.includes('IMF DataMapper'));
    hasObservation(bankHit, bank.page, date, value);
    hasObservation(imfHit, 'https://www.imf.org/external/datamapper/PCPIPCH@WEO/TUR', date, imfValue);
    expect(imfHit?.snippet).toMatch(/may include.*estimate/i);
    expect(imfHit?.snippet).not.toMatch(/projection/i);
  });

  it.each([
    ['كم عدد سكان أستراليا؟', worldBank('aus-population', 'AUS', 'SP.POP.TOTL'), imf.ausLatest, /توقع/u],
    ['ما الناتج المحلي لمصر؟', worldBank('egy-gdp', 'EGY', 'NY.GDP.MKTP.CD'), imf.egyLatest, /توقع/u],
    ['inflation in Turkey', worldBank('tur-inflation', 'TUR', 'FP.CPI.TOTL.ZG'), imf.turLatest, /projection/i],
    ['unemployment rate in Saudi Arabia', worldBank('sau-unemployment', 'SAU', 'SL.UEM.TOTL.ZS'), imf.sauLatest, /may include.*estimates/i],
  ])('ranks official statistics for %s in the search engine', async (question, recording, alternate, qualifier) => {
    const { network, providers, now } = replay([recording, alternate]);
    const outcome = await new SearchEngine(network, { providers, now }).execute(question, 5);
    expect(outcome.failures).toEqual([]);
    expect(outcome.hits.flatMap(hit => hit.providers).sort()).toEqual(['IMF DataMapper', 'World Bank']);
    const [{ date, value }] = recording.body[1];
    hasObservation(outcome.hits.find(hit => hit.providers.includes('World Bank')), recording.page, date, value);
    const [[code, countries]] = Object.entries(alternate.body.values);
    const [[country, years]] = Object.entries(countries);
    const year = Math.max(...Object.keys(years).map(Number));
    const imfHit = outcome.hits.find(hit => hit.providers.includes('IMF DataMapper'));
    hasObservation(imfHit, `https://www.imf.org/external/datamapper/${code}@WEO/${country}`, year, years[year as keyof typeof years]);
    expect(imfHit?.snippet).toMatch(qualifier);
  });

  it('ranks the spelled-out English GDP name through the search engine', async () => {
    const recording = worldBank('jpn-gdp', 'JPN', 'NY.GDP.MKTP.CD');
    const { network, bank, now } = replay([recording]);
    const outcome = await new SearchEngine(network, { providers: [bank], now }).execute('gross domestic product Japan', 5);
    expect(outcome.failures).toEqual([]);
    expect(outcome.hits).toHaveLength(1);
    const [{ date, value }] = recording.body[1];
    hasObservation(outcome.hits[0], recording.page, date, value);
  });

  it('checks robots before the API and skips disallowed paths', async () => {
    // Synthetic robots restriction; the live World Bank API robots endpoint returned 404.
    const { bank, urls } = replay([], url => url.endsWith('/robots.txt') ? {
      status: 200, body: Buffer.from('User-agent: *\nDisallow: /v2/country/'),
    } : undefined);
    await expect(search(bank, 'population of Canada')).rejects.toThrow();
    expect(urls()).toEqual(['https://api.worldbank.org/robots.txt']);
  });

  it.each(['40', new Date(clock + 40_000).toUTCString()])('honours 429 Retry-After %s before another API request', async retryAfter => {
    const recording = worldBank('can-population', 'CAN', 'SP.POP.TOTL');
    // Synthetic upstream rate limit followed by a replay of the recorded successful response.
    let throttled = true;
    const { bank, advance, urls } = replay([recording], url => url === recording.url && throttled ? {
      status: 429, headers: { 'retry-after': retryAfter },
    } : undefined);
    await expect(search(bank, 'population of Canada')).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 40_000 });
    throttled = false;
    advance(39_999);
    await expect(search(bank, 'population of Canada')).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(urls()).toEqual(['https://api.worldbank.org/robots.txt', recording.url]);
    advance(1);
    await expect(search(bank, 'population of Canada')).resolves.toHaveLength(1);
    expect(urls()).toEqual(['https://api.worldbank.org/robots.txt', recording.url, recording.url]);
  });

  it('honours Retry-After from robots.txt before dispatching any statistics request', async () => {
    const recording = worldBank('can-population', 'CAN', 'SP.POP.TOTL');
    const robots = 'https://api.worldbank.org/robots.txt';
    let throttled = true;
    const { bank, advance, urls } = replay([recording], url => url === robots && throttled ? {
      status: 429, headers: { 'retry-after': '40' },
    } : undefined);
    await expect(search(bank, 'population of Canada')).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 40_000 });
    throttled = false;
    await expect(search(bank, 'population of Canada')).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 40_000 });
    expect(urls()).toEqual([robots]);
    advance(40_000);
    await expect(search(bank, 'population of Canada')).resolves.toHaveLength(1);
    expect(urls()).toEqual([robots, robots, recording.url]);
  });
});
