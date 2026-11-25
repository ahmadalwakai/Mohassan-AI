import { publicSearchScan, publicSearchText, safeResumeUrl, searchTokens } from '@mohassan/browser';
import type { Evidence, Lang } from '../mind/contract.js';
import { boundedQuote, isPageInstruction, typedNumbers } from '../mind/extract.js';
import { matchText } from '../mind/normalize.js';
import type { ComparisonPage } from './comparison.js';
import { reasoned, type ReasoningResult } from './result.js';

const compare = /^(?:(?:compare|contrast|rank|sort|order|the difference)\b|(?:قارن|قارني|مقارنه|رتب|الفرق|فرق)(?=$|[^\p{L}]))/u;
const lower = /\b(?:shorter|shortest|smaller|smallest|cheaper|cheapest|fewer|fewest|lower|lowest|less|least)\b|(?:^|\s)(?:اقصر|الاقصر|اصغر|الاصغر|ارخص|الارخص|اقل|الاقل)(?=$|[^\p{L}])/u;
const higher = /\b(?:longer|longest|larger|largest|higher|highest|greater|greatest|heavier|heaviest|more|most)\b|(?:^|\s)(?:اطول|الاطول|اكبر|الاكبر|اعلي|الاعلي|اكثر|الاكثر|اثقل|الاثقل)(?=$|[^\p{L}])/u;
const faster = /\b(?:faster|fastest)\b|(?:^|\s)(?:اسرع|الاسرع)(?=$|[^\p{L}])/u;
const interrogative = /^(?:(?:which|who|what|how much)\b|(?:ايهما|اي|مين|من|ما|ايش|شنو|وش|كم)(?=$|[^\p{L}]))/u;
const difference = /\b(?:difference|gap|by how much)\b|(?:^|\s)(?:الفرق|فرق|بكم|بمقدار كم)(?=$|[^\p{L}])/u;
const ordering = /\b(?:rank|sort|order)\b|(?:^|\s)رتب(?=$|[^\p{L}])/u;
const introduction = /^(?:(?:please|kindly|tell me|show me|give me|can you|could you)\b|(?:لو سمحت|من فضلك|احكي\s*لي|قل\s*لي|خبرني|اخبرني|اعطني|عطيني|عطني|وضح لي)(?!\p{L}))[\s,،:]*/u;

export function isReadComparisonQuestion(question: string): boolean {
  let text = matchText(question).trim();
  for (let match = introduction.exec(text); match; match = introduction.exec(text)) text = text.slice(match[0].length);
  return compare.test(text) || (interrogative.test(text) && (lower.test(text) || higher.test(text) || faster.test(text) || difference.test(text)));
}

const properties = [
  ['price', /\b(?:price[sd]?|costs?|charges?|fares?|fees?|cheaper|cheapest|expensive)\b|(?:^|\s)(?:ال)?(?:سعر|اسعار|رسوم|تكلفه|اجره|ثمن|ارخص)(?=$|[^\p{L}])/u],
  ['length', /\b(?:length|longer|longest|shorter|shortest|distance|spans?)\b|(?:^|\s)(?:ال)?(?:طول|اطول|اقصر|مسافه|يمتد|تمتد)(?=$|[^\p{L}])/u],
  ['height', /\b(?:height|taller|tallest|elevation)\b|(?:^|\s)(?:ال)?(?:ارتفاع|مرتفع|علو)(?=$|[^\p{L}])/u],
  ['width', /\b(?:width|wide|wider|widest|breadth)\b|(?:^|\s)(?:ال)?(?:عرض|عريض)(?=$|[^\p{L}])/u],
  ['depth', /\b(?:depth|deep|deeper|deepest)\b|(?:^|\s)(?:ال)?(?:عمق|عميق)(?=$|[^\p{L}])/u],
  ['weight', /\b(?:weight|weighs?|mass|heavier|heaviest|lighter|lightest)\b|(?:^|\s)(?:ال)?(?:وزن|كتله|اثقل|اخف|يزن|تزن)(?=$|[^\p{L}])/u],
  ['power', /\b(?:wattage|power)\b|(?:^|\s)(?:ال)?(?:قدره|طاقه)(?=$|[^\p{L}])/u],
  ['duration', /\b(?:duration|takes?|delivery time|speed|faster|fastest)\b|(?:^|\s)(?:ال)?(?:مده|سرعه|اسرع|يصل|تصل|يستغرق|تستغرق)(?=$|[^\p{L}])/u],
  ['schedule', /\b(?:schedule|opening|open|visiting (?:days|hours)|access days)\b|(?:^|\s)(?:ال)?(?:يفتح|تفتح|مفتوح|مفتوحه|مواعيد|دوام)(?=$|[^\p{L}])/u],
  ['capacity', /\b(?:stores?|holds?|seats?|capacity|accommodates?)\b|(?:^|\s)(?:ال)?(?:سعه|يسع|تسع|يتسع|تتسع)(?=$|[^\p{L}])/u],
] as const;

