import { publicSearchText } from '@mohassan/browser';
import { isMetaLine } from './answer-check.js';
import { explicitFactualEvidence } from './factual-evidence.js';
import {
  comparisonAttributesIn, isConditionalComparisonAttribute, mentionsComparisonSubject, normalizeComparisonText, type ParsedComparisonQuestion,
} from './comparison-question.js';
import { isPageInstruction } from './mind/extract.js';

export interface ComparisonEvidence { text: string; title?: string; url?: string }

interface Condition { relation: string; terms: string[] }

interface ComparisonPassage<T extends ComparisonEvidence> {
  evidence: T;
  text: string;
  subjects: string[];
  attributes: string[];
  conditions: Condition[];
}

const sentences = new Intl.Segmenter(undefined, { granularity: 'sentence' });
const contextMarker = /(?<![\p{L}\p{N}])(?:as of|depending on|depends? on|var(?:y|ies|ied) (?:by|with|according to)|when|whenever|if|unless|under|during|before|after|since|per|given|using|for|with|on|in|اعتبارا من|عند(?:ما)?|حين(?:ما)?|اذا|لو|الا اذا|حسب|بحسب|وفقا ل|تبعا ل|يعتمد علي|تختلف (?:حسب|باختلاف)|في حال(?:ه)?|في|علي|خلال|قبل|بعد|منذ|لكل|مع)(?![\p{L}\p{N}])/gu;
const conditionEdge = /[,،;؛!?؟]|(?<!\p{L})(?:while|whereas|but|بينما|لكن)(?!\p{L})/u;
const conditionGrammar = /^(?:the|a|an|and|or|it|is|are|be|its|of|to|by|more|less|than|there|الذي|التي|هو|هي|ذلك|هذه|هذا|ال|ان|او|و|من|في|علي)$/u;
const noConcreteContext = /^(?:both|them|all|each|comparison|general|average|المتوسط|المقارنه|العموم|الجميع)$/u;
const conditionContinuation = /^(?:(?:the )?(?:results?|prices?|costs?|performance|speed|comparison|findings?|measurements?|these (?:results?|measurements?))\s+(?:(?:can|may|will)\s+)?(?:var(?:y|ies)|depends?|change[sd]?|appl(?:y|ies)|(?:we(?:re)? )?measured|(?:was|were) measured)|(?:و?تختلف|و?يتغير|و?تتغير|و?يعتمد|و?تعتمد)\s+(?:ال)?(?:النتائج|الاسعار|التكلفه|الاداء|السرعه)|(?:و?تختلف|و?يتغير|و?تتغير|و?يعتمد|و?تعتمد)\s+(?:حسب|باختلاف|على)|(?:النتائج|الاسعار|الاداء|السرعه)\s+(?:تختلف|يتغير|تتغير|يعتمد|تعتمد))/u;
const markdownLink = /\[([^\]\n]*)\]\((https?:\/\/[^)\s]+)\)/gu;
const sourceLine = /^\s*(?:\*\*)?(?:Sources?|المصادر?|Source link|رابط المصدر)\s*:/iu;
const layoutLine = /^\s*(?:\*\*)?(?:See also|للمزيد|Page title|عنوان الصفحة)\s*:/iu;
const partialLead = /^(?:\*\*)?(?:Partial answer|إجابة جزئية)\s*:/iu;
const questionEcho = /^(?:Q(?:uestion)?|You asked(?: me)?|(?:ال)?سؤال|سألت(?:ني)?)\s*[:：]/iu;
const questionLabel = /(?<!\p{L})(?:question|q|(?:ال)?س[ؤو]ال|س)\s*[:：]/iu;
const answerLabel = /(?<!\p{L})(?:answer|a|(?:ال)?[إأا]جاب[ةه]|(?:ال)?جواب|ج)\s*[:：]/giu;
const disputedChoice = /(?<!\p{L})(?:not|never|perhaps|possibly|probably|maybe|rather|ليس|ليست|ربما|المحتمل)(?!\p{L})/u;

const contextTerms = (text: string) => (normalizeComparisonText(text).match(/[\p{L}\p{N}]+/gu) ?? [])
  .filter(word => !conditionGrammar.test(word));

function conditionRelation(marker: string): string {
  if (/^(?:before|قبل)$/u.test(marker)) return 'before';
  if (/^(?:after|بعد)$/u.test(marker)) return 'after';
  if (/^(?:since|منذ)$/u.test(marker)) return 'since';
  if (/^(?:as of|اعتبارا من)$/u.test(marker)) return 'as of';
  if (/^(?:unless|الا اذا)$/u.test(marker)) return 'unless';
  if (/^(?:per|لكل)$/u.test(marker)) return 'per';
  return 'context';
}

