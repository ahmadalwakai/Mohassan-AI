import type { ExchangeIntent, ExchangeQuoteIntent, LiveLanguage, UnsupportedMarketIntent } from '@mohassan/contracts';
import { matchText } from '../assistant/mind/normalize.js';

const codes = new Set(Intl.supportedValuesOf('currency'));
const aliases = new Map<string, string>();
const currencyNames = new Map<string, string>();
for (const language of ['en', 'ar']) {
  const names = new Intl.DisplayNames(language, { type: 'currency', fallback: 'none' });
  for (const code of codes) {
    const name = names.of(code);
    if (name) currencyNames.set(matchText(name), code);
    if (language === 'en') {
      const plural = new Intl.NumberFormat(language, { style: 'currency', currency: code, currencyDisplay: 'name' })
        .formatToParts(2).find(part => part.type === 'currency')?.value;
      if (plural) currencyNames.set(matchText(plural), code);
    }
  }
}

// Exchange grammar and the common aliases are adapted from PR #26.
for (const [code, names] of Object.entries({
  USD: 'dollars?|us dollars?|u\\.s\\. dollars?|american dollars?|الدولار|دولار|دولارات|الدولار الامريكي|دولار امريكي',
  EUR: 'euros?|اليورو|يورو',
  GBP: 'pounds? sterling|british pounds?|sterling|pounds?|جنيه استرليني|الجنيه الاسترليني|استرليني',
  EGP: 'egyptian pounds?|جنيه مصري|الجنيه المصري',
  SAR: 'saudi riyals?|ريال سعودي|الريال السعودي',
  AED: 'uae dirhams?|emirati dirhams?|درهم اماراتي|الدرهم الاماراتي',
  JPY: 'yen|japanese yen|ين|الين|ين ياباني|الين الياباني',
  KWD: 'kuwaiti dinars?|دينار كويتي|الدينار الكويتي',
  BHD: 'bahraini dinars?|دينار بحريني|الدينار البحريني',
  OMR: 'omani rials?|ريال عماني|الريال العماني',
  QAR: 'qatari riyals?|ريال قطري|الريال القطري',
  CAD: 'canadian dollars?|دولار كندي|الدولار الكندي',
  AUD: 'australian dollars?|دولار استرالي|الدولار الاسترالي',
  CHF: 'swiss francs?|فرنك سويسري|الفرنك السويسري',
  INR: 'indian rupees?|روبيه هنديه|الروبيه الهنديه',
  CNY: 'yuan|chinese yuan|يوان|اليوان الصيني',
  IQD: 'iraqi dinars?|دينار عراقي|الدينار العراقي',
  SYP: 'syrian pounds?|ليره سوريه|الليره السوريه',
  TRY: 'turkish liras?|ليره تركيه|الليره التركيه',
  MAD: 'moroccan dirhams?|درهم مغربي|الدرهم المغربي',
  JOD: 'jordanian dinars?|دينار اردني|الدينار الاردني',
  LBP: 'lebanese pounds?|ليره لبنانيه|الليره اللبنانيه',
  YER: 'yemeni rials?|ريال يمني|الريال اليمني',
})) for (const name of names.split('|')) aliases.set(name, code);

const assetPatterns = Object.entries({
  gold: '(?:spot )?gold(?: bullion| per (?:gram|ounce|troy ounce))?|(?:a |an )?(?:gram|ounce|troy ounce) of gold|xau|(?:(?:جرام|غرام|كيلو|اونصه|اوقيه) (?:من )?)?(?:ذهب|الذهب)(?: عيار \\d{1,2})?|سبائك الذهب',
  crypto: 'crypto(?:currency|currencies)?|bitcoin|btc|xbt|ethereum|eth|tether|usdt|solana|بيتكوين|البيتكوين|بتكوين|ايثريوم|العملات الرقميه|العملات المشفره',
  stocks: 'stocks?|shares?|(?:[a-z0-9-]+ ){1,4}(?:stock|shares)|الاسهم|الاسواق الماليه|سهم(?: [\\p{L}\\p{N}-]+){0,4}|اسهم(?: [\\p{L}\\p{N}-]+){0,4}',
}).map(([kind, names]) => [new RegExp(`^(?:${names})$`, 'u'), kind as UnsupportedMarketIntent['asset']] as const);

const patterns = <T>(names: Map<string, T>) => [...names].map(([name, value]) => [new RegExp(`^(?:${name})$`, 'u'), value] as const);
const aliasPatterns = patterns(aliases);

function currency(term: string) {
  const name = term.replace(/^(?:the|an?) /u, '');
  const code = name.toUpperCase();
  return codes.has(code) ? code : aliasPatterns.find(([pattern]) => pattern.test(name))?.[1] ?? currencyNames.get(name);
}

