import { computeHijri, inspectHijri } from '../../live-data/calendar-answer.js';
import type { Frame } from './contract.js';
import { fixedReply, type LocalReply } from './limits.js';
import { evaluateArithmeticExpression } from '../calculator.js';
import { finishComputationConsumption, prepareComputationSource, type ComputationConsumption, type ComputationKind, type PreparedComputationSource } from './computation-consumption.js';
export type { ComputationConsumption } from './computation-consumption.js';

type Failure = 'division' | 'range' | 'domain' | 'complexity' | 'expression' | 'units' | 'quantity' | 'date' | 'date_direction' | 'date_year' | 'timezone';
class CalculationError extends Error {
  constructor(readonly kind: Failure) { super(kind); }
}

const MESSAGES: Record<Failure, { ar: string; en: string }> = {
  division: { ar: 'القسمة على صفر غير معرّفة.', en: 'Division by zero is undefined.' },
  range: { ar: 'لا يمكن تمثيل نتيجة هذا الحساب بدقة كافية.', en: 'The calculation exceeds the number range I can represent reliably.' },
  domain: { ar: 'التعبير خارج نطاق الحساب بالأعداد الحقيقية المدعوم.', en: 'The expression is outside the supported real-number domain.' },
  complexity: { ar: 'التعبير يتجاوز حدود تعقيد الحساب المدعومة.', en: 'The expression exceeds the supported calculation complexity.' },
  expression: { ar: 'لم أتمكن من قراءة هذا التعبير الحسابي. أعد كتابته بأرقام وعلامات العمليات.', en: 'I couldn’t read the arithmetic expression. Please write it with numbers and operators.' },
  units: { ar: 'لم أتعرف على تحويل بين وحدتين من النوع نفسه. اذكر وحدة الأصل ووحدة التحويل.', en: 'I couldn’t identify two compatible units. Name the original and target units.' },
  quantity: { ar: 'الكمية المكتوبة قد تعني عددًا أو كسرًا. اكتبها بالأرقام أو بكسر رقمي مثل 1/5 لأحسبها بدقة.', en: 'The written quantity could mean a count or a fraction. Write digits or a numeric fraction such as 1/5.' },
  date: { ar: 'التاريخ الميلادي غير صالح أو غير مكتمل. حدّده باليوم والشهر والسنة.', en: 'The Gregorian date is invalid or incomplete. Specify the day, month and year.' },
  date_direction: { ar: 'اتجاه التاريخ يناقض الطلب: «منذ» تحتاج تاريخًا مضى و«حتى» تحتاج تاريخًا لم يمضِ. حدّد التاريخ أو الاتجاه المقصود.', en: 'The date contradicts the requested direction: since needs a past date and until needs a date that has not passed. Specify the intended date or direction.' },
  date_year: { ar: 'المدى المكتوب يعكس ترتيب الشهرين دون تحديد السنة. اذكر السنة لكل تاريخ لأحسب المدى المقصود.', en: 'The month/day order runs backwards without an explicit year. Specify the year for each date so I can calculate the intended interval.' },
  timezone: { ar: 'تعذر تحديد وقت واحد من المناطق والتاريخ المكتوبين. اذكر منطقة زمنية ووقتًا محددين.', en: 'I couldn’t resolve a single time from those zones and dates. Specify the time and time zone.' },
};

const NUMBER = String.raw`[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?`;
const RESULT_FORMAT = new Intl.NumberFormat('en', { useGrouping: false, maximumSignificantDigits: 15 });
const formatNumber = (value: number) => Number.isInteger(value) ? String(value) : RESULT_FORMAT.format(value);
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

const SHORT_EN = String.raw`(?:(?:return|give|show|reply with|output)\s+)?(?:(?:just|only)\s+(?:the\s+)?(?:answer|result|value|number)|(?:the\s+)?(?:answer|result|value|number)\s+(?:only|alone)|only|(?:no|without(?:\s+an)?)\s+(?:explanation|steps))`;
const SHORT_AR = String.raw`(?:(?:اعطني|اعطيني|اريد|اكتب|اجب)\s+)?(?:(?:ال)?(?:نتيج[ةه]|ناتج|جواب|اجاب[ةه]|قيم[ةه]|رقم|عدد)\s+(?:فقط|بس|وحده[ا]?)|فقط|بس|(?:من دون|بدون|بلا|دون)\s+(?:شرح|تفصيل))`;
const SHORT_ANSWER_TAIL = new RegExp(String.raw`[\s,.!?:؟،؛;]+(?:${SHORT_EN}|${SHORT_AR})[\s,.!?؟،؛;]*$`, 'iu');

function safeNumber(value: number): number {
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) throw new CalculationError('range');
  return value;
}

function calculated(frame: Frame, value: string, line: string): LocalReply {
  const text = frame.valueOnly ? value : line;
  return {
    status: 'completed', text,
    claims: [{ text, support: ['calculation'], status: 'confirmed' }],
    evidence: [{ id: 'calculation', source: 'computed', quote: line, value }],
  };
}

