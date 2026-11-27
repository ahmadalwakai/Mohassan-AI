import { explicitFactualRecord, factualPassage, type FactualPassage } from './factual-evidence.js';
import { MEDICAL_NOTE, MEDICAL_NOTE_EN } from './hands.js';
import type { JudgeEvidence } from './judge.js';
import { matchText } from './mind/normalize.js';
import { isPageInstruction } from './mind/extract.js';
import {
  buildTruthQuestion, checkTruthQuestion, entityMention, namedAnswers, placeAnswers, placeValue, quantityCanAnswer, questionQuantities, sameAskedEntity,
  type QuestionFinding, type TruthAnswerType, type TruthQuestion,
} from './truth-agreement-question.js';
import {
  extractQuantities, labelledConversion, supportsQuantity, type Quantity,
} from './truth-agreement-quantities.js';

// Ported span matching from PR #27, retrieved 2026-11-27.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/7eb3713c42a1/apps/server/src/assistant/truth-agreement.ts
export type TruthFinding = QuestionFinding | 'unsupported_claim';

export interface TruthFragment {
  text: string;
  answering: boolean;
  finding: TruthFinding | null;
  supportingUrls: string[];
}

export interface TruthInspection {
  answerType: TruthAnswerType;
  fragments: TruthFragment[];
  supportedAnswer: boolean;
}

const SPLIT = /(?:[.!؟?؛;]+(?=\s|$)|\r?\n+)/gu;
const ABBREVIATION = /(?:\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|etc|vs|No|Inc|Ltd|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)|(?:^|\s)[A-Z])\.$/u;
const FOOTNOTE = /\[(?:\d{1,3}|[a-z]|[ا-ي]|note \d+|ملاحظة \d+|ملحوظة \d+)\]/giu;
const LINK = /!?\[([^\]\n]*)\]\([^\s\n)]+\)/gu;
const MARKDOWN_SOURCE = String.raw`\[[^\]\n]+\]\(https?:\/\/(?:[^()\s]|\([^()\s]*\))+\)`;
const SOURCE_LAYOUT = new RegExp(String.raw`^\s*\*\*(?:المصدر|Source):\*\*\s+${MARKDOWN_SOURCE}(?: · (?:read|قُرئت) \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC)?\s*$`, 'u');
const LINK_LAYOUT = new RegExp(String.raw`^\s*\*\*(?:للمزيد|See also|مصدر ثانٍ يؤكد|A second source agrees):\*\*\s+${MARKDOWN_SOURCE}(?: · ${MARKDOWN_SOURCE})*\s*$`, 'u');
const SOURCE_ADDRESS = /^\s*\*\*(?:رابط المصدر|Source link):\*\*\s+https?:\/\/[^\s]+\s*$/u;
const COUNCIL_SOURCE = /^\s*(?:المصدر|Source):\s+(.+)\s*$/u;
const COUNCIL_FOOTER = /^— (?:جواب «نموذج القراءة v3» \(تجريبي: F1 ‏18٪ بالعربية و26٪ بالإنجليزية على XQuAD\)|Answer from the reading model v3 \(experimental; F1 18% Arabic, 26% English on XQuAD\))$/u;
const PAGE_TITLE = /^\s*\*\*(?:عنوان الصفحة|Page title):\*\*\s+([^\n]+?)\s*$/u;
const PAGE_FRAME = /^\s*(?:من|From)\s+\*\*([^*\n]+)\*\*\s+\([^\s()]+\):\s*$/u;
const PAGE_LINK_FRAME = new RegExp('^\\s*(?:من|From)\\s+' + MARKDOWN_SOURCE + ':\\s*$', 'u');
const DETAILS_HEADING = /^\s*\*\*(?:تفاصيل أخرى من نفس المصدر|More from the same source):\*\*\s*$/u;
const SOURCE_NOTE = /^(?:لم أتحقق من هذا الرقم في مصدر ثانٍ\.|I did not check this figure against a second source\.|وفق مصدر واحد:|According to one source:)$/u;
const SAFETY_NOTES = new Set([MEDICAL_NOTE, MEDICAL_NOTE_EN, 'For diagnosis and treatment, see a doctor.', 'للتشخيص والعلاج راجع طبيبًا مختصًا.']);

