import { matchText, normalizeRequest, stripCourtesyTail } from '../mind/normalize.js';
import type { Lang } from '../mind/contract.js';
import { reasoned, reasoningGap, type ReasoningResult } from './result.js';

const englishSmall = 'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split(' ');
const englishTens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const arabicUnits = 'صفر واحد اثنان ثلاثة أربعة خمسة ستة سبعة ثمانية تسعة'.split(' ');
const arabicSmall = [...arabicUnits, 'عشرة', 'أحد عشر', 'اثنا عشر', 'ثلاثة عشر', 'أربعة عشر', 'خمسة عشر', 'ستة عشر', 'سبعة عشر', 'ثمانية عشر', 'تسعة عشر'];
const arabicTens = ['', '', 'عشرون', 'ثلاثون', 'أربعون', 'خمسون', 'ستون', 'سبعون', 'ثمانون', 'تسعون'];
const arabicHundreds = ['', 'مائة', 'مائتان', 'ثلاثمائة', 'أربعمائة', 'خمسمائة', 'ستمائة', 'سبعمائة', 'ثمانمائة', 'تسعمائة'];
const arabicUnitAliases = [
  'صفر زيرو', 'واحد واحدة احد احدى', 'اثنان اثنين اثنا اثني اثنتان اثنتين اثنتا اثنتي اتنين تنتين تنين ثنتين ثنين',
  'ثلاثة ثلاث تلاتة تلات', 'أربعة أربع اربعه', 'خمسة خمس', 'ستة ست', 'سبعة سبع', 'ثمانية ثماني ثمان تمانية تمان', 'تسعة تسع',
];
const arabicTeenAliases = [
  'عشرة عشر', 'حداشر احدعشر حداش', 'اتناشر اثناشر اتناش', 'تلاتاشر ثلاثطعش تلتعش', 'اربعتاشر اربطعش اربعطعش',
  'خمستاشر خمسطعش', 'ستاشر ستطعش', 'سبعتاشر سبعطعش', 'تمنتاشر ثمانطعش تمانطعش', 'تسعتاشر تسعطعش',
];

interface Scale {
  value: bigint;
  en: string;
  ar: string;
  dual: string;
  plural: string;
  alternateDual: string;
}

const scales: readonly Scale[] = [
  { value: 1_000n, en: 'thousand', ar: 'ألف', dual: 'ألفان', plural: 'آلاف', alternateDual: 'ألفين' },
  { value: 1_000_000n, en: 'million', ar: 'مليون', dual: 'مليونان', plural: 'ملايين', alternateDual: 'مليونين' },
  { value: 1_000_000_000n, en: 'billion', ar: 'مليار', dual: 'ملياران', plural: 'مليارات', alternateDual: 'مليارين' },
  { value: 1_000_000_000_000n, en: 'trillion', ar: 'تريليون', dual: 'تريليونان', plural: 'تريليونات', alternateDual: 'تريليونين' },
];
const limit = 1_000_000_000_000_000n;
const maxPrecision = 15;

function entries(words: readonly string[]): Map<string, number> {
  return new Map(words.flatMap((row, value) => row.split(' ').filter(Boolean).map(word => [matchText(word), value] as const)));
}

const enSmall = entries(englishSmall);
const enTens = entries(englishTens);
const arUnits = entries(arabicUnitAliases);
const arTeens = new Map(arabicTeenAliases.flatMap((row, offset) => row.split(' ').map(word => [matchText(word), offset + 10] as const)));
const arTens = entries(arabicTens.map(word => word ? `${word} ${word.slice(0, -2)}ين` : ''));
const arHundreds = entries(arabicHundreds.map(word => word
  ? `${word} ${word.replace('مائ', 'مئ')} ${word.replace('مائة', 'مية')}` : ''));
for (const [word, value] of entries(['', 'ماية', 'مائتين مئتين مائتا مئتا ميتين ميتان', 'تلتمية تلاتمية', 'اربعمية', 'خمسميه', 'ستمية', 'سبعمية', 'تمنمية تمانمية', 'تسعمية'])) {
  arHundreds.set(word, value);
}

function englishBelowHundred(tokens: readonly string[]): number | null {
  if (tokens.length === 1) return enSmall.get(tokens[0]) ?? (enTens.has(tokens[0]) ? enTens.get(tokens[0])! * 10 : null);
  if (tokens.length !== 2) return null;
  const tens = enTens.get(tokens[0]);
  const unit = enSmall.get(tokens[1]);
  return tens !== undefined && unit !== undefined && unit > 0 && unit < 10 ? tens * 10 + unit : null;
}

