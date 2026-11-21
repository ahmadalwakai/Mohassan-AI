import { describe, expect, it } from 'vitest';
import { calculate, calculationReply } from '../apps/server/src/assistant/calculator.js';
import { notWebReason } from '../apps/server/src/assistant/hands.js';

const value = (text: string) => calculate(text)?.value;

describe('calculate', () => {
  it('reads Arabic and English sums, words and symbols', () => {
    expect(value('كم يساوي 15 ضرب 23؟')).toBe(345);
    expect(value('٢٠ قسمة على ٤')).toBe(5);
    expect(value('احسب 100 ناقص 37')).toBe(63);
    expect(value('كم 7 زائد 8')).toBe(15);
    expect(value('2 أس 10')).toBe(1024);
    expect(value('What is (3 + 4) * 2?')).toBe(14);
    expect(value('12 divided by 5')).toBe(2.4);
    expect(value('1,250 × 4')).toBe(5000);
    expect(value('3 × -2')).toBe(-6);
    expect(value('2 + 3 * 4')).toBe(14);
    expect(value('2 ^ 3 ^ 2')).toBe(512);
    expect(value('١٫٥ ضرب ٤')).toBe(6);
  });

  it('leaves anything that is not a plain calculation alone', () => {
    for (const text of ['ما عاصمة اليابان؟', 'كم سعر الذهب في 2024', '15', 'كم عمري', 'اسم 3 اشياء', 'between 3 and 4 hours', '(3 + 4', '3 + + * 4', 'eval(1+1)'])
      expect(calculate(text), text).toBeNull();
  });

  it('shows the expression it read and handles division by zero', () => {
    expect(calculationReply(calculate('كم يساوي 15 ضرب 23؟')!)).toBe('15 × 23 = **345**');
    expect(calculationReply(calculate('1 / 3')!)).toBe('1 ÷ 3 = **0.3333333333**');
    expect(calculationReply(calculate('5 قسمة على 0')!)).toContain('القسمة على صفر');
  });

  it('matches what the router already treats as arithmetic', () => {
    expect(notWebReason('كم يساوي 15 ضرب 23؟')).toBe('arithmetic');
  });
});
