import { collectCandidates } from './candidates.js';
import { buildInterpretations } from './interpretations.js';
import type { DecisionOutcome, DecisionReason, DecisionRoute, Deliberation, DeliberationInput, EvidenceCode, ThoughtRecord } from './types.js';

export const requestCosts = {
  conversation: { wrongAction: 1, extraQuestion: 1.25, refusal: 1.5 },
  read: { wrongAction: 3.5, extraQuestion: 1.6, refusal: 3.5 },
  write: { wrongAction: 12, extraQuestion: 1.6, refusal: 4 },
  ads: { wrongAction: 45, extraQuestion: 1.7, refusal: 5 },
} as const;

export type RequestClass = keyof typeof requestCosts;
const publicReads = new Set<DecisionRoute>(['web_search', 'news', 'knowledge', 'inventory', 'skill', 'capture', 'memory', 'image']);
const externalActions = new Set<DecisionRoute>(['browser_command', 'pc', 'document', 'site', 'reminder', 'coding', 'media', 'resume', 'reply']);

export function requestClass(route: DecisionRoute, operation?: DeliberationInput['routing']['sourceAssessment']['operation'], handler?: string): RequestClass {
  if (handler === 'local_sequence') return 'conversation';
  if (handler === 'web_sequence' || handler === 'local_computer') return 'read';
  if (route === 'ads') return 'ads';
  if (route === 'memory' && operation === 'act') return 'write';
  if (publicReads.has(route)) return 'read';
  if (externalActions.has(route) || route === 'compound') return 'write';
  return 'conversation';
}

export function expectedCosts(kind: RequestClass, confidence: number) {
  const costs = requestCosts[kind];
  return {
    act: (1 - confidence) * costs.wrongAction,
    ask: costs.extraQuestion,
    abstain: confidence * costs.refusal,
  };
}

export function leastCostAction(kind: RequestClass, confidence: number): DecisionOutcome['action'] {
  const costs = expectedCosts(kind, confidence);
  if (costs.act < costs.ask && costs.act < costs.abstain) return 'act';
  return costs.ask <= costs.abstain ? 'ask' : 'abstain';
}

// Reproducibly fitted on the benchmark's separate development split.
export const DELIBERATION_TEMPERATURE = 4.5;
export const COST_POLICY_TEMPERATURE = 5.5;

export function confidenceForMargin(margin: number, temperature = DELIBERATION_TEMPERATURE): number {
  const safeTemperature = Number.isFinite(temperature) && temperature > 0 ? temperature : DELIBERATION_TEMPERATURE;
  return 1 / (1 + Math.exp(-margin / safeTemperature));
}

export function sameDecision(left: DecisionOutcome, right: DecisionOutcome, compareHandlers = false): boolean {
  if (left.action === 'act' && right.action === 'act') return left.route === right.route
    && (!compareHandlers || !left.handler || !right.handler || left.handler === right.handler);
  return left.action === right.action;
}

export function withLegacyDecision(trace: ThoughtRecord, legacy: DecisionOutcome): ThoughtRecord {
  return { ...trace, legacy, disagrees: !sameDecision(trace.chosen, legacy, true) };
}

