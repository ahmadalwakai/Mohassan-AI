import { compute } from './mind/compute.js';
import { buildFrame } from './mind/frame.js';
import { matchText } from './mind/normalize.js';

export interface Quantity {
  kind: 'date' | 'number';
  value: string;
  unit: string | null;
  /** UTF-16 offsets into the unchanged input. */
  start: number;
  end: number;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const aliases = (words: Iterable<string>) => [...words].sort((a, b) => b.length - a.length)
  .map(word => escape(word).replaceAll(' ', '\\s+')).join('|');

/** Retain source offsets while folding Arabic spellings, digits and compatibility unit symbols. */
function matchingText(input: string) {
  if (/^[\x00-\x7F]*$/u.test(input)) {
    return { text: input.toLowerCase(), span: (start: number, end: number) => ({ start, end }) };
  }
  const starts: number[] = [], ends: number[] = [], characters: string[] = [];
  let offset = 0;
  for (const character of input) {
    const normalized = /\p{Cf}/u.test(character) ? '' : matchText(character).replace('٫', '.').replace('٪', '%').replace('−', '-');
    characters.push(normalized);
    for (let index = 0; index < normalized.length; index++) {
      starts.push(offset);
      ends.push(offset + character.length);
    }
    offset += character.length;
  }
  return { text: characters.join(''), span: (start: number, end: number) => ({ start: starts[start], end: ends[end - 1] }) };
}

const MONTHS = [
  'january|jan|يناير|كانون الثاني', 'february|feb|فبراير|شباط', 'march|mar|مارس|آذار',
  'april|apr|أبريل|إبريل|نيسان', 'may|مايو|أيار', 'june|jun|يونيو|حزيران',
  'july|jul|يوليو|تموز', 'august|aug|أغسطس|آب', 'september|sep|sept|سبتمبر|أيلول',
  'october|oct|أكتوبر|تشرين الأول', 'november|nov|نوفمبر|تشرين الثاني', 'december|dec|ديسمبر|كانون الأول',
];
const monthNumber = new Map(MONTHS.flatMap((names, index) =>
  names.split('|').map(name => [matchText(name), index + 1] as const)));
const MONTH = String.raw`(?<month>${aliases(monthNumber.keys())})\.?`;
const DAY = String.raw`(?<day>\d{1,2})(?:st|nd|rd|th)?`;
const YEAR = String.raw`(?<year>\d{3,4})`;
const DATE_LEFT = String.raw`(?<![\p{L}\d])`;
const DATE_RIGHT = String.raw`(?![\p{L}\d])`;
const DATE_PATTERNS = [
  /(?<![\p{L}\d])(?<year>\d{4})(?<separator>[-/])(?<month>\d{1,2})\k<separator>(?<day>\d{1,2})(?![\p{L}\d])/gu,
  new RegExp(String.raw`${DATE_LEFT}${DAY}\s+${MONTH}(?:[\s,،]+${YEAR})?${DATE_RIGHT}`, 'gu'),
  new RegExp(String.raw`${DATE_LEFT}${MONTH}\s+${DAY}(?:[\s,،]+${YEAR})?${DATE_RIGHT}`, 'gu'),
  new RegExp(String.raw`${DATE_LEFT}${MONTH}\s+${YEAR}${DATE_RIGHT}`, 'gu'),
];
const NON_GREGORIAN = /^\s*(?:a\.?h\.?|b\.?c\.?(?:e\.?)?|هجري(?:ه|ا)?|هـ|هجر[يه]|ق\.?\s*م|قبل الميلاد)(?![\p{L}\d])/u;
const YEAR_CONTEXT = /(?:\b(?:in|since|until|from|by|during|as of|around|circa|year|opened|closed|founded|established|born|died|occurred|started|ended|began)\b|(?<!\p{L})(?:عام|سنه|في|منذ|حتي|خلال|مواليد|سقط|توفي|افتتح|تاسس))\s*$/u;
const YEAR_STATED = /^\s*(?:c\.?e\.?|a\.?d\.?|ميلادي(?:ه|ا)?)(?![\p{L}\d])/u;

function calendarValue(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 0) return null;
  const date = new Date(0);
  date.setUTCFullYear(year || 2000, month - 1, day || 1);
  if (day && date.getUTCMonth() + 1 !== month) return null;
  const prefix = year ? String(year).padStart(4, '0') : '-';
  return `${prefix}-${String(month).padStart(2, '0')}${day ? `-${String(day).padStart(2, '0')}` : ''}`;
}