export function isTruthSafetyNote(line: string): boolean {
  return SAFETY_NOTES.has(line.trim());
}

const QUALIFIER = /\b(?:about|approximately|nearly|almost|around|over|under|at least|at most|more than|less than|up to|between|estimated|projected|expected|forecast|unconfirmed|during|until|as of|according to the \d{4})\b|(?:حوالي|نحو|قرابه|تقريبا|علي الاقل|علي الاكثر|اكثر من|اقل من|ما بين|تقديرا|يقدر|تقديري|متوقع|يتوقع|منذ|حتي|اعتبارا من|حسب احصاء)/u;
const DATE_SCOPE = /(?:\b(?:as of|in|for|during|at|since|until|by)\s+(?:the year\s+)?|(?:في|عام|سنه|حتي|منذ|اعتبارا من)\s*)$/u;
const SOURCE_ATTRIBUTION = /^(?:according to (?:the )?(?:source|page)|in the (?:minutes|register|archive|record)|(?:وفقا|وفق|حسب) (?:المصدر|الصفحه))[,:،\s]+/iu;
const REPRESENTATION = /^(?:on behalf of|نيابه عن)\s+[^,،.!?؟]+$/u;
const CONVERSION_PREFIX = /^(?:conversion|converted|تحويل|بعد التحويل)\s*[:：]\s*/iu;
const CONVERSION_SUFFIX = /\s*\((?:conversion|converted|تحويل|بعد التحويل|تحويلا)(?:\s+(?:from|من)\s+([^()]+))?\)\s*[.!؟?]?$/iu;

interface Passage {
  text: string;
  key: string;
  skeleton: string;
  quantities: Quantity[];
  answering: boolean;
  page: JudgeEvidence;
}

function clean(text: string): string {
  return text.replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/gu, '').replace(LINK, '$1')
    .replace(FOOTNOTE, ' ').replace(/^\s*(?:>|[-*•]\s|\d+[.)]\s+)\s*/u, '').replace(/\*\*|__/gu, '')
    .replace(/\s+/gu, ' ').trim();
}

/** Punctuation used in a sentence is not a separator inside decimals, dates, or common abbreviations. */
function sentences(input: string): string[] {
  const results: string[] = [];
  let start = 0;
  for (const hit of input.matchAll(SPLIT)) {
    const end = hit.index + hit[0].length;
    const item = input.slice(start, end).trim();
    if (ABBREVIATION.test(item) && !/\n/u.test(hit[0])) continue;
    if (item) results.push(item);
    start = end;
  }
  if (input.slice(start).trim()) results.push(input.slice(start).trim());
  return results;
}

function councilBoilerplate(line: string, pages: readonly JudgeEvidence[]): boolean {
  if (COUNCIL_FOOTER.test(line.trim())) return true;
  const source = COUNCIL_SOURCE.exec(line)?.[1]?.trim();
  return Boolean(source && pages.some(page => [page.title, page.url].filter(Boolean).join(' — ') === source));
}

function replySentences(reply: string, pages: readonly JudgeEvidence[], extracted: ReadonlySet<string>): string[] {
  return reply.split(/\r?\n/u).filter(line => {
    if (isTruthSafetyNote(line) || SOURCE_NOTE.test(line.trim()) || DETAILS_HEADING.test(line)
      || SOURCE_LAYOUT.test(line) || LINK_LAYOUT.test(line) || SOURCE_ADDRESS.test(line) || PAGE_LINK_FRAME.test(line)
      || councilBoilerplate(line, pages)) return false;
    const title = PAGE_TITLE.exec(line)?.[1] ?? PAGE_FRAME.exec(line)?.[1];
    return !title || !pages.some(page => page.title?.trim() === title.trim());
  }).flatMap(line => extracted.has(key(clean(line))) ? [line] : sentences(line)).map(clean).filter(Boolean);
}

