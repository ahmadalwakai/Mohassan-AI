import { matchText } from '../mind/normalize.js';
import type { PlanValue } from './types.js';

type ScalarOperation = 'multiply' | 'divide' | 'subtract' | 'discount' | 'scale';
type Measurement = 'price' | 'count' | 'volume' | 'length' | 'mass';
export type SourceComputation =
  | { kind: ScalarOperation; amount: number; measurement?: Measurement; unit?: string }
  | { kind: 'change'; amount: number; quantity: number; currency: string };

const CARDINALS: ReadonlyMap<string, number> = new Map([
  ['zero', 'صفر'], ['one', 'واحد', 'واحده'], ['two', 'اثنان', 'اثنين', 'اثنتان', 'اثنتين', 'اتنين'],
  ['three', 'ثلاث', 'ثلاثه', 'تلات', 'تلاته'], ['four', 'اربع', 'اربعه'], ['five', 'خمس', 'خمسه'],
  ['six', 'ست', 'سته'], ['seven', 'سبع', 'سبعه'], ['eight', 'ثمان', 'ثمانيه', 'تمانيه'],
  ['nine', 'تسع', 'تسعه'], ['ten', 'عشر', 'عشره'], ['eleven'], ['twelve'], ['thirteen'], ['fourteen'],
  ['fifteen'], ['sixteen'], ['seventeen'], ['eighteen'], ['nineteen'], ['twenty'],
].flatMap((words, value) => words.map(word => [word, value] as const)));

const DECIMAL = String.raw`(?:\d{1,3}(?:[,٬]\d{3})+|\d+)(?:[.٫]\d+)?`;
const QUANTITY = String.raw`(?:${DECIMAL}|${[...CARDINALS.keys()].join('|')})`;
const WORD = String.raw`[\p{L}][\p{L}\p{M}’'-]*`;
const NOUN = String.raw`${WORD}(?:\s+${WORD}){0,3}?`;
const METRIC_EN = String.raw`(?:price|cost|fee|fare|charge|amount|volume|capacity|total|sum|weight|length|distance|number(?:\s+of\s+${NOUN})?|how\s+many\s+${NOUN}|المجموع|الاجمالي|الناتج)`;
const METRIC_AR = String.raw`(?:ال)?(?:سعر|تكلفه|ثمن|تمن|اجره|رسوم|مبلغ|قيمه|حق|حجم|سعه|عدد|وزن|طول|مسافه|مجموع|اجمالي|كم|قديش|شقد|شكد|كام)`;
const UNIT = String.raw`(?:km|m|cm|l|ml|kg|g|kilomet(?:er|re)s?|met(?:er|re)s?|centimet(?:er|re)s?|lit(?:er|re)s?|millilit(?:er|re)s?|kilograms?|grams?|كيلومتر(?:ات)?|متر|امتار|سنتيمتر(?:ات)?|لتر(?:ات)?|مليلتر|كيلوغرام(?:ات)?|غرام(?:ات)?)`;
const EN_CALC = String.raw`(?:(?:calculate|compute|work\s+out)\s+|(?:give|show)\s+me\s+)?`;
const STOP_NOUN = /\b(?:and|or|except|without|before|after|instead|then|from|for|over|each|per|in)\b|(?<!\p{L})(?:او|لكن|عدا|غير|بدون|قبل|بعد|ثم|بعدين|لكل|علي|من|في|الى)(?!\p{L})/u;
const SCALE_EN = new RegExp(String.raw`^(?:calculate|compute|work\s+out|(?:give|show)(?:\s+me)?)\s+(?:the\s+)?(?<metric>${METRIC_EN})\s+(?:for|of|in|across)\s+(?<amount>${QUANTITY})\s+(?<items>${NOUN})(?:\s+in\s+(?<unit>${UNIT}))?$`, 'u');
const SCALE_AR = new RegExp(String.raw`^(?:احسب|اعطني|اعطيني|عطني|طلع)\s+(?<metric>${METRIC_AR})\s+(?:(?<subject>${NOUN})\s+(?:في\s+|من\s+|ل\s*|ب\s*))?(?<amount>${QUANTITY})(?:\s+(?<items>${NOUN}))?(?:\s+(?:في\s+|ب(?:ال)?)?(?<unit>${UNIT}))?$`, 'u');
const CHANGE_EN = new RegExp(String.raw`^${EN_CALC}(?:the\s+)?(?:change|money\s+left)\s+(?:from|out\s+of)\s+(?<currency>US\$|USD\s+|GBP\s+|EUR\s+|[£€$])\s*(?<amount>${DECIMAL})\s+(?:for|after\s+(?:buying|paying\s+for))\s+(?<quantity>${QUANTITY})\s+(?<items>${NOUN})$`, 'iu');
const CHANGE_AR = new RegExp(String.raw`^(?:احسب|اعطني|عطني)\s+(?:الباقي|المتبقي)\s+من\s+(?<amount>${DECIMAL})\s+(?<currency>يورو|جنيه\s+استرليني|دولار\s+امريكي)\s+بعد\s+(?:شراء|دفع\s+ثمن)\s+(?<quantity>${QUANTITY})\s+(?<items>${NOUN})$`, 'u');
const DISCOUNT = new RegExp(String.raw`^(?:(?:apply\s+(?:a\s+)?|take\s+|subtract\s+|discount\s+by\s+|(?:اخصم|خصم|انقص|خفض)\s+))(?<amount>${DECIMAL})\s*(?:%|٪|percent|per\s+cent|بالم(?:ا?ئ|ي)ه)(?:\s+(?:discount|off(?:\s+it)?|from\s+(?:it|(?:the\s+)?(?:price|total))|منه|منها|من\s+(?:السعر|المبلغ|القيمه)))?(?:\s+(?:and\s+(?:show|report|give\s+me)\s+(?:the\s+)?(?:new|remaining|discounted)\s+(?:amount|price|total)|و\s*(?:اعطني|اعطيني|عطني|اظهر|اذكر)\s+(?:السعر|المبلغ|النتيجه)(?:\s+بعد\s+الخصم)?))?$`, 'u');
const SUBTRACT = new RegExp(String.raw`^(?:subtract|اطرح)\s+(?<amount>${QUANTITY})(?:\s+(?<items>${NOUN}))?\s+(?:from|من)\s+(?:(?:a|one|a\s+single|the\s+original)\s+(?<base>${NOUN})|it|(?:the\s+)?(?:total|amount|result)|الناتج|المجموع|القيمه)$`, 'u');
const SOURCE_SUBJECT = String.raw`(?:it|that|(?:the\s+)?(?:result|number|total|amount|value|figure|price|cost|capacity|volume|length|height|width|weight)|(?:ال)?(?:ناتج|نتيجه|مجموع|قيمه|عدد|سعر|سعه|حجم|طول|ارتفاع|عرض|وزن|مسافه|ثمن))`;
const PURPOSE = String.raw`(?:\s+(?:to\s+(?:get|calculate|find|determine)\s+(?:the\s+)?(?:total|number|amount|result)(?:\s+of\s+(?<purposeSubject>${NOUN}))?(?:\s+for\s+(?<purposeQuantity>${QUANTITY})\s+(?<purposeItems>${NOUN}))?|ل(?:تحدد|تحسب|تجد)\s+(?:الاجمالي|المجموع|الناتج)))?`;
const MULTIPLY = new RegExp(String.raw`^(?:(?:multiply|اضرب)\s+(?<metric>${SOURCE_SUBJECT})\s+(?:by|في)|اضرب(?:ه|ها)\s+في)\s+(?<amount>${QUANTITY})${PURPOSE}$`, 'u');
const DIVIDE = new RegExp(String.raw`^(?:(?:divide|اقسم)\s+(?<metric>${SOURCE_SUBJECT})\s+(?:by|علي)|اقسم(?:ه|ها)\s+علي)\s+(?<amount>${QUANTITY})${PURPOSE}$`, 'u');
const CURRENCY_CODES = new Map([['£', 'GBP'], ['€', 'EUR'], ['US$', 'USD'],
  ['جنيه استرليني', 'GBP'], ['يورو', 'EUR'], ['دولار امريكي', 'USD']]);
