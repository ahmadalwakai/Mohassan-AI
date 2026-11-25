import type { Lang } from '../mind/contract.js';
import { matchText } from '../mind/normalize.js';
import {
  comparisonDigits, comparisonMoney, comparisonNumber, comparisonOptionEvidence, comparisonQualifiedObservation, comparisonTurn,
  containsComparisonAction, formatComparisonNumber,
} from './comparison-prose.js';
import { reasoned, reasoningGap, type ReasoningResult } from './result.js';

type Metric = 'price' | 'capacity' | 'weight' | 'length' | 'data' | 'fuel' | 'quantity';
type Domain = 'mass' | 'volume' | 'length' | 'data' | 'fuel' | 'mpg';
type Basis = { domain: string; factor: number; unit: string };
type Quantity = { amount: number; basis?: Basis; index: number; decimal?: string };
type Option = { name: string; quote: string; value: Quantity };
type Selection = { metric: Metric; order: 'low' | 'high'; difference: boolean; rank?: boolean; target?: Quantity; priority?: string };

const fold = (text: string) => matchText(text).replace(/\s+/gu, ' ').trim();
const baseUnits: readonly { forms: string; domain: Domain; factor: number; unit: string }[] = [
  { forms: 'km per lit(?:er|re)|km/l|km per l|km/lit(?:er|re)|kilomet(?:er|re)s? per lit(?:er|re)|كم ?(?:/|لكل |بال)لتر|كيلومترات? لكل لتر', domain: 'fuel', factor: 1, unit: 'km/L' },
  { forms: 'mpg|miles per gallon', domain: 'mpg', factor: 1, unit: 'mpg' },
  { forms: 'g|grams?|غرام(?:ات|ا)?|جرام(?:ات|ا)?', domain: 'mass', factor: 1, unit: 'g' },
  { forms: 'kg|kilograms?|كيلو(?: ?غرام(?:ات)?| ?جرام(?:ات)?)?|كغ|كجم', domain: 'mass', factor: 1000, unit: 'g' },
  { forms: 'lb|lbs|pounds?', domain: 'mass', factor: 453.59237, unit: 'g' },
  { forms: 'ml|millilit(?:er|re)s?|مل|ملليلتر(?:ات)?', domain: 'volume', factor: 0.001, unit: 'L' },
  { forms: 'l|lit(?:er|re)s?|لتر(?:ات|ا)?', domain: 'volume', factor: 1, unit: 'L' },
  { forms: 'cm|centimet(?:er|re)s?|سم|سنتيمتر(?:ات)?', domain: 'length', factor: 0.01, unit: 'm' },
  { forms: 'm|met(?:er|re)s?|م|متر(?:ا|ات)?|امتار', domain: 'length', factor: 1, unit: 'm' },
  { forms: 'km|kilomet(?:er|re)s?|كم|كيلو ?متر(?:ات|ا)?', domain: 'length', factor: 1000, unit: 'm' },
  { forms: 'mi|miles?|ميل(?:ا)?|اميال', domain: 'length', factor: 1609.344, unit: 'm' },
  { forms: 'mb|megabytes?|ميجا(?: ?بايت)?', domain: 'data', factor: 0.001, unit: 'GB' },
  { forms: 'gb|gigabytes?|جيجا(?: ?بايت)?|قيقا(?: ?بايت)?', domain: 'data', factor: 1, unit: 'GB' },
  { forms: 'tb|terabytes?|تيرا(?: ?بايت)?', domain: 'data', factor: 1000, unit: 'GB' },
];
const units = baseUnits.map(({ forms, ...basis }) => ({ basis, prefix: new RegExp(`^(?:${forms})(?![\\p{L}\\p{Nd}/])`, 'u') }));
const quantityNumber = new RegExp(String.raw`(?<![\p{L}\p{M}\p{Nd}.٫])(${comparisonDigits})(?![\p{Nd}.٫])`, 'gu');
const requirementHeads = /^(?:(?:which|what)(?: (?:one|option))?|ايهما|انهي|انهو|مين|وش|ايش|شنو|يا وحده|اي خيار|اي واحد(?:ه)?|اي) /u;
const preference = /^(?:i (?:only care about|care (?:only|most) about|prioriti[sz]e) |my (?:priority|criterion) is |(?:انا )?(?:يهمني|اهم شي عندي|اهم شيء عندي|اولويتي) )([^،,]+?)(?:(?:[،,] | )(?:(?:not|rather than|مو|مش) .+))?$/u;
const differenceHint = /(?:[,،]? (?:and )?(?:by )?how much|[،,]? ?و(?:بكم|بكام|كم الفرق|قديش الفرق)|[،,]? ?ومقدار الفرق)$/u;
const cleanLabel = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} .'’_-]{0,59}$/u;
const optionSplit = /\s+(?:and|but|whereas|while|بينما|مقابل|و)\s+|[,،;؛](?!\p{Nd})\s*|\s+و(?=ال\p{Script=Arabic})/giu;
const nominalPrefix = /^.*?[:：]\s*(?=[\p{L}\p{N}])/u;
const subordinate = /^(?:can|could|would|will|may|is|are|has|have|uses?|runs?|reaches?|travel(?:s)?|weighs?|costs?|holds?|carries?|يقدر|تقدر|يستطيع|تستطيع|يسافر|تسافر|يبلغ|تبلغ|يحمل|تحمل)(?!\p{L})/u;
const neutralQualifier = /^(?:each|total|in total|(?:at|for) the same (?:price|cost)|(?:ب|وب)نفس (?:السعر|التكلفه)|اجمالا|بالمجموع)$/u;
const rolePredicates: Record<Metric, RegExp> = {
  price: /\s+(?:costs?|is priced at|is|تكلف|يكلف|سعرها|سعره|بثمن|بسعر|ثمنها|ثمنه)$/u,
  capacity: /\s+(?:holds?|fits?|stores?|can hold|can carry|carries|has room for|has a capacity of|بيشيل|بتشيل|يشيل|تشيل|يحمل|تحمل|تسع|يسع|يتسع ل|تتسع ل|سعته|سعتها|يستوعب|تستوعب)$/u,
  weight: /\s+(?:weighs?|has a weight of|weights?|وزنه|وزنها|يزن|تزن)$/u,
  length: /\s+(?:measures?|is|runs|extends|has a length of|طوله|طولها|يمتد|تمتد)$/u,
  data: /\s+(?:includes?|provides?|offers?|has|comes with|gives?|فيها|فيه|توفر|يوفر|تشمل|يشمل|تعطي|يعطي)$/u,
  fuel: /\s+(?:gets?|does|averages?|drives?|goes|travels?|تمشي|يمشي|تسير|يسير|تقطع|يقطع)$/u,
  quantity: /\s+(?:is|has|got|scores?|measures?|equals?|يساوي|تساوي|عنده|عندها|يسجل|تسجل)$/u,
};

