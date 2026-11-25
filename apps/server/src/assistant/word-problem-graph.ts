import { evaluateExactArithmeticExpression } from './calculator.js';

type WordOperator = '+' | '-' | '*' | '/';

export type WordExpression =
  | { readonly kind: 'value'; readonly value: string }
  | { readonly kind: 'operation'; readonly operator: WordOperator; readonly left: WordExpression; readonly right: WordExpression; readonly label?: string };

interface ExpressionValue {
  expression: string;
  value: string;
}

interface WordStep extends ExpressionValue {
  label?: string;
}

export interface WordEvaluation extends ExpressionValue {
  steps: WordStep[];
}

const LITERAL = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:\/\d+)?$/u;
const MAX_DEPTH = 48;
const MAX_NODES = 128;
const MAX_EXPRESSION_LENGTH = 4096;

export function quantity(value: string): WordExpression {
  return { kind: 'value', value };
}

export function operation(operator: WordOperator, left: WordExpression, right: WordExpression, label?: string): WordExpression {
  return { kind: 'operation', operator, left, right, ...(label === undefined ? {} : { label }) };
}

function operand(value: string): string {
  return value.startsWith('-') || value.includes('/') ? `(${value})` : value;
}

/** Evaluate each dependency through the exact calculator and record steps in dependency order. */
export function evaluateWordExpression(root: WordExpression): WordEvaluation | null {
  const completed = new Map<WordExpression, ExpressionValue>();
  const active = new Set<WordExpression>();
  const steps: WordStep[] = [];

  function visit(node: WordExpression, depth: number): ExpressionValue | null {
    const known = completed.get(node);
    if (known) return known;
    if (depth > MAX_DEPTH || completed.size + active.size >= MAX_NODES || active.has(node)) return null;

    let expression: string;
    let calculation: string;
    if (node.kind === 'value') {
      if (node.value.length > MAX_EXPRESSION_LENGTH || !LITERAL.test(node.value)) return null;
      expression = calculation = node.value;
    } else {
      active.add(node);
      const left = visit(node.left, depth + 1);
      const right = left && visit(node.right, depth + 1);
      active.delete(node);
      if (!left || !right) return null;
      const before = node.left.kind === 'operation' ? `(${left.expression})` : operand(left.expression);
      const after = node.right.kind === 'operation' ? `(${right.expression})` : operand(right.expression);
      expression = `${before} ${node.operator} ${after}`;
      calculation = `${operand(left.value)} ${node.operator} ${operand(right.value)}`;
    }
    if (expression.length > MAX_EXPRESSION_LENGTH) return null;
    const evaluated = evaluateExactArithmeticExpression(calculation);
    if (!evaluated.ok) return null;
    const result = { expression, value: evaluated.value };
    completed.set(node, result);
    if (node.kind === 'operation') steps.push({ expression: calculation, value: result.value, ...(node.label === undefined ? {} : { label: node.label }) });
    return result;
  }

  const result = visit(root, 0);
  return result ? { ...result, steps } : null;
}
