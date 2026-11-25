import { describe, expect, it } from 'vitest';
import { parseItemCosts } from '../apps/server/src/assistant/word-problem-costs.js';
import { evaluateWordExpression } from '../apps/server/src/assistant/word-problem-graph.js';

function solve(statements: string[], question: string) {
  const graph = parseItemCosts(statements, question);
  return graph && evaluateWordExpression(graph);
}

describe('word-problem item costs', () => {
  it('adds exact costs at separately stated unit prices', () => {
    const result = solve([
      'Each stencil costs $1.35 and each sketch pad costs 2.80 dollars',
      'Lin bought four stencils and three sketch pads',
    ], 'How much did Lin spend in total');
    expect(result).toMatchObject({ value: '13.8', steps: [
      { expression: '4 * 1.35', value: '5.4' },
      { expression: '3 * 2.8', value: '8.4' },
      { expression: '5.4 + 8.4', value: '13.8' },
    ] });
  });

  it('uses inline rates and accepts matching container units', () => {
    const result = solve([
      'Fatima ordered 3 boxes of hinges at £2.45 per box, 2 sanding blocks at £1.60 each, and five cloths for a total of £4',
    ], 'What was the total cost of the items');
    expect(result?.value).toBe('14.55');
  });

  it('can bind the amounts in the request to a catalogue', () => {
    const result = solve(['A bookmark costs €1.10', 'Each postcard is priced at €2.40'], 'How much would it cost to buy two bookmarks and four postcards');
    expect(result?.value).toBe('11.8');
  });

  it('does not split the conjunction inside a word number', () => {
    const result = solve(['Navi bought one hundred and two paper stars at $0.20 each'], 'How much did Navi pay');
    expect(result?.value).toBe('20.4');
  });

  it('uses opening funds for the balance and the explicit tender for change', () => {
    const statements = [
      'Nuri started with €40',
      'Nuri bought 3 plant pots at €3.25 each',
      'She also bought 2 seed trays at €1.50 each',
      'She handed over a €20 bill',
    ];
    expect(solve(statements, 'How much money does Nuri have left after these purchases')?.value).toBe('27.25');
    expect(solve(statements, 'How much change will she get back')?.value).toBe('7.25');
  });

  it.each([
    [['Arden bought 3 spools at $6'], 'How much did Arden spend'],
    [['Arden bought 3 spools at $6 each', 'Jo bought 2 felt hats at $9 each'], 'How much did Arden spend'],
    [['Arden bought 3 spools at $6 each and 2 hats at €9 each'], 'How much did Arden spend'],
    [['Arden bought 3 spools at $6 per metre'], 'How much did Arden spend'],
    [['Arden bought 3 spools at $6 each and 2 hats'], 'How much did Arden spend'],
    [['Arden has $30', 'Arden bought 3 spools at $6 each'], 'How much change will Arden get back'],
    [['Arden has $5', 'Arden bought 3 spools at $6 each'], 'How much money does Arden have left'],
    [['Arden bought 3 spools at $6 each'], 'How much money did Jo spend'],
    [['Arden bought 3 spools at $6 each'], 'How much did Arden spend in euros'],
    [['A spool costs $7', 'Arden bought 3 spools at $6 each'], 'How much did Arden spend'],
  ] satisfies [string[], string][])('abstains from purchases with missing or conflicting evidence (%j)', (statements, question) => {
    expect(solve(statements, question)).toBeNull();
  });
});
