import { z } from 'zod';
import { standaloneMannersRoute } from './manners/chat.js';
import { directRoute } from './brain.js';
import { isCampaignRequest } from './campaign-request.js';
import { recognizeEverydayClarification } from './everyday-clarification.js';
import { parseHands, type HandsStep } from './hands.js';
import { evaluateInlineDataFile } from './inline-data-file.js';
import { evaluateLocalComputation, type LocalComputation } from './local-computation.js';
import { evaluateLocalConversation } from './local-conversation.js';
import { recognizeRuntimeStatusRequest } from './runtime-status.js';
import type { LocalReply } from './mind/limits.js';
import { buildFrame } from './mind/frame.js';
import { planningTask } from './planner.js';
import type { ShadowRouteCandidate } from './router.js';
import { parseQuestionRewriteRequest } from './question-rewrite-request.js';
import {
  REQUEST_CONTEXT_VERSION, requestActionText, requestContextIntents, requestSlotKinds, resolveRequestContext,
  parseRequestContextState, type RequestContextIntent, type RequestContextOptions, type RequestResolution,
} from './request-context.js';
import { writingTask } from './writer.js';
import { usesAlignedEvidence } from './writing/multisource/types.js';
import { extractiveWritingEnabled } from './writing/request.js';
import { assessRequestScope, maskRequestLiteralData, parseRequestScopeAssessment, requestCapabilityAllowed, requestScopeActionText, reviewPublicProjection, requestConstraintReply, type RequestScopeAssessment } from './request-scope.js';
import { applyScratchRouting, runtimeScratchPolicy, type ScratchDecisionPolicy, type ScratchRoutingChoices } from './scratch-decisions.js';
import { reviewRoutingRefusal } from './refusal/turn.js';
import { parseTestDrivenCodingRequest, testDrivenCodingEnabled } from './test-driven-coding/request.js';

/**
 * Read-only routing contract for the host to adopt, test and observe. A decision
 * neither executes a tool nor grants permission. Readiness reflects only the
 * capabilities the host supplied; it is not an independent availability probe.
 * All inference capabilities refer to the already selected local/own model.
 */
export const routingCapabilities = ['browser', 'search', 'memory', 'adsModel', 'adsAccount', 'computer', 'writerModel', 'chatModel', 'planner', 'coding', 'reminders', 'imageModel', 'mediaModel'] as const;
export type RoutingCapability = (typeof routingCapabilities)[number];
export const routedIntents = [...requestContextIntents.filter(intent => intent !== 'unknown'), 'image', 'media'] as const;
export type RoutedIntent = Exclude<RequestContextIntent, 'unknown'> | 'image' | 'media';
export type RequestRoute = RoutedIntent | 'reply' | 'clarify';
export type RoutingHandler = 'resume' | 'clarify' | 'local_conversation' | 'local_computation' | 'local_coding' | 'local_status' | 'memory' | 'ads' | 'computer' | 'browser' | 'search' | 'writing' | 'planning' | 'coding' | 'reminder' | 'image' | 'media' | 'model' | 'unsupported';
export type RoutingReason = 'pending_answer' | 'missing_reference' | 'invalid_request' | 'local_conversation' | 'local_computation' | 'host_runtime_status' | 'explicit_handler' | 'context_destination' | 'rewritten_question' | 'deterministic_browser_plan' | 'public_lookup' | 'local_model_fallback' | 'missing_capability' | 'account_restriction' | 'unresolved_intent' | 'scratch_route' | 'scratch_speech_act' | 'scratch_refuse' | 'scratch_out_of_scope' | 'request_refused';

const PendingQuestionSchema = z.object({
  id: z.string().min(1).max(80),
  route: z.enum(['web_search', 'browser_command', 'news', 'memory', 'reminder', 'compute', 'ads', 'pc', 'writing', 'planning', 'coding', 'chat', 'unsupported', 'image', 'media']).optional(),
  fields: z.array(z.enum(requestSlotKinds)).max(12).optional(),
}).strict();