function metricFrom(words: string): Metric | undefined {
  const subject = words.replace(/^(?:the |ال)/u, '');
  if (/^(?:capacity|payload|load(?: capacity)?|volume|سعه|حموله|قدره التحميل)$/u.test(subject)) return 'capacity';
  if (/^(?:price|cost|expense|fee|سعر|كلفه|تكلفه|ثمن)$/u.test(subject)) return 'price';
  if (/^(?:data(?: allowance)?|internet(?: data)?|mobile data|bandwidth allowance|نت|انترنت|بيانات|باقه البيانات)$/u.test(subject)) return 'data';
  if (/^(?:fuel (?:economy|efficiency)|كفاءه (?:الوقود|استهلاك الوقود))$/u.test(subject)) return 'fuel';
  if (/^(?:weight|mass|وزن|كتله)$/u.test(subject)) return 'weight';
  if (/^(?:length|range|distance|طول|مدي|مسافه)$/u.test(subject)) return 'length';
  if (/^(?:quantity|amount|count|score|قيمه|عدد|درجه)$/u.test(subject)) return 'quantity';
  return undefined;
}

function measures(text: string): Quantity[] {
  return [...text.matchAll(quantityNumber)].flatMap(match => {
    const amount = comparisonNumber(match[1]);
    if (amount === undefined) return [];
    const rest = fold(text.slice(match.index + match[0].length));
    const unit = units.find(item => item.prefix.test(rest));
    const qualifier = unit ? rest.replace(unit.prefix, '').trim() : rest;
    if (qualifier && !neutralQualifier.test(qualifier)) return [];
    return [{ amount, basis: unit?.basis, index: match.index }];
  });
}