const MEASURES = [
  ['km/h', 'km/h|km/hr|kph|kilometers per hour|kilometres per hour|kilometer per hour|kilometre per hour|كم/س|كيلومتر في الساعة|كيلومتر/ساعة'],
  ['m/s', 'm/s|meters per second|metres per second|meter per second|metre per second|م/ث|متر في الثانية|متر/ثانية'],
  ['mph', 'mph|miles per hour|mile per hour|ميل في الساعة'],
  ['km2', 'km2|km^2|sq km|square kilometres|square kilometers|square kilometre|square kilometer|كيلومتر مربع|كم2'],
  ['m2', 'm2|m^2|sq m|square metres|square meters|square metre|square meter|متر مربع|م2'],
  ['ft2', 'ft2|ft^2|sq ft|square feet|square foot|قدم مربع'],
  ['m3', 'm3|m^3|cubic meters|cubic metres|cubic meter|cubic metre|متر مكعب|م3'],
  ['ha', 'ha|hectares|hectare|هكتار|هكتارات'],
  ['acre', 'acres|acre|أيكر'],
  ['km', 'km|kilometers|kilometer|kilometres|kilometre|كيلومتر|كيلومترات|كيلو متر|كم'],
  ['m', 'm|meters|meter|metres|metre|متر|أمتار|م'],
  ['cm', 'cm|centimeters|centimeter|centimetres|centimetre|سنتيمتر|سنتيمترات|سم'],
  ['mm', 'mm|millimeters|millimeter|millimetres|millimetre|مليمتر|ملليمتر|مم'],
  ['ft', 'ft|feet|foot|قدم|أقدام'],
  ['inch', 'inches|inch|بوصة|بوصات'],
  ['yd', 'yd|yards|yard|ياردة|ياردات'],
  ['mi', 'mi|miles|mile|ميل|أميال'],
  ['t', 'tonnes|tonne|metric tons|metric ton|طن|أطنان'],
  ['kg', 'kg|kilograms|kilogram|كيلوغرام|كيلوغرامات|كيلوجرام|كيلوجرامات|كيلو غرام|كغ|كجم'],
  ['g', 'g|grams|gram|غرام|غرامات|جرام|جرامات|غ|جم'],
  ['mg', 'mg|milligrams|milligram|مليغرام|مليجرام|ملغ'],
  ['lb', 'lb|lbs|رطل|أرطال'],
  ['oz', 'oz|ounces|ounce|أونصة'],
  ['l', 'l|liters|liter|litres|litre|لتر|لترات'],
  ['ml', 'ml|milliliters|milliliter|millilitres|millilitre|مليلتر|ملليلتر|مل'],
  ['°c', '°c|degrees celsius|degree celsius|celsius|درجة مئوية|درجات مئوية|مئوية'],
  ['°f', '°f|degrees fahrenheit|degree fahrenheit|fahrenheit|درجة فهرنهايت|درجات فهرنهايت|فهرنهايت'],
  ['kelvin', 'kelvins|kelvin|كلفن'],
  ['sec', 'sec|secs|seconds|second|ثانية|ثوان|ثواني'],
  ['min', 'min|mins|minutes|minute|دقيقة|دقائق'],
  ['h', 'h|hrs|hr|hours|hour|ساعة|ساعات'],
] as const;

