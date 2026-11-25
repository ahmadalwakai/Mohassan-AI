import { isDeepStrictEqual } from 'node:util';
import { expect, it } from 'vitest';
import {
  extractStructuredEvidence,
  type StructuredEvidencePage,
  type StructuredEvidenceTarget,
} from '../apps/server/src/assistant/structured-evidence.js';
import fixtures from './fixtures/structured-evidence-pages.json';

type Result = ReturnType<typeof extractStructuredEvidence>;
type Candidate = Result['candidates'][number];
type Value = Candidate['value'];
type DateValue = Extract<Value, { kind: 'date' }>['date'];
type Fixture = {
  id: string;
  target: StructuredEvidenceTarget;
  pages: (StructuredEvidencePage & { license: string })[];
  expected: { value?: number | DateValue; range?: [number, number]; conflict?: boolean; url?: string };
};

const cases = fixtures as Fixture[];
const months = [
  ['january', 'jan', 'يناير', 'كانون الثاني', 'جانفي'], ['february', 'feb', 'فبراير', 'شباط', 'فيفري'], ['march', 'mar', 'مارس', 'آذار'],
  ['april', 'apr', 'أبريل', 'ابريل', 'نيسان', 'أفريل'], ['may', 'مايو', 'أيار', 'ماي'], ['june', 'jun', 'يونيو', 'حزيران', 'جوان'],
  ['july', 'jul', 'يوليو', 'تموز'], ['august', 'aug', 'أغسطس', 'اغسطس', 'آب'], ['september', 'sep', 'sept', 'سبتمبر', 'أيلول'],
  ['october', 'oct', 'أكتوبر', 'اكتوبر', 'تشرين الأول'], ['november', 'nov', 'نوفمبر', 'تشرين الثاني'],
  ['december', 'dec', 'ديسمبر', 'كانون الأول'],
];
const hijriMonths = [
  ['محرم', 'المحرم', 'muharram'], ['صفر', 'safar'], ['ربيع الأول', 'rabi al awwal'], ['ربيع الآخر', 'ربيع الثاني', 'rabi al thani'],
  ['جمادى الأولى', 'jumada al awwal'], ['جمادى الآخرة', 'جمادى الثانية', 'jumada al thani'],
  ['رجب', 'rajab'], ['شعبان', 'shaban', 'sha ban'], ['رمضان', 'ramadan'], ['شوال', 'shawwal'],
  ['ذو القعدة', 'ذي القعدة', 'dhul qadah'], ['ذو الحجة', 'ذي الحجة', 'dhul hijjah'],
];
const ordinals = ['الأول', 'الثاني', 'الثالث', 'الرابع', 'الخامس', 'السادس', 'السابع', 'الثامن', 'التاسع', 'العاشر'];

/** Independent checks against source spans. The extractor's parser is intentionally not used here. */
function asciiDigits(text: string): string {
  return text.replace(/[٠-٩۰-۹]/gu, digit => String(digit.charCodeAt(0) & 0xf));
}

