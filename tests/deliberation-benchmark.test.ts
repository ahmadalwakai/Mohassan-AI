import { describe, expect, it } from 'vitest';
import { fitDecisionTemperature, measureDecisions, sameDecision } from '../apps/server/src/assistant/deliberation/benchmark-metrics.js';
import corpus from './fixtures/deliberation/clinc150.json';

const ask = { kind: 'ask' } as const;
const abstain = { kind: 'abstain' } as const;
const chat = { kind: 'act', route: 'chat' } as const;
const search = { kind: 'act', route: 'web_search' } as const;

describe('deliberation benchmark scoring', () => {
  it('requires the correct act route and uses all decisions as the rate denominator', () => {
    const metrics = measureDecisions([
      { expected: chat, decision: chat, confidence: 1 },
      { expected: chat, decision: search, confidence: 0.8 },
      { expected: ask, decision: chat, confidence: 0.8 },
      { expected: abstain, decision: ask, confidence: 0.5 },
      { expected: ask, decision: ask, confidence: 0.5 },
    ]);
    expect(metrics).toMatchObject({ count: 5, correct: 2, wrongActions: 2, unnecessaryQuestions: 1,
      accuracy: 0.4, wrongActionRate: 0.4, unnecessaryQuestionRate: 0.2 });
    expect(metrics.expectedCalibrationError).toBeCloseTo(0.32);
    expect(sameDecision(ask, abstain)).toBe(false);
  });

  it('places the probability endpoints in the first and last bins and rejects invalid inputs', () => {
    const metrics = measureDecisions([
      { expected: chat, decision: search, confidence: 0 },
      { expected: chat, decision: chat, confidence: 1 },
    ]);
    expect(metrics.expectedCalibrationError).toBe(0);
    expect(() => measureDecisions([])).toThrow('At least one decision');
    expect(() => measureDecisions([{ expected: ask, decision: ask, confidence: NaN }])).toThrow('confidence');
  });

  it('fits a temperature using correct and incorrect development decisions', () => {
    const rows = [{ margin: 0.4, correct: true }, { margin: 0.4, correct: false }];
    const fit = fitDecisionTemperature(rows, (margin, temperature) => 0.5 + margin / temperature, [1, 2, 4]);
    expect(fit.temperature).toBe(4);
    expect(fit.meanNegativeLogLikelihood).toBeCloseTo(-(Math.log(0.6) + Math.log(0.4)) / 2);
  });

  it('keeps distinct development and benchmark messages with complete labels', () => {
    expect(corpus.benchmark.length).toBeGreaterThanOrEqual(300);
    expect(corpus.development.length).toBeGreaterThan(0);
    expect(corpus.purpose).toContain('excluded from training');
    const rows = [...corpus.development, ...corpus.benchmark];
    const normalized = rows.map(row => row.text.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, ' '));
    expect(new Set(normalized).size).toBe(rows.length);
    expect(new Set(rows.map(row => row.id)).size).toBe(rows.length);
    expect(new Set(corpus.benchmark.map(row => row.expected.kind))).toEqual(new Set(['act', 'ask', 'abstain']));
    for (const row of rows) if (row.expected.kind === 'act') expect(row.expected.route).toMatch(/^(chat|compute|web_search)$/u);
  });
});
