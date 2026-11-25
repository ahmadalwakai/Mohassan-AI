import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  arbitrateComponent, beginArbiterReplayTurn, takeArbiterDecisions, withArbiterExecution, withArbiterReplay,
} from '../apps/server/src/assistant/model-relations-arbiter.js';
import { decideHostRequestRoute } from '../apps/server/src/assistant/routing-decision.js';
import { ArbiterBrain, type ArbiterInput } from '../packages/model-relations/src/arbiter.js';
import { ModelRelationsManager, type ArbiterDecisionType } from '../packages/model-relations/src/manager.js';
import { modelRegistry } from '../packages/model-relations/src/registry.js';
import { createModelRuntime, type ModelRunResult } from '../packages/model-relations/src/runtime.js';

const baseline = 'small-talk';
const alternative = 'lookup';
const input: ArbiterInput = {
  type: 'routing', precedence: baseline, language: 'en', length: 42, conversationState: 'new',
  claimants: [{ component: baseline, score: 0.8, label: 'reply' }, { component: alternative, score: 0.5, label: 'web_search' }],
};

afterEach(() => vi.unstubAllEnvs());

function brain(threshold: number, type: ArbiterDecisionType = 'routing') {
  return new ArbiterBrain({ schemaVersion: 1, decisions: { [type]: {
    threshold, components: [baseline, alternative],
    coefficients: { [`candidate:${alternative}`]: 3, [`candidate:${baseline}`]: -3 },
  } } });
}

function manager(env: NodeJS.ProcessEnv = {}, threshold = 0.7,
  type: ArbiterDecisionType = 'routing', promotedDecisionTypes: readonly ArbiterDecisionType[] = [type]) {
  const run = vi.fn(async (): Promise<ModelRunResult> => { throw new Error('Unexpected model call during arbitration'); });
  return { run, relations: new ModelRelationsManager({ run }, { arbiter: brain(threshold, type), promotedDecisionTypes, env }) };
}