function key(text: string): string {
  return matchText(text).replace(/[’‘]/gu, "'").replace(/[“”«»]/gu, '').replace(/[.!؟?؛;]+$/u, '')
    .replace(/\s+/gu, ' ').trim();
}

/** The placeholder preserves the positions of figures, so another clause's figures cannot match by value alone. */
function skeleton(text: string, quantities: readonly Quantity[]): string {
  let result = '';
  let offset = 0;
  for (const quantity of quantities) {
    result += `${text.slice(offset, quantity.start)} <${quantity.kind}> `;
    offset = quantity.end;
  }
  return key(result + text.slice(offset));
}

function passage(text: string, page: JudgeEvidence, asked: TruthQuestion): Passage {
  const quantities = questionQuantities(text, asked);
  return {
    text, key: key(text), skeleton: skeleton(text, quantities), quantities,
    answering: checkTruthQuestion(text, quantities, asked, sameAskedEntity(asked, page.title)) === null, page,
  };
}

interface Conversion {
  text: string;
  original: Quantity | null;
  originalUnitOnly: boolean;
}

function conversion(text: string): Conversion | null {
  if (CONVERSION_PREFIX.test(text)) return { text: text.replace(CONVERSION_PREFIX, ''), original: null, originalUnitOnly: false };
  const suffix = CONVERSION_SUFFIX.exec(matchText(text));
  if (!suffix) return null;
  const body = text.slice(0, text.lastIndexOf('(')).trimEnd();
  const origin = suffix[1]?.trim();
  if (!origin) return { text: body, original: null, originalUnitOnly: false };
  for (const [description, unitOnly] of [[origin, false], [`1 ${origin}`, true]] as const) {
    const values = extractQuantities(description);
    const value = values[0];
    if (values.length === 1 && value?.kind === 'number' && value.unit && value.start === 0 && value.end === description.length) {
      return { text: body, original: value, originalUnitOnly: unitOnly };
    }
  }
  return null;
}

function verifiedConversion(text: string, claim: Quantity, evidence: Quantity): boolean {
  const annotation = conversion(text);
  if (!annotation) return labelledConversion(text, claim, evidence);
  if (annotation.original && (annotation.original.unit !== evidence.unit
    || !annotation.originalUnitOnly && !supportsQuantity(annotation.original, evidence))) return false;
  const label = 'conversion: ';
  const literal = `${claim.value} ${claim.unit ?? ''}`;
  return labelledConversion(label + literal, { ...claim, start: label.length, end: label.length + literal.length }, evidence);
}

function conversionClues(reply: string, item: Passage, asked: TruthQuestion): boolean {
  const annotation = conversion(reply);
  const text = annotation?.text ?? reply;
  const quantities = questionQuantities(text, asked);
  return quantities.length === item.quantities.length
    && quantities.every((quantity, index) => supportsQuantity(quantity, item.quantities[index]!) || verifiedConversion(reply, quantity, item.quantities[index]!))
    && quantities.some((quantity, index) => !supportsQuantity(quantity, item.quantities[index]!) && verifiedConversion(reply, quantity, item.quantities[index]!))
    && skeleton(text, quantities) === item.skeleton;
}

function sameAssertion(text: string, quantities: readonly Quantity[], item: Passage, asked: TruthQuestion): boolean {
  const comparable = key(text).replace(SOURCE_ATTRIBUTION, '');
  // Check quantity spans even on equal folded text to keep precision, units, and signs intact.
  const sameFigures = quantities.length === item.quantities.length
    && quantities.every((quantity, index) => supportsQuantity(quantity, item.quantities[index]!));
  const quoted = item.key.replace(SOURCE_ATTRIBUTION, '');
  if (sameFigures && (comparable === quoted || skeleton(text, quantities).replace(SOURCE_ATTRIBUTION, '') === item.skeleton)) return true;
  if (sameFigures && quoted.startsWith(`${comparable} `) && REPRESENTATION.test(quoted.slice(comparable.length + 1))) return true;
  if (asked.count && countFromList(quoted, comparable, quantities, item)) return true;
  return conversion(text) !== null && conversionClues(text, item, asked);
}

