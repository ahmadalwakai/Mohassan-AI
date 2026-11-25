import { describe, expect, it, vi } from 'vitest';
import type { WeatherIntent } from '@mohassan/contracts';
import { resolvePlace } from '../apps/server/src/live-data/places.js';
import { createLiveRequestClient } from '../apps/server/src/live-data/request.js';
import { getWeather, weatherCondition } from '../apps/server/src/live-data/weather.js';
import geocoding from './fixtures/live-data/open-meteo-geocoding.json';
import londonCanada from './fixtures/live-data/open-meteo-geocoding-london-canada.json';
import londonGb from './fixtures/live-data/open-meteo-geocoding-london-gb.json';
import londonUkEmpty from './fixtures/live-data/open-meteo-geocoding-london-uk-empty.json';
import riyadh from './fixtures/live-data/open-meteo-geocoding-riyadh.json';
import forecast from './fixtures/live-data/open-meteo-forecast.json';

const fixtureTime = new Date('2026-11-25T03:44:25Z');
const { latitude, longitude, name, timezone, country, country_code, admin1 } = geocoding.results[0];
const london = { latitude, longitude, name, timezone, country, countryCode: country_code, admin1 };
const current: WeatherIntent = { kind: 'weather', language: 'ar', place: 'London', period: 'current' };

function weatherClient() {
  let now = fixtureTime.getTime();
  const fetch = vi.fn(async (input: URL | string) => {
    const url = new URL(input);
    switch (url.origin + url.pathname) {
      case 'https://geocoding-api.open-meteo.com/v1/search': return Response.json(geocoding);
      case 'https://api.open-meteo.com/v1/forecast': return Response.json(forecast);
      default: throw new Error(`Unexpected URL ${url}`);
    }
  });
  const client = createLiveRequestClient({ fetch, clock: () => now });
  return { ...client, fetch, advance: (ms: number) => { now += ms; } };
}