function questionSelection(question: string, statements: string[]): Selection | undefined {
  const headline = fold(question).replace(/^(?:please |من فضلك |لو سمحت )/u, '');
  const rank = /^(?:rank|رتب) (?:the options|them|these|الخيارات|هذه الخيارات)? ?(?:by|حسب|بحسب) (.*?)(?: ((?:in )?(?:ascending|descending)(?: order)?|from (?:highest to lowest|lowest to highest)|تصاعديا|تنازليا))?$/u.exec(headline);
  if (rank) {
    const metric = metricFrom(rank[1]);
    if (metric) return { metric, rank: true, difference: false, order: /ascending|lowest to highest|تصاعديا/u.test(rank[2] ?? '') ? 'low' : 'high' };
  }
  const head = requirementHeads.exec(headline);
  if (!head) return undefined;
  const core = headline.slice(head[0].length);
  const difference = differenceHint.test(core);
  const prompt = core.replace(differenceHint, '');
  const targetHead = /^(?:is (?:big|large|strong) enough for |can (?:hold|carry|fit|handle|support) |(?:ينفع|يصلح|يتحمل|يتسع|بزبط|بيضبط|يضبط|يشيل) (?:ل|مع)?(?:حموله|حمل|وزن|سعه)?(?: وزنه[ا]?| حجمها)? )/u.exec(prompt);
  if (targetHead) {
    const targetText = prompt.slice(targetHead[0].length).replace(/ (?:without overflow|دون فيضان)$/u, '');
    const [target, ...extra] = measures(targetText);
    if (target?.index === 0 && target.basis && ['mass', 'volume'].includes(target.basis.domain) && !extra.length && target.amount >= 0) {
      return { metric: 'capacity', order: 'high', difference: false, target };
    }
    return undefined;
  }
  if (/^(?:is (?:the )?cheaper|costs? less|(?:هو |هي )?(?:ارخص|اقل (?:كلفه|تكلفه|سعرا|ثمنا)))$/u.test(prompt)) {
    return { metric: 'price', order: 'low', difference };
  }
  if (/^(?:uses? less fuel(?: (?:on|for) the same (?:trip|journey|distance))?|(?:gets?|has) better fuel (?:economy|efficiency)|(?:يستهلك|تستهلك) اقل(?: وقودا?)?(?: لنفس (?:المسافه|الرحله|المشوار))?)$/u.test(prompt)) {
    return { metric: 'fuel', order: 'high', difference: false };
  }
  const comparative = /^(?:(?:is )?(?:the )?(more|less) (.+)|(?:has|holds|carries) (more|less) (.+)|(اكثر|اقل) (.+))$/u.exec(prompt);
  if (comparative) {
    const metric = metricFrom(comparative[2] ?? comparative[4] ?? comparative[6]);
    if (metric) return { metric, order: /^(?:less|اقل)$/u.test(comparative[1] ?? comparative[3] ?? comparative[5]) ? 'low' : 'high', difference };
  }
  const adjective = /^(?:is (?:the )?)?(lighter|heavier|shorter|longer|higher|lower|اخف|اثقل|اقصر|اطول|اعلي|اقل)$/u.exec(prompt)?.[1];
  if (adjective) {
    const metric = /^(?:lighter|heavier|اخف|اثقل)$/u.test(adjective) ? 'weight'
      : /^(?:shorter|longer|اقصر|اطول)$/u.test(adjective) ? 'length' : 'quantity';
    return { metric, order: /^(?:lighter|shorter|lower|اخف|اقصر|اقل)$/u.test(adjective) ? 'low' : 'high', difference };
  }
  const choice = /^(?:(?:should i (?:choose|pick|take)|do you recommend)|(?:اختار|اخذ|تنصحني اخذ|تنصحني اختار|ترشح))(?: (?:if i (?:only )?care about (.+)|(?:اذا|لو) يهمني (.+?)(?: اكثر)?))?$/u.exec(prompt);
  if (!choice) return undefined;
  const priorities = statements.flatMap(text => {
    const match = preference.exec(fold(text));
    return match ? [{ metric: metricFrom(match[1]), text }] : [];
  });
  const explicit = choice[1] ?? choice[2];
  const metric = explicit ? metricFrom(explicit) : priorities[0]?.metric;
  if (!metric || priorities.some(priority => priority.metric !== metric) || !['price', 'data', 'fuel', 'capacity'].includes(metric)) return undefined;
  return { metric, order: metric === 'price' ? 'low' : 'high', difference: false, priority: priorities[0]?.text ?? question };
}

