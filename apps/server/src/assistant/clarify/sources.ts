import type { SearchHit } from '@mohassan/browser';
import { redactCredentialText } from '@mohassan/cognitive';
import { isDisambiguationPage, isDisambiguationTitle, isMetaLine } from '../answer-check.js';
import { emptyConversationState, understandTurn } from '../conversation-state.js';
import { plainTitle } from '../hands.js';
import { matchText, normalizeRequest } from '../mind/normalize.js';
import type { MemoryLookupResult } from '../tools.js';

export type ClarificationKind = 'entity' | 'date' | 'account' | 'file';
export interface ClarificationCandidate {
  label: string;
  value: string;
  score: number;
  source: 'conversation' | 'search' | 'memory';
  kind: ClarificationKind;
  private?: true;
}

interface SourceInput {
  text: string;
  reference?: string | null;
  kind: ClarificationKind;
}

interface ConversationSourceInput extends SourceInput {
  /** Oldest first, including only turns that precede this request. */
  history: readonly { role: string; text: string }[];
}

export interface ClarificationPage {
  url: string;
  title: string;
  text: string;
  status: number;
  links?: readonly string[];
}

interface LookupSourceInput extends SourceInput {
  ownerId: string;
  signal: AbortSignal;
  /** These ports are supplied only when the current request permits the read. */
  search?: (query: string, limit: number, signal: AbortSignal) => Promise<readonly SearchHit[]>;
  readPage?: (url: string, signal: AbortSignal) => Promise<ClarificationPage | 'disallowed' | null>;
  memory?: (ownerId: string, query: string) => Promise<MemoryLookupResult>;
}

