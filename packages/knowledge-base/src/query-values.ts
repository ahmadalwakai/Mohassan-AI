import type { StoredClaim, WikidataSnak } from './types.ts';

const WIKIDATA_ITEM = /^(?:https?:\/\/www\.wikidata\.org\/entity\/)?(Q[1-9]\d*)$/u;
const GREGORIAN_CALENDAR = 'Q1985727';
const JULIAN_CALENDAR = 'Q1985786';

export function unitId(unit: string) {
  return unit === '1' ? unit : WIKIDATA_ITEM.exec(unit)?.[1];
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
}

type DateBounds = { earliest: number; latest: number };

function dateKey(year: number, month: number, day: number) {
  return year * 10_000 + month * 100 + day;
}

export function validateYear(year: number | undefined) {
  if (year !== undefined && (!Number.isInteger(year) || Math.abs(year) > 999_999_999)) {
    throw new RangeError('Expected an integer Gregorian year between -999999999 and 999999999');
  }
}

export function readWikidataDate(snak: WikidataSnak) {
  if (snak.snaktype !== 'value' || snak.datavalue?.type !== 'time') return;
  const value = record(snak.datavalue.value);
  if (typeof value?.time !== 'string' || typeof value.precision !== 'number' ||
    !Number.isInteger(value.precision) || value.precision < 9 || value.precision > 14 ||
    typeof value.calendarmodel !== 'string' ||
    (value.before ?? 0) !== 0 || (value.after ?? 0) !== 0 || (value.timezone ?? 0) !== 0) return;

  const calendar = unitId(value.calendarmodel);
  const date = /^([+-]\d{1,16})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)Z$/u.exec(value.time);
  if (!date || (calendar !== GREGORIAN_CALENDAR && calendar !== JULIAN_CALENDAR)) return;
  const year = Number(date[1]);
  const month = Number(date[2]);
  const day = Number(date[3]);
  const precision = value.precision;
  if (Math.abs(year) > 999_999_999) return;
  if (precision >= 10 && (month < 1 || month > 12)) return;
  if (precision >= 11 && (day < 1 || day > monthLength(year, month, calendar))) return;
  return { kind: 'date' as const, year, ...(precision >= 10 && { month }), ...(precision >= 11 && { day }),
    calendar, raw: value.time, precision };
}