const COUNTS = [
  ['days', 'days|day|أيام|يوم'], ['weeks', 'weeks|week|أسابيع|أسبوع'],
  ['months', 'months|month|أشهر|شهور|شهر'], ['years', 'years|year|سنوات|سنة|عام|أعوام'],
  ['people', 'people|persons|person|نسمة|نسمات|أشخاص|شخص'],
  ['residents', 'inhabitants|inhabitant|residents|resident|سكان|ساكن'],
  ['citizens', 'citizens|citizen|مواطنون|مواطنين|مواطن'],
  ['seats', 'seats|seat|مقاعد|مقعد'], ['employees', 'employees|employee|workers|worker|staff members|موظف|موظفون|موظفين|عامل|عمال'],
  ['students', 'students|student|pupils|pupil|طلاب|طالب|تلاميذ|تلميذ'],
  ['members', 'members|member|أعضاء|عضو'], ['participants', 'participants|participant|مشاركون|مشاركين|مشارك'],
  ['volunteers', 'volunteers|volunteer|متطوعون|متطوعين|متطوع'], ['exhibitors', 'exhibitors|exhibitor|عارضون|عارضين|عارض'],
  ['children', 'children|child|أطفال|طفل'], ['visitors', 'visitors|visitor|زوار|زائر'],
  ['passengers', 'passengers|passenger|ركاب|راكب'], ['patients', 'patients|patient|مرضى|مريض'],
  ['rooms', 'rooms|room|غرف|غرفة'], ['floors', 'floors|floor|stories|story|storeys|storey|طوابق|طابق'],
  ['buildings', 'buildings|building|مباني|مبنى'], ['homes', 'homes|home|houses|house|منازل|منزل|بيوت|بيت'],
  ['books', 'books|book|كتب|كتاب'], ['pages', 'pages|page|صفحات|صفحة'],
  ['languages', 'languages|language|لغات|لغة'], ['copies', 'copies|copy|نسخ|نسخة'],
  ['words', 'words|word|كلمات|كلمة'], ['letters', 'letters|letter|أحرف|حروف|حرف'],
  ['vehicles', 'vehicles|vehicle|مركبات|مركبة'], ['cars', 'cars|car|سيارات|سيارة'],
  ['buses', 'buses|bus|حافلات|حافلة'], ['trains', 'trains|train|قطارات|قطار'],
  ['platforms', 'platforms|platform|أرصفة|رصيف'], ['stalls', 'stalls|stall|أكشاك|كشك'],
  ['items', 'items|item|pieces|piece|عناصر|عنصر|قطع|قطعة'], ['units', 'units|unit|وحدات|وحدة'],
  ['countries', 'countries|country|بلدان|بلد|دول|دولة'], ['cities', 'cities|city|مدن|مدينة'],
  ['villages', 'villages|village|قرى|قرية'], ['continents', 'continents|continent|قارات|قارة'],
  ['islands', 'islands|island|جزر|جزيرة'], ['planets', 'planets|planet|كواكب|كوكب'],
  ['teams', 'teams|team|فرق|فريق'], ['players', 'players|player|لاعب|لاعبين|لاعبون'],
  ['goals', 'goals|goal|أهداف|هدف'], ['points', 'points|point|نقاط|نقطة'],
  ['votes', 'votes|vote|أصوات|صوت'], ['times', 'times|time|مرات|مرة'],
  ['cases', 'cases|case|حالات|حالة'], ['species', 'species|أنواع|نوع'],
  ['feddans', 'feddans|feddan|أفدنة|فدان'],
  ['%', '%|percent|per cent|بالمئة|بالمائة|في المئة|في المائة'],
  ['percentage points', 'percentage points|percentage point|نقاط مئوية|نقطة مئوية'],
] as const;

const CURRENCIES = [
  ['USD', 'usd|us dollars|us dollar|دولار أمريكي'], ['dollars', '$|dollars|dollar|دولارات|دولار'],
  ['EUR', '€|eur|euros|euro|يورو'], ['GBP', '£|gbp|pounds sterling|pound sterling|جنيه إسترليني'],
  ['SAR', 'sar|saudi riyals|saudi riyal|ريال سعودي'], ['riyals', 'riyals|riyal|ريالات|ريال'],
  ['AED', 'aed|uae dirhams|uae dirham|درهم إماراتي'], ['dirhams', 'dirhams|dirham|دراهم|درهم'],
  ['JPY', 'jpy|yen|ين ياباني'], ['¥', '¥'], ['EGP', 'egp|egyptian pounds|egyptian pound|جنيه مصري'],
  ['pounds', 'pounds|pound|جنيهات|جنيه'], ['dinars', 'dinars|dinar|دنانير|دينار'],
] as const;

function unitAliases(entries: readonly (readonly [string, string])[]) {
  const result = new Map<string, string>();
  for (const [unit, names] of entries) {
    for (const alias of names.split('|').map(matchText)) {
      result.set(alias, unit);
      if (/^\p{Script=Arabic}+(?<![اهوي])$/u.test(alias)) result.set(`${alias}ا`, unit);
    }
  }
  return result;
}

