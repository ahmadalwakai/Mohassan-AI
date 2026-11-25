import { describe, expect, it } from 'vitest';
import { evaluateWordExpression } from '../apps/server/src/assistant/word-problem-graph.js';
import { parseRepeatedRates } from '../apps/server/src/assistant/word-problem-repeated-rates.js';

const cartons = ['A warehouse packs 4 crates every 2 hours', 'Each crate holds 6 jars', 'Each jar contains 8 beads'];

describe('composing counts with explicit rates', () => {
  it('multiplies every link from the time span to the requested unit', () => {
    const graph = parseRepeatedRates(cartons, 'How many beads does the warehouse pack in 6 hours');
    expect(graph && evaluateWordExpression(graph)).toMatchObject({ value: '576', steps: [
      { expression: '4 / 2', value: '2' },
      { expression: '2 * 6', value: '12' },
      { expression: '12 * 6', value: '72' },
      { expression: '72 * 8', value: '576' },
    ] });
  });

  it('combines the same rate for every member of an explicitly counted group', () => {
    const graph = parseRepeatedRates(['There are 3 machines', 'Each machine prints 8 labels per hour'],
      'How many labels do the machines print in 90 minutes');
    expect(graph && evaluateWordExpression(graph)?.value).toBe('36');
  });

  it('uses an explicit duration clause with the same rate owner', () => {
    const graph = parseRepeatedRates(['Each parcel contains 6 sheets', 'A shop prepares 9 parcels per day',
      'If the shop operates for 5 days'], 'How many sheets does the shop prepare');
    expect(graph && evaluateWordExpression(graph)?.value).toBe('270');
  });

  it.each([
    'How many beads does another warehouse pack in 6 hours',
    'How many beads does the warehouse consume in 6 hours',
    'How many jars does the warehouse pack in 6 hours',
    'How many beads does the warehouse pack in 6 shifts',
    'How many beads does the warehouse pack in 6 days',
  ])('leaves unsupported ownership, activity or time implicit in %s unresolved', question => {
    expect(parseRepeatedRates(cartons, question)).toBeNull();
  });

  it('leaves a chain with conflicting group contents unresolved', () => {
    expect(parseRepeatedRates([...cartons, 'Each jar contains 5 beads'],
      'How many beads does the warehouse pack in 6 hours')).toBeNull();
  });
});
