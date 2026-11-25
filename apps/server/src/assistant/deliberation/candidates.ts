import { decisionRoutes } from '@mohassan/contracts';
import { requestsUnsupportedServiceAction } from './public-evidence.js';
import type { Candidate, DecisionRoute, DeliberationInput, EvidenceCode } from './types.js';

const publicLookup = (route: DecisionRoute) => route === 'web_search' || route === 'news';
const actionable = (route: DecisionRoute) => route !== 'unsupported' && route !== 'clarify';

/** Evaluate evidence from immutable input. Predicates are data, so collecting candidates cannot invoke a handler. */
export function collectCandidates(input: DeliberationInput): Candidate[] {
  const { routing } = input;
  const serviceAction = requestsUnsupportedServiceAction(input.text);
  const candidates = new Map<string, Candidate>();
  const add = (route: DecisionRoute, handler: string, eligible: boolean) => {
    const key = `${route}:${handler}`;
    const existing = candidates.get(key);
    if (existing) return existing;
    const candidate: Candidate = { route, handler, score: 0, evidence: [], eligible };
    candidates.set(key, candidate);
    return candidate;
  };
  const weigh = (candidate: Candidate, evidence: EvidenceCode, score: number) => {
    if (candidate.evidence.includes(evidence)) return;
    candidate.evidence.push(evidence);
    candidate.score += score;
  };

  for (const predicate of input.predicates) {
    if (!predicate.matched) continue;
    const candidate = add(predicate.route, predicate.handler, predicate.eligible !== false
      && (!predicate.outcome || predicate.outcome === 'act') && actionable(predicate.route));
    if (predicate.strength === 'weak') weigh(candidate, 'cascade_weak_match', 0.75);
    else weigh(candidate, 'cascade_match', 3.4);
    if (predicate.outcome === 'ask') weigh(candidate, 'missing_context', 0);
  }
  const matchingRoute = [...candidates.values()].filter(candidate => candidate.route === routing.route);
  if (!matchingRoute.length) matchingRoute.push(add(routing.route, 'routing_suggestion', false));
  for (const candidate of matchingRoute) {
    weigh(candidate, 'route_decision', routing.availability === 'ready' ? 1.8 : 0.6);
    if (routing.availability === 'restricted') {
      candidate.eligible = false;
      weigh(candidate, 'restricted', -3);
    } else if (routing.availability === 'needs_context') weigh(candidate, 'missing_context', 0);
    else if (routing.availability === 'missing_capability') weigh(candidate, 'missing_capability', 0);
  }
  for (const top of input.b0 ?? []) {
    if (!decisionRoutes.includes(top.route) || !Number.isFinite(top.score) || top.score <= 0) continue;
    const matching = [...candidates.values()].filter(candidate => candidate.route === top.route);
    if (!matching.length) matching.push(add(top.route, 'router_suggestion', false));
    for (const candidate of matching) weigh(candidate, 'router_top', Math.min(top.score, 1) * 0.9);
  }

  for (const candidate of candidates.values()) {
    if (candidate.route === routing.sourceAssessment.destination) weigh(candidate, 'explicit_destination', 1.1);
    if ((input.followUp || routing.resolution.kind === 'follow_up') && (candidate.route === routing.route || candidate.route === routing.intent)) {
      weigh(candidate, 'follow_up', 0.85);
    }
    if (input.memoryHit && candidate.route === 'memory') weigh(candidate, 'memory_hit', 1.2);
    if (input.pendingCard && (routing.resolution.kind === 'answer' || candidate.route === 'resume') && ['reply', 'resume'].includes(candidate.route)) {
      weigh(candidate, 'pending_card', 4);
    }
    if (input.choiceRoute === candidate.route && candidate.eligible && (!input.choiceHandler || input.choiceHandler === candidate.handler)) {
      weigh(candidate, 'clarified_choice', 7);
    }
    if (publicLookup(candidate.route) && (!routing.sourceAssessment.publicQueryEligible || serviceAction)) {
      candidate.eligible = false;
      weigh(candidate, serviceAction ? 'unsupported_operation' : 'request_scope', -4);
    }
    if (publicLookup(candidate.route) && input.missingLocation) {
      candidate.eligible = false;
      weigh(candidate, 'missing_context', 0);
    }
    candidate.score = Number(candidate.score.toFixed(3));
  }

  // Insertion order only breaks exact ties. It does not prevent independent matches from being evaluated.
  return [...candidates.values()].sort((a, b) => b.score - a.score);
}
