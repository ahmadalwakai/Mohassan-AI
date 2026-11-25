import type { DesktopChatPort } from '../../command-chat.js';
import { shorterRequest } from '../answer-reshape.js';
import { looksEnglishRequest } from '../ads-model-chat.js';
import { directRoute, type BrainState } from '../brain.js';
import { decideBrowserVisibility } from '../browser-visibility.js';
import { isCampaignRequest } from '../campaign-request.js';
import { computationReference, evaluateReferencedComputation, latestComputedResult, withReferencedValue } from '../computation-reference.js';
import { createComputationMemoryReceipt } from '../computation-memory-receipt.js';
import { documentTask } from '../documents.js';
import { isFollowUp, notWebReason, parseHands, tidy, topicWords, unnamedSite, webQuestion, type HandsStep } from '../hands.js';
import { projectInventoryFormat } from '../inventory.js';
import { planLocalComputerRead } from '../local-computer-read.js';
import { evaluateLocalComputation } from '../local-computation.js';
import { evaluateLocalConversation } from '../local-conversation.js';
import { isKnowledgeDocumentRequest } from '../local-knowledge.js';
import { evaluateLocalSequence, type LocalSequenceDeps } from '../local-sequence.js';
import { memoryRecallFormat } from '../memory-recall.js';
import { recognizeMemoryVerificationRequest } from '../memory-verification.js';
import { buildFrame } from '../mind/frame.js';
import { ownFactQuestion } from '../own-fact-question.js';
import { planningTask } from '../planner.js';
import { publicConversationFollowup } from '../public-conversation-followup.js';
import { requestActionText } from '../request-context.js';
import { assessRequestScope, isEntireLiteralRequest, parseUserRequestConstraints, requestCapabilityAllowed, requestScopeActionText,
  type RequestScopeAssessment } from '../request-scope.js';
import type { RequestRoutingDecision } from '../routing-decision.js';
import { recognizeRuntimeStatusRequest } from '../runtime-status.js';
import { evaluateSelfQuestion } from '../self-knowledge.js';
import { siteTask } from '../site-builder.js';
import { skillReadable } from '../skill-reader.js';
import { unsupportedRequest } from '../unsupported-request.js';
import { assessUserFactMemoryRequest } from '../user-fact-memory-receipt.js';
import { recognizeUserFactMemoryVerificationRequest } from '../user-fact-memory-verification.js';
import { planWebSequence, startWebSequence } from '../web-sequence.js';
import { writingTask } from '../writer.js';
import { handlerRoutes, type CascadeHandler } from './cascade-handlers.js';
import type { DecisionOutcome, PredicateCandidate } from './types.js';

export interface CascadeTurn {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}
export interface CascadeInput {
  text: string;
  routing: Pick<RequestRoutingDecision, 'route' | 'handler' | 'intent' | 'availability' | 'resolution'>;
  now?: Date;
  state?: Partial<BrainState>;
  history?: readonly CascadeTurn[];
  previousStates?: readonly Partial<BrainState>[];
  configured?: Partial<Record<'computer' | 'documents' | 'sites' | 'memory' | 'knowledge' | 'skills' | 'inventory' | 'ads' | 'mind' | 'chatModel', boolean>>;
  desktop?: Pick<DesktopChatPort, 'parse'>;
  fullAccess?: boolean;
  pendingCard?: boolean;
  browserPage?: boolean;
  hostIntent?: string;
  ownerId?: string;
  conversationId?: string;
  runId?: string;
  confirmed?: boolean;
  actionLedgerValid?: boolean;
  memoryHit?: boolean;
  knowledgeHit?: boolean;
  skillHit?: boolean;
  siteMatch?: boolean;
}

export function handlerForHands(steps: readonly HandsStep[]): CascadeHandler {
  if (steps.some(step => step.kind === 'news')) return 'news';
  if (steps.some(step => step.kind === 'search' && !!step.ask && !step.site && !step.here)) return 'web_search';
  if (steps.length === 1 && steps[0]?.kind === 'search' && !steps[0].site && !steps[0].here) return 'web_search';
  return 'browser_hands';
}

export function missingReference(input: Pick<RequestRoutingDecision, 'resolution'>): boolean {
  return input.resolution.kind === 'ambiguous' && input.resolution.ambiguities.some(reason =>
    reason === 'missing_reference' || reason === 'missing_question' || reason === 'unclear_replacement');
}

