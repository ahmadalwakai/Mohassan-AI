interface Span {
  start: number;
  end: number;
}

export interface NumericToken extends Span {
  value: number;
  upper?: number;
  unit?: string;
  approximate: boolean;
  scaled: boolean;
}

export interface EvidenceDate {
  calendar: 'gregorian' | 'hijri';
  year: number;
  month?: number;
  day?: number;
}

export interface DateToken extends Span {
  date: EvidenceDate;
}

const ARABIC_MARKS = /[\u061c\u0640\u064b-\u065f\u0670\u200b-\u200f\u202a-\u202e\u2066-\u2069]/u;
const WORD_CHARACTER = '[\\p{L}\\p{M}\\p{N}]';
const LEFT = `(?<!${WORD_CHARACTER})`;
const RIGHT = `(?!${WORD_CHARACTER})`;
const SPACE = '[\\p{Zs}\\t]';
const GAP = `${SPACE}*`;
const SEPARATION = `${SPACE}+`;

function project(text: string) {
  const offsets: number[] = [];
  let normalized = '';
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (ARABIC_MARKS.test(character)) continue;
    offsets.push(index);
    const code = character.charCodeAt(0);
    if (code >= 0x0660 && code <= 0x0669) normalized += code - 0x0660;
    else if (code >= 0x06f0 && code <= 0x06f9) normalized += code - 0x06f0;
    else normalized += character.replace(/[أإآٱ]/u, 'ا').replace(/ى/u, 'ي').replace(/ة/u, 'ه');
  }
  return {
    text: normalized,
    span(start: number, end: number): Span {
      // Include elided marks after the last matched character in the verbatim span.
      return { start: offsets[start], end: offsets[end] ?? text.length };
    },
  };
}

