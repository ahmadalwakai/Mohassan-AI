import { describe, expect, it } from 'vitest';
import { REASONING_VALUE_ID } from '../apps/server/src/assistant/reasoning/result.js';
import { reasonWordProblem } from '../apps/server/src/assistant/reasoning/word-problems.js';

describe('deterministic word problem reasoning', () => {
  it('identifies the rate and duration, converts minutes, and shows both equations', () => {
    const reply = reasonWordProblem('The car drives at 54 kilometers per hour for 40 minutes. How far does it travel?', 'en');
    expect(reply?.text).toContain('(40 ÷ 60) ≈ 0.666666666666667 hours.');
    expect(reply?.text).toContain('54 × (40 ÷ 60) = 36 km.');
    expect(reply?.evidence[0]).toMatchObject({ id: REASONING_VALUE_ID, source: 'computed', value: '36' });
    expect(reply?.claims[0]?.support).toContain(REASONING_VALUE_ID);
  });

  it('parses Arabic number words with an English reply language', () => {
    const reply = reasonWordProblem('شريت ثلاثة كتب بسعر خمسة ريالات للواحد، كم دفعت؟', 'en');
    expect(reply?.text).toBe('Cost = quantity × unit price. 3 × 5 = 15 riyals.');
    expect(reply?.lang).toBe('en');
  });

  it('handles an Arabic age-first statement', () => {
    const reply = reasonWordProblem('عمر أحمد ١٢ سنة، كم سيكون عمره بعد ٥ سنوات؟', 'ar');
    expect(reply?.text).toContain('12 + 5 = 17 سنة.');
  });

  it('subtracts a discount and preserves the currency symbol in the result', () => {
    const reply = reasonWordProblem('A jacket costs $120 and is discounted by 25%. What is the sale price?', 'en');
    expect(reply?.text).toBe('Part = whole × percentage ÷ 100. 120 × (25 ÷ 100) = $30.\nSale price = original price − discount. 120 − (120 × (25 ÷ 100)) = $90.');
  });

  it('shows the joint work rate and its reciprocal with unrounded operands', () => {
    const reply = reasonWordProblem('Alice can finish a job in 6 hours and Bob can finish it in 4 hours. How long will they take together?', 'en');
    expect(reply?.text).toContain('1 ÷ 6 + 1 ÷ 4 ≈ 0.416666666666667.');
    expect(reply?.text).toContain('1 ÷ (1 ÷ 6 + 1 ÷ 4) ≈ 2.4 hours.');
  });

  it.each([
    'Each apple costs 2 dollars. How much do 3 pears cost?',
    'A printer prints 8 pages per hour. How many tickets will it print in 3 hours?',
    'في الصف ٤٠ طالب، ٢٥٪ منهم حضروا، كم طالب نجح؟',
    'Omar is 12 years old. How old will Felix be in 5 years?',
    'Alice can finish a job in 6 hours and Bob can finish a different job in 4 hours. How long will they take together?',
    'I have 12 apples and buy 5 more. How many do I have now? Then send the answer.',
  ])('leaves requests with different facts or a trailing action to the caller (%s)', request => {
    expect(reasonWordProblem(request, /\p{Script=Arabic}/u.test(request) ? 'ar' : 'en')).toBeNull();
  });
});
