import { legacyClarificationNeeded } from './clarify/policy.js';
import { detectManners, type MannersDialect, type SpeechAct } from './manners/detect.js';
import { matchText, normalizeRequest } from './mind/normalize.js';
import { splitReplyDirective, type ReplyField, type ReplyLanguage } from './reply-directive.js';
import { maskRequestLiteralData, type UserRequestConstraints } from './request-constraints.js';
import { returnParts } from './return-to.js';
import type { RequestContextIntent, RequestResolution } from './request-context.js';
import type { RequestRoute, RoutedIntent, RoutingHandler } from './routing-decision.js';
import {
  asksForCoverage, asksForScalar, avoidFollowUp, backgroundWork, conflictingHistory, deepResearch, expectsExplanation,
  explicitLength, explicitReplyLocale, externalHistory, interactiveOnly, monitoringRequest, multipleQuestions, noHistory, olderReference,
  recapConversation, requestDialect, requestedNextStep, requestedStructure, resumeWork, substantialBuild, suggestedStructure,
} from './response-policy-signals.js';

export type ReplyLength = 'short' | 'medium' | 'long';
export type ReplyStructure = 'prose' | 'list' | 'steps' | 'sections' | 'requested';
export type ResponseContextTrigger = 'older_reference' | 'recap' | 'conflict' | 'resume';

export interface ResponsePolicyInput {
  text: string;
  route?: RequestRoute;
  intent?: RequestContextIntent | RoutedIntent;
  handler?: RoutingHandler;
  /** These are host observations about this turn and this conversation. */
  speechAct?: SpeechAct | null;
  clarification?: 'needed' | 'pending' | 'answered';
  constraints?: UserRequestConstraints | null;
  resolution?: RequestResolution | null;
  language?: ReplyLanguage;
  dialect?: MannersDialect | null;
  channel?: 'web' | 'phone';
  previousTurns?: number;
  recentTurns?: number;
  historyConflict?: boolean;
  resumingLongWork?: boolean;
  backgroundRequested?: boolean;
  currentLength?: ReplyLength;
  /** A concrete next action supported by the current result, supplied by the host. */
  concreteNextStep?: string | null;
}

export interface ResponsePolicyDecision {
  length: ReplyLength;
  /** Keep the existing answer length on uncertain requests. Length preferences never authorize dropping content. */
  preserveCurrentLength: boolean;
  followUp: 'none' | 'ask' | 'offer';
  structure: ReplyStructure;
  contextScope: 'recent' | 'full';
  contextTrigger: ResponseContextTrigger | null;
  /** A request to use only the current material overrides routine transcript inclusion too. */
  includeEarlierTurns: boolean;
  /** A work recommendation. Admission and execution still require the existing host permission checks. */
  workMode: 'interactive' | 'long_running';
  language: ReplyLanguage;
  dialect: MannersDialect | null;
  sentences: number | null;
  requiredFields: readonly ReplyField[];
  nextStep: string | null;
}

export const POLICY_RECENT_TURNS = 6;
const MAX_POLICY_REQUEST = 8000;

function contextTrigger(input: ResponsePolicyInput, text: string, includeEarlierTurns: boolean): ResponseContextTrigger | null {
  const previousTurns = input.previousTurns ?? 0;
  if (!previousTurns || !includeEarlierTurns || externalHistory.test(text)) return null;
  if (input.historyConflict || conflictingHistory(text)) return 'conflict';
  if (recapConversation(text)) return 'recap';
  if (input.resumingLongWork || resumeWork(text)) return 'resume';
  if (previousTurns > (input.recentTurns ?? POLICY_RECENT_TURNS) && (olderReference(text) || returnParts(input.text))) return 'older_reference';
  return null;
}

function followUp(input: ResponsePolicyInput, text: string, scope: ResponseContextTrigger | null, nextStep: string | null) {
  if (avoidFollowUp.test(text) || input.clarification === 'pending') return 'none';
  const required = input.clarification === 'needed' || input.clarification !== 'answered' && !scope
    && (input.route === 'clarify' || legacyClarificationNeeded(input.resolution));
  if (required) return 'ask';
  if (nextStep || requestedNextStep(text)) return 'offer';
  return 'none';
}