const TIME_UNITS: ReadonlyMap<string, string> = new Map([['ساعه', 'ساعات'], ['ساعات', 'ساعات'],
  ['دقيقه', 'دقائق'], ['دقايق', 'دقائق'], ['دقائق', 'دقائق'], ['ثانيه', 'ثوان'], ['ثوان', 'ثوان'], ['ثواني', 'ثوان']]);
const TIME_UNIT = [...TIME_UNITS.keys()].join('|');
const SPOKEN_CONVERSION = new RegExp(String.raw`^حول\s+(?<amount>${DECIMAL})\s+(?<from>${TIME_UNIT})\s+(?:ل(?:ل)?\s*|الي\s+(?:ال)?)(?<to>${TIME_UNIT})[.!?؟]*$`, 'u');
const ISO_CURRENCIES = new Set(Intl.supportedValuesOf('currency'));
const OPERATIONS = [
  ['discount', DISCOUNT], ['subtract', SUBTRACT], ['multiply', MULTIPLY], ['divide', DIVIDE],
  ['scale', SCALE_EN], ['scale', SCALE_AR],
] as const;

function measurementForMetric(metric: string): Measurement | undefined {
  if (/^(?:the\s+)?(?:price|cost|fee|fare|charge)|^(?:ال)?(?:سعر|تكلفه|ثمن|تمن|اجره|رسوم|حق)/u.test(metric)) return 'price';
  if (/^(?:the\s+)?volume|^(?:ال)?حجم/u.test(metric)) return 'volume';
  if (/^(?:the\s+)?(?:length|distance|width|height)|^(?:ال)?(?:طول|مسافه|عرض|ارتفاع)/u.test(metric)) return 'length';
  if (/^(?:the\s+)?weight|^(?:ال)?وزن/u.test(metric)) return 'mass';
  if (/^(?:the\s+)?(?:number of|how many)|^(?:ال)?عدد/u.test(metric)) return 'count';
  return undefined;
}

