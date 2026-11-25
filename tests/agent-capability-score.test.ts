import { describe, expect, it } from 'vitest';
import type { CapabilityCase } from '../scripts/agent-capability-bench/corpus.js';
import type { CapabilityCaseObservation } from '../scripts/agent-capability-bench/observe.js';
import { includesLiteral, includesNumber, scoreCapabilityCase, summarizeCapability, wilson95 } from '../scripts/agent-capability-bench/score.js';

describe('capability scoring primitives', () => {
  it('matches whole signed numbers and normalizes Arabic digits and grouping', () => {
    expect(includesNumber('٣٬٥٠٠٫٠٠', '3500')).toBe(true);
    expect(includesNumber('−۱۲٫۵', '-12.50')).toBe(true);
    expect(includesNumber('32 and -2', '2')).toBe(false);
    expect(includesNumber('2.11.3', '2.11')).toBe(false);
    expect(includesNumber('2.5', '2')).toBe(false);
    expect(includesNumber('1/2 and 2e3', '2')).toBe(false);
    expect(includesNumber('2.000', '2')).toBe(true);
    expect(includesNumber('12', '12a')).toBe(false);
  });

  it('compares composed Unicode literals across whitespace and case', () => {
    expect(includesLiteral('A\u030A\nB', 'Å b')).toBe(true);
    expect(includesLiteral('A B', 'AB')).toBe(false);
  });

  it('computes Wilson 95% bounds for zero, full and intermediate scores', () => {
    expect(wilson95(0, 0)).toBeNull();
    expect(wilson95(0, 10)?.[0]).toBe(0);
    expect(wilson95(10, 10)?.[1]).toBe(1);
    const [lower, upper] = wilson95(5, 10)!;
    expect(lower).toBeCloseTo(0.23659, 5);
    expect(upper).toBeCloseTo(0.76341, 5);
  });
});

describe('checking structured signals without a benchmark corpus', () => {
  const wanted: CapabilityCase['turns'][number]['expect'] = {
    requiredTools: ['search', 'calculate'], forbiddenTools: ['open'], questionCount: 0, status: ['completed'],
    maxSteps: 2, requiredContent: [{ match: 'number', anyOf: ['2'] }], forbiddenContent: [], verification: 'verified',
  };
  // The scorer has no reason to inspect the inputs or their provenance.
  const item: CapabilityCase = { id: 'unit-01', area: 'calculation', language: 'en', variety: 'english',
    provenance: { author: '', source: '' }, turns: [{ text: '', expect: wanted }] };
  const turn: CapabilityCaseObservation['turns'][number] = {
    answer: '2', source: null, operation: null, route: null, handler: null, questionCount: 0, steps: 2,
    status: 'completed', toolCalls: [{ tool: 'search', outcome: 'recorded' }, { tool: 'calculate', outcome: 'recorded' }], boundaryCalls: [],
    fixtureMisses: 0, modelCalls: 0, planSteps: [], latencyMs: 5, questionFields: [], conversationStatus: 'idle',
    understanding: null, routeReason: null, verdict: null, unexpectedEffects: 0,
    verification: { status: 'verified', evidence: [], independentEvidence: [], reviewStatus: null },
  };

  it('checks ordering, attempted forbidden tools, answer and verification with the first failing stage', () => {
    const pass = scoreCapabilityCase(item, { turns: [turn], setupMs: 10 });
    expect(pass.passed).toBe(true);
    const failure = scoreCapabilityCase(item, { setupMs: 10,
      turns: [{ ...turn, steps: 3, toolCalls: [...turn.toolCalls].reverse(), boundaryCalls: [{ tool: 'open', outcome: 'denied' }],
        answer: '32', verification: { ...turn.verification, status: 'unverified' }, latencyMs: 15 }] });
    expect(failure.stage).toBe('planning');
    expect(failure.failures.map(({ stage, check }) => [stage, check])).toEqual([
      ['planning', 'step-budget'], ['tool', 'required-tool-order'], ['tool', 'forbidden-tool'],
      ['answer', 'required-content-1'], ['verification', 'verification'],
    ]);
    expect(failure.completedWithFailure).toBe(true);
    expect(failure.turns[0]).not.toHaveProperty('answer');
    const stats = summarizeCapability([pass, failure]);
    expect(stats.overall).toMatchObject({
      passed: 1, total: 2, rate: 0.5, p50Ms: 5, p95Ms: 15,
      primaryFailureStages: { understanding: 0, routing: 0, planning: 1, tool: 0, answer: 0, verification: 0 },
      anyFailureStages: { understanding: 0, routing: 0, planning: 1, tool: 1, answer: 1, verification: 1 },
    });
    expect(stats.byArea.calculation).toEqual(stats.byLanguage.en);
    expect(stats.byAreaAndLanguage['calculation/en']).toEqual(stats.byArea.calculation);
  });

  it('checks successful recorded boundary calls and a denied network attempt', () => {
    const observed = { ...turn, toolCalls: [], boundaryCalls: [...turn.toolCalls, { tool: 'unexpected_fetch', outcome: 'denied' as const }] };
    expect(scoreCapabilityCase(item, { setupMs: 0, turns: [observed] }).failures).toEqual([
      { turn: 1, stage: 'tool', check: 'unexpected-network' },
    ]);
    expect(scoreCapabilityCase(item, { setupMs: 0, turns: [{ ...turn, unexpectedEffects: 1 }] }).failures).toEqual([
      { turn: 1, stage: 'tool', check: 'unexpected-effect' },
    ]);
  });

  it('counts missing turns as failures without inventing latency', () => {
    const missing = scoreCapabilityCase(item, { setupMs: 10, turns: [] });
    expect(missing.passed).toBe(false);
    expect(missing.failures).toEqual([{ turn: 1, stage: 'tool', check: 'unobserved-turn' }]);
    expect(summarizeCapability([missing]).overall).toMatchObject({ measuredLatency: 0, p50Ms: null, p95Ms: null });
  });
});
