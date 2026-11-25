import type { LiveLanguage, LivePlace } from '@mohassan/contracts';
import { z } from 'zod';
import type { RequestScope } from './request.js';

// https://open-meteo.com/en/docs/geocoding-api (retrieved 2026-11-25).
const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const PLACE_TTL_MS = 24 * 60 * 60 * 1000;
export const GEOCODING_ATTRIBUTION = '[GeoNames](https://www.geonames.org/)';

const locationName = z.string().max(160).regex(/^[^\p{Cc}\p{Zl}\p{Zp}]+$/u)
  .transform(value => value.replace(/\p{Bidi_Control}/gu, '').trim()).pipe(z.string().min(1));
const location = z.object({
  name: locationName,
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  timezone: z.string().min(1).max(80),
  country_code: z.string().regex(/^[A-Z]{2}$/u).optional(),
  country: locationName.optional(),
  admin1: locationName.optional(),
});
const geocodingResponse = z.object({
  results: z.array(z.unknown()).max(10).optional(),
  generationtime_ms: z.number().optional(),
}).refine(value => value.results !== undefined || value.generationtime_ms !== undefined);

function hasTimeZone(timeZone: string): boolean {
  // Intl also accepts numeric offset strings, which do not provide DST rules.
  if (/^[+-]/u.test(timeZone)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone });
    return true;
  } catch {
    return false;
  }
}

async function lookup(scope: RequestScope, name: string, language: LiveLanguage, countryCode?: string): Promise<LivePlace | undefined> {
  const url = new URL(GEOCODING_URL);
  url.search = new URLSearchParams({ name, count: '10', language }).toString();
  if (countryCode) url.searchParams.set('countryCode', countryCode);
  const response = await scope.fetch(url);
  if (!response.ok) throw new Error(`Open-Meteo geocoding HTTP ${response.status}`);
  const data = geocodingResponse.parse(await response.json());
  if (!data.results?.length) return undefined;
  for (const item of data.results) {
    const result = location.safeParse(item);
    if (!result.success || !hasTimeZone(result.data.timezone)) continue;
    const { name, latitude, longitude, timezone, country_code, country, admin1 } = result.data;
    if (countryCode && country_code !== countryCode) continue;
    return { name, latitude, longitude, timezone, countryCode: country_code, country, admin1 };
  }
  throw new Error('Open-Meteo geocoding did not return usable coordinates and a time zone');
}

export async function resolvePlace(scope: RequestScope, name: string, language: LiveLanguage): Promise<LivePlace | undefined> {
  const query = name.normalize('NFC').replace(/،/gu, ',').replace(/\s*,\s*/gu, ', ').replace(/\s+/gu, ' ').trim();
  if (!query) return undefined;
  // Open-Meteo localizes qualifier matching based on the requested language.
  const locale = /\p{Script=Arabic}/u.test(query) ? 'ar' : language;
  return scope.withCache(`place:${locale}:${query.toLowerCase()}`, PLACE_TTL_MS, async () => {
    const place = await lookup(scope, query, locale);
    if (place) return place;
    const qualified = /^([^,]+), ([A-Za-z]{2})$/u.exec(query);
    if (!qualified) return undefined;
    const [, city, suffix] = qualified;
    // CLDR region alias canonicalization, for example UK -> GB. Only try an alias after the
    // raw qualifier; Open-Meteo gives an administrative-area abbreviation precedence.
    // https://unicode.org/reports/tr35/#Canonical_Unicode_Locale_Identifiers (retrieved 2026-11-25).
    const code = new Intl.Locale(`und-${suffix}`).region;
    return code && code !== suffix.toUpperCase() ? lookup(scope, city, locale, code) : undefined;
  });
}

export function placeLabel(place: LivePlace, language: LiveLanguage): string {
  return [...new Set([place.name, place.admin1, place.country ?? place.countryCode].filter(Boolean))]
    .join(language === 'ar' ? '، ' : ', ')
    .replace(/[\\`*_{}\[\]<>&]/gu, '\\$&');
}
