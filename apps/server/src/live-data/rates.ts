import type { ExchangeIntent } from '@mohassan/contracts';
import type { RequestScope } from './request.js';

// ECB reference-rate framework and daily feed, retrieved 2026-11-25.
// https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html
const ECB_XML = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
const ECB_NAMESPACE = 'http://www.ecb.int/vocabulary/2002-08-01/eurofxref';
const ECB_CACHE_MS = 15 * 60 * 1000;
const MAX_XML_LENGTH = 64 * 1024;
const DECIMAL = /^\d{1,18}(?:\.\d{1,18})?$/u;

interface ExchangeRateTable {
  asOf: string;
  source: string;
  base: 'EUR';
  /** Units of each quoted currency per EUR. */
  rates: Readonly<Record<string, string>>;
}

interface Peg {
  currencyUnits: string;
  dollarUnits: string;
  ar: string;
  en: string;
  source: string;
}

// Each parity is published by the issuing central bank. Sources retrieved 2026-11-25.
const PEGS: Readonly<Record<string, Peg | undefined>> = {
  AED: {
    currencyUnits: '3.6725', dollarUnits: '1',
    ar: 'مصرف الإمارات العربية المتحدة المركزي', en: 'Central Bank of the UAE',
    source: 'https://www.centralbank.ae/media/e44dkkze/cbuae-annual-report-2014-en.pdf',
  },
  BHD: {
    currencyUnits: '0.376', dollarUnits: '1',
    ar: 'مصرف البحرين المركزي', en: 'Central Bank of Bahrain',
    source: 'https://www.cbb.gov.bh/wp-content/uploads/2019/01/Economic-Report-2007-ENG.pdf',
  },
  OMR: {
    currencyUnits: '1', dollarUnits: '2.6008',
    ar: 'البنك المركزي العُماني', en: 'Central Bank of Oman',
    source: 'https://cbo.gov.om/Pages/FixedPeg.aspx',
  },
  QAR: {
    currencyUnits: '3.64', dollarUnits: '1',
    ar: 'مصرف قطر المركزي', en: 'Qatar Central Bank',
    source: 'https://www.qcb.gov.qa/en/Pages/MonetaryPolicyTools.aspx',
  },
  SAR: {
    currencyUnits: '3.75', dollarUnits: '1',
    ar: 'البنك المركزي السعودي', en: 'Saudi Central Bank',
    source: 'https://www.sama.gov.sa/en-US/MediaCenter/News/Pages/news-557.aspx',
  },
};

