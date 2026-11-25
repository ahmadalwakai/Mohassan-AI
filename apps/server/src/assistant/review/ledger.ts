import {
  commitmentDisposition, extractClaims, extractCommitments, extractCorrections, extractPreferences,
  isPreferenceOnly, normalizeReviewText, rejectsAnswer, replyClauses, reviewTokens, splitRequest,
  type Claim, type Commitment, type Correction, type Preference, type RequestPart,
} from './language.js';

export {
  commitmentDisposition, extractClaims, extractCommitments, extractCorrections, extractPreferences,
  normalizeReviewText, reviewTokens, splitRequest,
} from './language.js';
export type { Claim, Commitment, Correction, Preference, RequestPart } from './language.js';

export interface ReviewMessage {
  id?: string;
  role: 'user' | 'assistant';
  content: string;
}

export interface RejectedAnswer extends RequestPart {
  answerIndex: number;
  feedback: string;
}

export interface ConversationLedger {
  messages: readonly ReviewMessage[];
  currentRequestIndex: number;
  requests: RequestPart[];
  claims: Claim[];
  userClaims: Claim[];
  commitments: Commitment[];
  corrections: Correction[];
  preferences: Preference[];
  rejectedAnswers: RejectedAnswer[];
  summary?: ConversationSummary;
}

export interface ConversationSummary {
  version: 1;
  messageCount: number;
  throughMessageId?: string;
  decisions: Claim[];
  openRequests: RequestPart[];
  commitments: Commitment[];
  preferences: Preference[];
}

export const SUMMARY_MIN_MESSAGES = 24;
export const SUMMARY_MAX_BYTES = 16_384;
const SUMMARY_ENTRIES = 12;
const SUMMARY_TEXT_LIMIT = 350;
const TEXT_ENCODER = new TextEncoder();

function preferenceKey(preference: Preference): string {
  return preference.kind === 'avoid' ? 'avoid:' + normalizeReviewText(preference.value) : preference.kind;
}