function measurementForUnit(unit: string): Measurement | undefined {
  const normalized = matchText(unit).split('/')[0]!;
  if (ISO_CURRENCIES.has(normalized.toUpperCase()) || /^(?:[$€£]|جنيه|دينار|ريال|دولار|يورو)$/u.test(normalized)) return 'price';
  if (/^(?:l|ml|lit(?:er|re)s?|millilit(?:er|re)s?|لتر(?:ات)?|مليلتر)$/u.test(normalized)) return 'volume';
  if (/^(?:km|m|cm|mm|mi|ft|kilomet(?:er|re)s?|met(?:er|re)s?|centimet(?:er|re)s?|feet|foot|mile(?:s)?|كيلومتر(?:ات)?|متر|امتار|سنتيمتر(?:ات)?)$/u.test(normalized)) return 'length';
  if (/^(?:kg|g|lb|lbs|kilograms?|grams?|كيلوغرام(?:ات)?|غرام(?:ات)?)$/u.test(normalized)) return 'mass';
  if (/^(?:people|persons?|items?|units?|اشخاص|نسخ)$/u.test(normalized)) return 'count';
  return undefined;
}

function quantity(text: string): number {
  return CARDINALS.get(text) ?? Number(text.replace(/[,٬]/gu, '').replace('٫', '.'));
}

/** Recognize arithmetic whose missing operand may come from a preceding numeric source. */
export function parseSourceComputation(text: string): SourceComputation | null {
  if (text.length > 320) return null;
  const request = matchText(text).trim().replace(/^(?:please|kindly|من فضلك|لو سمحت)[,،:\s]+/u, '').replace(/[.!?؟]+$/u, '');
  const change = (CHANGE_EN.exec(request) ?? CHANGE_AR.exec(request))?.groups;
  if (change && !STOP_NOUN.test(change.items)) {
    const token = change.currency.trim().replace(/\s+/gu, ' ').toUpperCase();
    const amount = quantity(change.amount);
    const units = quantity(change.quantity);
    if (!Number.isFinite(amount) || !Number.isFinite(units)) return null;
    return { kind: 'change', currency: CURRENCY_CODES.get(token) ?? token, amount, quantity: units };
  }
  for (const [kind, pattern] of OPERATIONS) {
    const match = pattern.exec(request)?.groups;
    if (!match || [match.items, match.subject, match.base, match.purposeSubject, match.purposeItems]
      .some(phrase => phrase && STOP_NOUN.test(phrase))) continue;
    const amount = quantity(match.amount);
    if (!Number.isFinite(amount) || (kind === 'discount' && amount > 100)) return null;
    if (match.purposeQuantity && quantity(match.purposeQuantity) !== amount) return null;
    const subtrahend = kind === 'subtract' && match.items ? measurementForUnit(match.items) : undefined;
    if (subtrahend && subtrahend !== 'count') return null;
    const measurement = match.metric ? measurementForMetric(match.metric) : kind === 'subtract' && match.items ? 'count' : undefined;
    return { kind, amount, ...(measurement ? { measurement } : {}), ...(match.unit ? { unit: match.unit } : {}) };
  }
  return null;
}

export function sourceComputationExpression(operation: SourceComputation, source: Extract<PlanValue, { type: 'number' }>): string | null {
  const value = source.value;
  if (!Number.isFinite(value)) return null;
  if (operation.kind !== 'change' && operation.measurement) {
    const actual = source.unit ? measurementForUnit(source.unit) : 'count';
    if (actual !== operation.measurement) return null;
  }
  const { amount } = operation;
  switch (operation.kind) {
    case 'change':
      return source.unit === operation.currency && value >= 0 ? `${amount} - (${value} * ${operation.quantity})` : null;
    case 'discount':
      return value >= 0 ? `${value} * (1 - ${amount} / 100)` : null;
    case 'scale':
      return value >= 0 && !source.unit?.includes('/') ? `${value} * ${amount}` : null;
    case 'multiply': return `${value} * ${amount}`;
    case 'divide': return `${value} / ${amount}`;
    case 'subtract': return `${value} - ${amount}`;
  }
}

/** Normalize colloquial unit spellings only inside a complete conversion command. */
export function normalizePlanConversion(text: string): string | null {
  const conversion = SPOKEN_CONVERSION.exec(matchText(text).trim())?.groups;
  if (!conversion) return null;
  return `حول ${conversion.amount} ${TIME_UNITS.get(conversion.from)} إلى ${TIME_UNITS.get(conversion.to)}`;
}
