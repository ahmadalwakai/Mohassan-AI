import { describe, expect, it } from 'vitest';
import { ArbiterBrain, type ArbiterArtifact, type ArbiterInput } from './arbiter.js';
import {
  assessArbiterPromotion, exclusionManifestSha256, parseArbiterReplay, replayOracle,
  splitArbiterFamilies, trainArbiter, type ArbiterReplay, type DevelopmentResult,
} from './arbiter-training.js';

const input: ArbiterInput = {
  type: 'routing', precedence: 'small-talk', language: 'en', length: 42, conversationState: 'new',
  claimants: [{ component: 'small-talk', label: 'reply', score: 0.8 },
    { component: 'lookup', label: 'web_search', score: 0.5, modelState: 'active' }],
};

const model = (threshold: number | null): ArbiterArtifact => ({
  schemaVersion: 1,
  decisions: { routing: { components: ['small-talk', 'lookup'], threshold,
    coefficients: { 'candidate:lookup': 3, 'candidate:small-talk': -3 } } },
});

describe('arbiter inference', () => {
  it('logs an inspectable alternative and defers below the calibrated threshold', () => {
    const supported = new ArbiterBrain(model(0.7)).choose(input);
    expect(supported).toMatchObject({ choice: 'lookup', proposedChoice: 'lookup', reason: 'higher-pass-likelihood',
      reasons: [{ feature: 'candidate:lookup', contribution: 3 }, { feature: 'candidate:small-talk', contribution: 3 }] });
    expect(new ArbiterBrain(model(0.99)).choose(input)).toMatchObject({ choice: 'small-talk', proposedChoice: 'lookup',
      reason: 'low-confidence', confidence: supported.confidence, threshold: 0.99 });
    expect(new ArbiterBrain(model(null)).choose(input)).toMatchObject({ choice: 'small-talk', proposedChoice: 'lookup',
      reason: 'uncalibrated' });
  });

  it('retains precedence when a relevant dependency is absent or an artifact fails validation', () => {
    const brain = new ArbiterBrain(model(0.7));
    expect(brain.choose({ ...input, modelStates: { classifier: 'absent' } })).toMatchObject({ choice: 'small-talk', reason: 'model-unavailable' });
    expect(brain.choose({ ...input, claimants: [input.claimants[0]!, { ...input.claimants[1]!, modelState: 'absent' }] }))
      .toMatchObject({ choice: 'small-talk', reason: 'model-unavailable' });
    expect(new ArbiterBrain(model(Number.NaN)).choose(input)).toMatchObject({ choice: 'small-talk', reason: 'untrained' });
    expect(new ArbiterBrain().choose(input)).toMatchObject({ choice: 'small-talk', reason: 'untrained' });
    expect(brain.choose({ ...input, claimants: [input.claimants[0]!, { component: 'unknown' }] }))
      .toMatchObject({ choice: 'small-talk', reason: 'unsupported' });
  });

  it('prefers precedence on ties', () => {
    const tied = new ArbiterBrain({ schemaVersion: 1, decisions: {
      routing: { components: ['small-talk', 'lookup'], threshold: 0, coefficients: { bias: 1 } },
    } });
    expect(tied.choose({ ...input, claimants: [...input.claimants].reverse() })).toMatchObject({ choice: 'small-talk', reason: 'precedence' });
  });
});

function replay(caseId: string, extra: Partial<ArbiterReplay> = {}): ArbiterReplay {
  return { split: 'v1-development', caseId, turn: 0, family: caseId, area: 'factual', language: 'en',
    author: 'agent', excluded: false, baselinePassed: false, input,
    outcomes: { 'small-talk': false, lookup: true }, ...extra };
}

const receipt = (rows: readonly ArbiterReplay[]) => ({ schemaVersion: 1 as const, exclusionManifestSha256, rows });

