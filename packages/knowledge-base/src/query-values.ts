import type { StoredClaim, WikidataSnak } from './types.ts';

const WIKIDATA_ITEM = /^(?:https?:\/\/www\.wikidata\.org\/entity\/)?(Q[1-9]\d*)$/u;
const GREGORIAN_CALENDAR = 'Q1985727';

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

function dateBounds(snak: WikidataSnak): DateBounds | undefined {
  if (snak.snaktype !== 'value' || snak.datavalue?.type !== 'time') return;
  const value = record(snak.datavalue.value);
  if (typeof value?.time !== 'string' || typeof value.precision !== 'number' ||
    !Number.isInteger(value.precision) || value.precision < 9 || value.precision > 14 ||
    typeof value.calendarmodel !== 'string' || unitId(value.calendarmodel) !== GREGORIAN_CALENDAR ||
    (value.before ?? 0) !== 0 || (value.after ?? 0) !== 0 || (value.timezone ?? 0) !== 0) return;

  const date = /^([+-]\d{1,16})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}Z$/u.exec(value.time);
  if (!date) return;
  const year = Number(date[1]);
  const month = Number(date[2]);
  const day = Number(date[3]);
  if (Math.abs(year) > 999_999_999) return;
  if (value.precision === 9) return { earliest: dateKey(year, 1, 1), latest: dateKey(year, 12, 31) };
  if (month < 1 || month > 12) return;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (value.precision === 10) {
    return { earliest: dateKey(year, month, 1), latest: dateKey(year, month, daysInMonth) };
  }
  if (day < 1 || day > daysInMonth) return;
  const exactDay = dateKey(year, month, day);
  return { earliest: exactDay, latest: exactDay };
}

function boundary(snaks: WikidataSnak[], edge: keyof DateBounds): number | undefined {
  const first = snaks[0] && dateBounds(snaks[0]);
  if (!first) return;
  // Distinct endpoints do not establish a unique interval.
  if (snaks.every(snak => {
    const bounds = dateBounds(snak);
    return bounds?.earliest === first.earliest && bounds.latest === first.latest;
  })) return first[edge];
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

// Powers of ten relative to the square metre. Other units compare by exact identity.
const AREA_UNIT_EXPONENTS: Record<string, number> = { Q25343: 0, Q35852: 4, Q712226: 6 };

export function quantityInUnit(claim: StoredClaim, targetUnit: string): Decimal | undefined {
  if (claim.snak.snaktype !== 'value' || claim.snak.datavalue?.type !== 'quantity') return;
  const value = record(claim.snak.datavalue.value);
  if (typeof value?.amount !== 'string' || typeof value.unit !== 'string') return;
  const sourceUnit = unitId(value.unit);
  if (!sourceUnit) return;

  let adjustment = 0;
  if (sourceUnit !== targetUnit) {
    const from = AREA_UNIT_EXPONENTS[sourceUnit];
    const to = AREA_UNIT_EXPONENTS[targetUnit];
    if (from === undefined || to === undefined) return;
    adjustment = from - to;
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
