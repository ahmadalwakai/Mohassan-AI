import { describe, expect, it } from 'vitest';
import type { SearchCandidate } from '../apps/server/src/assistant/arithmetic-search-candidates.js';
import { rankArithmeticCandidates, selectArithmeticCandidate } from '../apps/server/src/assistant/arithmetic-search-ranker.js';
import { operation, quantity } from '../apps/server/src/assistant/word-problem-graph.js';
import { canonicalSearchExpression, goldSearchExpressions } from '../scripts/word-problem-evaluation/annotations.js';
import { fitSelectionThreshold } from '../scripts/word-problem-evaluation/train-arithmetic-search.js';

function candidate(value: string, strength: number): SearchCandidate {
  return { graph: quantity(value), expression: value, value, operations: 0, features: { strength } };
}

describe('arithmetic annotation supervision', () => {
  it('inlines exact intermediate values and accepts commutative reordering', () => {
    const trainingAnswer = 'First <<17*3=51>>. Then <<51+8=59>>.\n#### 59';
    const annotation = goldSearchExpressions(trainingAnswer, '59', new Set());
    const reordered = operation('+', quantity('8'), operation('*', quantity('3'), quantity('17')));
    expect(annotation.has(canonicalSearchExpression(reordered, new Set()))).toBe(true);
  });

  it('preserves ordered operations and folds a ratio that was extracted from the statement', () => {
    const fractions = new Set(['0.25']);
    const annotation = goldSearchExpressions('<<48-48*25/100=36>>.\n#### 36', '36', fractions);
    const left = quantity('48');
    const right = operation('/', operation('*', quantity('48'), quantity('25')), quantity('100'));
    const sequential = operation('-', left, right);
    const reversed = operation('-', right, left);
    expect(annotation.has(canonicalSearchExpression(sequential, fractions))).toBe(true);
    expect(annotation.has(canonicalSearchExpression(reversed, fractions))).toBe(false);
    const ratioFirst = goldSearchExpressions('<<48-(25/100)*48=36>>.\n#### 36', '36', fractions);
    const ratio = operation('-', quantity('48'), operation('*', quantity('1/4'), quantity('48')));
    expect(ratioFirst.has(canonicalSearchExpression(ratio, fractions))).toBe(true);
  });

  it('rejects missing, rounded or inconsistent final annotations', () => {
    expect(goldSearchExpressions('<<7/3=2.33>>', '2.33', new Set()).size).toBe(0);
    expect(goldSearchExpressions('<<12+9=21>>\n#### 2', '2', new Set()).size).toBe(0);
    expect(goldSearchExpressions('<<17/50%=34>>', '34', new Set()).size).toBeGreaterThan(0);
  });
});

describe('arithmetic ranker confidence and threshold', () => {
  it('calculates the score gap against the best different answer', () => {
    const candidates = [candidate('11', 5), candidate('11', 4), candidate('19', 2)];
    expect(rankArithmeticCandidates(candidates, { strength: 1 })).toMatchObject({ score: 5, margin: 3, answerCount: 2 });
  });

  it('selects an answer only at the threshold and abstains on a different-answer score tie', () => {
    const candidates = [candidate('19', 2), candidate('11', 5), candidate('11', 4)];
    const fitted = { rank: { strength: 1 }, confidence: { 'confidence:margin': 1 }, minimumConfidence: 3 };
    expect(selectArithmeticCandidate(candidates, fitted)?.value).toBe('11');
    expect(selectArithmeticCandidate(candidates, { ...fitted, minimumConfidence: 3.01 })).toBeNull();
    expect(selectArithmeticCandidate([...candidates, candidate('23', 5)], fitted)).toBeNull();
    expect(selectArithmeticCandidate(candidates, { ...fitted, minimumConfidence: null })).toBeNull();
  });

  it('calibrates to the precision floor with equal scores accepted together', () => {
    const correct = Array.from({ length: 9 }, (_, index) => ({ confidence: 10 - index, correct: true }));
    const incorrect = [{ confidence: 1, correct: false }, { confidence: 0, correct: false }];
    expect(fitSelectionThreshold([...correct, ...incorrect])).toBe(1);
    expect(fitSelectionThreshold([...correct, ...incorrect, { confidence: 1, correct: false }])).toBe(2);
    expect(fitSelectionThreshold(incorrect)).toBeNull();
  });
});