describe('Open-Meteo geocoding', () => {
  it('uses the first usable result with its coordinates, IANA time zone and country, and caches normalized place names', async () => {
    const client = weatherClient();
    await expect(client.run(scope => resolvePlace(scope, '  London ', 'ar'))).resolves.toEqual(london);
    await expect(client.run(scope => resolvePlace(scope, 'london', 'ar'))).resolves.toEqual(london);
    expect(client.fetch).toHaveBeenCalledTimes(1);
    const url = new URL(client.fetch.mock.calls[0][0]);
    expect(url.searchParams.get('name')).toBe('London');
    expect(url.searchParams.get('language')).toBe('ar');
  });

  it('passes a country qualifier to the API and uses Arabic matching for Arabic place names', async () => {
    const fetch = vi.fn(async (_: URL | string) => Response.json(londonCanada));
    const client = createLiveRequestClient({ fetch });
    await expect(client.run(scope => resolvePlace(scope, 'لندن ، كندا', 'en'))).resolves.toMatchObject({
      name: 'لندن', timezone: 'America/Toronto', countryCode: 'CA',
    });
    const query = new URL(fetch.mock.calls[0][0]).searchParams;
    expect(query.get('name')).toBe('لندن, كندا');
    expect(query.get('language')).toBe('ar');
  });

  it('tries canonical country code GB after a qualifier of UK returns no results', async () => {
    const fetch = vi.fn(async (input: URL | string) => {
      const query = new URL(input).searchParams;
      if (query.get('name') === 'London, UK' && !query.has('countryCode')) return Response.json(londonUkEmpty);
      if (query.get('name') === 'London' && query.get('countryCode') === 'GB') return Response.json(londonGb);
      throw new Error('Unexpected alias lookup');
    });
    const client = createLiveRequestClient({ fetch });
    await expect(client.run(scope => resolvePlace(scope, 'London, UK', 'en'))).resolves.toMatchObject({
      name: 'London', timezone: 'Europe/London', countryCode: 'GB',
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps the first Riyadh result when its name contains an invisible directional mark', async () => {
    const fetch = vi.fn(async () => Response.json(riyadh));
    const client = createLiveRequestClient({ fetch });
    await expect(client.run(scope => resolvePlace(scope, 'الرياض', 'ar'))).resolves.toMatchObject({
      name: 'الرياض', admin1: 'منطقة الرياض', timezone: 'Asia/Riyadh', countryCode: 'SA',
    });
  });

  it('returns no place when the API has no matches', async () => {
    // Hand-written no-result response in the documented geocoder shape.
    const fetch = vi.fn(async () => Response.json({ generationtime_ms: 0.1 }));
    const client = createLiveRequestClient({ fetch });
    await expect(client.run(scope => resolvePlace(scope, 'Unknown Place', 'en'))).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid coordinates and time zones while allowing a subsequent valid fetch', async () => {
    // Hand-written invalid variants of the recorded payload.
    const fetch = vi.fn().mockImplementationOnce(async () => Response.json({
      results: [{ ...geocoding.results[0], longitude: 182 }, { ...geocoding.results[0], timezone: '+03:00' }],
    })).mockImplementation(async () => Response.json(geocoding));
    const client = createLiveRequestClient({ fetch });
    await expect(client.run(scope => resolvePlace(scope, 'London', 'ar'))).rejects.toThrow(/usable coordinates/);
    await expect(client.run(scope => resolvePlace(scope, 'London', 'ar'))).resolves.toEqual(london);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('Open-Meteo weather', () => {
  it('renders the recorded current conditions in Arabic with metric units, valid time, method, and attribution', async () => {
    const client = weatherClient();
    const reply = await client.run(scope => getWeather(scope, london, current, fixtureTime));
    expect(reply).toContain('لندن، إنجلترا، المملكة المتحدة');
    expect(reply).toContain('غائم كليًا، 4.4 °C، والمحسوسة 1.1 °C');
    expect(reply).toContain('الرطوبة 83%، الرياح 10.1 كم/س، والهطول 0 ملم');
    expect(reply).toContain('2026-11-25 03:30 (Europe/London)');
    expect(reply).toContain('Best Match');
    expect(reply).toContain('[Open-Meteo](https://open-meteo.com/)');
    expect(reply).toContain('[GeoNames](https://www.geonames.org/)');
    expect(reply).toContain('[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)');

    const url = new URL(client.fetch.mock.calls[0][0]);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      latitude: `${latitude}`, longitude: `${longitude}`, timezone, timeformat: 'unixtime',
      temperature_unit: 'celsius', wind_speed_unit: 'kmh', precipitation_unit: 'mm', forecast_days: '7',
    });
  });

  it('renders only the next 24 hourly forecasts and seven daily rows from a shared weather request', async () => {
    const client = weatherClient();
    const hourly = await client.run(scope => getWeather(scope, london, { ...current, period: 'hourly' }, fixtureTime));
    const hours = hourly.split('\n').filter(line => line.startsWith('| 2026-'));
    expect(hours).toHaveLength(24);
    expect(hours[0]).toBe('| 2026-11-25 04:00 | غائم كليًا | 4.6 °C | 0% |');
    expect(hours.at(-1)).toContain('2026-11-26 03:00');
    expect(hourly).toContain('وقت طلب التوقع 2026-11-25 03:44');

    const daily = await client.run(scope => getWeather(scope, london, { ...current, language: 'en', period: 'daily' }, fixtureTime));
    const days = daily.split('\n').filter(line => line.startsWith('| 2026-'));
    expect(days).toHaveLength(7);
    expect(days[0]).toBe('| 2026-11-25 | Overcast | 4.2 °C | 6.7 °C | 0% |');
    expect(days[2]).toBe('| 2026-11-27 | Light drizzle | 1.1 °C | 3 °C | 33% |');
    expect(days.at(-1)).toContain('2026-12-01');
    expect(daily).toContain('Forecast requested at 2026-11-25 03:44');
    expect(client.fetch).toHaveBeenCalledTimes(1);
  });

  it('expires a per-place weather entry after 15 minutes while preserving its original request time until expiry', async () => {
    const client = weatherClient();
    const read = (elapsed: number) => client.run(scope => getWeather(scope, london, { ...current, period: 'daily' }, new Date(fixtureTime.getTime() + elapsed)));
    const ttl = 15 * 60 * 1000;
    await read(0);
    client.advance(ttl - 1);
    expect(await read(ttl - 1)).toContain('وقت طلب التوقع 2026-11-25 03:44');
    expect(client.fetch).toHaveBeenCalledTimes(1);
    client.advance(1);
    expect(await read(ttl)).toContain('وقت طلب التوقع 2026-11-25 03:59');
    expect(client.fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects HTTP errors and malformed series without caching either failure', async () => {
    // Hand-written HTTP error and length mismatch against the recorded forecast.
    const fetch = vi.fn().mockImplementationOnce(async () => new Response('', { status: 503 }))
      .mockImplementationOnce(async () => Response.json({ ...forecast, hourly: { ...forecast.hourly, temperature_2m: [] } }))
      .mockImplementation(async () => Response.json(forecast));
    const client = createLiveRequestClient({ fetch });
    const read = () => client.run(scope => getWeather(scope, london, current, fixtureTime));
    await expect(read()).rejects.toThrow('HTTP 503');
    await expect(read()).rejects.toThrow(/mismatched forecast series/);
    await expect(read()).resolves.toContain('غائم كليًا');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('translates every WMO code in the Open-Meteo table and identifies missing or undocumented codes', () => {
    // https://open-meteo.com/en/docs, WMO Weather interpretation codes (retrieved 2026-11-25).
    const documented = [0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 97, 99];
    const translations = documented.map(code => weatherCondition(code, 'ar'));
    expect(new Set(translations).size).toBe(documented.length);
    expect(translations.every(label => !label.includes('WMO'))).toBe(true);
    expect(weatherCondition(99, 'ar')).toBe('عاصفة رعدية مع بَرَد كثيف');
    expect(weatherCondition(97, 'ar')).toBe('عاصفة رعدية شديدة');
    expect(weatherCondition(null, 'ar')).toBe('—');
    expect(weatherCondition(100, 'ar')).toBe('رمز طقس غير موصوف (WMO 100)');
  });
});
