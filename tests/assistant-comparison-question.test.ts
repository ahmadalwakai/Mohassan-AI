import { describe, expect, it } from 'vitest';
import {
  comparisonAttributesIn, isConditionalComparisonAttribute, mentionsComparisonAttribute,
  mentionsComparisonSubject, parseComparisonQuestion,
} from '../apps/server/src/assistant/comparison-question.js';

describe('public comparison questions', () => {
  // The fixture's labels and quantities are inputs to the grammar, with no
  // assumed comparison result about the named subjects.
  const first = 'Python';
  const second = 'Java';
  const pair = [first, second];

  it.each([
    [`Is ${first} faster than ${second}?`, 'speed'],
    [`هل ${first} أسرع من ${second}؟`, 'speed'],
    [`Does ${first} run faster than ${second}?`, 'speed'],
    [`هل ${first} أفضل من ${second}؟`, 'general'],
    [`Is ${first} better than ${second}?`, 'general'],
    [`What is the price difference between ${first} and ${second}?`, 'price'],
    [`ما الفرق بين ${first} و${second} في السعر؟`, 'price'],
    [`مقارنة بين ${first} و${second}؟`, 'general'],
    [`مقارنة بين ${first} و${second} من حيث الأمان؟`, 'safety'],
    [`What is the difference between ${first} and ${second}?`, 'general'],
    [`${first} vs. ${second}: size?`, 'size'],
    [`${first} versus ${second} in terms of ease?`, 'ease'],
    [`${first} versus ${second} in terms of portability?`, 'portability'],
  ])('extracts both sides and the criterion from %s', (question, key) => {
    expect(parseComparisonQuestion(question)).toMatchObject({ subjects: pair, attribute: { key } });
  });

  it.each([
    [`أيهما أفضل للمبتدئين: ${first} أم ${second}؟`, 'للمبتدئين'],
    [`أيهما أفضل: ${first} أم ${second} للمبتدئين؟`, 'للمبتدئين'],
    [`Which is better for beginners: ${first} or ${second}?`, 'for beginners'],
    [`Which is better, ${first} or ${second}, for beginners?`, 'for beginners'],
  ])('preserves the audience from %s', (question, qualifier) => {
    const parsed = parseComparisonQuestion(question);
    expect(parsed).toMatchObject({ subjects: pair, qualifier, attribute: { key: 'general' } });
    expect(comparisonAttributesIn(parsed!, 'Novices reported a shorter learning curve.')).toContain('ease');
    expect(comparisonAttributesIn(parsed!, 'كانت هناك سهولة تعلم للمبتدئين.')).toContain('ease');
    expect(mentionsComparisonAttribute(parsed!, 'The two groups included novices.')).toBe(false);
    expect(mentionsComparisonAttribute(parsed!, 'The groups compared costs.')).toBe(false);
  });

  it('matches full names even when they are lowercase or have Arabic clitics', () => {
    expect(parseComparisonQuestion('is python faster than java?')?.subjects).toEqual(pair.map(item => item.toLowerCase()));
    expect(mentionsComparisonSubject('Python and JavaScript', 'Java')).toBe(false);
    expect(mentionsComparisonSubject('Compare C++ and C#', 'C')).toBe(false);
    expect(mentionsComparisonSubject('بينهما جافا وبايثون', 'بايثون')).toBe(true);
    expect(mentionsComparisonSubject('بينهما المغرب ومصر', 'المغرب')).toBe(true);
    expect(parseComparisonQuestion('Example Android vs. Example Other?')?.subjects).toEqual(['Example Android', 'Example Other']);
  });

  it('keeps speed distinct from unrelated dimensions', () => {
    const parsed = parseComparisonQuestion(`Is ${first} faster than ${second}?`)!;
    expect(mentionsComparisonAttribute(parsed, 'Safety and technical documentation')).toBe(false);
    expect(mentionsComparisonAttribute(parsed, 'Execution time and throughput')).toBe(true);
    expect(mentionsComparisonAttribute(parsed, 'سرعة التنفيذ')).toBe(true);
    expect(isConditionalComparisonAttribute(parsed.attribute.key)).toBe(true);
    expect(isConditionalComparisonAttribute('price')).toBe(true);
    expect(isConditionalComparisonAttribute('size')).toBe(false);
  });

  it.each([
    [`Which is longer, ${first} or ${second}?`, 'length', `${first} is ${first.length} km long.`],
    [`Which is taller, ${first} or ${second}?`, 'height', `${first} is ${first.length} m tall.`],
    [`Which is taller, ${first} or ${second}?`, 'height', `${first} is ${first.length} m high.`],
    [`Which is bigger, ${first} or ${second}?`, 'size', `${first} covers ${first.length} square kilometres.`],
    [`Which is bigger, ${first} or ${second}?`, 'size', `The area of ${first} is ${first.length} hectares.`],
  ])('accepts the measured predicate for %s', (question, key, excerpt) => {
    const parsed = parseComparisonQuestion(question);
    expect(parsed?.attribute.key).toBe(key);
    expect(mentionsComparisonAttribute(parsed!, excerpt)).toBe(true);
  });

  it('does not treat unrelated adjectives as physical measurements', () => {
    const length = parseComparisonQuestion(`Which is longer, ${first} or ${second}?`)!;
    const height = parseComparisonQuestion(`Which is taller, ${first} or ${second}?`)!;
    expect(mentionsComparisonAttribute(length, `${first} has a long history.`)).toBe(false);
    expect(mentionsComparisonAttribute(height, `${first} is in high demand.`)).toBe(false);
  });

  it.each([
    ['أيهما أكبر مساحة السعودية أم مصر؟', ['السعودية', 'مصر'], 'area'],
    ['أيهما أكبر عدد سكان السعودية أم مصر؟', ['السعودية', 'مصر'], 'population'],
    ['مين أحسن ميسي ولا رونالدو؟', ['ميسي', 'رونالدو'], 'general'],
    ['ايش الفرق بين الايفون والسامسونج', ['الايفون', 'السامسونج'], 'general'],
    ['Messi or Ronaldo, who is better?', ['Messi', 'Ronaldo'], 'general'],
  ])('extracts alternatives from %s', (question, subjects, key) => {
    expect(parseComparisonQuestion(question)).toMatchObject({ subjects, attribute: { key } });
  });

  it.each([
    'How do I use Python?',
    'ما هي Java؟',
    'Is Java better than ever?',
    'Which is better?',
    'مين أحسن؟',
    'ايش الفرق بينهما؟',
    'Messi, who is better?',
    'What is the difference between these?',
    'Which is longer from that page: Pine or Birch?',
    'Which is older: Sam 2 years or Lee 3 years?',
    'Which is older: A (born 1990-01-01) or B (born 1991-01-01)?',
    'أيهما أكبر: الأول ٥ أم الثاني؟',
    'Rank by length from the table',
  ])('leaves other questions to their existing paths (%s)', question => {
    expect(parseComparisonQuestion(question)).toBeNull();
  });
});
