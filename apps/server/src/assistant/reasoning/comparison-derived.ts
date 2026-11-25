import type { Lang } from '../mind/contract.js';
import { matchText } from '../mind/normalize.js';
import { comparisonMoney, comparisonNumber, comparisonOptionEvidence, comparisonQualifiedObservation, comparisonTurn } from './comparison-prose.js';
import { parseNumberWords } from './number-words.js';
import { reasoned, type ReasoningResult } from './result.js';

interface Ratio {
  numerator: bigint;
  denominator: bigint;
}

interface Option {
  name: string;
  quote: string;
  amount: Ratio;
}

const amountOption = /^(.+?)\s*(?:[:=]|\s+(?:costs?|charges?|sells?|offers?|asks?|is\s+(?:priced\s+at|selling)|ت?كلف(?:ه)?|بسعر|[بت]?يبيع|تبيع|يطلب|تطلب|سعره[ا]?)(?!\p{L}))/iu;
const optionSeparator = /\s*[,،;؛]\s*(?=\p{L})|\s+(?:and|while|but|whereas|versus|vs\.?|مقابل|بينما|لكن|و)\s+|\s+و(?=ال[\p{L}\p{M}])/iu;
const leadingConjunction = /^(?:and|while|but|whereas|versus|vs\.?|مقابل|بينما|لكن|و)\s+|^و(?=ال[\p{L}\p{M}])/iu;
const perItem = /\b(?:per (?:item|unit|piece)|each|unit price)\b|(?<!\p{L})(?:لكل (?:قطعه|وحده|حبه)|لل(?:قطعه|وحده|حبه)|سعر الوحده)(?!\p{L})/u;
const calendarUnit = /(?:^\s*[/(]?\s*(?:a |an |per |every |each |كل |في )?(?:([\p{L}\d]+(?:[- ][\p{L}]+){0,3}) )?(month|months|mo|quarter|quarters|year|years|yr|شهر|شهور|اشهر|سنه|سنوات|عام|اعوام|ربع سنوي)(?!\p{L}))|(?:^\s*(monthly|quarterly|yearly|annually|شهريا|سنويا)(?!\p{L}))/u;
const difference = /\b(?:difference|by how (?:much|many))\b|(?<!\p{L})(?:الفرق|وبكم|وبكام|بكم|بكام|بقد ايه|بمقدار كم)(?!\p{L})/u;
const lowPrice = /\b(?:cheaper|cheapest|less (?:expensive|costly)|lower (?:price|cost)|better value|costs? less)\b|(?<!\p{L})(?:ارخص|اوفر|اقل (?:كلفه|تكلفه|سعرا)|اقتصادي)(?!\p{L})/u;
const highPrice = /\b(?:more (?:expensive|costly)|most (?:expensive|costly)|higher (?:price|cost)|costs? more)\b|(?<!\p{L})(?:اغلي|اعلي (?:كلفه|تكلفه|سعرا)|اكثر (?:كلفه|تكلفه))(?!\p{L})/u;
const lowerTime = /\b(?:shorter|shortest|takes? less time|quicker|quickest)\b|(?<!\p{L})(?:اقصر|اسرع|اقل (?:وقتا|مده))(?!\p{L})/u;
const higherTime = /\b(?:longer|longest|takes? more time)\b|(?<!\p{L})(?:اطول|اكثر (?:وقتا|مده))(?!\p{L})/u;
const timeQuestion = /\b(?:trip|journey|commute|duration|travel(?:ling)? time|elapsed|time taken|time did .+ take)\b|(?<!\p{L})(?:رحله|الرحله|مشوار|المشوار|مده|المده|وقت|الوقت)(?!\p{L})/u;
const clock = String.raw`\d{1,2}:\d{2}(?:\s*[ap]\.?m\.?)?`;
const travel = String.raw`(?:travel(?:s|l?ed)?|commute(?:s|d)?|dr[oi]ve(?:s)?|walk(?:s|ed)?|run(?:s)?|ran|ride(?:s)?|rode|went|journey(?:s|ed)?|work(?:s|ed)?|(?:ركب|سافر|مشي|وصل|ذهب|راح)(?:ت)?)`;
const start = String.raw`(?:left|depart(?:s|ed)?|start(?:s|ed)?|set off|went out|(?:غادر|خرج|انطلق|بدا)(?:ت)?)`;
const finish = String.raw`(?:got (?:in|back|there|home|to [\p{L} ]{1,30}?)|arriv(?:es|ed)|reach(?:es|ed)(?: the [\p{L} ]{1,30}?)?|return(?:s|ed)?|finish(?:es|ed)|(?:وصل|عاد|انتهي|رجع)(?:ت)?)`;
const elapsedRange = new RegExp(String.raw`^(?<name>.+?)(?:\s+${travel}\s+(?:from|من|between|بين)\s+|\s*[:=]\s*(?:from\s+|من\s+)?)\s*(?<start>${clock})\s*(?:–|—|-|to|until|through|and|الي|حتي|و)\s*(?<end>${clock})(?:\s+(?<next>the next day|next day|tomorrow|في اليوم التالي|اليوم التالي))?$`, 'u');
const elapsedEvents = new RegExp(String.raw`^(?<name>.+?)\s+${start}\s+(?:(?:at|في|الساعه)\s+)?(?<start>${clock})[\s,،]+(?:and\s+(?:then\s+)?|ثم\s+|و\s*)?${finish}\s+(?:(?:at|في|الساعه)\s+)?(?<end>${clock})(?:\s+(?<next>the next day|next day|tomorrow|في اليوم التالي|اليوم التالي))?$`, 'u');
const validName = /^[\p{L}\p{Nd}][\p{L}\p{M}\p{Nd} .'’_-]{0,69}$/u;

function optionName(text: string): string | null {
  const name = text.trim().replace(/^(?:(?:the|an?)\s+|(?:ف|و)(?=ال))/iu, '');
  return validName.test(name) ? name : null;
}

function asRatio(decimal: string, multiply = 1, divide = 1): Ratio {
  const [whole, fraction = ''] = decimal.split('.');
  return { numerator: BigInt(whole + fraction) * BigInt(multiply), denominator: 10n ** BigInt(fraction.length) * BigInt(divide) };
}

function shownRatio(value: Ratio): string {
  const whole = value.numerator / value.denominator;
  let remainder = value.numerator % value.denominator;
  let decimals = '';
  for (let place = 0; remainder && place < 6; place++) {
    remainder *= 10n;
    decimals += String(remainder / value.denominator);
    remainder %= value.denominator;
  }
  return `${remainder ? '≈ ' : ''}${whole}${decimals ? `.${decimals}` : ''}`;
}

function numberOf(value: string, lang: Lang): number | null {
  const numeric = comparisonNumber(value) ?? Number(parseNumberWords(value, lang) ?? NaN);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
}

function monthsOf(raw: string, lang: Lang, quoted = false): number | null {
  const folded = matchText(raw);
  const period = calendarUnit.exec(folded);
  if (!period || (quoted && !/^\s*\)?\s*$/u.test(folded.slice(period[0].length)))) return null;
  const count = period[1] ? numberOf(period[1], lang) : 1;
  const unit = period[2] ?? period[3];
  const unitMonths = /^(?:y|annually|سن|عام|اعوام)/u.test(unit) ? 12 : /^(?:quarter|ربع)/u.test(unit) ? 3 : 1;
  const months = count === null ? NaN : count * unitMonths;
  return Number.isSafeInteger(months) ? months : null;
}

function desiredMonths(question: string, lang: Lang): number | null {
  const basis = /(?:\b(?:for|over|across)\s+|(?<!\p{L})(?:لمده|خلال|على مدار)\s+)(.+)$/u.exec(question)?.[1] ?? '';
  return monthsOf(basis, lang) ?? (/\b(?:annually|yearly)\b|سنويا/u.test(question) ? 12 : null);
}

export function hasDerivedPriceBasis(text: string): boolean {
  const folded = matchText(text);
  return perItem.test(folded) || desiredMonths(folded, 'en') !== null || desiredMonths(folded, 'ar') !== null
    || comparisonMoney(text).some(price => calendarUnit.test(matchText(text.slice(price.index + price.raw.length))));
}

function splitPriceOptions(statement: string): string[] {
  const prices = comparisonMoney(statement);
  if (prices.length < 2) return [statement];
  if (prices.length > 2) return [];
  const [first, second] = prices;
  const firstEnd = first.index + first.raw.length;
  const boundary = optionSeparator.exec(statement.slice(firstEnd, second.index));
  if (!boundary) return [];
  const split = firstEnd + boundary.index;
  return [statement.slice(0, split).trim(), statement.slice(split + boundary[0].length).trim().replace(leadingConjunction, '')];
}

const itemNouns = /^(?:items?|units?|pieces?|packets?|قطع(?:ه)?|حبه|حبات|وحد(?:ه|ات))$/u;

function packageCount(beforePrice: string, lang: Lang): { count: number; goods?: string; trailingWords?: number } | null {
  const tokens = beforePrice.trim().split(/\s+/u);
  const preposition = /^(?:for|at|ب|مقابل|بسعر)$/u.test(matchText(tokens.at(-1) ?? '')) ? 1 : 0;
  const folded = matchText(tokens.slice(0, tokens.length - preposition).join(' '));
  const pack = /^(.+?)[ -](?:pack|bundle|box|carton)(?:\s|$)/u.exec(folded.replace(/^(?:an?|the)\s+/u, ''));
  if (pack) {
    const count = numberOf(pack[1], lang);
    return count === null ? null : { count };
  }
  const countTokens = folded.split(/\s+/u);
  const noun = countTokens.pop();
  if (!noun || !/^\p{L}+$/u.test(noun)) return null;
  if (lang === 'ar' && /^(?:قطعت|حبت|وحدت)(?:ين|ان)$/u.test(noun)) return { count: 2, trailingWords: 1 + preposition };
  const goods = itemNouns.test(noun) ? undefined : noun.replace(lang === 'en' ? /s$/u : /$^/u, '');
  for (let last = Math.max(0, countTokens.length - 6); last < countTokens.length; last++) {
    const count = numberOf(countTokens.slice(last).join(' '), lang);
    if (count !== null) return { count, goods, trailingWords: countTokens.length - last + 1 + preposition };
  }
  return null;
}

function priceOptions(statements: string[], question: string, lang: Lang) {
  const priceGroups = statements.map(splitPriceOptions);
  if (priceGroups.some(group => group.length === 0)) return null;
  const quotes = priceGroups.flat();
  const item = perItem.test(question);
  const months = desiredMonths(question, lang);
  if (item && months !== null) return null;
  const priced = quotes.map(quote => {
    const [price, extra] = comparisonMoney(quote);
    if (!price || extra) return null;
    const before = quote.slice(0, price.index).trimEnd();
    const after = quote.slice(price.index + price.raw.length);
    const pack = item ? packageCount(before, lang) : null;
    const period = monthsOf(after, lang, true);
    const divisor = item ? pack?.count : period;
    if (!divisor || (item && after.trim()) || (months && months % divisor)) return null;
    const subject = amountOption.exec(before);
    if (!item && subject && before.slice(subject[0].length).trim()) return null;
    const label = subject?.[1]
      ?? (pack?.trailingWords ? before.split(/\s+/u).slice(0, -pack.trailingWords).join(' ') : before);
    const name = optionName(label);
    if (!name || price.amount < 0) return null;
    return { name, quote, amount: asRatio(price.decimal, months ?? 1, divisor), currency: price.currency, unit: price.unit, goods: pack?.goods };
  });
  if (priced.some(option => !option)) return null;
  const options = priced.filter(option => option !== null);
  const first = options[0];
  if (!first || options.some(option => option.currency !== first.currency) || new Set(options.map(option => option.goods).filter(Boolean)).size > 1) return null;
  const basis = item ? lang === 'ar' ? 'للوحدة' : 'per item'
    : months === 12 ? lang === 'ar' ? 'لسنة' : 'for one year'
    : months && months !== 1 ? lang === 'ar' ? `خلال ${months} شهر` : `for ${months} months`
    : lang === 'ar' ? 'شهريًا' : 'per month';
  return { options, unit: `${first.unit} ${basis}` };
}

function clockMinutes(raw: string): number | null {
  const [, hour, minute, half] = /^(\d{1,2}):(\d{2})(?:\s*([ap])\.?m\.?)?$/u.exec(raw) ?? [];
  const h = Number(hour), m = Number(minute);
  if (!Number.isInteger(h) || m > 59 || (half ? h < 1 || h > 12 : h > 23)) return null;
  return (half ? h % 12 + (half === 'p' ? 12 : 0) : h) * 60 + m;
}

function elapsedOptions(statements: string[]): Option[] {
  return statements.flatMap(quote => {
    const folded = matchText(quote).trim().replace(/[.!?؟]+$/u, '');
    const match = elapsedRange.exec(folded) ?? elapsedEvents.exec(folded);
    if (!match?.groups) return [];
    const { name: rawName, start, end, next } = match.groups;
    const nameWords = rawName.trim().split(/\s+/u).length;
    const name = optionName(quote.trim().replace(/[:=]+/gu, ' ').split(/\s+/u).slice(0, nameWords).join(' '));
    const first = clockMinutes(start), last = clockMinutes(end);
    if (!name || first === null || last === null || /[ap]/u.test(start) !== /[ap]/u.test(end) || (last < first && !next)) return [];
    const minutes = last - first + (next ? 24 * 60 : 0);
    return [{ name, quote, amount: { numerator: BigInt(minutes), denominator: 1n } }];
  });
}

export function reasonDerivedComparison(text: string, lang: Lang): ReasoningResult | null {
  const turn = comparisonTurn(text);
  if (!turn || turn.statements.some(statement => comparisonQualifiedObservation.test(matchText(statement)))) return null;
  const question = matchText(turn.question);
  const elapsed = timeQuestion.test(question) && (lowerTime.test(question) || higherTime.test(question));
  const result = elapsed
    ? { options: elapsedOptions(turn.statements), unit: lang === 'ar' ? 'دقيقة' : 'min' }
    : (lowPrice.test(question) || highPrice.test(question)) && hasDerivedPriceBasis(text) ? priceOptions(turn.statements, question, lang) : null;
  if (!result || elapsed && result.options.length !== turn.statements.length || result.options.length !== 2) return null;
  const { options: [first, second], unit } = result;
  if (matchText(first.name) === matchText(second.name)) return null;
  const left = first.amount.numerator * second.amount.denominator;
  const right = second.amount.numerator * first.amount.denominator;
  const high = elapsed ? higherTime.test(question) : highPrice.test(question);
  const chosen = (left > right) === high ? first : second;
  const outcome = left === right ? `${first.name} = ${second.name}` : chosen.name;
  const label = lang === 'ar'
    ? left === right ? 'تعادل' : elapsed ? high ? 'الزمن الأطول' : 'الزمن الأقصر' : high ? 'الأغلى' : 'الأوفر'
    : left === right ? 'Tie' : elapsed ? high ? 'Longer duration' : 'Shorter duration' : high ? 'Higher cost' : 'Lower cost';
  const deltaLabel = lang === 'ar' ? 'الفرق' : 'Difference';
  const delta = { numerator: left > right ? left - right : right - left, denominator: first.amount.denominator * second.amount.denominator };
  const rows = [first, second].map(option => `${option.name} — ${shownRatio(option.amount)} ${unit} («${option.quote}»).`);
  const answer = [`${label} — ${outcome}.`, ...rows, ...(difference.test(question) ? [`${deltaLabel} — ${shownRatio(delta)} ${unit}.`] : [])].join('\n');
  return reasoned(lang, answer, outcome, comparisonOptionEvidence([first.quote, second.quote]));
}