export function parseEcbRates(xml: string): ExchangeRateTable {
  if (xml.length > MAX_XML_LENGTH || /<!DOCTYPE/iu.test(xml)) throw new TypeError('Unexpected ECB exchange-rate feed.');
  const namespace = /<gesmes:Envelope\b[^>]*\sxmlns\s*=\s*(['"])([^'"]+)\1/u.exec(xml);
  if (namespace?.[2] !== ECB_NAMESPACE) {
    throw new TypeError('Unexpected ECB exchange-rate feed.');
  }
  // Read only the dated Cube and its leaf elements from the ECB daily format.
  const cube = /<Cube\s*>\s*<Cube\s+time=(['"])(\d{4}-\d{2}-\d{2})\1\s*>([\s\S]*?)<\/Cube\s*>\s*<\/Cube\s*>\s*<\/gesmes:Envelope\s*>\s*$/u.exec(xml);
  if (!cube) throw new TypeError('Expected a single dated ECB exchange-rate table.');
  const [, , asOf, rows] = cube;
  const date = new Date(`${asOf}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== asOf) {
    throw new TypeError('Invalid ECB observation date.');
  }

  const rates: Record<string, string> = Object.create(null);
  rates.EUR = '1';
  const remainder = rows.replace(/<Cube\s+currency=(['"])([A-Z]{3})\1\s+rate=(['"])([^'"]+)\3\s*\/>/gu,
    (_row, _currencyQuote, code: string, _rateQuote, rate: string) => {
      if (rates[code] || !DECIMAL.test(rate) || !/[1-9]/u.test(rate)) throw new TypeError('Invalid ECB exchange-rate row.');
      rates[code] = rate;
      return '';
    });
  if (remainder.trim() || Object.keys(rates).length < 2) throw new TypeError('Incomplete ECB exchange-rate table.');
  return { asOf, source: ECB_XML, base: 'EUR', rates: Object.freeze(rates) };
}

interface Fraction {
  numerator: bigint;
  denominator: bigint;
}

function fraction(decimal: string): Fraction {
  const [whole, part = ''] = decimal.split('.');
  return { numerator: BigInt(whole + part), denominator: 10n ** BigInt(part.length) };
}

function divide(left: Fraction, right: Fraction): Fraction {
  return { numerator: left.numerator * right.denominator, denominator: left.denominator * right.numerator };
}

function euroQuote(table: ExchangeRateTable, code: string): Fraction | undefined {
  const rate = table.rates[code];
  if (rate) return fraction(rate);
  const peg = PEGS[code];
  if (!peg || !table.rates.USD) return undefined;
  const dollar = fraction(table.rates.USD);
  const multiplier = divide(fraction(peg.currencyUnits), fraction(peg.dollarUnits));
  return { numerator: dollar.numerator * multiplier.numerator, denominator: dollar.denominator * multiplier.denominator };
}

// Uses the dated-table and exact decimal rounding design from PR #26.
// Only the displayed result is rounded, with ties rounded away from zero.
function convert(amount: string, from: Fraction, to: Fraction, places: number): string {
  const input = fraction(amount);
  const ratio = divide(to, from);
  const factor = 10n ** BigInt(places);
  const numerator = input.numerator * ratio.numerator * factor;
  const denominator = input.denominator * ratio.denominator;
  const magnitude = numerator < 0n ? -numerator : numerator;
  const rounded = (2n * magnitude + denominator) / (2n * denominator);
  const whole = rounded / factor;
  const fractional = String(rounded % factor).padStart(places, '0').replace(/0+$/u, '');
  return `${numerator < 0n && rounded ? '-' : ''}${whole}${fractional ? `.${fractional}` : ''}`;
}

function pegSources(table: ExchangeRateTable, codes: string[], language: ExchangeIntent['language']): string[] {
  const links: string[] = [];
  for (const code of new Set(codes)) {
    const peg = PEGS[code];
    if (!peg || table.rates[code]) continue;
    const parity = `${peg.dollarUnits} USD = ${peg.currencyUnits} ${code}`;
    const source = `[${peg[language]}](${peg.source})`;
    links.push(language === 'ar' ? `الربط الرسمي بالدولار (${parity})، ${source}.` : `Official USD peg (${parity}), ${source}.`);
  }
  return links;
}

async function readRateTable(scope: RequestScope): Promise<ExchangeRateTable> {
  return scope.withCache('ecb:rates', ECB_CACHE_MS, async () => {
    const response = await scope.fetch(ECB_XML, { headers: { Accept: 'application/xml, text/xml' } });
    if (!response.ok) throw new Error(`ECB exchange-rate feed returned HTTP ${response.status}.`);
    return parseEcbRates(await response.text());
  });
}

export async function getRateValue(scope: RequestScope, from: string, to: string) {
  const table = await readRateTable(scope);
  const fromRate = euroQuote(table, from), toRate = euroQuote(table, to);
  if (!fromRate || !toRate) return undefined;
  return { value: convert('1', fromRate, toRate, 12), asOf: table.asOf, source: table.source };
}

export async function getRates(scope: RequestScope, request: ExchangeIntent): Promise<{ text: string; status: 'completed' | 'blocked' }> {
  const { amount, from, to, language } = request;
  const table = await readRateTable(scope);
  const disclaimer = `سعر مرجعي يومي من البنك المركزي الأوروبي بتاريخ ${table.asOf}، وليس سعر السوق اللحظي`;
  const source = `[${language === 'ar' ? 'بيانات البنك المركزي الأوروبي' : 'ECB reference data'}](${table.source})`;
  const fromRate = euroQuote(table, from);
  const toRate = euroQuote(table, to);
  if (!fromRate || !toRate) {
    const missing = [...new Set([!fromRate ? from : '', !toRate ? to : ''].filter(Boolean))].join(', ');
    const reason = language === 'ar'
      ? `لا يوجد مصدر حي موثوق لـ ${missing}. يحتاج التقاطع عبر اليورو إلى أسعارٍ لهذه العملات في النشرة أو أسعار ربط رسمية منشورة، وهذه البيانات غير متاحة.`
      : `لا يوجد مصدر حي موثوق. No reliable live source is available for ${missing}. A cross-rate through EUR requires a rate in the bulletin or a published official peg. These data are unavailable.`;
    return { status: 'blocked', text: [reason, disclaimer, source].join('\n') };
  }

  const places = request.rateOnly ? 12
    : new Intl.NumberFormat('en', { style: 'currency', currency: to }).resolvedOptions().maximumFractionDigits ?? 2;
  const value = convert(amount, fromRate, toRate, places);
  const method = language === 'ar' ? 'طريقة الحساب: السعر التقاطعي عبر اليورو (EUR).'
    : `Daily European Central Bank reference rate dated ${table.asOf}. This is not a real-time market rate.\nMethod: cross-rate through EUR.`;
  const text = [`${amount} ${from} ≈ ${value} ${to}`, disclaimer, method, ...pegSources(table, [from, to], language), source].join('\n');
  return { status: 'completed', text };
}
