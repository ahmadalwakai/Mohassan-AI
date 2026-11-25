import { evaluateExactArithmeticExpression } from '../../apps/server/src/assistant/calculator.js';
import { operation, quantity, type WordExpression } from '../../apps/server/src/assistant/word-problem-graph.js';

type Operator = Extract<WordExpression, { kind: 'operation' }>['operator'];

const ANNOTATION = /<<([^<>]+)>>/gu;
const DECIMAL = /^(?:\d+(?:\.\d*)?|\.\d+)$/u;
const PRECEDENCE: Readonly<Record<Operator, number>> = { '+': 1, '-': 1, '*': 2, '/': 2 };
const MAX_VARIANTS = 16;

function exact(text: string, allowPercent = false): string | null {
  const result = evaluateExactArithmeticExpression(text, { allowPercent });
  return result.ok ? result.value : null;
}

function parseAnnotation(text: string): WordExpression | null {
  const source = text.replaceAll(/\s/gu, '');
  const tokens = source.match(/(?:\d+(?:\.\d*)?|\.\d+)|[-+*/()%]/gu) ?? [];
  if (!tokens.length || tokens.length > 64 || tokens.join('') !== source) return null;
  let index = 0;

  function operand(): WordExpression | null {
    if (tokens[index] === '(') {
      index++;
      const inner = expression(1);
      return inner && tokens[index++] === ')' ? inner : null;
    }
    const negative = tokens[index] === '-';
    if (negative || tokens[index] === '+') index++;
    const token = tokens[index++];
    if (!token || !DECIMAL.test(token)) return null;
    const percent = tokens[index] === '%';
    if (percent) index++;
    const value = exact(`${negative ? '-' : ''}${token}${percent ? '/100' : ''}`);
    return value === null ? null : quantity(value);
  }

  function expression(minimum: number): WordExpression | null {
    let left = operand();
    while (left && Object.hasOwn(PRECEDENCE, tokens[index])) {
      const operator = tokens[index] as Operator;
      if (PRECEDENCE[operator] < minimum) break;
      index++;
      const right = expression(PRECEDENCE[operator] + 1);
      left = right ? operation(operator, left, right) : null;
    }
    return left;
  }

  const result = expression(1);
  return index === tokens.length ? result : null;
}

/** Keep subtraction and division ordered. Normalize only associative, commutative operations and extracted ratios. */
export function canonicalSearchExpression(node: WordExpression, fractions: ReadonlySet<string>): string {
  if (node.kind === 'value') return exact(node.value) ?? node.value;
  const operator = node.operator;
  if (operator === '/' && node.left.kind === 'value' && node.right.kind === 'value') {
    const value = exact(`(${node.left.value})/(${node.right.value})`);
    if (value !== null && fractions.has(value)) return value;
  }
  function parts(current: WordExpression): string[] {
    if ((operator === '+' || operator === '*') && current.kind === 'operation' && current.operator === operator) {
      return [...parts(current.left), ...parts(current.right)];
    }
    return [canonicalSearchExpression(current, fractions)];
  }
  const children = [...parts(node.left), ...parts(node.right)];
  if (operator === '+' || operator === '*') children.sort();
  return `(${operator},${children.join(',')})`;
}

/** Resolve a magnitude to earlier annotated operations as well as the literal when its role is ambiguous. */
function expand(node: WordExpression, known: ReadonlyMap<string, WordExpression[]>): WordExpression[] {
  if (node.kind === 'value') return [node, ...(known.get(node.value) ?? [])].slice(0, MAX_VARIANTS);
  const left = expand(node.left, known);
  const right = expand(node.right, known);
  const versions: WordExpression[] = [];
  // Visit the fully expanded dependencies first so the bound preserves nested derivations.
  for (const first of left.reverse()) {
    for (const second of [...right].reverse()) {
      versions.push(operation(node.operator, first, second));
      if (versions.length === MAX_VARIANTS) return versions.reverse();
    }
  }
  return versions.reverse();
}

/** Extract exact, annotated final derivations. Skip rounded or missing final annotations. */
export function goldSearchExpressions(annotated: string, finalAnswer: string, fractions: ReadonlySet<string>): Set<string> {
  const assignments = [...annotated.matchAll(ANNOTATION)];
  const known = new Map<string, WordExpression[]>();
  const gold = exact(finalAnswer);
  for (const [index, assignment] of assignments.entries()) {
    const [source, asserted, extra] = assignment[1].replaceAll(',', '').split('=');
    if (asserted === undefined || extra !== undefined) continue;
    // Integral floor-division annotations are equivalent under rational arithmetic.
    const expression = source.replaceAll('//', '/');
    const value = exact(asserted);
    if (value === null || exact(expression, true) !== value) continue;
    const parsed = parseAnnotation(expression);
    if (!parsed) continue;
    const expanded = expand(parsed, known);
    if (index === assignments.length - 1 && value === gold) {
      return new Set(expanded.map(node => canonicalSearchExpression(node, fractions)));
    }
    known.set(value, [...(known.get(value) ?? []), ...expanded].slice(-MAX_VARIANTS + 1));
  }
  return new Set();
}