/** Count a sequence only when its clauses establish the public scope. */
function hasPublicSequence(request: string, deps: LocalSequenceDeps): boolean {
  if (!requestCapabilityAllowed(parseUserRequestConstraints(request), 'public_search') || assessRequestScope(request).scope === 'private') return false;
  const parts = planWebSequence(requestActionText(requestScopeActionText(request)), deps);
  if (!parts) return false;
  let previous: RequestScopeAssessment | undefined;
  for (const part of parts) {
    if (part.local) continue;
    const source = assessRequestScope(part.request, previous ? { contextKind: 'follow_up', previous } : {});
    if (!source.publicQueryEligible) return false;
    previous = source;
  }
  return Boolean(startWebSequence(parts, /\p{Script=Arabic}/u.test(request) ? 'ar' : 'en'));
}

/**
 * Read-only view of the worker's handler order. Retrieval-backed handlers can
 * contribute before I/O, but only an observed hit settles an ambiguous probe
 * in the first-match replay. Permission, approval and effect checks still run
 * at dispatch time.
 */
export function inspectCascade(input: CascadeInput): { predicates: PredicateCandidate[]; legacy: DecisionOutcome } {
  const { text, routing, state = {}, configured = {}, fullAccess = true } = input;
  const now = input.now ?? new Date();
  const allowed = parseUserRequestConstraints(text);
  const action = requestActionText(requestScopeActionText(text));
  const resolution = state.requestResolution ?? routing.resolution;
  const trail = (state.trail ?? []).filter(entry => !entry.action.startsWith('browser_recovery '));
  const answerOnly = trail.every(entry => entry.action === 'asked the user');
  const fresh = !state.steps && (!trail.length || (state.clarifiedRequest || input.confirmed) && answerOnly);
  const desktopFresh = !state.steps && answerOnly && !state.site && !state.writer && !state.planner && !state.adsBrief
    && !state.hands && !state.pendingTask && !state.pendingComputer && !state.pendingDesktop;
  const local = !!(fresh && !state.hands && !state.site && !state.writer && !state.planner && !state.document && !state.adsBrief);
  const history = input.history ?? [];
  const earlierAsks = history.filter(turn => turn.role === 'user').map(turn => turn.text).slice(-4);
  const document = configured.documents && (state.document ?? (fresh ? documentTask(text,
    { hasDocuments: history.some(turn => turn.role === 'assistant' && turn.text.includes('/api/documents/')) }) : null));
  const note = recognizeUserFactMemoryVerificationRequest(text);
  const verify = recognizeMemoryVerificationRequest(text);
  const fact = assessUserFactMemoryRequest(text);
  const pendingSiteContent = !!(configured.sites && state.sitePendingWant && !/[؟?]\s*$/u.test(text.trim()));
  const candidates: PredicateCandidate[] = [];
  let legacy: DecisionOutcome | undefined;
  const match = (handler: CascadeHandler, matched: unknown, options: {
    eligible?: boolean; strength?: 'strong' | 'weak'; legacy?: boolean; outcome?: DecisionOutcome['action'];
  } = {}) => {
    if (!matched) return;
    const route = handlerRoutes[handler];
    const destinationAllowed = !pendingSiteContent || !['web_search', 'browser_command', 'news', 'capture'].includes(route);
    candidates.push({ handler, route, matched: true, eligible: destinationAllowed && (options.eligible ?? true),
      strength: options.strength ?? 'strong', outcome: options.outcome });
    if (!legacy && options.legacy !== false) legacy = options.outcome === 'ask' || options.outcome === 'abstain'
      ? { action: options.outcome } : { action: 'act', handler, route };
  };

  match('member_browser_blocked', !fullAccess && decideBrowserVisibility({ request: text, route: routing.route, role: 'member' }).level === 4,
    { outcome: 'abstain' });
  match('request_constraint', (allowed?.standalone || allowed?.ambiguous) && !verify?.allowed && !note?.allowed,
    { outcome: allowed?.ambiguous ? 'abstain' : 'act' });
  match('literal_clarification', isEntireLiteralRequest(text), { outcome: 'ask' });
  match('ledger_blocked', input.actionLedgerValid === false, { outcome: 'abstain' });
  match('verify_note', note, { eligible: note?.allowed === true && requestCapabilityAllowed(allowed, 'memory_read') });
  match('verify_memory', verify, { eligible: verify?.allowed === true && requestCapabilityAllowed(allowed, 'memory_read') });
  match('save_fact', fact.candidate, { eligible: requestCapabilityAllowed(allowed, 'memory_write'),
    legacy: !configured.chatModel || fact.status !== 'ready' || fact.statementKind !== 'current_declaration' });
  const desktop = desktopFresh && !configured.chatModel && fullAccess && !/https?:\/\/|\bwww\./iu.test(action)
    ? input.desktop?.parse(action) : null;
  match('desktop', desktop && requestCapabilityAllowed(allowed, desktop.mutating ? 'computer_action' : 'computer_read'));
  match('local_computer', !configured.chatModel && planLocalComputerRead(text), { eligible: fullAccess && !!configured.computer });
  match('browser_review', input.hostIntent === 'review_browser');
  match('browser_restore', input.hostIntent === 'restore_browser');
  match('pending_action', state.pendingAction || state.pendingHeld || state.pendingTask || state.pendingComputer || state.pendingDesktop);
  match('resume_card', input.pendingCard, { legacy: false });
  match('desktop_refused', state.desktopRefused, { outcome: 'abstain' });

  const site = configured.sites && (state.site ?? (fresh ? siteTask(text) : null));
  match('site_build', site);
  match('site_edit', configured.sites && state.siteId && fresh, {
    strength: input.siteMatch ? 'strong' : 'weak', eligible: input.siteMatch === true, legacy: input.siteMatch === true,
  });
  match('pending_calculation', state.pendingComputation && !state.hands);
  match('pending_open', state.pendingOpen && !state.hands);

  const selfFacts = { chatModel: !!configured.chatModel, web: true, browser: true, computation: true, memory: !!configured.memory,
    knowledge: !!configured.knowledge, documents: !!configured.documents, sites: !!configured.sites, skills: !!configured.skills,
    ads: fullAccess && !!configured.ads, imageReading: false, pc: fullAccess && !!configured.computer, planner: true, letters: true };
  const runtime = local && recognizeRuntimeStatusRequest(action);
  const conversation = local && evaluateLocalConversation(action);
  const compute = local && evaluateLocalComputation(action, now);
  const self = local && !runtime && !conversation && evaluateSelfQuestion(action, selfFacts);
  const sequence = local && !runtime && !conversation && !compute && evaluateLocalSequence(action, { now, self: selfFacts });
  const computeMemory = input.ownerId && input.conversationId && input.runId && createComputationMemoryReceipt(text,
    { ownerId: input.ownerId, conversationId: input.conversationId, runId: input.runId, evaluatedAt: now.getTime() });
  const noIntrinsic = !runtime && !conversation && !compute && !self && !sequence && !computeMemory;
  const reference = local && noIntrinsic && computationReference(action);
  if (reference) {
    const previous = latestComputedResult(input.previousStates ?? []);
    const supported = evaluateReferencedComputation(withReferencedValue(action, reference, previous?.value ?? '1'), now)?.status === 'completed';
    match('calculation_reference', supported, { outcome: previous ? 'act' : 'ask' });
  }
  match('earlier_answer', local && noIntrinsic && shorterRequest(action));
  match('unnamed_site', fresh && !state.hands && !document && !configured.chatModel && routing.route !== 'pc' && unnamedSite(action), { outcome: 'ask' });
  const ambiguous = missingReference({ resolution });
  match('missing_reference', fresh && !document && !runtime && !conversation && !self && !compute && !sequence && ambiguous, { outcome: 'ask' });

  match('runtime_status', !document && runtime);
  match('local_conversation', !document && conversation);
  match('local_sequence', !document && sequence);
  match('self_question', !document && self);
  match('computation_memory', local && !document && computeMemory);
  match('local_computation', !document && compute && !(compute.status === 'partial' && configured.chatModel), { strength: compute && compute.status === 'partial' ? 'weak' : 'strong' });
  const ownFact = fresh && ownFactQuestion(action);
  const privateRequest = resolution.scope === 'private' || !!ownFact || input.siteMatch === true || pendingSiteContent;
  const memoryIntent = local && !document && (Boolean(ownFact) || resolution.intent === 'memory' && resolution.scope === 'private'
    || buildFrame(action).intent === 'memory_recall');
  const readAllowed = local && !document && resolution.sourceAssessment?.operation !== 'transform'
    && resolution.sourceAssessment?.source !== 'local_state' && resolution.sourceAssessment?.source !== 'supplied_content';
  const documentFirst = isKnowledgeDocumentRequest(action);
  const knowledgeMatch = readAllowed && !configured.chatModel && configured.knowledge && requestCapabilityAllowed(allowed, 'knowledge_read')
    && (documentFirst || ['fact_question', 'memory_recall'].includes(buildFrame(action).intent));
  if (documentFirst) match('knowledge', knowledgeMatch, { legacy: input.knowledgeHit || privateRequest });
  match('memory_recall', readAllowed && configured.memory && memoryIntent && requestCapabilityAllowed(allowed, 'memory_read'));
  if (!documentFirst) match('knowledge', knowledgeMatch, { strength: 'weak', legacy: input.knowledgeHit === true });

  const planEligible = !!(!state.hands && fresh && !configured.chatModel && !document);
  const desktopRequest = routing.route === 'pc' || resolution.sourceAssessment?.source === 'local_state';
  let steps = planEligible && !desktopRequest ? parseHands(action) : null;
  if (privateRequest && steps?.length === 1 && steps[0]?.kind === 'search' && !steps[0].site && !input.browserPage) steps = null;
  const excludedFromWeb = notWebReason(tidy(action));
  if (planEligible && !steps && !privateRequest && !excludedFromWeb) {
    match('unsupported', unsupportedRequest(action, earlierAsks) || routing.handler === 'unsupported', { outcome: 'abstain' });
    match('skill', configured.skills && !isFollowUp(tidy(action)) && skillReadable(action, 'advice'), { strength: 'weak', legacy: input.skillHit === true });
  }
  const parsedQuery = resolution.kind === 'follow_up' && resolution.scope === 'public' ? resolution.query : null;
  const terms = new Set(topicWords(action));
  const contextualQuery = parsedQuery && topicWords(parsedQuery).some(word => !terms.has(word)) ? parsedQuery : null;
  const conversationQuery = planEligible && !steps && !privateRequest && !ambiguous ? publicConversationFollowup({
    request: text, resolution, previousSource: state.previousSource,
    earlierUserTurns: earlierAsks, pending: !!input.pendingCard,
  }) : null;
  const asked = planEligible && !ambiguous && !privateRequest && !steps && !(configured.memory && memoryRecallFormat(text)) && !projectInventoryFormat(text)
    ? (conversationQuery && webQuestion(conversationQuery)) || webQuestion(contextualQuery ?? action, contextualQuery ? [] : earlierAsks) : null;
  const publicLookup = steps?.length === 1 && steps[0]?.kind === 'search' && !steps[0].site && !input.browserPage ? steps : asked;
  const hands = state.hands?.steps ?? steps ?? asked ?? state.webFallback;
  const vettedSequence = planEligible && !privateRequest && hasPublicSequence(text, { now, self: selfFacts });
  const legacySequence = asked && !steps && !contextualQuery && planWebSequence(action, { now, self: selfFacts });
  if (publicLookup && !requestCapabilityAllowed(allowed, 'public_search')) match('unsupported', true, { outcome: 'abstain' });
  const adsReady = fullAccess && !!configured.ads && !(configured.memory && memoryRecallFormat(text));
  const mindReady = fullAccess && !!configured.mind;
  const deferred = !!(publicLookup && (mindReady || (adsReady && !steps)));
  match('web_sequence', vettedSequence || legacySequence || state.hands?.sequel, { eligible: !!vettedSequence, legacy: !!(legacySequence || state.hands?.sequel) && !deferred });
  if (hands?.length && !deferred) match(handlerForHands(hands), true,
    { eligible: !publicLookup || requestCapabilityAllowed(allowed, 'public_search') });

  match('document', document);
  const writing = !configured.chatModel && (state.writer ?? (fresh && !isCampaignRequest(text) ? writingTask(text) : null));
  match('writing', writing, { eligible: !!writing && !('unsupported' in writing), outcome: writing && 'unsupported' in writing ? 'abstain' : 'act' });
  match('planning', !configured.chatModel && (state.planner ?? (!state.writer && fresh ? planningTask(text) : null)));
  const direct = !state.steps || fresh ? directRoute(action) : null;
  if (direct) match(direct.screenshot ? 'browser_capture' : 'browser_direct', fresh || direct.finishes && input.browserPage);
  match('inventory', configured.inventory && fullAccess && projectInventoryFormat(text));
  match('ads', adsReady && (isCampaignRequest(text) || state.adsBrief || state.adsCampaign || looksEnglishRequest(text) || /\p{Script=Arabic}/u.test(text)),
    { strength: isCampaignRequest(text) || state.adsBrief || state.adsCampaign ? 'strong' : 'weak',
      eligible: !!(isCampaignRequest(text) || state.adsBrief || state.adsCampaign),
      legacy: !!(isCampaignRequest(text) || state.adsBrief || state.adsCampaign) });
  match('mind', mindReady, { strength: 'weak' });
  if (deferred && hands?.length) match(handlerForHands(hands), true, { eligible: requestCapabilityAllowed(allowed, 'public_search') });
  if (!configured.chatModel && !ownFact && !['compute', 'browser_command'].includes(routing.intent) && !reference) {
    match('skill', configured.skills && skillReadable(action, 'fallback'), { strength: 'weak', legacy: input.skillHit === true });
  }
  match('model', configured.chatModel, { strength: 'weak' });
  match('exhausted', !configured.chatModel, { strength: 'weak', outcome: 'abstain' });
  return { predicates: candidates, legacy: legacy ?? { action: 'abstain' } };
}
