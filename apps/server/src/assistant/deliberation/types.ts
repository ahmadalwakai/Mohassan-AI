import type { DecisionOutcome, DecisionRoute, EvidenceCode, ThoughtRecord } from '@mohassan/contracts';
import type { RequestRoutingDecision } from '../routing-decision.js';

export type { DecisionOutcome, DecisionReason, DecisionRoute, EvidenceCode, ThoughtRecord } from '@mohassan/contracts';

export interface PredicateCandidate {
  route: DecisionRoute;
  handler: string;
  matched: boolean;
  strength?: 'strong' | 'weak';
  eligible?: boolean;
  outcome?: 'act' | 'ask' | 'abstain';
}

export interface RouterCandidate {
  route: DecisionRoute;
  score: number;
}

export interface DeliberationInput {
  text: string;
  previousText?: string | null;
  routing: RequestRoutingDecision;
  predicates: readonly PredicateCandidate[];
  b0?: readonly RouterCandidate[];
  followUp?: boolean;
  entity?: string | null;
  missingLocation?: boolean;
  memoryHit?: boolean;
  pendingCard?: boolean;
  choiceRoute?: DecisionRoute;
  choiceHandler?: string;
  legacy?: DecisionOutcome;
  temperature?: number;
  policyTemperature?: number;
}

export interface Candidate {
  route: DecisionRoute;
  handler: string;
  score: number;
  evidence: EvidenceCode[];
  eligible: boolean;
}

export interface Interpretation {
  route: DecisionRoute;
  intent: RequestRoutingDecision['intent'];
  scope: 'public' | 'private' | 'unknown';
  request: string;
  entity: string | null;
  spans: ThoughtRecord['readings'][number]['spans'];
}

export interface Deliberation {
  outcome: DecisionOutcome;
  candidates: Candidate[];
  readings: Interpretation[];
  confidence: number;
  margin: number;
  routeMargin: number;
  routeCandidate?: DecisionRoute;
  trace: ThoughtRecord;
}
