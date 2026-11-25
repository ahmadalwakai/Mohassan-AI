import { dateFrom, matchMonitorText } from './page.js';

const digitPattern = /(?<![\p{L}\p{N}.,])[-+−]?\d+(?:[,.٫٬]\d+)*/gu;
const currencyCodes = new Set(Intl.supportedValuesOf('currency'));

function currencyAliases() {
  const aliases = new Map<string, string | null>();
  for (const code of currencyCodes) {
    for (const locale of ['en', 'ar']) {
      for (const currencyDisplay of ['symbol', 'name'] as const) {
        const format = new Intl.NumberFormat(locale, { style: 'currency', currency: code, currencyDisplay });
        for (const amount of [1, 2]) {
          const part = format.formatToParts(amount).find(item => item.type === 'currency')?.value;
          if (!part) continue;
          const alias = matchMonitorText(part);
          aliases.set(alias, aliases.has(alias) && aliases.get(alias) !== code ? null : code);
        }
      }
    }
  }
  return aliases;
}

let currencies: ReturnType<typeof currencyAliases> | undefined;

const numberUnits = ['percent', 'kilogram', 'gram', 'pound', 'liter', 'milliliter', 'meter', 'kilometer',
  'centimeter', 'millimeter', 'celsius', 'fahrenheit', 'kilometer-per-hour', 'meter-per-second',
  'mile-per-hour', 'second', 'minute', 'hour', 'day'];

// Unit identifiers are from ECMA-402 and their printed variants come from the runtime's locale data.
const unitAliases = new Map(numberUnits.flatMap(unit => ['en', 'ar'].flatMap(locale =>
  ['short', 'narrow', 'long'].map(unitDisplay => {
    const format = new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: unitDisplay as 'short' | 'narrow' | 'long' });
    const symbol = format.formatToParts(3).find(item => item.type === 'unit')?.value ?? '';
    return [matchMonitorText(symbol), unit] as const;
  }))));
const unitPattern = new RegExp('^(' + [...unitAliases.keys()].filter(Boolean).sort((a, b) => b.length - a.length)
  .map(value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|') + ')(?![\\p{L}\\p{N}])', 'u');

export function normalizeUnit(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const unit = matchMonitorText(value);
  return unitAliases.get(unit) ?? unit;
}

export function normalizeCurrency(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const alias = matchMonitorText(value);
  const code = alias.toUpperCase();
  if (currencyCodes.has(code)) return code;
  currencies ??= currencyAliases();
  return currencies.has(alias) ? currencies.get(alias) ?? alias : undefined;
}

function currencyAt(text: string, side: 'start' | 'end'): string | undefined {
  const trimmed = text.trim();
  const token = side === 'start' ? /^(?:[\p{L}]+(?=\p{Sc})\p{Sc}|\p{Sc}|[\p{L}]+(?:\.[\p{L}]+)+\.?)/u.exec(trimmed)?.[0]
    : /(?:[\p{L}]+(?=\p{Sc})\p{Sc}|\p{Sc}|[\p{L}]+(?:\.[\p{L}]+)+\.?)$/u.exec(trimmed)?.[0];
  if (token) return normalizeCurrency(token) ?? (/\p{Sc}/u.test(token) ? token : undefined);
  const words = trimmed.match(/[\p{L}]+/gu) ?? [];
  const edge = (side === 'start' ? words.slice(0, 4) : words.slice(-4).reverse());
  for (let count = edge.length; count > 0; count--) {
    const candidate = edge.slice(0, count);
    const alias = (side === 'start' ? candidate : candidate.reverse()).join(' ');
    if (side === 'start' ? !trimmed.startsWith(alias) : !trimmed.endsWith(alias)) continue;
    // Ignore pure lower-case three-letter English words next to an unmarked number.
    const spelling = side === 'start' ? text.trim().slice(0, alias.length) : text.trim().slice(-alias.length);
    if (/^[a-z]{3}$/u.test(spelling)) continue;
    const currency = normalizeCurrency(alias);
    if (currency) return currency;
  }
}

export interface PageNumber { value: number; index: number; raw: string; currency?: string; unit?: string; conflicting?: true }

export function pageNumbers(text: string): PageNumber[] {
  const numeric = matchMonitorText(text);
  return [...numeric.matchAll(digitPattern)].flatMap(({ 0: raw, index }) => {
    const normalized = raw.replaceAll('−', '-').replaceAll('٬', '').replaceAll('٫', '.');
    const grouped = /^[+-]?\d{1,3}(,\d{3})+(?:\.\d+)?$/u.test(normalized);
    const value = Number(grouped ? normalized.replaceAll(',', '') : normalized.replace(',', '.'));
    if (!Number.isFinite(value)) return [];
    const before = numeric.slice(Math.max(0, index - 48), index);
    const after = numeric.slice(index + raw.length, index + raw.length + 48);
    // Keep uppercase ISO tokens, which matchMonitorText otherwise case-folds.
    const original = text.normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/[\p{Cc}\p{Z}]+/gu, ' ').trim();
    const spelling = original.length === numeric.length ? original : numeric;
    const prefixCurrency = currencyAt(spelling.slice(Math.max(0, index - 48), index), 'end');
    const suffixCurrency = currencyAt(spelling.slice(index + raw.length, index + raw.length + 48), 'start');
    const incompatible = prefixCurrency && suffixCurrency && prefixCurrency !== suffixCurrency;
    const currency = suffixCurrency ?? prefixCurrency;
    const suffix = unitPattern.exec(after.trim())?.[1];
    const unit = suffix && !currency ? normalizeUnit(suffix) : undefined;
    const boundaryAfter = after[0] ?? '';
    if (!unit && !currency && /[\p{L}\p{N}]/u.test(boundaryAfter)) return [];
    if (/(?:\d\s*[:/]|\d\s*[-–—])\s*$/u.test(before) || /^\s*[:/]\s*\d/u.test(after)) return [];
    return [{ value, index, raw, ...(currency && { currency }), ...(unit && { unit }), ...(incompatible && { conflicting: true as const }) }];
  });
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const ummAlQura = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura-nu-latn', {
  timeZone: 'UTC', year: 'numeric', month: 'numeric', day: 'numeric',
});

