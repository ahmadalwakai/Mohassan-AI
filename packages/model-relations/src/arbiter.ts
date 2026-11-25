import type { ModelState } from './registry.js';

export interface ArbiterClaim {
  component: string;
  score?: number;
  label?: string;
  modelState?: ModelState;
}

export interface ArbiterInput {
  type: string;
  precedence: string;
  claimants: readonly ArbiterClaim[];
  language: string;
  length: number;
  conversationState: string;
  /** Only registry models relevant to this decision. */
  modelStates?: Readonly<Record<string, ModelState>>;
}

interface DecisionModel {
  components: readonly string[];
  coefficients: Readonly<Record<string, number>>;
  threshold: number | null;
}

export interface ArbiterArtifact {
  schemaVersion: 1;
  decisions: Readonly<Record<string, DecisionModel>>;
}

export type ArbiterReason = 'untrained' | 'uncontested' | 'model-unavailable' | 'unsupported' | 'uncalibrated'
  | 'low-confidence' | 'higher-pass-likelihood' | 'precedence';

export interface ArbiterDecision {
  choice: string;
  proposedChoice?: string;
  confidence: number | null;
  threshold: number | null;
  reason: ArbiterReason;
  reasons?: { feature: string; contribution: number }[];
}

type Features = Record<string, number>;
const tokenPattern = /^[a-z][a-z0-9_.-]{0,63}$/u;
const maxComponents = 16;
const modelStates: readonly ModelState[] = ['absent', 'experimental', 'shadow', 'active'];
const token = (value: unknown): value is string => typeof value === 'string' && tokenPattern.test(value);
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const validState = (value: unknown): value is ModelState => modelStates.includes(value as ModelState);
const finiteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export function isArbiterInput(input: unknown): input is ArbiterInput {
  if (!record(input) || !token(input.type) || !token(input.precedence) || !token(input.language)
    || !finiteNumber(input.length) || input.length < 0 || !token(input.conversationState)
    || !Array.isArray(input.claimants) || input.claimants.length > maxComponents) return false;
  const seen = new Set<string>();
  for (const claim of input.claimants) {
    if (!record(claim) || !token(claim.component) || seen.has(claim.component)
      || (claim.label !== undefined && !token(claim.label))
      || (claim.score !== undefined && !finiteNumber(claim.score))
      || (claim.modelState !== undefined && !validState(claim.modelState))) return false;
    seen.add(claim.component);
  }
  if (!seen.has(input.precedence)) return false;
  if (input.modelStates === undefined) return true;
  return record(input.modelStates) && Object.keys(input.modelStates).length <= maxComponents
    && Object.entries(input.modelStates).every(([id, state]) => token(id) && validState(state));
}

function loadDecisions(artifact: unknown): Map<string, DecisionModel> {
  const decisions = new Map<string, DecisionModel>();
  if (!record(artifact) || artifact.schemaVersion !== 1 || !record(artifact.decisions)) return decisions;
  for (const [type, model] of Object.entries(artifact.decisions)) {
    if (!token(type) || !record(model) || !Array.isArray(model.components) || model.components.length < 2
      || model.components.length > maxComponents || !model.components.every(token)
      || new Set(model.components).size !== model.components.length || !record(model.coefficients)
      || (model.threshold !== null && (!finiteNumber(model.threshold) || model.threshold < 0 || model.threshold > 1))) continue;
    const coefficients = Object.entries(model.coefficients);
    if (coefficients.length === 0 || coefficients.length > 4096 || !coefficients.every(([feature, weight]) =>
      /^[a-z0-9_.:-]{1,224}$/u.test(feature) && finiteNumber(weight) && Math.abs(weight) <= 64)) continue;
    decisions.set(type, {
      components: [...model.components],
      threshold: model.threshold,
      coefficients: Object.assign(Object.create(null), model.coefficients) as Record<string, number>,
    });
  }
  return decisions;
}

