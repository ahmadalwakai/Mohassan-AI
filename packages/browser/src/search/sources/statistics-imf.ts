import type { StatisticsCountry } from './statistics-countries.js';
import type { StatisticsIndicator, StatisticsObservation, StatisticsRequest } from './statistics-types.js';

// Checked 2026-11-27. Statistical-data terms require attribution and permission for commercial reuse.
export const IMF_TERMS = 'https://www.imf.org/en/about/copyright-and-terms';

interface DataMapperResponse {
  indicators?: Record<string, {
    dataset?: unknown;
    source?: unknown;
    unit?: unknown;
    'projection-year'?: unknown;
  }>;
  values?: Record<string, Record<string, Record<string, unknown>>>;
}

export async function imfStatistic(
  request: StatisticsRequest,
  country: StatisticsCountry,
  indicator: StatisticsIndicator,
  signal: AbortSignal,
  year: number | undefined,
  currentYear: number,
  projectionRequested: boolean,
): Promise<StatisticsObservation | undefined> {
  if (!indicator.imf) return undefined;
  const { code, unit } = indicator.imf;
  const years = year === undefined
    ? Array.from({ length: 5 }, (_, index) => projectionRequested ? currentYear + index + 1 : currentYear - index)
    : [year];

  // v2 country and periods selectors are documented at https://www.imf.org/external/datamapper/api/help.
  // Some responses contain other areas and periods. Select only the requested country and years.
  const url = new URL(`https://www.imf.org/external/datamapper/api/v2/${code}/${country.iso3}?periods=${years.join(',')}`);
  const data = await request(url, signal) as DataMapperResponse | null;
  const metadata = data?.indicators?.[code];
  const values = data?.values?.[code]?.[country.iso3];
  if (metadata?.dataset !== 'WEO' || !values) return undefined;

  const projectionYear = metadata['projection-year'];
  if (typeof projectionYear !== 'number' || !Number.isInteger(projectionYear)
    || typeof metadata.source !== 'string' || !metadata.source.trim()
    || typeof metadata.unit !== 'string' || !metadata.unit.trim()) return undefined;

  const sourceUnit = metadata.unit.trim();
  for (const candidate of years) {
    const value = values[String(candidate)];
    const projection = candidate >= projectionYear;
    if (typeof value !== 'number' || !Number.isFinite(value) || (projectionRequested && !projection)) continue;

    // Historical values can include staff estimates. The DataMapper boundary is for projections.
    // https://www.imf.org/en/Publications/WEO/frequently-asked-questions
    return {
      value,
      year: candidate,
      url: `https://www.imf.org/external/datamapper/${code}@WEO/${country.iso3}`,
      source: `International Monetary Fund, ${metadata.source.trim()}`,
      unit: { en: sourceUnit, ar: sourceUnit === unit.en ? unit.ar : sourceUnit },
      projection,
      estimate: !projection,
    };
  }
}