function matchesMetric(value: Quantity, metric: Metric) {
  const domain = value.basis?.domain;
  if (metric === 'capacity') return !domain || domain === 'mass' || domain === 'volume';
  if (metric === 'weight') return !domain || domain === 'mass';
  if (metric === 'fuel') return domain === 'fuel' || domain === 'mpg';
  return metric === 'quantity' || !domain || domain === metric;
}

function optionName(text: string, metric: Metric): string | undefined {
  const raw = text.replace(nominalPrefix, '').trim();
  const normalized = fold(raw);
  if (subordinate.test(normalized)) return undefined;
  const predicate = rolePredicates[metric].exec(normalized);
  const length = predicate ? normalized.slice(0, predicate.index).split(' ').length : undefined;
  const name = raw.split(/\s+/u).slice(0, length).join(' ');
  return cleanLabel.test(name) ? name : undefined;
}

function optionStatements(statements: readonly string[]) {
  return statements.flatMap(statement => {
    if (preference.test(fold(statement))) return [];
    return statement.split(optionSplit).map(clause => clause.trim().replace(/^و(?=ال[\p{Script=Arabic}])/u, ''));
  }).filter(Boolean);
}

function observeOptions(statements: readonly string[], selection: Selection): Option[] | null {
  const options: Option[] = [];
  for (const quote of optionStatements(statements)) {
    const normalized = fold(quote);
    if (comparisonQualifiedObservation.test(normalized) || containsComparisonAction(quote)) return null;
    const values = selection.metric === 'price'
      ? comparisonMoney(quote).flatMap(money => {
          if (quote.slice(money.index + money.raw.length).trim() || money.amount < 0) return [];
          return [{ amount: money.amount, decimal: money.decimal, index: money.index, basis: { domain: money.currency, factor: 1, unit: money.unit } }];
        })
      : measures(quote).filter(value => matchesMetric(value, selection.metric) && value.amount >= 0);
    // A second statement about the same option may be irrelevant. Another
    // measurement of the selected property makes that option ambiguous.
    if (subordinate.test(normalized) && !values.length) continue;
    const [value] = values;
    const name = value && optionName(quote.slice(0, value.index), selection.metric);
    if (!name || values.length !== 1) return null;
    options.push({ name, quote, value });
  }
  const distinct = new Set(options.map(({ name }) => fold(name).replace(/^the /u, '')));
  return options.length >= 2 && options.length <= 30 && distinct.size === options.length ? options : null;
}

const comparableValue = (value: Quantity) => Number((value.amount * (value.basis?.factor ?? 1)).toPrecision(15));