const CANCEL = /^(?:never mind|forget (?:it|that)|cancel|(?:please )?(?:do not|don['’]t)\s+|لا داعي|لا (?:ترسل|ترفع|تكمل|تتابع|تضف|تحفظ)|الغ|الغي|الغاء|انس(?:ى)?)(?!\p{L})/iu;

function cancelledByUser(commitment: Commitment, userText: string): boolean {
  const folded = userText.trim().normalize('NFKC').replace(/[أإآ]/gu, 'ا');
  const cancellation = CANCEL.exec(folded);
  if (!cancellation) return false;
  const object = normalizeReviewText(folded.slice(cancellation[0].length));
  return Boolean(object && normalizeReviewText(commitment.action).includes(object));
}

export function buildConversationLedger(messages: readonly ReviewMessage[], summary?: ConversationSummary): ConversationLedger {
  const ledger: ConversationLedger = {
    messages, currentRequestIndex: -1, requests: [], claims: [], userClaims: [], commitments: [],
    corrections: [], preferences: [], rejectedAnswers: [],
  };
  const preferences = new Map<string, Preference>();
  let latestAssistantIndex = -1;
  let latestRejectedIndex = -1;
  messages.forEach(({ role, content }, index) => {
    if (role === 'assistant') {
      latestAssistantIndex = index;
      ledger.claims.push(...extractClaims(content, index));
      ledger.commitments = ledger.commitments.filter(item => commitmentDisposition(item, content) !== 'kept');
      for (const promise of extractCommitments(content, index)) {
        const key = normalizeReviewText(promise.action);
        if (key && !ledger.commitments.some(item => normalizeReviewText(item.action) === key)) ledger.commitments.push(promise);
      }
      return;
    }
    ledger.currentRequestIndex = index;
    ledger.userClaims.push(...extractClaims(content, index));
    const lastAnswer = messages[latestAssistantIndex]?.content;
    const corrections = extractCorrections(content, index, lastAnswer);
    const userPreferences = extractPreferences(content, index);
    for (const part of splitRequest(content, index)) {
      const partKey = normalizeReviewText(part.text);
      const wholeTurn = part.text === content.trim();
      const recordPreferences = wholeTurn ? userPreferences : userPreferences.filter(item => normalizeReviewText(item.text) === partKey);
      const feedbackOnly = corrections.some(item => normalizeReviewText(item.text) === partKey);
      if (!feedbackOnly && !rejectsAnswer(part.text)
        && !isPreferenceOnly(part.text, wholeTurn || recordPreferences.length ? recordPreferences : undefined)) ledger.requests.push(part);
    }
    ledger.corrections.push(...corrections);
    if (lastAnswer && latestRejectedIndex !== latestAssistantIndex && (rejectsAnswer(content) || corrections.some(item => item.before))) {
      ledger.rejectedAnswers.push({ text: lastAnswer, messageIndex: index, answerIndex: latestAssistantIndex, feedback: content });
      latestRejectedIndex = latestAssistantIndex;
    }
    for (const preference of userPreferences) {
      const key = preferenceKey(preference);
      const previous = preferences.get(key);
      const alias = preference.kind === 'name' ? preference.alias
        ?? (previous?.value === preference.value ? previous.alias : previous?.value) : undefined;
      preferences.delete(key);
      preferences.set(key, alias && alias !== preference.value ? { ...preference, alias } : preference);
    }
    ledger.commitments = ledger.commitments.filter(item => !cancelledByUser(item, content));
  });
  ledger.preferences = [...preferences.values()];

  // Stored summaries may lag by a turn. Accept only one tied to a retained
  // message so a reset, deleted transcript, or another conversation cannot seed retrieval.
  if (summary && validSummary(summary, messages)) ledger.summary = summary;
  return ledger;
}

function validSummary(summary: ConversationSummary, messages: readonly ReviewMessage[]): boolean {
  const count = summary.messageCount;
  if (summary.version !== 1 || !Number.isSafeInteger(count) || count < 1 || count > messages.length
    || typeof summary.throughMessageId !== 'string' || !summary.throughMessageId
    || messages[count - 1]?.id !== summary.throughMessageId) return false;
  const entries = <T extends RequestPart>(values: T[], role: ReviewMessage['role'], fields: (value: T) => boolean) =>
    Array.isArray(values) && values.length <= SUMMARY_ENTRIES && values.every(value =>
      value && typeof value.text === 'string' && value.text.length <= SUMMARY_TEXT_LIMIT
      && Number.isSafeInteger(value.messageIndex) && value.messageIndex >= 0 && value.messageIndex < count
      && messages[value.messageIndex]?.role === role && fields(value));
  return entries(summary.decisions, 'assistant', value =>
    value.kind === 'decision' && typeof value.subject === 'string' && typeof value.value === 'string')
    && entries(summary.openRequests, 'user', () => true)
    && entries(summary.commitments, 'assistant', value => typeof value.action === 'string')
    && entries(summary.preferences, 'user', value =>
      ['name', 'language', 'length', 'format', 'units', 'avoid'].includes(value.kind) && typeof value.value === 'string'
      && (value.alias === undefined || typeof value.alias === 'string')
      && (value.limit === undefined || ['words', 'sentences', 'lines'].includes(value.limit)));
}

const REQUEST_STOP = new Set(['what', 'when', 'where', 'who', 'which', 'why', 'how', 'could', 'can', 'would', 'please',
  'tell', 'show', 'list', 'provide', 'include', 'give', 'explain', 'describe', 'i', 'me', 'you', 'we', 'it', 'a', 'an',
  'the', 'is', 'are', 'and', 'or', 'of', 'for', 'in', 'on', 'to', 'on', 'with', 'that', 'this',
  'ما', 'ماذا', 'متي', 'اين', 'من', 'كم', 'كيف', 'اي', 'هل', 'لماذا', 'اعطني', 'اذكر', 'قدم', 'اخبرني', 'و', 'اشرح',
  'اعرض', 'صف', 'ان', 'عن', 'في', 'الي', 'مع', 'هو', 'هي', 'هذا', 'هذه']);

function topicWords(text: string): string[] {
  return reviewTokens(text).filter(token => !REQUEST_STOP.has(token)).map(token => token.replace(/^ال(?=\p{L}{3,})/u, ''));
}

const DEFERRED = /(?:\b(?:cannot|can t|could not|couldn t|unable|pending|unconfirmed|unavailable|unknown|not yet|no information|must wait|need more|will|we need)\b|(?:^|\s)(?:لم|لن|لا يمكن|لا استطيع|غير متاح|غير مؤكد|غير معروف|يحتاج|ناقص|سوف)(?:\s|$))/u;

function openRequestParts(ledger: ConversationLedger, published?: ReviewMessage): RequestPart[] {
  const anchor = ledger.summary?.messageCount ?? 0;
  const historicalAnswerRejected = ledger.rejectedAnswers.some(answer => answer.messageIndex >= anchor && answer.answerIndex < anchor);
  const checkpoint = historicalAnswerRejected ? undefined : ledger.summary;
  const start = checkpoint?.messageCount ?? 0;
  const open = new Map<RequestPart, string[]>((checkpoint?.openRequests ?? []).map(part => [part, topicWords(part.text)]));
  const rejected = new Set(ledger.rejectedAnswers.map(reply => reply.answerIndex));
  const requests = ledger.requests.filter(part => part.messageIndex >= start);
  let requestIndex = 0;
  for (let index = start; index <= ledger.messages.length; index++) {
    const message = ledger.messages[index] ?? published;
    if (!message) break;
    if (message.role === 'user') {
      while (requests[requestIndex]?.messageIndex === index) {
        const part = requests[requestIndex++]!;
        open.set(part, topicWords(part.text));
      }
      continue;
    }
    if (!open.size || rejected.has(index)) continue;
    const clauses = replyClauses(message.content).filter(clause => !DEFERRED.test(normalizeReviewText(clause)))
      .map(clause => new Set(topicWords(clause)));
    for (const [part, topics] of open) {
      if (clauses.some(words => topics.filter(word => words.has(word)).length >= Math.max(1, Math.ceil(topics.length * 0.6)))) open.delete(part);
    }
  }
  return [...open.keys()];
}

function extractiveEntries<T extends RequestPart>(values: readonly T[]): T[] {
  return values.filter(value => Object.values(value).every(field => typeof field !== 'string' || field.length <= SUMMARY_TEXT_LIMIT))
    .slice(-SUMMARY_ENTRIES);
}

export function buildConversationSummary(ledger: ConversationLedger, published?: ReviewMessage): ConversationSummary {
  const messageCount = ledger.messages.length + Number(Boolean(published));
  const throughMessageId = (published ?? ledger.messages.at(-1))?.id;
  const latestDecisions = new Map<string, Claim>();
  const additionalClaims = published?.role === 'assistant' ? extractClaims(published.content, messageCount - 1) : [];
  for (const claim of [...ledger.claims, ...additionalClaims]) {
    if (claim.kind !== 'decision') continue;
    latestDecisions.delete(claim.subject);
    latestDecisions.set(claim.subject, claim);
  }

  const commitments = published?.role === 'assistant'
    ? [...ledger.commitments.filter(item => commitmentDisposition(item, published.content) !== 'kept'),
      ...extractCommitments(published.content, messageCount - 1)]
    : ledger.commitments;
  const summary: ConversationSummary = {
    version: 1, messageCount, ...(throughMessageId && throughMessageId.length <= 128 ? { throughMessageId } : {}),
    decisions: extractiveEntries([...latestDecisions.values()]),
    openRequests: extractiveEntries(openRequestParts(ledger, published)),
    commitments: extractiveEntries(commitments),
    preferences: extractiveEntries(ledger.preferences),
  };
  while (TEXT_ENCODER.encode(JSON.stringify(summary)).length > SUMMARY_MAX_BYTES) {
    if (summary.openRequests.length) summary.openRequests.shift();
    else if (summary.decisions.length) summary.decisions.shift();
    else if (summary.commitments.length) summary.commitments.shift();
    else summary.preferences.shift();
  }
  return summary;
}
