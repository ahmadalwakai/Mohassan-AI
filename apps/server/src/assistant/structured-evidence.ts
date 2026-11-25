import {
  normalizeEvidenceUnit, parseEvidenceDates, parseEvidenceNumbers, parseEvidenceUnitContext,
  type DateToken, type NumericToken,
} from './structured-evidence-parsing.js';

export type EvidenceKind = 'population' | 'gdp' | 'event-date' | 'price' | 'distance' | 'height' | 'other';
export type EvidenceDate = DateToken['date'];

export interface StructuredEvidenceTarget {
  entity: string;
  attribute: string;
  unit: string;
  kind?: EvidenceKind;
  time?: EvidenceDate;
  entityAliases?: readonly string[];
  attributeAliases?: readonly string[];
  /** Exact URLs permitted by the caller when the request limits which read sources count. */
  allowedSourceUrls?: readonly string[];
}

export interface StructuredEvidenceTable {
  caption?: string;
  headers: readonly string[];
  rows: readonly (readonly string[])[];
}

export interface StructuredEvidencePage {
  url: string;
  title: string;
  fetchedAt: string;
  publishedAt?: string;
  text: string;
  tables?: readonly StructuredEvidenceTable[];
  /** Use a common ID for known copies or editions of one source. Defaults to the URL without its fragment. */
  sourceId?: string;
}

export interface StructuredEvidenceOptions {
  now?: string;
  staleAfterDays?: Partial<Record<EvidenceKind, number>>;
  relativeTolerance?: number;
  absoluteTolerance?: number;
}

export type EvidenceValue =
  | { kind: 'number'; value: number; unit: string }
  | { kind: 'range'; min: number; max: number; unit: string }
  | { kind: 'date'; date: EvidenceDate };

type EvidenceSource = Pick<StructuredEvidencePage, 'url' | 'title' | 'fetchedAt' | 'publishedAt' | 'sourceId'>;
interface Quote {
  /** Offsets are UTF-16 and end-exclusive in the indicated text, cell, or header. */
  start: number;
  end: number;
  quote: string;
}

type ValueLocation = { kind: 'text' } | {
  kind: 'table';
  tableIndex: number;
  rowIndex: number;
  columnIndex: number;
  header: string;
  rowLabel?: string;
  caption?: string;
  unitCell?: { columnIndex: number; quote: string };
};

export type EvidenceSpan = EvidenceSource & Quote & ValueLocation & {
  valueStart: number;
  valueEnd: number;
  literal: string;
};

type TimeLocation =
  { kind: 'text' } |
  { kind: 'table-header'; tableIndex: number; columnIndex: number } |
  { kind: 'table-cell'; tableIndex: number; rowIndex: number; columnIndex: number } |
  { kind: 'table-caption'; tableIndex: number };

export type EvidenceTimeSpan = Quote & TimeLocation;

export interface EvidenceCandidate {
  value: EvidenceValue;
  stated: EvidenceValue;
  evidence: EvidenceSpan;
  referenceTime: EvidenceDate | null;
  timeEvidence?: EvidenceTimeSpan;
  approximate: boolean;
  scaled: boolean;
  conversion?: { from: string; to: string; factor: number };
  possiblyStale: boolean;
  freshness: 'fresh' | 'possibly-stale' | 'unknown' | 'not-applicable';
}

export interface EvidenceConflict {
  first: EvidenceCandidate;
  second: EvidenceCandidate;
  tolerance: { relative: number; absolute: number };
}

export type EvidenceGap = {
  reason: 'no-verified-value' | 'requested-time-not-found' | 'freshness-unknown';
  message: string;
};

export interface StructuredEvidenceResult {
  status: 'value' | 'conflict' | 'gap';
  /** A conflict retains the preferred observation for comparison. Consumers must also show the conflicts. */
  top: EvidenceCandidate | null;
  candidates: EvidenceCandidate[];
  conflicts: EvidenceConflict[];
  gaps: EvidenceGap[];
  read: EvidenceSource[];
}

