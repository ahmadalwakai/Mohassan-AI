import { SearchProviderFailure } from '../providers.js';
import type { StatisticsCountry } from './statistics-countries.js';
import type { StatisticsIndicator, StatisticsObservation, StatisticsRequest } from './statistics-types.js';

export const WORLD_BANK_TERMS = 'https://www.worldbank.org/ext/en/legal/terms-conditions/datasets';

interface IndicatorRow {
  indicator?: { id?: unknown };
  countryiso3code?: unknown;
  date?: unknown;
  value?: unknown;
  obs_status?: unknown;
}

export async function worldBankStatistic(
  request: StatisticsRequest,
  country: StatisticsCountry,
  indicator: StatisticsIndicator,
  signal: AbortSignal,
  year?: number,
): Promise<StatisticsObservation | undefined> {
  const series = indicator.worldBank;
  if (!series) return;

  const endpoint = new URL(`https://api.worldbank.org/v2/country/${country.iso3}/indicator/${series.code}`);
  // World Development Indicators (source 2) and MRNEV were verified on 2026-11-27.
  // https://datahelpdesk.worldbank.org/knowledgebase/articles/898581-api-basic-call-structures
  endpoint.searchParams.set('format', 'json');
  endpoint.searchParams.set('source', '2');
  if (year === undefined) endpoint.searchParams.set('mrnev', '1');
  else endpoint.searchParams.set('date', String(year));

  const data = await request(endpoint, signal);
  if (!Array.isArray(data) || data.length !== 2) throw new SearchProviderFailure('invalid_response');
  const rows: unknown = data[1];
  if (rows === null) return;
  if (!Array.isArray(rows)) throw new SearchProviderFailure('invalid_response');

  const sourcePage = new URL(`https://data.worldbank.org/indicator/${series.code}`);
  sourcePage.searchParams.set('locations', country.iso2);

  let latest: StatisticsObservation | undefined;
  for (const row of rows as (IndicatorRow | null)[]) {
    if (!row || row.indicator?.id !== series.code || row.countryiso3code !== country.iso3
      || typeof row.date !== 'string' || !/^\d{4}$/.test(row.date)
      || typeof row.value !== 'number' || !Number.isFinite(row.value)) continue;
    const rowYear = Number(row.date);
    if ((year !== undefined && rowYear !== year) || (latest && rowYear <= latest.year)) continue;

    latest = {
      value: row.value,
      year: rowYear,
      url: sourcePage.href,
      source: `The World Bank: World Development Indicators: ${series.upstream}`,
      unit: series.unit,
    };
    // Observation status F is a forecast (documentation checked 2026-11-27).
    // https://datahelpdesk.worldbank.org/knowledgebase/articles/1886674-new-features-and-enhancements-in-the-v2-api
    if (typeof row.obs_status === 'string' && row.obs_status.trim() === 'F') latest.projection = true;
  }
  return latest;
}
