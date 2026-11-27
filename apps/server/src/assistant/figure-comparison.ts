import { normalizeAnswerDigits } from './answer-check.js';
import { parseEvidenceDates, parseEvidenceNumbers, type EvidenceDate, type NumericToken } from './structured-evidence-parsing.js';

export type FigureComparison =
  | { kind: 'agree' | 'different-period' | 'different-value' | 'different-unit' | 'uncomparable' }
  | { kind: 'agree-period-unstated'; unstatedSource: 'first' | 'second' };

interface Period {
  start: number;
  end: number;
  key: string;
}

interface Quantity {
  value: number;
  upper?: number;
  unit?: string;
  period?: string;
  roundingStep: number;
}

// Sources retrieved 2026-11-27. The evidence parser supplies the long scale and unit names.
// CLDR English and Arabic compact numbers, units, and currency names:
// https://www.unicode.org/cldr/charts/48/verify/numbers/en.html
// https://www.unicode.org/cldr/charts/48/verify/numbers/ar.html
// https://www.unicode.org/cldr/charts/48/summary/en.html
// https://www.unicode.org/cldr/charts/48/summary/ar.html
// Cairo Arabic Language Academy (ألف/آلاف، مليون/ملايين، مليار/مليارات، شخص/أشخاص):
// https://www.arabicacademy.gov.eg/ar/search_engine/roots/ألف
// https://www.arabicacademy.gov.eg/ar/search_engine/roots/مليون
// https://www.arabicacademy.gov.eg/ar/search_engine/roots/مليار
// https://www.arabicacademy.gov.eg/ar/محرك-البحث/الشخص
// Cambridge Dictionary for k and bn:
// https://dictionary.cambridge.org/dictionary/english/k?topic=informal-words-for-money
// https://dictionary.cambridge.org/dictionary/english/bn
const SHORT_SCALE: Readonly<Record<string, string>> = { k: 'thousand', K: 'thousand', M: 'million', bn: 'billion' };

// ISO 4217 codes and ECMA-402 currency identifiers:
// https://www.iso.org/iso-4217-currency-codes.html
// https://tc39.es/ecma402/#sec-currency-codes
const CURRENCY_CODES = new Set(Intl.supportedValuesOf('currency'));
const AMBIGUOUS_CURRENCY = new Set(['dollar', 'yen-or-yuan', 'riyal', 'dirham', 'dinar', 'pound']);

function normalize(text: string): string {
  // Digit families, Arabic decimal and thousands marks: https://www.w3.org/TR/alreq/
  return normalizeAnswerDigits(text.replace(/[\u061c\u0640\u064b-\u065f\u0670\u200b-\u200f\u202a-\u202e\u2066-\u2069*]/gu, ''))
    .replace(/(?<!\d)\d{1,3}(?:[ \u00a0\u202f\u2009]\d{3})+(?!\d)/gu, grouped => grouped.replace(/\p{Zs}/gu, '٬'))
    .replace(/\d+(?:[.,]\d+)+/gu, literal => {
      // A single three-digit group after a comma is read as grouping. A single dot is decimal.
      if (/^\d{1,3}(?:\.\d{3})+,\d+$/u.test(literal)) return literal.replace(/\./gu, '٬').replace(',', '٫');
      if (/^\d{1,3}(?:\.\d{3}){2,}$/u.test(literal)) return literal.replace(/\./gu, '٬');
      if (/^\d+,\d+$/u.test(literal) && !/^\d{1,3},\d{3}$/u.test(literal)) return literal.replace(',', '٫');
      return literal;
    })
    .replace(/(\d)(?:[\p{Zs}]*(k|M|bn)|(K))(?![\p{L}\p{N}])/gu, (_, digit: string, scale?: string) => `${digit} ${SHORT_SCALE[scale ?? 'K']}`)
    .replace(/(?<=\d)[A-Z]{3}(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])[A-Z]{3}(?=[+-]?\d)/gu, (code, index: number, line: string) => {
      if (!CURRENCY_CODES.has(code)) return code;
      return /\d/u.test(line[index - 1] ?? '') ? ` ${code}` : `${code} `;
    });
}