function monthLength(year: number, month: number, calendar: string) {
  const leapYear = year % 4 === 0 && (calendar === JULIAN_CALENDAR || year % 100 !== 0 || year % 400 === 0);
  return [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

function dateBounds(snak: WikidataSnak): DateBounds | undefined {
  const date = readWikidataDate(snak);
  if (!date || date.calendar !== GREGORIAN_CALENDAR) return;
  return calendarDateBounds(date);
}

export function calendarDateBounds(date: NonNullable<ReturnType<typeof readWikidataDate>>): DateBounds {
  const { year, month, day } = date;
  if (month === undefined) return { earliest: dateKey(year, 1, 1), latest: dateKey(year, 12, 31) };
  if (day === undefined) {
    return { earliest: dateKey(year, month, 1), latest: dateKey(year, month, monthLength(year, month, date.calendar)) };
  }
  const exactDay = dateKey(year, month, day);
  return { earliest: exactDay, latest: exactDay };
}

export function uniqueDateBounds(snaks: WikidataSnak[]): DateBounds | undefined {
  const first = snaks[0] && dateBounds(snaks[0]);
  if (!first) return;
  if (snaks.every(snak => {
    const bounds = dateBounds(snak);
    return bounds?.earliest === first.earliest && bounds.latest === first.latest;
  })) return first;
}

function boundary(snaks: WikidataSnak[], edge: keyof DateBounds): number | undefined {
  return uniqueDateBounds(snaks)?.[edge];
}

/** Compare dated values, observations and interval starts at their stated precision. */
export function orderedStatementDate(claim: StoredClaim, pointInTimeOnly = false): DateBounds | undefined {
  if (!pointInTimeOnly && claim.snak.datavalue?.type === 'time') return dateBounds(claim.snak);
  const { P585: points, P580: starts, P582: ends } = claim.qualifiers;
  const candidates = pointInTimeOnly ? points : points ?? starts;
  if (!candidates) return;
  const date = uniqueDateBounds(candidates);
  const start = starts ? boundary(starts, 'earliest') : -Infinity;
  const end = ends ? boundary(ends, 'latest') : Infinity;
  if (!date || start === undefined || end === undefined) return;
  const earliest = Math.max(date.earliest, start);
  const latest = Math.min(date.latest, end);
  if (earliest <= latest) return { earliest, latest };
}

export function appliesInYear(claim: StoredClaim, year: number, snapshotDay: number) {
  const { P585: points, P580: starts, P582: ends } = claim.qualifiers;
  if (!points && !starts && !ends) return false;

  // A lone end substantiates the end year. A lone start cannot predict beyond the snapshot.
  const startBounds = starts ?? (points ? undefined : ends);
  const start = startBounds ? boundary(startBounds, 'earliest') : -Infinity;
  const openEnd = points ? Infinity : snapshotDay;
  const end = ends ? boundary(ends, 'latest') : openEnd;
  if (start === undefined || end === undefined) return false;
  const firstDay = Math.max(start, dateKey(year, 1, 1));
  const lastDay = Math.min(end, dateKey(year, 12, 31));
  if (firstDay > lastDay) return false;

  return !points || points.some(point => {
    const bounds = dateBounds(point);
    return bounds !== undefined && bounds.earliest <= lastDay && bounds.latest >= firstDay;
  });
}

type Decimal = { coefficient: bigint; exponent: number };

// Powers of ten within each dimension. Other units compare by exact identity.
const AREA_UNIT_EXPONENTS: Record<string, number> = { Q25343: 0, Q35852: 4, Q712226: 6 };
const LENGTH_UNIT_EXPONENTS: Record<string, number> = { Q11573: 0, Q828224: 3 };

export function quantityInUnit(claim: StoredClaim, targetUnit: string): Decimal | undefined {
  if (claim.snak.snaktype !== 'value' || claim.snak.datavalue?.type !== 'quantity') return;
  const value = record(claim.snak.datavalue.value);
  if (typeof value?.amount !== 'string' || typeof value.unit !== 'string') return;
  const sourceUnit = unitId(value.unit);
  if (!sourceUnit) return;

  let adjustment = 0;
  if (sourceUnit !== targetUnit) {
    const dimension = [AREA_UNIT_EXPONENTS, LENGTH_UNIT_EXPONENTS]
      .find(units => units[sourceUnit] !== undefined && units[targetUnit] !== undefined);
    if (!dimension) return;
    adjustment = dimension[sourceUnit] - dimension[targetUnit];
  }
  const amount = /^([+-]?)(\d{1,256})(?:\.(\d{1,256}))?$/u.exec(value.amount);
  if (!amount) return;
  const fraction = amount[3] ?? '';
  return {
    coefficient: BigInt(`${amount[1]}${amount[2]}${fraction}`),
    exponent: adjustment - fraction.length,
  };
}

export function orderAmounts(left: Decimal, right: Decimal) {
  const exponent = Math.min(left.exponent, right.exponent);
  const a = left.coefficient * 10n ** BigInt(left.exponent - exponent);
  const b = right.coefficient * 10n ** BigInt(right.exponent - exponent);
  return a < b ? -1 : a > b ? 1 : 0;
}

export function formatAmount({ coefficient, exponent }: Decimal) {
  if (coefficient === 0n) return '0';
  const sign = coefficient < 0n ? '-' : '';
  const magnitude = (coefficient < 0n ? -coefficient : coefficient).toString();
  if (exponent >= 0) return sign + magnitude + '0'.repeat(exponent);
  const digits = magnitude.padStart(1 - exponent, '0');
  const whole = digits.slice(0, exponent);
  const fraction = digits.slice(exponent).replace(/0+$/u, '');
  return sign + whole + (fraction ? `.${fraction}` : '');
}