function dateSupported(literal: string, date: DateValue): boolean {
  const normalized = asciiDigits(literal).toLowerCase().replace(/[\u064b-\u065f\u0670]/gu, '');
  const numbers = [...normalized.matchAll(/\d+/gu)].map(match => Number(match[0]));
  const yearAt = numbers.indexOf(date.year);
  if (yearAt === -1) return false;
  const words = ` ${normalized.replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
  const hasLabel = (label: string) => words.includes(` ${label} `);
  const hijriMonth = hijriMonths.findIndex(group => group.some(hasLabel)) + 1;
  const hijri = hijriMonth > 0 || /(?:\bhijri\b|\ba\.?\s*h\b|هجري|هـ|(?:^|\s)ه(?:$|\s))/u.test(normalized);
  if (hijri !== (date.calendar === 'hijri')) return false;
  if (date.month === undefined) return numbers.length === 1;
  const namedMonth = hijriMonth || months.findIndex(group => group.some(hasLabel)) + 1;
  const components = numbers.filter((_, index) => index !== yearAt);
  if (namedMonth) {
    return namedMonth === date.month && (date.day === undefined || components.includes(date.day)
      || ordinals.findIndex(hasLabel) + 1 === date.day);
  }
  if (date.day === undefined) return components.length === 1 && components[0] === date.month;
  return components.length === 2 && (yearAt === 0
    ? components[0] === date.month && components[1] === date.day
    : components.includes(date.month) && components.includes(date.day) && components[0]! + components[1]! === date.month + date.day);
}

function scale(text: string): number | undefined {
  const words = new Set(text.toLowerCase().split(/[^\p{L}]+/u));
  if (['trillion', 'trillions', 'تريليون', 'تريليونات'].some(word => words.has(word))) return 1e12;
  if (['billion', 'billions', 'مليار', 'مليارات'].some(word => words.has(word))) return 1e9;
  if (['million', 'millions', 'مليون', 'ملايين'].some(word => words.has(word))) return 1e6;
  if (['thousand', 'thousands', 'الف', 'ألف', 'آلاف'].some(word => words.has(word))) return 1e3;
}

function amount(text: string): number {
  return Number(text.replace(/[,،٬\s’']/gu, '').replace('٫', '.'));
}

function numbersSupported(literal: string, context: string, stated: Exclude<Value, { kind: 'date' }>): boolean {
  const text = asciiDigits(literal).replaceAll('−', '-');
  const tokens = [...text.matchAll(/(?<!\d)-?(?:\d+(?:(?:[.,،٬٫]|[\u00a0\u202f\u2009'’](?=\d{3}\b))\d+)*|[.٫]\d+)/gu)];
  const contextScale = scale(context) ?? 1;
  const amounts = tokens.map((token, index) => {
    const tokenEnd = token.index + token[0].length;
    const following = text.slice(tokenEnd, tokens[index + 1]?.index ?? text.length);
    return amount(token[0]) * (scale(following) ?? scale(literal) ?? contextScale);
  });
  const expected = stated.kind === 'range' ? [stated.min, stated.max] : [stated.value];
  if (stated.kind === 'range') amounts.sort((a, b) => a - b);
  return amounts.length === expected.length && expected.every((value, index) => close(value, amounts[index]!));
}

const metres = new Map([['m', 1], ['km', 1000], ['cm', 0.01], ['mm', 0.001], ['mi', 1609.344], ['ft', 0.3048], ['in', 0.0254], ['yd', 0.9144]]);

function close(expected: number, observed: number): boolean {
  return Number.isFinite(expected) && Number.isFinite(observed)
    && Math.abs(expected - observed) <= Math.max(1, Math.abs(expected)) * Number.EPSILON * 8;
}

function conversionSupported(candidate: Candidate): boolean {
  const { stated, value, conversion } = candidate;
  if (!conversion) return isDeepStrictEqual(stated, value);
  if (stated.kind === 'date' || value.kind === 'date' || stated.kind !== value.kind) return false;
  const from = metres.get(stated.unit), to = metres.get(value.unit);
  if (!from || !to || conversion.from !== stated.unit || conversion.to !== value.unit) return false;
  const factor = from / to;
  if (!close(factor, conversion.factor)) return false;
  if (value.kind === 'number' && stated.kind === 'number') return close(stated.value * factor, value.value);
  if (value.kind === 'range' && stated.kind === 'range') return close(stated.min * factor, value.min) && close(stated.max * factor, value.max);
  return false;
}

function supported(candidate: Candidate, pages: Fixture['pages']): boolean {
  const { evidence, stated, timeEvidence, referenceTime } = candidate;
  const page = pages.find(source => source.url === evidence.url && source.fetchedAt === evidence.fetchedAt);
  if (!page || page.title !== evidence.title || page.publishedAt !== evidence.publishedAt) return false;
  if (timeEvidence) {
    let timeText: string | undefined;
    if (timeEvidence.kind === 'text') timeText = page.text;
    else if (timeEvidence.kind === 'table-header') timeText = page.tables?.[timeEvidence.tableIndex]?.headers[timeEvidence.columnIndex];
    else if (timeEvidence.kind === 'table-caption') timeText = page.tables?.[timeEvidence.tableIndex]?.caption;
    else timeText = page.tables?.[timeEvidence.tableIndex]?.rows[timeEvidence.rowIndex]?.[timeEvidence.columnIndex];
    if (!timeText || timeEvidence.start < 0 || timeEvidence.start >= timeEvidence.end || timeEvidence.end > timeText.length
      || timeText.slice(timeEvidence.start, timeEvidence.end) !== timeEvidence.quote || !referenceTime
      || !dateSupported(timeEvidence.quote, referenceTime)) return false;
  } else if (referenceTime) return false;
  let original: string | undefined = page.text;
  let context = '';
  if (evidence.kind === 'table') {
    const table = page.tables?.[evidence.tableIndex];
    const row = table?.rows[evidence.rowIndex];
    original = row?.[evidence.columnIndex];
    if ((table?.headers[evidence.columnIndex] ?? '') !== evidence.header || table?.caption !== evidence.caption) return false;
    if (evidence.rowLabel !== undefined && evidence.rowLabel !== row?.[0]) return false;
    if (evidence.unitCell && row?.[evidence.unitCell.columnIndex] !== evidence.unitCell.quote) return false;
    context = [evidence.unitCell?.quote, evidence.header, evidence.rowLabel, evidence.caption, page.title].filter(Boolean).join(' ');
  }
  if (!original || evidence.start < 0 || evidence.start >= evidence.end || evidence.end > original.length
    || evidence.valueStart < evidence.start || evidence.valueStart >= evidence.valueEnd || evidence.valueEnd > evidence.end
    || original.slice(evidence.start, evidence.end) !== evidence.quote
    || original.slice(evidence.valueStart, evidence.valueEnd) !== evidence.literal) return false;
  return conversionSupported(candidate) && (stated.kind === 'date'
    ? dateSupported(evidence.literal, stated.date)
    : numbersSupported(evidence.literal, context, stated));
}

function topCorrect({ expected, target }: Fixture, top: Result['top']): boolean {
  if (expected.value === undefined && expected.range === undefined) return top === null;
  if (!top || !matchesRequestedTime(top, target.time) || (expected.url && top.evidence.url !== expected.url)) return false;
  const { value } = top;
  if (expected.range) return value.kind === 'range' && value.unit === target.unit
    && close(value.min, expected.range[0]) && close(value.max, expected.range[1]);
  if (typeof expected.value === 'number') return value.kind === 'number' && value.unit === target.unit && close(value.value, expected.value);
  return value.kind === 'date' && isDeepStrictEqual(value.date, expected.value);
}

function matchesRequestedTime(candidate: Candidate, requested: DateValue | undefined): boolean {
  if (!requested) return true;
  const time = candidate.value.kind === 'date' ? candidate.value.date : candidate.referenceTime;
  return time !== null && time.calendar === requested.calendar && time.year === requested.year
    && (requested.month === undefined || time.month === requested.month)
    && (requested.day === undefined || time.day === requested.day);
}

it('grades top values, exact evidence and declared conflicts across public fixtures', () => {
  const urls = new Set(cases.flatMap(fixture => fixture.pages.map(page => page.url)));
  expect(urls.size).toBeGreaterThanOrEqual(40);
  const kinds = new Set(cases.map(fixture => fixture.target.kind));
  for (const kind of ['population', 'gdp', 'event-date', 'price', 'distance', 'height'] as const) expect(kinds.has(kind)).toBe(true);
  const pages = cases.flatMap(fixture => fixture.pages);
  expect(pages.some(page => /\p{Script=Arabic}/u.test(page.text))).toBe(true);
  expect(pages.some(page => /[A-Za-z]{5}/u.test(page.text))).toBe(true);
  expect(pages.every(page => page.license.trim() && /^https:\/\//u.test(page.url))).toBe(true);

  const missedValues: string[] = [];
  const unsupported: string[] = [];
  const missedConflicts: string[] = [];
  const unexpectedConflicts: string[] = [];
  const unexpectedValues: string[] = [];
  let valueCases = 0, candidates = 0, conflictCases = 0;
  for (const fixture of cases) {
    const result = extractStructuredEvidence(fixture.target, fixture.pages, { now: '2026-11-25T00:00:00Z' });
    expect(result.read.map(page => page.url), fixture.id).toEqual(fixture.pages.map(page => page.url));
    if (fixture.expected.value !== undefined || fixture.expected.range !== undefined) {
      valueCases++;
      if (!topCorrect(fixture, result.top)) missedValues.push(fixture.id);
    } else if (!fixture.expected.conflict && (result.top || result.status !== 'gap'
      || !result.gaps.some(gap => gap.message === 'لم أجد قيمة موثقة'))) unexpectedValues.push(fixture.id);
    const observations = new Set(result.candidates);
    if (result.top) observations.add(result.top);
    for (const { first, second } of result.conflicts) {
      observations.add(first);
      observations.add(second);
    }
    for (const candidate of observations) {
      candidates++;
      if (!supported(candidate, fixture.pages)) unsupported.push(`${fixture.id}: ${candidate.evidence.literal}`);
    }
    if (fixture.expected.conflict) {
      conflictCases++;
      const hasWitnesses = result.conflicts.some(({ first, second }) => first.evidence.url !== second.evidence.url
        && matchesRequestedTime(first, fixture.target.time) && matchesRequestedTime(second, fixture.target.time)
        && !isDeepStrictEqual(first.value, second.value)
        && supported(first, fixture.pages) && supported(second, fixture.pages));
      if (result.status !== 'conflict' || !hasWitnesses) missedConflicts.push(fixture.id);
    } else if (result.conflicts.length) unexpectedConflicts.push(fixture.id);
  }
  const correct = valueCases - missedValues.length;
  console.info('STRUCTURED_EVIDENCE_FIXTURES', JSON.stringify({
    pages: urls.size, cases: cases.length, correct, valueCases, topAccuracy: correct / valueCases,
    fabricated: unsupported.length, candidates, conflictsDetected: conflictCases - missedConflicts.length, conflictCases,
    missedValues, unsupported, missedConflicts, unexpectedConflicts, unexpectedValues,
  }));
  expect(valueCases).toBeGreaterThan(0);
  expect(correct / valueCases, missedValues.join(', ')).toBeGreaterThanOrEqual(0.95);
  expect(unsupported).toEqual([]);
  expect(conflictCases).toBeGreaterThan(0);
  expect(missedConflicts).toEqual([]);
  expect(unexpectedConflicts).toEqual([]);
  expect(unexpectedValues).toEqual([]);
});