const YEAR_LEAD = /(?<!\p{L})(?<lead>as of|as at|in|during|for|by|since|until|through|year|estimates?(?: for| of)?|census(?: of)?|في|عام|سنة|العام|السنة|حتى|منذ|تقديرات|تعداد|لعام|لسنة)\s*$/iu;
const YEAR_PART = /(?<!\p{L})(fiscal|early|mid|late|بداية|منتصف|نهاية)\s*[-–]?\s*$/iu;
const YEAR_PARTS: Readonly<Record<string, string>> = { بداية: 'early', منتصف: 'mid', نهاية: 'late' };
const YEAR_RANGE = /(?<![\p{L}\p{N}/.,٫٬-])(?<first>(?:1\d|2[01])\d{2})\s*(?:[-‐‑‒–—−]|(?:to|through|and|إلى|الى|حتى)\s+|و\s*)(?<last>(?:1\d|2[01])\d{2})(?![\p{L}\p{N}/-]|[.,٫٬]\d)/giu;
const RANGE_LEAD = /(?<!\p{L})(?:between|from|بين|من)\s*$/iu;
const RANGE_JOIN = /^\s*(?:[-‐‑‒–—−]|to|through|and|إلى|الى|حتى|و)\s*$/iu;
const RANGE_AND = /^\s*(?:and|و)\s*$/iu;

function dateKey(date: EvidenceDate): string {
  return [date.calendar, date.year, date.month, date.day].filter(part => part !== undefined).join('/');
}

const OPEN_PERIOD: Readonly<Record<string, string>> = { since: 'since', منذ: 'since', until: 'until', through: 'until', حتى: 'until' };

function leadingPeriod(text: string, start: number): { start: number; qualifier: string } | undefined {
  const lead = text.slice(0, start);
  const part = YEAR_PART.exec(lead);
  const marker = YEAR_LEAD.exec(part ? lead.slice(0, part.index) : lead);
  if (!part && !marker) return;
  const name = part?.[1].toLowerCase() ?? '';
  const direction = OPEN_PERIOD[marker?.groups?.lead.toLowerCase() ?? ''] ?? '';
  return { start: marker?.index ?? part!.index, qualifier: direction + (YEAR_PARTS[name] ?? name) };
}

function periodsOf(text: string, numbers: NumericToken[]): Period[] {
  const periods: Period[] = [];
  for (const match of text.matchAll(YEAR_RANGE)) {
    const { first, last } = match.groups!;
    const start = match.index;
    const end = start + match[0].length;
    const lead = text.slice(0, start);
    const rangeLead = RANGE_LEAD.exec(lead);
    const part = leadingPeriod(text, start);
    const separator = match[0].slice(first.length, -last.length);
    if (RANGE_AND.test(separator) && !rangeLead) continue;
    const measured = numbers.some(number => number.start < end && start < number.end && (number.unit || number.scaled));
    if (measured || Number(first) > Number(last)) continue;
    if (part === undefined && !rangeLead && !/^(?:\s*$|\s*[,،;؛.:)])/u.test(text.slice(end))) continue;
    periods.push({
      start: part?.start ?? rangeLead?.index ?? start,
      end,
      key: `gregorian/${first}:${part?.qualifier ?? ''}..gregorian/${last}:`,
    });
  }

  // The shared evidence date parser handles named dates, as well as ISO-style dates and explicit calendars.
  // ISO 8601 (retrieved 2026-11-27): https://www.iso.org/iso-8601-date-and-time-format.html
  const dates: Period[] = [];
  for (const { start, end, date } of parseEvidenceDates(text)) {
    if (periods.some(period => period.start < end && start < period.end)) continue;
    const bareYear = /^\d{4}$/u.test(text.slice(start, end));
    const part = leadingPeriod(text, start);
    const bareSentence = /^\s*\(?\d{4}\)?[.!؟]?\s*$/u.test(text);
    const yearHeading = !text.slice(0, start).trim() && /^\s*:/u.test(text.slice(end));
    const parenthetical = text[start - 1] === '(' && text[end] === ')';
    const measured = numbers.some(number => number.start <= start && end <= number.end && (number.unit || number.scaled));
    if (measured && (bareYear || date.month === undefined && !part)) continue;
    if (bareYear && !part && !bareSentence && !yearHeading && !parenthetical) continue;
    dates.push({ start: part?.start ?? start, end, key: `${dateKey(date)}:${part?.qualifier ?? ''}` });
  }
  for (let index = 0; index < dates.length; index++) {
    const current = dates[index]!;
    const next = dates[index + 1];
    const gap = next && text.slice(current.end, next.start);
    if (next && gap && RANGE_JOIN.test(gap) && (!RANGE_AND.test(gap) || RANGE_LEAD.test(text.slice(0, current.start)))) {
      periods.push({ start: current.start, end: next.end, key: `${current.key}..${next.key}` });
      index++;
    } else {
      periods.push(current);
    }
  }
  return periods;
}

