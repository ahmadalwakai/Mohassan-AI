import { describe, expect, it } from 'vitest';
import { extractSearchProblem } from '../apps/server/src/assistant/arithmetic-search-quantities.js';

describe('English arithmetic search quantities', () => {
  it('extracts exact numerals, compound words, mixed fractions, percentages and multiples', () => {
    const problem = extractSearchProblem([
      'Willa bought twenty-four wooden pegs and one thousand and forty fasteners',
      'She used three sevenths of the pegs and 12.5 percent of the glue',
      'Willa works twice a week for 1 1/2 hours and then triple the time on call',
      'She orders two dozen washers and keeps half a bag of beads',
    ], 'How many pegs will she use in 4 weeks?');
    expect(problem.quantities.map(({ value, kind, unit, per }) => [value, kind, unit, per])).toEqual([
      ['24', 'amount', 'peg', null],
      ['1040', 'amount', 'fastener', null],
      ['3/7', 'fraction', null, null],
      ['12.5/100', 'percentage', null, null],
      ['2', 'multiple', null, 'week'],
      ['3/2', 'fraction', 'hour', null],
      ['3', 'multiple', null, null],
      ['24', 'multiple', 'washer', null],
      ['1/2', 'fraction', 'bag', null],
      ['4', 'amount', 'week', null],
    ]);
    expect(problem.quantities[0]).toMatchObject({ category: 'count', entity: 'willa', before: ['willa', 'bought'], inQuestion: false });
    expect(problem.quantities[2]).toMatchObject({ category: 'ratio', entity: 'peg' });
    expect(problem.quantities[3]).toMatchObject({ category: 'ratio', entity: 'glue' });
    expect(problem.quantities[8]).toMatchObject({ category: 'count', entity: 'bead' });
    expect(problem.quantities[9]).toMatchObject({ category: 'time', sentence: 4, inQuestion: true });
    const last = problem.quantities[9];
    expect(problem.text.slice(last.start, last.end)).toBe('4');
  });

  it('binds currencies, count subsets, time and measured quantities to their referents', () => {
    const problem = extractSearchProblem([
      'The stall sells 9 enamel pins for two dollars each',
      'Five of the pins carry an emblem',
      'It paid €2.75 per badge',
      'The stall holds 5kg of chalk for 3 hours',
    ], 'What is the average cost per badge?');
    expect(problem.quantities).toEqual([
      expect.objectContaining({ value: '9', unit: 'pin', entity: 'stall' }),
      expect.objectContaining({ value: '2', category: 'money', unit: 'dollar', per: 'pin', entity: 'stall' }),
      expect.objectContaining({ value: '5', category: 'count', unit: 'pin', entity: 'pin' }),
      expect.objectContaining({ value: '2.75', category: 'money', unit: 'euro', per: 'badge', entity: 'badge' }),
      expect.objectContaining({ value: '5', category: 'measure', unit: 'kilogram', entity: 'chalk' }),
      expect.objectContaining({ value: '3', category: 'time', unit: 'hour', entity: 'stall' }),
    ]);
    expect(problem.target).toMatchObject({ intent: 'average', unit: null, per: 'badge' });
  });

  it('omits number labels, clock times, ranges and invalid fractional quantities', () => {
    const { quantities } = extractSearchProblem([
      'The display in room 37 shows 4-8 seats and opens at 6:30',
      'Omar keeps 1,250 pamphlets there',
      'His notes say 3/0 is invalid',
    ], 'How many pamphlets does Omar have?');
    expect(quantities.map(({ value }) => value)).toEqual(['1250']);
  });

  it('binds rates stated with an individual subject or a reference to the previous count', () => {
    const { quantities } = extractSearchProblem([
      'Nina has 14 packets',
      'The packets contain 11 stickers each',
      'Each envelope holds 3 labels',
    ], 'How many stickers are in a packet?');
    expect(quantities.map(({ unit, per }) => [unit, per])).toEqual([
      ['packet', null], ['sticker', 'packet'], ['label', 'envelope'],
    ]);
  });
});

describe('English arithmetic search target', () => {
  it.each([
    ['How many brooches do they have altogether?', 'total', 'brooch', null],
    ['How many pins are left?', 'remainder', 'pin', null],
    ['What is the difference in the number of pins?', 'difference', 'pin', null],
    ['At what rate does it package pins per hour?', 'rate', 'pin', 'hour'],
    ['How many pins are needed per badge?', 'per-unit', 'pin', 'badge'],
    ['How many times as many pins does Zara have?', 'comparison', null, null],
    ['What is the average number of pins?', 'average', 'pin', null],
    ['What percent of the pins are blue?', 'percentage', null, null],
    ['How much did Zara spend?', 'unknown', 'dollar', null],
  ])('identifies intent and units in %s', (question, intent, unit, per) => {
    const { target } = extractSearchProblem(['Zara paid $11 for 8 pins and took 2 hours to pack them'], question);
    expect(target).toMatchObject({ intent, unit, per });
  });
});
