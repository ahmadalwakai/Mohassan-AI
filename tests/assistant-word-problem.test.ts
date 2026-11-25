import { describe, expect, it } from 'vitest';
import { evaluateWordProblem } from '../apps/server/src/assistant/word-problem.js';
import { parseNumber, unitKey } from '../apps/server/src/assistant/word-problem-quantities.js';

describe('local arithmetic word problems', () => {
  it.each([
    ['A screen displays 15 frames per second. How many frames does it display in 4 minutes?', '3600'],
    ['A cyclist travels 9 miles every 2 hours. How far will the cyclist travel in 6 hours?', '27'],
    ['A baker makes three loaves per hour. How many loaves does the baker make in 1½ hours?', '4.5'],
    ['Tess has 8 bundles. Each bundle contains 6 postcards. How many postcards does Tess have in total?', '48'],
    ['Tess bought 4 packs of 12 postcards each. How many postcards did Tess buy?', '48'],
    ['Each scarf costs $7.50. If Avery buys 3 scarves, how much does Avery pay?', '22.5'],
    ['Each scarf costs $7.50. How much do 3 scarves cost in total?', '22.5'],
    ['Avery has 27 postcards. Avery divides them equally among 9 students. How many postcards will each student get?', '3'],
    ['Kenji wrote 8 poems last month. If that amount is two thirds of the number of poems Kenji has written this month, how many poems has Kenji written this month?', '12'],
    ['Ari can assemble 6 lanterns in 2 hours. How many minutes will it take Ari to assemble 9 lanterns?', '180'],
    ['Mina is four times as old as Nia. In 6 years, Mina will be twice as old as Nia. How old is Nia now?', '3'],
  ])('finds a supported graph for %s', (story, expected) => {
    const result = evaluateWordProblem(story);
    expect(result?.status).toBe('completed');
    expect(result?.text.split('\n').at(-1)).toBe(`Final answer = ${expected}`);
    expect(result?.evidence[0]).toMatchObject({ id: 'calculation', value: expected, source: 'computed' });
    expect(result?.claims.length).toBeGreaterThan(1);
  });

  it.each([
    'A baker sells 3 loaves per hour. How many loaves does the baker eat in 5 hours?',
    'Musa has 9 cartons of 6 notebooks. How many notebooks will Musa buy?',
    'Nora has 14 plums. She ate some of them. How many plums does Nora have left?',
    'Each lamp costs $8. How much does Bea pay if Bea buys 3 chairs?',
    'Dan has 9 pieces of toast. Dan divides them equally among zero diners. How many pieces of toast does each diner get?',
  ])('abstains on an unbound or invalid reading of %s', story => {
    const result = evaluateWordProblem(story);
    expect(result).toMatchObject({ status: 'blocked', abstained: true, evidence: [] });
    expect(result?.text).toContain("couldn't solve this problem reliably");
    expect(result?.text.match(/\?/gu)).toHaveLength(1);
    expect(result?.text).not.toContain('Final answer');
  });

  it('leaves ordinary questions and requests for external actions to their existing routes', () => {
    expect(evaluateWordProblem('How many years did the Roman Empire last?')).toBeNull();
    expect(evaluateWordProblem('Search for a workshop that sells 9 rolls. How many are available?')).toBeNull();
    expect(evaluateWordProblem('A baker makes 3 loaves per hour. How many loaves does it make in 4 hours? Then save the result.')).toBeNull();
  });

  it.each([
    ['ينتج المصنع ١٢ ملصق في كل دقيقة. كم ملصق سينتج خلال ٥ دقائق؟', '60'],
    ['لدى هدى ١٨ بطاقة. ثم أعطت هدى ٦ منها. كم بقي لدى هدى؟', '12'],
    ['مع عمر ٨ أقلام. اشترى عمر ٣ أقلام. كم أصبح معه؟', null],
  ])('uses the same exact path for supported handwritten Arabic problems', (text, result) => {
    const answer = evaluateWordProblem(text);
    if (result === null) expect(answer?.text).toMatch(/لم أتمكن.+؟$/u);
    else {
      expect(answer).toMatchObject({ lang: 'ar', status: 'completed' });
      expect(answer?.text.split('\n').at(-1)).toBe(`النتيجة النهائية = ${result}`);
    }
  });

  it('preserves mixed, decimal and written amounts in canonical form', () => {
    expect(parseNumber('١٬٢٣٤٫٥')).toBe('1234.5');
    expect(parseNumber('1½')).toBe('3/2');
    expect(parseNumber('two hundred and twenty-four')).toBe('224');
    expect(parseNumber('three eighths')).toBe('3/8');
    expect(parseNumber('seven meters')).toBeNull();
    expect(unitKey('red berries')).toBe('red berry');
  });
});