export interface RequestRoutingInput {
  text: string;
  /** Host-persisted user state only, parsed by resolveRequestContext. */
  context?: unknown;
  /** Actual conversation history when the host has a turn count. */
  previousTurns?: number;
  previousScope?: unknown;
  pendingQuestion?: z.infer<typeof PendingQuestionSchema>;
  capabilities?: Partial<Record<RoutingCapability, boolean>>;
  /** The host still enforces per-operation permissions after choosing a route. */
  fullAccess?: boolean;
  now?: Date;
  turnId?: string;
  previousUserTurn?: string;
}

export interface RequestRoutingDecision {
  version: 1;
  route: RequestRoute;
  intent: RoutedIntent | 'unknown';
  handler: RoutingHandler;
  availability: 'ready' | 'needs_context' | 'missing_capability' | 'restricted';
  missingCapabilities: RoutingCapability[];
  reason: RoutingReason;
  resolution: RequestResolution;
  sourceAssessment: RequestScopeAssessment;
  /** Only a public lookup receives a query. Private destinations never do. */
  publicQuery: string | null;
  /** A bounded proposal only; the host must validate actual page refs and authority. */
  browserSteps?: HandsStep[];
  localReply?: LocalReply | LocalComputation;
}

const frameIntent = (intent: ReturnType<typeof buildFrame>['intent']): RoutedIntent | null => ({
  identity: 'chat', smalltalk: 'chat', compute: 'compute', memory_recall: 'memory', memory_save: 'memory',
  open_site: 'browser_command', site_check: 'web_search', site_question: 'web_search', fact_question: 'web_search', compare: 'web_search', explain: 'web_search',
  write: 'writing', ads: 'ads', coding: 'coding', computer: 'pc',
} as Partial<Record<ReturnType<typeof buildFrame>['intent'], RoutedIntent>>)[intent] ?? null;

export interface RankedClarificationRoute {
  route: RoutedIntent;
  score: number;
  source: 'rules' | 'b0';
  /** The original words of an explicit alternative, when independently routable. */
  request?: string;
}

type RouteDecisionSummary = Pick<RequestRoutingDecision, 'route' | 'intent' | 'reason' | 'availability'>;
const ROUTE_LOOKUP_LEAD = /^(?:search|look up|find|research|tell me|what|who|where|when|how|ابحث|اعثر|اخبرني|أخبرني|ما|ماذا|من|أين|اين|متى|كيف)(?!\p{L})/iu;
const WEAK_FALLBACK_RULES = new Set(['question-shape', 'factual-report', 'property-and-topic', 'ambiguous-action']);

function explicitRouteAlternatives(text: string): RankedClarificationRoute[] {
  // Split only unquoted alternatives. Each side must be independently routable.
  const splits = [...maskRequestLiteralData(text).matchAll(/(?<=\s)(?:or|أو|او)(?=\s)/giu)];
  if (splits.length < 1 || splits.length > 3) return [];
  const parts = splits.map((split, index) => text.slice(index ? splits[index - 1].index + splits[index - 1][0].length : 0, split.index).trim());
  const last = splits[splits.length - 1];
  parts.push(text.slice(last.index + last[0].length).trim());
  const alternatives: RankedClarificationRoute[] = [];
  for (const request of parts) {
    if (!request || request.length > 500) return [];
    const branch = decideRequestRoute({ text: request });
    if (!routedIntents.includes(branch.route as RoutedIntent) || branch.route === 'unsupported'
      || branch.route === 'web_search' && (!branch.publicQuery || !ROUTE_LOOKUP_LEAD.test(request))
      || alternatives.some(option => option.route === branch.route)) return [];
    alternatives.push({ route: branch.route as RoutedIntent, score: 0.86, source: 'rules', request });
  }
  return alternatives;
}