function englishTriple(tokens: readonly string[]): number | null {
  if (tokens[1] !== 'hundred') return englishBelowHundred(tokens);
  const hundreds = tokens[0] === 'a' ? 1 : enSmall.get(tokens[0]);
  if (!hundreds || hundreds > 9) return null;
  if (tokens.length === 2) return hundreds * 100;
  const remainder = englishBelowHundred(tokens.slice(tokens[2] === 'and' ? 3 : 2));
  return remainder ? hundreds * 100 + remainder : null;
}

function arabicBelowHundred(tokens: readonly string[]): number | null {
  if (tokens.length === 1) return arUnits.get(tokens[0]) ?? arTeens.get(tokens[0])
    ?? (arTens.has(tokens[0]) ? arTens.get(tokens[0])! * 10 : null);
  const unit = arUnits.get(tokens[0]);
  if (!unit) return null;
  if (tokens.length === 2 && /^(?:عشر|عشره)$/u.test(tokens[1])) return unit + 10;
  if (tokens.length !== 3 || tokens[1] !== 'و') return null;
  const tens = arTens.get(tokens[2]);
  return tens === undefined ? null : tens * 10 + unit;
}

function arabicTriple(tokens: readonly string[]): number | null {
  let parts = 1;
  let hundreds = arHundreds.get(tokens[0]);
  if (hundreds === undefined && /^(?:مايه|ميه|مائه|مئه)$/u.test(tokens[1] ?? '')) {
    hundreds = arUnits.get(tokens[0]);
    parts = 2;
  }
  if (hundreds === undefined) return arabicBelowHundred(tokens);
  if (hundreds < 1) return null;
  if (tokens.length === parts) return hundreds * 100;
  if (tokens[parts] !== 'و') return null;
  const remainder = arabicBelowHundred(tokens.slice(parts + 1));
  return remainder ? hundreds * 100 + remainder : null;
}

const enScales = new Map(scales.map(scale => [scale.en, scale.value]));
const arScales = new Map<string, { value: bigint; implicit?: number }>(scales.flatMap(scale => [
  [matchText(scale.ar), { value: scale.value, implicit: 1 }],
  [matchText(scale.plural), { value: scale.value }],
  [matchText(scale.dual), { value: scale.value, implicit: 2 }],
  [matchText(scale.alternateDual), { value: scale.value, implicit: 2 }],
] as const));

function tokensFor(text: string, lang: Lang): string[] {
  const split = text.trim().split(lang === 'en' ? /\s+|(?<=\p{L})-(?=\p{L})/u : /\s+/u);
  if (lang === 'en') return split;
  return split.flatMap((token, index) => {
    // Letter folding makes «وأحد عشر» begin with the same token as «واحد».
    const eleven = token === 'واحد' && index > 0 && split[index - 1] !== 'و' && split[index + 1] === 'عشر';
    return eleven || token.startsWith('و') && token.length > 1 && !arUnits.has(token) ? ['و', token.slice(1)] : [token];
  });
}

function parseInteger(text: string, lang: Lang): bigint | null {
  const tokens = tokensFor(text, lang);
  const en = lang === 'en';
  const group = en ? englishTriple : arabicTriple;
  const conjunction = en ? 'and' : 'و';
  let from = 0;
  let lastScale = limit;
  let total = 0n;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const arabicScale = en ? undefined : arScales.get(token);
    const scale = en ? enScales.get(token) : arabicScale?.value;
    if (!scale) continue;
    if (scale >= lastScale) return null;
    const coefficient = tokens.slice(from, i);
    if (total && coefficient[0] === conjunction) coefficient.shift();
    const implicit = arabicScale?.implicit;
    let count = group(coefficient);
    if (en && coefficient.length === 1 && coefficient[0] === 'a') count = 1;
    if (!coefficient.length) count = implicit ?? null;
    if (!count || (implicit === 2 && coefficient.length)) return null;
    total += BigInt(count) * scale;
    lastScale = scale;
    from = i + 1;
  }
  if (from === tokens.length) return total;
  const remaining = tokens.slice(from);
  if (total && remaining[0] === conjunction) remaining.shift();
  const remainder = group(remaining);
  if (remainder === null || (total && remainder === 0)) return null;
  return total + BigInt(remainder);
}

const englishFraction = /^(.*?)(?:\s+and\s+|^)(?:(?:a|one)\s+)?(half|quarter)(?:\s+(?:of\s+(?:a|one)\s+)?(thousand|million|billion|trillion))?$/u;
const arabicFraction = /^(.*?)(?:\s+و\s*|^)(نصف|نص|ربع)(?:\s+(?:من\s+)?(الف|مليون|مليار|تريليون))?$/u;

