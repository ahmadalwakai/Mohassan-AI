import type { DeliberationReview as ReviewRecord, ReviewFindingCode } from '@mohassan/contracts';
import { analyzeCompoundRequest, type PendingActionKind } from '../compound-request.js';
import { shorterAnswer, shorterRequest } from '../answer-reshape.js';
import { textLanguage } from '../answer-check.js';
import { entitySurface, entityWords, fold } from '../hands.js';
import { projectInventoryFormat } from '../inventory.js';
import { judge, ownLines, pageKey, sourceUrls, type JudgeEvidence } from '../judge.js';
import { sequenceParts } from '../local-sequence.js';
import { requestLanguage, splitReplyDirective, type ReplyField } from '../reply-directive.js';
import type { TaskCompletionReview } from '../task-supervisor.js';
import type { WebSequenceAnswer } from '../web-sequence.js';
import type { Interpretation } from './types.js';

export type { ReviewFindingCode, ReviewRecord };

type ReplyStatus = 'completed' | 'partial' | 'blocked';
export interface DeliberationReviewInput {
  request: string;
  reading?: Pick<Interpretation, 'request' | 'entity' | 'scope'> | null;
  decision: 'act' | 'ask' | 'abstain';
  reply: string;
  status: ReplyStatus;
  previousRequest?: string | null;
  evidence?: readonly JudgeEvidence[];
  completion?: TaskCompletionReview | null;
  parts?: readonly WebSequenceAnswer[];
  /** The caller already used the guarded alternative-source repair path. */
  readRevision?: readonly ReviewFindingCode[];
  /** Publication revalidates this exact reply against a tool receipt or answer hash. */
  protectedReply?: boolean;
}

interface Part { request: string; action?: PendingActionKind }

function partsOf(body: string): Part[] {
  const sequence = sequenceParts(body);
  if (sequence) return sequence.map(request => ({ request }));
  const compound = analyzeCompoundRequest(body);
  if (compound.kind === 'compound') {
    return [{ request: compound.primary.text }, ...compound.pendingActions.map(action => ({ request: action.text, action: action.kind }))];
  }
  return [{ request: body }];
}

const comparable = (text: string) => fold(text).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const contains = (text: string, phrase: string) => Boolean(phrase && ` ${text} `.includes(` ${phrase} `));
const prose = (reply: string) => ownLines(reply).map(line => line.text).join('\n');
const partKey = (request: string) => comparable(splitReplyDirective(request).body);

const fieldPatterns: Record<ReplyField, RegExp> = {
  title: /^\s*(?:\*\*)?(?:page title|عنوان الصفحة)\s*:\s*(?:\*\*)?\s*[^\s*]/imu,
  link: /https?:\/\/[^\s<>()]+/iu,
  heading: /^\s*(?:\*\*)?(?:main heading|العنوان الرئيسي)\s*:\s*(?:\*\*)?\s*(?:[^\s*]|\n\s*>\s*\S)/imu,
  first_sentence: /^\s*(?:\*\*)?(?:first sentence(?: on the page)?|أول جملة(?: في الصفحة)?|الجملة الأولى)\s*:\s*(?:\*\*)?\s*(?:[^\s*]|\n\s*>\s*\S)/imu,
};

function sentenceCount(text: string, lang: 'ar' | 'en'): number {
  const sentences = new Intl.Segmenter(lang, { granularity: 'sentence' }).segment(text);
  return [...sentences].filter(({ segment }) => /[\p{L}\p{N}]/u.test(segment)).length;
}

function acceptsJson(request: string, reply: string): boolean {
  let parsed: unknown;
  try { parsed = JSON.parse(reply); } catch { return false; }
  const format = projectInventoryFormat(request);
  if (format?.kind !== 'json') {
    if (/\bjson\s+array\b|مصفوفة\s+json\b/iu.test(request)) return Array.isArray(parsed);
    if (/\bjson\s+object\b|كائن\s+json\b/iu.test(request)) return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
    return true;
  }
  if (format.shape === 'names') return Array.isArray(parsed) && parsed.every(item => typeof item === 'string');
  const row = (item: unknown) => item !== null && typeof item === 'object' && !Array.isArray(item)
    && Object.keys(item).length === format.fields.length
    && format.fields.every(({ key }) => Object.hasOwn(item, key) && typeof (item as Record<string, unknown>)[key] === 'string');
  return format.shape === 'object' ? row(parsed) : Array.isArray(parsed) && parsed.every(row);
}

const wantsJson = (request: string) => projectInventoryFormat(request)?.kind === 'json'
  || /\b(?:as|in|only|return|output)\s+(?:(?:raw|valid|a|an)\s+){0,2}json\b|(?:بصيغة|فقط)\s+json\b/iu.test(request);
