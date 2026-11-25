import { describe, expect, it } from 'vitest';
import { evaluateExactArithmeticExpression } from '../apps/server/src/assistant/calculator.js';
import { evaluateWordExpression, operation, quantity } from '../apps/server/src/assistant/word-problem-graph.js';

describe('exact calculator', () => {
  it.each([
    ['0.1 + 0.2', '0.3'],
    ['(1 / 3) * (1 / 3) + 1 / 3', '4/9'],
    ['(6 / 15) * (5 / 2)', '1'],
    ['-2 / 16', '-0.125'],
    ['12.5% * 28', '3.5'],
    ['.5e2 * 3e-1', '15'],
    ['9007199254740992 + 1', '9007199254740993'],
    ['2^-3 + (-2)^3', '-7.875'],
  ])('keeps %s exact', (expression, value) => {
    expect(evaluateExactArithmeticExpression(expression, { allowPercent: true })).toEqual({ ok: true, value });
  });

  it.each([
    ['0 / 0', 'division_by_zero'], ['0^-1', 'division_by_zero'], ['4^.5', 'domain'], ['2^500000', 'range'],
    ['2^2^500000', 'range'], ['1e500000', 'range'], ['0 / 0 + )', 'syntax'], ['25% * 3', 'syntax'],
  ])('reports calculator errors for %s', (expression, error) => {
    expect(evaluateExactArithmeticExpression(expression)).toEqual({ ok: false, error });
  });
});

describe('word-problem expression graph', () => {
  it('computes shared dependencies once and explains the operations in order', () => {
    const share = operation('/', quantity('5'), quantity('6'), 'one share');
    const sum = operation('+', share, share, 'two shares');
    expect(evaluateWordExpression(sum)).toEqual({
      expression: '(5 / 6) + (5 / 6)',
      value: '5/3',
      steps: [
        { expression: '5 / 6', label: 'one share', value: '5/6' },
        { expression: '(5/6) + (5/6)', label: 'two shares', value: '5/3' },
      ],
    });
  });

  it('uses exact intermediate values for signed quantities and decimal rates', () => {
    const cost = operation('*', quantity('1/3'), quantity('2.7'), 'subtotal');
    const remaining = operation('+', cost, quantity('-0.8'));
    expect(evaluateWordExpression(remaining)).toEqual({
      expression: '((1/3) * 2.7) + (-0.8)',
      value: '0.1',
      steps: [
        { expression: '(1/3) * 2.7', label: 'subtotal', value: '0.9' },
        { expression: '0.9 + (-0.8)', value: '0.1' },
      ],
    });
    expect(evaluateWordExpression(quantity('1.5/2'))?.value).toBe('0.75');
  });

  it('rejects invalid quantities, zero division and cyclic or excessively deep expression graphs', () => {
    const one = quantity('1');
    expect(evaluateWordExpression(quantity('100 + 1'))).toBeNull();
    expect(evaluateWordExpression(operation('/', one, quantity('0')))).toBeNull();

    const cyclic = { kind: 'operation' as const, operator: '+' as const, left: one, right: one };
    cyclic.left = cyclic;
    expect(evaluateWordExpression(cyclic)).toBeNull();

    let nested = one;
    for (let index = 0; index < 50; index++) nested = operation('+', nested, one);
    expect(evaluateWordExpression(nested)).toBeNull();
  });
});