const unitName = unitAliases([...MEASURES, ...COUNTS, ...CURRENCIES]);
const unitPattern = new RegExp(String.raw`^\s*(${aliases(unitName.keys())})(?![\p{L}\d])`, 'u');
const currencyName = unitAliases(CURRENCIES);
const SCALES = [['thousand|ألف|آلاف', 3], ['million|مليون|ملايين', 6],
  ['billion|مليار|مليارات', 9], ['trillion|تريليون|تريليونات', 12]] as const;
const scalePowers = new Map(SCALES.flatMap(([names, power]) =>
  names.split('|').map(name => [matchText(name), power] as const)));
const scalePattern = new RegExp(String.raw`^\s+(${aliases(scalePowers.keys())})(?![\p{L}\d])`, 'u');
const numeral = String.raw`[+-]?(?:(?:\d{1,3}(?:[,،٬]\d{3})+|\d+)(?:\.\d+)?|\.\d+)(?:e[+-]?\d{1,3})?`;
const numberPattern = new RegExp(String.raw`(?<![\p{L}\d.,،٬])(?:(${aliases(currencyName.keys())})\s*)?(${numeral})(?!\d|[,،٬.]\d)`, 'gu');
const perUnitPattern = new RegExp(String.raw`^\s*(?:/|per\s+|لكل\s+|في\s+كل\s+)(${aliases(unitName.keys())})(?![\p{L}\d])`, 'u');

const MASS_CONTEXT = /\b(?:weigh(?:s|ed|ing)?|weight|mass)\b/u;

function decimalValue(raw: string, scale: number): string | null {
  const normalized = raw.replace(/[,،٬]/gu, '');
  const [coefficient, exponent = '0'] = normalized.split('e');
  const [integer, fraction = ''] = coefficient.replace(/^[+-]/u, '').split('.');
  const point = integer.length + Number(exponent) + scale;
  const digits = integer + fraction;
  if (digits.length > 100 || Math.abs(point) > 100) return null;
  const head = (point < 0 ? '' : digits.slice(0, point).padEnd(point, '0')).replace(/^0+/u, '') || '0';
  const tail = (`${'0'.repeat(Math.max(0, -point))}${digits.slice(Math.max(0, point))}`).replace(/0+$/u, '');
  return `${coefficient.startsWith('-') && (head !== '0' || tail) ? '-' : ''}${head}${tail ? `.${tail}` : ''}`;
}

const overlaps = (first: { start: number; end: number }, second: { start: number; end: number }) =>
  first.start < second.end && second.start < first.end;

export function extractQuantities(input: string): Quantity[] {
  const { text, span } = matchingText(input);
  const quantities: Quantity[] = [];
  const dateSpans: { start: number; end: number; valid: boolean }[] = [];
  for (const pattern of DATE_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index, end = start + match[0].length;
      if (dateSpans.some(other => overlaps({ start, end }, other))) continue;
      const { year, month, day } = match.groups!;
      const value = (day && Number(day) === 0) || (year && Number(year) === 0) || NON_GREGORIAN.test(text.slice(end))
        ? null : calendarValue(Number(year ?? 0), monthNumber.get(month.replace(/\s+/gu, ' ')) ?? Number(month), Number(day ?? 0));
      dateSpans.push({ start, end, valid: value !== null });
      if (value) quantities.push({ kind: 'date', value, unit: null, ...span(start, end) });
    }
  }
  for (const match of text.matchAll(numberPattern)) {
    const start = match.index, numberEnd = start + match[0].length;
    const insideDate = dateSpans.find(other => overlaps({ start, end: numberEnd }, other));
    if (insideDate?.valid) continue;
    const after = text.slice(numberEnd);
    const scale = scalePattern.exec(after);
    const unitsStart = numberEnd + (scale?.[0].length ?? 0);
    let units = unitPattern.exec(text.slice(unitsStart));
    if (units?.[1] === 'm') {
      const original = span(unitsStart, unitsStart + units[0].length);
      // Capital M is often a multiplier. It cannot establish a metre.
      if (input.slice(original.start, original.end).trim() === 'M') units = null;
    }
    let unit = (match[1] && currencyName.get(match[1])) || (units && unitName.get(units[1].replace(/\s+/gu, ' '))) || null;
    let end = unitsStart + (match[1] ? 0 : units?.[0].length ?? 0);
    const context = text.slice(Math.max(0, start - 48), start);
    if (!match[1] && /^pounds?$/u.test(units?.[1] ?? '') && MASS_CONTEXT.test(context)) unit = 'lb';
    const perUnit = unit && perUnitPattern.exec(text.slice(end));
    if (perUnit) {
      unit += `/${unitName.get(perUnit[1].replace(/\s+/gu, ' '))}`;
      end += perUnit[0].length;
    }
    const dated = YEAR_CONTEXT.test(context);
    const abbreviatedEra = dated && units?.[1] === 'م';
    const statedEra = YEAR_STATED.test(after);
    if ((!unit || abbreviatedEra) && !scale && !insideDate && /^\d{3,4}$/u.test(match[2])
        && Number(match[2]) > 0 && !NON_GREGORIAN.test(after)
        && (!/^\p{L}/u.test(after) || abbreviatedEra || statedEra)
        && (dated || statedEra || /^\d{4}[.!?؟]?$/u.test(text.trim()) && Number(match[2]) >= 1000)) {
      quantities.push({ kind: 'date', value: match[2].padStart(4, '0'), unit: null, ...span(start, end) });
      continue;
    }
    const value = decimalValue(match[2], scalePowers.get(scale?.[1] ?? '') ?? 0) ?? match[0];
    quantities.push({ kind: 'number', value, unit, ...span(start, end) });
  }
  return quantities.sort((a, b) => a.start - b.start);
}

