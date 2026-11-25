import { publicSearchText } from '@mohassan/browser';
import { analyzeCompoundRequest } from '../compound-request.js';
import type { Evidence } from '../mind/contract.js';
import { isPageInstruction } from '../mind/extract.js';
import { matchText, stripCourtesyTail } from '../mind/normalize.js';
import { assessRequestScope } from '../request-scope.js';

const digits = '[0-9٠-٩۰-۹]';
export const comparisonDigits = String.raw`[+−-]?(?:${digits}{1,3}(?:[,،٬]${digits}{3})+|${digits}+)(?:[.٫]${digits}+)?`;
export const comparisonQualifiedObservation = /\b(?:about|approximate(?:ly)?|around|roughly|estimat(?:e|ed)|supposedly|possibly|maybe|rumou?red|disputed|at least|at most|up to|could|would|might|if|not|never)\b|(?<!\p{L})(?:تقريبا|حوالي|نحو|المقدر|تقديري(?:ه)?|ربما|قد|ممكن|على الاقل|على الاكثر|اذا|لو|لم)(?!\p{L})/u;
const decimalPattern = new RegExp(`^${comparisonDigits}$`, 'u');
const displayedNumber = new Intl.NumberFormat('en', { useGrouping: false, maximumSignificantDigits: 15 });
const additionalAction = /(?:^|[\s,،;؛])(?:(?:and|then)\s+(?:buy|purchase|reserve|rent|book|subscribe|pay|order(?!\s+(?:by|from))|click|tap|press|type|scroll|go back|read|search)|(?:ثم\s+|و\s*)(?:اشتر|احجز|استاجر|اشترك|ادفع|اضغط|انقر|اكتب|مرر|اقرا|ابحث))(?!\p{L})/u;

export function isStandaloneComparisonQuestion(question: string): boolean {
  return !additionalAction.test(matchText(question)) && analyzeCompoundRequest(question).kind === 'single';
}

export function comparisonDecimal(text: string): string | undefined {
  if (!decimalPattern.test(text)) return undefined;
  const decimal = matchText(text).replace(/[,،٬]/gu, '').replace('٫', '.').replace('−', '-');
  const amount = Number(decimal);
  const precision = decimal.replace(/\D/gu, '').replace(/^0+/u, '').length;
  if (!Number.isFinite(amount) || Math.abs(amount) > Number.MAX_SAFE_INTEGER || precision > 15 || amount === 0 && /[1-9]/u.test(decimal)) return undefined;
  return decimal;
}

export function comparisonNumber(text: string): number | undefined {
  const decimal = comparisonDecimal(text);
  return decimal === undefined ? undefined : Number(decimal);
}

export function formatComparisonNumber(value: number): string {
  return displayedNumber.format(value);
}

export function comparisonTurn(text: string): { statements: string[]; question: string } | null {
  const original = stripCourtesyTail(text.trim());
  if (original.length > 4000 || /https?:|www\.|[<>`\p{Cf}]/iu.test(original) || publicSearchText(original) !== original) return null;
  const chunks = original.split(/(?:[.!?؟](?=\s)|\r?\n)[ \t]*|[;,؛،]\s+(?=(?:which|who|what|ايهما|اي|انهي|مين|وش|شنو|ايش)\s)/iu)
    .map(part => part.trim()).filter(Boolean);
  const question = chunks.pop()?.replace(/[.!?؟]+$/u, '').trim();
  if (!question || !chunks.length || chunks.length > 32 || !isStandaloneComparisonQuestion(question) || chunks.some(containsComparisonAction)) return null;
  return { statements: chunks, question };
}

export function containsComparisonAction(text: string): boolean {
  if (isPageInstruction(text)) return true;
  const scope = assessRequestScope(text);
  return scope.operation === 'act' || scope.operation === 'transform'
    || scope.reasons.includes('explicit_public_lookup') || scope.source === 'local_state';
}

export function comparisonOptionEvidence(quotes: readonly string[]): Evidence[] {
  return quotes.map((quote, index) => ({ id: `comparison-input-${index + 1}`, source: 'computed', quote }));
}

const currencyNames: Readonly<Record<string, string>> = {
  '$': '$', '€': 'EUR', '£': 'GBP',
  usd: 'USD', dollar: '$', dollars: '$', 'us dollar': 'USD', 'us dollars': 'USD',
  eur: 'EUR', euro: 'EUR', euros: 'EUR', يورو: 'EUR',
  gbp: 'GBP', 'pound sterling': 'GBP', 'pounds sterling': 'GBP', pound: 'pound', pounds: 'pound',
  sar: 'SAR', riyal: 'riyal', riyals: 'riyal', ريال: 'riyal', ريالا: 'riyal', ريالات: 'riyal',
  egp: 'EGP', جنيه: 'جنيه', جنيها: 'جنيه', جنيهات: 'جنيه',
  aed: 'AED', dirham: 'dirham', dirhams: 'dirham', درهم: 'dirham', درهما: 'dirham', دراهم: 'dirham',
  دينار: 'dinar', دينارا: 'dinar', دنانير: 'dinar', dinar: 'dinar', dinars: 'dinar',
  دولار: '$', دولارا: '$', دولارات: '$',
};
const currencySuffix = Object.keys(currencyNames).filter(key => !/^[$€£]$/u.test(key))
  .sort((a, b) => b.length - a.length)
  .map(key => [...key].map(char => char === ' ' ? '\\s+' : /^[\p{Script=Arabic}]$/u.test(char) ? `${char === 'ه' ? '[هة]' : char}\\p{M}*` : char).join(''))
  .join('|');
const money = new RegExp(
  String.raw`(?<![\p{L}\p{M}\p{Nd}])(?:([$€£])\s*(${comparisonDigits})|(?:ب[ـ]*\s*)?(${comparisonDigits})\s*([$€£]|${currencySuffix}))(?![\p{L}\p{M}\p{Nd}])`, 'giu',
);

export function comparisonMoney(text: string): {
  amount: number; decimal: string; currency: string; unit: string; index: number; raw: string;
}[] {
  return [...text.matchAll(money)].flatMap(match => {
    const decimal = comparisonDecimal(match[2] ?? match[3]);
    const unit = match[1] ?? match[4];
    const currency = currencyNames[matchText(unit).replace(/\s+/gu, ' ')];
    if (decimal === undefined || !currency) return [];
    return [{ amount: Number(decimal), decimal, currency, unit, index: match.index, raw: match[0] }];
  });
}
