import { describe, expect, it } from 'vitest';
import { searchCandidates } from '../apps/server/src/assistant/arithmetic-search-candidates.js';
import { extractSearchProblem } from '../apps/server/src/assistant/arithmetic-search-quantities.js';
import { evaluateWordExpression } from '../apps/server/src/assistant/word-problem-graph.js';

const search = (statements: string[], question: string) => searchCandidates(extractSearchProblem(statements, question));

describe('typed arithmetic expression search', () => {
  it('cancels a rate with a matching amount and converts a stated time unit', () => {
    const candidates = search(['A conveyor moves 0.125 kilograms per second'], 'How many kilograms move in 3 minutes?');
    const answer = candidates.find(candidate => candidate.expression === '0.125 * (3 * 60)');
    expect(answer).toMatchObject({ value: '22.5', operations: 2, features: { 'constant:conversion': 1, 'bound:rate-product': 1, matched: 1 } });
    expect(evaluateWordExpression(answer!.graph)?.steps).toEqual([
      { expression: '3 * 60', value: '180', label: 'Convert minute to second' },
      { expression: '0.125 * 180', value: '22.5' },
    ]);
  });

  it('does not add quantities of unrelated units or apply a price to another item', () => {
    const candidates = search(['The price is $4 per badge', 'The shop ordered 3 candles'], 'How many dollars will the candles cost?');
    expect(candidates).toEqual([]);
  });

  it('limits average candidates to division and licenses an observation count', () => {
    const candidates = search(['One ribbon is 7 meters long', 'Another ribbon is 8 meters long'], 'What is the average length in meters?');
    expect(candidates).toEqual(expect.arrayContaining([expect.objectContaining({
      expression: '(7 + 8) / 2', value: '7.5', features: expect.objectContaining({ 'constant:average': 1 }),
    })]));
    expect(candidates.every(candidate => candidate.features['root:/'] === 1)).toBe(true);
  });

  it('distinguishes fraction and percentage requests and preserves exact nonterminal fractions', () => {
    const statements = ['There are 7 panes', 'The worker repaired 2 panes'];
    const percentage = search(statements, 'What percentage of the panes did the worker repair?');
    const fraction = search(statements, 'What fraction of the panes did the worker repair?');
    expect(percentage).toEqual(expect.arrayContaining([expect.objectContaining({ expression: '(2 / 7) * 100', value: '200/7' })]));
    expect(fraction).toEqual(expect.arrayContaining([expect.objectContaining({ expression: '2 / 7', value: '2/7' })]));
  });

  it('tries the surviving share when a stated percentage reduces an amount', () => {
    const candidates = search(['A ticket costs $15', 'A discount takes 20 percent off the price'], 'How much money is left to pay?');
    expect(candidates).toEqual(expect.arrayContaining([expect.objectContaining({
      expression: '15 * (1 - (20/100))', value: '12', features: expect.objectContaining({ 'constant:complement': 1 }),
    })]));
  });

  it('licenses a conversion when the question gives a different unit for one amount', () => {
    expect(search(['The segment is 84 inches long'], 'How long is the segment in feet?')).toEqual([
      expect.objectContaining({ expression: '84 / 12', value: '7' }),
    ]);
  });

  it('recognizes a complete balance only when the expression follows each event’s direction', () => {
    const candidates = search(['The hall had 16 lanterns', 'The curator removed 5 lanterns'], 'How many lanterns remained?');
    expect(candidates.find(candidate => candidate.expression === '16 - 5')?.features['bound:inventory']).toBe(1);
    expect(candidates.find(candidate => candidate.expression === '16 + 5')?.features['bound:inventory']).toBeUndefined();
  });

  it('distinguishes a pooled total per requested recipient from other operations', () => {
    const candidates = search(['The hall supplied 9 badges and the café supplied 11 badges', 'The badges were shared among 4 volunteers'],
      'How many badges per volunteer?');
    expect(candidates).toEqual(expect.arrayContaining([expect.objectContaining({
      expression: '(9 + 11) / 4', value: '5', features: expect.objectContaining({ 'bound:combined-share': 1, 'bound:requested-denominator': 1 }),
    })]));
  });

  it('combines groups and ranks with sparse context and structure features', () => {
    const statements = ['A conservator packed 3 parcels of 5 ornaments and 2 parcels of 7 ornaments'];
    const candidates = search(statements, 'How many ornaments did the conservator pack altogether?');
    const answer = candidates.find(candidate => candidate.expression === '(3 * 5) + (2 * 7)');
    expect(answer).toMatchObject({ value: '29', operations: 3, features: {
      'root:+': 1, 'operation:*': 2, 'intent:total:+': 1, used: 4, omitted: 0, matched: 1,
    } });
    expect(search(statements, 'How many ornaments did the conservator pack altogether?')).toEqual(candidates);
  });

  it('abstains when the input exceeds the fixed search budget', () => {
    expect(search(['There were 2 bowls, 3 mats, 4 lights, 5 ribbons, 6 bags, 7 ornaments, 8 boxes and 9 cups'],
      'How many items were there in total?')).toEqual([]);
  });
});