const MAX_LABEL = 120;
const MAX_CANDIDATES_PER_SOURCE = 8;
const LOOKUP_TIMEOUT_MS = 2500;
const MAX_HISTORY = 8;
const PRIMARY_REFERENCE = /^(?:what (?:do you know|can you tell me) about|(?:can|could|would) you (?:please )?tell me about|tell me about|give me (?:some )?information (?:on|about)|look up|search (?:the web )?for|what about|what(?:'s|’s| is| are)|who(?:'s|’s| is| are)|(?:ماذا|ما) (?:تعرف|تعلم) عن|(?:هل )?يمكنك [أا]ن (?:تخبرني|تحدثني) عن|(?:أخبرني|اخبرني|حدثني|حدّثني|كلمني|احك(?:ِ|ي)? لي) عن|(?:أعطني|اعطني|هات) معلومات عن|ابحث عن|(?:ما|ماذا) عن|ما (?:هو|هي)|من (?:هو|هي))\s+(.+)$/iu;
const OWNER_REFERENCE = /^(?:what did (?:i|we) (?:tell|mention to) you about|what do you remember about|(?:ماذا|ما الذي) (?:[أا]خبرتك به|قلته لك|قلت لك|تتذكره) عن)\s+(.+)$/iu;
const EMPTY_NAME = /^(?:it|this|that|them|one|something|anything|the (?:same|one|file|account)|none|this (?:time|week)|هذا|هذه|ذلك|تلك|شيء|نفسه|نفسها|الملف|الحساب|المقصود)$/iu;
const UNSAFE_LABEL = /[<>;؛?!؟]|https?:\/\/|\b[\w.%+-]+@[\w.-]+\.[a-z]{2,}\b|\b(?:ignore|disregard|override)\s+(?:all |previous |prior )?(?:instructions?|rules?)\b|تجاهل\s+(?:كل\s+)?(?:التعليمات|القواعد)|^(?:ignore|disregard|forget|follow|execute|override|run|delete|send|click|type|open|تجاهل|انس|اتبع|نفذ|شغل|احذف|ارسل|انقر|اكتب|افتح)(?!\p{L})/iu;
const DESCRIPTOR = /\s+\(([^()]{1,70})\)$|[،,]\s+([^،,]{1,70})$|\s+(?:the|الـ)\s+([^،,]{1,50})$/iu;
const PERSON_QUESTION = /^(?:who(?:'s|’s| is| are)|من (?:هو|هي))(?!\p{L})/iu;
const PLACE_TYPE = /(?<!\p{L})(?:capital|city|town|village|district|province|river|mountain|island|مدينة|عاصمة|قرية|محافظة|نهر|جزيرة)(?!\p{L})/iu;
const FILE = /(?<![\p{L}\p{N}._-])(?:[\p{L}\p{N}][\p{L}\p{N}_.-]{0,75}\.(?:pdf|docx?|xlsx?|pptx?|txt|csv|json|md))(?![\p{L}\p{N}_-]|\.[\p{L}\p{N}_-])/giu;
const QUOTED_FILE = /["“«]([^"”»\r\n]{1,100}\.(?:pdf|docx?|xlsx?|pptx?|txt|csv|json|md))["”»]/giu;
const DATE = /\b\d{4}-\d{2}-\d{2}\b|(?<![\p{L}\p{N}])(?:Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?|(?:الأحد|الاحد|الاثنين|الإثنين|الثلاثاء|الأربعاء|الاربعاء|الخميس|الجمعة|السبت))(?!\p{L})/giu;
const ACCOUNT = /\b(?:my|our|the)\s+([\p{L}\p{N}][\p{L}\p{N}_-]{0,50})\s+account\b|(?<!\p{L})(?:account(?: name)?|اسم الحساب)\s*[:=]\s*([^\r\n،,;؛]{1,70})|(?<!\p{L})حساب\s+(?:(?:ال)?(?:عمل|شخصي|شركة|شرك[هة])|[«“"][^»”"]{1,70}[»”"])(?!\p{L})/giu;

function key(value: string): string {
  return matchText(value).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function includesName(value: string, name: string): boolean {
  const phrase = key(name);
  return Boolean(phrase) && ` ${key(value)} `.includes(` ${phrase} `);
}

function matchesVariant(value: string, reference: string): boolean {
  const name = key(reference), label = key(value);
  return label.startsWith(`${name} `) || label.endsWith(` ${name}`);
}

function labelOf(value: string): string | null {
  if (/[\p{Cc}\p{Cf}]/u.test(value)) return null;
  const label = value.trim().replace(/^["“«]+|["”»]+$/gu, '').replace(/\s{2,}/gu, ' ').trim();
  return label.length > 0 && label.length <= MAX_LABEL && /[\p{L}\p{N}]/u.test(label)
    && !UNSAFE_LABEL.test(label) && !EMPTY_NAME.test(label) && redactCredentialText(label) === label ? label : null;
}

function candidate(value: string, kind: ClarificationKind, source: ClarificationCandidate['source'], score: number, privateValue = false): ClarificationCandidate | null {
  const label = labelOf(value);
  return label ? { label, value: label, source, kind, score, ...(privateValue ? { private: true } : {}) } : null;
}

function entityLabel(value: string): string | null {
  const label = labelOf(value);
  return label && label.split(/\s+/u).length <= 9
    && !/^(?:my|our|remember|please|احفظ|تذكر|هذا|هذه|تلك)(?!\p{L})|\b(?:said|wants?|should|would|is|was|were)\b/iu.test(label) ? label : null;
}

function placeDescription(value: string): boolean {
  return PLACE_TYPE.test(DESCRIPTOR.exec(value)?.[0] ?? '');
}

/** Subject of a narrow request for information, spelled in this turn by the owner. */
export function clarificationEntityReference(text: string): string | null {
  const request = normalizeRequest(text).text.replace(/[.?!؟]+$/gu, '').trim();
  const written = (OWNER_REFERENCE.exec(request) ?? PRIMARY_REFERENCE.exec(request))?.[1];
  const name = written ? labelOf(written) : null;
  return name && name.length <= 85 && name.split(/\s+/u).length <= 6
    && !/\b(?:and|or|but|then)\b|(?<!\p{L})(?:أو|او|ثم)(?!\p{L})/iu.test(name) ? name : null;
}

function typedValues(text: string, kind: Exclude<ClarificationKind, 'entity'>): string[] {
  switch (kind) {
    case 'date': return [...text.matchAll(DATE)].map(match => match[0]);
    case 'file': {
      const quoted = [...text.matchAll(QUOTED_FILE)].map(match => match[1]);
      const unquoted = [...text.replace(QUOTED_FILE, ' ').matchAll(FILE)].map(match => match[0]);
      return [...quoted, ...unquoted];
    }
    case 'account': return [...text.matchAll(ACCOUNT)].map(match => match[1] ?? match[2] ?? match[0]);
  }
}

function unique(candidates: readonly (ClarificationCandidate | null)[]): ClarificationCandidate[] {
  const values = new Map<string, ClarificationCandidate>();
  for (const item of candidates) {
    if (!item) continue;
    const id = key(item.value);
    if ((values.get(id)?.score ?? -1) < item.score) values.set(id, item);
  }
  return [...values.values()].sort((a, b) => b.score - a.score).slice(0, MAX_CANDIDATES_PER_SOURCE);
}

/** Conversation candidates come from preceding owner turns and the current explicit subject. */
export function conversationClarificationCandidates(input: ConversationSourceInput): ClarificationCandidate[] {
  const { kind, text } = input;
  const { reference = clarificationEntityReference(text) } = input;
  const personQuestion = kind === 'entity' && PERSON_QUESTION.test(normalizeRequest(text).text);
  const candidates: (ClarificationCandidate | null)[] = [];
  if (kind === 'entity' && reference && DESCRIPTOR.test(reference)) {
    candidates.push(candidate(reference, kind, 'conversation', 0.97));
  }
  const turns = input.history.filter(turn => turn.role === 'user').slice(-MAX_HISTORY);
  let conversation = emptyConversationState();
  for (const [index, turn] of turns.entries()) {
    if (turn.text.length > 8000) continue;
    const score = 0.85 - (turns.length - index - 1) * 0.015;
    if (kind !== 'entity') {
      candidates.push(...typedValues(turn.text, kind).map(value => candidate(value, kind, 'conversation', score)));
      continue;
    }
    const understanding = understandTurn(conversation, turn.text, `clarification-history-${index}`);
    conversation = understanding.next;
    const privateValue = understanding.v1.sourceAssessment?.publicQueryEligible !== true;
    const known = clarificationEntityReference(turn.text) ?? (understanding.type === 'new_request' || understanding.type === 'topic_change' ? understanding.entity : null);
    if (known && entityLabel(known) && (!reference || matchesVariant(known, reference))) {
      candidates.push(candidate(known, kind, 'conversation', score, privateValue));
    }
    if (!reference) continue;
    for (const mention of turn.text.split(/\s+(?:and|or|أو|او|ثم)\s+|[\r\n]+/iu)) {
      const label = labelOf(mention);
      if (label && key(label).startsWith(`${key(reference)} `) && DESCRIPTOR.test(label)) {
        candidates.push(candidate(label, kind, 'conversation', score, privateValue));
      }
    }
  }
  return unique(candidates).filter(item => !personQuestion || !placeDescription(item.value));
}

function pageUrl(raw: string): URL | null {
  const page = URL.parse(raw);
  return page && /^https?:$/u.test(page.protocol) && !page.username && !page.password ? page : null;
}

function articleTitle(page: URL, link: string): string | null {
  if (link.length > 1024) return null;
  const url = URL.parse(link, page);
  if (!url || url.origin !== page.origin || url.search || !url.pathname.startsWith('/wiki/')) return null;
  try {
    const title = decodeURIComponent(url.pathname.slice('/wiki/'.length)).replaceAll('_', ' ');
    return !/[:/]/u.test(title) ? labelOf(title) : null;
  } catch { return null; }
}

function qualifiedPrimaryTitle(title: string, body: string): string | null {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const opening = /(?:is|was|هي|هو)\s+|[،,]\s+/u.source;
  const specification = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}\\s*(?:${opening})((?:(?:the|an?)\\s+)?(?:[\\p{L}-]+\\s+){0,3}${PLACE_TYPE.source}(?:\\s+(?:of|in|في)\\s+[\\p{L}][\\p{L} \\-]{0,30})?)`, 'iu');
  const detail = specification.exec(body)?.[1]?.trim();
  return detail ? labelOf(`${title} (${detail})`) : null;
}

function pageLabels(page: ClarificationPage, reference: string, hits: readonly SearchHit[], personQuestion: boolean): string[] {
  const base = pageUrl(page.url);
  if (!base || page.status < 200 || page.status >= 300 || !isDisambiguationPage(page)) return [];
  const body = page.text.slice(0, 12_000);
  const linked = (page.links ?? []).slice(0, 100).map(link => articleTitle(base, link)).filter((title): title is string => Boolean(title));
  const matchingHits = hits.filter(hit => pageUrl(hit.url)?.origin === base.origin).map(hit => plainTitle(hit.title));
  const listed = body.split(/\r?\n/u).flatMap(line => {
    const bullet = /^\s*(?:[-*•]|\d{1,2}[.)])\s+(.{1,240})$/u.exec(line)?.[1];
    if (!bullet) return [];
    const label = bullet.split(/\s+[–—-]\s+|,\s+(?=(?:a|an|the|هو|هي)\s)/iu, 1)[0];
    return labelOf(label) ? [label] : [];
  });
  const normalizedBody = ` ${key(body)} `, anchor = key(reference), pageName = key(plainTitle(page.title));
  return [...linked, ...matchingHits, ...listed].flatMap(title => {
    const label = entityLabel(title), titleKey = key(title);
    if (!label || isDisambiguationTitle(title) || isMetaLine(title) || titleKey === pageName
      || !normalizedBody.includes(` ${titleKey} `)) return [];
    const geographic = titleKey === anchor || personQuestion ? qualifiedPrimaryTitle(label, body) : null;
    if (personQuestion && (placeDescription(label) || geographic)) return [];
    const variant = titleKey === anchor ? geographic : includesName(title, reference) ? label : null;
    return variant ? [variant] : [];
  });
}

/** Use an actual listed variant, not merely similarly named search results. */
async function publicCandidates(input: LookupSourceInput, signal: AbortSignal): Promise<ClarificationCandidate[]> {
  const { reference = clarificationEntityReference(input.text) } = input;
  if (input.kind !== 'entity' || !reference || !input.search || !input.readPage || DESCRIPTOR.test(reference) || !includesName(input.text, reference)) return [];
  const hits = (await input.search(reference, 6, signal)).slice(0, 6);
  const personQuestion = PERSON_QUESTION.test(normalizeRequest(input.text).text);
  const disambiguation = hits.filter(hit => pageUrl(hit.url)
    && includesName(plainTitle(hit.title), reference) && isDisambiguationPage({ title: hit.title, text: hit.snippet })).slice(0, 2);
  const sources = await Promise.all(disambiguation.map(async hit => {
    const page = await input.readPage?.(hit.url, signal).catch(() => null);
    return page && page !== 'disallowed' && pageUrl(page.url)?.origin === pageUrl(hit.url)?.origin
      ? pageLabels(page, reference, hits, personQuestion)
      : [];
  }));
  return unique(sources.flat().map(label => candidate(label, 'entity', 'search', 0.79)));
}

async function memoryCandidates(input: LookupSourceInput): Promise<ClarificationCandidate[]> {
  if (!input.memory) return [];
  const { reference = clarificationEntityReference(input.text) } = input;
  const fallback = /\p{Script=Arabic}/u.test(input.text)
    ? { account: 'حساب', file: 'ملف', date: 'تاريخ' }
    : { account: 'account', file: 'file', date: 'date' };
  const query = labelOf(reference ?? '') ?? (input.kind === 'entity' ? null : fallback[input.kind]);
  if (!query) return [];
  const result = await input.memory(input.ownerId, query);
  if (typeof result === 'string') return [];
  const candidates = result.evidence.slice(0, 8).flatMap(note => note.slice(0, 2000).split(/\r?\n/u).flatMap(line => {
    if (input.kind !== 'entity') return typedValues(line, input.kind);
    const label = /^(?:name|entity|subject|الاسم|الجهة|الموضوع)\s*[:=]\s*(.+)$/iu.exec(line.trim())?.[1] ?? line;
    return reference && includesName(label, reference) && key(label) !== key(reference) && DESCRIPTOR.test(label) ? [label] : [];
  }));
  return unique(candidates.map(label => candidate(label, input.kind, 'memory', 0.82)));
}

/** A slow or unavailable lookup leaves other evidence usable. */
async function boundedRead<T>(signal: AbortSignal, read: () => Promise<T>): Promise<T | null> {
  if (signal.aborted) return null;
  let stop: (() => void) | undefined;
  try {
    const aborted = new Promise<null>(resolve => {
      stop = () => resolve(null);
      signal.addEventListener('abort', stop, { once: true });
    });
    return await Promise.race([aborted, read()]);
  } catch { return null; }
  finally { if (stop) signal.removeEventListener('abort', stop); }
}

export async function lookupClarificationCandidates(input: LookupSourceInput): Promise<ClarificationCandidate[]> {
  const lookupSignal = AbortSignal.any([input.signal, AbortSignal.timeout(LOOKUP_TIMEOUT_MS)]);
  const [search, memory] = await Promise.all([
    boundedRead(lookupSignal, () => publicCandidates(input, lookupSignal)),
    boundedRead(lookupSignal, () => memoryCandidates(input)),
  ]);
  input.signal.throwIfAborted();
  return [...(search ?? []), ...(memory ?? [])];
}