const DEFAULT_STALE_DAYS: Partial<Record<EvidenceKind, number>> = { population: 730, gdp: 730, price: 1 };
const DAY_MS = 86_400_000;
const LENGTH_IN_METRES = new Map(Object.entries({ mm: 0.001, cm: 0.01, m: 1, km: 1_000, in: 0.0254, ft: 0.3048, yd: 0.9144, mi: 1609.344 }));
const ATTRIBUTE_FORMS: Partial<Record<EvidenceKind, readonly string[]>> = {
  population: ['population', 'resident population', 'estimated population', 'estimated resident population', 'population estimate', 'عدد السكان', 'عدد سكان', 'السكان', 'سكان'],
  gdp: ['gdp', 'gross domestic product', 'الناتج المحلي الإجمالي', 'الناتج الإجمالي المحلي'],
  price: ['price', 'priced', 'سعر', 'السعر'],
  distance: ['distance', 'المسافة', 'مسافة'],
  height: ['height', 'elevation', 'altitude', 'ارتفاع', 'الارتفاع'],
};
const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
const unobserved = /(?:\b(?:projected|projection|forecast|predicted|expected to|could reach|would reach|will reach|will be)\b|يتوقع|متوقع|توقعات|توقع ان|سيبلغ|ستبلغ|سيصل|ستصل)/u;
const changeBefore = /(?:\b(?:grew|increased|rose|fell|decreased|declined|dropped|changed)(?: by)?|\b(?:increase|decrease|growth|change) of|بمقدار|بزياده|بنقصان)\s*(?:(?:about|around|نحو|حوالي)\s*)?$/u;
const populationDerivative = /\b(?:population (?:growth|density|share|rate|index|includes?|comprised|consists)|(?:growth|density|share) of (?:the )?population)\b|(?:نمو|زياده|معدل|كثافه|نسبه) (?:عدد )?(?:ال)?سكان/u;
const gdpPerCapita = /\bper capita\b|(?:للفرد|نصيب الفرد)/u;
const publicationBefore = /\b(?:(?:published|reported|released|announced) (?:in|on)|(?:in|from) (?:a|the))$|(?:نشر|صدر|اعلن) (?:في|عام|بتاريخ)$/u;
const publicationAfter = /^(?:report|edition|press release|article|release)\b|^(?:التقرير|تقرير|النشر|الاصدار)(?: |$)/u;
const eventRetrospective = /\b(?:anniversary|years? (?:since|after|before))\b|ذكري|(?:سنوات|سنين|سنه|اعوام) (?:علي|بعد|قبل)/u;
const partialYearBefore = /\b(?:fy|q[1-4]|fiscal year|(?:first|second|third|fourth) quarter(?: of)?)$|(?:السنه الماليه|الربع (?:الاول|الثاني|الثالث|الرابع)(?: من)?)$/u;
const yearRangeStart = /^[\p{Zs}\t]*[-–—/][\p{Zs}\t]*\p{Nd}{2,4}(?!\p{Nd})/u;
const yearRangeEnd = /[\p{Nd}]{4}[\p{Zs}\t]*[-–—/][\p{Zs}\t]*$/u;

function fold(text: string): string {
  return text.normalize('NFC').toLowerCase().replace(/[ـً-ٰٟ]/gu, '').replace(/[أإآٱ]/gu, 'ا')
    .replace(/ى/gu, 'ي').replace(/ة/gu, 'ه').replace(/[’']s\b/gu, ' possessive ').replace(/[’‘']/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function names(values: readonly string[]): string[] {
  return [...new Set(values.map(fold).filter(Boolean))];
}

function has(text: string, terms: readonly string[]): boolean {
  return terms.some(term => ` ${text} `.includes(` ${term} `));
}

function begins(text: string, terms: readonly string[]): boolean {
  return terms.some(term => `${text} `.startsWith(`${term} `));
}

function source(page: StructuredEvidencePage): EvidenceSource {
  const { url, title, fetchedAt, publishedAt, sourceId } = page;
  return { url, title, fetchedAt, ...(publishedAt !== undefined && { publishedAt }), ...(sourceId && { sourceId }) };
}

function sourceUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    parsed.hash = '';
    return parsed.href;
  } catch {
    return null;
  }
}

function sameDate(left: EvidenceDate, right: EvidenceDate): boolean {
  return left.calendar === right.calendar && left.year === right.year && left.month === right.month && left.day === right.day;
}

function matchesPeriod(date: EvidenceDate, period: EvidenceDate): boolean {
  return date.calendar === period.calendar && date.year === period.year
    && (period.month === undefined || date.month === period.month)
    && (period.day === undefined || date.day === period.day);
}

