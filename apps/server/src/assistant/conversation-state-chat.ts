import type { Kysely } from 'kysely';
import { analyzeCompoundRequest } from './compound-request.js';
import {
  emptyConversationState, understandTurn, withAssistantAnswer,
  type ConversationStateV2, type TurnUnderstanding,
} from './conversation-state.js';
import type { BrainState } from './brain.js';
import type { ConversationShadow, ConversationShadowInput } from './conversation-state-shadow.js';
import { answerSubject, fold, isFollowUp, notWebReason, parseHands, refersBack, tidy, topicWords, webQuestion, type HandsPlan } from './hands.js';
import { projectInventoryFormat } from './inventory.js';
import { memoryRecallFormat } from './memory-recall.js';
import { ownFactQuestion } from './own-fact-question.js';
import { publicConversationFollowup } from './public-conversation-followup.js';
import { MAX_CONTEXT_REQUEST, requestActionText, resolveRequestContext, type RequestResolution } from './request-context.js';
import {
  parseRequestScopeAssessment, parseUserRequestConstraints, requestCapabilityAllowed, requestScopeActionText,
  reviewPublicProjection, type RequestScopeAssessment,
} from './request-scope.js';
import { returnParts } from './return-to.js';
import { unsupportedRequest } from './unsupported-request.js';

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

interface ConversationChatSelection {
  decision: TurnUnderstanding['decision'];
  plan: HandsPlan | null;
  resolution?: RequestResolution;
  previousSource?: RequestScopeAssessment;
}

interface ConversationTurnEntry {
  db: Kysely<any>;
  ownerId: string;
  conversationId: string;
  turnId: string;
  text: string;
  intent: string;
  state: BrainState;
  active: () => Promise<void>;
  shadow?: ConversationShadow;
  chatModel: boolean;
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

async function selectConversationTurn(input: ConversationTurnEntry, latest: StoredConversationEntry,
    history: readonly StoredConversationEntry[]): Promise<ConversationChatSelection> {
  const decision = understandTurn(replayConversationTranscript(history), input.text, latest.id).decision;
  const { reference, references, standalone } = decision;
  const explicitReturn = returnParts(input.text);
  const originalResolution = input.state.requestResolution;
  const resolution = explicitReturn && originalResolution?.scope === 'private'
    ? resolveRequestContext(input.text, null, { turnId: input.turnId }) : originalResolution;
  const fallback = { decision, plan: null };
  if ((decision.type !== 'follow_up' && decision.type !== 'correction') || decision.confidence < MIN_CONFIDENCE
    || !reference || !references.length || references.length > 4 || references.some(item => !item.publicLookup) || !standalone || standalone.length > MAX_CONTEXT_REQUEST
    || !resolution || resolution.pendingQuestionId || comparableRequest(input.text) !== resolution.original
    || resolution.scope === 'private' || !['web_search', 'news', 'unknown'].includes(resolution.intent)
    || resolution.ambiguities.some(reason => !REFERENCE_AMBIGUITIES.has(reason))
    || !requestCapabilityAllowed(parseUserRequestConstraints(input.text), 'public_search')) return fallback;

  const compound = analyzeCompoundRequest(input.text);
  if (compound.kind !== 'single' || compound.literalRanges.length) return fallback;
  let previous = input.state.previousSource ?? undefined;
  if (!isPublicLookup(previous) && !explicitReturn) return fallback;
  const origin = requestActionText(requestScopeActionText(input.text));
  if (input.state.routing?.route === 'pc' || parseHands(origin) || ownFactQuestion(origin) || projectInventoryFormat(input.text)) return fallback;
  const earlierAsks = history.filter(message => message.role === 'user').map(message => message.text).slice(-4);
  if (!notWebReason(tidy(origin)) && (input.state.routing?.handler === 'unsupported' || unsupportedRequest(origin, earlierAsks))) return fallback;

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
  const plan: HandsPlan = { steps: search, next: 0, lang: /\p{Script=Arabic}/u.test(input.text) ? 'ar' : 'en' };
  return { decision, plan, previousSource: previous, resolution: { ...resolution, kind: 'follow_up', query: step.query, ambiguities: [],
    scope: 'public', intent: 'web_search', sourceAssessment: assessment.source, topic: reference.text, nextState } };
}

/**
 * Called for an accepted run before the worker chooses a handler. The transcript
 * is captured while the database is open so the deferred shadow only writes files.
 */
export async function enterConversationTurn(input: ConversationTurnEntry): Promise<ConversationChatSelection | null> {
  const mode = conversationDecisionEnabled() ? 'active' : 'shadow';
  const { state, shadow } = input;
  if (input.intent !== 'task' || state.steps || state.trail.length || mode === 'shadow' && !shadow) return null;
  const transcript = await loadTranscript(input.db, input.conversationId).catch(() => null);
  const latest = transcript?.at(-1);
  if (!transcript || latest?.role !== 'user' || comparableRequest(latest.text) !== comparableRequest(input.text)) return null;

  const history = transcript.slice(0, -1);
  const selection = mode === 'active' && !input.chatModel ? await selectConversationTurn(input, latest, history) : null;
  const previousFound = shadow && mode === 'shadow' && isPublicLookup(state.previousSource)
    ? (await input.db.selectFrom('chat_runs').select('state').where('owner_id', '=', input.ownerId)
      .where('conversation_id', '=', input.conversationId).where('id', '!=', input.turnId)
      .orderBy('created_at', 'desc').limit(1).executeTakeFirst().catch(() => undefined))?.state?.handsFound : undefined;
  await input.active();

  try {
    shadow?.observeTask?.({ mode, conversationId: input.conversationId, turnId: input.turnId, text: input.text,
      history, legacy: state.requestResolution, previousSource: state.previousSource, previousFound });
  } catch { /* Diagnostics must never stop the run. */ }

  // The existing clarifier needs the vetted resolution. Tool permissions still
  // come from the original request and the planned lookup is consumed only later.
  if (selection?.plan && selection.resolution) {
    state.requestResolution = selection.resolution;
    if (selection.previousSource) state.previousSource = selection.previousSource;
    if (selection.resolution.nextState) state.requestContext = selection.resolution.nextState;
  }
  return selection;
}

interface ConversationLookup {
  state: BrainState;
  actionRequest: string;
  handsPlan: HandsPlan | null;
  freshRequest: boolean;
  chatModel: boolean;
  documentWork: unknown;
  ownFact: ReturnType<typeof ownFactQuestion>;
  mindReady: boolean;
  memory: boolean;
  adsFirst: boolean;
  applyPlan: (plan: HandsPlan) => void;
}

/** A proven standalone takes the public lookup lane before any legacy heuristics run. */
export function useLegacyConversationLookup(selection: ConversationChatSelection | null, input: ConversationLookup): boolean {
  if (input.handsPlan || !input.freshRequest || input.chatModel || input.documentWork) return false;
  const { state, actionRequest } = input;
  if (!selection?.plan || input.ownFact || state.routing?.route === 'pc' || state.requestResolution?.scope === 'private'
    || input.memory && memoryRecallFormat(actionRequest)) return true;

  const { plan, resolution } = selection;
  state.resolvedRequest = resolution?.query ?? null;
  if (input.mindReady || input.adsFirst) state.webFallback = plan.steps;
  else input.applyPlan(plan);
  return false;
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