export function comparableQuantityUnits(a: Quantity, b: Quantity): boolean {
  return a.kind === b.kind && a.unit === b.unit;
}

export function equivalentQuantity(a: Quantity, b: Quantity): boolean {
  return comparableQuantityUnits(a, b) && a.value === b.value;
}

const dateParts = (value: string) => value.startsWith('--') ? ['', ...value.slice(2).split('-')] : value.split('-');

export function supportsQuantity(claim: Quantity, evidence: Quantity): boolean {
  if (equivalentQuantity(claim, evidence)) return true;
  if (claim.kind !== 'date' || evidence.kind !== 'date') return false;
  const quoted = dateParts(evidence.value);
  return dateParts(claim.value).every((part, index) => !part || part === quoted[index]);
}

export function conflictingQuantity(claim: Quantity, evidence: Quantity): boolean {
  if (!comparableQuantityUnits(claim, evidence)) return false;
  if (claim.kind === 'number') return claim.value !== evidence.value;
  const quoted = dateParts(evidence.value);
  return dateParts(claim.value).some((part, index) => Boolean(part && quoted[index] && part !== quoted[index]));
}

const convertibleUnits = new Set<string>(MEASURES.map(([unit]) => unit));
const CONVERSION_BEFORE = /(?:\bconverted(?:\s+to\s+[a-z]+)?|\bconversion|\bequivalent\s+to|\bequals|تحويل|محول[اه]?|يعادل|يساوي|[=≈])\s*[:(]?\s*(?:about\s+|approximately\s+|نحو\s+|حوالي\s+)?$/u;
const CONVERSION_AFTER = /^\s*(?:\(\s*(?:a\s+)?(?:converted\b|(?:unit\s+)?conversion\b|تحويل(?!\p{L})|محول[اه]?(?!\p{L}))|[=≈])/u;

/** Reuse the local calculator only when the claim marks its own supported unit conversion. */
export function labelledConversion(text: string, claim: Quantity, evidence: Quantity): boolean {
  if (claim.kind !== 'number' || evidence.kind !== 'number' || !claim.unit || !evidence.unit || claim.unit === evidence.unit
      || !convertibleUnits.has(claim.unit) || !convertibleUnits.has(evidence.unit)) return false;
  const before = matchText(text.slice(Math.max(0, claim.start - 48), claim.start));
  const after = matchText(text.slice(claim.end, claim.end + 48));
  if (!CONVERSION_BEFORE.test(before) && !CONVERSION_AFTER.test(after)) return false;
  const request = `convert ${evidence.value} ${evidence.unit} to ${claim.unit}`;
  const result = compute(buildFrame(request), new Date(0));
  const value = result?.evidence[0]?.value;
  return result?.status === 'completed' && result.consumption.kind === 'conversion'
    && value !== undefined && decimalValue(value, 0) === claim.value;
}
