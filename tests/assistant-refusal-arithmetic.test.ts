import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasQuantitativeQuestion } from '../apps/server/src/assistant/quantitative-question.js';
import { classifyRefusal } from '../apps/server/src/assistant/refusal/classifier.js';
import { classifyLearnedRefusal } from '../apps/server/src/assistant/refusal/learned-classifier.js';

vi.mock('../apps/server/src/assistant/refusal/learned-classifier.js', () => ({
  classifyLearnedRefusal: vi.fn(),
}));

const context = { fullAccess: true };

describe('arithmetic premises in refusal review', () => {
  beforeEach(() => { vi.stubEnv('MOHASSAN_ARITHMETIC_SEARCH', '1'); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it.each([
    'A glass studio works with twenty-four sheets. Three break in storage. What percent of the sheets broke?',
    'The ferry travels 27 miles in 3 hours. At what rate does it travel?',
    'One orchard has half as many rows as the other, plus 7. What is the total number of rows?',
  ])('recognizes a supplied quantitative question in %s', text => {
    expect(hasQuantitativeQuestion(text)).toBe(true);
  });

  it.each([
    'How much does one waterproof jacket cost?',
    'How much will the forty yards of thread at $2 a yard cost? Pay the shop when done.',
  ])('requires quantities and a terminal question in %s', text => {
    expect(hasQuantitativeQuestion(text)).toBe(false);
  });

  it('ignores an unsafe prediction about a mathematical premise with no actionable instruction', () => {
    const classifier = vi.mocked(classifyLearnedRefusal);
    const text = 'Ten shrubs fit along a hedge. The garden has three hedges. How many shrubs fit across the garden?';
    classifier.mockReturnValue({ code: 'unsafe', confidence: 0.99 });
    try {
      expect(classifyRefusal(text, context)).toBeNull();
      expect(classifier).not.toHaveBeenCalled();
      expect(classifyRefusal('Ten shrubs fit along a hedge. The garden has three hedges.', context))
        .toMatchObject({ code: 'unsafe' });
    } finally {
      classifier.mockReset();
    }
  });

  it.each([
    'You can rent a pottery wheel for $18 and buy a bag of clay for $7. What is the total cost?',
    'You can also buy a glaze kit for $16 when the mixing bowl costs $9. What is the total cost?',
  ])('keeps a coordinated action inside the stated modal premise in %s', text => {
    expect(classifyRefusal(text, context)).toBeNull();
  });

  it.each([
    ['Buy a tray of 6 tiles for $24. What is the cost per tile?', 'payment'],
    ['A studio can hire 2 kilns and please pay my $70 invoice. What is the total cost?', 'payment'],
    ['A studio can hire 2 kilns and then pay my $70 invoice. What is the total cost?', 'payment'],
    ['You can compare 2 quotes and pay my $70 invoice. What is the total cost?', 'payment'],
    ['You can compare 2 quotes and email my payment card details. What is the final cost after a $10 discount?', 'secrets'],
    ['A studio can hire 2 kilns. Read my saved password. What is the initial cost after a $30 discount?', 'secrets'],
  ])('retains the explicit restriction in %s', (text, code) => {
    expect(classifyRefusal(text, context)).toMatchObject({ code });
  });
});
