import type { ChatQuestion } from '@mohassan/contracts';
import type { CommandChatConfig } from '../../command-chat.js';
import type { BrainState } from '../brain.js';
import type { HandsStep } from '../hands.js';
import { requestCapabilityAllowed, type UserRequestConstraints } from '../request-scope.js';
import { decideRequestRoute, rankClarificationRoutes, type RequestRoutingDecision } from '../routing-decision.js';
import type { ShadowRouteCandidate, ShadowRouter } from '../router.js';
import { applyChoiceRequestEdit } from './choice-request.js';
import { armClarification, hasAnsweredClarification } from './resume.js';
import { clarificationCard, clarificationLanguage, decideClarification, legacyClarificationNeeded, missingClarificationDetail,
  missingClarificationSlot, type ClarificationChoice, type ClarificationKind, type ClarificationPlan } from './policy.js';
import { clarificationEntityReference, conversationClarificationCandidates, lookupClarificationCandidates } from './sources.js';

type SourceInput = Parameters<typeof lookupClarificationCandidates>[0];

interface ClarificationGateInput {
  enabled: boolean;
  eligible: boolean;
  request: string;
  actionRequest: string;
  state: BrainState;
  history: readonly { role: string; text: string }[];
  ownerId: string;
  signal: AbortSignal;
  constraints: UserRequestConstraints | null;
  shadowRouter?: ShadowRouter;
  search?: SourceInput['search'];
  readPage?: SourceInput['readPage'];
  memory?: SourceInput['memory'];
  route: (request: string) => RequestRoutingDecision;
  pause: (question: ChatQuestion) => Promise<void>;
  block: (text: string) => Promise<void>;
}

export function clarificationEnabled(override?: boolean): boolean {
  return override ?? process.env.MOHASSAN_CLARIFY_CHOICES === '1';
}

export function routeClarifiedRequest(text: string, config: CommandChatConfig, fullAccess: boolean, chatModel: boolean, turnId?: string) {
  return decideRequestRoute({ text, fullAccess, turnId, capabilities: { browser: true, search: true, planner: true,
    memory: Boolean(config.tools?.memory), adsModel: Boolean(config.adsModel), computer: Boolean(config.tools?.computer),
    coding: Boolean(config.tools?.work?.code), chatModel, writerModel: chatModel } });
}

export function needsClarificationBeforeDesktop(enabled: boolean, text: string, state: BrainState): boolean {
  return enabled && !hasAnsweredClarification(state) && missingClarificationSlot(text, state.requestResolution) === 'file';
}

/** An explicit broad knowledge question can contain “you” and look like small talk to the hands parser. */
export function clarifiedPublicLookup(state: BrainState, text: string): HandsStep[] | null {
  if (!hasAnsweredClarification(state) || state.routing?.route !== 'web_search' || !state.requestResolution?.sourceAssessment?.publicQueryEligible) return null;
  const query = clarificationEntityReference(text);
  return query ? [{ kind: 'search', query, site: null, ask: true }] : null;
}

const danglingReference = /(?<!\p{L})(?:it|that|this|them|هذا|هذه|ذلك|تلك)(?!\p{L})/iu;

function report(enabled: boolean, legacyWouldAsk: boolean, decision: string, kind: ClarificationKind, count: number, b0Count: number) {
  console.info(JSON.stringify({ event: 'clarification_shadow', enabled, legacyWouldAsk, decision, kind, candidateCount: count, b0Count }));
}

/** Inspect only eligible, unstarted work. Shadow evaluation uses the local evidence already available. */
export async function runClarificationGate(input: ClarificationGateInput): Promise<boolean> {
  const { enabled, state, request, actionRequest, constraints } = input;
  if (!input.eligible || hasAnsweredClarification(state) || state.clarificationAttempts) return false;

  const legacyWouldAsk = legacyClarificationNeeded(state.requestResolution);
  const language = clarificationLanguage(request);
  const missing = missingClarificationSlot(actionRequest, state.requestResolution);
  const named = clarificationEntityReference(actionRequest);
  let shadow: readonly ShadowRouteCandidate[] = [];
  try { shadow = input.shadowRouter?.candidates?.(request) ?? []; } catch { /* The shadow never holds up a request. */ }
  const ranked = rankClarificationRoutes(actionRequest, state.routing, shadow);
  const branches = constraints ? [] : ranked.filter(candidate => candidate.request && candidate.request.length <= 120);
  const routeChoices: ClarificationChoice[] = [];
  for (const candidate of branches) {
    if (!candidate.request) continue;
    const routing = input.route(candidate.request);
    if (routing.route !== candidate.route || routing.availability !== 'ready') continue;
    if (state.requestResolution?.scope === 'private' && routing.resolution.scope === 'public') continue;
    routeChoices.push({ label: candidate.request, value: candidate.request, source: candidate.source, score: candidate.score, route: candidate.route });
  }

  let plan: ClarificationPlan | undefined;
  if (routeChoices.length === branches.length && routeChoices.length >= 2) {
    const route = decideClarification({ kind: 'route', language, candidates: routeChoices });
    if (route.decision === 'ask') plan = route.plan;
    report(enabled, legacyWouldAsk, route.decision, 'route', routeChoices.length, shadow.length);
  }

  if (!plan && (missing || named || legacyWouldAsk)) {
    const kind: Exclude<ClarificationKind, 'route'> = missing ?? 'entity';
    const subject = kind === 'entity' ? named ?? actionRequest.match(danglingReference)?.[0] : undefined;
    const reference = kind === 'entity' ? named : null;
    const publicSubject = Boolean(named && state.requestResolution?.scope !== 'private' && state.requestResolution?.sourceAssessment?.publicQueryEligible);
    const local = conversationClarificationCandidates({ text: actionRequest, kind, reference, history: input.history });
    const forDestination = (candidate: ClarificationChoice) => {
      if (publicSubject && (candidate.source === 'memory' || candidate.private)) return false;
      // Keep the explicit-subject candidate as evidence of a clear winner.
      if (candidate.score >= 0.95 && candidate.label === subject) return true;
      const revised = applyChoiceRequestEdit(request, candidate.label, { kind, subject });
      return revised !== null && revised !== request && revised.length <= 4000;
    };
    const options: Pick<ClarificationPlan, 'kind' | 'language' | 'subject'> = { kind, language, subject };
    let decision = decideClarification({ ...options, candidates: local.filter(forDestination) });
    if (enabled && decision.decision !== 'clear_winner') {
      const search = publicSubject && requestCapabilityAllowed(constraints, 'public_search') ? input.search : undefined;
      const memory = !publicSubject && requestCapabilityAllowed(constraints, 'memory_read') ? input.memory : undefined;
      const found = await lookupClarificationCandidates({ text: actionRequest, kind, reference, ownerId: input.ownerId,
        signal: input.signal, search, readPage: input.readPage, memory });
      input.signal.throwIfAborted();
      decision = decideClarification({ ...options, candidates: [...local, ...found].filter(forDestination) });
    }
    if (decision.decision === 'ask') plan = decision.plan;
    report(enabled, legacyWouldAsk, decision.decision, kind, decision.decision === 'ask' ? decision.plan.candidates.length : decision.count, shadow.length);
    if (enabled && !plan && (legacyWouldAsk || missing) && decision.decision === 'insufficient_evidence') {
      await input.block(missingClarificationDetail(kind, language));
      return true;
    }
  }

  if (!enabled || !plan) return false;
  const card = clarificationCard(plan);
  if (!armClarification(state, card.id, plan)) return false;
  await input.pause(card);
  return true;
}