/** Rules are ordered independently of the B0 confidence scale. The shadow head grants no authority. */
export function rankClarificationRoutes(text: string, decision?: RouteDecisionSummary | null,
  shadow: readonly ShadowRouteCandidate[] = []): RankedClarificationRoute[] {
  const alternatives = explicitRouteAlternatives(text);
  const orderedRules = new Map<RoutedIntent, RankedClarificationRoute>();
  if (alternatives.length) for (const option of alternatives) orderedRules.set(option.route, option);
  else {
    const winner = decision?.route === 'clarify' || decision?.route === 'reply' ? null : decision?.route;
    if (winner && winner !== 'unsupported') orderedRules.set(winner, { route: winner,
      score: decision?.reason === 'local_model_fallback' ? 0.62 : 0.97, source: 'rules' });
    for (const match of buildFrame(text).matched) {
      if (WEAK_FALLBACK_RULES.has(match.rule)) continue;
      const route = frameIntent(match.intent);
      if (route && !orderedRules.has(route)) orderedRules.set(route, { route, score: winner ? 0.72 : 0.69, source: 'rules' });
    }
  }
  const suggestions = shadow.filter(candidate => routedIntents.includes(candidate.route as RoutedIntent) && candidate.route !== 'unsupported'
    && Number.isFinite(candidate.score) && candidate.score >= 0 && candidate.score <= 1)
    .slice(0, 4).map(({ route, score }): RankedClarificationRoute => ({ route: route as RoutedIntent, score, source: 'b0' }));
  return [...orderedRules.values(), ...suggestions];
}

/** No I/O, model calls, public search fallback for private requests or state mutation. */
export function decideRequestRoute(input: RequestRoutingInput, policy: ScratchDecisionPolicy | null = runtimeScratchPolicy()): RequestRoutingDecision {
  const rule = decideRuleRequestRoute(input);
  return policy ? applyScratchRouting(input, rule, policy, choices => decideRuleRequestRoute(input, choices)) : rule;
}