function hijriAt(dayIndex: number): number {
  const parts = ummAlQura.formatToParts(dayIndex * MS_PER_DAY);
  const value = (part: string) => Number(parts.find(item => item.type === part)?.value);
  return value('year') * 10_000 + value('month') * 100 + value('day');
}

function hijriDate(year: number, month: number, day: number): string | undefined {
  if (month < 1 || month > 12 || day < 1 || day > 30) return undefined;
  const goal = year * 10_000 + month * 100 + day;
  // Search the supported four-digit Gregorian range. Round-trip validation excludes nonexistent Hijri days.
  let low = Date.parse('0622-01-01T00:00:00Z') / MS_PER_DAY;
  let high = Date.parse('9999-12-31T00:00:00Z') / MS_PER_DAY;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const observed = hijriAt(middle);
    if (observed === goal) return new Date(middle * MS_PER_DAY).toISOString().slice(0, 10);
    if (observed < goal) low = middle + 1;
    else high = middle - 1;
  }
}

function hijriMonthNames(): string[] {
  const formatter = new Intl.DateTimeFormat('ar-u-ca-islamic-umalqura-nu-latn', { timeZone: 'UTC', month: 'long' });
  const names: string[] = [];
  // Scrape consecutive dates from runtime calendar data until all month numbers have been seen.
  for (let index = 0; index < 366 && names.filter(Boolean).length < 12; index++) {
    const day = index + Date.UTC(2026, 0, 1) / MS_PER_DAY;
    const month = Math.floor(hijriAt(day) / 100) % 100;
    names[month - 1] = matchMonitorText(formatter.format(day * MS_PER_DAY));
  }
  return names;
}

const hijriNames = hijriMonthNames();
const namedHijri = new RegExp(String.raw`(?<![\p{L}\p{N}])(\d{1,2})\s+(${hijriNames.join('|')})\s+(\d{4})(?!\d)`, 'u');
const numericHijri = /(?<![\p{L}\p{N}])(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,4})\s*(?:ah|ه(?:جري)?)(?!\p{L})/u;

export function pageDate(text: string): string | undefined {
  const normalized = matchMonitorText(text);
  const numeric = numericHijri.exec(normalized);
  if (numeric) {
    const [, first, month, last] = numeric;
    const [year, day] = first.length === 4 ? [first, last] : [last, first];
    return year.length === 4 ? hijriDate(Number(year), Number(month), Number(day)) : undefined;
  }
  const named = namedHijri.exec(normalized);
  if (named) return hijriDate(Number(named[3]), hijriNames.indexOf(named[2]) + 1, Number(named[1]));
  const iso = /(?<!\d)(\d{4}-\d{2}-\d{2})t\d{2}:\d{2}/u.exec(normalized);
  if (iso) return dateFrom(iso[1]);
  return dateFrom(text);
}

export function pageStatus(text: string, label?: string): string | undefined {
  const value = matchMonitorText(text);
  const subject = matchMonitorText(label ?? '');
  if (subject === 'availability' && /\b(?:registration|tickets?)\b|تسجيل|تذاكر/u.test(value) &&
      !/\b(?:availability|in stock|out of stock)\b|مخزون|نفد/u.test(value)) return undefined;
  const registration = /registration|تسجيل/u.test(subject) || /registration|تسجيل/u.test(value);
  const tickets = /tickets?|تذاكر/u.test(subject) || /tickets?|تذاكر/u.test(value);
  const pending = /\b(?:coming soon|opens? on|will open)\b|قريبا|سيفتح|ستفتح/u.test(value);
  const closed = /\b(?:closed|not open|unavailable|sold out|out of stock|not available|not in stock)\b|غير متاح|غير متوفر|نفد(?:ت)?|مغلق|لم يفتح/u.test(value);
  const open = /\b(?:open|in stock|available|on sale)\b|مفتوح|متوفر|متاح/u.test(value);
  if (registration) return pending || closed ? 'registration closed' : open ? 'registration open' : undefined;
  if (tickets) return pending || closed ? 'tickets unavailable' : open ? 'tickets available' : undefined;
  if (pending) return 'coming soon';
  if (closed) return 'out of stock';
  if (open) return 'in stock';
}
