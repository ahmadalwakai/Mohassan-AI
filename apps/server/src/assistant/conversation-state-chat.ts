import type { Kysely } from 'kysely';
import { analyzeCompoundRequest } from './compound-request.js';
import {
  emptyConversationState, understandTurn, withAssistantAnswer,
  type ConversationStateV2, type PendingStep, type TurnUnderstanding,
} from './conversation-state.js';
import type { ConversationShadow, ConversationShadowInput } from './conversation-state-shadow.js';
import { answerSubject, fold, isFollowUp, parseHands, refersBack, tidy, topicWords, webQuestion, type HandsPlan, type HandsStep } from './hands.js';
import { ownFactQuestion } from './own-fact-question.js';
import { publicConversationFollowup } from './public-conversation-followup.js';
import { MAX_CONTEXT_REQUEST, requestActionText, resolveRequestContext, type RequestResolution } from './request-context.js';
import {
  parseRequestScopeAssessment, parseUserRequestConstraints, requestCapabilityAllowed, requestScopeActionText,
  reviewPublicProjection, type RequestScopeAssessment,
} from './request-scope.js';
import { returnParts } from './return-to.js';

const HISTORY_LIMIT = 16;
const MIN_CONFIDENCE = 0.76;
const REFERENCE_AMBIGUITIES = new Set(['missing_reference', 'missing_question']);

export interface ConversationTranscriptEntry { id: string; role: string; text: string }
interface StoredConversationEntry extends ConversationTranscriptEntry { created_at: Date | string }

export function conversationDecisionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MOHASSAN_CONVERSATION_SHADOW === 'decide';
}

function isPublicLookup(value: unknown): boolean {
  const source = parseRequestScopeAssessment(value);
  return source?.source === 'public_lookup' && source.scope === 'public'
    && source.operation === 'lookup' && source.publicQueryEligible;
}

export function replayConversationTranscript(history: readonly ConversationTranscriptEntry[]): ConversationStateV2 {
  let state = emptyConversationState();
  let publicLookup = false;
  for (const message of history.slice(-HISTORY_LIMIT)) {
    if (message.role === 'user') {
      const user = understandTurn(state, message.text, message.id);
      state = user.next;
      publicLookup = isPublicLookup(user.v1.sourceAssessment);
    } else if (message.role === 'assistant') {
      state = withAssistantAnswer(state, message.text, message.id, { publicLookup });
    }
  }
  return state;
}

async function loadTranscript(db: Kysely<any>, conversationId: string): Promise<StoredConversationEntry[]> {
  const rows = await db.selectFrom('chat_messages').select(['id', 'role', 'text', 'created_at'])
    .where('conversation_id', '=', conversationId).orderBy('created_at', 'desc').orderBy('id', 'desc').limit(HISTORY_LIMIT).execute();
  return rows.reverse();
}

interface PendingBinding { field?: 'question' | 'approval' | 'secure'; requestId?: string }

function boundPending(input: PendingBinding): PendingStep | null {
  if (!input.field) return null;
  const kind = input.field === 'approval' ? 'approval' : input.field === 'secure' ? 'sign_in' : 'question_card';
  return { kind, id: input.requestId ?? input.field };
}

async function transcriptBefore(db: Kysely<any>, conversationId: string, turnId: string): Promise<ConversationTranscriptEntry[]> {
  const rows = await db.selectFrom('chat_messages as entry')
    .innerJoin('chat_messages as anchor', join => join.onRef('anchor.conversation_id', '=', 'entry.conversation_id')
      .on('anchor.id', '=', turnId).on('anchor.role', '=', 'user'))
    .select(['entry.id', 'entry.role', 'entry.text']).where('entry.conversation_id', '=', conversationId)
    .where(eb => eb.or([
      eb('entry.created_at', '<', eb.ref('anchor.created_at')),
      eb.and([eb('entry.created_at', '=', eb.ref('anchor.created_at')), eb('entry.id', '<', eb.ref('anchor.id'))]),
    ])).orderBy('entry.created_at', 'desc').orderBy('entry.id', 'desc').limit(HISTORY_LIMIT).execute();
  return rows.reverse();
}