function conditionsIn(text: string, comparison: ParsedComparisonQuestion): Condition[] {
  const normalized = normalizeComparisonText(text);
  const markers = [...normalized.matchAll(contextMarker)];
  return markers.flatMap((marker, index) => {
    const start = marker.index + marker[0].length;
    const phrase = normalized.slice(start, markers[index + 1]?.index).split(conditionEdge, 1)[0]!.trim();
    if (!phrase || comparison.subjects.some(subject => normalizeComparisonText(subject) === phrase.replace(/[.!]+$/u, ''))) return [];
    const terms = [...new Set(contextTerms(phrase))];
    if (!terms.length || terms.every(term => noConcreteContext.test(term))) return [];
    return [{ relation: conditionRelation(marker[0]), terms }];
  });
}

function pieces(text: string): string[] {
  return text.split(/\r?\n/u).flatMap(line => [...sentences.segment(line)]
    .map(({ segment }) => segment.trim().replace(/\s+/gu, ' ')).filter(Boolean));
}

function isObservation(text: string): boolean {
  return !/[?؟]$/u.test(text) && !questionEcho.test(text) && !isMetaLine(text) && !isPageInstruction(text);
}

/** A single choice in an exact, labeled Q&A can state an ordering for a stable attribute. */
function choiceRecord<T extends ComparisonEvidence>(comparison: ParsedComparisonQuestion, evidence: T, text: string): ComparisonPassage<T> | undefined {
  if (comparison.attribute.conditionSensitive || comparison.attribute.key === 'general') return;
  const record = explicitFactualEvidence({ text, signals: { captcha: false, password: false, otp: false, card: false } }, comparison.question);
  if (record?.kind !== 'answer') return;
  const labels = [...record.quote.matchAll(answerLabel)];
  const label = labels.at(-1);
  if (!label) return;
  const value = normalizeComparisonText(record.quote.slice(label.index + label[0].length)).replace(/[.!]+$/u, '');
  if (!/^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N}.'() -]*$/u.test(value) || disputedChoice.test(value)
    || comparison.subjects.filter(subject => mentionsComparisonSubject(value, subject)).length !== 1) return;
  return { evidence, text: record.quote, subjects: [...comparison.subjects], attributes: [comparison.attribute.key], conditions: [] };
}

function evidencePassages<T extends ComparisonEvidence>(comparison: ParsedComparisonQuestion, evidence: T): ComparisonPassage<T>[] {
  const passages: ComparisonPassage<T>[] = [];
  let previous: ComparisonPassage<T> | undefined;
  const text = evidence.text.slice(0, 200_000);
  if (!comparison.subjects.some(subject => mentionsComparisonSubject(text, subject))) return passages;
  const record = questionLabel.test(text) ? choiceRecord(comparison, evidence, text) : undefined;
  if (record) passages.push(record);
  for (const piece of pieces(text)) {
    if (piece.length > 550 || !isObservation(piece) || publicSearchText(piece) !== piece) {
      previous = undefined;
      continue;
    }
    const subjects = comparison.subjects.filter(subject => mentionsComparisonSubject(piece, subject));
    const attributes = comparisonAttributesIn(comparison, piece);
    const conditions = comparison.attribute.conditionSensitive || comparison.attribute.key === 'general' ? conditionsIn(piece, comparison) : [];
    if (subjects.length && attributes.length) {
      previous = { evidence, text: piece, subjects, attributes, conditions };
      passages.push(previous);
    } else if (previous && conditions.length && conditionContinuation.test(normalizeComparisonText(piece))) {
      previous.text += ` ${piece}`;
      previous.conditions.push(...conditions);
    } else previous = undefined;
  }
  return passages;
}

/** The read passages that attach a comparison attribute to at least one of the subjects. */
export function comparisonEvidencePassages<T extends ComparisonEvidence>(comparison: ParsedComparisonQuestion, evidence: readonly T[]): ComparisonPassage<T>[] {
  return evidence.flatMap(item => evidencePassages(comparison, item));
}

function sourceKey(url: string): string {
  const parsed = URL.parse(url);
  if (!parsed) return url;
  parsed.hash = '';
  parsed.search = '';
  return parsed.href.replace(/\/$/u, '');
}