const period = /\b(?:per|each|a)\s+(day|week|month|year|person|item|hour)\b|\b(daily|weekly|monthly|annually|annual|yearly)\b|(?:^|\s)(?:ال)?(يومي|اسبوعي|شهري|سنوي)(?:[اه])?(?=$|[^\p{L}])|(?:^|\s)(?:لكل|كل|في)\s+(?:ال)?(يوم|اسبوع|شهر|سنه|عام|ساعه|شخص)(?=$|[^\p{L}])/u;
const periods: Record<string, string> = {
  daily: 'day', weekly: 'week', monthly: 'month', annually: 'year', annual: 'year', yearly: 'year',
  يومي: 'day', اسبوعي: 'week', شهري: 'month', سنوي: 'year', يوم: 'day', اسبوع: 'week',
  شهر: 'month', سنه: 'year', عام: 'year', ساعه: 'hour', شخص: 'person',
};
function cadence(text: string) {
  const match = period.exec(matchText(text));
  return match?.[1] ?? periods[match?.[2] ?? match?.[3] ?? match?.[4] ?? ''] ?? '';
}

const englishPredicate = /\s+(?:currently\s+)?(?:(?:it\s+)?(?:is|are)|costs?|charges?|carries|holds?|stores?|takes?|lasts?|weighs?|spans?|reaches|delivers?|allows?|offers?|runs?|has|have|opens?|closes?)(?=$|\s)/iu;
const arabicPredicate = /(?:^|\s)(?:هو|هي|يبلغ|تبلغ|يساوي|تساوي|يكلف|تكلف|تصل|يصل|يمتد|تمتد|يستغرق|تستغرق|يزن|تزن|يفتح|تفتح|يتسع|تتسع)(?=$|\s)/u;
const arabicField = /^(?:ال)?(?:طول|وزن|عرض|ارتفاع|عمق|سعر|تكلفه|رسوم|قدره|اشتراك|اجره|مده|سعه)\s+/u;
const relative = /\b(?:difference|gap|higher|lower|greater|less|more|fewer|shorter|longer|cheaper|offset)\b|(?:^|\s)(?:الفرق|فرق|اعلي|اقل|اكثر|اقصر|اطول|ارخص|بمقدار)(?=$|[^\p{L}])/u;
const unasserted = /\b(?:not\b(?!\s+only\b)|never|may|might|estimated|planned|proposed|approximately|about|up to|at most|at least|starting from|maximum|minimum)\b|(?:^|\s)(?:لم|لن|ليس|ليست|ربما|نحو|حوالي|تقريبا|متوقع|مقترح|حد اقصي|حد ادني|بحد اقصي|بحد ادني)(?=$|[^\p{L}])/u;
const clauses = /[؛;]\s*|(?:[,،]\s*|\s+)(?:while|whereas|but|and|بينما|لكن|في حين)\s+|،\s*(?:و(?=\p{L})|(?=\p{L}))/iu;
const weekdayWord = /^(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|(?:ال)?(?:اثنين|ثلاثاء|اربعاء|خميس|جمعه|سبت|احد))$/u;

