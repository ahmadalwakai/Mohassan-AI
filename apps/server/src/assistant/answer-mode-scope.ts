import type { BrainState } from './brain.js';
import { isBareAddress, parseHands, webQuestion } from './hands.js';
import { evaluateLocalComputation } from './local-computation.js';
import { sequenceParts } from './local-sequence.js';
import { detectManners } from './manners/detect.js';
import { buildFrame } from './mind/frame.js';
import { ownFactQuestion } from './own-fact-question.js';
import { recognizePreferredLanguageRequest } from './preferred-language-fact.js';
import { startsFactualQuestion } from './public-question-syntax.js';
import { splitReplyDirective } from './reply-directive.js';
import { requestActionText } from './request-context.js';
import { assessRequestScope, maskRequestLiteralData, requestCapabilityAllowed, requestOperationText, requestScopeActionText, reviewPublicProjection } from './request-scope.js';
import { monitoringRequest } from './response-policy-signals.js';
import type { RequestRoute } from './routing-decision.js';
import { recognizeSelfQuestion } from './self-knowledge.js';
import { writingTask } from './writer.js';
import { detectMonitorNeed } from '../monitors/detection.js';
import { parseMonitorManagement } from '../monitors/v2-chat-intents.js';

const routeExemptions: Partial<Record<RequestRoute, 'arithmetic' | 'personal' | 'action' | 'plan' | 'campaign'>> = {
  compute: 'arithmetic',
  memory: 'personal',
  pc: 'action',
  reminder: 'action',
  browser_command: 'action',
  coding: 'action',
  media: 'action',
  image: 'action',
  planning: 'plan',
  ads: 'campaign',
};

type Exemption = NonNullable<(typeof routeExemptions)[RequestRoute]> | 'control' | 'conversation' | 'local-content' | 'monitor';
type ScopeState = Pick<BrainState, 'routing' | 'requestResolution' | 'previousSource' | 'actionCompletion'>;

export type CouncilWebTurn =
  | { kind: 'exempt'; reason: Exemption }
  | { kind: 'factual'; question: string; query: string }
  | { kind: 'factual'; question: string; query: null; reason: 'search_forbidden' | 'unsafe_query' };

const exempt = (reason: Exemption): CouncilWebTurn => ({ kind: 'exempt', reason });
const factualWriting = /^(?:(?:write|draft|prepare|produce|make|create)\s+(?:me\s+)?(?:(?:an?|the|short|brief|factual)\s+){0,4}(?:report|explanation|history|essay|timeline|csv|fact sheet)\b|(?:اكتب|اعد|انشئ)(?:\s+لي)?\s+(?:تقرير|شرح|تاريخ|جدول زمني|مقال|ملخص حقائق)(?!\p{L}))/iu;
const createMonitor = /^(?:(?:create|set up|start)\s+(?:a\s+)?monitor\b|(?:اعد|انشئ|ابد[اأ]|فعل)(?:\s+لي)?\s+(?:مراقبه|المراقبه)(?!\p{L}))/iu;
const withoutWeb = /(?:\bwithout (?:searching|browsing|using) (?:the )?(?:web|internet)\b|\b(?:answer|respond) from (?:your )?memory only\b|(?<!\p{L})(?:بدون|دون|بلا) (?:البحث|بحث|التصفح|تصفح)(?: (?:على|علي|في))? (?:الويب|الانترنت)(?!\p{L}))/iu;