/** Return a post-commit observer. History is read later, fenced by the committed message. */
export function prepareConversationObservation(shadow: ConversationShadow | undefined, db: Kysely<any>,
    input: Pick<ConversationShadowInput, 'conversationId' | 'turnId' | 'text' | 'legacy' | 'previousSource' | 'previousFound'>,
    binding?: PendingBinding): (() => void) | undefined {
  if (!shadow) return undefined;
  const mode = conversationDecisionEnabled() ? 'active' : 'shadow';
  const pending = binding && boundPending(binding);
  return () => {
    try {
      shadow.observeLater({ ...input, mode, ...(pending ? { pending, boundAnswer: true } : {}) },
        () => transcriptBefore(db, input.conversationId, input.turnId));
    } catch { /* Observation never changes the chat. */ }
  };
}

export interface ConversationChatSelection {
  decision: TurnUnderstanding['decision'];
  search: HandsStep[] | null;
  resolution: RequestResolution | undefined;
  previousSource?: RequestScopeAssessment;
}

interface PriorPublicAnswer {
  assessment: unknown;
  found: HandsPlan['found'];
}

function hasObservedName(reference: NonNullable<TurnUnderstanding['decision']['reference']>, prior: PriorPublicAnswer | null | undefined): boolean {
  if (!prior?.found || !isPublicLookup(prior.assessment) || typeof prior.found.title !== 'string'
    || !Array.isArray(prior.found.lines)) return false;
  const words = (text: string) => ` ${fold(text).replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
  const name = words(reference.text);
  return name.length > 2 && [prior.found.title, ...prior.found.lines].some(line => typeof line === 'string' && words(line).includes(name));
}

const comparableRequest = (text: string) => text.normalize('NFC').trim().replace(/\s+/gu, ' ');

export async function selectConversationTurn(input: {
  db: Kysely<any>; ownerId: string; conversationId: string; turnId: string; text: string;
  resolution?: RequestResolution; previousSource?: RequestScopeAssessment | null; fresh: boolean;
}): Promise<ConversationChatSelection | null> {
  if (!input.fresh || !conversationDecisionEnabled()) return null;
  const transcript = await loadTranscript(input.db, input.conversationId);
  const latest = transcript.at(-1);
  if (!latest || latest.role !== 'user' || comparableRequest(latest.text) !== comparableRequest(input.text)) return null;
  const history = transcript.slice(0, -1);
  const decision = understandTurn(replayConversationTranscript(history), input.text, latest.id).decision;
  const { reference, references, standalone } = decision;
  const explicitReturn = returnParts(input.text);
  const resolution = explicitReturn && input.resolution?.scope === 'private'
    ? resolveRequestContext(input.text, null, { turnId: input.turnId }) : input.resolution;
  const fallback = { decision, search: null, resolution };
  if ((decision.type !== 'follow_up' && decision.type !== 'correction') || decision.confidence < MIN_CONFIDENCE
    || !reference || !references.length || references.length > 4 || references.some(item => !item.publicLookup) || !standalone || standalone.length > MAX_CONTEXT_REQUEST
    || !resolution || resolution.pendingQuestionId || comparableRequest(input.text) !== resolution.original
    || resolution.scope === 'private' || !['web_search', 'news', 'unknown'].includes(resolution.intent)
    || resolution.ambiguities.some(reason => !REFERENCE_AMBIGUITIES.has(reason))
    || !requestCapabilityAllowed(parseUserRequestConstraints(input.text), 'public_search')) return fallback;

  const compound = analyzeCompoundRequest(input.text);
  if (compound.kind !== 'single' || compound.literalRanges.length) return fallback;
  let previous = input.previousSource ?? undefined;
  if (!isPublicLookup(previous) && !explicitReturn) return fallback;
  const origin = requestActionText(requestScopeActionText(input.text));

  for (const operand of references) {
    if (operand.role === 'user') {
      if (!isPublicLookup(previous)) {
        const mention = history.find(message => message.role === 'user' && message.id === operand.turnId);
        previous = mention ? resolveRequestContext(mention.text).sourceAssessment : undefined;
      }
      continue;
    }
    const answerIndex = history.findIndex(message => message.role === 'assistant' && message.id === operand.turnId);
    if (answerIndex < 0) return fallback;
    const answer = history[answerIndex]!;
    const pairedRequest = history.slice(0, answerIndex).findLast(message => message.role === 'user');
    if (!pairedRequest) return fallback;
    const prior = await input.db.selectFrom('chat_runs').select(['state', 'status', 'goal']).where('owner_id', '=', input.ownerId)
      .where('conversation_id', '=', input.conversationId).where('id', '!=', input.turnId).where('created_at', '<=', answer.created_at)
      .orderBy('created_at', 'desc').limit(1).executeTakeFirst();
    const originatingSource = prior?.state?.requestResolution?.sourceAssessment;
    if (!prior || comparableRequest(prior.goal) !== comparableRequest(pairedRequest.text) || !['completed', 'partial'].includes(prior.status)
      || !hasObservedName(operand, { assessment: originatingSource, found: prior.state?.handsFound })) return fallback;
    if (!isPublicLookup(previous)) previous = parseRequestScopeAssessment(originatingSource) ?? undefined;
  }
  if (!isPublicLookup(previous)) return fallback;
  const assessment = reviewPublicProjection(origin, standalone, { contextKind: 'follow_up', previous });
  if (!assessment.eligible || !isPublicLookup(assessment.source)) return fallback;

  const search = webQuestion(standalone);
  const step = search?.[0];
  if (search?.length !== 1 || step?.kind !== 'search' || step.site
    || !reviewPublicProjection(origin, step.query, { contextKind: 'follow_up', previous }).eligible) return fallback;
  const projected = resolveRequestContext(standalone, null, { turnId: input.turnId });
  const nextState = projected.nextState?.scope === 'public' ? projected.nextState : resolution.nextState;
  return { decision, search, previousSource: previous, resolution: { ...resolution, kind: 'follow_up', query: step.query, ambiguities: [],
    scope: 'public', intent: 'web_search', sourceAssessment: assessment.source, topic: reference.text, nextState } };
}

export function applyConversationSelection(state: { requestResolution?: RequestResolution; requestContext?: RequestResolution['nextState']; previousSource?: RequestScopeAssessment | null },
    selection: ConversationChatSelection | null): void {
  if (!selection?.search || !selection.resolution) return;
  state.requestResolution = selection.resolution;
  if (selection.previousSource) state.previousSource = selection.previousSource;
  if (selection.resolution.nextState) state.requestContext = selection.resolution.nextState;
}

export function isAppliedConversationQuestion(state: { requestResolution?: RequestResolution; resolvedRequest?: string | null },
    query: string): boolean {
  return conversationDecisionEnabled() && state.requestResolution?.kind === 'follow_up'
    && state.requestResolution.query === query && state.resolvedRequest === query;
}

export function legacyShadowDecision(input: ConversationShadowInput, legacy: TurnUnderstanding) {
  const resolution = input.legacy ?? legacy.v1;
  const classification = { kind: input.boundAnswer ? 'answer' : resolution.kind, intent: resolution.intent, scope: resolution.scope };
  if (input.boundAnswer) return { ...classification, query: null };
  if (!input.history || input.pending || resolution.scope === 'private'
      || resolution.kind === 'ambiguous' && resolution.ambiguities.some(reason =>
        REFERENCE_AMBIGUITIES.has(reason) || reason === 'unclear_replacement')) return { ...classification, query: resolution.query };

  const action = requestActionText(requestScopeActionText(input.text));
  if (ownFactQuestion(action)) return { ...classification, query: null };
  const steps = parseHands(action);
  const reviewedQuery = (query: string | null) => query && reviewPublicProjection(action, query, {
    contextKind: resolution.kind, previous: input.previousSource ?? undefined,
  }).eligible ? query : null;
  if (steps) return { ...classification, query: reviewedQuery(steps[0]?.kind === 'search' ? steps[0].query : null) };
  const earlier = input.history.filter(message => message.role === 'user').map(message => message.text);
  const refined = publicConversationFollowup({ request: input.text, resolution,
    previousSource: input.previousSource, earlierUserTurns: earlier, pending: false });
  const lastPublic = isPublicLookup(input.previousSource) ? input.previousFound : undefined;
  const named = !refined && typeof lastPublic?.title === 'string' && Array.isArray(lastPublic.lines)
    && lastPublic.lines.every(line => typeof line === 'string') && isFollowUp(tidy(action)) && refersBack(tidy(action))
    ? answerSubject(lastPublic) : null;
  const ownedWords = new Set(topicWords(action));
  const contextual = resolution.kind === 'follow_up' && resolution.scope === 'public' && resolution.query
    && topicWords(resolution.query).some(word => !ownedWords.has(word)) ? resolution.query : null;
  const search = refined ? webQuestion(refined) : named ? webQuestion(action, [named])
    : webQuestion(contextual ?? action, contextual ? [] : earlier.slice(-3));
  const step = search?.[0];
  return { ...classification, query: reviewedQuery(step?.kind === 'search' ? step.query : resolution.query) };
}