function checkedEvidence<T extends ComparisonEvidence>(reply: string, evidence: readonly T[]): T[] {
  const links = new Set(reply.split('\n').filter(line => sourceLine.test(line))
    .flatMap(line => [...line.matchAll(markdownLink)].map(match => sourceKey(match[2]!))));
  if (!links.size || !evidence.some(item => item.url)) return [...evidence];
  return evidence.filter(item => item.url && links.has(sourceKey(item.url)));
}

function sharedAttributes(subjects: readonly string[], parts: readonly { subjects: string[]; attributes: string[] }[]): string[] {
  const first = new Set(parts.filter(part => part.subjects.includes(subjects[0]!)).flatMap(part => part.attributes));
  return [...new Set(parts.filter(part => part.subjects.includes(subjects[1]!)).flatMap(part => part.attributes))]
    .filter(attribute => first.has(attribute));
}

export interface ComparisonCompleteness {
  complete: boolean;
  missingEvidenceSubjects: string[];
  missingReplySubjects: string[];
  missingAttribute: boolean;
  missingConditions: boolean;
}

/** Use with the actual evidence supplied to the answer, including any cited page text. */
export function checkComparisonCompleteness(
  comparison: ParsedComparisonQuestion, reply: string, evidence: readonly ComparisonEvidence[],
): ComparisonCompleteness {
  const replyText = reply.split('\n').filter(line => !sourceLine.test(line) && !layoutLine.test(line) && !partialLead.test(line.trim()))
    .map(line => line.replace(markdownLink, '$1').replace(/https?:\/\/\S+/gu, '').replace(/^\s*(?:>|[-*•])\s*/u, '')).join('\n');
  const replyParts = pieces(replyText).filter(isObservation);
  const replyObservations = replyParts.map(text => ({
    subjects: comparison.subjects.filter(subject => mentionsComparisonSubject(text, subject)),
    attributes: comparisonAttributesIn(comparison, text),
  }));
  const presentedEvidence = checkedEvidence(reply, evidence);
  const passages = comparisonEvidencePassages(comparison, presentedEvidence);
  const contiguousReply = replyText.replace(/\s+/gu, ' ').trim();
  for (const passage of passages) {
    if (questionEcho.test(passage.text) && contiguousReply.includes(passage.text)) replyObservations.push(passage);
  }
  const replyAttributes = sharedAttributes(comparison.subjects, replyObservations);
  const comparableAttributes = sharedAttributes(comparison.subjects, passages).filter(attribute => replyAttributes.includes(attribute));
  const missingEvidenceSubjects = comparison.subjects.filter(subject => !passages.some(passage => passage.subjects.includes(subject)));
  const missingReplySubjects = comparison.subjects.filter(subject => !replyObservations.some(part => part.subjects.includes(subject)));
  const missingAttribute = comparableAttributes.length === 0;
  const replyConditions = replyParts.flatMap(line => conditionsIn(line, comparison)).map(condition => ({ ...condition, terms: new Set(condition.terms) }));
  const missingConditions = comparableAttributes.some(attribute => {
    if (!comparison.attribute.conditionSensitive && !isConditionalComparisonAttribute(attribute)) return false;
    const conditions = passages.filter(passage => passage.attributes.includes(attribute)).flatMap(passage => passage.conditions);
    return !conditions.length || conditions.some(condition => !replyConditions.some(stated => stated.relation === condition.relation
      && condition.terms.every(term => stated.terms.has(term))));
  });
  return {
    complete: !missingEvidenceSubjects.length && !missingReplySubjects.length && !missingAttribute && !missingConditions,
    missingEvidenceSubjects, missingReplySubjects, missingAttribute, missingConditions,
  };
}

export function isComparisonPartialReply(reply: string): boolean {
  return partialLead.test(reply.trimStart());
}

export function comparisonPartialReply(comparison: ParsedComparisonQuestion, lang: 'ar' | 'en'): string {
  const [left, right] = comparison.subjects;
  const dimension = comparison.attribute.key === 'general' ? '' : lang === 'ar'
    ? ` من حيث ${comparison.attribute.label.ar}` : ` for ${comparison.attribute.label.en}`;
  return lang === 'ar' ? `إجابة جزئية: لم أجد مصدراً يقارن «${left}» و«${right}»${dimension} بصورة تكفي للإجابة.`
    : `Partial answer: I did not find enough evidence comparing “${left}” and “${right}”${dimension}.`;
}