function parseFraction(text: string, lang: Lang): string | null {
  const match = (lang === 'en' ? englishFraction : arabicFraction).exec(text);
  if (!match) return null;
  const [, whole, fraction, suffix] = match;
  const integer = whole ? parseInteger(whole, lang) : 0n;
  if (integer === null || (suffix && integer >= 1000n)) return null;
  const previous = whole ? tokensFor(whole, lang).at(-1) : undefined;
  const englishScale = (word: string) => enScales.get(word);
  const arabicScale = (word: string) => arScales.get(word)?.value;
  const scaleOf = lang === 'en' ? englishScale : arabicScale;
  const scale = (suffix ? scaleOf(suffix) : previous && scaleOf(previous)) || 1n;
  const denominator = fraction === 'quarter' || fraction === 'ربع' ? 4n : 2n;
  const hundredths = (suffix ? integer * scale : integer) * 100n + scale * 100n / denominator;
  if (hundredths / 100n >= limit) return null;
  const decimal = String(hundredths % 100n).padStart(2, '0').replace(/0+$/u, '');
  return `${hundredths / 100n}${decimal ? `.${decimal}` : ''}`;
}

/** Accepts one complete numeral phrase and returns its exact ASCII decimal representation. */
export function parseNumberWords(text: string, lang: Lang): string | null {
  let input = matchText(text).trim();
  if (!input || input.length > 350) return null;
  const negative = /^(?:negative|minus|سالب|ناقص)\s+/u.exec(input);
  if (negative) input = input.slice(negative[0].length);
  const signed = (value: string) => negative && /[1-9]/u.test(value) ? `-${value}` : value;
  const parts = input.split(lang === 'en' ? /\s+point\s+/u : /\s+فاصله\s+/u);
  if (parts.length === 2) {
    const whole = parseInteger(parts[0], lang);
    const tokens = tokensFor(parts[1], lang);
    const digits = tokens.map(word => (lang === 'en' ? enSmall : arUnits).get(word));
    if (whole === null || digits.length > maxPrecision || digits.some(digit => digit === undefined || digit > 9)) return null;
    return signed(`${whole}.${digits.join('')}`);
  }
  const whole = parseInteger(input, lang);
  if (whole !== null) return signed(String(whole));
  const fraction = parseFraction(input, lang);
  return fraction === null ? null : signed(fraction);
}

function spellTriple(value: number, lang: Lang): string {
  const hundreds = Math.floor(value / 100);
  const rest = value % 100;
  const tens = Math.floor(rest / 10);
  const unit = rest % 10;
  if (lang === 'en') {
    const low = rest < 20 ? englishSmall[rest] : [englishTens[tens], unit ? englishSmall[unit] : ''].filter(Boolean).join('-');
    return [hundreds ? `${englishSmall[hundreds]} hundred` : '', rest || !hundreds ? low : ''].filter(Boolean).join(' ');
  }
  const low = rest < 20 ? arabicSmall[rest] : [unit ? arabicUnits[unit] : '', arabicTens[tens]].filter(Boolean).join(' و');
  return [arabicHundreds[hundreds], rest || !hundreds ? low : ''].filter(Boolean).join(' و');
}

function spellInteger(value: bigint, lang: Lang): string {
  const words: string[] = [];
  for (const scale of [...scales].reverse()) {
    const count = Number(value / scale.value);
    if (!count) continue;
    value %= scale.value;
    if (lang === 'en') words.push(`${spellTriple(count, lang)} ${scale.en}`);
    else if (count === 1) words.push(scale.ar);
    else if (count === 2) words.push(scale.dual);
    else if (count === 200) words.push(`مائتا ${scale.ar}`);
    else words.push(`${spellTriple(count, lang)} ${count % 100 >= 3 && count % 100 <= 10 ? scale.plural : scale.ar}`);
  }
  if (value || !words.length) words.push(spellTriple(Number(value), lang));
  return words.join(lang === 'en' ? ' ' : ' و');
}

