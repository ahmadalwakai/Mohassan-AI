import { BrowserError } from '@mohassan/browser';
import { compileActionCompletionContract, createActionCompletionLedger, restoreActionCompletionLedger } from '../action-completion.js';
import type { BrainState } from '../brain.js';
import { createChoiceRequestSource, createClarifiedRequestSource } from '../effective-request-source.js';
import { parseUserRequestConstraints } from '../request-scope.js';
import type { RequestRoutingDecision, RoutedIntent } from '../routing-decision.js';

interface AnswerChoice {
  label: string;
  value: string;
  source?: string;
  private?: boolean;
  route?: RoutedIntent;
}

export interface ClarificationResumePlan {
  kind: 'entity' | 'route' | 'date' | 'account' | 'file' | 'conversion' | 'request';
  subject?: string;
  candidates: readonly AnswerChoice[];
  language: 'ar' | 'en';
}

interface ClarificationState {
  pendingClarification?: ClarificationResumePlan & { questionId: string };
  answeredClarification?: true;
}

export function hasPendingClarification(state: BrainState): boolean {
  return (state as BrainState & ClarificationState).pendingClarification !== undefined;
}

export function isPendingClarification(state: BrainState & ClarificationState, questionId: string): boolean {
  return state.pendingClarification?.questionId === questionId && !state.answeredClarification;
}

export function hasAnsweredClarification(state: BrainState): boolean {
  return (state as BrainState & ClarificationState).answeredClarification === true;
}

export function armClarification(state: BrainState, questionId: string, plan: ClarificationResumePlan): boolean {
  if (hasPendingClarification(state) || hasAnsweredClarification(state) || state.requestClarification || state.steps) return false;
  const { kind, language, subject } = plan;
  (state as BrainState & ClarificationState).pendingClarification = {
    questionId, kind, language, ...(subject ? { subject } : {}),
    candidates: plan.candidates.map(({ label, value, source, route, private: local }) => ({ label, value, source, route, private: local })),
  };
  return true;
}

interface ClarificationReply {
  runId: string;
  questionId: string | undefined;
  message: { id: string; text: string; priorRequest?: string };
  route: (text: string) => RequestRoutingDecision;
}

function cannotResume(ar: boolean): BrowserError {
  return new BrowserError('CHAT_CLARIFICATION_CHANGED', ar ? 'تعذّر ربط الإجابة بالطلب المعلّق.' : 'The answer could not be bound to the pending request.', 409);
}

function unsafeAnswer(ar: boolean, kind: ClarificationResumePlan['kind'], open: boolean): BrowserError {
  const text = open
    ? kind === 'request'
      ? ar ? 'أعد كتابة طلبك كاملاً واذكر الإجراء المقصود.' : 'Enter a complete request that says what you want me to do.'
      : ar ? 'اكتب القيمة المطلوبة أو أعد صياغة الطلب مع التفاصيل الناقصة.' : 'Enter the requested value or restate the request with the missing details.'
    : kind === 'route'
    ? ar ? 'اختر إجابة من البطاقة أو اكتب طلبًا كاملًا يحدّد الإجراء المطلوب.' : 'Choose an answer from the card or enter a complete request naming the action.'
    : ar ? 'اختر إجابة من البطاقة أو اكتب القيمة المقصودة فقط.' : 'Choose an answer from the card or enter just the requested value.';
  return new BrowserError('CHAT_CLARIFICATION_ANSWER_INVALID', text, 400);
}

function explicitAlternative(routing: RequestRoutingDecision): boolean {
  return routing.availability !== 'needs_context' && routing.resolution.kind === 'new'
    && !['clarify', 'reply', 'chat', 'unsupported'].includes(routing.route)
    && (routing.reason === 'deterministic_browser_plan' && Boolean(routing.browserSteps?.length)
      || !routing.sourceAssessment.reasons.some(reason => reason === 'nominal_public_subject' || reason === 'missing_target'));
}

const operandKey = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[\u0640\u064b-\u065f\u0670]/gu, '').replace(/\s+/gu, ' ').trim();