function countFromList(quoted: string, claim: string, quantities: readonly Quantity[], evidence: Passage): boolean {
  if (quantities.length !== 1 || evidence.quantities.length !== 2 || quantities[0]?.kind !== 'number') return false;
  const value = quantities[0];
  const [first, next] = evidence.quantities;
  if (!first?.unit || !next || first.unit === next.unit || !supportsQuantity(value, first)) return false;
  if (!quoted.startsWith(`${claim} `) || QUALIFIER.test(quoted)) return false;
  const rest = quoted.slice(claim.length + 1);
  return /^(?:and\s+|و\s*)[+-]?\d/u.test(rest)
    && (next.unit !== null || /^\s+[\p{L}\p{M}]+(?:\s|$)/u.test(evidence.text.slice(next.end)));
}

function shortValue(text: string, quantities: readonly Quantity[]): Quantity | null {
  if (quantities.length !== 1) return null;
  const value = quantities[0]!;
  const rest = key(`${text.slice(0, value.start)} ${text.slice(value.end)}`).replace(CONVERSION_PREFIX, '').trim();
  return /^(?:(?:in|on|في|عام|سنه|about|on about|around|approximately|قرابه|حوالي|نحو|تقريبا)\s*)?$/u.test(rest) ? value : null;
}

function shortName(text: string, item: Passage, asked: TruthQuestion): boolean {
  if (asked.answerType !== 'person' || asked.identity || extractQuantities(text).length || key(text).split(/\s+/u).length > 7) return false;
  const candidate = key(text).replace(/^(?:by|هو|هي)\s+/u, '');
  return namedAnswers(item.text, asked).some(value => key(value) === candidate)
    && !entityMention(candidate, asked.entity);
}

function normalizedScope(text: string): string[] {
  return extractQuantities(text)
    .filter(value => value.kind === 'date' && DATE_SCOPE.test(matchText(text.slice(0, value.start))))
    .map(value => value.value);
}

function scopeCompatible(left: string, right: string, matchingDate: boolean): boolean {
  const a = key(left);
  const b = key(right);
  const qa = a.match(QUALIFIER)?.[0] ?? null;
  const qb = b.match(QUALIFIER)?.[0] ?? null;
  if (qa !== qb) return false;
  if (matchingDate) return true;
  const aYears = normalizedScope(a);
  const bYears = normalizedScope(b);
  return aYears.length === bYears.length && aYears.every((year, index) => year === bYears[index]);
}

function shortAnswer(text: string, quantities: readonly Quantity[], item: Passage, asked: TruthQuestion): boolean {
  if (!item.answering) return false;
  if (shortName(text, item, asked)) return true;
  if (asked.answerType === 'place') return placeAnswers(item.text, asked).some(place => key(place) === key(text));
  const claim = shortValue(text, quantities);
  if (!claim || claim.kind !== asked.answerType || !scopeCompatible(text, item.text, claim.kind === 'date')) return false;
  return item.quantities.some(value => quantityCanAnswer(item.text, value, asked)
    && (supportsQuantity(claim, value) || verifiedConversion(text, claim, value)));
}

function recordHasAnswer(record: FactualPassage, asked: TruthQuestion): boolean {
  const value = clean(record.value);
  if (asked.answerType === 'place') return placeValue(value);
  if (asked.answerType === 'person') {
    const name = value.replace(/\.$/u, '');
    if (/\p{Nd}|\b(?:unknown|none|nobody|unconfirmed)\b|مجهول|غير معروف/u.test(matchText(name))) return false;
    const spelling = /\p{Script=Arabic}/u.test(name)
      ? /^[\p{Script=Arabic}\p{M}\s-]+$/u
      : /^(?:\p{Lu}[\p{L}\p{M}'’.-]*(?:[ ,]+(?:(?:and|de|del|van|von|da|di|of|the) +)*\p{Lu}[\p{L}\p{M}'’.-]*)*)$/u;
    return spelling.test(name) && name.split(/\s+/u).length <= 12;
  }
  const typed = questionQuantities(value, asked);
  if (asked.answerType === 'number') return /^\p{Nd}+[.!؟]?$/u.test(value) || typed.some(quantity => quantity.kind === 'number'
    && (!asked.count || quantity.unit === (asked.countUnit ?? asked.count)));
  return typed.some(quantity => quantity.kind === 'date') || /\b(?:\d{1,4}\s+(?:BCE|BC|CE|AD)|(?:\d{1,2}(?:st|nd|rd|th)|\p{L}+) century)\b/iu.test(value);
}