/** The only inputs with free text remain in process. Serialization uses finite codes and turn offsets. */
export function deliberate(input: DeliberationInput): Deliberation {
  const candidates = collectCandidates(input);
  const ranked = candidates.filter(candidate => candidate.eligible);
  const best = ranked[0];
  const routing = input.routing;
  const kind = best ? requestClass(best.route, routing.sourceAssessment.operation, best.handler) : 'conversation';
  const alternative = ranked.slice(1).find(candidate => candidate.route !== best?.route
    || (kind === 'write' || kind === 'ads') && candidate.route !== 'browser_command');
  const pending = best?.evidence.includes('pending_card');
  const clarified = best?.evidence.includes('clarified_choice');
  const hasStrongMatch = best?.evidence.includes('cascade_match');
  const missingContext = input.missingLocation || input.predicates.some(candidate => candidate.matched && candidate.outcome === 'ask')
    || routing.availability === 'needs_context'
    && (routing.reason === 'missing_reference' || routing.resolution.constraints?.ambiguous
      || routing.reason === 'invalid_request' && Boolean(input.text.trim()));
  const blocked = routing.availability === 'restricted';
  const scopeConflict = candidates.some(candidate => candidate.evidence.includes('request_scope'));
  const unsupportedOperation = candidates.some(candidate => candidate.evidence.includes('unsupported_operation')
    || candidate.handler === 'unsupported' && candidate.evidence.includes('cascade_match'));

  // A null alternative preserves uncertainty even when only one executable route matched.
  const margin = best ? best.score - Math.max(0.75, alternative?.score ?? 0) : 0;
  // The development corpus covers local answers and reads. High-risk classes
  // keep a separate conservative scale until they have decision labels.
  const policyTemperature = kind === 'write' || kind === 'ads' ? 2 : input.policyTemperature ?? COST_POLICY_TEMPERATURE;
  const routeConfidence = confidenceForMargin(margin, policyTemperature);
  const costAction = best ? leastCostAction(kind, routeConfidence) : 'abstain';
  let outcome: DecisionOutcome;
  let decisionMargin = margin;
  let reasons: DecisionReason[];
  let changeEvidence: EvidenceCode[];
  if (best && (pending || clarified) && !blocked) {
    outcome = { action: 'act', route: best.route, handler: best.handler };
    reasons = [pending ? 'pending_card' : 'clarified_choice'];
    changeEvidence = [pending ? 'pending_card' : 'clarified_choice', 'restricted'];
  } else if (blocked) {
    outcome = { action: 'abstain' };
    decisionMargin = 3.4;
    reasons = ['restricted'];
    changeEvidence = ['restricted', 'explicit_destination'];
  } else if (missingContext && !hasStrongMatch && !unsupportedOperation) {
    outcome = { action: 'ask' };
    decisionMargin = input.missingLocation ? 3.4 : 0.65;
    reasons = ['missing_context'];
    changeEvidence = ['missing_context', 'follow_up', 'clarified_choice'];
  } else if (best && costAction === 'act') {
    outcome = { action: 'act', route: best.route, handler: best.handler };
    reasons = ['lowest_expected_cost'];
    changeEvidence = ['explicit_destination', 'request_scope', 'restricted'];
  } else if (best && costAction === 'ask') {
    outcome = { action: 'ask' };
    decisionMargin = -margin;
    reasons = ['lowest_expected_cost'];
    changeEvidence = ['clarified_choice', 'explicit_destination', 'follow_up'];
  } else {
    outcome = { action: 'abstain' };
    decisionMargin = best ? -margin : unsupportedOperation ? 3.4 : -0.85;
    reasons = [scopeConflict ? 'scope_conflict' : routing.availability === 'missing_capability'
      ? 'missing_capability' : 'no_supported_candidate'];
    changeEvidence = [scopeConflict ? 'request_scope' : unsupportedOperation ? 'unsupported_operation' : 'cascade_match',
      'missing_capability', 'explicit_destination'];
  }

  const selected = outcome.action === 'act' ? best : null;
  const ordered = selected ? [selected, ...candidates.filter(candidate => candidate !== selected)] : candidates;
  const readings = buildInterpretations(ordered, input);
  const confidence = confidenceForMargin(decisionMargin, input.temperature);
  const trace: ThoughtRecord = {
    version: 1,
    candidates: candidates.map(({ route, handler, score, evidence }) => ({ route, handler, score, evidence })),
    chosen: outcome,
    confidence,
    reasons,
    changeEvidence,
    readings: readings.map(({ route, scope, spans }) => ({ route, scope, spans })),
  };
  return { outcome, candidates, readings, confidence, margin: decisionMargin, routeMargin: margin, routeCandidate: best?.route, trace: input.legacy ? withLegacyDecision(trace, input.legacy) : trace };
}