export function arbiterFeatures(input: ArbiterInput, claim: ArbiterClaim): Features {
  const candidate = `candidate:${claim.component}`;
  const length = Math.log2(1 + Math.min(input.length, 8000)) / 13;
  const features: Features = {
    bias: 1,
    [candidate]: 1,
    [`${candidate}:language:${input.language}`]: 1,
    [`${candidate}:context:${input.conversationState}`]: 1,
    [`${candidate}:length`]: length,
    [`language:${input.language}`]: 1,
    [`context:${input.conversationState}`]: 1,
    length,
  };
  if (claim.component === input.precedence) features.precedence = 1;
  if (claim.label !== undefined) features[`${candidate}:label:${claim.label}`] = 1;
  if (claim.score !== undefined) {
    features[`${candidate}:scored`] = 1;
    features[`${candidate}:score`] = Math.tanh(claim.score);
  }
  if (claim.modelState !== undefined) features[`${candidate}:model:${claim.modelState}`] = 1;
  for (const other of input.claimants) {
    if (other.component === claim.component) continue;
    features[`${candidate}:versus:${other.component}`] = 1;
    if (other.score !== undefined) features[`${candidate}:versus:${other.component}:score`] = Math.tanh(other.score);
  }
  for (const [model, state] of Object.entries(input.modelStates ?? {})) features[`model:${model}:${state}`] = 1;
  return features;
}

export function passProbability(features: Features, coefficients: Readonly<Record<string, number>>): number {
  let logit = 0;
  for (const feature of Object.keys(features)) {
    if (Object.hasOwn(coefficients, feature)) logit += features[feature]! * coefficients[feature]!;
  }
  return 1 / (1 + Math.exp(-logit));
}

function explain(selected: Features, baseline: Features, coefficients: DecisionModel['coefficients']) {
  return [...new Set([...Object.keys(selected), ...Object.keys(baseline)])]
    .map(feature => ({ feature, contribution: ((selected[feature] ?? 0) - (baseline[feature] ?? 0)) * (coefficients[feature] ?? 0) }))
    .filter(({ contribution }) => contribution > 0)
    .sort((a, b) => b.contribution - a.contribution || a.feature.localeCompare(b.feature, 'en')).slice(0, 3);
}

/** Loads an inspectable linear scorer once. Scoring is synchronous and has no model or device calls. */
export class ArbiterBrain {
  private readonly models: Map<string, DecisionModel>;

  constructor(artifact?: unknown) {
    this.models = loadDecisions(artifact);
  }

  choose(input: ArbiterInput): ArbiterDecision {
    const defer = (reason: ArbiterReason, threshold: number | null = null): ArbiterDecision =>
      ({ choice: input.precedence, reason, confidence: null, threshold });
    if (input.claimants.length < 2) return defer('uncontested');
    if (input.claimants.some(claim => claim.modelState === 'absent')
      || Object.values(input.modelStates ?? {}).includes('absent')) return defer('model-unavailable');
    const model = this.models.get(input.type);
    if (!model) return defer('untrained');
    if (!isArbiterInput(input) || !input.claimants.every(claim => model.components.includes(claim.component))) {
      return defer('unsupported', model.threshold);
    }

    const scored = input.claimants.map(claim => {
      const features = arbiterFeatures(input, claim);
      return { component: claim.component, features, confidence: passProbability(features, model.coefficients) };
    });
    const baseline = scored.find(claim => claim.component === input.precedence)!;
    let best = baseline;
    for (const claim of scored) {
      if (claim.confidence > best.confidence || (best !== baseline && claim.confidence === best.confidence
        && claim.component < best.component)) best = claim;
    }
    const { threshold } = model;
    const { confidence } = best;
    if (best === baseline) return { choice: input.precedence, confidence, threshold, reason: 'precedence' };
    const reasons = explain(best.features, baseline.features, model.coefficients);
    if (threshold === null || confidence < threshold) {
      return { choice: input.precedence, proposedChoice: best.component, confidence, threshold, reasons,
        reason: threshold === null ? 'uncalibrated' : 'low-confidence' };
    }
    return { choice: best.component, proposedChoice: best.component, confidence, threshold, reasons, reason: 'higher-pass-likelihood' };
  }
}