function dateOrder(date: EvidenceDate): number {
  return date.year * 10_000 + (date.month ?? 0) * 100 + (date.day ?? 0);
}

function overlapping(left: { start: number; end: number }, right: { start: number; end: number }): boolean {
  return left.start < right.end && right.start < left.end;
}

function dated(token: DateToken, text: string, location: Exclude<TimeLocation, { kind: 'text' }> |
  { kind: 'text'; offset: number },
): { date: EvidenceDate; span: EvidenceTimeSpan } {
  const offset = location.kind === 'text' ? location.offset : 0;
  const place = location.kind === 'text' ? { kind: 'text' as const } : location;
  return { date: token.date, span: { ...place, start: offset + token.start, end: offset + token.end, quote: text.slice(token.start, token.end) } };
}

type Dated = ReturnType<typeof dated>;

/** One period, optionally repeated at different precision. Distinct periods are ambiguous. */
function distinctPeriod(dates: readonly Dated[]): Dated | null {
  const precise = dates.reduce<Dated | null>((best, item) => !best ||
    Number(item.date.month !== undefined) + Number(item.date.day !== undefined)
    > Number(best.date.month !== undefined) + Number(best.date.day !== undefined) ? item : best, null);
  return precise && dates.every(item => matchesPeriod(precise.date, item.date)) ? precise : null;
}

function freshness(time: EvidenceDate | null, now: number, maxAge: number | undefined): EvidenceCandidate['freshness'] {
  if (maxAge === undefined) return 'not-applicable';
  if (!time || time.calendar !== 'gregorian') return 'unknown';
  // A value known only to a year or month can be as recent as the end of that period.
  const end = new Date(0);
  const latest = end.setUTCFullYear(time.year, time.day === undefined ? time.month ?? 12 : (time.month ?? 1) - 1,
    time.day ?? 0) + DAY_MS - 1;
  return now - latest > maxAge * DAY_MS ? 'possibly-stale' : 'fresh';
}

function bounds(value: Exclude<EvidenceValue, { kind: 'date' }>): [number, number] {
  if (value.kind === 'number') return [value.value, value.value];
  return [value.min, value.max];
}

