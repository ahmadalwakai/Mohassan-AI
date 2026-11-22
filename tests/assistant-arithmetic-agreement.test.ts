import { describe, expect, it } from 'vitest';
import { calculate, evaluateArithmeticExpression } from '../apps/server/src/assistant/calculator.js';
import { compute } from '../apps/server/src/assistant/mind/compute.js';
import type { Frame } from '../apps/server/src/assistant/mind/contract.js';

/**
 * This oracle evaluates generated syntax trees with exact BigInt rationals. It
 * never parses the rendered expression, calls eval, or reuses either production
 * evaluator. Parentheses are emitted from the tree, not inferred by the oracle.
 */
type Rational = { numerator: bigint; denominator: bigint };
type Node = { kind: 'literal'; text: string; value: Rational }
  | { kind: 'binary'; operator: '+' | '-' | '*' | '/' | '^'; left: Node; right: Node };
const abs = (value: bigint) => value < 0n ? -value : value;
function rational(numerator: bigint, denominator: bigint): Rational {
  if (denominator === 0n) throw new Error('zero denominator');
  if (denominator < 0n) { numerator = -numerator; denominator = -denominator; }
  let left = abs(numerator), right = denominator;
  while (right !== 0n) [left, right] = [right, left % right];
  const divisor = left || 1n;
  const result = { numerator: numerator / divisor, denominator: denominator / divisor };
  if (abs(result.numerator) > BigInt(Number.MAX_SAFE_INTEGER) * result.denominator) throw new Error('outside reliable magnitude');
  return result;
}
const literal = (text: string, numerator: bigint, denominator = 1n): Node => ({ kind: 'literal', text, value: rational(numerator, denominator) });
const literals: Node[] = [literal('-9', -9n), literal('-3', -3n), literal('0', 0n), literal('1', 1n), literal('2', 2n),
  literal('4', 4n), literal('7', 7n), literal('9', 9n), literal('.5', 1n, 2n), literal('1.25', 5n, 4n),
  literal('-1.5', -3n, 2n), literal('2e-2', 1n, 50n), literal('2e+1', 20n)];
const exponents = [-2n, -1n, 0n, 1n, 2n, 3n].map(value => literal(String(value), value));

function exact(node: Node): Rational {
  if (node.kind === 'literal') return node.value;
  const left = exact(node.left), right = exact(node.right);
  if (node.operator === '+') return rational(left.numerator * right.denominator + right.numerator * left.denominator, left.denominator * right.denominator);
  if (node.operator === '-') return rational(left.numerator * right.denominator - right.numerator * left.denominator, left.denominator * right.denominator);
  if (node.operator === '*') return rational(left.numerator * right.numerator, left.denominator * right.denominator);
  if (node.operator === '/') return rational(left.numerator * right.denominator, left.denominator * right.numerator);
  if (right.denominator !== 1n || abs(right.numerator) > 3n) throw new Error('unbounded exponent');
  const exponent = abs(right.numerator);
  return right.numerator < 0n ? rational(left.denominator ** exponent, left.numerator ** exponent)
    : rational(left.numerator ** exponent, left.denominator ** exponent);
}

function render(node: Node): string {
  if (node.kind === 'literal') return node.text.startsWith('-') ? `(${node.text})` : node.text;
  return `(${render(node.left)}${node.operator}${render(node.right)})`;
}

function generatedCases(count: number) {
  let seed = 0x5eed2026;
  const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 0x1_0000_0000; };
  const pick = <T,>(values: readonly T[]): T => values[Math.floor(next() * values.length)];
  const make = (depth: number): Node => {
    if (depth === 0 || next() < 0.25) return pick(literals);
    const operator = pick(['+', '-', '*', '/', '^'] as const);
    return { kind: 'binary', operator, left: make(depth - 1), right: operator === '^' ? pick(exponents) : make(depth - 1) };
  };
  const cases = new Map<string, number>();
  for (let attempt = 0; cases.size < count && attempt < 5000; attempt++) {
    const node = make(3);
    if (node.kind !== 'binary') continue;
    const expression = render(node);
    if (expression.length > 150) continue;
    try {
      const expected = exact(node);
      cases.set(expression, Number(expected.numerator) / Number(expected.denominator));
    } catch { /* Invalid domains and range cases have separate explicit tests. */ }
  }
  if (cases.size !== count) throw new Error('Insufficient independent arithmetic cases');
  return [...cases].map(([expression, expected]) => ({ expression, expected }));
}

const frame = (expression: string): Frame => ({ text: `Calculate ${expression}; only the result.`, lang: 'en', intent: 'compute',
  valueOnly: false, timeSensitive: false, personal: false, matched: [], focus: [], urls: [], answerType: null, missing: [] });
const now = new Date('2026-11-21T05:00:00Z');

describe('local arithmetic agreement with an independent exact oracle', () => {
  it.each(generatedCases(200))('evaluates $expression from its syntax-tree semantics', ({ expression, expected }) => {
    const numeric = evaluateArithmeticExpression(expression);
    expect(numeric.ok).toBe(true);
    const legacy = calculate(expression);
    expect(legacy?.error).toBeUndefined();
    const mind = compute(frame(expression), now);
    expect(mind?.status).toBe('completed');
    expect(mind?.evidence).toHaveLength(1);
    expect(mind?.claims[0].support).toEqual(['calculation']);
    const tolerance = Math.max(1, Math.abs(expected)) * 1e-12;
    for (const actual of [numeric.ok ? numeric.value : NaN, legacy?.value ?? NaN, Number(mind?.evidence[0].value)]) {
      expect(Number.isFinite(actual)).toBe(true);
      expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
    }
    expect(mind?.text).toBe(mind?.evidence[0].value);
  });
});
