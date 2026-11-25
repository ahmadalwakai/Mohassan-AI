import { createHash } from 'node:crypto';
import {
  ArbiterBrain, arbiterFeatures, isArbiterInput, passProbability,
  type ArbiterArtifact, type ArbiterInput,
} from './arbiter.js';

export const exclusionManifestSha256 = 'de192bdc7203e1aa24fa06b216d3976f4ea77ec103e085a4019af7a60c2f3054';
const development = { 'v1-development': 240, 'v2-development': 2400 } as const;
type Split = keyof typeof development;

export interface ArbiterReplay {
  split: Split;
  caseId: string;
  family: string;
  turn: number;
  occurrence?: number;
  area: string;
  language: string;
  author: string;
  excluded: boolean;
  input: ArbiterInput;
  baselinePassed: boolean;
  outcomes: Readonly<Record<string, boolean>>;
}

interface ReplayReceipt {
  schemaVersion: 1;
  exclusionManifestSha256: string;
  rows: readonly ArbiterReplay[];
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const tag = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/u.test(value);

export function parseArbiterReplay(value: unknown): ReplayReceipt {
  if (!record(value) || value.schemaVersion !== 1 || value.exclusionManifestSha256 !== exclusionManifestSha256
    || !Array.isArray(value.rows)) throw new Error('Expected a development replay receipt with the pinned v2 exclusion manifest.');

  const sites = new Set<string>();
  const cases = new Map<string, string>();
  const rows: ArbiterReplay[] = [];
  for (const [index, row] of value.rows.entries()) {
    if (!record(row) || !tag(row.split) || !Object.hasOwn(development, row.split) || !tag(row.caseId)
      || !tag(row.family) || !Number.isSafeInteger(row.turn) || (row.turn as number) < 0 || !tag(row.area)
      || (row.occurrence !== undefined && (!Number.isSafeInteger(row.occurrence) || (row.occurrence as number) < 1))
      || !tag(row.language) || !tag(row.author) || typeof row.excluded !== 'boolean'
      || typeof row.baselinePassed !== 'boolean' || !isArbiterInput(row.input) || row.input.claimants.length < 2
      || !record(row.outcomes) || Object.keys(row.outcomes).length !== row.input.claimants.length) {
      throw new Error(`Invalid development replay row ${index + 1}.`);
    }
    const { outcomes } = row;
    if (!row.input.claimants.every(claim => Object.hasOwn(outcomes, claim.component)
      && typeof outcomes[claim.component] === 'boolean')) throw new Error(`Incomplete counterfactual replay at row ${index + 1}.`);
    // Published benchmark notes reserve all pinned v1 fixtures and #70 covers every v2 native source ID.
    if ((row.split === 'v1-development' && row.author === 'human') || (row.split === 'v2-development' && !row.excluded)) {
      throw new Error(`Replay provenance contradicts the pinned development releases at row ${index + 1}.`);
    }
    const id = JSON.stringify([row.split, row.caseId]);
    const site = JSON.stringify([id, row.turn, row.input.type, row.occurrence ?? 1]);
    const metadata = JSON.stringify([row.family, row.area, row.language, row.author, row.excluded, row.baselinePassed]);
    if (sites.has(site) || (cases.has(id) && cases.get(id) !== metadata)) {
      throw new Error(`Conflicting development replay at row ${index + 1}.`);
    }
    cases.set(id, metadata);
    sites.add(site);
    rows.push({ split: row.split as Split, caseId: row.caseId, family: row.family, turn: row.turn as number,
      ...(row.occurrence === undefined ? {} : { occurrence: row.occurrence as number }),
      area: row.area, language: row.language, author: row.author, excluded: row.excluded, input: row.input,
      baselinePassed: row.baselinePassed, outcomes: outcomes as Record<string, boolean> });
  }
  return { schemaVersion: 1, exclusionManifestSha256, rows };
}

type Counts = { total: number; baseline: number; oracle: number; additional: number };

export function replayOracle(rows: readonly ArbiterReplay[]) {
  const groups = new Map<string, { group: string[]; cases: Map<string, { baseline: boolean; oracle: boolean }> }>();
  for (const row of rows) {
    const type = row.input.type;
    const availablePass = row.baselinePassed || Object.entries(row.outcomes)
      .some(([component, passed]) => component !== row.input.precedence && passed);
    for (const group of [[row.split], [row.split, 'type', type], [row.split, 'area', row.area],
      [row.split, 'language', row.language], [row.split, 'type', type, 'area', row.area],
      [row.split, 'type', type, 'language', row.language]]) {
      const groupId = JSON.stringify(group);
      const entry = groups.get(groupId) ?? { group, cases: new Map() };
      const previous = entry.cases.get(row.caseId);
      entry.cases.set(row.caseId, { baseline: row.baselinePassed, oracle: availablePass || Boolean(previous?.oracle) });
      groups.set(groupId, entry);
    }
  }
  return [...groups.values()].sort((a, b) => a.group.join('/').localeCompare(b.group.join('/'), 'en')).map(({ group, cases }) => {
    const counts: Counts = { total: cases.size, baseline: 0, oracle: 0, additional: 0 };
    for (const observed of cases.values()) {
      counts.baseline += Number(observed.baseline);
      counts.oracle += Number(observed.oracle);
    }
    counts.additional = counts.oracle - counts.baseline;
    return { group, ...counts };
  });
}

const familyOrder = (family: string) => createHash('sha256').update(`mohassan-arbiter-family-v1:${family}`).digest('hex');

export function splitArbiterFamilies(rows: readonly ArbiterReplay[]) {
  const families = [...new Set(rows.map(row => row.family))].map(family => ({ family, key: familyOrder(family) }));
  families.sort((a, b) => a.key.localeCompare(b.key, 'en') || a.family.localeCompare(b.family, 'en'));
  const heldOut = families.length > 1 ? Math.max(1, Math.floor(families.length / 4)) : 0;
  const calibrationFamilies = new Set(families.slice(0, heldOut).map(({ family }) => family));
  const training = rows.filter(row => !calibrationFamilies.has(row.family));
  const calibration = rows.filter(row => calibrationFamilies.has(row.family));
  return { training, calibration, trainingFamilyCount: families.length - heldOut, calibrationFamilyCount: heldOut };
}

function fit(rows: readonly ArbiterReplay[]) {
  const examples = rows.flatMap(row => row.input.claimants.map(claim => ({
    features: arbiterFeatures(row.input, claim), target: Number(row.outcomes[claim.component]),
    weight: 1 / row.input.claimants.length,
  })));
  const keys = [...new Set(examples.flatMap(({ features }) => Object.keys(features)))].sort();
  const weights: Record<string, number> = Object.fromEntries(keys.map(feature => [feature, 0]));
  for (let step = 0; step < 240; step++) {
    const gradient = new Map<string, number>();
    for (const { features, target, weight } of examples) {
      const error = (passProbability(features, weights) - target) * weight;
      for (const [feature, value] of Object.entries(features)) {
        gradient.set(feature, (gradient.get(feature) ?? 0) + error * value);
      }
    }
    for (const feature of keys) {
      const current = weights[feature]!;
      const penalty = feature === 'bias' ? 0 : 0.025 * current;
      weights[feature] = current - 0.25 * ((gradient.get(feature) ?? 0) / rows.length + penalty);
    }
  }
  return Object.fromEntries(keys.map(feature => [feature, Number(weights[feature]!.toFixed(8))]));
}

type DecisionModel = ArbiterArtifact['decisions'][string];

function calibrate(type: string, model: DecisionModel, rows: readonly ArbiterReplay[]) {
  const brain = new ArbiterBrain({ schemaVersion: 1, decisions: { [type]: model } });
  const predictions = rows.flatMap(row => {
    const decision = brain.choose(row.input);
    if (!decision.proposedChoice || decision.confidence === null) return [];
    return [{ confidence: decision.confidence, delta: Number(row.outcomes[decision.proposedChoice]) - Number(row.baselinePassed) }];
  });
  // Highest coverage with a measured improvement and no loss on held-out decisions.
  for (const threshold of [...new Set(predictions.map(prediction => prediction.confidence))].sort((a, b) => a - b)) {
    const accepted = predictions.filter(prediction => prediction.confidence >= threshold);
    if (accepted.some(prediction => prediction.delta > 0) && accepted.every(prediction => prediction.delta >= 0)) return threshold;
  }
  return null;
}

function metrics(rows: readonly ArbiterReplay[], artifact: ArbiterArtifact) {
  const brain = new ArbiterBrain(artifact);
  const reliability = Array.from({ length: 5 }, (_, index) => ({
    lower: index / 5, upper: (index + 1) / 5, count: 0, predicted: 0, passed: 0,
  }));
  let brier = 0;
  let correct = 0;
  let scoredClaims = 0;
  let scoredCases = 0;
  let precedencePassed = 0;
  let selectedPassed = 0;
  let topRankedPassed = 0;
  const changed: { split: Split; caseId: string; turn: number; occurrence: number; type: string; from: string; to: string; passed: boolean }[] = [];
  for (const row of rows) {
    const model = artifact.decisions[row.input.type];
    const decision = brain.choose(row.input);
    if (!model || decision.confidence === null) continue;
    scoredCases++;
    precedencePassed += Number(row.baselinePassed);
    selectedPassed += Number(decision.choice === row.input.precedence ? row.baselinePassed : row.outcomes[decision.choice]);
    topRankedPassed += Number(row.outcomes[decision.proposedChoice ?? row.input.precedence]);
    if (decision.choice !== row.input.precedence) changed.push({ split: row.split, caseId: row.caseId,
      turn: row.turn, occurrence: row.occurrence ?? 1, type: row.input.type, from: row.input.precedence, to: decision.choice,
      passed: row.outcomes[decision.choice]! });
    for (const claim of row.input.claimants) {
      const probability = passProbability(arbiterFeatures(row.input, claim), model.coefficients);
      const passed = Number(row.outcomes[claim.component]);
      brier += (probability - passed) ** 2;
      correct += Number((probability >= 0.5) === Boolean(passed));
      scoredClaims++;
      const bin = reliability[Math.min(4, Math.floor(probability * 5))]!;
      bin.count++;
      bin.predicted += probability;
      bin.passed += passed;
    }
  }
  const rate = (count: number, total: number) => total === 0 ? null : count / total;
  const ece = reliability.reduce((sum, bin) => sum + Math.abs(bin.predicted - bin.passed), 0);
  return { scoredCases, scoredClaims, precedencePassed, selectedPassed, topRankedPassed,
    accuracy: rate(correct, scoredClaims), brier: rate(brier, scoredClaims), expectedCalibrationError: rate(ece, scoredClaims),
    reliability: reliability.map(bin => ({ lower: bin.lower, upper: bin.upper, count: bin.count,
      meanConfidence: rate(bin.predicted, bin.count), passRate: rate(bin.passed, bin.count) })), changed };
}

/** One row per complete development case. The full rerun is the promotion gate. */
export interface DevelopmentResult {
  split: Split;
  caseId: string;
  language: string;
  area: string;
  passed: boolean;
}

export function assessArbiterPromotion(before: readonly DevelopmentResult[], after: readonly DevelopmentResult[]) {
  const missing = { complete: false as const, holdsAllGroups: false as const, groups: [], changedCases: 0 };
  const results = (rows: readonly DevelopmentResult[]) => {
    const indexed = new Map<string, DevelopmentResult>();
    const counts = { 'v1-development': 0, 'v2-development': 0 };
    for (const row of rows) {
      if (!row || !Object.hasOwn(development, row.split) || !tag(row.caseId) || !tag(row.language) || !tag(row.area)
        || typeof row.passed !== 'boolean') return null;
      const id = JSON.stringify([row.split, row.caseId]);
      if (indexed.has(id)) return null;
      indexed.set(id, row);
      counts[row.split]++;
    }
    return counts['v1-development'] === development['v1-development'] && counts['v2-development'] === development['v2-development']
      ? indexed : null;
  };
  const baseline = results(before);
  const candidate = results(after);
  if (!baseline || !candidate) return missing;
  const groups = new Map<string, { split: Split; group: string; total: number; before: number; after: number }>();
  let changedCases = 0;
  for (const [id, row] of baseline) {
    const next = candidate.get(id);
    if (!next || row.area !== next.area || row.language !== next.language) return missing;
    changedCases += Number(row.passed !== next.passed);
    for (const group of ['overall', `area:${row.area}`, `language:${row.language}`]) {
      const key = `${row.split}:${group}`;
      const counts = groups.get(key) ?? { split: row.split, group, total: 0, before: 0, after: 0 };
      counts.total++;
      counts.before += Number(row.passed);
      counts.after += Number(next.passed);
      groups.set(key, counts);
    }
  }
  const table = [...groups.values()].sort((a, b) => `${a.split}:${a.group}`.localeCompare(`${b.split}:${b.group}`, 'en'));
  return { complete: true as const, holdsAllGroups: table.every(group => group.after >= group.before), groups: table, changedCases };
}

export function trainArbiter(receipt: ReplayReceipt) {
  const excluded = receipt.rows.filter(row => row.excluded).length;
  const nonHuman = receipt.rows.filter(row => row.author !== 'human').length;
  const eligible = receipt.rows.filter(row => row.author === 'human' && !row.excluded);
  const stable = eligible.filter(row => row.baselinePassed === row.outcomes[row.input.precedence]);
  const rows = [...stable].sort((a, b) => a.split.localeCompare(b.split, 'en') || a.caseId.localeCompare(b.caseId, 'en')
    || a.turn - b.turn || a.input.type.localeCompare(b.input.type, 'en') || (a.occurrence ?? 1) - (b.occurrence ?? 1));
  const { training, calibration, trainingFamilyCount, calibrationFamilyCount } = splitArbiterFamilies(rows);
  const types = [...new Set(training.map(row => row.input.type))].sort();
  const decisions: Record<string, DecisionModel> = {};
  for (const type of types) {
    const fitRows = training.filter(row => row.input.type === type);
    const hasSignal = fitRows.some(row => new Set(Object.values(row.outcomes)).size > 1);
    if (!hasSignal) continue;
    const components = [...new Set(fitRows.flatMap(row => row.input.claimants.map(claim => claim.component)))].sort();
    const model = { components, coefficients: fit(fitRows), threshold: null };
    const threshold = calibrate(type, model, calibration.filter(row => row.input.type === type));
    decisions[type] = { ...model, threshold };
  }
  const artifact: ArbiterArtifact = { schemaVersion: 1, decisions };
  return { artifact: Object.keys(decisions).length ? artifact : null,
    receipt: { exclusionManifestSha256: receipt.exclusionManifestSha256, replayRows: receipt.rows.length,
      eligibility: { eligible: eligible.length, excluded, nonHuman, unstable: eligible.length - stable.length },
      trainingRows: training.length, trainingFamilyCount, calibrationRows: calibration.length, calibrationFamilyCount,
      thresholds: Object.fromEntries(Object.entries(decisions).map(([type, { threshold }]) => [type, threshold])),
      oracle: replayOracle(receipt.rows), training: metrics(training, artifact), calibration: metrics(calibration, artifact) } };
}
