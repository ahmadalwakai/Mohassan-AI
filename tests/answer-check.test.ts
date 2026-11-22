import { describe, expect, it } from 'vitest';
import { checkAnswerLine, checkAnswerLines, isDisambiguationPage, isDisambiguationTitle, isMetaLine, textLanguage } from '../apps/server/src/assistant/answer-check.js';

describe('answer checks before a line is sent (plan §7.4)', () => {
  it('rejects the lines the baseline sent with confidence', () => {
    expect(checkAnswerLine('What is the speed of light?', 'By Vicky Stein last updated October 29, 2024 Beyond the limits of light: exploring the speed of light.').reasons).toContain('meta_line');
    expect(checkAnswerLine('ما عاصمة اليابان؟', 'قد يُقصد من « طوكيو » ما يلي: طوكيو : عاصمة اليابان.').reasons).toContain('meta_line');
    expect(checkAnswerLine('What is the speed of light?', 'For other uses, see Speed of light (disambiguation).').reasons).toContain('meta_line');
    expect(checkAnswerLine('who wrote the novel One Hundred Years of Solitude', 'The novel is often cited as one of the great achievements in world literature.').reasons).toContain('needs_name');
  });

  it('accepts answers that carry what the question asks for', () => {
    expect(checkAnswerLine('who wrote the novel One Hundred Years of Solitude', 'One Hundred Years of Solitude is a 1967 novel by Colombian author Gabriel García Márquez.').ok).toBe(true);
    expect(checkAnswerLine('ما عاصمة اليابان؟', 'طوكيو هي عاصمة اليابان وأكبر مدنها، وتقع على الساحل الشرقي لجزيرة هونشو.').ok).toBe(true);
    expect(checkAnswerLine('What is the speed of light?', 'The speed of light in vacuum is 299,792,458 metres per second.').ok).toBe(true);
    expect(checkAnswerLine('كم عدد سكان مصر؟', 'يبلغ عدد سكان مصر نحو 105 ملايين نسمة بحسب تقديرات 2024.').ok).toBe(true);
  });

  it('wants a number for a how-many or when question', () => {
    expect(checkAnswerLine('كم عدد سكان مصر؟', 'مصر دولة عربية تقع في الركن الشمالي الشرقي من قارة أفريقيا.').reasons).toContain('needs_number');
    expect(checkAnswerLine('When did the Berlin Wall fall?', 'The Berlin Wall divided the city for decades.').reasons).toContain('needs_number');
    expect(checkAnswerLine('When did the Berlin Wall fall?', 'The Berlin Wall fell on 9 November 1989.').ok).toBe(true);
  });

  it('keeps the reply in the language of the question', () => {
    expect(textLanguage('طوكيو هي عاصمة اليابان وأكبر مدنها')).toBe('ar');
    expect(textLanguage('The speed of light in vacuum is 299,792,458 metres per second.')).toBe('en');
    expect(textLanguage('345')).toBe('none');
    expect(checkAnswerLine('ما عاصمة اليابان؟', 'Tokyo is the capital of Japan and its largest city.').reasons).toContain('language');
    expect(checkAnswerLine('What is the capital of Japan?', 'طوكيو هي عاصمة اليابان وأكبر مدنها.').reasons).toContain('language');
    // A proper noun inside an Arabic sentence is not a language change.
    expect(checkAnswerLine('ما هو الذكاء الاصطناعي؟', 'الذكاء الاصطناعي (Artificial Intelligence) هو سلوك وخصائص معينة تتسم بها البرامج الحاسوبية.').ok).toBe(true);
    // Nor is an English page title quoted inside an Arabic frame.
    expect(checkAnswerLine('افتح https://docs.python.org/3/tutorial/ ثم اقرأ الصفحة', 'من **Search — Python 3.15.2 documentation** (docs.python.org):').reasons).not.toContain('language');
    expect(checkAnswerLine('what is the capital of Japan', 'وصلت إلى **Tokyo - Wikipedia** (en.wikipedia.org):').reasons).toContain('language');
  });

  it('spots a disambiguation page by its title or its opening', () => {
    expect(isDisambiguationTitle('طوكيو (توضيح) - ويكيبيديا')).toBe(true);
    expect(isDisambiguationTitle('Mercury (disambiguation) - Wikipedia')).toBe(true);
    expect(isDisambiguationTitle('طوكيو - ويكيبيديا')).toBe(false);
    expect(isDisambiguationPage({ title: 'طوكيو', text: 'قد يُقصد من «طوكيو» ما يلي: طوكيو: عاصمة اليابان. طوكيو (محافظة).' })).toBe(true);
    expect(isDisambiguationPage({ title: 'Mercury', text: 'Mercury most commonly refers to: Mercury (planet). Mercury may also refer to: …' })).toBe(true);
    expect(isDisambiguationPage({ title: 'Tokyo', text: 'Tokyo, officially the Tokyo Metropolis, is the capital and most populous city of Japan.' })).toBe(false);
    expect(isMetaLine('من ويكيبيديا، الموسوعة الحرة')).toBe(true);
    expect(isMetaLine('آخر تحديث: 12 مايو 2026')).toBe(true);
    expect(isMetaLine('تقع طوكيو على الساحل الشرقي لجزيرة هونشو.')).toBe(false);
  });

  it('drops failing lines and lets the first survivor lead', () => {
    const result = checkAnswerLines('What is the speed of light?', [
      'By Vicky Stein last updated October 29, 2024',
      'For other uses, see Speed of light (disambiguation).',
      'The speed of light in vacuum is 299,792,458 metres per second.',
      'The Moon orbits Earth about once every 27 days.',
    ], { topic: ['speed', 'light'] });
    expect(result.lines).toEqual(['The speed of light in vacuum is 299,792,458 metres per second.']);
    // The byline names neither «speed» nor «light», so it is off topic as well as a byline.
    expect(result.dropped.map(entry => entry.reasons)).toEqual([['meta_line', 'off_topic'], ['meta_line'], ['off_topic']]);
  });
});