const currency = /^(pounds?\s+sterling|us\s+dollars?|saudi\s+riyals?|egyptian\s+pounds?|dollars?|euros?|pounds?|riyals?|dinars?|دينار(?:ا|ات)?|ريال(?:ا|ات)?|دولار(?:ا|ات)?|جنيه(?:ا|ات)?|يورو)(?!\p{L})/u;
const currencySign: Record<string, string> = { '£': 'pound', '$': 'dollar', '€': 'euro' };
const currencyCodes = new Set(Intl.supportedValuesOf('currency'));
const currencyCode = /(?:^|\s)([A-Z]{3})$/u;
const extraUnits = [
  { words: /^(?:kilomet(?:er|re)s?|كيلومترات?|كيلو متر(?:ات)?|كم)(?!\p{L})/u, unit: 'length:m', factor: 1_000 },
  { words: /^(?:kilowatts?|kw|كيلو\s?واط)(?!\p{L})/u, unit: 'power:w', factor: 1_000 },
  { words: /^(?:watts?|w|واط|وات)(?!\p{L})/u, unit: 'power:w', factor: 1 },
  { words: /^(?:lit(?:er|re)s?|l|لترات?|ليترات?)(?!\p{L})/u, unit: 'volume:l', factor: 1 },
  { words: /^(?:business days?|working days?|ايام عمل|يوم عمل)(?!\p{L})/u, unit: 'duration:workday', factor: 1 },
  { words: /^(?:days?|ايام|يوم)(?!\p{L})/u, unit: 'duration:s', factor: 86_400 },
] as const;
const unitNames: Record<string, [ar: string, en: string]> = {
  'length:m': ['م', 'm'], 'mass:g': ['غ', 'g'], 'power:w': ['واط', 'W'], 'volume:l': ['لتر', 'L'],
  'duration:s': ['ثانية', 'seconds'], 'duration:workday': ['يوم عمل', 'business days'], percent: ['نقطة مئوية', 'percentage points'],
};
const arabicPeriods: Record<string, string> = { day: 'اليوم', week: 'الأسبوع', month: 'الشهر', year: 'السنة', person: 'الشخص', item: 'القطعة', hour: 'الساعة' };
const comparisonNoise = new Set('compare contrast rank differences difference cheaper cheapest shorter shortest longer longest lower higher less more larger smaller faster fastest tell show give page listed report included please only both same public between versus among قارن مقارنه رتب فرق الفرق ايهما اقصر اطول اكثر اقل اعلي ارخص احكيلي عطني اعطني قل اخبرني بين ولا و عند فقط الصفحه'.split(' '));
const terms = (text: string) => searchTokens(matchText(text)).map(word => word.replace(/(?<=[a-z]{2})ies$/u, 'y').replace(/(?<=[a-z]{3})(?<![su])s$/u, ''));
const labelKey = (label: string) => terms(label).join(' ');
const sentenceSegments = new Intl.Segmenter('en', { granularity: 'sentence' });

interface ComparisonObservation {
  label: string;
  quote: string;
  unit: string;
  metric: string;
  amount?: number;
  cadence: string;
  unitLabel?: string;
}

function allowed(text: string): boolean {
  const scanned = publicSearchScan(text);
  return !!text && boundedQuote(text) === text && !/[<>\x60\[\]\p{Cf}]|https?:\/\//iu.test(text)
    && publicSearchText(scanned) === scanned && !isPageInstruction(text);
}

