import { readFileSync, statSync } from 'node:fs';
import { matchText, normalizeRequest, stripCourtesyTail } from '../mind/normalize.js';
import { reasoned, reasoningGap, type ReasoningResult } from './result.js';

export interface ExchangeRateTable {
  asOf: string;
  source: string;
  base: string;
  /** Units of each currency per unit of base. The loader sets the base rate to 1. */
  rates: Readonly<Record<string, string>>;
}

const DEFAULT_TABLE_PATH = '.data/reasoning/exchange-rates.json';
const MAX_TABLE_BYTES = 64 * 1024;
const DECIMAL = /^\d{1,18}(?:\.\d{1,18})?$/u;
const codes = new Set(Intl.supportedValuesOf('currency'));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function parseExchangeRateTable(input: unknown): ExchangeRateTable {
  if (!isRecord(input)) throw new TypeError('Expected an exchange-rate table object.');
  const { asOf, source, base, rates } = input;
  if (!isDate(asOf) || typeof source !== 'string' || !source.trim() || source.length > 300 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(source)
    || typeof base !== 'string' || !codes.has(base) || !isRecord(rates)) {
    throw new TypeError('The rate table needs an ISO date, a source, a currency base and a rates object.');
  }
  const values: Record<string, string> = Object.create(null);
  values[base] = '1';
  for (const [code, raw] of Object.entries(rates)) {
    const rate = typeof raw === 'number' ? String(raw) : raw;
    if (!codes.has(code) || typeof rate !== 'string' || !DECIMAL.test(rate) || !/[1-9]/u.test(rate)
      || (code === base && !/^0*1(?:\.0+)?$/u.test(rate))) {
      throw new TypeError('Use supported currency codes and positive decimal rates. A base rate must equal 1.');
    }
    values[code] = rate;
  }
  if (Object.keys(values).length < 2) throw new TypeError('The table needs a rate for another currency.');
  return { asOf, source: source.trim(), base, rates: Object.freeze(values) };
}

export function loadExchangeRateTable(path: string | URL): ExchangeRateTable {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > MAX_TABLE_BYTES) throw new TypeError('The rate table must be a local JSON file up to 64 KiB.');
  const json = readFileSync(path, 'utf8');
  if (Buffer.byteLength(json) > MAX_TABLE_BYTES) throw new TypeError('The rate table exceeds 64 KiB.');
  return parseExchangeRateTable(JSON.parse(json));
}

function loadOwnerTable(): ExchangeRateTable | undefined {
  try {
    return loadExchangeRateTable(DEFAULT_TABLE_PATH);
  } catch {
    return undefined;
  }
}

const names = new Map<string, string>();
for (const [code, terms] of Object.entries({
  USD: ['dollar', 'dollars', 'us dollar', 'us dollars', 'american dollar', 'american dollars', 'دولار', 'دولارات', 'دولار أمريكي', 'الدولار الأمريكي', 'الدولار'],
  EUR: ['euro', 'euros', 'يورو', 'اليورو'],
  GBP: ['pound', 'pounds', 'pound sterling', 'pounds sterling', 'british pound', 'british pounds', 'sterling', 'جنيه إسترليني', 'الجنيه الإسترليني', 'إسترليني'],
  EGP: ['egyptian pound', 'egyptian pounds', 'جنيه مصري', 'الجنيه المصري'],
  SAR: ['saudi riyal', 'saudi riyals', 'ريال سعودي', 'الريال السعودي'],
  AED: ['uae dirham', 'uae dirhams', 'emirati dirham', 'emirati dirhams', 'درهم إماراتي', 'الدرهم الإماراتي'],
  JPY: ['yen', 'japanese yen', 'ين', 'الين', 'ين ياباني', 'الين الياباني'],
  KWD: ['kuwaiti dinar', 'kuwaiti dinars', 'دينار كويتي', 'الدينار الكويتي'],
  CAD: ['canadian dollar', 'canadian dollars', 'دولار كندي', 'الدولار الكندي'],
  AUD: ['australian dollar', 'australian dollars', 'دولار أسترالي', 'الدولار الأسترالي'],
  CHF: ['swiss franc', 'swiss francs', 'فرنك سويسري', 'الفرنك السويسري'],
  INR: ['indian rupee', 'indian rupees', 'روبية هندية', 'الروبية الهندية'],
})) for (const term of terms) names.set(matchText(term), code);

function currencyCode(term: string): string | undefined {
  const code = term.toUpperCase();
  return codes.has(code) ? code : names.get(term);
}