// NIST describes rounding uncertainty as half the last displayed place. Use a strict boundary,
// and only when a scale is printed. Cap that allowance to 0.5% of the smaller magnitude as policy.
// https://www.nist.gov/pml/special-publication-811/nist-guide-si-appendix-b-conversion-factors
// NIST's exact international mile in kilometres:
// https://www.nist.gov/pml/special-publication-811/nist-guide-si-appendix-b-conversion-factors/nist-guide-si-appendix-b9
// Both retrieved 2026-11-27.
const MILE_IN_KM = 1.609344;
const MAX_RELATIVE_ROUNDING = 0.005;

function roundingStep(literal: string, number: NumericToken): number {
  if (!number.scaled || number.upper !== undefined || number.value === 0) return 0;
  const printed = /(?:\d|[.٫](?=\d))[\d.,٫٬،\p{Zs}'’]*/u.exec(literal)?.[0]
    .replace(/[,٬،\p{Zs}'’]/gu, '').replace('٫', '.');
  if (!printed) return 0;
  const decimalPlaces = printed.split('.')[1]?.length ?? 0;
  const scalePower = Math.round(Math.log10(Math.abs(number.value / Number(printed))));
  return 10 ** (scalePower - decimalPlaces);
}

const UNIT_FREE_TAIL = /^\s*(?:$|[.,;:!?؟،؛)\]]|(?:as|according|in|for|at|on|by|from|between|during|since|until|through|based|estimated|currently|today|respectively|approximately|roughly|about|so far|في|عام|سنة|لعام|لسنة|حتى|منذ|بين|من|تقديرات|تعداد|نحو|تقريبا|بحسب|حسب|وفقا|وفق|حاليا|اليوم|على التوالي)(?!\p{L}))/iu;
const COMPOUND_SUFFIX = /^\s*(?:squared|cubed|مربع(?:ة)?|مكعب(?:ة)?|an?\s+(?:second|minute|hour|day|week|month|year)|في\s+(?:الثانية|الدقيقة|الساعة|اليوم|الأسبوع|الشهر|السنة|العام))(?!\p{L})/iu;
const POPULATION = /(?<!\p{L})(?:population|(?:عدد\s+)?(?:ال)?سكان\p{L}{0,3})(?!\p{L})/iu;

function adjacentCurrency(before: string, after: string): string | undefined {
  const prefix = /(?<![\p{L}\p{N}])([A-Z]{3})\s*$/u.exec(before)?.[1];
  const suffix = /^\s*([A-Z]{3})(?![\p{L}\p{N}])/u.exec(after)?.[1];
  if (prefix && CURRENCY_CODES.has(prefix)) return prefix;
  if (suffix && CURRENCY_CODES.has(suffix)) return suffix;
  return undefined;
}

function readFigure(sentence: string, dateOnly: boolean): Quantity | string | undefined {
  const text = normalize(sentence);
  const observed = parseEvidenceNumbers(text);
  const periods = periodsOf(text, observed);
  const periodKeys = new Set(periods.map(period => period.key));
  if (periodKeys.size > 1) return;
  const period = periodKeys.values().next().value;
  if (dateOnly) return period;
  const remainder = periods.sort((left, right) => right.start - left.start).reduce(
    (line, { start, end }) => line.slice(0, start) + ' '.repeat(end - start) + line.slice(end), text,
  );
  const numbers = periods.length ? parseEvidenceNumbers(remainder) : observed;
  if (numbers.length !== 1) return;
  const number = numbers[0]!;
  const before = remainder.slice(0, number.start);
  const after = remainder.slice(number.end);
  // A skipped number, unparsed unit, or another claim makes the figure ambiguous.
  if (/\d/u.test(before + after) || COMPOUND_SUFFIX.test(after)) return;
  const code = adjacentCurrency(before, after);
  let unit = number.unit ?? code;
  if (AMBIGUOUS_CURRENCY.has(unit ?? '') || code && code !== unit) return;
  if (!unit && !UNIT_FREE_TAIL.test(after)) return;
  if (!unit && POPULATION.test(before)) unit = 'count';
  return { value: number.value, upper: number.upper, unit, period, roundingStep: roundingStep(remainder.slice(number.start, number.end), number) };
}

function sameMagnitude(first: number, second: number, tolerance: number, converted: boolean): boolean {
  if (first === second) return true;
  const difference = Math.abs(first - second);
  const magnitude = Math.min(Math.abs(first), Math.abs(second));
  if (converted && difference <= Math.min(Number.EPSILON * magnitude * 2, 1e-7)) return true;
  return difference < tolerance && difference <= magnitude * MAX_RELATIVE_ROUNDING;
}

/**
 * Compare one figure in each sentence. Both endpoints of a range must match, with no rounding allowance.
 * Callers determine whether the sentences answer the same question. Use `kind: 'date'` for a date answer.
 */
export function compareFigures(first: string, second: string, options?: { kind?: 'date' }): FigureComparison {
  const dateOnly = options?.kind === 'date';
  const a = readFigure(first, dateOnly);
  const b = readFigure(second, dateOnly);
  if (!a || !b) return { kind: 'uncomparable' };
  if (typeof a === 'string' && typeof b === 'string') return { kind: a === b ? 'agree' : 'different-period' };
  if (typeof a === 'string' || typeof b === 'string') return { kind: 'uncomparable' };

  const converted = a.unit === 'km' && b.unit === 'mi' || a.unit === 'mi' && b.unit === 'km';
  if (a.unit !== b.unit && !converted) return { kind: 'different-unit' };
  if (a.period && b.period && a.period !== b.period) return { kind: 'different-period' };
  const factorA = converted && a.unit === 'mi' ? MILE_IN_KM : 1;
  const factorB = converted && b.unit === 'mi' ? MILE_IN_KM : 1;
  const tolerance = Math.max(a.roundingStep * factorA, b.roundingStep * factorB) / 2;
  if (!sameMagnitude(a.value * factorA, b.value * factorB, tolerance, converted)) return { kind: 'different-value' };
  if (a.upper !== undefined || b.upper !== undefined) {
    if (a.upper === undefined || b.upper === undefined || !sameMagnitude(a.upper * factorA, b.upper * factorB, 0, converted)) {
      return { kind: 'different-value' };
    }
  }
  if (a.period !== b.period) return { kind: 'agree-period-unstated', unstatedSource: a.period ? 'second' : 'first' };
  return { kind: 'agree' };
}