// «كم حاصل 17 × 23؟» and «ما هو ناتج …» ask for the result as «ما ناتج …» does (real request rq039, 2026-11-22).
const ARITHMETIC_INTRO = /^(?:(?:please|kindly|من فضلك|لو سمحت)[,،:\s]+)?(?:(?:calculate|compute|evaluate|solve|what is|what['’]s|how much is|(?:كم|ما)(?: (?:هو|هي))?(?: (?:يساوي|تساوي|ناتج|حاصل|نتيج[ةه]))?|ناتج|حاصل|نتيج[ةه])|(?:(?:نبي|نبغي|ابغي|ابي|بدي|بدنا|عايز|عايزة|عايزين|اريد|نريد)\s+(?:ان\s+)?)?(?:احسب(?:وا|ي)?|نحسب))[\s:،]+/iu;

const OPERAND_COMMANDS = [
  { match: /^(?:subtract|اطرح)[\s:،]+(.+?)\s+(?:from|من)\s+(.+)$/iu, operator: '-', reverse: true },
  { match: /^(?:divide|اقسم)[\s:،]+(.+?)\s+(?:by|علي)\s+(.+)$/iu, operator: '/' },
  { match: /^(?:multiply|اضرب)[\s:،]+(.+?)\s+(?:by|في)\s+(.+)$/iu, operator: '*' },
  { match: /^(?:add|اجمع|اضف)[\s:،]+(.+?)\s+(?:to|and|الي|مع)\s+(.+)$/iu, operator: '+' },
] as const;

function directedExpression(input: string) {
  for (const rule of OPERAND_COMMANDS) {
    const match = rule.match.exec(input);
    if (!match) continue;
    const [, first, second] = match;
    const [left, right] = 'reverse' in rule ? [second, first] : [first, second];
    return `(${left}) ${rule.operator} (${right})`;
  }
  return input;
}

function arithmeticExpression(input: string): string | null {
  const math = input.replace(ARITHMETIC_INTRO, '');
  if (/\b0(?:x[0-9a-f]+|b[01]+|o[0-7]+)\b/iu.test(math)) return null;
  const expression = directedExpression(math)
    .replace(/\b(?:percent|per cent)\b|(?:بال|في\s+ال)م(?:ا?ئ[ةه]|ي[ةه])(?!\p{L})/giu, '%')
    .replace(/%\s*(?:of\b|من(?!\p{L}))/giu, '% *')
    // An Arabic operator word takes its preposition with it: «قسمة على» and «ضرب في» are one operator each. Leaving «على»
    // behind made «(١٢ زائد ٨) قسمة على ٣» an unreadable expression (real requests rq014 and rq070, 2026-11-22).
    .replace(/\b(?:divided by|over)\b|مقسوم(?:ا|ة|ه)?\s+علي|قسم[ةه](?:\s+علي(?!\p{L}))?/giu, '/')
    .replace(/\b(?:times|multiplied by)\b|مضروب(?:ا|ة|ه)?\s+في|ضرب(?:\s+في(?!\p{L}))?|(?<=\d)\s*[xX]\s*(?=\d)|[×·]/giu, '*')
    .replace(/\bplus\b|(?:زائد|زايد|جمع)(?!\p{L})/giu, '+')
    .replace(/\bminus\b|(?:ناقص|طرح)(?!\p{L})/giu, '-')
    .replace(/÷/gu, '/').trim();
  // Retain the unsupported-language boundary: a currency/source request or an
  // instruction with extra words stays available to routing. Numeric grammar
  // and evaluation belong to the one shared, bounded parser.
  const tokens = [...expression.matchAll(/(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|[()+*\/^%\-]/giu)].map(match => match[0]);
  if (!tokens.length || tokens.join('') !== expression.replace(/\s+/gu, '')) return null;
  return expression;
}

function arithmetic(input: string): { value: number; expression: string } | null {
  const expression = arithmeticExpression(input);
  if (expression === null) return null;
  const result = evaluateArithmeticExpression(expression, { allowPercent: true });
  if (result.ok) return { value: result.value, expression };
  throw new CalculationError(result.error === 'division_by_zero' ? 'division' : result.error === 'syntax' ? 'expression' : result.error);
}

type Unit = { dim: string; factor: number; offset?: number; names: string; pluralNames?: string; abbreviations?: string };
// SI, IEC, common imperial units, and affine temperature scales.
const UNITS: readonly Unit[] = [
  { dim: 'length', factor: 1, names: 'm|meter|metre|م|متر|امتار', pluralNames: 'امتار' },
  { dim: 'length', factor: 1e3, names: 'km|kilometer|kilometre|كم|كيلومتر|كيلو متر|كيلومترات', pluralNames: 'كيلومترات' },
  { dim: 'length', factor: 1e-2, names: 'cm|centimeter|centimetre|سم|سنتيمتر|سنتيمترات' },
  { dim: 'length', factor: 1e-3, names: 'mm|millimeter|millimetre|مم|ملليمتر|مليمتر' },
  { dim: 'length', factor: 0.0254, names: 'in|inch|inches|بوصة|بوصه|انش' },
  { dim: 'length', factor: 0.3048, names: 'ft|foot|feet|قدم|اقدام', pluralNames: 'اقدام' },
  { dim: 'length', factor: 0.9144, names: 'yd|yard|ياردة|يارده' },
  { dim: 'length', factor: 1609.344, names: 'mi|mile|ميل|اميال', pluralNames: 'اميال' },
  { dim: 'mass', factor: 1, names: 'kg|kilogram|كغ|كجم|كيلوغرام|كيلوجرام|كيلو غرام|كيلو جرام', pluralNames: 'كيلوغرامات|كيلوجرامات' },
  { dim: 'mass', factor: 1e-3, names: 'g|gram|غ|جم|غرام|جرام', pluralNames: 'غرامات|جرامات' },
  { dim: 'mass', factor: 1e-6, names: 'mg|milligram|ملغ|مليغرام|مليجرام|ملليجرام' },
  { dim: 'mass', factor: 1e3, names: 't|tonne|metric ton|طن|اطنان', pluralNames: 'اطنان' },
  { dim: 'mass', factor: 0.45359237, names: 'lb|pound|رطل|ارطال', pluralNames: 'ارطال' },
  { dim: 'mass', factor: 0.45359237 / 16, names: 'oz|ounce|اونصة|اونصه' },
  { dim: 'temperature', factor: 1, offset: 273.15, names: 'c|°c|celsius|centigrade|مئوي|مئوية|مئويه|سيليسيوس|سيلسيوس|سلسيوس' },
  { dim: 'temperature', factor: 5 / 9, offset: 273.15 - 32 * 5 / 9, names: 'f|°f|fahrenheit|فهرنهايت' },
  { dim: 'temperature', factor: 1, names: 'k|kelvin|كلفن|كيلفن' },
  { dim: 'area', factor: 1, names: 'm2|m^2|square metre|square meter|sq m|متر مربع|م2' },
  { dim: 'area', factor: 1e6, names: 'km2|km^2|square kilometre|square kilometer|sq km|كيلومتر مربع' },
  { dim: 'area', factor: 1e-4, names: 'cm2|cm^2|square centimetre|square centimeter|سنتيمتر مربع' },
  { dim: 'area', factor: 1e4, names: 'ha|hectare|هكتار' },
  { dim: 'area', factor: 0.3048 ** 2, names: 'ft2|ft^2|sq ft|square foot|square feet|قدم مربع' },
  { dim: 'area', factor: 4046.8564224, names: 'acre|ايكر' },
  { dim: 'volume', factor: 1, names: 'm3|m^3|cubic meter|cubic metre|متر مكعب' },
  { dim: 'volume', factor: 1e-3, names: 'l|liter|litre|ل|لتر|لترات', pluralNames: 'لترات' },
  { dim: 'volume', factor: 1e-6, names: 'ml|milliliter|millilitre|مل|مليلتر|ملليلتر|ملي لتر|cm3' },
  { dim: 'volume', factor: 0.003785411784, names: 'us gallon|american gallon|غالون امريكي|جالون امريكي' },
  { dim: 'volume', factor: 0.00454609, names: 'imperial gallon|uk gallon|british gallon|غالون بريطاني|جالون بريطاني' },
  { dim: 'speed', factor: 1, names: 'm/s|meter per second|metre per second|م/ث|متر في الثانية|متر في الثانيه|متر/ثانية' },
  { dim: 'speed', factor: 1e3 / 3600, names: 'km/h|km/hr|kph|kilometer per hour|kilometre per hour|كم/س|كيلومتر في الساعة|كيلومتر في الساعه|كيلومتر/ساعة' },
  { dim: 'speed', factor: 1609.344 / 3600, names: 'mph|mile per hour|ميل في الساعة|ميل في الساعه|ميل/ساعة' },
  { dim: 'speed', factor: 1852 / 3600, names: 'knot|kt|عقدة|عقده' },
  { dim: 'data', factor: 1, names: 'byte|بايت', abbreviations: 'B' },
  { dim: 'data', factor: 1 / 8, names: 'bit|بت', abbreviations: 'b' },
  { dim: 'data', factor: 1e3, names: 'kilobyte|كيلوبايت|كيلو بايت', abbreviations: 'kB|KB' },
  { dim: 'data', factor: 1e6, names: 'megabyte|ميغابايت|ميجابايت|ميغا بايت', abbreviations: 'MB' },
  { dim: 'data', factor: 1e9, names: 'gigabyte|غيغابايت|جيجابايت|جيجا بايت', abbreviations: 'GB' },
  { dim: 'data', factor: 1e12, names: 'terabyte|تيرابايت|تيرا بايت', abbreviations: 'TB' },
  { dim: 'data', factor: 1e3 / 8, names: 'kilobit|كيلوبت|كيلو بت', abbreviations: 'kb|Kb' },
  { dim: 'data', factor: 1e6 / 8, names: 'megabit|ميغابت|ميجابت', abbreviations: 'Mb' },
  { dim: 'data', factor: 1e9 / 8, names: 'gigabit|غيغابت|جيجابت', abbreviations: 'Gb' },
  { dim: 'data', factor: 2 ** 10, names: 'kibibyte|كيبيبايت', abbreviations: 'KiB' },
  { dim: 'data', factor: 2 ** 20, names: 'mebibyte|ميبيبايت', abbreviations: 'MiB' },
  { dim: 'data', factor: 2 ** 30, names: 'gibibyte|جيبيبايت', abbreviations: 'GiB' },
  { dim: 'data', factor: 2 ** 40, names: 'tebibyte|تيبيبايت', abbreviations: 'TiB' },
  { dim: 'duration', factor: 1, names: 'sec|second|ثانية|ثانيه|ثوان', pluralNames: 'ثوان' },
  { dim: 'duration', factor: 60, names: 'min|minute|دقيقة|دقيقه|دقائق', pluralNames: 'دقائق' },
  { dim: 'duration', factor: 3600, names: 'h|hr|hour|ساعة|ساعه|ساعات', pluralNames: 'ساعات' },
];

function unit(raw: string) {
  const label = raw.trim().replace(/^(?:degrees?\s+|درج(?:ة|ه|ات)\s+)/iu, '');
  const words = label.toLowerCase().replace(/\s+/gu, ' ');
  const singular = words.replace(/\b([a-z]{2,})s\b/gu, '$1');
  const arabicUninflected = words.replace(/^ال(?=\p{Script=Arabic})/u, '').replace(/(?<=\p{Script=Arabic})ا(?=\s|$)/gu, '');
  return UNITS.find(item => {
    if (item.abbreviations?.split('|').includes(label)) return true;
    const names = `${item.names}|${item.pluralNames ?? ''}`.split('|');
    return names.includes(words) || names.includes(singular) || names.includes(arabicUninflected);
  });
}

const FRACTION_COUNTS = new Map([
  'a|an|one|واحد|واحدة', 'two|اثنان|اثنين|اثنتان|اثنتين', 'three|ثلاثة|ثلاث', 'four|اربعة|اربع',
  'five|خمسة|خمس', 'six|ستة|ست', 'seven|سبعة|سبع', 'eight|ثمانية|ثماني|ثمان',
  'nine|تسعة|تسع', 'ten|عشرة|عشر',
].flatMap((aliases, index) => aliases.split('|').map(alias => [alias, index + 1] as const)));

type FractionWord = { denominator: number; implicitCount: number | null };
const FRACTION_WORDS = new Map<string, FractionWord>();
for (const [index, [english, englishPlural, arabic, arabicPlural]] of [
  ['half', 'halves', 'نصف|نص', 'انصاف'], ['third', 'thirds', 'ثلث', 'اثلاث'],
  ['quarter', 'quarters', 'ربع', 'ارباع'], ['fifth', 'fifths', 'خمس', 'اخماس'],
  ['sixth', 'sixths', 'سدس', 'اسداس'], ['seventh', 'sevenths', 'سبع', 'اسباع'],
  ['eighth', 'eighths', 'ثمن', 'اثمان'], ['ninth', 'ninths', 'تسع', 'اتساع'],
  ['tenth', 'tenths', 'عشر', 'اعشار'],
].entries()) {
  const denominator = index + 2;
  for (const word of [english, ...arabic.split('|')]) FRACTION_WORDS.set(word, { denominator, implicitCount: 1 });
  for (const word of [englishPlural, ...arabicPlural.split('|')]) FRACTION_WORDS.set(word, { denominator, implicitCount: null });
  for (const word of arabic.split('|')) {
    for (const suffix of ['ان', 'ين', 'ي']) FRACTION_WORDS.set(`${word}${suffix}`, { denominator, implicitCount: 2 });
  }
}

const SPOKEN_FRACTION = String.raw`(?:(?:${[...FRACTION_COUNTS.keys()].join('|')}|\d+)\s+)?(?:${[...FRACTION_WORDS.keys()].join('|')})(?![\p{L}\p{N}])`;
const SPOKEN_CARDINAL = String.raw`(?:${[...FRACTION_COUNTS.keys()].join('|')})(?![\p{L}\p{N}])`;
const NUMERIC_FRACTION = String.raw`${NUMBER}\s*/\s*${NUMBER}`;
const CONVERSION = new RegExp(String.raw`(?:^|[\s:،])(${SPOKEN_FRACTION}|${SPOKEN_CARDINAL}|${NUMERIC_FRACTION}|${NUMBER})\s*(.+?)(?:[\s,،;؛:]+(?:to|into|in|الي|ب)[\s,،;؛:]+|\s*(?:→|⇒|->)\s*)(.+)$`, 'iu');
const unitLabel = (raw: string) => raw.trim().replace(/^[,،;؛:.]+|[,،;؛:.]+$/gu, '').trim().replace(/^\(\s*([^()]+?)\s*\)$/u, '$1');

function unitQuantity(raw: string, original: string, rawUnit: string): { value: number; fraction: boolean } | null {
  const slash = raw.indexOf('/');
  if (slash >= 0) {
    const numerator = safeNumber(Number(raw.slice(0, slash)));
    const denominator = safeNumber(Number(raw.slice(slash + 1)));
    if (denominator === 0) throw new CalculationError('division');
    return { value: safeNumber(numerator / denominator), fraction: true };
  }

  const words = raw.toLowerCase().split(/\s+/u);
  // These unmarked Arabic forms collide with cardinals (and, in the dual,
  // decades). Retain the source vowel or require clear plural-unit grammar.
  const ambiguous = /^(خمس|سبع|تسع|عشر)(ان|ين|ي)?$/u.exec(raw);
  if (ambiguous) {
    const initialMarks = /^[\p{L}][\p{M}]*/u.exec(original.trim().replace(/[\u0640\p{Cf}]/gu, ''))?.[0] ?? '';
    if (!initialMarks.includes('\u064f')) {
      const cardinal = ambiguous[2] ? ambiguous[2] === 'ين' && initialMarks.includes('\u064e')
        ? new Map([['خمس', 50], ['سبع', 70], ['تسع', 90], ['عشر', 20]]).get(ambiguous[1]!) : undefined
        : FRACTION_COUNTS.get(ambiguous[1]!);
      const label = unitLabel(rawUnit).replace(/^ال(?=\p{Script=Arabic})/u, '');
      const plural = unit(label)?.pluralNames?.split('|').includes(label) ?? false;
      if (cardinal !== undefined && (initialMarks.includes('\u064e') || !ambiguous[2] && plural)) return { value: cardinal, fraction: false };
      throw new CalculationError('quantity');
    }
  }
  const word = FRACTION_WORDS.get(words.at(-1)!);
  if (!word) {
    const cardinal = FRACTION_COUNTS.get(raw.toLowerCase());
    return { value: safeNumber(cardinal ?? Number(raw)), fraction: false };
  }
  const count = words.length === 1 ? word.implicitCount : FRACTION_COUNTS.get(words[0]) ?? Number(words[0]);
  if (count === null || !Number.isSafeInteger(count) || words.length > 1 && word.implicitCount === 2) return null;
  return { value: count / word.denominator, fraction: true };
}

function conversion(input: string, frame: Frame, requested: boolean, source: PreparedComputationSource): LocalReply | null {
  const phrase = CONVERSION.exec(input);
  if (!phrase) return null;
  const [, sourceNumber, rawSource, rawTarget] = phrase;
  const numberStart = phrase.index + phrase[0].indexOf(sourceNumber);
  const originalNumber = source.span(numberStart, numberStart + sourceNumber.length);
  const quantity = unitQuantity(sourceNumber, source.original.slice(originalNumber.start, originalNumber.end), rawSource);
  if (!quantity) return null;
  const sourceLabel = unitLabel(quantity.fraction ? rawSource.replace(/^\s*(?:of\s+)?(?:an?|the)\s+/iu, '') : rawSource);
  const targetLabel = unitLabel(rawTarget);
  const from = unit(sourceLabel);
  const target = unit(targetLabel);
  if (!from || !target) {
    if (requested) throw new CalculationError('units');
    return null;
  }
  if (from.dim !== target.dim) throw new CalculationError('units');
  const base = quantity.value * from.factor + (from.offset ?? 0);
  if (from.dim === 'temperature' && base < 0) throw new CalculationError('range');
  const result = formatNumber(safeNumber((base - (target.offset ?? 0)) / target.factor));
  return calculated(frame, result, `${sourceNumber} ${sourceLabel} = ${result} ${targetLabel}`);
}

const MONTHS = [
  'january|jan|يناير|كانون الثاني', 'february|feb|فبراير|شباط', 'march|mar|مارس|اذار',
  'april|apr|ابريل|نيسان', 'may|مايو|ايار', 'june|jun|يونيو|حزيران',
  'july|jul|يوليو|تموز', 'august|aug|اغسطس|اب', 'september|sept|sep|سبتمبر|ايلول',
  'october|oct|اكتوبر|تشرين الاول', 'november|nov|نوفمبر|تشرين الثاني', 'december|dec|ديسمبر|كانون الاول',
];
const monthAliases = MONTHS.join('|');
const namedDates = new RegExp(String.raw`(?<!\p{L})و?(?:(\d{1,2})(?:st|nd|rd|th)?\s+(${monthAliases})|(${monthAliases})\s+(\d{1,2})(?:st|nd|rd|th)?)(?![\p{L}\d])(?:[ ,،]+(\d{4})(?!\d))?`, 'giu');

function calendarDate(year: number, month: number, day: number) {
  const value = new Date(0);
  value.setUTCFullYear(year, month, day);
  if (year < 1 || value.getUTCFullYear() !== year || value.getUTCMonth() !== month || value.getUTCDate() !== day) throw new CalculationError('date');
  return value;
}

const iso = (value: Date) => value.toISOString().split('T')[0];
type DateParts = { date: Date; index: number; implicitYear?: boolean };
function datesIn(input: string, currentYear: number): DateParts[] {
  const dates: DateParts[] = [...input.matchAll(/(?<!\d)(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?!\d)/gu)].map(match => ({ date: calendarDate(Number(match[1]), Number(match[2]) - 1, Number(match[3])), index: match.index }));
  for (const match of input.matchAll(namedDates)) {
    const name = (match[2] || match[3]).toLowerCase();
    const month = MONTHS.findIndex(aliases => aliases.split('|').includes(name));
    dates.push({ date: calendarDate(match[5] ? Number(match[5]) : currentYear, month, Number(match[1] || match[4])), index: match.index, implicitYear: !match[5] });
  }
  return dates.sort((a, b) => a.index - b.index);
}

function dayRange(frame: Frame, input: string, left: Date, right: Date): LocalReply {
  const weeks = /\bweeks?\b|(?:اسبوع|اسابيع)(?!\p{L})/iu.test(input);
  const amount = Math.abs(right.getTime() - left.getTime()) / DAY_MS;
  const value = formatNumber(weeks ? amount / 7 : amount);
  const unitName = frame.lang === 'ar' ? weeks ? 'أسبوع' : 'يوم' : weeks ? 'weeks' : 'days';
  const line = frame.lang === 'ar' ? `من ${iso(left)} إلى ${iso(right)} = ${value} ${unitName}` : `From ${iso(left)} to ${iso(right)} = ${value} ${unitName}`;
  return calculated(frame, value, line);
}

function dateCalculation(frame: Frame, input: string, now: Date, kind: ComputationKind): LocalReply | null {
  const dates = datesIn(input, now.getUTCFullYear());
  const first = dates[0];
  if (!first) return null;
  if (kind === 'weekday') {
    const day = new Intl.DateTimeFormat(frame.lang, { timeZone: 'UTC', weekday: 'long' }).format(first.date);
    return calculated(frame, day, `${iso(first.date)} = ${day}`);
  }

  if (kind === 'date_range' && dates.length === 2) {
    if (first.date > dates[1].date && (first.implicitYear || dates[1].implicitYear)) throw new CalculationError('date_year');
    return dayRange(frame, input, first.date, dates[1].date);
  }

  const shift = /(?<![\d/-])([+-]?\d+)\s*(days?|weeks?|months?|years?|ايام|يوما?|اسابيع|اسبوعا?|شهور|اشهر|شهرا?|سنوات|سنة|عاما?)(?!\p{L})/iu.exec(input);
  if (kind === 'date_shift' && shift) {
    const count = safeNumber(Number(shift[1])) * (/\b(?:before|subtract|earlier)\b|(?:اطرح|قبل)/iu.test(input) ? -1 : 1);
    const units = shift[2].toLowerCase();
    const original = first.date;
    const result = new Date(original);
    if (/^(?:month|year|اشهر|شهور|شهر|سن|عام)/iu.test(units)) {
      const months = count * (/^(?:year|سن|عام)/iu.test(units) ? 12 : 1);
      result.setUTCMonth(result.getUTCMonth() + months + 1, 0);
      result.setUTCDate(Math.min(original.getUTCDate(), result.getUTCDate()));
    } else {
      const days = count * (/^(?:week|اسبوع|اسابيع)/iu.test(units) ? 7 : 1);
      result.setUTCDate(result.getUTCDate() + days);
    }
    if (!Number.isFinite(result.getTime()) || result.getUTCFullYear() < 1) throw new CalculationError('date');
    return calculated(frame, iso(result), `${iso(original)} ${count < 0 ? '−' : '+'} ${Math.abs(count)} ${units} = ${iso(result)}`);
  }

  if (kind === 'date_distance') {
    const today = calendarDate(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const since = /\bsince\b|منذ/iu.test(input);
    const next = first.implicitYear && first.date < today && !since
      ? calendarDate(today.getUTCFullYear() + 1, first.date.getUTCMonth(), first.date.getUTCDate()) : first.date;
    if (since && next > today || !since && next < today) throw new CalculationError('date_direction');
    return since ? dayRange(frame, input, next, today) : dayRange(frame, input, today, next);
  }
  return null;
}

const ZONES: Record<string, string> = {
  'new york': 'America/New_York', 'نيويورك': 'America/New_York', 'نيو يورك': 'America/New_York',
  'los angeles': 'America/Los_Angeles', 'لوس انجلوس': 'America/Los_Angeles',
  'london': 'Europe/London', 'لندن': 'Europe/London', 'paris': 'Europe/Paris', 'باريس': 'Europe/Paris',
  'cairo': 'Africa/Cairo', 'القاهرة': 'Africa/Cairo', 'القاهره': 'Africa/Cairo', 'riyadh': 'Asia/Riyadh', 'الرياض': 'Asia/Riyadh',
  'dubai': 'Asia/Dubai', 'دبي': 'Asia/Dubai', 'baghdad': 'Asia/Baghdad', 'بغداد': 'Asia/Baghdad', 'دمشق': 'Asia/Damascus',
  'tokyo': 'Asia/Tokyo', 'طوكيو': 'Asia/Tokyo', 'sydney': 'Australia/Sydney', 'سيدني': 'Australia/Sydney',
  'kolkata': 'Asia/Kolkata', 'كولكاتا': 'Asia/Kolkata', 'berlin': 'Europe/Berlin', 'برلين': 'Europe/Berlin',
};
const zonePattern = new RegExp(String.raw`(?<![\p{L}_/])(?:[a-z_]+(?:/[a-z0-9_+-]+)+|(?:UTC|GMT)(?:\s*[+-]\s*\d{1,2}(?::?\d{2})?)?|${Object.keys(ZONES).join('|')})(?![\p{L}_/])`, 'giu');
type Zone = { label: string; parts(date: Date): readonly [number, number, number, number, number] };
function zoneFor(label: string): Zone {
  const canonical = ZONES[label.toLowerCase()] ?? label.replace(/\s+/gu, '');
  const offset = /^(?:UTC|GMT)(?:([+-])(\d{1,2})(?::?(\d{2}))?)?$/iu.exec(canonical);
  if (offset) {
    const hours = Number(offset[2] ?? 0);
    const minutes = Number(offset[3] ?? 0);
    if (hours > 23 || minutes > 59) throw new CalculationError('timezone');
    const milliseconds = (hours * 60 + minutes) * MINUTE_MS * (offset[1] === '-' ? -1 : 1);
    return { label, parts(date) {
      const local = new Date(date.getTime() + milliseconds);
      return [local.getUTCFullYear(), local.getUTCMonth() + 1, local.getUTCDate(), local.getUTCHours(), local.getUTCMinutes()];
    } };
  }
  let clock: Intl.DateTimeFormat;
  try {
    clock = new Intl.DateTimeFormat('en-GB', { timeZone: canonical, calendar: 'gregory', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
  } catch {
    throw new CalculationError('timezone');
  }
  return { label, parts(date) {
    const parts = Object.fromEntries(clock.formatToParts(date).map(part => [part.type, Number(part.value)]));
    return [parts.year, parts.month, parts.day, parts.hour, parts.minute];
  } };
}

function zoneCalculation(frame: Frame, input: string, now: Date): LocalReply | null {
  if (!/\b(?:time|utc|gmt|time zone|a\.?m\.?|p\.?m\.?)\b|(?:الساعة|الساعه|الوقت|توقيت)|\d:\d/iu.test(input)) return null;
  const matches = [...input.matchAll(zonePattern)];
  if (!matches.length || matches.length > 2) return null;

  const finalZone = zoneFor(matches.at(-1)![0]);
  const clock = /(?<![\d:+-])(\d{1,2}):(\d{2})(?:\s*([ap])\.?m\.?)?(?![\d:])/iu.exec(input)
    ?? /(?<![\d:+-])(\d{1,2})\s*()([ap])\.?m\.?(?!\p{L})/iu.exec(input);
  let instant = now;
  let source: Zone | undefined;
  const hour = clock && Number(clock[1]);
  const minute = clock && Number(clock[2]);
  if (clock && hour !== null && minute !== null) {
    if (matches.length !== 2 || hour > 23 || minute > 59 || (clock[3] && (hour < 1 || hour > 12))) throw new CalculationError('timezone');
    source = zoneFor(matches[0][0]);
    const [year, month, day] = source.parts(now);
    const date = datesIn(input, year)[0]?.date ?? calendarDate(year, month - 1, day);
    date.setUTCHours(clock[3] ? hour % 12 + (clock[3].toLowerCase() === 'p' ? 12 : 0) : hour, minute);
    const expected = date.getTime();

    // A local wall time can be missing or repeated when a daylight-saving offset changes.
    const localOrigin = new Set<number>();
    for (const probeTime of [expected - DAY_MS, expected, expected + DAY_MS]) {
      const [y, m, d, h, min] = source.parts(new Date(probeTime));
      const wall = calendarDate(y, m - 1, d);
      wall.setUTCHours(h, min);
      const candidate = new Date(expected + (probeTime - wall.getTime()));
      const [actualYear, actualMonth, actualDay, actualHour, actualMinute] = source.parts(candidate);
      const candidateWall = calendarDate(actualYear, actualMonth - 1, actualDay);
      candidateWall.setUTCHours(actualHour, actualMinute);
      if (expected === candidateWall.getTime()) localOrigin.add(candidate.getTime());
    }
    if (localOrigin.size !== 1) throw new CalculationError('timezone');
    instant = new Date([...localOrigin][0]);
  } else if (matches.length !== 1 || !/\b(?:time|now)\b|(?:الساعة|الساعه|الوقت|الان)/iu.test(input)) return null;

  const [year, month, day, hours, minutes] = finalZone.parts(instant);
  const hhmm = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  const line = `${source && clock ? `${clock[0].trim()} ${source.label} = ` : ''}${hhmm} ${finalZone.label} (${iso(calendarDate(year, month - 1, day))})`;
  return calculated(frame, hhmm, line);
}

const CURRENCIES = /\b(?:currency|exchange rate|USD|EUR|GBP|AED|SAR|JPY|INR|CAD|AUD|CHF|EGP|dollars?|euros?|sterling|yen|rupees?|riyals?|dirhams?)\b|[$€£¥]|(?:دولار|يورو|استرليني|عملة|عمله|سعر الصرف|درهم|ريال|ليرة|ليره|جنيه)/iu;

// Grammar envelopes consume a whole supported question. Operand extraction below
// does not itself prove that unrelated instructions/prefixes were understood.
const DATE_OPERAND = String.raw`(?:\d{4}[-/]\d{1,2}[-/]\d{1,2}|(?:(?:\d{1,2})(?:st|nd|rd|th)?\s+(?:${monthAliases})|(?:${monthAliases})\s+\d{1,2}(?:st|nd|rd|th)?)(?:[ ,،]+\d{4})?)`;
const SHIFT_UNITS = String.raw`(?:days?|weeks?|months?|years?|ايام|يوما?|اسابيع|اسبوعا?|شهور|اشهر|شهرا?|سنوات|سن[ةه]|عاما?)`;
const SHIFT_COUNT = String.raw`[+-]?\d+\s*${SHIFT_UNITS}`;
const ZONE_OPERAND = String.raw`(?:[a-z_]+(?:/[a-z0-9_+-]+)+|(?:UTC|GMT)(?:\s*[+-]\s*\d{1,2}(?::?\d{2})?)?|${Object.keys(ZONES).sort((a, b) => b.length - a.length).join('|')})`;
const CLOCK_OPERAND = String.raw`(?:\d{1,2}:\d{2}(?:\s*[ap]\.?m\.?)?|\d{1,2}\s*[ap]\.?m\.?)`;
const ENVELOPE = (body: string) => new RegExp(String.raw`^(?:${body})(?=$|[^\p{L}\p{N}_])`, 'iu');
const DATE_ENVELOPES: readonly (readonly [ComputationKind, RegExp])[] = [
  ['weekday', ENVELOPE(String.raw`(?:what (?:day of the week|weekday|day)(?: (?:is|was|will be))?|which (?:weekday|day of the week)(?: (?:is|was|will be))?|ما (?:اليوم الموافق|يوم الاسبوع|اليوم الذي يصادف)|اي يوم(?: من الاسبوع)?(?: (?:كان|يصادف|يوافق))?)\s+${DATE_OPERAND}`)],
  ['date_range', ENVELOPE(String.raw`(?:(?:how many|number of) (?:days|weeks)(?: are there)? (?:between|from)|(?:calculate|compute) (?:the )?(?:days|weeks|difference) (?:between|from)|كم (?:يوما?|اسبوعا?) (?:بين|من)|(?:احسب )?(?:فرق الايام|فرق التاريخين|الفارق بين التاريخين)(?: بين| من)?)\s+${DATE_OPERAND}\s*(?:and|to|until|و|الي|الى|حتي|حتى)\s*${DATE_OPERAND}`)],
  ['date_shift', ENVELOPE(String.raw`(?:(?:add|subtract|اضف|اطرح|زود)\s+${SHIFT_COUNT}\s+(?:to|from|الي|الى|من|علي|على)\s+${DATE_OPERAND}|(?:what (?:date|day)(?: (?:is|will it be))?|(?:ما|اي) (?:التاريخ|تاريخ|يوم)(?: (?:يكون|يصادف))?)\s+${SHIFT_COUNT}\s+(?:after|before|بعد|قبل)\s+${DATE_OPERAND}|(?:ما|اي) (?:التاريخ|تاريخ|يوم)\s+(?:بعد|قبل)\s+${SHIFT_COUNT}\s+(?:من\s+)?${DATE_OPERAND}|${SHIFT_COUNT}\s+(?:after|before|بعد|قبل)\s+${DATE_OPERAND})`)],
  ['date_distance', ENVELOPE(String.raw`(?:(?:how many|number of) (?:days|weeks)(?: are (?:left|remaining))? (?:until|since)|(?:days|weeks) (?:until|since)|كم (?:يوما?|اسبوعا?) (?:حتي|حتى|منذ)|(?:كم )?(?:يوما?|ايام|اسبوعا?|اسابيع) (?:باقي[ةه]?|متبقي[ةه]?)(?: حتي| حتى)?)\s+${DATE_OPERAND}`)],
];
const CLOCK_ENVELOPES: readonly (readonly [ComputationKind, RegExp])[] = [
  ['clock_now', ENVELOPE(String.raw`(?:what time is it|what(?:'|’)s the (?:current |local )?time|what is the (?:current |local )?time|(?:كم|ما) (?:الساعة|الساعه|الوقت|التوقيت))(?: (?:now|الان))?\s+(?:in|at|في|ب)\s*${ZONE_OPERAND}(?: (?:now|الان))?`)],
  ['clock_conversion', ENVELOPE(String.raw`(?:(?:convert|حول)[\s:،]+${CLOCK_OPERAND}\s+(?:(?:from|من)\s+)?${ZONE_OPERAND}\s+(?:to|into|in|الي|الى)\s+${ZONE_OPERAND}|(?:at\s+)?${CLOCK_OPERAND}\s+(?:in\s+)?${ZONE_OPERAND}[,،]?\s+(?:what time is it|what (?:is|will be) the time)\s+(?:in|at)\s+${ZONE_OPERAND})(?:\s+(?:on|في|بتاريخ)\s+${DATE_OPERAND})?`)],
];

function inspectPreparedComputation(source: PreparedComputationSource): ComputationConsumption {
  if (!source.valid || source.literal) return finishComputationConsumption(source, 'unsupported');
  const calendar = inspectHijri(source); if (calendar) return calendar;
  // NFKC intentionally folds unit m²/m³ aliases, but raised/lowered numeric
  // positions are not baseline digits. Never flatten them into another sum,
  // date, clock or quantity; subscripts do not denote square/cubic units.
  if (/[\u2080-\u209f]/u.test(source.original)) return finishComputationConsumption(source, 'unsupported');
  const raised = /[¹²³\u2070-\u207f]/u.test(source.original);
  for (const [kind, pattern] of [...CLOCK_ENVELOPES, ...DATE_ENVELOPES]) {
    const match = pattern.exec(source.input);
    if (match) return raised ? finishComputationConsumption(source, 'unsupported') : finishComputationConsumption(source, kind, { start: 0, end: match[0].length });
  }
  if (arithmeticExpression(source.input) !== null) return raised ? finishComputationConsumption(source, 'unsupported') : finishComputationConsumption(source, 'arithmetic', { start: 0, end: source.input.length });
  const intro = /^(?:(?:convert|conversion|حول|تحويل)[\s:،]+)/iu.exec(source.input);
  const offset = intro?.[0].length ?? 0;
  const phrase = CONVERSION.exec(source.input.slice(offset));
  if (phrase && phrase.index === 0) {
    const number = phrase[1]!;
    const originalQuantity = source.span(offset + phrase[0].indexOf(number), offset + phrase[0].indexOf(number) + number.length);
    if (/[¹²³\u2070-\u207f]/u.test(source.original.slice(originalQuantity.start, originalQuantity.end))) return finishComputationConsumption(source, 'unsupported');
    const targetText = phrase[3]!;
    const targetStart = source.input.length - targetText.length;
    // A known target followed by extra text proves a remainder. Unknown units
    // can still receive an honest units boundary, never a completed result.
    if (!unit(unitLabel(targetText))) {
      let longestUnitEnd = 0;
      for (const boundary of targetText.matchAll(/\s|[,،;؛:]/gu)) {
        if (unit(unitLabel(targetText.slice(0, boundary.index)))) longestUnitEnd = boundary.index;
      }
      if (longestUnitEnd) return finishComputationConsumption(source, 'conversion', { start: 0, end: targetStart + longestUnitEnd });
    }
    return finishComputationConsumption(source, 'conversion', { start: 0, end: source.input.length });
  }
  return finishComputationConsumption(source, 'unsupported');
}

/** Matching diagnostics only; exact source ranges do not grant any action. */
export function inspectComputationRequest(original: string): ComputationConsumption {
  return inspectPreparedComputation(prepareComputationSource(original, SHORT_ANSWER_TAIL));
}

export interface ComputedReply extends LocalReply { consumption: ComputationConsumption }

export function compute(frame: Frame, now: Date, options: { originalText?: string } = {}): ComputedReply | null {
  const source = prepareComputationSource(options.originalText ?? frame.text, SHORT_ANSWER_TAIL);
  const calendar = computeHijri(source, frame.lang, now); if (calendar) return calendar;
  const consumption = inspectPreparedComputation(source);
  if (!consumption.complete || !Number.isFinite(now.getTime())) return null;
  const { input, valueOnly } = source;
  const display = valueOnly && !frame.valueOnly ? { ...frame, valueOnly: true } : frame;
  const covered = (reply: LocalReply): ComputedReply => ({ ...reply, consumption });
  const conversionRequest = /\b(?:convert|conversion|exchange rate)\b|(?:حول|تحويل|يساوي كم|سعر الصرف)/iu.test(input);
  if (CURRENCIES.test(input) && (conversionRequest || /\b(?:to|into|in)\b|(?:الي|→|⇒|->)/iu.test(input))) return null;
  try {
    const zoned = consumption.kind === 'clock_now' || consumption.kind === 'clock_conversion' ? zoneCalculation(display, input, now) : null;
    if (zoned) return covered(zoned);
    if (['date_range', 'date_shift', 'weekday', 'date_distance'].includes(consumption.kind)) {
      const dated = dateCalculation(display, input, now, consumption.kind);
      if (dated) return covered(dated);
    }
    const operation = consumption.kind === 'arithmetic' ? arithmetic(input) : null;
    if (operation) {
      const value = formatNumber(operation.value);
      return covered(calculated(display, value, `${operation.expression} = ${value}`));
    }
    const converted = consumption.kind === 'conversion' ? conversion(input, display, conversionRequest, source) : null;
    return converted ? covered(converted) : conversionRequest ? covered(fixedReply(MESSAGES.units[frame.lang], 'blocked')) : null;
  } catch (error) {
    if (error instanceof CalculationError) return covered(fixedReply(MESSAGES[error.kind][frame.lang], 'blocked'));
    throw error;
  }
}