function workMode(input: ResponsePolicyInput, text: string, constraints: UserRequestConstraints | null,
  follow: ResponsePolicyDecision['followUp'], socialOnly: boolean) {
  if (!text || interactiveOnly.test(text) || follow === 'ask' || socialOnly || input.clarification === 'pending'
    || input.route === 'clarify' || input.route === 'unsupported' || constraints?.standalone || constraints?.ambiguous) return 'interactive';
  const implementation = ['coding', 'planning'].some(kind => kind === input.route || kind === input.intent);
  if (input.resumingLongWork || Boolean(input.previousTurns && resumeWork(text)) || input.backgroundRequested || backgroundWork(text) || monitoringRequest(text) || deepResearch(text) || substantialBuild(text, implementation)) {
    return 'long_running';
  }
  return 'interactive';
}

function lengthFor(input: ResponsePolicyInput, text: string, structure: ReplyStructure, explicit: ReplyLength | null,
  socialOnly: boolean, follow: ResponsePolicyDecision['followUp'], coverage: boolean): Pick<ResponsePolicyDecision, 'length' | 'preserveCurrentLength'> {
  if (explicit) return { length: explicit, preserveCurrentLength: false };
  if (follow === 'ask' || socialOnly && input.speechAct !== 'capabilities') return { length: 'short', preserveCurrentLength: false };
  if (structure === 'sections' || structure === 'steps' && coverage) return { length: 'long', preserveCurrentLength: false };
  if (structure === 'steps' || structure === 'list' || expectsExplanation.test(text)) {
    return { length: input.currentLength === 'long' ? 'long' : 'medium', preserveCurrentLength: input.currentLength === 'long' };
  }
  if (!coverage && structure === 'prose' && follow === 'none' && (input.route === 'compute' || input.intent === 'compute'
    || input.handler === 'local_computation' || asksForScalar.test(text) || input.channel === 'phone' && /[?؟]$/u.test(text) && text.split(/\s+/u).length <= 5)) {
    return { length: 'short', preserveCurrentLength: false };
  }
  return { length: input.currentLength ?? 'medium', preserveCurrentLength: true };
}

/** Decide a turn's shape without changing its request, evidence, permissions, or existing verified reply. */
export function decideResponsePolicy(input: ResponsePolicyInput): ResponsePolicyDecision {
  const text = input.text.length <= MAX_POLICY_REQUEST ? input.text : '';
  const constraints = input.constraints ?? input.resolution?.constraints ?? null;
  const outer = maskRequestLiteralData(text).trim();
  const normalized = matchText(outer).replace(/[’‘]/gu, "'").replace(/\s+/gu, ' ');
  const manners = input.speechAct === undefined ? detectManners(text) : null;
  const speechAct = input.speechAct ?? manners?.act;
  const socialOnly = Boolean(speechAct && (manners ? !manners.request : !input.route || input.route === 'chat' || input.route === 'reply'));
  const phrase = splitReplyDirective(outer);
  const directive = phrase.directive;
  const task = matchText(normalizeRequest(phrase.body).text).replace(/[’‘]/gu, "'").replace(/\s+/gu, ' ');
  const actionText = constraints?.safeActionText ? matchText(maskRequestLiteralData(constraints.safeActionText)).replace(/\s+/gu, ' ').trim() : normalized;
  const locale = explicitReplyLocale(normalized);
  const language = locale?.language ?? directive?.lang ?? input.language ?? manners?.language ?? normalizeRequest(text).lang;
  const dialect = language === 'ar' ? locale?.dialect ?? input.dialect ?? manners?.dialect ?? requestDialect(task) : null;
  const includeEarlierTurns = !noHistory.test(normalized) && !constraints?.forbiddenCapabilities.includes('memory_read');
  const scope = contextTrigger(input, normalized, includeEarlierTurns);
  const nextStep = input.concreteNextStep?.trim() || null;
  const follow = followUp(input, normalized, scope, nextStep);
  const explicit = explicitLength(normalized) ?? (directive?.sentences ? directive.sentences === 1 ? 'short' : 'medium'
    : directive?.brief ? 'short' : null);
  const coverage = asksForCoverage.test(normalized) || multipleQuestions.test(task) || Boolean(directive?.fields?.length);
  const structure = requestedStructure(normalized) ?? (directive?.sentences || follow === 'ask' ? 'prose' : suggestedStructure(task));

  return {
    ...lengthFor({ ...input, speechAct }, task, structure, explicit, socialOnly, follow, coverage),
    followUp: follow, structure,
    contextScope: scope ? 'full' : 'recent', contextTrigger: scope, includeEarlierTurns,
    workMode: workMode(input, actionText, constraints, follow, socialOnly),
    language, dialect, sentences: directive?.sentences ?? null, requiredFields: directive?.fields ?? [],
    nextStep: follow === 'offer' ? nextStep : null,
  };
}