describe('arbiter counterfactual training', () => {
  it('rejects sealed rows, incomplete outcomes, a bad registry pin, and a contradictory provenance claim', () => {
    expect(() => parseArbiterReplay({ ...receipt([]), exclusionManifestSha256: 'unverified' })).toThrow(/pinned/u);
    expect(() => parseArbiterReplay({ ...receipt([]), rows: [{ ...replay('sample'), split: 'v1-sealed' }] })).toThrow(/row 1/u);
    expect(() => parseArbiterReplay(receipt([replay('sample', { outcomes: { lookup: true } })]))).toThrow(/row 1/u);
    expect(() => parseArbiterReplay(receipt([replay('sample', { author: 'human' })]))).toThrow(/provenance/u);
    expect(() => parseArbiterReplay(receipt([replay('sample', { split: 'v2-development', author: 'human', excluded: false })])))
      .toThrow(/provenance/u);
  });

  it('keeps excluded and AI-authored cases out of training, with no artifact when no data remain', () => {
    const rows = [replay('sample-v1'), replay('sample-v2', { split: 'v2-development', author: 'human', excluded: true })];
    const { artifact, receipt: report } = trainArbiter(parseArbiterReplay(receipt(rows)));
    expect(artifact).toBeNull();
    expect(report).toMatchObject({ trainingRows: 0, calibrationRows: 0,
      eligibility: { eligible: 0, excluded: 1, nonHuman: 1 }, calibration: { accuracy: null, changed: [] } });
    expect(report.oracle).toContainEqual({ group: ['v2-development', 'type', 'routing', 'language', 'en'],
      total: 1, baseline: 0, oracle: 1, additional: 1 });
  });

  it('deduplicates oracle cases across contested turns and counts only an alternate claimant as an improvement', () => {
    const rows = [replay('sample'), replay('sample', { turn: 1 }),
      replay('other', { outcomes: { 'small-talk': true, lookup: false } })];
    expect(replayOracle(rows)).toContainEqual({ group: ['v1-development'], total: 2, baseline: 0, oracle: 1, additional: 1 });
  });

  it('learns pass outcomes reproducibly with a family held out for threshold calibration', () => {
    // Hand-edited feature rows exercise the learner without product or benchmark input text.
    const rows = Array.from({ length: 12 }, (_, index) => replay(`manual-${index}`, {
      author: 'human', family: `family-${Math.floor(index / 2)}`,
    }));
    const split = splitArbiterFamilies(rows);
    expect(split.trainingFamilyCount).toBe(5);
    expect(split.calibrationFamilyCount).toBe(1);
    const heldOut = split.calibration[0]!.family;
    expect(split.training.every(row => row.family !== heldOut)).toBe(true);
    expect(new Set(split.calibration.map(row => row.family))).toEqual(new Set([heldOut]));

    const result = trainArbiter(receipt(rows));
    expect(result).toEqual(trainArbiter(receipt([...rows].reverse())));
    expect(result.artifact?.decisions.routing?.threshold).toBeGreaterThan(0.5);
    expect(new ArbiterBrain(result.artifact).choose(input).choice).toBe('lookup');
    expect(result.receipt.calibration).toMatchObject({ accuracy: 1, selectedPassed: 2, precedencePassed: 0 });
  });
});

it('requires both complete development splits and rejects an area or language regression despite overall parity', () => {
  const rows: DevelopmentResult[] = ([['v1-development', 240], ['v2-development', 2400]] as const)
    .flatMap(([split, count]) => Array.from({ length: count }, (_, index) => ({
      split, caseId: `fixture-${index}`, passed: index % 2 === 0,
      language: index % 2 === 0 ? 'en' : 'ar', area: index % 2 === 0 ? 'factual' : 'coding',
    })));
  expect(assessArbiterPromotion(rows, rows)).toMatchObject({ complete: true, holdsAllGroups: true, changedCases: 0 });
  expect(assessArbiterPromotion(rows.slice(1), rows.slice(1))).toMatchObject({ complete: false, holdsAllGroups: false });
  const edited = rows.map((row, index) => index < 2 ? { ...row, passed: !row.passed } : row);
  const gate = assessArbiterPromotion(rows, edited);
  expect(gate).toMatchObject({ complete: true, holdsAllGroups: false, changedCases: 2 });
  expect(gate.groups).toContainEqual({ split: 'v1-development', group: 'language:en', total: 120, before: 120, after: 119 });
  expect(gate.groups).toContainEqual({ split: 'v1-development', group: 'area:factual', total: 120, before: 120, after: 119 });
});
