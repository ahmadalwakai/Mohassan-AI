const NUMBER = String.raw`[+−-]?[0-9]+(?:[,.٬٫][0-9]+)*`;
const FIGURE = new RegExp(String.raw`(?<![\p{L}\p{N}.,٬٫])(${NUMBER})(?![.,٬٫]\d)(?=$|[^\p{L}\p{N}]|(?:km|m|mi|ft)\b)`, 'giu');
const CURRENCY = String.raw`(?:US\$|[$€£]|USD|EUR|GBP|(?:U\.S\.|US) dollars?|dollars?|euros?|pounds sterling|دولار(?:ا|ات|ًا)?(?: (?:أمريكي|امريكي))?|يورو|جنيه إسترليني)`;
const PRICE = new RegExp(String.raw`(?<!\p{L})(?:(?<before>${CURRENCY})\s*(?<left>${NUMBER})|(?<right>${NUMBER})\s*(?<after>${CURRENCY}))(?![\p{L}\p{N}])`, 'giu');
const PRICE_REQUEST = /\b(?:price|prices|cost|fee|fare|rate)\b|(?:سعر|أسعار|اسعار|تكلفة|تكلفه|رسوم)/iu;
const RANGE_START = new RegExp(String.raw`${NUMBER}\s*(?:[-–—]|\bto|إلى|الى)\s*$`, 'iu');
const SCALE: ReadonlyArray<readonly [RegExp, number]> = [
  [/^\s*(?:billion\b|مليار)/iu, 1e9],
  [/^\s*(?:million\b|مليون|ملايين)/iu, 1e6],
  [/^\s*(?:thousand\b|ألف|الف|آلاف|الاف)/iu, 1e3],
];
const MEASURES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^\s*(?:km\b|kilomet(?:er|re)s?\b|كيلومتر|كم\b)/iu, 'km'],
  [/^\s*(?:m\b|met(?:er|re)s?\b|متر)/iu, 'm'],
  [/^\s*(?:mi\b|miles?\b|ميل)/iu, 'mi'],
  [/^\s*(?:ft\b|feet\b|foot\b|قدم)/iu, 'ft'],
  [/^\s*(?:people\b|inhabitants?\b|residents?\b|نسمة|نسمه)/iu, 'people'],
  [/^\s*[%٪]/u, '%'],
];
const MASS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(?:\bper\s+|\/\s*)(?:kg\b|kilograms?\b)|(?:للكيلوغرام|للكيلو[غج]رام|لكل كيلو[غج]رام)/iu, 'kg'],
  [/(?:\bper\s+|\/\s*)(?:g\b|grams?\b)|(?:لل[غج]رام|لكل [غج]رام)/iu, 'g'],
  [/\bper\s+troy\s+ounces?\b|\/\s*(?:troy\s+oz|ozt)\b|(?:للأونصة الترويسية|لكل أونصة تروي)/iu, 'ozt'],
  [/\bper\s+ounces?\b|\/\s*oz\b|(?:للأونصة|للأوقية|لكل (?:أونصة|أوقية))(?!\s+(?:الترويسية|تروي))/iu, 'oz'],
];

function digits(value: string): string {
  return value.replace(/[٠-٩۰-۹]/gu, digit => String(digit.charCodeAt(0) & 15)).replace(/−/gu, '-');
}

function parseFigure(value: string): number {
  if (/^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/u.test(value)) return Number(value.replace(/,/gu, ''));
  return Number(value.replace(/٬/gu, '').replace(/[٫,]/gu, '.'));
}

function currencyCode(value: string, line: string): string {
  if (/^€$|eur|يورو/iu.test(value)) return 'EUR';
  if (/^£$|gbp|sterling|إسترليني/iu.test(value)) return 'GBP';
  if (/^US\$|\bUSD\b|\b(?:U\.S\.|US) dollars?\b|(?:أمريكي|امريكي)/iu.test(value) || /\bUSD\b/u.test(line)) return 'USD';
  return '$';
}

export interface WebFigure { value: number; unit?: string }

/** Require one unambiguous figure in a quote, with an explicit currency for prices. */
export function webFigure(question: string, quote: string): WebFigure | null {
  const line = digits(quote);
  if (PRICE_REQUEST.test(question)) {
    const prices = [...line.matchAll(PRICE)];
    if (prices.length !== 1) return null;
    const price = prices[0]!;
    if (RANGE_START.test(line.slice(0, price.index))) return null;
    const value = parseFigure(price.groups?.left ?? price.groups?.right ?? '');
    const currency = currencyCode(price.groups?.before ?? price.groups?.after ?? '', line);
    const after = line.slice(price.index + price[0].length).trimStart();
    const mass = MASS.filter(([pattern]) => pattern.test(after.slice(0, 48)));
    if (!Number.isFinite(value) || value <= 0 || mass.length > 1) return null;
    return { value, unit: mass.length ? `${currency}/${mass[0]![1]}` : currency };
  }

  const figures = [...line.matchAll(FIGURE)];
  const dated = /\b(?:year|when)\b|(?<!\p{L})(?:سنة|سنه|عام|متى)(?!\p{L})/iu.test(question);
  const candidates = figures.length > 1 && !dated
    ? figures.filter(match => !/^(?:1[89]|20)\d\d$/u.test(match[1]!))
    : figures;
  if (candidates.length !== 1) return null;
  const figure = candidates[0]!;
  const next = line.slice(figure.index! + figure[0].length);
  const scale = SCALE.find(([pattern]) => pattern.test(next));
  const value = parseFigure(figure[1]!) * (scale?.[1] ?? 1);
  const measured = scale ? next.replace(scale[0], '') : next;
  const unit = MEASURES.find(([pattern]) => pattern.test(measured))?.[1];
  return Number.isFinite(value) ? { value, ...(unit ? { unit } : {}) } : null;
}