function aliasMap<Value>(entries: readonly (readonly [Value, string])[]): Map<string, Value> {
  const aliases = new Map<string, Value>();
  for (const [value, labels] of entries) {
    for (const label of labels.split('|')) aliases.set(project(label).text.toLowerCase(), value);
  }
  return aliases;
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function alternatives(aliases: Iterable<string>): string {
  return [...aliases].sort((left, right) => right.length - left.length).map(label => escape(label).replace(/ /g, SEPARATION)).join('|');
}

function labelKey(label: string): string {
  return label.toLowerCase().replace(/[\p{Zs}\t]+/gu, ' ').trim();
}

const SCALES = aliasMap([
  [1e3, 'thousand|thousands|ألف|ألفًا|آلاف'],
  [1e6, 'million|millions|مليون|مليونًا|ملايين'],
  [1e9, 'billion|billions|مليار|مليارًا|مليارات'],
  [1e12, 'trillion|trillions|تريليون|تريليونًا|تريليونات'],
] as const);

const CURRENCIES = aliasMap([
  ['USD', 'usd|us$|us $|u.s.$|u.s. $|$us|us dollar|us dollars|u.s. dollar|u.s. dollars|united states dollar|دولار أمريكي|دولارًا أمريكيًا|دولارات أمريكية'],
  ['AUD', 'aud|au$|a$|australian dollar|australian dollars|دولار أسترالي|دولارًا أستراليًا|دولارات أسترالية'],
  ['CAD', 'cad|ca$|c$|canadian dollar|canadian dollars|دولار كندي|دولارات كندية'],
  ['NZD', 'nzd|nz$|new zealand dollar|new zealand dollars|دولار نيوزيلندي'],
  ['SGD', 'sgd|s$|singapore dollar|singapore dollars|دولار سنغافوري'],
  ['HKD', 'hkd|hk$|hong kong dollar|hong kong dollars|دولار هونغ كونغ'],
  ['EUR', 'eur|€|euro|euros|يورو'],
  ['GBP', 'gbp|£|pound sterling|pounds sterling|british pound|british pounds|جنيه إسترليني|جنيهات إسترلينية'],
  ['SAR', 'sar|sr|ر.س|ريال سعودي|ريالًا سعوديًا|ريالات سعودية|saudi riyal|saudi riyals'],
  ['AED', 'aed|د.إ|درهم إماراتي|دراهم إماراتية|uae dirham|uae dirhams'],
  ['EGP', 'egp|e£|ج.م|جنيه مصري|جنيهات مصرية|egyptian pound|egyptian pounds'],
  ['QAR', 'qar|ريال قطري|ريالات قطرية|qatari riyal|qatari riyals'],
  ['OMR', 'omr|ريال عماني|omani rial|omani rials'],
  ['KWD', 'kwd|دينار كويتي|kuwaiti dinar|kuwaiti dinars'],
  ['BHD', 'bhd|دينار بحريني|bahraini dinar|bahraini dinars'],
  ['JOD', 'jod|دينار أردني|jordanian dinar|jordanian dinars'],
  ['IQD', 'iqd|دينار عراقي|iraqi dinar|iraqi dinars'],
  ['MAD', 'mad|درهم مغربي|دراهم مغربية|moroccan dirham|moroccan dirhams'],
  ['JPY', 'jpy|yen|japanese yen|ين ياباني|ين'],
  ['CNY', 'cny|rmb|yuan|chinese yuan|يوان صيني|يوان'],
  ['INR', 'inr|₹|indian rupee|indian rupees|روبية هندية'],
  ['CHF', 'chf|swiss franc|swiss francs|فرنك سويسري'],
  ['TRY', 'try|₺|turkish lira|ليرة تركية'],
  ['BRL', 'brl|r$|brazilian real|brazilian reais|ريال برازيلي'],
  ['dollar', '$|dollar|dollars|دولار|دولارًا|دولارات'],
  ['yen-or-yuan', '¥|yen-or-yuan'],
  ['riyal', 'riyal|riyals|rial|rials|ريال|ريالًا|ريالات'],
  ['dirham', 'dirham|dirhams|درهم|دراهم'],
  ['dinar', 'dinar|dinars|دينار|دنانير'],
  ['pound', 'جنيه|جنيهات'],
] as const);

const UNITS = aliasMap([
  ['count', 'count|people|person|persons|inhabitant|inhabitants|resident|residents|نسمة|نسمات|شخص|شخصًا|أشخاص|ساكن|ساكنًا|مواطن|مواطنًا|مواطنون|مواطنين|فرد|فردًا|أفراد'],
  ['percent', 'percent|percentage|per cent|%|٪|في المئة|في المائة|بالمئة|بالمائة'],
  ['percentage-point', 'percentage point|percentage points|نقطة مئوية|نقاط مئوية'],
  ['m', 'm|meter|meters|metre|metres|م|متر|مترًا|أمتار'],
  ['km', 'km|kilometer|kilometers|kilometre|kilometres|كم|كلم|كيلومتر|كيلومترًا|كيلومترات|كيلو متر'],
  ['cm', 'cm|centimeter|centimeters|centimetre|centimetres|سم|سنتيمتر|سنتيمترات'],
  ['mm', 'mm|millimeter|millimeters|millimetre|millimetres|مم|مليمتر|ملليمتر'],
  ['mi', 'mi|mile|miles|ميل|أميال'],
  ['ft', 'ft|foot|feet|قدم|قدمًا|أقدام'],
  ['in', 'inch|inches|بوصة|بوصات'],
  ['yd', 'yd|yard|yards|ياردة|ياردات'],
  ['km²', 'km²|km2|square kilometer|square kilometers|square kilometre|square kilometres|كم²|كم2|كيلومتر مربع|كيلومترات مربعة'],
  ['m²', 'm²|m2|square meter|square meters|square metre|square metres|م²|م2|متر مربع|أمتار مربعة'],
  ['km/h', 'km/h|kph|كم/س'],
  ['m/s', 'm/s|م/ث'],
  ['s', 's|sec|secs|second|seconds|ثانية|ثواني|ثوان'],
  ['min', 'min|mins|minute|minutes|دقيقة|دقائق'],
  ['h', 'h|hr|hrs|hour|hours|ساعة|ساعات'],
  ['day', 'day|days|يوم|أيام'],
  ['week', 'week|weeks|أسبوع|أسابيع'],
  ['month', 'month|months|شهر|شهور|أشهر'],
  ['year', 'year|years|سنة|سنوات|عام|أعوام'],
  ['g', 'g|gram|grams|غ|غرام|غرامات'],
  ['kg', 'kg|kilogram|kilograms|كغ|كيلوغرام|كيلوغرامات|كيلوجرام'],
  ['l', 'l|litre|litres|liter|liters|لتر|لترات'],
  ['ml', 'ml|millilitre|millilitres|milliliter|milliliters|مل|ملليلتر'],
] as const);

const ALL_UNITS = new Map<string, string>([...UNITS, ...CURRENCIES]);
const UNIT_WORDS = alternatives(ALL_UNITS.keys());
const CURRENCY_WORDS = alternatives(CURRENCIES.keys());
const SCALE_WORDS = alternatives(SCALES.keys());

export function normalizeEvidenceUnit(unit: string): string | undefined {
  const key = labelKey(project(unit).text);
  return ALL_UNITS.get(key) ?? (key === 'in' ? 'in' : undefined);
}

const CONTEXT_UNIT = new RegExp(`${LEFT}(?:${UNIT_WORDS})${RIGHT}`, 'giu');
const CONTEXT_SCALE = new RegExp(`${LEFT}(?:${SCALE_WORDS})${RIGHT}`, 'giu');

function uniqueAlias<Value>(text: string, pattern: RegExp, aliases: Map<string, Value>): Value | undefined {
  const found = new Set([...text.matchAll(pattern)].map(match => aliases.get(labelKey(match[0]))));
  return found.size === 1 ? [...found][0] : undefined;
}

export function parseEvidenceUnitContext(text: string): { unit?: string; scale?: number } {
  const normalized = project(text).text;
  return { unit: uniqueAlias(normalized, CONTEXT_UNIT, ALL_UNITS), scale: uniqueAlias(normalized, CONTEXT_SCALE, SCALES) };
}

// Require each grouping separator to be followed by three digits. Keep decimal and thousands marks distinct.
const GROUPED_INTEGER = [',', '٬', '،', '[\u00a0\u202f\u2009]', "['’]"].map(separator => `\\d{1,3}(?:${separator}\\d{3})+`).join('|');
const NUMBER = `(?:(?:${GROUPED_INTEGER}|\\d+)(?:[.٫]\\d+)?|[.٫]\\d+)`;
const APPROXIMATE = 'about|around|approximately|roughly|circa|nearly|almost|estimated at|[بف]?نحو|[بف]?حوالي|قرابه|تقريبا|ما يقارب|ما يقرب من|ما يناهز|[~≈]';
const APPROXIMATE_PREFIX = `(?:${APPROXIMATE})(?![\\p{L}\\p{M}])${GAP}`;
const AMOUNT_START = `(?<![\\p{L}\\p{M}\\p{N}٬٫.,،/])`;
const NUMBER_END = '(?![٬٫.,،/]\\d)';
const AMOUNT_END = `${RIGHT}${NUMBER_END}`;
const APPROXIMATE_END = new RegExp(`^${SEPARATION}(?:approximately|roughly|تقريبا)${RIGHT}`, 'iu');
const PER_UNIT = new RegExp(`^${GAP}(?:/|per${SEPARATION}|لكل${SEPARATION})`, 'iu');
const INEQUALITY = /(?:[<>≤≥]\s*|\b(?:less than|more than|at least|at most|over|under|up to)\s+|(?:أكثر من|اكثر من|أقل من|اقل من|على الأقل|علي الاقل|حد اقصى|حتى|حتي)\s+)$/iu;

function amountPattern(prefix: string): string {
  return [
    `(?<${prefix}Approx>${APPROXIMATE_PREFIX})?`,
    `(?:(?<${prefix}Sign>[-+−])?(?<${prefix}Currency>${CURRENCY_WORDS})${GAP})?`,
    `(?<${prefix}Number>[-+−]?${NUMBER})${NUMBER_END}`,
    `(?:${GAP}(?<${prefix}Scale>${SCALE_WORDS})${RIGHT})?`,
    `(?:${GAP}(?<${prefix}Unit>${UNIT_WORDS})${RIGHT})?`,
  ].join('');
}

interface Amount {
  literal: string;
  scale?: number;
  unit?: string;
  approximate: boolean;
}

function readAmount(groups: Record<string, string | undefined>, prefix: string): Amount | undefined {
  const number = groups[`${prefix}Number`];
  if (number === undefined) return;
  const leadingSign = groups[`${prefix}Sign`] ?? '';
  if (leadingSign && /^[-+−]/u.test(number)) return;
  const currency = CURRENCIES.get(labelKey(groups[`${prefix}Currency`] ?? ''));
  const unit = ALL_UNITS.get(labelKey(groups[`${prefix}Unit`] ?? ''));
  // Only the unqualified dollar sign can be clarified by another dollar label.
  if (currency && unit && currency !== unit && !compatibleDollar(currency, unit)) return;
  return {
    literal: (leadingSign + number).replace(/[,٬،\p{Zs}'’]/gu, '').replace('٫', '.').replace('−', '-'),
    scale: SCALES.get(labelKey(groups[`${prefix}Scale`] ?? '')),
    unit: currency === 'dollar' ? unit ?? currency : currency ?? unit,
    approximate: !!groups[`${prefix}Approx`],
  };
}

const DOLLAR_UNITS = new Set(['AUD', 'CAD', 'HKD', 'NZD', 'SGD', 'USD']);

function compatibleDollar(first: string, second: string): boolean {
  return (first === 'dollar' && DOLLAR_UNITS.has(second)) || (second === 'dollar' && DOLLAR_UNITS.has(first));
}

function scaleValue(literal: string, scale = 1): number | undefined {
  const value = Number(`${literal}e${Math.log10(scale)}`);
  // Above the safe integer limit two distinct source values can normalize to the same number.
  return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER ? value : undefined;
}

const AMOUNT = amountPattern('first');
const RANGE_END = amountPattern('last');
const RANGE_PATTERNS = [
  `(?:between${SEPARATION}${AMOUNT}${SEPARATION}and${SEPARATION}${RANGE_END})`,
  `(?:بين${SEPARATION}${AMOUNT}${GAP}و${GAP}${RANGE_END})`,
  `(?:من${SEPARATION}|from${SEPARATION})?${AMOUNT}${GAP}(?:[-‐‑‒–—−]${GAP}|(?:to|الي|حتي)${SEPARATION})${RANGE_END}`,
];

const RANGES = RANGE_PATTERNS.map(pattern =>
  new RegExp(`${AMOUNT_START}(?<rangeApprox>${APPROXIMATE_PREFIX})?(?:${pattern})${AMOUNT_END}`, 'giu'));
const SINGLE_AMOUNT = new RegExp(`${AMOUNT_START}${AMOUNT}${AMOUNT_END}`, 'giu');
// A year immediately labelled as a time does not become the first endpoint of a measure range.
const YEAR_LEAD = /(?<![\p{L}])(?:عام|سنه|السنه|العام|year|as of|since|during|in)\s+$/iu;
const ARABIC_YEAR_LEAD = /(?<![\p{L}])(?:عام|سنه|السنه|العام)\s+$/u;
const NUMERIC_DATE = /(?<!\d)\d+(?<separator>[-/.])\d+\k<separator>\d+(?!\d)/gu;

function overlaps(spans: readonly Span[], start: number, end: number): boolean {
  return spans.some(span => span.start < end && start < span.end);
}

export function parseEvidenceNumbers(text: string): NumericToken[] {
  const input = project(text);
  const tokens: NumericToken[] = [];
  // Ignore ISO dates and version-like strings, even when they do not form a valid date.
  const ranges: Span[] = [...input.text.matchAll(NUMERIC_DATE)].map(match => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
  for (const pattern of RANGES) {
    for (const match of input.text.matchAll(pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      if (overlaps(ranges, start, end)) continue;
      const first = readAmount(match.groups!, 'first');
      const last = readAmount(match.groups!, 'last');
      if (first && !first.scale && !first.unit && /^(?:1\d{3}|2[01]\d{2})$/u.test(first.literal)
        && YEAR_LEAD.test(input.text.slice(Math.max(0, start - 24), start))) continue;
      ranges.push({ start, end });
      if (!first || !last || PER_UNIT.test(input.text.slice(end))) continue;
      if (first.unit && last.unit && first.unit !== last.unit && !compatibleDollar(first.unit, last.unit)) continue;
      const value = scaleValue(first.literal, first.scale ?? last.scale);
      const upper = scaleValue(last.literal, last.scale ?? first.scale);
      if (value === undefined || upper === undefined) continue;
      const trailing = APPROXIMATE_END.exec(input.text.slice(end));
      tokens.push({
        ...input.span(start, end + (trailing?.[0].length ?? 0)),
        value: Math.min(value, upper),
        upper: Math.max(value, upper),
        unit: first.unit === 'dollar' ? last.unit ?? first.unit : first.unit ?? last.unit,
        approximate: !!match.groups?.rangeApprox || first.approximate || last.approximate || !!trailing,
        scaled: !!(first.scale ?? last.scale),
      });
    }
  }
  for (const match of input.text.matchAll(SINGLE_AMOUNT)) {
    const start = match.index;
    const end = start + match[0].length;
    if (overlaps(ranges, start, end) || INEQUALITY.test(input.text.slice(Math.max(0, start - 40), start))) continue;
    const amount = readAmount(match.groups!, 'first');
    if (!amount || PER_UNIT.test(input.text.slice(end))) continue;
    if (match.groups?.firstUnit === 'م' && !amount.scale && /^\d{3,4}$/u.test(amount.literal)
      && ARABIC_YEAR_LEAD.test(input.text.slice(Math.max(0, start - 24), start))) continue;
    const value = scaleValue(amount.literal, amount.scale);
    if (value === undefined) continue;
    const trailing = APPROXIMATE_END.exec(input.text.slice(end));
    tokens.push({
      ...input.span(start, end + (trailing?.[0].length ?? 0)),
      value,
      unit: amount.unit,
      approximate: amount.approximate || !!trailing,
      scaled: amount.scale !== undefined,
    });
  }
  return tokens.sort((left, right) => left.start - right.start);
}

interface Month {
  month: number;
  calendar: EvidenceDate['calendar'];
}

const GREGORIAN_MONTHS = [
  'January|Jan|Jan.|يناير|كانون الثاني|جانفي',
  'February|Feb|Feb.|فبراير|شباط|فيفري',
  'March|Mar|Mar.|مارس|آذار',
  'April|Apr|Apr.|أبريل|نيسان|أفريل',
  'May|مايو|أيار|ماي',
  'June|Jun|Jun.|يونيو|حزيران|جوان',
  'July|Jul|Jul.|يوليو|تموز|جويلية|يوليوز',
  'August|Aug|Aug.|أغسطس|آب|أوت|غشت',
  'September|Sep|Sep.|Sept|Sept.|سبتمبر|أيلول|شتنبر',
  'October|Oct|Oct.|أكتوبر|تشرين الأول',
  'November|Nov|Nov.|نوفمبر|تشرين الثاني|نونبر',
  'December|Dec|Dec.|ديسمبر|كانون الأول|دجنبر',
];

const HIJRI_MONTHS = [
  'محرم|المحرم|Muharram|Moharram',
  'صفر|Safar',
  'ربيع الأول|Rabi al-Awwal|Rabi I',
  'ربيع الآخر|ربيع الثاني|Rabi al-Thani|Rabi II',
  'جمادى الأولى|Jumada al-Awwal|Jumada I',
  'جمادى الآخرة|جمادى الآخر|جمادى الثانية|Jumada al-Thani|Jumada II',
  'رجب|Rajab',
  "شعبان|Sha'ban|Shaaban|Shaban",
  'رمضان|Ramadan|Ramadhan',
  'شوال|Shawwal',
  'ذو القعدة|ذي القعدة|ذو القعده|Dhu al-Qadah|Dhul Qadah',
  'ذو الحجة|ذي الحجة|Dhu al-Hijjah|Dhul Hijjah',
];

function monthAliases(labels: string[], calendar: Month['calendar']): [Month, string][] {
  return labels.map((label, index) => [{ month: index + 1, calendar }, label]);
}

const MONTHS = aliasMap([...monthAliases(GREGORIAN_MONTHS, 'gregorian'), ...monthAliases(HIJRI_MONTHS, 'hijri')]);
const ORDINAL_DAYS = aliasMap([
  [1, 'الأول|أول'],
  [2, 'الثاني'],
  [3, 'الثالث'],
  [4, 'الرابع'],
  [5, 'الخامس'],
  [6, 'السادس'],
  [7, 'السابع'],
  [8, 'الثامن'],
  [9, 'التاسع'],
  [10, 'العاشر'],
] as const);

const MONTH = `(?<month>${alternatives(MONTHS.keys())})`;
const DAY = `(?<day>\\d{1,2}(?:st|nd|rd|th)?|${alternatives(ORDINAL_DAYS.keys())})`;
const YEAR = '(?<year>\\d{1,4})';
const NUMERIC_YEAR = '(?<year>\\d{3,4})';
const BARE_YEAR = '(?<year>1\\d{3}|2[01]\\d{2})';
const HIJRI_LABEL = 'هـ|هجري(?:ا|ه)?|ه|a\\.?h\\.?';
const GREGORIAN_LABEL = 'ميلادي(?:ا|ه)?|م|a\\.?d\\.?|ce';
const DATE_LABEL = `${GAP}(?<calendar>${HIJRI_LABEL}|${GREGORIAN_LABEL})${RIGHT}`;
const BEFORE_YEAR = `(?:,${GAP}|${SEPARATION}(?:[-–—]${GAP})?)(?:من${SEPARATION})?(?:(?:عام|سنه)${SEPARATION})?`;
const NOT_DATE_CONTINUATION = '(?![-/.,٬٫،]\\d)';
const DATE_LEFT = '(?<![\\p{L}\\p{M}\\p{N}/.])';
const HIJRI_CALENDAR = new RegExp(`^(?:${HIJRI_LABEL})$`, 'iu');

function labelledCalendar(label: string | undefined): EvidenceDate['calendar'] | undefined {
  if (label === undefined) return;
  return HIJRI_CALENDAR.test(label) ? 'hijri' : 'gregorian';
}

function checkedDate(year: number, calendar: EvidenceDate['calendar'], month?: number, day?: number): EvidenceDate | undefined {
  if (year < 1 || month !== undefined && (month < 1 || month > 12)) return;
  if (day === undefined) return month === undefined ? { calendar, year } : { calendar, year, month };
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month === undefined || day < 1 || day > (calendar === 'hijri' ? 30 : days[month - 1])) return;
  return { calendar, year, month, day };
}

type DateGroups = Record<string, string | undefined>;

function namedDate(groups: DateGroups): EvidenceDate | undefined {
  const month = MONTHS.get(labelKey(groups.month ?? ''));
  if (!month) return;
  const labelled = labelledCalendar(groups.calendar);
  const calendar = labelled ?? month.calendar;
  if (calendar !== month.calendar) return;
  const year = Number(groups.year);
  const day = groups.day === undefined ? undefined : ORDINAL_DAYS.get(labelKey(groups.day)) ?? Number.parseInt(groups.day, 10);
  // “March 7” and “Ramadan 7” name a day of the month without stating a year.
  if (!labelled && ((day === undefined && year <= 31) || (calendar === 'gregorian' && year < 100))) return;
  return checkedDate(year, calendar, month.month, day);
}

function yearFirstDate(groups: DateGroups): EvidenceDate | undefined {
  return checkedDate(Number(groups.year), labelledCalendar(groups.calendar) ?? 'gregorian', Number(groups.month), Number(groups.day));
}

function yearLastDate(groups: DateGroups): EvidenceDate | undefined {
  const first = Number(groups.first);
  const second = Number(groups.second);
  // Reject ambiguous dates, except when swapping the components gives the same day.
  if (first <= 12 && second <= 12 && first !== second) return;
  const [month, day] = first <= 12 ? [first, second] : [second, first];
  return checkedDate(Number(groups.year), labelledCalendar(groups.calendar) ?? 'gregorian', month, day);
}

function yearDate(groups: DateGroups): EvidenceDate | undefined {
  return checkedDate(Number(groups.year), labelledCalendar(groups.calendar) ?? 'gregorian');
}

const DATE_PATTERNS: ReadonlyArray<readonly [string, (groups: DateGroups) => EvidenceDate | undefined]> = [
  [`${NUMERIC_YEAR}(?<separator>[-/])(?<month>\\d{1,2})\\k<separator>(?<day>\\d{1,2})(?:${DATE_LABEL})?`, yearFirstDate],
  [`(?<first>\\d{1,2})(?<separator>[-/])(?<second>\\d{1,2})\\k<separator>${NUMERIC_YEAR}(?:${DATE_LABEL})?`, yearLastDate],
  [`${DAY}${SEPARATION}(?:(?:of|من)${SEPARATION})?${MONTH}${BEFORE_YEAR}${YEAR}(?:${DATE_LABEL})?`, namedDate],
  [`${MONTH}${SEPARATION}${DAY}${BEFORE_YEAR}${YEAR}(?:${DATE_LABEL})?`, namedDate],
  [`${MONTH}${BEFORE_YEAR}${YEAR}(?:${DATE_LABEL})?`, namedDate],
  [`${YEAR}${DATE_LABEL}`, yearDate],
  [BARE_YEAR, yearDate],
];

const DATE_MATCHERS = DATE_PATTERNS.map(([pattern, read]) => [
  new RegExp(`${DATE_LEFT}(?:${pattern})${RIGHT}${NOT_DATE_CONTINUATION}`, 'giu'),
  read,
] as const);

export function parseEvidenceDates(text: string): DateToken[] {
  const input = project(text);
  const spans: Span[] = [];
  const tokens: DateToken[] = [];
  for (const [pattern, read] of DATE_MATCHERS) {
    for (const match of input.text.matchAll(pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      if (overlaps(spans, start, end)) continue;
      spans.push({ start, end });
      const date = read(match.groups!);
      if (date) tokens.push({ ...input.span(start, end), date });
    }
  }
  return tokens.sort((left, right) => left.start - right.start);
}
