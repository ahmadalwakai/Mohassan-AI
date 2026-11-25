import { loadScratchClassifiers, type ScratchClassifiers, type ScratchHead, type ScratchPrediction } from '@mohassan/scratch-classifiers';
import { webQuestion } from './hands.js';
import { buildFrame } from './mind/frame.js';
import { hasQuantitativeQuestion } from './quantitative-question.js';
import { arithmeticSearchEnabled } from './arithmetic-search-settings.js';
import { parseRequestContextState, requestActionText } from './request-context.js';
import { maskRequestLiteralData, requestScopeActionText } from './request-scope.js';
import type { RequestRoutingDecision, RequestRoutingInput, RoutedIntent } from './routing-decision.js';
import { unsupportedRequest } from './unsupported-request.js';

type FollowUp = 'follow_up' | 'new';
export interface ScratchRoutingChoices {
  followUp?: FollowUp;
  smalltalk?: boolean;
  route?: RoutedIntent;
  refusal?: 'refuse' | 'out_of_scope';
}

interface DecisionTrace {
  event: 'scratch_classifiers';
  turnId?: string;
  enabled: boolean;
  decisions: Record<ScratchHead, { rule: string; model: ScratchPrediction; selected: string }>;
}

export interface ScratchDecisionPolicy {
  enabled: boolean;
  predictAll: ScratchClassifiers['predictAll'];
  report(trace: DecisionTrace): void;
}

function readRuntimeModels(): ScratchClassifiers | null {
  try { return loadScratchClassifiers(); }
  catch {
    console.warn(JSON.stringify({ event: 'scratch_classifiers_unavailable' }));
    return null;
  }
}

let runtimeModels = process.env.VITEST ? undefined : readRuntimeModels();

export function runtimeScratchPolicy(): ScratchDecisionPolicy | null {
  const enabled = process.env.MOHASSAN_SCRATCH_CLASSIFIERS === '1';
  if (process.env.VITEST && !enabled) return null;
  if (runtimeModels === undefined) runtimeModels = readRuntimeModels();
  return runtimeModels ? {
    enabled, predictAll: runtimeModels.predictAll,
    report: trace => console.info(JSON.stringify(trace)),
  } : null;
}

const PUBLIC_ROUTES = new Set<RoutedIntent>(['web_search', 'news']);
const FALLBACK_ROUTES = new Set<RoutedIntent>(['writing', 'reminder', 'chat']);