function comparisonDifference(first: Option & { amount: number }, second: Option & { amount: number }) {
  if (first.value.decimal === undefined || second.value.decimal === undefined) {
    return formatComparisonNumber(Math.abs(first.amount - second.amount));
  }
  const [one, two] = [first.value.decimal, second.value.decimal].map(decimal => {
    const [whole, fraction = ''] = decimal.split('.');
    return { whole, fraction };
  });
  const places = Math.max(one.fraction.length, two.fraction.length);
  const delta = BigInt(one.whole + one.fraction.padEnd(places, '0')) - BigInt(two.whole + two.fraction.padEnd(places, '0'));
  const digits = (delta < 0n ? -delta : delta).toString().padStart(places + 1, '0');
  return places ? `${digits.slice(0, -places)}.${digits.slice(-places)}`.replace(/\.?0+$/u, '') : digits;
}

/** Compare measured options within the supplied prose when both the criterion and every option can be read. */
export function reasonConversationComparison(text: string, lang: Lang): ReasoningResult | null {
  const turn = comparisonTurn(text);
  if (!turn) return null;
  const { question, statements } = turn;
  const selection = questionSelection(question, statements);
  if (!selection) return null;
  const options = observeOptions(statements, selection);
  if (!options) return null;
  const ar = lang === 'ar';
  const quotes = [
    ...options.map(option => option.quote),
    ...(selection.target ? [question] : selection.priority ? [selection.priority] : []),
  ];
  const evidence = comparisonOptionEvidence(quotes);
  const citations = quotes.map(quote => `- «${quote}»`);
  const domain = new Set(options.flatMap(({ value }) => value.basis ? [value.basis.domain] : []));
  const bases = options.flatMap(({ value }) => value.basis ?? []);
  const inferred = bases[0];
  if (domain.size > 1 || options.some(({ value }) => !value.basis) && bases.some(basis => basis.factor !== inferred?.factor)
    || selection.target && inferred?.domain !== selection.target.basis?.domain) {
    return reasoningGap(lang, [ar ? 'الوحدات المتاحة لا تكفي لمقارنة هذه القيم.' : 'The available units do not support a comparison of these values.', ...citations].join('\n'), evidence);
  }
  const ordered = options.map(option => ({
    ...option, amount: comparableValue({ ...option.value, basis: option.value.basis ?? inferred }),
  })).sort((a, b) => selection.order === 'high' ? b.amount - a.amount : a.amount - b.amount);
  const threshold = selection.target && comparableValue(selection.target);
  if (ordered.some(option => Math.abs(option.amount) > Number.MAX_SAFE_INTEGER) || threshold && Math.abs(threshold) > Number.MAX_SAFE_INTEGER) {
    return reasoningGap(lang, [ar ? 'القيم الموحّدة أكبر من النطاق المدعوم.' : 'These normalized values exceed the supported range.', ...citations].join('\n'), evidence);
  }
  const selected = ordered.filter((item, index) => threshold !== undefined ? item.amount >= threshold : selection.rank || !index || item.amount === ordered[0].amount);
  const names = selected.reduce<string[]>((out, item, index) => {
    if (!index) return [item.name];
    if (item.amount === selected[index - 1].amount) out[out.length - 1] += ` = ${item.name}`;
    else out.push(item.name);
    return out;
  }, []).join(' → ');
  const heading = threshold !== undefined ? (ar ? 'الخيارات التي تستوعب الحمولة المطلوبة' : 'Options that meet the required capacity')
    : selection.rank ? (ar ? 'الترتيب المطلوب' : 'Requested order') : (ar ? 'الاختيار حسب المعيار المطلوب' : 'Best match for the requested criterion');
  const answer = names ? `${heading} — ${names}` : (ar ? 'لا خيار يستوعب السعة المطلوبة.' : 'None of the options meet the required capacity.');
  const difference = selection.difference ? ordered.slice(1).map(item => {
    const amount = `${comparisonDifference(ordered[0], item)}${inferred ? ` ${inferred.unit}` : ''}`;
    if (ordered.length === 2) return ar ? `الفرق: ${amount}.` : `Difference: ${amount}.`;
    return ar ? `الفرق مع ${item.name}: ${amount}.` : `Difference from ${item.name}: ${amount}.`;
  }) : [];
  return reasoned(lang, [answer, ...difference, ...citations].join('\n'), names || answer, evidence);
}