const asset = (term: string) => assetPatterns.find(([pattern]) => pattern.test(term.replace(/^the /u, '')))?.[1];
const AMOUNT = String.raw`[+−-]?(?:\d{1,3}(?:,\d{3})+|\d{1,18})(?:\.\d{1,18})?`;
const PAIR = String.raw`(?<from>.+?) (?<separator>to |into |in |for |against |and |الي |مقابل |في |(?:كم|بكم|يساوي|تساوي) (?:ب|ل)?|[بلو] *)(?<to>.+)`;
const conversion = new RegExp(`^(?:(?:convert|exchange|how much is|what is|what's|حول|تحويل|اصرف|صرف|بدل|كم|كام|قديش|كم يساوي|كم سعر|عندي|لدي)(?: مبلغ)? )?(?:من )?(?<amount>${AMOUNT}) *${PAIR}$`, 'u');
const reverseConversion = new RegExp(`^(?:how many|how much in|كم) (?<to>.+?) (?:is|are|for|يساوي|تساوي) (?<amount>${AMOUNT}) *(?<from>.+)$`, 'u');
const pair = new RegExp(`^${PAIR}$`, 'u');
const explicitRate = /^(?:(?:what(?: is|'s)|show me|tell me|give me|كم|ما(?: هو)?|ماهو|اعطني) )?(?:the )?(?:(?:foreign )?exchange rates?|forex(?: (?:rates?|quote))?|(?:سعر|اسعار) (?:الصرف|صرف))(?: (?:from|for|between|of|من|بين))?(?= |$) */u;
const priceLead = /^(?:(?:what(?: is|'s)|show me|tell me|give me|how much is|كم|ما(?: هو)?|ماهو|اعطني) )?(?:the )?(?:price(?: of)?|quote(?: for)?|value of|سعر|اسعار) /u;
const conversionLead = /^(?:convert|exchange|حول|تحويل|اصرف|صرف|بدل) /u;
const questionLead = /^(?:how much is|what(?: is|'s)|كم|بكم|كام|قديش) /u;
const amountQuestion = /^(?:how much is|كم|بكم|كام|قديش) /u;
const priceTail = / (?:spot price|price|quote|value|(?:foreign )?exchange rate)(?=$| (?:in|against) )/u;
const stockPrice = /^(?:the )?(?:stock|share) price(?: (?:of|for))? (?!(?:of|for|history|historical|forecast|prediction|api|chart|design|data)\b)[a-z\d][a-z\d.'-]*(?: [a-z\d][a-z\d.'-]*){0,4}$/u;
const currencyCode = /^[a-z]{3}$/u;
const currencyLabel = /^(?:currency [\p{L}-]+|[\p{L}-]+ currency|عمله [\p{L}-]+)$/u;
const freshness = /\b(?:right now|as of today|at (?:the )?(?:live|current|today's) (?:exchange )?rate|today(?:'s)?|latest|live|currently|current|now)\b|(?<!\p{L})(?:اليوم|النهارده|الحالي(?:ه)?|حاليا|الان|دلوقتي|الحين|هلق|مباشر)(?!\p{L})/gu;
const symbols: Record<string, string> = { '$': 'usd', '€': 'eur', '£': 'gbp', '¥': 'jpy' };

export function recognizeMarket(body: string, language: LiveLanguage, original: string): ExchangeIntent | ExchangeQuoteIntent | UnsupportedMarketIntent | null {
  const normalized = body.replace(/٬/gu, ',').replace(/٫/gu, '.')
    .replace(/([$€£¥]) *(\d[\d,.]*)|([$€£¥])(?![a-z])/gu, (_, prefix, amount, suffix) => amount ? `${amount} ${symbols[prefix]}` : symbols[suffix]);
  const fresh = normalized.replace(freshness, '').replace(/ +/gu, ' ').trim();
  const rate = explicitRate.exec(fresh);
  const price = priceLead.exec(fresh);
  const question = questionLead.exec(fresh);
  const lead = rate ?? price ?? conversionLead.exec(fresh) ?? question;
  const market = fresh.slice(lead?.[0].length ?? 0);
  const priceSuffix = priceTail.test(market);
  const quote = market.replace(priceTail, '');
  const slashPair = quote.split(/\s*[/→]\s*/u);
  const compactPair = rate && /^[a-z]{6}$/u.test(quote) ? { from: quote.slice(0, 3), to: quote.slice(3) } : undefined;
  const amountMatch = conversion.exec(fresh) ?? reverseConversion.exec(fresh);
  const matchedPair = amountMatch?.groups ?? pair.exec(quote)?.groups;
  const conjunction = matchedPair?.separator === 'and ' || matchedPair?.separator?.trim() === 'و';
  const terms = conjunction && !rate ? undefined : matchedPair
    ?? (slashPair.length === 2 ? { from: slashPair[0], to: slashPair[1] } : compactPair);
  const unsupported = terms && (asset(terms.from) ?? asset(terms.to));
  const amount = amountMatch?.groups?.amount.replace(/,/gu, '').replace('−', '-') ?? '1';
  const from = terms && currency(terms.from);
  const to = terms && currency(terms.to);
  if (unsupported && (rate || price || priceSuffix || from || to || amountMatch)) return { kind: 'unsupported-market', language, asset: unsupported };
  if (from && to && /^[-+]?\d{1,18}(?:\.\d{1,18})?$/u.test(amount)) {
    return { kind: 'exchange', language, amount, from, to, rateOnly: !amountMatch };
  }
  if (rate && terms && (from || to) && (from || currencyCode.test(terms.from)) && (to || currencyCode.test(terms.to))) {
    return { kind: 'unsupported-market', language, asset: 'currency' };
  }
  if (stockPrice.test(market)) return { kind: 'unsupported-market', language, asset: 'stocks' };
  const requestingQuote = rate || price || priceSuffix || amountQuestion.test(fresh) || fresh !== normalized;
  const pricedAsset = asset(quote);
  if (pricedAsset && requestingQuote) {
    return { kind: 'unsupported-market', language, asset: pricedAsset };
  }
  const single = requestingQuote && currency(quote);
  if (single) return { kind: 'exchange-quote', language, from: single };
  const ticker = quote.replace(/^the /u, '').replace(/ (?:in|against) [a-z]{3}$/u, '');
  if (requestingQuote && /^(?:\$[a-z]{1,5}(?:[.-][a-z])?|[a-z]{4,5}|[a-z]{3,5}[.-][a-z])$/u.test(ticker)
    && original.split(' ').includes(ticker.toUpperCase())) {
    return { kind: 'unsupported-market', language, asset: 'stocks' };
  }
  if ((rate || price) && currencyLabel.test(quote)) {
    return { kind: 'unsupported-market', language, asset: 'currency' };
  }
  return null;
}