function decideRuleRequestRoute(input: RequestRoutingInput, choices: ScratchRoutingChoices = {}): RequestRoutingDecision {
  const manners = standaloneMannersRoute(input);
  if (manners) return manners;
  const pending = PendingQuestionSchema.safeParse(input.pendingQuestion);
  const options: RequestContextOptions = { turnId: input.turnId, learnedFollowUp: choices.followUp,
    ...(pending.success ? { pendingQuestion: { id: pending.data.id, fields: pending.data.fields } } : {}) };
  const resolution = resolveRequestContext(input.text, input.context, options);
  const previousContext = parseRequestContextState(input.context);
  const retainedScope = previousContext && 'sourceAssessment' in previousContext ? parseRequestScopeAssessment(previousContext.sourceAssessment) : null;
  const inferredScope = previousContext?.topic ? assessRequestScope(previousContext.topic) : null;
  const legacyPrivateScope: RequestScopeAssessment | null = previousContext?.scope === 'private' ? {
    version: 1, source: previousContext.intent === 'pc' ? 'local_state' : 'prior_conversation',
    scope: 'private', operation: 'lookup', destination: previousContext.intent === 'memory' ? 'memory' : previousContext.intent === 'pc' ? 'pc' : 'unknown',
    publicQueryEligible: false, reasons: ['inherited_source'],
  } : null;
  const previousScope = input.previousScope ?? retainedScope ?? legacyPrivateScope ?? inferredScope ?? undefined;
  const scopeOptions = { contextKind: resolution.kind, previous: previousScope };
  const sourceAssessment = assessRequestScope(input.text, scopeOptions);
  const refusal = reviewRoutingRefusal(input, resolution, sourceAssessment, previousContext);
  if (refusal) return refusal;
  const explicitPublicSource = sourceAssessment.source === 'public_lookup'
    && sourceAssessment.reasons.some(reason => reason === 'explicit_public_lookup' || reason === 'public_document_reference');
  const has = (capability: RoutingCapability) => input.capabilities?.[capability] === true;
  const reconciled = (intent: RequestRoutingDecision['intent']): RequestResolution => {
    if (intent === 'unknown' || !requestContextIntents.includes(intent as RequestContextIntent)) return resolution;
    const contextIntent = intent as RequestContextIntent;
    const scope = sourceAssessment.scope === 'private' || resolution.scope === 'private' && !explicitPublicSource || ['memory', 'ads', 'pc', 'reminder', 'planning', 'coding'].includes(contextIntent)
      ? 'private' : ['web_search', 'news', 'browser_command'].includes(contextIntent) ? 'public' : 'unknown';
    const query = scope === 'public' && sourceAssessment.publicQueryEligible && ['web_search', 'news'].includes(contextIntent)
      ? resolution.query ?? resolution.constraints?.safeActionText ?? resolution.resolved : null;
    const nextState = resolution.nextState ? parseRequestContextState({ ...resolution.nextState, intent: contextIntent, scope }) : null;
    return { ...resolution, intent: contextIntent, scope, query, nextState };
  };
  const base = (route: RequestRoute, intent: RequestRoutingDecision['intent'], handler: RoutingHandler, reason: RoutingReason): RequestRoutingDecision => ({
    version: 1, route, intent, handler, availability: 'ready', missingCapabilities: [], reason, resolution: reconciled(intent), sourceAssessment, publicQuery: null,
  });
  const clarify = (reason: RoutingReason): RequestRoutingDecision => ({ ...base('clarify', resolution.intent, 'clarify', reason), availability: 'needs_context' });
  if (resolution.resolved === null || input.pendingQuestion !== undefined && !pending.success) return clarify('invalid_request');
  if (!pending.success && parseQuestionRewriteRequest(input.text)) return base('writing', 'writing', 'writing', 'explicit_handler');
  const scopeRequest = requestActionText(requestScopeActionText(resolution.resolved));
  if (resolution.constraints?.ambiguous) return clarify('unresolved_intent');
  if (resolution.constraints?.standalone) {
    const reply = requestConstraintReply(resolution.constraints, /\p{Script=Arabic}/u.test(input.text) ? 'ar' : 'en');
    return { ...base('chat', 'chat', 'local_conversation', 'local_conversation'), resolution, ...(reply ? { localReply: reply } : {}) };
  }
  if (resolution.kind === 'answer') return base('reply', resolution.intent === 'unknown' && pending.success ? pending.data.route ?? 'unknown' : resolution.intent, 'resume', 'pending_answer');
  if (evaluateInlineDataFile(input.text) !== null) {
    const decision = base('writing', 'writing', 'writing', 'explicit_handler');
    const supplied: RequestScopeAssessment = { version: 1, source: 'supplied_content', operation: 'transform', scope: 'private',
      destination: 'writing', publicQueryEligible: false, reasons: ['supplied_transformation'],
      ...(resolution.constraints ? { constraints: resolution.constraints } : {}) };
    const nextState = decision.resolution.nextState ? parseRequestContextState({ ...decision.resolution.nextState, scope: 'private', sourceAssessment: supplied }) : null;
    return { ...decision, sourceAssessment: supplied, resolution: { ...decision.resolution, kind: 'new', scope: 'private', query: null,
      sourceAssessment: supplied, nextState, ambiguities: [] } };
  }
  const codingRequest = parseTestDrivenCodingRequest(input.text);
  if (codingRequest) {
    const decision = base('coding', 'coding', 'local_coding', 'explicit_handler');
    const source: RequestScopeAssessment = { version: 1, source: 'supplied_content', operation: 'transform', scope: 'private',
      destination: 'unknown', publicQueryEligible: false, reasons: ['supplied_transformation'] };
    const description = resolveRequestContext(codingRequest.description, input.context, options);
    const nextState = description.nextState
      ? parseRequestContextState({ ...description.nextState, intent: 'coding', scope: 'private', sourceAssessment: source }) : null;
    decision.sourceAssessment = source;
    decision.resolution = { ...description, kind: 'new', intent: 'coding', scope: 'private', original: resolution.original,
      resolved: resolution.resolved, query: null, sourceAssessment: source, nextState };
    if (input.fullAccess === false) return { ...decision, availability: 'restricted', reason: 'account_restriction' };
    if (!testDrivenCodingEnabled()) return { ...decision, availability: 'missing_capability', missingCapabilities: ['coding'], reason: 'missing_capability' };
    return decision;
  }
  if (recognizeEverydayClarification(input.text, input.previousTurns === undefined ? previousContext !== null : input.previousTurns > 0)) {
    const decision = clarify('missing_reference');
    return { ...decision, resolution: { ...decision.resolution, kind: 'ambiguous', query: null,
      ambiguities: [...new Set([...resolution.ambiguities, 'missing_reference' as const])], nextState: previousContext } };
  }
  if (recognizeRuntimeStatusRequest(scopeRequest)) {
    const decision = base('chat', 'chat', 'local_status', 'host_runtime_status');
    const localSource: RequestScopeAssessment = { version: 1, source: 'unresolved', operation: 'converse', scope: 'unknown', destination: 'unknown', publicQueryEligible: false, reasons: ['non_lookup_operation'] };
    const nextState = decision.resolution.nextState ? parseRequestContextState({ ...decision.resolution.nextState,
      intent: 'chat', scope: 'unknown', topic: 'Mohassan runtime status', slots: [], sourceAssessment: localSource }) : null;
    return { ...decision, sourceAssessment: localSource, resolution: { ...decision.resolution,
      kind: 'new', intent: 'chat', scope: 'unknown', query: null, sourceAssessment: localSource, nextState,
      ambiguities: decision.resolution.ambiguities.filter(reason => reason === 'invalid_previous_state' || reason === 'unsafe_previous_context') } };
  }

  const action = scopeRequest;
  const now = input.now ?? new Date();
  const localComputation = evaluateLocalComputation(action, now, { previousUserTurn: input.previousUserTurn });
  const localConversation = evaluateLocalConversation(action, choices.smalltalk && !localComputation ? { reason: 'scratch_speech_act' } : undefined);
  // These helpers match complete standalone requests; they do not consume a
  // greeting followed by an action, a quoted calculation or a multi-action task.
  if (localConversation) {
    const decision = base('chat', 'chat', 'local_conversation', choices.smalltalk ? 'scratch_speech_act' : 'local_conversation');
    const localSource: RequestScopeAssessment = { version: 1, source: 'unresolved', operation: 'converse', scope: 'unknown', destination: 'unknown', publicQueryEligible: false, reasons: ['non_lookup_operation'] };
    const retainedAcknowledgement = resolution.intent === 'chat' && resolution.nextState !== null && resolution.nextState.intent !== 'chat';
    const nextState = retainedAcknowledgement ? structuredClone(resolution.nextState) : decision.resolution.nextState
      ? parseRequestContextState({ ...decision.resolution.nextState, scope: 'unknown', sourceAssessment: localSource }) : null;
    return { ...decision, sourceAssessment: localSource, localReply: localConversation,
      resolution: { ...decision.resolution, scope: 'unknown', query: null, sourceAssessment: localSource, nextState } };
  }
  if (localComputation) {
    const decision = base('compute', 'compute', 'local_computation', 'local_computation');
    const continueCompound = localComputation.status === 'partial' && has('chatModel');
    const intrinsicSource: RequestScopeAssessment = { version: 1, source: 'supplied_content', operation: 'compute', scope: 'private', destination: 'compute', publicQueryEligible: false, reasons: ['numeric_operation'] };
    const currentId = typeof input.turnId === 'string' && input.turnId.length > 0 && input.turnId.length <= 80 ? input.turnId
      : resolution.provenance.find(item => item.relation === 'current')?.sourceTurnId ?? 'intrinsic-computation';
    const topic = action.length <= 600 ? action : 'calculation';
    const slots = resolution.slots.filter(slot => slot.sourceTurnId === currentId);
    const nextState = parseRequestContextState({
      version: REQUEST_CONTEXT_VERSION, revision: resolution.nextState?.revision ?? (previousContext?.revision ?? 0) + 1,
      intent: 'compute', scope: 'private', topic, topicSourceTurnId: currentId, slots, sourceAssessment: intrinsicSource,
    });
    return { ...decision, ...(continueCompound ? { handler: 'model' as const, reason: 'local_model_fallback' as const } : { localReply: localComputation }), sourceAssessment: intrinsicSource,
      resolution: { ...decision.resolution, kind: 'new', intent: 'compute', scope: 'private', query: null,
        sourceAssessment: intrinsicSource, topic, slots, nextState, pendingQuestionId: null,
        ambiguities: resolution.ambiguities.filter(reason => reason === 'invalid_previous_state' || reason === 'unsafe_previous_context'),
        provenance: [{ field: 'topic', sourceTurnId: currentId, relation: 'current' }, ...slots.map(slot => ({ field: slot.kind, sourceTurnId: slot.sourceTurnId, relation: 'current' as const }))],
      } };
  }
  const extractive = extractiveWritingEnabled() && writingTask(input.text, 'extractive');
  if (extractive && !(extractive.source.kind === 'search' && usesAlignedEvidence(extractive)
    && (resolution.kind === 'ambiguous' || sourceAssessment.reasons.includes('unresolved_reference')))) {
    // Public evidence acquisition uses the same route vocabulary as ordinary public reads.
    const constraints = resolution.constraints ?? null;
    if ((usesAlignedEvidence(extractive) || extractive.opensSource) && sourceAssessment.scope !== 'private'
      && requestCapabilityAllowed(constraints, 'browser_navigation')) {
      if (extractive.source.kind === 'urls') {
        const route = extractive.opensSource ? 'browser_command' : 'web_search';
        return base(route, route, 'writing', 'explicit_handler');
      }
      if (extractive.source.kind === 'search' && requestCapabilityAllowed(constraints, 'public_search')
        && (explicitPublicSource || resolution.scope !== 'private' && !buildFrame(action).personal)) {
        return base('web_search', 'web_search', 'writing', 'explicit_handler');
      }
    }
    return base('writing', 'writing', 'writing', 'explicit_handler');
  }
  if (choices.refusal) {
    const decision = base('unsupported', 'unsupported', 'unsupported', choices.refusal === 'refuse' ? 'scratch_refuse' : 'scratch_out_of_scope');
    const localReply = evaluateLocalConversation(action, decision);
    return { ...decision, availability: 'missing_capability', ...(localReply && { localReply }) };
  }
  if (resolution.kind === 'ambiguous') return clarify('missing_reference');
  if (sourceAssessment.reasons.includes('unresolved_reference')) return clarify('missing_reference');

  const frame = buildFrame(action), parsedSteps = parseHands(action), direct = directRoute(action);
  const steps = parsedSteps && parsedSteps.length <= 40 ? parsedSteps : undefined;
  const writer = writingTask(action), planner = planningTask(action);
  if (frame.missing.some(field => field === 'expression' || field === 'memory_content')
    || resolution.intent === 'browser_command' && frame.missing.includes('website') && !steps && !direct) return clarify('missing_reference');
  if (!choices.route && resolution.intent === 'web_search' && frame.intent === 'unknown' && frame.missing.includes('question') && sourceAssessment.source === 'unresolved' && !steps) {
    return has('chatModel') ? base('chat', 'chat', 'model', 'local_model_fallback') : clarify('missing_reference');
  }
  let intent: RoutedIntent | 'unknown' = resolution.intent;
  let reason: RoutingReason = resolution.kind === 'follow_up' ? 'context_destination' : 'explicit_handler';
  // An advertising campaign request keeps its destination: its budget is not a calculation, its business is not a web
  // question and «create a campaign for …» is not a letter (assistant/campaign-request.ts).
  const campaign = resolution.kind !== 'follow_up' && isCampaignRequest(action);
  if (resolution.kind !== 'follow_up') {
    const framed = frameIntent(frame.intent);
    if (campaign) intent = 'ads';
    // A live exchange-rate request is a public lookup even when its digits match
    // a broad arithmetic recogniser. A verified local calculation already won.
    else if (frame.matched.some(match => match.rule === 'live-currency-exchange') && !frame.personal) intent = 'web_search';
    else if (['memory', 'ads', 'pc', 'reminder', 'coding', 'planning', 'news'].includes(resolution.intent)) {
      // A specific writer/parser result can disambiguate ordinary prose about
      // code or memory. Actual private lookup frames retain their destination.
      if (resolution.intent !== 'news' && framed === 'writing' && writer && !['memory_recall', 'memory_save', 'ads', 'computer', 'coding'].includes(frame.intent)) intent = 'writing';
    } else if (planner) intent = 'planning';
    else if (writer && framed !== 'ads' && framed !== 'memory' && framed !== 'pc' && framed !== 'coding') intent = 'writing';
    else if (steps?.some(step => step.kind === 'news')) { intent = 'news'; reason = 'deterministic_browser_plan'; }
    else if (steps?.length || direct) {
      const publicSearchOnly = steps?.length === 1 && steps[0]!.kind === 'search' && !steps[0]!.site && !steps[0]!.here;
      intent = publicSearchOnly ? 'web_search' : 'browser_command'; reason = 'deterministic_browser_plan';
    } else if (framed) intent = framed;
  }
  // Source/operation provenance can recover a private or numeric destination
  // without treating an unavailable solver or writer as a public search task.
  const reminderDate = intent === 'reminder' && /(?:\bon|في تاريخ)\s+\d{4}-\d{2}-\d{2}(?!\d)/iu.test(action);
  if (campaign) { /* «40 pounds a week» in a campaign brief is its budget, not an operation on numbers. */ }
  else if (sourceAssessment.source === 'local_state') intent = 'pc';
  else if (sourceAssessment.operation === 'compute' && !reminderDate) intent = 'compute';
  else if (sourceAssessment.source === 'supplied_content' && sourceAssessment.operation === 'transform'
    && !['ads', 'coding'].includes(intent)) intent = 'writing';
  else if (sourceAssessment.source === 'prior_conversation' && ['web_search', 'unknown'].includes(intent)) intent = 'memory';
  else if (explicitPublicSource && sourceAssessment.operation === 'lookup') intent = 'web_search';
  else if (explicitPublicSource && sourceAssessment.operation === 'act' && sourceAssessment.destination === 'browser_command') intent = 'browser_command';

  if (choices.route) { intent = choices.route; reason = 'scratch_route'; }

  const withCapability = (route: RoutedIntent, handler: RoutingHandler, required: readonly RoutingCapability[], modelFallback = false): RequestRoutingDecision => {
    const decision = base(route, route, handler, reason);
    if (input.fullAccess === false && ['pc', 'coding'].includes(route)) return { ...decision, availability: 'restricted', reason: 'account_restriction' };
    if (route === 'ads' && input.fullAccess === false) return has('chatModel')
      ? { ...decision, handler: 'model', reason: 'local_model_fallback' }
      : { ...decision, availability: 'restricted', reason: 'account_restriction' };
    const missing = required.filter(capability => !has(capability));
    if (!missing.length) return decision;
    if (modelFallback && has('chatModel')) return { ...decision, handler: 'model', reason: 'local_model_fallback' };
    return { ...decision, availability: 'missing_capability', missingCapabilities: missing, reason: 'missing_capability' };
  };

  switch (intent) {
    case 'memory': return withCapability('memory', 'memory', ['memory']);
    case 'ads': return withCapability('ads', 'ads', ['adsModel'], true);
    case 'pc': return withCapability('pc', 'computer', ['computer']);
    case 'coding': return withCapability('coding', 'coding', ['coding']);
    case 'reminder': return withCapability('reminder', 'reminder', ['reminders']);
    case 'writing': {
      if (writer && !('unsupported' in writer)) return base('writing', 'writing', 'writing', reason);
      return withCapability('writing', 'writing', ['writerModel'], true);
    }
    case 'planning': {
      if (planner) return base('planning', 'planning', 'planning', reason);
      return withCapability('planning', 'planning', ['planner'], true);
    }
    case 'compute': return withCapability('compute', 'model', ['chatModel']);
    case 'chat': return withCapability('chat', 'model', ['chatModel']);
    case 'browser_command': {
      const decision = withCapability('browser_command', 'browser', ['browser']);
      if (steps) decision.browserSteps = structuredClone(steps);
      else if (direct) decision.browserSteps = [{ kind: 'open', url: direct.url, name: direct.name }];
      else if (!has('chatModel') && decision.availability === 'ready') return { ...decision, availability: 'missing_capability', missingCapabilities: ['chatModel'], reason: 'missing_capability' };
      return decision;
    }
    case 'news':
    case 'web_search': {
      if (sourceAssessment.scope === 'private' || !explicitPublicSource && (resolution.scope === 'private' || frame.personal)) return has('chatModel')
        ? { ...withCapability(intent, 'model', ['chatModel']), publicQuery: null }
        : clarify('unresolved_intent');
      const decision = withCapability(intent, 'search', ['search', 'browser']);
      const query = decision.resolution.query ?? action;
      if (!reviewPublicProjection(input.text, query, scopeOptions).eligible) return has('chatModel')
        ? base(intent, intent, 'model', 'local_model_fallback') : clarify('unresolved_intent');
      decision.publicQuery = query;
      const browserSteps = steps ?? (choices.route === 'news' ? parseHands(action, true) : null);
      if (browserSteps) decision.browserSteps = structuredClone(browserSteps);
      return { ...decision, reason: decision.availability === 'ready' && !choices.route ? 'public_lookup' : decision.reason };
    }
    case 'unsupported': return { ...base('unsupported', 'unsupported', 'unsupported', reason), availability: 'missing_capability' };
    default: return has('chatModel') ? base('chat', 'chat', 'model', 'local_model_fallback') : clarify('unresolved_intent');
  }
}
