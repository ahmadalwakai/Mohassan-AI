import { normalizeWordProblem, numberSource, parseNumber, unitKey } from './word-problem-quantities.js';

export type QuantityCategory = 'count' | 'money' | 'time' | 'measure' | 'ratio' | 'unknown';
export type SearchIntent = 'total' | 'remainder' | 'difference' | 'rate' | 'per-unit' | 'comparison' | 'average' | 'percentage' | 'unknown';

export interface SearchQuantity {
  value: string;
  kind: 'amount' | 'fraction' | 'percentage' | 'multiple';
  category: QuantityCategory;
  unit: string | null;
  per: string | null;
  entity: string | null;
  before: string[];
  after: string[];
  /** Offsets of the numeric mention in the normalized problem text. */
  start: number;
  end: number;
  sentence: number;
  inQuestion: boolean;
}

export interface SearchTarget {
  intent: SearchIntent;
  unit: string | null;
  per: string | null;
  words: string[];
  entity: string | null;
}

export interface SearchProblem {
  text: string;
  context: string;
  question: string;
  quantities: SearchQuantity[];
  target: SearchTarget;
}

const money: Readonly<Record<string, string>> = {
  '$': 'dollar', '£': 'pound sterling', '€': 'euro', '¥': 'yen',
  usd: 'dollar', gbp: 'pound sterling', eur: 'euro', jpy: 'yen',
  dollar: 'dollar', cent: 'cent', penny: 'penny', pence: 'penny', euro: 'euro', yen: 'yen',
};
const time: Readonly<Record<string, string>> = {
  second: 'second', sec: 'second', minute: 'minute', min: 'minute', hour: 'hour', hr: 'hour',
  day: 'day', week: 'week', wk: 'week', month: 'month', year: 'year', yr: 'year',
};
const measures: Readonly<Record<string, string>> = {
  mm: 'millimeter', millimeter: 'millimeter', millimetre: 'millimeter',
  cm: 'centimeter', centimeter: 'centimeter', centimetre: 'centimeter',
  m: 'meter', meter: 'meter', metre: 'meter', km: 'kilometer', kilometer: 'kilometer', kilometre: 'kilometer',
  in: 'inch', inch: 'inch', ft: 'foot', foot: 'foot', yd: 'yard', yard: 'yard', mi: 'mile', mile: 'mile',
  mg: 'milligram', milligram: 'milligram', g: 'gram', gram: 'gram', kg: 'kilogram', kilogram: 'kilogram',
  oz: 'ounce', ounce: 'ounce', lb: 'pound', pound: 'pound', ton: 'ton', tonne: 'tonne',
  ml: 'milliliter', milliliter: 'milliliter', millilitre: 'milliliter',
  l: 'liter', liter: 'liter', litre: 'liter', gallon: 'gallon', quart: 'quart', pint: 'pint', cup: 'cup',
};
const scales: Readonly<Record<string, bigint>> = { billion: 1000000000n, million: 1000000n, thousand: 1000n };
const denominators: Readonly<Record<string, string>> = {
  half: '2', halves: '2', third: '3', thirds: '3', quarter: '4', quarters: '4', fourth: '4', fourths: '4',
  fifth: '5', fifths: '5', sixth: '6', sixths: '6', seventh: '7', sevenths: '7', eighth: '8', eighths: '8',
  ninth: '9', ninths: '9', tenth: '10', tenths: '10', hundredth: '100', hundredths: '100',
};
const factors: Readonly<Record<string, string>> = {
  once: '1', twice: '2', thrice: '3', double: '2', doubles: '2', doubled: '2',
  triple: '3', triples: '3', tripled: '3', quadruple: '4', quadruples: '4', quadrupled: '4',
};
const scaleSource = Object.keys(scales).join('|');
const largeNumber = `(?:(?:${numberSource}|an?) (?:${scaleSource})(?: (?:and )?(?:(?:${numberSource}) (?:${scaleSource}))){0,2}(?: (?:and )?${numberSource})?)`;
const denominatorSource = Object.keys(denominators).join('|');
const wordFraction = `(?:(?:${numberSource}|an?)[ -](?:${denominatorSource})|half|quarter(?= of\\b))`;
const mixedFraction = `(?:${numberSource} and ${wordFraction}|\\d+ \\d+/\\d+)`;
const dozens = `(?:(?:${largeNumber}|${numberSource}|an?) )?dozen`;
const multiplier = `(?:${Object.keys(factors).join('|')})`;
const suffix = String.raw`(?:\s*(?<percent>%|percent\b|per cent\b)|\s+(?<times>times)(?=\s+(?:as\b|more\b|less\b|the\b)))?`;
const gluedUnit = 'mm|cm|km|mg|kg|ml|m|g|l|ft|mi|yd|oz|lb|hr|min|sec';
const quantityPattern = new RegExp(String.raw`(?<![\p{L}\d_./])(?<currency>[$£€¥]\s*|(?:USD|GBP|EUR|JPY)\s+)?(?<number>${mixedFraction}|${wordFraction}|${dozens}|${largeNumber}|${numberSource}|${multiplier})(?![\d_/])(?=\b|%|$|(?:${gluedUnit})\b)${suffix}`, 'giu');
const quantityLead = new RegExp(`^${quantityPattern.source}`, 'iu');
const scaledPart = new RegExp(`^(.+?) (${scaleSource})(?: |$)`, 'u');
const fractionPart = new RegExp(`^(?:(.+?)[ -])?(${denominatorSource})$`, 'u');
const wordPattern = /[\p{L}]+(?:['-][\p{L}]+)*/gu;
const boundaries = /^(?:a|an|the|any|that|this|those|these|in|at|on|for|by|of|from|to|as|per|each|every|after|before|over|during|through|into|with|without|throughout|and|or|but|while|than|around|about|between|since|until|it|he|she|they|we|you|his|her|their|our|its|who|which|what|when|where|if|so|there|here|is|are|was|were|be|been|will|would|should|can|could|did|does|do|has|have|had|went|goes|go|costs?|spends?|spent|sells?|sold|buys?|bought|gives?|gave|adds?|added|takes?|took|uses?|used|gets?|got|needs?|needed|wants?|wanted|makes?|made|holds?|held|contains?|contained|works?|worked|walks?|drives?|drove|travels?|traveled|earns?|earned|leaves?|left|remains?|remaining|still|more|less|fewer|many|much|longer|later|altogether|combined|total|together|overall|respectively)$/u;
const additional = /^(?:(?:additional|another|extra|more|fewer|less|remaining|different|other)\s+)*/iu;
const label = /\b(?:room|apartment|route|chapter|episode|row|seat|figure|table|model|number)\s+(?:no\.?\s*|#\s*)?$/iu;
const nonQuantitiesAfter = /^(?::\d|[.,-]\d)/u;
const nonQuantitiesBefore = /\d[:,-]$/u;
const nonNames = /^(?:a|an|the|if|there|they|having|he|she|we|it|his|her|their|our|when|how|what|which|for|by|at|in|after|before|then|during|this|today|yesterday|tomorrow|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|half|once|twice|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december)$/iu;
const commonSubjects = /^(?:an?|the)\s+([a-z-]+(?:\s+[a-z-]+){0,2}?)\s+(?:has|had|buys?|bought|sells?|sold|holds?|held|contains?|contained|makes?|made|produces?|produced|uses?|used|works?|worked|travels?|traveled|drives?|drove)\b/iu;
const distributesBySubject = /^(?:each|every)\s+(?:of the )?([a-z-]+(?:\s+[a-z-]+){0,2}?)\s+(?:(?:can|will)\s+)?(?:has|had|holds?|held|contains?|contained|carries|carried|costs?|produces?|produced|makes?|made|uses?|used|gets?|got|receives?|received|requires?|required)\b/iu;

function words(text: string): string[] {
  return text.toLowerCase().match(wordPattern) ?? [];
}

function integerPhrase(text: string): string | null {
  const small = parseNumber(text);
  if (small !== null) return small;
  let remainder = text;
  let lastScale = 1000000000000n;
  let total = 0n;
  for (let match = scaledPart.exec(remainder); match; match = scaledPart.exec(remainder)) {
    const count = /^an?$/u.test(match[1]) ? '1' : parseNumber(match[1]);
    const scale = scales[match[2]];
    if (!count || !/^\d{1,3}$/u.test(count) || scale >= lastScale) return null;
    total += BigInt(count) * scale;
    lastScale = scale;
    remainder = remainder.slice(match[0].length).replace(/^and /u, '');
  }
  const tail = remainder ? parseNumber(remainder) : '0';
  return total > 0n && tail && /^\d{1,3}$/u.test(tail) ? String(total + BigInt(tail)) : null;
}

function numericPhrase(text: string): Pick<SearchQuantity, 'value' | 'kind'> | null {
  const amount = text.toLowerCase();
  if (Object.hasOwn(factors, amount)) return { value: factors[amount], kind: 'multiple' };
  if (amount.endsWith('dozen')) {
    const count = amount.slice(0, -5).trim();
    const value = !count || /^an?$/u.test(count) ? '1' : integerPhrase(count);
    return value && /^\d+$/u.test(value) ? { value: String(BigInt(value) * 12n), kind: 'multiple' } : null;
  }
  const mixed = /^(.+?)(?: and | (?=\d+\/))(.*)$/u.exec(amount);
  if (mixed) {
    const whole = integerPhrase(mixed[1]);
    const part = numericPhrase(mixed[2]);
    if (whole && /^\d+$/u.test(whole) && part?.kind === 'fraction') {
      const [numerator, denominator] = part.value.split('/').map(BigInt);
      return { value: `${BigInt(whole) * denominator + numerator}/${denominator}`, kind: 'fraction' };
    }
  }
  const fraction = fractionPart.exec(amount);
  if (fraction) {
    const count = !fraction[1] || /^an?$/u.test(fraction[1]) ? '1' : parseNumber(fraction[1]);
    return count && /^\d+$/u.test(count) ? { value: `${count}/${denominators[fraction[2]]}`, kind: 'fraction' } : null;
  }
  const value = integerPhrase(amount);
  return value && !/\/0+$/u.test(value) ? { value, kind: value.includes('/') ? 'fraction' : 'amount' } : null;
}

interface UnitMatch {
  unit: string;
  category: QuantityCategory;
  end: number;
}

function readUnit(text: string, allowArticle = false): UnitMatch | null {
  const start = /^[ -]*/u.exec(text)![0].length;
  const article = allowArticle ? /^(?:an?|the)\s+/iu.exec(text.slice(start))?.[0].length ?? 0 : 0;
  const offset = start + article + additional.exec(text.slice(start + article))![0].length;
  let count: UnitMatch | null = null;
  let end = offset;
  let scanned = 0;
  for (const token of text.slice(offset).matchAll(/[a-z]+(?:-[a-z]+)*/giu)) {
    if (scanned++ >= 3) break;
    const index = offset + token.index;
    if (index > end && !/^\s+$/u.test(text.slice(end, index))) break;
    const word = token[0].toLowerCase().replace(/-old$/u, '');
    if (boundaries.test(word) || /^-?\d/u.test(text.slice(index + word.length))) break;
    const key = unitKey(word);
    end = index + token[0].length;
    if (Object.hasOwn(money, key)) return { unit: money[key], category: 'money', end };
    if (Object.hasOwn(time, key)) return { unit: time[key], category: 'time', end };
    if (Object.hasOwn(measures, key)) {
      // A one-letter abbreviation is only credible adjacent to a number or at a phrase boundary.
      if (key.length > 1 || index === 0 || /^(?:\s*(?:$|[.,!?;])|\s+(?:of|long|wide|high|per)\b)/iu.test(text.slice(end))) {
        return { unit: measures[key], category: 'measure', end };
      }
    }
    count = { unit: key, category: 'count', end };
    if (key !== word || /^(?:people|children|men|women|feet|mice|loaves)$/u.test(word)) break;
  }
  return count;
}

function namedEntity(text: string, last: boolean): string | null {
  const matches = [...text.matchAll(/\b([A-Z][a-z]{1,30})(?:'s)?\b/gu)]
    .map(match => match[1]).filter(match => !nonNames.test(match) && parseNumber(match) === null);
  return (last ? matches.at(-1) : matches[0])?.toLowerCase() ?? null;
}

function referent(text: string): string | null {
  const following = /^(?:\s+(?:of|for)\s+)(?:(?:an?|the|each)\s+)?/iu.exec(text);
  if (!following) return null;
  const tail = text.slice(following[0].length);
  if (quantityLead.test(tail)) return null;
  const unit = readUnit(tail);
  return unit ? namedEntity(tail.slice(0, unit.end), false) ?? unit.unit : null;
}

function subsetUnit(text: string): UnitMatch | null {
  const lead = /^\s+of\s+(?:(?:the|his|her|their|its)\s+)?/iu.exec(text);
  if (!lead) return null;
  const tail = text.slice(lead[0].length);
  const unit = quantityLead.test(tail) ? null : readUnit(tail);
  return unit ? { ...unit, end: unit.end + lead[0].length } : null;
}

function rateUnit(text: string): string | null {
  const explicit = /^\s+(?:per|for each|each|every)\s+(?:an? |the )?/iu.exec(text);
  if (explicit) return readUnit(text.slice(explicit[0].length))?.unit ?? null;
  const article = /^\s+an?\s+/iu.exec(text);
  const following = article ? readUnit(text.slice(article[0].length)) : null;
  return following?.category === 'time' ? following.unit : null;
}

function eachUnit(before: string, after: string, unit: string | null, previous: SearchQuantity | undefined, sentence: number): string | null {
  if (!previous?.unit || previous.category !== 'count' || previous.unit === unit || !/^\s+each\b/iu.test(after)) return null;
  if (previous.sentence === sentence) return previous.unit;
  const referenced = /^(?:they|these|those)\b/iu.test(before) || words(before).some(word => unitKey(word) === previous.unit);
  return previous.sentence === sentence - 1 && referenced ? previous.unit : null;
}

function readQuantities(parts: readonly string[]): SearchQuantity[] {
  const quantities: SearchQuantity[] = [];
  let offset = 0;
  let previousActor: string | null = null;
  for (const [sentence, part] of parts.entries()) {
    const subject = commonSubjects.exec(part)?.[1];
    const sentenceActor = subject ? unitKey(subject) : namedEntity(part, false);
    for (const match of part.matchAll(quantityPattern)) {
      const { currency, number, percent, times } = match.groups!;
      const before = part.slice(0, match.index);
      const after = part.slice(match.index + match[0].length);
      if (label.test(before) || nonQuantitiesAfter.test(after) || nonQuantitiesBefore.test(before)) continue;
      if (/^one$/iu.test(number) && /^(?:\s+of\s+(?:that|this|them|those|these)\b|['’]s\b)/iu.test(after)) continue;
      const parsed = numericPhrase(number);
      if (!parsed) continue;
      const follow = readUnit(after, parsed.kind === 'fraction') ?? (parsed.kind === 'amount' ? subsetUnit(after) : null);
      const markedMoney = currency ? money[currency.trim().toLowerCase()] : null;
      const kind = percent ? 'percentage' : times ? 'multiple' : parsed.kind;
      const isFactor = times || Object.hasOwn(factors, number.toLowerCase());
      const unitMatch = percent || isFactor || markedMoney ? null : follow;
      const unit = markedMoney ?? unitMatch?.unit ?? null;
      const category = markedMoney ? 'money' : unitMatch?.category ?? (kind !== 'amount' ? 'ratio' : 'unknown');
      const [top, bottom] = parsed.value.split('/');
      const value = percent ? `${top}/${bottom ? BigInt(bottom) * 100n : 100n}` : parsed.value;
      const afterUnit = after.slice(unitMatch?.end ?? 0);
      const preceding = quantities.at(-1);
      const lead = preceding?.sentence !== sentence ? distributesBySubject.exec(before)?.[1] : null;
      const perSubject = lead ? readUnit(lead)?.unit ?? null : null;
      const per = rateUnit(afterUnit) ?? eachUnit(before, afterUnit, unit, preceding, sentence) ?? (perSubject !== unit ? perSubject : null);
      const inheritedActor = /^(?:he|she|they|it|his|her|their|its)\b/iu.test(part) ? previousActor : null;
      const entity = referent(afterUnit) ?? namedEntity(before, true) ?? (subject ? sentenceActor : null) ?? per ?? inheritedActor ?? unit;
      quantities.push({ value, kind, category, unit, per, entity, before: words(before).slice(-8), after: words(after).slice(0, 8),
        start: offset + match.index, end: offset + match.index + match[0].length, sentence, inQuestion: sentence === parts.length - 1 });
    }
    previousActor = sentenceActor ?? previousActor;
    offset += part.length + 2;
  }
  return quantities;
}

function targetIntent(question: string, per: string | null): SearchIntent {
  if (/\b(?:percent(?:age)?|per cent|proportion|fraction)\b/iu.test(question)) return 'percentage';
  if (/\b(?:average|arithmetic mean|on average)\b/iu.test(question)) return 'average';
  if (/\b(?:difference|how (?:many|much) (?:more|less|fewer)|how much (?:larger|smaller|longer|shorter|older|younger))\b/iu.test(question)) return 'difference';
  if (/\b(?:left(?: over)?|remain(?:s|ing|ed)?|remainder|still (?:has|have|had))\b/iu.test(question)) return 'remainder';
  if (/\b(?:how many times|times as (?:many|much|large)|ratio|how do(?:es)? .+ compare)\b/iu.test(question)) return 'comparison';
  if (/\b(?:rate|speed|how fast|how quickly)\b/iu.test(question) || per && Object.values(time).includes(per)) return 'rate';
  if (per || /\b(?:per|each|apiece|per-unit)\b/iu.test(question)) return 'per-unit';
  if (/\b(?:in all|total|sum|combined|altogether|together|overall|how many (?:have|has) .+ collected)\b/iu.test(question)) return 'total';
  return 'unknown';
}

function targetUnit(question: string, quantities: readonly SearchQuantity[]): string | null {
  const requested = /\bhow (?:many|much) (?:more |less |fewer )?([^?]+)/iu.exec(question)
    ?? /\b(?:number|amount|quantity|count) of ([^?]+)/iu.exec(question)
    ?? /\b(?:what (?:is|was|will be)|calculate|find|determine) (?:the )?(?:total|average|sum) (?:of )?([^?]+)/iu.exec(question);
  const written = /\b(?:in|to) ((?:centimeters?|kilometers?|meters?|grams?|kilograms?|liters?|feet|inches|miles?|yards?|minutes?|hours?|seconds?|days?|weeks?|months?|years?|dollars?|cents?|euros?))\s*\??$/iu.exec(question);
  const named = written ? readUnit(written[1]) : requested ? readUnit(requested[1]) : null;
  if (/\b(?:how long|how much (?:longer|shorter)\b)/iu.test(question) && !written) {
    const timed = [...new Set(quantities.filter(quantity => quantity.category === 'time').map(quantity => quantity.unit))];
    if (timed.length === 1) return timed[0];
  }
  const currencies = [...new Set(quantities.filter(quantity => quantity.category === 'money').map(quantity => quantity.unit))];
  const moneyQuestion = /\b(?:money|price|cost|costs|pay|paid|charge|charged|earn|earned|spend|spent|revenue|profit)\b/iu.test(question);
  if (moneyQuestion && currencies.length === 1 && (!named || named.unit === 'money')) return currencies[0];
  if (named) return named.unit;
  const units = [...new Set(quantities.map(quantity => quantity.unit).filter(unit => unit !== null))];
  const rateNumerator = /\b([a-z-]+)\s+(?:per|each|every)\b/iu.exec(question)?.[1];
  if (rateNumerator) {
    const explicitUnit = readUnit(rateNumerator)?.unit;
    if (explicitUnit && units.includes(explicitUnit)) return explicitUnit;
  }
  return units.length === 1 ? units[0] : null;
}

export function extractSearchProblem(statements: readonly string[], question: string): SearchProblem {
  const parts = [...statements.map(normalizeWordProblem), normalizeWordProblem(question)];
  const normalizedQuestion = parts.at(-1)!;
  const context = parts.slice(0, -1).join('. ');
  const quantities = readQuantities(parts);
  let per: string | null = null;
  const rate = /\b(?:per|for each|each|every)\s+(?:(?:an?|the)\s+)?([^?]+)/iu.exec(normalizedQuestion);
  if (rate) per = readUnit(rate[1])?.unit ?? null;
  const intent = targetIntent(normalizedQuestion, per);
  const unit = intent === 'percentage' || intent === 'comparison' ? null : targetUnit(normalizedQuestion, quantities);
  return { text: parts.join('. '), context, question: normalizedQuestion, quantities,
    target: { intent, unit, per, words: words(normalizedQuestion), entity: namedEntity(normalizedQuestion, false) ?? unit } };
}
