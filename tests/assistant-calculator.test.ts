import { describe, expect, it } from 'vitest';
import { calculate, calculationReply, evaluateArithmeticExpression } from '../apps/server/src/assistant/calculator.js';
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

  it.each([
    ['-3^2', -9], ['(-3)^2', 9], ['-2^2^3', -256], ['(-2)^2^3', 256],
    ['2^-2', 0.25], ['2^(-2)', 0.25], ['2^-2^2', 0.0625], ['-2^-2', -0.25],
    ['2^3^2', 512], ['(2^3)^2', 64], ['2^--2', 4], ['3*-2^2', -12],
    ['--3^2', 9], ['8/4/2', 1], ['10-3-2', 5], ['2++3', 5],
  ])('uses standard signs, exponent precedence and associativity for %s', (expression, expected) => {
    expect(value(expression)).toBe(expected);
  });

  it.each([
    ['.5 + .25', 0.75], ['5. + .5', 5.5], ['(2.)*.5', 1], ['.2e+2 + 1', 21],
    ['1e-3 * 2e3', 2], ['2E2 + 3', 203], ['١٬٢٣٤٬٥٦٧ + ٣', 1234570],
    ['۱٫۲۵ + ٫۷۵', 2], ['1,234,567.5 + .5', 1234568],
  ])('reads complete decimal/scientific notation and validated grouping in %s', (expression, expected) => {
    expect(value(expression)).toBe(expected);
  });

  it('does not round a nonzero tiny answer to zero or insert spaces into exponent signs', () => {
    expect(calculationReply(calculate('1e-12 + 2e-12')!)).toBe('1e-12 + 2e-12 = **3e-12**');
    expect(calculationReply(calculate('1e+3 + 2')!)).toBe('1e+3 + 2 = **1,002**');
    expect(calculationReply(calculate('9007199254740990 + 1')!)).toContain('9.007199254740991e+15');
    expect(calculationReply(calculate('900719925474098 + 1')!)).toContain('900,719,925,474,099');
    expect(calculationReply(calculate('1.2345e-10 + 0')!)).toContain('1.2345e-10');
  });

  it.each([
    '3..5+2', '.+2', '1e+ + 2', '1 e3+2', '2(3+4)', '(2+3)4', '(2+3)(4+5)',
    '2**3', '3//2', '() + 2', '2+()', '1 + 2)', '(1 + 2', '3 + + * 4',
    '1,23+2', '1٬23+2', '1,234,56+2', '1234,567+2', '1,234٬567+2',
    '0x10 + 1', '0b10 + 1', '0o10 + 1', 'Math.pow(2,3)', 'process.exit()+2',
    '1 + 2; throw 1', '1 + 2\u0000', '1/0 + )', '1e309 + ) + 2',
  ])('leaves malformed or non-arithmetic input unchanged: %s', expression => {
    expect(calculate(expression)).toBeNull();
  });

  it.each([
    ['5 / 0', 'division_by_zero'], ['0 / 0', 'division_by_zero'], ['1 / -0', 'division_by_zero'], ['0^-2', 'division_by_zero'],
    ['2^1024', 'range'], ['2^53', 'range'], ['1e309 + 0', 'range'], ['1e-400 + 1', 'range'],
    ['1e-300 * 1e-100', 'range'], ['5e-324 * .5', 'range'], ['(-1)^.5', 'domain'],
  ] as const)('reports the actual calculation boundary in %s', (expression, error) => {
    const calculation = calculate(expression)!;
    expect(calculation.error).toBe(error);
    expect(Number.isFinite(calculation.value)).toBe(false);
    if (error !== 'division_by_zero') expect(calculationReply(calculation)).not.toContain('division by zero');
  });

  it('uses separate translated messages for division, range and supported-domain failures', () => {
    expect(calculationReply(calculate('احسب 2^1024')!)).toContain('نطاق الأعداد');
    expect(calculationReply(calculate('احسب (-1)^.5')!)).toContain('الأعداد الحقيقية');
    expect(calculationReply(calculate('Compute 2^1024')!)).toContain('number range');
    expect(calculationReply(calculate('Compute (-1)^.5')!)).toContain('real-number domain');
    expect(calculationReply({ expression: '2^1024', value: Infinity, lang: 'en' })).toContain('number range');
  });
});

describe('bounded numeric-expression parser', () => {
  it('supports opt-in postfix percentages without evaluating code or rewriting language', () => {
    expect(evaluateArithmeticExpression('12.5% * 160', { allowPercent: true })).toEqual({ ok: true, value: 20 });
    expect(evaluateArithmeticExpression('12.5% * 160')).toEqual({ ok: false, error: 'syntax' });
    expect(evaluateArithmeticExpression('2 plus 3')).toEqual({ ok: false, error: 'syntax' });
    expect(evaluateArithmeticExpression('globalThis.process.exit()')).toEqual({ ok: false, error: 'syntax' });
  });

  it('checks the whole grammar before numeric evaluation, keeping malformed inputs distinct from numeric errors', () => {
    for (const expression of ['1e309 + )', '1 / 0 + )', '(-1)^.5 + ()', '5e-400 + + * 3'])
      expect(evaluateArithmeticExpression(expression), expression).toEqual({ ok: false, error: 'syntax' });
  });

  it('bounds nesting, operation count, token count and input length without recursion', () => {
    expect(evaluateArithmeticExpression('('.repeat(64) + '1+1' + ')'.repeat(64))).toEqual({ ok: true, value: 2 });
    expect(evaluateArithmeticExpression('('.repeat(65) + '1+1' + ')'.repeat(65))).toEqual({ ok: false, error: 'complexity' });
    expect(evaluateArithmeticExpression('-'.repeat(257) + '1')).toEqual({ ok: false, error: 'complexity' });
    expect(evaluateArithmeticExpression(Array(260).fill('1').join('+'))).toEqual({ ok: false, error: 'complexity' });
    expect(evaluateArithmeticExpression('1'.repeat(4097))).toEqual({ ok: false, error: 'complexity' });
    expect(calculate('('.repeat(65) + '1+1' + ')'.repeat(65))?.error).toBe('complexity');
    expect(calculate('1+'.repeat(100) + '1')).toBeNull();
  });

  it('handles cancellation and zero powers without falsely diagnosing underflow', () => {
    expect(evaluateArithmeticExpression('1e-300 - 1e-300')).toEqual({ ok: true, value: 0 });
    expect(evaluateArithmeticExpression('0 * 1e-300')).toEqual({ ok: true, value: 0 });
    expect(evaluateArithmeticExpression('0^0')).toEqual({ ok: true, value: 1 });
    expect(evaluateArithmeticExpression('5e-324 * 1')).toEqual({ ok: true, value: Number.MIN_VALUE });
  });
});