function finiteOption(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function comparable(left: EvidenceCandidate, right: EvidenceCandidate, kind: EvidenceKind): boolean {
  if (left.referenceTime && right.referenceTime) return sameDate(left.referenceTime, right.referenceTime);
  return !left.referenceTime && !right.referenceTime
    && (left.value.kind === 'date' || kind === 'height' || kind === 'distance');
}

function disagree(left: EvidenceValue, right: EvidenceValue, relative: number, absolute: number): boolean {
  if (left.kind === 'date' || right.kind === 'date') {
    return left.kind === 'date' && right.kind === 'date'
      && left.date.calendar === right.date.calendar
      && !matchesPeriod(left.date, right.date) && !matchesPeriod(right.date, left.date);
  }
  const [min, max] = bounds(left);
  const [otherMin, otherMax] = bounds(right);
  const tolerance = Math.max(absolute, relative * Math.max(Math.abs(min), Math.abs(max), Math.abs(otherMin), Math.abs(otherMax)));
  return min - otherMax > tolerance || otherMin - max > tolerance;
}

function tokenValue(token: NumericToken, unit: string, scale = 1): Exclude<EvidenceValue, { kind: 'date' }> {
  const value = token.value * scale;
  if (token.upper === undefined) return { kind: 'number', value, unit };
  const upper = token.upper * scale;
  return { kind: 'range', min: Math.min(value, upper), max: Math.max(value, upper), unit };
}

function numericValue(token: NumericToken, targetUnit: string, context: ReturnType<typeof parseEvidenceUnitContext>) {
  let unit = token.unit ?? context.unit;
  if (unit === 'dollar' && context.unit?.endsWith('D') && /^(?:USD|AUD|CAD|NZD|HKD|SGD)$/u.test(context.unit)) unit = context.unit;
  if (unit === 'riyal' && context.unit && /^(?:SAR|QAR)$/u.test(context.unit)) unit = context.unit;
  if (unit === 'yen-or-yuan' && context.unit && /^(?:JPY|CNY)$/u.test(context.unit)) unit = context.unit;
  if (!unit && targetUnit === 'count') unit = 'count';
  if (!unit) return null;
  const scale = token.scaled || token.unit ? 1 : context.scale ?? 1;
  const stated = tokenValue(token, unit, scale);
  const factor = unit === targetUnit ? 1 : (LENGTH_IN_METRES.get(unit) ?? NaN) / (LENGTH_IN_METRES.get(targetUnit) ?? NaN);
  if (!Number.isFinite(factor)) return null;
  const value = tokenValue(token, targetUnit, scale * factor);
  if (![...bounds(stated), ...bounds(value)].every(amount => Number.isFinite(amount) && Math.abs(amount) <= Number.MAX_SAFE_INTEGER)) return null;
  return { value, stated, scaled: token.scaled || scale !== 1,
    ...(unit !== targetUnit && { conversion: { from: unit, to: targetUnit, factor } }) };
}

function quoteAt(text: string, start: number, end: number): Quote {
  return { start, end, quote: text.slice(start, end) };
}

function valueSpan(page: EvidenceSource, quote: Quote, location: ValueLocation, start: number, end: number): EvidenceSpan {
  return { ...page, ...quote, ...location, valueStart: start, valueEnd: end,
    literal: quote.quote.slice(start - quote.start, end - quote.start) };
}

function makeCandidate(
  value: Pick<EvidenceCandidate, 'value' | 'stated' | 'scaled' | 'conversion'>,
  evidence: EvidenceSpan, time: Dated | null, approximate: boolean, now: number, staleAfter: number | undefined,
): EvidenceCandidate {
  const state = freshness(time?.date ?? null, now, staleAfter);
  return { ...value, evidence, referenceTime: time?.date ?? null, ...(time && { timeEvidence: time.span }),
    approximate, freshness: state, possiblyStale: state === 'possibly-stale' };
}

function startsWithAttribute(text: string, attributes: readonly string[]): boolean {
  const body = text.replace(/^(?:the |an |a )/u, '');
  return attributes.some(attribute => {
    if (!begins(body, [attribute])) return false;
    const rest = body.slice(attribute.length).trim();
    return /^(?:(?:is|was|were|stood at|reached|amounted to|بلغ|بلغت|يبلغ|تبلغ|كان|كانت|نحو|حوالي|في|عام|سنه)(?: |$)|\p{N})/u.test(rest);
  });
}

function boundSubject(text: string, entities: readonly string[], attributes: readonly string[]): boolean {
  const words = ` ${text} `;
  return entities.some(entity => attributes.some(attribute => [
    `${entity} ${attribute}`, `${entity} possessive ${attribute}`,
    `${entity} is ${attribute}`, `${entity} is an ${attribute}`, `${entity} was ${attribute}`, `${entity} had a ${attribute}`,
    `${entity} has a ${attribute}`, `${entity} had an ${attribute}`, `${entity} has an ${attribute}`,
    `${entity} with a ${attribute}`, `${entity} with an ${attribute}`,
  ].some(phrase => words.includes(` ${phrase} `))
    || ['', 'of ', 'in ', 'for ', 'from '].some(link => {
      const phrase = ` ${attribute} ${link}${entity} `;
      return words.includes(phrase) && !words.includes(`${phrase}possessive `);
    })));
}

const clauseSeparator = /[;؛]|(?:[,،]\s*)?\b(?:while|whereas|versus|compared (?:with|to)|but|(?:lower|higher|smaller|larger|fewer|greater|less|more) than)\b|(?:[,،]\s*)?(?<![\p{L}])(?:بينما|في حين|مقارنة (?:مع|ب)|لكن|(?:أقل|أكثر|أكبر|أصغر) من)(?![\p{L}])|(?:[,،]\s*)?\band(?=\s+(?:(?:in|as of|by|to|around|about)\s+)?[+−-]?[\p{Nd}])|(?<![\p{L}])و(?=\s*(?:(?:في|عام|نحو|حوالي)\s+)?[+−-]?[\p{Nd}])/giu;
const continuation = /^\s*(?:(?:and|in|as of|by|to|about|around|و|في|عام|سنة|نحو|حوالي)\s*)?[+−-]?[\p{Nd}]/iu;
const comparative = /(?:while|whereas|versus|compared|but|than|بينما|حين|مقارنة|لكن|من)/iu;

function* clauses(text: string): Iterable<{ text: string; offset: number; continued: boolean }> {
  let offset = 0, continued = false;
  for (const separator of text.matchAll(clauseSeparator)) {
    if (/\band\b/iu.test(separator[0]) && /\bbetween\b[^;؛]*\p{Nd}[^;؛]*$/iu.test(text.slice(offset, separator.index))) continue;
    yield { text: text.slice(offset, separator.index), offset, continued };
    offset = separator.index + separator[0].length;
    continued = !comparative.test(separator[0]);
  }
  yield { text: text.slice(offset), offset, continued };
}

function* sentences(text: string): Iterable<Quote> {
  for (const line of text.matchAll(/[^\r\n]+/gu)) {
    for (const { segment, index } of segmenter.segment(line[0])) {
      const start = line.index + index + segment.length - segment.trimStart().length;
      const end = line.index + index + segment.trimEnd().length;
      if (end > start) yield quoteAt(text, start, end);
    }
  }
}

interface ExtractionContext {
  entities: string[];
  attributes: string[];
  kind: EvidenceKind;
  unit: string;
  now: number;
  staleAfter: number | undefined;
  totalPopulation: boolean;
  aggregateGdp: boolean;
}

/** Numeric citation markers carry no measure. Preserve their width for evidence offsets. */
function withoutCitations(text: string): string {
  return text.replace(/\[[\p{Nd}\s,،]+\]/gu, marker => ' '.repeat(marker.length));
}

function dateValues(dates: readonly DateToken[]): readonly DateToken[] {
  const calendars = new Set(dates.map(token => token.date.calendar));
  // The same date may be printed in two calendars. A list of different dates needs more attribution.
  return calendars.size === dates.length ? dates : [];
}

function referenceDates(dates: readonly DateToken[], raw: string): DateToken[] {
  return dates.filter(date => {
    const before = raw.slice(0, date.start), after = raw.slice(date.end);
    const prefix = fold(before);
    if (publicationBefore.test(prefix) || publicationAfter.test(fold(after))) return false;
    return date.date.month !== undefined ||
      (!partialYearBefore.test(prefix) && !yearRangeStart.test(after) && !yearRangeEnd.test(before));
  });
}

function geometrySubject(raw: string, text: string, entities: readonly string[]): boolean {
  // A leading measurement can modify the named subject immediately after the comma.
  if (/^(?:ascending to|rising to|from (?:a|an|the))\b/u.test(text)) {
    const separator = raw.indexOf(',');
    // Grouped numbers can contain commas. Match the clause where the subject actually starts.
    if (separator !== -1 && [...raw.matchAll(/,(?=\s*\p{L})/gu)]
      .some(match => begins(fold(raw.slice(match.index + 1)).replace(/^the /u, ''), entities))) return true;
  }
  return begins(text, entities) && /(?:يبلغ|تبلغ) (?:ارتفاعه|ارتفاعها|طوله|طولها|الارتفاع|الطول)(?: |$)/u.test(text);
}

function pickNumber(
  tokens: readonly NumericToken[], raw: string, unit: string, units: ReturnType<typeof parseEvidenceUnitContext>,
) {
  const proposed = tokens.flatMap(token => {
    if (changeBefore.test(fold(raw.slice(0, token.start)))) return [];
    const value = numericValue(token, unit, units);
    return value ? [{ token, value }] : [];
  });
  if (proposed.length <= 1) return proposed[0];
  // Publishers often give an equivalent in parentheses. Prefer the actual requested unit if the
  // two amounts are compatible at ordinary published rounding precision.
  const [first, second] = proposed;
  if (proposed.length !== 2 || !!first.value.conversion === !!second.value.conversion
    || !/^\s*\(\s*$/u.test(raw.slice(first.token.end, second.token.start))
    || !/^\s*\)/u.test(raw.slice(second.token.end))
    || disagree(first.value.value, second.value.value, 0.03, 0)) return;
  return first.value.conversion ? second : first;
}

function* textCandidates(page: StructuredEvidencePage, context: ExtractionContext): Iterable<EvidenceCandidate> {
  const { entities, attributes, kind, unit, now, staleAfter, totalPopulation, aggregateGdp } = context;
  const title = fold(page.title);
  const subjectPage = entities.includes(title) || entities.includes(fold(page.title.split(/\s(?:[-–—]|\|)\s/u)[0]));
  const pageSource = source(page);
  for (const sentence of sentences(page.text)) {
    let priorSubject: boolean = false;
    for (const clause of clauses(sentence.quote)) {
      const raw = withoutCitations(clause.text);
      const normalized = fold(raw);
      const named = has(normalized, entities);
      const attribute = has(normalized, attributes);
      const direct = named && attribute && (boundSubject(normalized, entities, attributes)
        || kind === 'event-date'
        || (kind === 'distance' || kind === 'height') && geometrySubject(raw, normalized, entities)
        || kind === 'price' && attributes.some(term => has(term, entities) && has(normalized, [term]))
        || begins(normalized.replace(/^the /u, ''), entities) && (kind === 'price' || kind === 'gdp' || kind === 'other'));
      const propertyLead = normalized.replace(/^(?:(?:it |the )?(?:is|was) )?(?:the )?(?:fee for (?:a |an |the )?|يبلغ |تبلغ |بلغ |بلغت )/u, '');
      const titlePrice = kind === 'price' && has(title, entities) && attribute
        && (startsWithAttribute(propertyLead, attributes) || /^\p{N}/u.test(normalized)
          && attributes.some(term => normalized.endsWith(` ${term}`)));
      const implicit = !named && ((subjectPage && (startsWithAttribute(propertyLead, attributes)
        || kind === 'height' && /\b(?:the )?(?:new )?official (?:height|elevation) (?:is|was)\b/u.test(normalized))) || titlePrice);
      const inherited: boolean = clause.continued && priorSubject && !named && !attribute && continuation.test(raw);
      priorSubject = (direct || implicit || inherited) && !unobserved.test(normalized)
        && !(totalPopulation && populationDerivative.test(normalized)) && !(aggregateGdp && gdpPerCapita.test(normalized));
      if (!priorSubject) continue;

      const offset = sentence.start + clause.offset;
      const span = (token: { start: number; end: number }) =>
        valueSpan(pageSource, sentence, { kind: 'text' }, offset + token.start, offset + token.end);
      const allDates = parseEvidenceDates(raw);
      const dates = referenceDates(allDates, raw);
      if (unit === 'date') {
        // Dates of publication are input metadata, and only explicit event wording enters this branch.
        if (eventRetrospective.test(normalized)) continue;
        for (const token of dateValues(dates)) {
          const value: EvidenceValue = { kind: 'date', date: token.date };
          yield makeCandidate({ value, stated: value, scaled: false }, span(token), null, false, now, staleAfter);
        }
        continue;
      }

      const tokens = parseEvidenceNumbers(raw);
      const numbers = tokens.filter(token => !allDates.some(date => overlapping(date, token)
        && (date.date.month !== undefined || date.start !== token.start || date.end >= token.end
          || (!token.unit && !token.scaled))));
      const times = dates.filter(date => !numbers.some(token => overlapping(date, token)))
        .map(date => dated(date, raw, { kind: 'text', offset }));
      const time = distinctPeriod(times);
      if (times.length && !time) continue;
      const proposed = pickNumber(numbers, raw, unit, {});
      if (!proposed) continue;
      const { token, value } = proposed;
      yield makeCandidate(value, span(token), time, token.approximate, now, staleAfter);
    }
  }
}

function* tableCandidates(page: StructuredEvidencePage, context: ExtractionContext): Iterable<EvidenceCandidate> {
  const { entities, attributes, unit, now, staleAfter, totalPopulation, aggregateGdp } = context;
  const title = fold(page.title);
  const pageSource = source(page);
  for (const [tableIndex, table] of (page.tables ?? []).entries()) {
    const rawCaption = table.caption ?? '';
    const caption = fold(rawCaption);
    const headers = table.headers.map(fold);
    const dateColumns = headers.map(header => /^(?:as of|reference (?:date|period)|date|year|period|السنه|السنه المرجعيه|سنه|العام|عام|التاريخ|تاريخ|الفتره)$/u.test(header));
    const unitsColumn = headers.findIndex(header => /^(?:units?|وحده|الوحده|وحده القياس)$/u.test(header));
    const rowKey = /^(?:country|location|city|entity|name|region|state|county|province|territory|locality|subject|area|place|البلد|الدوله|المدينه|المنطقه|الولايه|المحافظه|المكان|الاسم)$/u.test(headers[0] ?? '');
    const captionUnit = parseEvidenceUnitContext(rawCaption);
    const titleUnit = parseEvidenceUnitContext(page.title);
    for (const [rowIndex, row] of table.rows.entries()) {
      const rowLabel = row[0];
      const label = fold(rowLabel ?? '');
      const rowAttribute = has(label, attributes);
      const rowEntity = rowKey ? entities.includes(label) : has(label, entities);
      if (rowKey && !rowEntity) continue;
      const rowPeriods = row.flatMap((cell, columnIndex) => dateColumns[columnIndex]
        ? referenceDates(parseEvidenceDates(cell), cell).map(date => dated(date, cell, { kind: 'table-cell', tableIndex, rowIndex, columnIndex }))
        : []);
      const unitCell = row[unitsColumn];
      const cellUnit = unitCell === undefined ? {} : parseEvidenceUnitContext(unitCell);
      for (const [columnIndex, cell] of row.entries()) {
        const header = table.headers[columnIndex] ?? '';
        const column = headers[columnIndex] ?? '';
        const timeColumn = dateColumns[columnIndex];
        if (columnIndex === unitsColumn || columnIndex === 0 && (rowKey || rowAttribute || rowEntity)) continue;
        if (unit !== 'date' && timeColumn) continue;
        const localEntity = rowEntity || has(column, entities);
        const localAttribute = rowAttribute || has(column, attributes);
        const pageEntity = has(caption, entities) || has(title, entities);
        const pageAttribute = has(caption, attributes) || has(title, attributes);
        const headerDates = parseEvidenceDates(header);
        const genericColumn = !column || headerDates.length > 0 || timeColumn
          || /^(?:value|estimate|total|القيمه|الاجمالي|التقدير)$/u.test(column)
          || parseEvidenceUnitContext(header).unit !== undefined;
        if (!(localEntity || pageEntity) || !(localAttribute || (pageAttribute && genericColumn))
          || (totalPopulation && populationDerivative.test(`${label} ${column}`))
          || (aggregateGdp && gdpPerCapita.test(`${label} ${column} ${caption} ${title}`))) continue;
        const quote = quoteAt(cell, 0, cell.length);
        const span = (token: { start: number; end: number }) => valueSpan(pageSource, quote,
          { kind: 'table', tableIndex, rowIndex, columnIndex, header, ...(columnIndex !== 0 && { rowLabel }),
            ...(unitCell !== undefined && { unitCell: { columnIndex: unitsColumn, quote: unitCell } }),
            ...(table.caption !== undefined && { caption: table.caption }) }, token.start, token.end);
        const raw = withoutCitations(cell);
        const cellDates = parseEvidenceDates(raw);
        if (unit === 'date') {
          for (const token of dateValues(cellDates)) {
            const value: EvidenceValue = { kind: 'date', date: token.date };
            yield makeCandidate({ value, stated: value, scaled: false }, span(token), null, false, now, staleAfter);
          }
          continue;
        }
        const periods = [...referenceDates(headerDates, header).map(date => dated(date, header, { kind: 'table-header', tableIndex, columnIndex })),
          ...rowPeriods];
        if (!periods.length) periods.push(...referenceDates(parseEvidenceDates(rawCaption), rawCaption)
          .map(date => dated(date, rawCaption, { kind: 'table-caption', tableIndex })));
        const time = distinctPeriod(periods);
        if (periods.length && !time) continue;
        const rowUnit = columnIndex !== 0 && rowAttribute ? parseEvidenceUnitContext(rowLabel ?? '') : {};
        const headerUnit = parseEvidenceUnitContext(header);
        const unitContext = { unit: headerUnit.unit ?? cellUnit.unit ?? rowUnit.unit ?? captionUnit.unit ?? titleUnit.unit,
          scale: headerUnit.scale ?? cellUnit.scale ?? rowUnit.scale ?? captionUnit.scale ?? titleUnit.scale };
        const tokens = parseEvidenceNumbers(raw).filter(token =>
          !cellDates.some(date => date.date.month !== undefined && overlapping(date, token)));
        const proposed = pickNumber(tokens, raw, unit, unitContext);
        if (proposed) yield makeCandidate(proposed.value, span(proposed.token), time, proposed.token.approximate, now, staleAfter);
      }
    }
  }
}

function candidateTime(candidate: EvidenceCandidate): EvidenceDate | null {
  return candidate.value.kind === 'date' ? candidate.value.date : candidate.referenceTime;
}

function latestFirst(left: EvidenceCandidate, right: EvidenceCandidate): number {
  const a = left.referenceTime, b = right.referenceTime;
  if (a && b && a.calendar === b.calendar) return dateOrder(b) - dateOrder(a);
  if (a && b) return a.calendar === 'gregorian' ? -1 : 1;
  return Number(b !== null) - Number(a !== null);
}

function sourceKey(candidate: EvidenceCandidate): string | null {
  return candidate.evidence.sourceId || sourceUrl(candidate.evidence.url);
}

/** Extract observations only from the caller's already-read evidence. This function performs no I/O. */
export function extractStructuredEvidence(
  target: StructuredEvidenceTarget, pages: readonly StructuredEvidencePage[], options: StructuredEvidenceOptions = {},
): StructuredEvidenceResult {
  const allowed = target.allowedSourceUrls && new Set(target.allowedSourceUrls.map(sourceUrl).filter(Boolean));
  const unit = normalizeEvidenceUnit(target.unit) ?? target.unit.trim().toLowerCase();
  const attribute = fold(target.attribute);
  const inferredKind = (Object.keys(ATTRIBUTE_FORMS) as EvidenceKind[])
    .find(item => names(ATTRIBUTE_FORMS[item] ?? []).includes(attribute));
  const kind = target.kind ?? (unit === 'date' ? 'event-date' : inferredKind ?? 'other');
  const configuredNow = options.now === undefined ? Date.now() : Date.parse(options.now);
  const threshold = finiteOption(options.staleAfterDays?.[kind], DEFAULT_STALE_DAYS[kind] ?? Infinity);
  const forms = names(ATTRIBUTE_FORMS[kind] ?? []);
  const generic = forms.includes(attribute);
  const context: ExtractionContext = {
    entities: names([target.entity, ...target.entityAliases ?? []]),
    attributes: names([target.attribute, ...(target.attributeAliases ?? []), ...(generic ? forms : [])]),
    kind, unit, now: Number.isFinite(configuredNow) ? configuredNow : Date.now(),
    staleAfter: Number.isFinite(threshold) ? threshold : undefined,
    totalPopulation: kind === 'population' && generic,
    aggregateGdp: kind === 'gdp' && !gdpPerCapita.test(attribute),
  };
  const read = pages.map(source);
  const candidates: EvidenceCandidate[] = [];
  if (context.entities.length && target.attribute.trim() && unit) {
    for (const page of pages) {
      const url = sourceUrl(page.url);
      if (!url || (allowed && !allowed.has(url))) continue;
      for (const candidate of textCandidates(page, context)) candidates.push(candidate);
      for (const candidate of tableCandidates(page, context)) candidates.push(candidate);
    }
  }
  const eligible = candidates.filter(candidate => {
    if (!target.time) return true;
    const time = candidateTime(candidate);
    return time !== null && matchesPeriod(time, target.time);
  }).sort((a, b) => latestFirst(a, b) || Number(a.approximate) - Number(b.approximate));
  const top = eligible[0] ?? null;
  const gaps: EvidenceGap[] = [];
  if (!top) {
    gaps.push({ reason: target.time && candidates.length ? 'requested-time-not-found' : 'no-verified-value', message: 'لم أجد قيمة موثقة' });
    return { status: 'gap', top, candidates, conflicts: [], gaps, read };
  }
  if (top.freshness === 'unknown') gaps.push({ reason: 'freshness-unknown', message: 'لم أجد تاريخًا مرجعيًا يكفي للتحقق من حداثة القيمة' });
  const tolerance = { relative: finiteOption(options.relativeTolerance, 0.01), absolute: finiteOption(options.absoluteTolerance, 0) };
  const conflicts: EvidenceConflict[] = [];
  for (const [index, first] of eligible.entries()) {
    for (const second of eligible.slice(index + 1)) {
      if (sourceKey(first) === sourceKey(second) || sourceUrl(first.evidence.url) === sourceUrl(second.evidence.url)
        || !comparable(first, second, kind)) continue;
      if (disagree(first.value, second.value, tolerance.relative, tolerance.absolute)) conflicts.push({ first, second, tolerance });
    }
  }
  return { status: conflicts.length ? 'conflict' : 'value', top, candidates, conflicts, gaps, read };
}