function choose(input: RequestRoutingInput, rule: RequestRoutingDecision, predictions: Record<ScratchHead, ScratchPrediction>,
    hasPublicHistory: boolean, ruleRefusal: boolean): ScratchRoutingChoices {
  const choices: ScratchRoutingChoices = {};
  const resolution = rule.resolution;
  if (input.pendingQuestion || resolution.constraints || !resolution.resolved || resolution.kind === 'answer'
      || Array.from(input.text).length > 512) return choices;
  const source = rule.sourceAssessment;
  // An available public lookup already has an authorized source and a usable query.
  if (rule.handler === 'search' && rule.availability === 'ready' && rule.publicQuery !== null
      && source.publicQueryEligible) return choices;
  const followUp = predictions.followUp.label;
  const publicRoute = rule.intent === 'unknown' || PUBLIC_ROUTES.has(rule.intent);
  if (hasPublicHistory && publicRoute && source.scope !== 'private'
      && (followUp === 'follow_up' && resolution.kind !== 'follow_up' && !source.reasons.includes('explicit_new_task')
        || followUp === 'new' && resolution.kind === 'follow_up')) {
    choices.followUp = followUp;
  }

  const unresolved = source.source === 'unresolved' && source.reasons.includes('missing_target');
  const fallback = unresolved && (rule.handler === 'clarify' && publicRoute
    || rule.reason === 'local_model_fallback' && (rule.route === 'chat' || publicRoute));
  const explicitLookup = source.reasons.some(reason => reason === 'explicit_public_lookup' || reason === 'public_document_reference');
  const defaultLookup = rule.route === 'web_search' && source.publicQueryEligible && !explicitLookup && !rule.browserSteps;
  // The scope classifier also offers search for otherwise unrecognized short noun phrases.
  // Only that fallback may be reassigned by the learned refusal and news labels.
  const nominalLookup = defaultLookup && source.reasons.includes('nominal_public_subject');
  const action = defaultLookup ? requestActionText(requestScopeActionText(resolution.resolved)) : '';
  const nominalFrame = nominalLookup ? buildFrame(action) : null;
  const nominalFallback = nominalFrame !== null && nominalFrame.intent !== 'compare'
    && !nominalFrame.matched.some(({ rule }) => rule === 'property-and-topic' || rule === 'factual-report');
  const refusal = predictions.refusal.label;
  if (!ruleRefusal && resolution.kind === 'new' && (fallback || nominalFallback)
      && (refusal === 'refuse' || refusal === 'out_of_scope')) {
    if (arithmeticSearchEnabled() && hasQuantitativeQuestion(maskRequestLiteralData(resolution.resolved))) return choices;
    return { refusal };
  }

  if (!ruleRefusal && resolution.kind === 'new' && predictions.speechAct.label === 'smalltalk') {
    if (fallback && source.operation === 'unknown') return { smalltalk: true };
    if (nominalFallback || defaultLookup && !nominalLookup && !webQuestion(action)) return { smalltalk: true };
  }
  const route = predictions.route.label as RoutedIntent | undefined;
  if (!ruleRefusal && resolution.kind === 'new' && route !== undefined && route !== rule.route) {
    if (route === 'news' && nominalFallback || FALLBACK_ROUTES.has(route) && fallback) choices.route = route;
  }
  return choices;
}

export function applyScratchRouting(input: RequestRoutingInput, rule: RequestRoutingDecision, policy: ScratchDecisionPolicy,
    reroute: (choices: ScratchRoutingChoices) => RequestRoutingDecision): RequestRoutingDecision {
  const previous = parseRequestContextState(input.context);
  let predictions: Record<ScratchHead, ScratchPrediction>;
  try { predictions = policy.predictAll(input.text, { previousText: previous?.topic ?? undefined }); }
  catch { return rule; }

  const ruleRefusal = rule.handler === 'unsupported' || (rule.resolution.kind === 'new' && rule.resolution.scope !== 'private'
    && !rule.browserSteps && Boolean(unsupportedRequest(input.text, previous?.topic ? [previous.topic] : [])));
  const choices = policy.enabled ? choose(input, rule, predictions, previous?.scope === 'public' && Boolean(previous.topic), ruleRefusal) : {};
  let selected = Object.values(choices).some(Boolean) ? reroute(choices) : rule;
  if (choices.followUp && selected.resolution.kind !== choices.followUp) selected = rule;

  const trace = (head: ScratchHead, baseline: string, effective = baseline) => ({ rule: baseline, model: predictions[head], selected: effective });
  const ruleSpeech = rule.handler === 'local_conversation' && !rule.resolution.constraints?.standalone ? 'smalltalk' : 'request';
  policy.report({ event: 'scratch_classifiers', turnId: input.turnId, enabled: policy.enabled, decisions: {
    refusal: trace('refusal', ruleRefusal ? 'out_of_scope' : 'allow',
      selected.reason === 'scratch_refuse' ? 'refuse' : selected.reason === 'scratch_out_of_scope' || ruleRefusal ? 'out_of_scope' : 'allow'),
    speechAct: trace('speechAct', ruleSpeech, selected.reason === 'scratch_speech_act' ? 'smalltalk' : ruleSpeech),
    route: trace('route', rule.route, selected.route),
    followUp: trace('followUp', rule.resolution.kind, selected.resolution.kind),
  } });
  return selected;
}