const jsonFence = /^\s*```(?:json)?\s*\n([\s\S]*?)\n```\s*$/iu;

function entityMismatch({ reading, evidence, reply, completion }: DeliberationReviewInput): boolean {
  if (completion?.criteria.some(criterion => criterion.reason === 'target_mismatch')) return true;
  if (reading?.scope !== 'public' || !reading.entity) return false;
  const urls = sourceUrls(reply);
  if (!urls.length) return false;
  const namedUrl = URL.parse(reading.entity);
  if (namedUrl && ['http:', 'https:'].includes(namedUrl.protocol)) return !urls.includes(pageKey(namedUrl.href));
  const requested = splitReplyDirective(reading.request).body;
  const entity = entitySurface(requested, entityWords(requested));
  // Request context can carry a whole topic such as “many people live in Japan”.
  // Only compare a named entity or a short explicit name with the delivered source.
  const name = entity && entity.split(/\s+/u).length <= 4 ? entity
    : /^[\p{L}\p{N}-]+$|^\p{Lu}\p{L}*(?:\s+\p{Lu}\p{L}*){1,3}$/u.test(reading.entity) ? reading.entity : '';
  const subject = comparable(name);
  if (!subject || subject.length < 3) return false;
  const observed = evidence?.filter(item => item.url && urls.includes(pageKey(item.url))).map(item => item.title ?? '') ?? [];
  return !contains(comparable([reply, ...observed].join(' ')), subject);
}

const effectCriteria: Partial<Record<PendingActionKind, readonly string[]>> = {
  save: ['computed-memory-save'], open: ['navigation'], change: ['effect'],
};

function answeredCount(input: DeliberationReviewInput, parts: readonly Part[]): number {
  if (input.status === 'blocked' || !input.reply.trim()) return 0;
  if (parts.length === 1) return input.status === 'completed' ? 1 : 0;
  const text = comparable(input.reply);
  if (input.parts) {
    const available = [...input.parts];
    return parts.filter(part => {
      const index = available.findIndex(answer => partKey(answer.request) === partKey(part.request));
      if (index < 0) return false;
      const [answer] = available.splice(index, 1);
      return answer!.status === 'completed' && contains(text, comparable(answer!.text));
    }).length;
  }
  const headings = input.reply.split(/\n\s*\n/u).flatMap(section => {
    const [, heading, answer] = /^\*\*([^\n]+)\*\*\s*\n([\s\S]+)$/u.exec(section) ?? [];
    return heading && answer?.trim() ? [partKey(heading)] : [];
  });
  const verified = new Set(input.completion?.criteria.filter(criterion => criterion.status === 'verified').map(criterion => criterion.id));
  return parts.filter((part, index) => {
    if (part.action) {
      const criterion = effectCriteria[part.action]?.find(id => verified.has(id));
      if (!criterion) return false;
      verified.delete(criterion);
      return true;
    }
    const heading = headings.indexOf(partKey(part.request));
    if (heading < 0) return !index && !headings.length && input.status === 'completed';
    headings.splice(heading, 1);
    return true;
  }).length;
}