/** The host calls this inside the existing owner/card/run resume transaction. */
export function resumeClarification(state: BrainState & ClarificationState, input: ClarificationReply): boolean {
  const pending = state.pendingClarification;
  if (!pending) return false;
  const { runId, questionId, message } = input;
  const ar = pending.language === 'ar';
  const goal = message.priorRequest;
  if (!goal || pending.questionId !== questionId || state.answeredClarification || state.steps
    || !state.trail.every(entry => entry.action === 'asked the user')
    || state.computationMemory !== undefined || state.userFactMemory !== undefined) throw cannotResume(ar);
  const priorLedger = restoreActionCompletionLedger(state.actionCompletion, { runId, request: goal });
  if (state.actionCompletion !== undefined && (!priorLedger || priorLedger.events.length || priorLedger.fault)) throw cannotResume(ar);

  const routeChoice = pending.kind === 'route';
  const openCard = pending.candidates.length === 0;
  const invalidAnswer = () => unsafeAnswer(ar, pending.kind, openCard);
  const choice = pending.candidates.find(candidate => routeChoice ? candidate.label === message.text
    : [candidate.label, candidate.value].some(value => operandKey(value) === operandKey(message.text)));
  const edited = pending.kind === 'request' || pending.kind === 'route' ? null
    : createChoiceRequestSource(goal, message.text, message.id, { kind: pending.kind, ...(pending.subject ? { subject: pending.subject } : {}) });
  const responseRoute = routeChoice || openCard && !(pending.kind === 'conversion' && edited) ? input.route(message.text) : null;
  const fullRequest = routeChoice || Boolean(responseRoute && explicitAlternative(responseRoute));
  const source = fullRequest ? createClarifiedRequestSource(message.text, message.id) : null;
  const clarified = fullRequest ? source && { request: message.text, source } : edited;
  if (!clarified || clarified.request === goal) throw invalidAnswer();

  const priorConstraints = parseUserRequestConstraints(goal)?.forbiddenCapabilities ?? [];
  const nextConstraints = parseUserRequestConstraints(clarified.request)?.forbiddenCapabilities ?? [];
  if (priorConstraints.some(capability => !nextConstraints.includes(capability))) throw invalidAnswer();
  const routing = fullRequest && responseRoute ? responseRoute : input.route(clarified.request);
  if (routeChoice && (routing.availability !== 'ready' || (choice
    ? choice.value !== message.text || routing.route !== choice.route
    : !explicitAlternative(routing)))) throw invalidAnswer();
  if (openCard && routing.availability === 'needs_context') throw invalidAnswer();
  const wasPrivate = state.requestResolution?.scope === 'private' || state.requestResolution?.sourceAssessment?.scope === 'private'
    || state.requestResolution?.kind === 'ambiguous' && state.previousSource?.scope === 'private';
  const literalPrivate = choice?.source === 'memory' || choice?.private || pending.kind === 'account' || pending.kind === 'file';
  const publicDestination = ['web_search', 'news', 'browser_command'].includes(routing.route) || routing.sourceAssessment.publicQueryEligible;
  if ((wasPrivate || literalPrivate) && (publicDestination || routing.resolution.scope === 'public')
    || literalPrivate && routing.resolution.scope !== 'private') throw invalidAnswer();
  if (!fullRequest && pending.kind === 'entity' && state.requestResolution?.sourceAssessment?.publicQueryEligible
    && (routing.sourceAssessment.scope !== 'public' || routing.sourceAssessment.operation !== 'lookup')) throw invalidAnswer();

  const contract = compileActionCompletionContract({ runId, request: clarified.request });
  if (!contract) throw cannotResume(ar);
  state.clarifiedRequest = clarified.request;
  state.clarifiedRequestSource = clarified.source;
  // A host-composed operand or route selection is not a verbatim note to save.
  delete state.requestOriginalHash;
  state.actionCompletion = createActionCompletionLedger(contract);
  state.requestResolution = routing.resolution;
  if (routing.resolution.nextState) state.requestContext = routing.resolution.nextState;
  const { route, intent, handler, availability, missingCapabilities, reason } = routing;
  state.routing = { route, intent, handler, availability, missingCapabilities, reason };
  state.trail.push({ step: state.steps, action: 'asked the user', result: `user answered: ${message.text.slice(0, 400)}`, changed: true });
  state.failures = 0;
  state.unchanged = 0;
  delete state.pendingClarification;
  delete state.requestClarification;
  state.answeredClarification = true;
  return true;
}