const AMOUNT = '[+−-]?(?:\\d{1,3}(?:,\\d{3})+|\\d{1,18})(?:\\.\\d{1,18})?';
const TERM = [
  ...names.keys(), ...[...codes].map(code => code.toLowerCase()),
].sort((left, right) => right.length - left.length).join('|');
const EN_QUERY = new RegExp(`^(?:(?:convert|exchange|how much is|what is|what's) )?(${AMOUNT}) ?(${TERM}) (?:to|into|in|for) (${TERM})$`, 'u');
const AR_QUERY = new RegExp(`^(?:(?:حول|تحويل|بدل|صرف|اصرف|كم|كام|قديش|قد ايه|كم يساوي|كم يسوي|كم يطلع)(?: مبلغ)? )?(?:من )?(${AMOUNT}) ?(${TERM}) (?:الي |مقابل |في |(?:كم|بكم|بكام|كام|قديش|قد ايه|يساوي|يسوي|يطلع|تساوي|تسوي) (?:ب|ل)?|[بل] ?)(${TERM})$`, 'u');
const RATE_QUERY = new RegExp(`^(?:(?:what is|what's|show me|كم) )?(?:the )?(?:exchange rate (?:from |for |between )?|سعر (?:الصرف |صرف )?)(${TERM}) (?:to |in |against |and |مقابل |الي |[بل] ?)(${TERM})$`, 'u');
const FRESHNESS_PHRASE = /\b(?:as of today|at (?:the )?(?:live|current|today['’]s) (?:exchange )?rate)\b/gu;
const FRESHNESS = /\b(?:live|today(?:'s)?|current(?:ly)?|right now|latest)\b|(?<!\p{L})(?:اليوم|النهارده|الحالي(?:ه)?|حاليا|الان|دلوقتي|الحين|هلق|مباشر)(?!\p{L})/gu;

function conversionRequest(text: string) {
  const normalized = stripCourtesyTail(normalizeRequest(text).match)
    .replace(/[‘’]/gu, "'").replace(/٬/gu, ',').replace(/٫/gu, '.').replace(/[.!?؟]+$/u, '').replace(/\s+/gu, ' ')
    .replace(/([$€£]) ?(\d[\d,.]*)|([$€£])/gu, (_, prefix: string | undefined, amount: string | undefined, suffix: string | undefined) => {
      const code = prefix === '$' || suffix === '$' ? 'usd' : prefix === '€' || suffix === '€' ? 'eur' : 'gbp';
      return amount ? `${amount} ${code}` : code;
    });
  const fresh = normalized.replace(FRESHNESS_PHRASE, '').replace(FRESHNESS, '').replace(/\s+/gu, ' ').trim();
  const explicit = EN_QUERY.exec(fresh) ?? AR_QUERY.exec(fresh);
  const rate = explicit ? null : RATE_QUERY.exec(fresh);
  const amount = explicit?.[1].replace(/,/gu, '').replace('−', '-') ?? '1';
  const from = explicit?.[2] ?? rate?.[1], to = explicit?.[3] ?? rate?.[2];
  if (!from || !to || !DECIMAL.test(amount.replace(/^[+-]/u, ''))) return null;
  const fromCode = currencyCode(from), toCode = currencyCode(to);
  return fromCode && toCode ? { amount, from: fromCode, to: toCode, live: fresh !== normalized.trim(), rate: Boolean(rate) } : null;
}

function fraction(decimal: string) {
  const [whole, part = ''] = decimal.split('.');
  return { units: BigInt(whole + part), factor: 10n ** BigInt(part.length) };
}

/** Exact cross-rate calculation with half-away-from-zero rounding. */
function convert(amount: string, fromRate: string, toRate: string, places: number): string {
  const input = fraction(amount);
  const from = fraction(fromRate);
  const to = fraction(toRate);
  const factor = 10n ** BigInt(places);
  const numerator = input.units * from.factor * to.units * factor;
  const denominator = input.factor * from.units * to.factor;
  const magnitude = numerator < 0n ? -numerator : numerator;
  const rounded = (2n * magnitude + denominator) / (2n * denominator);
  const whole = rounded / factor;
  const fractional = String(rounded % factor).padStart(places, '0').replace(/0+$/u, '');
  return `${numerator < 0n && rounded ? '-' : ''}${whole}${fractional ? `.${fractional}` : ''}`;
}

export function reasonCurrency(text: string, lang: 'ar' | 'en', table?: ExchangeRateTable): ReasoningResult | null {
  const request = conversionRequest(text);
  if (!request) return null;
  if (request.live) return reasoningGap(lang, lang === 'ar'
    ? 'أستطيع التحويل بسعر من جدول مؤرّخ فقط. السعر الحالي غير متاح في مسار الحساب المحلي.'
    : 'The local calculator uses dated snapshots. A current exchange rate is unavailable here.');
  const rates = table ?? loadOwnerTable();
  if (!rates) return reasoningGap(lang, lang === 'ar'
    ? 'تنقصني بيانات أسعار الصرف. أحتاج إلى جدول محلي فيه تاريخ ومصدر.'
    : 'I need an offline exchange-rate table with a date and source.');
  const { amount, from, to } = request;
  const fromRate = rates.rates[from], toRate = rates.rates[to];
  const provenance = lang === 'ar' ? `أسعار ${rates.asOf} من ${rates.source}` : `Rates dated ${rates.asOf} from ${rates.source}`;
  if (!fromRate || !toRate) {
    const missing = [...new Set([!fromRate ? from : '', !toRate ? to : ''].filter(Boolean))].join(', ');
    return reasoningGap(lang, lang === 'ar' ? `${provenance}. لا يوجد سعر لـ ${missing}.` : `${provenance}. The table has no rate for ${missing}.`);
  }
  const places = request.rate ? 12 : new Intl.NumberFormat('en', { style: 'currency', currency: to }).resolvedOptions().maximumFractionDigits ?? 2;
  const value = convert(amount, fromRate, toRate, places);
  const quote = `1 ${rates.base} = ${fromRate} ${from} · 1 ${rates.base} = ${toRate} ${to}`;
  const equation = `${amount} ${from} × (${toRate} ÷ ${fromRate}) ≈ ${value} ${to}`;
  return reasoned(lang, `${equation}\n${provenance}.`, value,
    [{ id: 'exchange-rate-snapshot', source: 'computed', title: rates.source, sourceRef: rates.source, pageDate: rates.asOf, quote }]);
}