function inspect(input: DeliberationReviewInput) {
  const { request, reply, status } = input;
  const findings = new Set<ReviewFindingCode>();
  if (input.decision !== 'act') {
    if (!reply.trim() || status === 'completed' || input.decision === 'ask' && (reply.match(/[?؟]/gu)?.length ?? 0) !== 1) {
      findings.add('decision_mismatch');
    }
    return { checkedParts: 0, answeredParts: 0, findings: [...findings], fixedReply: null };
  }

  const { body, directive } = splitReplyDirective(request);
  const parts = partsOf(body);
  const answeredParts = answeredCount(input, parts);
  if (!reply.trim() || answeredParts < parts.length) findings.add(parts.length > 1 || !reply.trim() ? 'missing_part' : 'unverified_part');
  if (input.completion?.criteria.some(criterion => criterion.required
    && (criterion.status === 'failed' || criterion.reason === 'answer_changed'))) findings.add('unverified_part');

  let fixedReply: string | null = null;
  if (reply.trim() && status === 'completed') {
    const question = splitReplyDirective(input.reading?.request ?? request).body;
    if (parts.length === 1) {
      const sources = sourceUrls(reply);
      const evidence = input.evidence?.filter(item => !item.url || sources.includes(pageKey(item.url)));
      const verdict = judge({ question, reply, status, previous: input.previousRequest, evidence: evidence?.length ? evidence : undefined });
      if (verdict.findings.some(finding => finding.code === 'page_subject_mismatch'
        || finding.code === 'subject_missing' && finding.severity === 'block') || entityMismatch(input)) findings.add('wrong_entity');
      if (verdict.findings.some(finding => finding.code === 'unsupported_sentence')) findings.add('unsupported_answer');
      if (verdict.findings.some(finding => finding.severity === 'block'
        && ['lead_off_topic', 'lead_needs_number', 'lead_meta', 'duration_unit_missing'].includes(finding.code))) findings.add('unverified_part');
      fixedReply = verdict.fixedReply;
    }

    const shorter = shorterRequest(request);
    const sentences = directive?.sentences ?? shorter?.sentences;
    const lang = directive?.lang ?? shorter?.lang;
    const partWithDirective = directive && input.parts?.find(part => splitReplyDirective(part.request).directive?.text === directive.text);
    const formattedReply = partWithDirective ? partWithDirective.text : reply;
    const text = prose(formattedReply);
    const observedLanguage = textLanguage(text);
    const onlyOtherScript = lang === 'ar' ? /[a-z]/iu.test(text) && !/\p{Script=Arabic}/u.test(text)
      : /\p{Script=Arabic}/u.test(text) && !/[a-z]/iu.test(text);
    if (lang && (observedLanguage !== 'none' ? observedLanguage !== lang : onlyOtherScript)) findings.add('format_language');
    if (sentences && sentenceCount(text, lang ?? requestLanguage(request)) !== sentences) findings.add('format_sentences');
    if (directive?.brief && text.split(/\s+/u).length > 60) findings.add('format_brief');
    if (directive?.fields?.some(field => !fieldPatterns[field].test(formattedReply))) findings.add('format_fields');
    if (wantsJson(body) && !acceptsJson(body, reply)) findings.add('format_json');
  }
  return { checkedParts: parts.length, answeredParts, findings: [...findings], fixedReply };
}

function revisedFormat(input: DeliberationReviewInput, observed: ReturnType<typeof inspect>): string | null {
  let text = observed.fixedReply ?? input.reply;
  if (observed.findings.includes('format_json')) text = jsonFence.exec(text)?.[1]?.trim() ?? text;
  if (observed.checkedParts === 1 && (observed.findings.includes('format_sentences') || observed.findings.includes('format_brief'))) {
    const { directive } = splitReplyDirective(input.request);
    const shorter = shorterRequest(input.request);
    text = shorterAnswer(text, {
      sentences: directive?.sentences ?? shorter?.sentences ?? 1, lang: directive?.lang ?? shorter?.lang ?? requestLanguage(input.request),
    }) ?? text;
  }
  return text === input.reply ? null : text;
}

/** Follow the existing public-read repair path only with evidence of an answer defect. */
export function deliberationReadFindings(input: DeliberationReviewInput): ReviewFindingCode[] | null {
  if (input.decision !== 'act' || input.status !== 'completed') return null;
  const findings = inspect(input).findings.filter(code => code === 'wrong_entity' || code === 'unsupported_answer'
    || code === 'unverified_part' || code === 'format_language');
  return findings.length ? findings : null;
}

/** One mechanical revision from already available material, or one guarded read revision owned by the caller. */
export function reviewDeliberationResult(input: DeliberationReviewInput, apply: boolean): { text: string; status: ReplyStatus; record: ReviewRecord } {
  const initial = inspect(input);
  let reviewed = initial, text = input.reply, status = input.status;
  let revision: ReviewRecord['revision'] = input.readRevision ? 'read' : 'none';
  if (apply && input.decision === 'act' && status === 'completed') {
    if (!input.protectedReply && revision === 'none' && initial.findings.length) {
      const replacement = revisedFormat(input, initial);
      if (replacement) {
        revision = 'format';
        const checked = inspect({ ...input, reply: replacement });
        if (checked.answeredParts >= initial.answeredParts && checked.findings.length < initial.findings.length
          && checked.findings.every(code => initial.findings.includes(code))) {
          reviewed = checked;
          text = replacement;
        }
      }
    }
    if (reviewed.findings.length) {
      status = 'partial';
      if (!input.protectedReply && (reviewed.findings.includes('wrong_entity') || reviewed.findings.includes('unsupported_answer'))) {
        text = requestLanguage(input.request) === 'ar' ? 'لم أتمكن من التحقق من جواب يطابق طلبك.' : 'I could not verify an answer that matches your request.';
      }
    }
  }
  return { text, status, record: { checkedParts: reviewed.checkedParts, answeredParts: reviewed.answeredParts,
    initialFindings: input.readRevision ? [...input.readRevision] : initial.findings, findings: reviewed.findings, revision } };
}