/**
 * Check the quoted assertion as a whole, then check which question it answers. A bare answer can only inherit
 * context from a grounded passage of the requested type. Additional clauses keep their own evidence and figures.
 */
export function inspectTruth(question: string, reply: string, evidence: readonly JudgeEvidence[]): TruthInspection {
  const asked = buildTruthQuestion(question);
  if (!asked.answerType) return { answerType: null, fragments: [], supportedAnswer: false };
  const pages = evidence.filter(item => item.kind === 'page' && item.text.trim());
  const extracted = new Map<string, string[]>();
  for (const page of pages) {
    const record = explicitFactualRecord(page.text, asked.text);
    const answer = record?.kind === 'answer' ? record
      : !record && page.title ? factualPassage({ text: page.text, title: page.title }, asked.text) : undefined;
    if (!answer || !recordHasAnswer(answer, asked)) continue;
    for (const part of [answer.quote, answer.value]) {
      const identity = key(clean(part));
      extracted.set(identity, [...(extracted.get(identity) ?? []), ...(page.url ? [page.url] : [])]);
    }
  }
  const replyParts = replySentences(reply, pages, new Set(extracted.keys()));
  const replyKeys = new Set(replyParts.map(key));
  const replyCandidates = [...replyKeys].map(text => text.replace(SOURCE_ATTRIBUTION, ''));
  const passages = pages.flatMap(page => {
    const knownTitle = sameAskedEntity(asked, page.title);
    return sentences(page.text).map(clean).filter(text => text && !isPageInstruction(text)
      && (replyKeys.has(key(text)) || knownTitle || asked.entity.length > 0 && entityMention(text, asked.entity)
        || extractCandidate(text, replyCandidates))).map(text => passage(text, page, asked));
  });
  const fragments = replyParts.map((text, index): TruthFragment => {
    const extractedUrls = extracted.get(key(text));
    if (extractedUrls) return { text, answering: true, finding: null, supportingUrls: [...new Set(extractedUrls)] };
    const quantities = questionQuantities(text, asked);
    const matches = passages.filter(item => sameAssertion(text, quantities, item, asked) || shortAnswer(text, quantities, item, asked));
    const body = conversion(text)?.text ?? text;
    const bodyQuantities = questionQuantities(body, asked);
    const direct = matches.some(item => item.answering
      && (checkTruthQuestion(body, bodyQuantities, asked, sameAskedEntity(asked, item.page.title)) === null || shortAnswer(text, quantities, item, asked)));
    const problem = checkTruthQuestion(text, quantities, asked, false);
    const answering = direct;
    const finding = matches.length === 0 ? problem ?? 'unsupported_claim' : index === 0 && !answering ? problem ?? 'wrong_relation' : null;
    return {
      text, answering, finding, supportingUrls: [...new Set(matches.flatMap(item => item.page.url ? [item.page.url] : []))],
    };
  });
  return { answerType: asked.answerType, fragments, supportedAnswer: fragments.some(item => item.answering) };
}

/** Non-answer details may carry a source attribution or omit an on-behalf-of phrase. */
function extractCandidate(text: string, fragments: readonly string[]): boolean {
  const source = key(text).replace(SOURCE_ATTRIBUTION, '');
  return fragments.some(candidate => source === candidate || source.startsWith(candidate + ' '));
}