function observationLabel(text: string): { label: string; dependent: boolean } | null {
  const prefix = text.trim().replace(/^[*•–—-]\s+/u, '').replace(/[\s:=،,]+$/u, '');
  const dependent = /^(?:to|for)\s+.+\s+it\s+is$/iu.test(prefix);
  const subject = /^(?:[\p{L}\p{M}]+\s+){0,6}(?:charges?|costs?|prices?|fares?|fees?|length|height|width|depth|weight|power|duration|capacity)\s+(?:of|on|for|to)\s+(.+?)\s+(?:is|are)$/iu.exec(prefix)?.[1] ?? prefix;
  let label = subject.split(englishPredicate, 1)[0].trim().replace(/^(?:the|a|an|for|to)\s+/iu, '');
  if (/\p{Script=Arabic}/u.test(label)) {
    const words = label.split(/\s+/u);
    if (arabicField.test(matchText(label))) words.shift();
    const predicate = words.findIndex(word => arabicPredicate.test(matchText(word)));
    const subjectWords = predicate === 0 ? words.slice(1) : predicate > 0 ? words.slice(0, predicate) : words;
    if (predicate === 0 && arabicField.test(matchText(subjectWords.join(' ')))) subjectWords.shift();
    label = subjectWords.filter(word => !cadence(word) && !/^(?:خلال|في|نحو)$/u.test(matchText(word))).join(' ');
  }
  return /^[\p{L}\p{N}][\p{L}\p{M}\p{N} .'’_-]{0,79}$/u.test(label) && labelKey(label) ? { label, dependent } : null;
}

function numericObservation(quote: string, previous?: ComparisonObservation): ComparisonObservation | undefined {
  const values = typedNumbers(quote);
  if (values.length !== 1) return;
  const [number] = values;
  if ((number.value.match(/\p{Nd}/gu) ?? []).length > 15) return;
  const head = quote.slice(0, number.index);
  if (relative.test(matchText(quote)) || /\d\s*[:/-]\s*$/u.test(head)) return;
  const leadingCode = currencyCode.exec(head.trimEnd())?.[1];
  const leadingMoney = /[£$€]\s*$/u.exec(head)?.[0].trim() ?? (currencyCodes.has(leadingCode ?? '') ? leadingCode : undefined);
  const label = observationLabel(leadingMoney ? head.trimEnd().slice(0, -leadingMoney.length) : head);
  if (!label) return;
  const rawTail = quote.slice(number.index + number.value.length).trimStart();
  const tail = matchText(rawTail);
  const trailingCode = /^[A-Z]{3}(?!\p{L})/u.exec(rawTail)?.[0];
  const trailingMoney = currency.exec(tail)?.[1] ?? (currencyCodes.has(trailingCode ?? '') ? trailingCode : undefined);
  if (leadingMoney && trailingMoney) return;
  const money = leadingMoney ?? trailingMoney;
  const text = matchText(quote);
  const matches = properties.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
  let unit = number.unit;
  let amount = number.number;
  let unitLabel: string | undefined;
  let implied: string | undefined;
  if (money) {
    unit = `money:${currencySign[money] ?? labelKey(money).replace(/([\p{Script=Arabic}])(?:ات|ا)$/u, '$1')}`;
    unitLabel = money;
    implied = 'price';
  } else if (unit === 'number') {
    const extended = extraUnits.find(extra => extra.words.test(tail));
    if (extended) {
      unit = extended.unit;
      amount *= extended.factor;
    } else {
      const count = /^(\p{L}+(?:\s+\p{L}+)?)(?=\s|[.،,؟?]|$)/u.exec(tail)?.[1];
      if (count) {
        unitLabel = count;
        unit = `count:${labelKey(count)}`;
      }
    }
  }
  // A business-day qualification may precede an equivalent parenthetical number.
  if (unit === 'duration:s' && /\b(?:business|working)\s+days?\b|(?:ايام|يوم) عمل/u.test(text)
      && /^(?:days?|ايام|يوم)(?!\p{L})/u.test(tail)) {
    amount /= 86_400;
    unit = 'duration:workday';
  }
  implied ??= unit === 'length:m' ? 'length' : unit === 'mass:g' ? 'weight' : unit.startsWith('duration:') ? 'duration' : unit === 'power:w' ? 'power' : undefined;
  const metric = matches.length === 1 ? matches[0] : implied ?? (label.dependent && previous?.unit === unit ? previous.metric : '');
  if (!metric && !unit.startsWith('count:')) return;
  const billing = cadence(quote) || (label.dependent && previous?.unit === unit ? previous.cadence : '');
  if (!Number.isFinite(amount) || Math.abs(amount) > Number.MAX_SAFE_INTEGER) return;
  return { label: label.label, quote, unit, amount: Number(amount.toPrecision(15)), metric, cadence: billing, unitLabel };
}

function scheduleObservation(quote: string): ComparisonObservation | undefined {
  const text = matchText(quote);
  if (!properties.find(([name]) => name === 'schedule')![1].test(text)) return;
  const weekday = [...quote.matchAll(/\p{L}[\p{L}\p{M}]*/gu)].find(word => weekdayWord.test(matchText(word[0])));
  if (!weekday) return;
  const label = observationLabel(quote.slice(0, weekday.index));
  if (label) return { label: label.label, quote, unit: 'schedule', metric: 'schedule', cadence: '' };
}

/** Split a requested pair without expanding a named selection to the whole page. */
function namedPair(question: string): string[][] | undefined {
  const text = matchText(question).replace(/(?:\s+(?:in|on|from) (?:this|the|that) (?:open )?page|\s+(?:في|علي|من) (?:هذه )?الصفحه)(?=$|[^\p{L}])/u, '');
  const pair = /\b(?:which|who)\s+of\s+(.+?)\s+(?:or|and)\s+(.+?)\s+(?:is|are|has|have|costs?|weighs?|holds?|stores?)\s+/u.exec(text)
    ?? /\b(?:between|of|for)\s+(.+?)\s+(?:and|versus|vs\.?)\s+(.+)|(?:^|\s)بين\s+(.+)\s+(?:و\s*|او\s+)(.+)|[،,]\s+(.+?)\s+(?:or|ولا|ام|او)\s+(.+)|(?:^|\s)(لل\p{L}+)\s+و(لل\p{L}+)(?!\p{L})/u.exec(text)
    ?? /^(?:compare|contrast|rank)\s+(.+?)\s+(?:and|versus|vs\.?)\s+(.+)|^(?:قارن|رتب)\s+(.+)\s+(?:و\s*|او\s+)(.+)/u.exec(text);
  if (!pair) return;
  const first = pair[1] ?? pair[3] ?? pair[5] ?? pair[7];
  const second = pair[2] ?? pair[4] ?? pair[6] ?? pair[8];
  const targets = [first, second].map((part, index) => terms(part
    .replace(/^لل/u, 'ال')
    .replace(/\s+(?:at|when|using|by|عند|حسب)\s+.+$/u, '')
    .replace(index === 0 ? /^\S+(?:تين|ين)\s+(?=\p{L})/u : /^$/u, ''))
    .filter(word => !comparisonNoise.has(word)));
  if (targets.every(target => target.length > 0 && target.length <= 6)) return targets;
}

function chooseObservations(observations: ComparisonObservation[], question: string): ComparisonObservation[] | null {
  const text = matchText(question);
  const metrics = properties.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
  const requestedPeriod = cadence(question);
  const targets = namedPair(question);
  const focus = terms(question).filter(word => !comparisonNoise.has(word));
  const groups = new Map<string, ComparisonObservation[]>();
  for (const item of observations) {
    if (metrics.length && !metrics.some(metric => metric === item.metric)) continue;
    if (requestedPeriod && requestedPeriod !== item.cadence) continue;
    const key = JSON.stringify([item.metric, item.unit, item.cadence]);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  const candidates = [...groups.values()].flatMap(group => {
    if (!targets && !metrics.length && !group.some(item => terms(item.quote).some(word => focus.includes(word)))) return [];
    const byLabel = new Map<string, ComparisonObservation>();
    for (const item of group) {
      const key = labelKey(item.label);
      if (targets && !targets.some(target => target.every(word => key.split(' ').includes(word)))) continue;
      const prior = byLabel.get(key);
      if (prior && (prior.amount !== item.amount || prior.amount === undefined && prior.quote !== item.quote)) return [];
      byLabel.set(key, item);
    }
    const items = [...byLabel.values()];
    if (targets && !targets.every(target => items.filter(item => target.every(word => terms(item.label).includes(word))).length === 1)) return [];
    return items.length >= 2 && items.length <= 30 ? [items] : [];
  });
  return candidates.length === 1 ? candidates[0] : null;
}

export function reasonReadComparison(page: ComparisonPage, question: string, lang: Lang): ReasoningResult | null {
  const url = safeResumeUrl(page.url);
  if (!url || page.text.length > 60_000 || !isReadComparisonQuestion(question)) return null;
  const link = publicSearchScan(url);
  if (publicSearchText(link) !== link) return null;
  const observations: ComparisonObservation[] = [];
  for (const line of page.text.split(/\r?\n/u)) for (const { segment } of sentenceSegments.segment(line)) {
    const sentence = segment.trim();
    if (!allowed(sentence) || unasserted.test(matchText(sentence))) continue;
    const portions = sentence.split(clauses).map(clause => clause.trim());
    const numeric = portions.map((quote, index) => numericObservation(quote, index === 0 ? observations.at(-1) : undefined));
    if (numeric.every(item => item !== undefined)) observations.push(...numeric);
    else {
      const item = numericObservation(sentence, observations.at(-1)) ?? scheduleObservation(sentence);
      if (item) observations.push(item);
    }
  }
  const values = chooseObservations(observations, question);
  if (!values) return null;
  const ar = lang === 'ar';
  const text = matchText(question);
  const ascending = /\bascending\b|تصاعديا/u.test(text);
  const low = lower.test(text) || ascending || (faster.test(text) && values[0].metric === 'duration');
  const high = higher.test(text) || faster.test(text);
  const order = ordering.test(text) || ascending || /\bdescending\b|تنازليا/u.test(text);
  const delta = difference.test(text);
  const numeric = values.every(value => value.amount !== undefined);
  if ((delta && values.length !== 2) || (!numeric && (low || high || order || delta))) return null;
  const sorted = low || high || order
    ? [...values].sort((a, b) => (low ? 1 : -1) * (a.amount! - b.amount!))
    : values;
  const selected = !order && (low || high) ? sorted.filter(item => item.amount === sorted[0].amount) : sorted;
  const labels = selected.map((item, index) => {
    const separator = !index ? '' : (order || low || high) && item.amount === selected[index - 1].amount ? ' = ' : order ? ' → ' : ' / ';
    return separator + item.label;
  }).join('');
  const outcome = low || high || order ? labels : ar ? 'القيم المذكورة في الصفحة' : 'Values reported on the page';
  const evidence: Evidence[] = sorted.map((item, index) => ({
    id: `comparison-page-${index + 1}`, source: 'site', quote: item.quote, url,
    ...(allowed(page.title) ? { title: page.title } : {}),
    ...(page.observedAt ? { fetchedAt: page.observedAt } : {}),
  }));
  const change = delta ? Number(Math.abs(sorted[0].amount! - sorted[1].amount!).toPrecision(15)) : undefined;
  const unit = unitNames[sorted[0].unit]?.[ar ? 0 : 1] ?? sorted[0].unitLabel ?? '';
  const recurring = sorted[0].cadence ? ar ? ` لكل ${arabicPeriods[sorted[0].cadence]}` : ` per ${sorted[0].cadence}` : '';
  const gap = change === undefined ? '' : `\n${ar ? 'الفرق' : 'Difference'} — ${change}${unit ? ` ${unit}` : ''}${recurring}`;
  const details = evidence.map(item => `- «${item.quote}» (${url})`);
  return reasoned(lang, [`${outcome}${gap}`, ...details].join('\n'), change === undefined ? labels : String(change), evidence);
}
