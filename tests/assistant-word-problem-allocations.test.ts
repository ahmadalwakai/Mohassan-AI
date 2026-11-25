import { describe, expect, it } from 'vitest';
import { parseAllocations } from '../apps/server/src/assistant/word-problem-allocations.js';
import { evaluateWordExpression } from '../apps/server/src/assistant/word-problem-graph.js';
import { evaluateWordProblem } from '../apps/server/src/assistant/word-problem.js';

function resolve(statements: readonly string[], question: string) {
  const graph = parseAllocations(statements, question);
  return graph && evaluateWordExpression(graph);
}

describe('word-problem allocation by a shared total', () => {
  it('resolves each owner against the same additive relationship', () => {
    const facts = ['Together, Cedar and Moss hold 86 buttons', 'Moss holds 16 more buttons than Cedar'];
    expect(resolve(facts, 'How many buttons does Cedar hold')).toMatchObject({ value: '35' });
    expect(resolve(facts, 'How many buttons does Moss hold')).toMatchObject({ value: '51' });
  });

  it('passes a conditional comparison through the word-problem entry point', () => {
    const result = evaluateWordProblem('Mara and Imani have 54 seed envelopes in all. If Mara has 12 more seed envelopes than Imani, how many seed envelopes does Imani have?');
    expect(result?.status).toBe('completed');
    expect(result?.text.split('\n').at(-1)).toBe('Final answer = 21');
  });

  it('uses the same combined amount when one share is fewer', () => {
    expect(resolve([
      'Jace holds 7 labels fewer than Noor', 'Noor and Jace own a total of 49 labels',
    ], 'How many labels does Jace hold')).toMatchObject({ value: '21' });
  });

  it('allocates a multiplier and amount in exact parts', () => {
    expect(resolve([
      'Oak and Pine have 15.3 kilograms of flour between them',
      'Pine has half as many kilograms of flour as Oak',
    ], 'How many kilograms of flour does Pine have')).toMatchObject({ value: '5.1' });
  });

  it('interprets a currency sign in place of a repeated noun', () => {
    expect(resolve([
      'Lou and Mina combined have $62.50', 'Lou has $8.50 more than Mina',
    ], 'How much does Mina have')).toMatchObject({ value: '27' });
  });

  it.each([
    ['Unmarked total', 'Rae and Sol have 35 beads', 'Sol has twice as many beads as Rae'],
    ['Other owner', 'Rae and Sol combined have 35 beads', 'Sol has twice as many beads as Kai'],
    ['Other unit', 'Rae and Sol combined have 35 beads', 'Sol has twice as many books as Rae'],
    ['Other time', 'Rae and Sol combined had 35 beads', 'Sol has twice as many beads as Rae'],
    ['Negative share', 'Rae and Sol combined have 35 beads', 'Sol has 40 more beads than Rae'],
  ])('abstains for %s', (_label, total, comparison) => {
    expect(resolve([total, comparison], 'How many beads does Rae have')).toBeNull();
  });
});