/** Spell an exact decimal with optional thousands separators and either Arabic digit set. */
export function formatNumberWords(text: string, lang: Lang): string | null {
  const input = matchText(text).trim();
  const parsed = /^([+−-]?)(\d+|\d{1,3}(?<separator>[,٬، ])\d{3}(?:\k<separator>\d{3})*)(?:[.٫](\d+))?$/u.exec(input);
  if (!parsed) return null;
  const [, sign, grouped, , decimal] = parsed;
  const raw = grouped.replace(/[,٬، ]/gu, '').replace(/^0+(?=\d)/u, '');
  if (raw.length >= String(limit).length || (decimal?.length ?? 0) > maxPrecision) return null;
  const prefix = (sign === '-' || sign === '−') && /[1-9]/u.test(raw + (decimal ?? '')) ? lang === 'en' ? 'minus ' : 'سالب ' : '';
  const digitWords = lang === 'en' ? englishSmall : arabicUnits;
  const ending = decimal ? `${lang === 'en' ? ' point ' : ' فاصلة '}${[...decimal].map(digit => digitWords[Number(digit)]).join(' ')}` : '';
  return `${prefix}${spellInteger(BigInt(raw), lang)}${ending}`;
}

const englishOutput = /^(?:(?:how (?:do|would) (?:you|i) |can you )?(?:write|spell|read|say|convert)\s+|what is\s+)(?:the number\s+)?(.+?)\s+(?:in|into|as|to)\s+(?:(english|arabic)\s+)?(words|digits|numbers|figures)$/u;
const englishOutputFirst = /^(?:(?:write|spell|read|convert)\s+)?(?:in|to|as)\s+(?:(english|arabic)\s+)?(words|digits|numbers|figures)\s*[:،,]\s*(.+)$/u;
const arabicOutput = /^(?:(?:(?:كيف|ازاي|شلون|كيفاش)\s+)?(?:اكتب(?:لي|ها|ه)?|تكتب|اقرا|حول|قول|قل)\s+|(?:كم|شو|وش)\s+)(?:(?:العدد|الرقم|عدد|رقم)\s+)?(.+?)\s+(?:الي\s+)?(بالكلمات|بالحروف|بالاحرف|كتابه|بالارقام|للارقام|رقما|رقميا|كلمات|حروف|ارقام)(?:\s+(بالانجليزي(?:ه)?|بالعربي(?:ه)?))?$/u;
const arabicOutputFirst = /^(?:(?:اكتب|اقرا|حول)\s+)?(بالكلمات|بالحروف|بالاحرف|بالارقام)\s*[:،,]\s*(.+)$/u;
const explicitRead = /^(?:spell|read(?: the number)?|اقرا(?: العدد| الرقم)?)\s+([+−-]?\d[\d,،٬٫. ]*)$/u;

function unwrapOperand(text: string): string {
  const clean = text.trim().replace(/^:\s*/u, '');
  const quote = /^["'«“‘](.+?)["'»”’]$/u.exec(clean);
  return quote?.[1] ?? clean;
}

export function reasonNumberWords(text: string, lang: Lang): ReasoningResult | null {
  const normalized = normalizeRequest(stripCourtesyTail(text));
  const input = normalized.match.replace(/[\s?!؟.،]+$/gu, '');
  const en = englishOutput.exec(input);
  const enFirst = englishOutputFirst.exec(input);
  const ar = arabicOutput.exec(input);
  const arFirst = arabicOutputFirst.exec(input);
  if (!en && !enFirst && !ar && !arFirst) {
    const read = explicitRead.exec(input);
    const words = read && formatNumberWords(read[1], lang);
    if (words) return reasoned(lang, words, words);
    // A lone word like “one” can be an ordinary conversational reply.
    if (!/\s/u.test(input)) return null;
    const value = parseNumberWords(input, lang);
    return value === null ? null : reasoned(lang, value, value);
  }
  const operand = unwrapOperand((en?.[1] ?? enFirst?.[3] ?? ar?.[1] ?? arFirst?.[2])!);
  const format = (en?.[3] ?? enFirst?.[2] ?? ar?.[2] ?? arFirst?.[1])!;
  const language = en?.[2] ?? enFirst?.[1] ?? ar?.[3];
  const outputLang = language === 'english' || language?.startsWith('بالانجليزي') ? 'en'
    : language === 'arabic' || language?.startsWith('بالعربي') ? 'ar' : lang;
  const operandLang = /\p{Script=Arabic}/u.test(operand) ? 'ar' : 'en';
  const digits = /^(?:digits|numbers|figures|بالارقام|للارقام|رقما|رقميا|ارقام)$/u.test(format);
  const value = digits ? parseNumberWords(operand, operandLang)
    : formatNumberWords(operand, outputLang);
  return value === null ? reasoningGap(lang, lang === 'en'
    ? 'I need one number in the requested input format.'
    : 'أحتاج إلى عدد واحد بصيغة الإدخال المطلوبة.') : reasoned(outputLang, value, value);
}
