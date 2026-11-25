import { numberSource, unitKey } from './word-problem-quantities.js';

interface QuantityContext {
  subject?: string;
  subjectAnchored?: boolean;
}

const amount = String.raw`(?:${numberSource})(?:\s+(?:thousand|million|billion|trillion))?`;
const range = String.raw`(?:between\s+${amount}\s+and\s+${amount}|from\s+${amount}\s+to\s+${amount}|${amount}(?:\s*(?:[–—-]|\bto\b)\s*${amount})?)`;
const qualifiedAmount = String.raw`(?:(?:about|approximately|around|an estimated|at least|at most|more than|less than|up to|nearly|roughly)\s+)?${range}`;
const timeUnit = /^(?:second|sec|minute|min|hour|hr|day|week|month|quarter|year|decade|century|season)$/u;
const dimensionUnits: Record<string, RegExp> = {
  tall: /^(?:cm|m|ft|inch|foot|meter|metre|centimeter|centimetre)$/u,
  wide: /^(?:mm|cm|m|km|ft|inch|foot|yard|meter|metre|centimeter|centimetre|kilometer|kilometre|mile)$/u,
  deep: /^(?:mm|cm|m|km|ft|inch|foot|yard|meter|metre|centimeter|centimetre|kilometer|kilometre|mile|fathom)$/u,
  far: /^(?:cm|m|km|ft|foot|yard|meter|metre|kilometer|kilometre|mile|light-year|parsec)$/u,
  heavy: /^(?:mg|g|kg|lb|oz|gram|kilogram|pound|ounce|ton|tonne)$/u,
  old: /^(?:day|week|month|year)$/u,
};
const dimensionRelation: Record<string, RegExp> = {
  tall: /\b(?:tall|high|height|stands?)\b/iu,
  wide: /\b(?:wide|width|across|spans?)\b/iu,
  deep: /\b(?:deep|depth)\b/iu,
  far: /\b(?:distant|distance|away|apart)\b/iu,
  heavy: /\b(?:heavy|weight|weigh(?:s|ed)?)\b/iu,
  old: /\b(?:old|age[ds]?)\b/iu,
};
const countQuestion = /^how many\s+([\p{L}][\p{L}\s'-]{0,65}?)\s+(do|does|did|is|are|was|were|has|have|had|can|could|will|would|(?:still )?(?:live|work|remain|exist|attend)s?)\s+(.+)$/iu;
const countConnection = /\b(?:has|have|had|contains?|contained|includes?|included|counts?|counted|totals?|totaled|number(?:s|ed)?|consists? of|comprises?|hosts?|hosted|holds?|held|houses?|housed)$/iu;
const existential = /\bthere (?:are|were|is|was)$/iu;
const countLocation = /^(?:(?:still )?(?:live|work|remain|exist)s?\s+)?(?:there\s+)?(?:in|on|at|within)\s+(.+)$/iu;
const relationStop = new Set(['a', 'an', 'the', 'of', 'in', 'on', 'to', 'for', 'at', 'by', 'with', 'and', 'from', 'its', 'there', 'typically', 'usually', 'currently', 'still', 'now', 'today', 'total', 'altogether']);
const pronoun = /^(?:it|they|he|she)$/iu;
const auxiliaryVerb = /^(?:do|does|did|is|are|was|were|has|have|had|can|could|will|would)$/iu;
const possessionVerb = /^(?:have|contain|include|number|hold)$/u;

function words(text: string): string[] {
  return (text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().match(/[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*/gu) ?? []);
}

function content(text: string): string[] {
  return words(text).filter(word => !relationStop.has(word)).map(unitKey);
}

function mentions(tokens: readonly string[], text: string): boolean {
  const source = new Set(words(text).map(unitKey));
  return tokens.length > 0 && tokens.every(token => source.has(token));
}

function relationKey(word: string): string {
  return word.replace(/(?:ies|ied)$/u, 'y').replace(/(?:[ei]ng|ed|es|s)$/u, '').replace(/e$/u, '');
}

function mentionsRelation(relation: string, text: string): boolean {
  const key = relationKey(relation);
  return words(text).some(word => relationKey(word) === key);
}

function scoped(subject: string, clause: string, context: QuantityContext): boolean {
  const subjectWords = content(subject);
  if (mentions(subjectWords, clause)) return true;
  return Boolean(context.subjectAnchored && context.subject && mentions(subjectWords, context.subject)
    && /^(?:it|they|he|she|this |these |the )/iu.test(clause));
}

function consecutiveSubject(subject: string, actor: string): boolean {
  const expected = content(subject);
  const actual = content(actor);
  return expected.length > 0 && expected.every((word, at) => word === actual[actual.length - expected.length + at]);
}

function ownsPredicate(subject: string, actor: string, context: QuantityContext): boolean {
  const explicit = actor.trim().replace(/\s*\([^()]*\)$/u, '').split(',').at(-1)!;
  const subjectWords = content(subject);
  if (content(explicit).length === subjectWords.length && consecutiveSubject(subject, explicit)) return true;
  if (pronoun.test(actor.trim())) return Boolean(context.subjectAnchored && context.subject && consecutiveSubject(subject, context.subject));
  // A relative clause can resume the explicit subject of the same sentence.
  const resumed = /^(.+?)\s*,\s*(?:with whom|for whom)\s+(?:he|she|they|it)$/iu.exec(actor.trim());
  return Boolean(resumed && content(resumed[1]!).join(' ').startsWith(`${subjectWords.join(' ')} `));
}

function quantitySpans(clause: string, unitLength: number): IterableIterator<RegExpMatchArray> {
  const unit = String.raw`[\p{L}][\p{L}\p{N}²³-]*(?:\s+[\p{L}][\p{L}\p{N}²³-]*){${unitLength - 1}}`;
  return clause.matchAll(new RegExp(String.raw`(?<![\p{L}\p{N}./])(?<amount>${qualifiedAmount})(?:\s+|(?<=\d))(?<unit>${unit})(?![\p{L}\p{N}-])`, 'giu'));
}

function unitMatches(unit: string, sought: string): boolean {
  return unitKey(unit.replace(/\s+/gu, ' ')) === unitKey(sought.replace(/\s+/gu, ' '));
}

function isCount(clause: string, question: RegExpExecArray, context: QuantityContext): string[] {
  const sought = question[1]!, auxiliary = question[2]!, rest = question[3]!;
  const location = countLocation.exec(auxiliaryVerb.test(auxiliary) ? rest : `${auxiliary} ${rest}`);
  const explicitAction = /^(?:do|does|did|can|could|will|would)$/iu.test(auxiliary) ? /^(.*?)\s+(\p{L}+)(?:\s+(?:in total|altogether))?$/iu.exec(rest) : null;
  if (/^there(?:$|\s)/iu.test(rest) && !location) return [];
  const subject = location?.[1] ?? explicitAction?.[1] ?? rest.replace(/^(?:in|on|at|within|of|belonging to)\s+/iu, '');
  if (!scoped(subject, clause, context)) return [];
  const askedAction = explicitAction?.[2]?.toLowerCase();
  const distinctAction = askedAction && !possessionVerb.test(askedAction) ? askedAction : undefined;
  const spans = [...quantitySpans(clause, sought.split(/\s+/u).length)].filter(span => unitMatches(span.groups!.unit!, sought));
  if (spans.length > 1 && new Set(spans.map(span => span.groups!.amount!.toLowerCase())).size > 1) return [];
  const found: string[] = [];
  for (const span of spans) {
    const before = clause.slice(0, span.index);
    const after = clause.slice(span.index! + span[0].length);
    if (/^\s*(?:per\b|\/|fewer\b|more (?:than|were)\b)/iu.test(after) || /\b(?:not|never|no)\s*$/iu.test(before)) continue;
    const prefix = before.trimEnd().replace(/\s+(?:(?:a |the )?total of|an estimated)\s*$/iu, '');
    const existence = existential.exec(prefix);
    const located = /^\s*(?:in|on|at|within)\s+(.*)$/iu.exec(after);
    const setting = /^\s*(?:in|on|at|within)\s+(.+?),?\s*$/iu.exec(prefix.slice(0, existence?.index));
    if (existence && (setting && consecutiveSubject(subject, setting[1]!) || located && mentions(content(subject), located[1]!))) {
      if (!askedAction || /^(?:live|reside|exist|have)$/u.test(askedAction)) found.push(span[0]);
      continue;
    }
    const predicate = distinctAction ? /\p{L}+$/u.exec(prefix) : countConnection.exec(prefix);
    if (!predicate || distinctAction && !mentionsRelation(distinctAction, predicate[0])) continue;
    if (ownsPredicate(subject, prefix.slice(0, predicate.index), context)) found.push(span[0]);
  }
  return found;
}

function measured(clause: string, question: string, context: QuantityContext): string[] {
  const asked = /^how (long|tall|wide|deep|far|heavy|old)\s+(?:is|are|was|were|does|did|do)\s+(.+)$/iu.exec(question);
  if (!asked) return [];
  const kind = asked[1]!.toLowerCase(), rest = asked[2]!;
  const duration = kind === 'long';
  const action = duration ? /^(.*?)\s+(last|take|run|air|continue|remain|operate|persist)(?:\s+for)?$/iu.exec(rest) : null;
  if (duration && !action) return [];
  const subject = action?.[1] ?? rest;
  if (!scoped(subject, clause, context)) return [];
  const units = duration ? timeUnit : dimensionUnits[kind]!;
  const result: string[] = [];
  for (const span of quantitySpans(clause, 1)) {
    if (!units.test(unitKey(span.groups!.unit!))) continue;
    const before = clause.slice(0, span.index);
    const after = clause.slice(span.index! + span[0].length);
    if (/^\s*(?:per\b|\/|ago\b|later\b)/iu.test(after) || /\b(?:not|never|no)\s*$/iu.test(before)) continue;
    if (duration) {
      const predicate = /\b(\p{L}+)(?:\s+(?:for|in|within|roughly|approximately|a total of))?\s*$/iu.exec(before);
      if (predicate && mentionsRelation(action![2]!, predicate[1]!) && ownsPredicate(subject, before.slice(0, predicate.index), context)) result.push(span[0]);
      continue;
    }
    const predicate = /\b(?:is|are|was|were|stands?|stood|measures?|measured|reaches?|reached|extends?|extended|spans?|weighs?|weighed)(?:\s+(?:at|to))?\s*$/iu.exec(before);
    if (predicate && dimensionRelation[kind]!.test(`${predicate[0]} ${after.slice(0, 30)}`) && ownsPredicate(subject, before.slice(0, predicate.index), context)) result.push(span[0]);
  }
  return result;
}

/** Return an unambiguous quantity with its original unit, range and qualification. */
export function extractEnglishQuantity(question: string, quote: string, context: QuantityContext = {}): string | undefined {
  const asked = question.trim().replace(/[.!?]+$/u, '').replace(/\s+/gu, ' ');
  const count = countQuestion.exec(asked);
  const clauses = quote.split(/\s*(?:[;!?]|\.(?=\s|\[\d)|,?\s+\b(?:but|whereas|while)\b)\s*/iu)
    .map(clause => clause.replace(/^(?:\[\d+(?:,\s*\d+)*\]\s*)+/u, '').trim());
  const values = clauses.flatMap(clause => count ? isCount(clause, count, context) : measured(clause, asked, context));
  const unique = new Map(values.map(value => [value.toLowerCase().replace(/\s+/gu, ' '), value]));
  return unique.size === 1 ? unique.values().next().value : undefined;
}