describe('relations manager arbitration', () => {
  it('reports its shadow preference and retains precedence by default', () => {
    const { relations, run } = manager();
    const decision = relations.arbitrate(input);
    expect(decision).toMatchObject({ type: 'routing', selected: baseline, proposed: alternative, reason: 'shadow', threshold: 0.7 });
    expect(decision.confidence).toBeGreaterThan(decision.threshold!);
    expect(run).not.toHaveBeenCalled();
  });

  it('retains precedence below the calibrated threshold and without an arbiter artifact', () => {
    const env = { MOHASSAN_ARBITER_ROUTING: '1' };
    const { relations, run } = manager(env, 0.99);
    const lowConfidence = relations.arbitrate(input);
    expect(lowConfidence.selected).toBe(baseline);
    expect(lowConfidence.confidence).toBeLessThan(lowConfidence.threshold!);
    const untrained = new ModelRelationsManager({ run }, { env, promotedDecisionTypes: ['routing'] });
    expect(untrained.arbitrate(input).selected).toBe(baseline);
    expect(run).not.toHaveBeenCalled();
  });

  it('keeps the precedence when a consulted model is absent', () => {
    const { relations, run } = manager({ MOHASSAN_ARBITER_ROUTING: '1' });
    expect(relations.arbitrate(input).selected).toBe(alternative);
    expect(relations.arbitrate({ ...input, modelStates: { 'scratch-route': 'absent' } }).selected).toBe(baseline);
    expect(run).not.toHaveBeenCalled();
  });

  it('requires a promotion as well as the flag, and preserves protected decisions', () => {
    const env = { MOHASSAN_ARBITER_ROUTING: '1' };
    const { relations } = manager(env, 0.7, 'routing', []);
    expect(relations.arbitrate(input).selected).toBe(baseline);
    const live = manager(env).relations;
    expect(live.arbitrate(input).selected).toBe(alternative);
    expect(live.arbitrate(input, { protected: true }).selected).toBe(baseline);
  });

  it.each<ArbiterDecisionType>(['routing', 'question-rewrite', 'local-computation', 'compound-plan'])(
    'honors the separate kill switch for %s', type => {
      const flag = `MOHASSAN_ARBITER_${type.replaceAll('-', '_').toUpperCase()}`;
      const env: NodeJS.ProcessEnv = { [flag]: '1' };
      const { relations } = manager(env, 0.7, type);
      const decision = { ...input, type };
      expect(relations.arbitrate(decision).selected).toBe(alternative);
      env[`${flag}_KILL`] = '1';
      expect(relations.arbitrate(decision)).toMatchObject({ selected: baseline, reason: 'killed' });
    },
  );

  it('still arbitrates on the CPU while .data/gpu.lock exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'arbiter-gpu-lock-'));
    const loadAdapter = vi.fn(() => { throw new Error('Unexpected adapter load during arbitration'); });
    const runtime = createModelRuntime({ root, loadAdapter, registry: modelRegistry });
    const run = vi.spyOn(runtime, 'run');
    try {
      await mkdir(join(root, '.data'));
      await writeFile(join(root, '.data', 'gpu.lock'), 'fixture lock');
      const relations = new ModelRelationsManager(runtime, { arbiter: brain(0.7), env: {} });
      expect(relations.arbitrate(input)).toMatchObject({ selected: baseline, proposed: alternative });
      expect(run).not.toHaveBeenCalled();
      expect(loadAdapter).not.toHaveBeenCalled();
    } finally {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('adds at most 1 ms at p95 on the warmed arbitration path', () => {
    const { relations } = manager();
    const localHistory: ArbiterInput = { ...input, language: 'ar', length: 246, conversationState: 'follow_up',
      modelStates: { 'scratch-route': 'shadow', 'scratch-refusal': 'active' } };
    const sampleInputs = [input, localHistory];
    for (let i = 0; i < 2_000; i++) relations.arbitrate(sampleInputs[i % sampleInputs.length]!);
    expect(relations.arbitrate(localHistory).proposed).toBe(alternative);
    const elapsed: number[] = [];
    for (let i = 0; i < 4_000; i++) {
      const start = performance.now();
      relations.arbitrate(sampleInputs[i % sampleInputs.length]!);
      elapsed.push(performance.now() - start);
    }
    elapsed.sort((a, b) => a - b);
    const p95 = elapsed[Math.ceil(elapsed.length * 0.95) - 1]!;
    console.info(`Arbitration p95 ${p95.toFixed(3)} ms over ${elapsed.length} warmed samples`);
    expect(p95).toBeLessThanOrEqual(1);
  });
});

describe('assistant arbitration hook', () => {
  const hostResult = { reply: 'Pine needles on the railway platform.' };
  const replacement = { reply: 'A green canvas under the marquee.' };
  const hostClaim = { component: baseline, result: hostResult };
  const otherClaims = [{ component: alternative, result: replacement }];
  const context = { text: 'Night train through the ravine', conversationState: 'new' };

  it('keeps host results and publishes only decision metadata from a live execution', () => {
    vi.stubEnv('MOHASSAN_MODEL_RELATIONS', undefined);
    const runId = 'arbiter-wrapper-test';
    expect(withArbiterExecution(runId, () => arbitrateComponent('routing', context, hostClaim, otherClaims))).toBe(hostResult);
    const decisions = takeArbiterDecisions(runId);
    expect(decisions).toMatchObject([{ type: 'routing', precedence: baseline, selected: baseline,
      claimants: [{ component: baseline }, { component: alternative }], reason: 'untrained' }]);
    const log = JSON.stringify(decisions);
    expect(log).not.toContain(context.text);
    expect(log).not.toContain(hostResult.reply);
    expect(log).not.toContain(replacement.reply);
    expect(takeArbiterDecisions(runId)).toBeUndefined();
  });

  it('allows a scoped development replay despite the base observer setting', async () => {
    vi.stubEnv('MOHASSAN_MODEL_RELATIONS', 'off');
    const override = { type: 'routing' as const, turnId: 1, occurrence: 2, component: alternative };
    const replay = (overrides: typeof override[]) => withArbiterReplay({ overrides }, async trace => {
      beginArbiterReplayTurn();
      await Promise.resolve();
      const first = arbitrateComponent('routing', context, hostClaim, otherClaims);
      const second = arbitrateComponent('routing', context, hostClaim, otherClaims);
      return { first, second, decisions: trace.decisions };
    });
    const [forced, control] = await Promise.all([replay([override]), replay([])]);
    expect(forced.first).toBe(hostResult);
    expect(forced.second).toBe(replacement);
    expect(forced.decisions[1]).toMatchObject({ turnId: 1, occurrence: 2, selected: alternative, reason: 'forced' });
    expect(control.second).toBe(hostResult);
    expect(arbitrateComponent('routing', context, hostClaim, otherClaims)).toBe(hostResult);
  });

  it('rejects replay in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => withArbiterReplay({ overrides: [] }, () => null)).toThrow('Arbiter replay is disabled in production');
  });

  it('replays a contested production routing decision with the existing claimant result', () => {
    vi.stubEnv('MOHASSAN_MODEL_RELATIONS', 'off');
    vi.stubEnv('MOHASSAN_SCRATCH_CLASSIFIERS', undefined);
    const request = { text: 'What is the time here in early September?', turnId: 'arbiter-routing-test',
      previousTurns: 0, capabilities: { browser: true, search: true } };
    expect(decideHostRequestRoute(request)).toMatchObject({ route: 'clarify', handler: 'clarify' });
    withArbiterReplay({ overrides: [{ type: 'routing', turnId: 1, component: 'factual-lookup' }] }, trace => {
      beginArbiterReplayTurn();
      expect(decideHostRequestRoute(request)).toMatchObject({ route: 'web_search', handler: 'search',
        sourceAssessment: { publicQueryEligible: true }, publicQuery: expect.any(String) });
      expect(trace.decisions).toMatchObject([{ type: 'routing', turnId: 1, precedence: 'everyday-clarification',
        selected: 'factual-lookup', reason: 'forced' }]);
    });
  });
});