/** Apply the host's route and source boundaries before any council-web lookup. */
export function classifyCouncilWebTurn(request: string, state: ScopeState, now?: Date): CouncilWebTurn {
  const { routing, requestResolution: resolution, previousSource, actionCompletion } = state;
  const manners = detectManners(request);
  const action = requestActionText(requestScopeActionText(manners?.request ?? request));
  const question = splitReplyDirective(action).body;
  const scopeOptions = { contextKind: resolution?.kind, previous: previousSource ?? undefined };
  const source = assessRequestScope(requestActionText(request), scopeOptions);
  const publicQuestion = source.source === 'public_lookup' && source.operation !== 'act';
  const routeExemption = routing && routeExemptions[routing.route];

  if (routing?.availability === 'restricted' || routing?.route === 'unsupported' || routing?.handler === 'resume') return exempt('control');
  if (routing?.handler === 'local_status' || recognizeSelfQuestion(action)
      || !manners?.request && (routing?.handler === 'local_conversation' || source.operation === 'converse')) return exempt('conversation');
  const operation = requestOperationText(question);
  if (parseMonitorManagement(action) || monitoringRequest(operation) || createMonitor.test(operation)
      || detectMonitorNeed({ text: action })?.kind === 'explicit') return exempt('monitor');
  if (routeExemption === 'plan') return exempt('plan');
  if (routeExemption === 'campaign' && !publicQuestion) return exempt('campaign');
  if (ownFactQuestion(action) || recognizePreferredLanguageRequest(action) || source.source === 'prior_conversation') return exempt('personal');
  const steps = parseHands(action);
  const oneSearch = steps?.length === 1 && steps[0]?.kind === 'search' && !steps[0].here ? steps[0] : undefined;
  if (source.source === 'local_state' || source.operation === 'act' || actionCompletion?.contract.requirements.length || isBareAddress(action)
      || steps?.some(step => !['search', 'news'].includes(step.kind))) return exempt('action');
  if (source.source === 'supplied_content' && source.operation === 'transform') return exempt('local-content');

  const frame = buildFrame(question);
  const writerSource = ['writing', 'clarify', 'web_search'].includes(routing?.route ?? '') ? writingTask(question, 'extractive')?.source : undefined;
  const needsFacts = publicQuestion || startsFactualQuestion(operation) || factualWriting.test(operation)
    || ['fact_question', 'explain', 'compare'].includes(frame.intent) || writerSource?.kind === 'search';
  if (routeExemption === 'personal') return exempt('personal');
  // Coding and site search may be requests for public information despite the route name.
  if (routeExemption === 'action' && !oneSearch && !needsFacts) return exempt('action');
  const compoundFacts = routeExemption === 'arithmetic' && sequenceParts(action)?.some(part => assessRequestScope(part).source === 'public_lookup');
  if (!compoundFacts && (routeExemption === 'arithmetic' && !publicQuestion
      || frame.intent === 'compute' && evaluateLocalComputation(action, now)?.status === 'completed')) return exempt('arithmetic');
  if (routing?.route === 'writing' && !needsFacts) return exempt('local-content');
  if (routing?.route === 'clarify' && !needsFacts) return exempt('control');
  if (routing?.route === 'clarify' && resolution?.kind === 'ambiguous' && source.reasons.includes('unresolved_reference')) return exempt('control');

  if (!requestCapabilityAllowed(source.constraints ?? null, 'public_search') || withoutWeb.test(requestOperationText(maskRequestLiteralData(request)))) {
    return { kind: 'factual', question, query: null, reason: 'search_forbidden' };
  }
  const contextualQuestion = resolution?.kind === 'follow_up' ? resolution.query : null;
  const web = webQuestion(contextualQuestion ?? question);
  const lookup = web?.length === 1 && web[0]?.kind === 'search' ? web[0].query : null;
  const query = (oneSearch?.query ?? contextualQuestion ?? lookup ?? (writerSource?.kind === 'search' ? writerSource.query : null) ?? question).trim();
  const resolvedQuestion = contextualQuestion || question;
  // Match the search router's personal-context veto for implicit lookups.
  const explicitlyPublic = source.reasons.some(reason => reason === 'explicit_public_lookup' || reason === 'public_document_reference');
  if (query.length > 500 || !explicitlyPublic && frame.personal || !reviewPublicProjection(requestActionText(request), query, scopeOptions).eligible) {
    return { kind: 'factual', question: resolvedQuestion, query: null, reason: 'unsafe_query' };
  }
  return { kind: 'factual', question: resolvedQuestion, query };
}
