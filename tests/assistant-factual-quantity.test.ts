import { describe, expect, it } from 'vitest';
import { extractEnglishQuantity } from '../apps/server/src/assistant/factual-quantity.js';

describe('grounded factual quantities', () => {
  it('extracts a count in words for the requested subject, action and kind', () => {
    const question = 'How many children did the caretaker welcome?';
    expect(extractEnglishQuantity(question, 'The caretaker welcomed sixteen children during the first shift.')).toBe('sixteen children');
    expect(extractEnglishQuantity(question, 'The caretaker welcomed sixteen volunteers and brought two children.')).toBeUndefined();
    expect(extractEnglishQuantity('How many trees did Arthur have?', 'Arthur worked with his neighbors, with whom he had twenty-one trees in the orchard.')).toBe('twenty-one trees');
  });

  it('keeps the count qualifier, separator and multi-word unit', () => {
    const question = 'How many red deer live in North Vale?';
    expect(extractEnglishQuantity(question, 'In North Vale, there are an estimated 3,400 red deer.')).toBe('an estimated 3,400 red deer');
    expect(extractEnglishQuantity(question, 'In South Vale, there are an estimated 3,400 red deer.')).toBeUndefined();
  });

  it('keeps a printed range and checks that its unit measures what was asked', () => {
    const question = 'How deep is the civic well?';
    expect(extractEnglishQuantity(question, 'The civic well is 8–10 m deep.')).toBe('8–10 m');
    expect(extractEnglishQuantity(question, 'The civic well is 8–10 years old.')).toBeUndefined();
    expect(extractEnglishQuantity(question, 'The civic well overlooks a trench that is 8–10 m deep.')).toBeUndefined();
  });

  it('reads a spelled-out duration and requires established context for an anaphor', () => {
    const question = 'How long did the River Club operate?';
    expect(extractEnglishQuantity(question, 'The River Club operated for seven to ten weeks.')).toBe('seven to ten weeks');
    expect(extractEnglishQuantity(question, '[12] The River Club operated for between seven and ten weeks.')).toBe('between seven and ten weeks');
    expect(extractEnglishQuantity(question, 'It operated for seven to ten weeks.')).toBeUndefined();
    expect(extractEnglishQuantity(question, 'It operated for seven to ten weeks.', { subject: 'River Club', subjectAnchored: true })).toBe('seven to ten weeks');
    expect(extractEnglishQuantity(question, 'The River Club rented the hall for seven to ten weeks.')).toBeUndefined();
  });

  it('abstains for ambiguous counts, rates and counts belonging to another entity', () => {
    const question = 'How many seats does North Hall have?';
    for (const quote of [
      'North Hall has 27 seats and is sometimes listed as having 30 seats.',
      'North Hall has 27 seats per tier.',
      'North Hall is near a restaurant with 27 seats.',
      'North Hall has an annex which has 27 seats.',
      'The lobby of North Hall has 27 seats.',
    ]) expect(extractEnglishQuantity(question, quote)).toBeUndefined();
  });
});
