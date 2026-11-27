/**
 * Infobox boundaries and estimate rows follow the captured country page in
 * https://github.com/ahmadalwakai/Mohassan-AI/pull/1 (retrieved 2026-11-27).
 * The lead scan uses the same 8,000-character limit as readableText in
 * https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/assistant/hands.ts (retrieved 2026-11-27).
 */
const INFOBOX_END = /تعديل مصدري\s*-\s*تعديل|Edit this at Wikidata/u;
const ESTIMATE_ROW = /(?<!\S)(?:توقع|تقدير)\s+\(\s*([\p{Nd}]{4})\s*\)\s+[\p{Nd}]+(?:[,٬][\p{Nd}]{3})*\s+نسم[ةه](?!\p{L})/gu;

const digits = (text: string) => text.replace(/[٠-٩۰-۹]/gu, digit => String(digit.charCodeAt(0) & 0xf));

export function isPopulationEstimateRow(line: string): boolean {
  return Array.from(line.trim().matchAll(ESTIMATE_ROW)).some(([row]) => row === line.trim());
}

/** Most recent four-digit year in the supported 1900s/2000s date grammar, excluding number groups. */
export function populationYear(line: string): number {
  return Math.max(0, ...Array.from(digits(line).matchAll(/(?<!\d)(?<!\d[.,،٬])(?:19\d\d|20\d\d)(?!\d)(?![.,،٬]\d)/gu), ([year]) => Number(year)));
}

export function countryInfoboxPopulation(page: { url: string; text: string }, currentYear: number): { line: string; year: number } | undefined {
  if (URL.parse(page.url)?.hostname !== 'ar.wikipedia.org') return;
  const lead = page.text.slice(0, 8000);
  const start = lead.indexOf('الأرض والسكان');
  const end = lead.search(INFOBOX_END);
  if (start < 0 || end <= start) return;

  const infobox = lead.slice(start, end).replace(/\[\s*\p{Nd}+\s*\]|[\u200e\u200f]/gu, ' ').replace(/\s+/gu, ' ');
  let estimate: { line: string; year: number } | undefined;
  for (const [line, date] of infobox.matchAll(ESTIMATE_ROW)) {
    const year = Number(digits(date!));
    if (year <= currentYear && year > (estimate?.year ?? 0)) estimate = { line, year };
  }
  return estimate;
}
