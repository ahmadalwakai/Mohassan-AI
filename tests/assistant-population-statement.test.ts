import { describe, expect, it } from 'vitest';
import { checkAnswerLine, hasFigureOf } from '../apps/server/src/assistant/answer-check.js';
import { judge } from '../apps/server/src/assistant/judge.js';

// The lines are sentences of live Wikipedia articles, as read on 2026-11-22 (artifacts/agent-gaps-2026-11-22/audit-head-3959084:
// wiring-probe.json, wiring-probe-after-1.json and the lines.mts diagnostic).
describe('a population question is answered by a statement of the population', () => {
  it.each([
    'يبلغ عدد سكان اليابان 123 مليون نسمة اعتباراً من 2024.',
    'قُدِّر عدد سكانها بأكثرَ من 120 مليون نسَمة؛ لتكون الثالثةَ عشْرة بين دول العالم سكانًا.',
    'ويبلغ عدد سكانها نحو 37 مليون نسمة، وعاصمتها الرباط وأكبر مدنها الدار البيضاء.',
    'تُعدُّ ألمانيا أكثر دول الاتحاد الأوروبي سكانا بأزبد من 83 مليون نسمة حسب إحصائيَّات 2024م.',
    'تقدر مساحة جيبوتي بنحو 23.200 كيلومتر مربع فقط، فيما يقدر عدد سكانها بنحو 1,000,000 نسمة، وعاصمتها مدينة جيبوتي.',
    'عدد سكانها 125,416,877 حسب آخر تعداد.',
    'ارتفع عدد سكان مصر إلى 105 ملايين نسمة.',
    'With a population of almost 123 million as of 2026, it is the world\'s 11th most populous country.',
    'With over 107 million inhabitants, Egypt is the most populous country in the Arab world.',
    'Its population of almost 29 million is highly urbanised and heavily concentrated on the eastern seaboard.',
    'About 123 million people live in Japan.',
    'The population rose to 40 million in 2023.',
    'The population is about 1,234.567 million people.',
  ])('accepts: %s', line => {
    expect(hasFigureOf('people', line)).toBe(true);
  });

  it.each([
    // A share of the world, with an unrelated «10» in a later clause: this led the answer to «كم عدد سكان أستراليا؟».
    'على الرغم من أن عدد سكان أستراليا يبلغ 0.3% فقط من سكان العالم، ساهمت أستراليا بنسبة 4.1% من الأبحاث المنشورة في العالم عام 2020، ما يجعلها واحدة من أفضل 10 مساهمين في الأبحاث في العالم.',
    // A density.
    'وتعدّ الكثافة السكانية 2.8 نسمة لكل كيلومتر مربع، ويعدّ من أدنى الم.',
    'The population density is 337 people per km².',
    // A number of something else beside the word, a time of day, a workforce.
    'عدد كبير من اللغة يتحدثها كبار السن; ونحو 18 لغة لسكان أستراليا الأصليون ينطقها جميع الفئات العمرية.',
    'يتم حساب تقدير عدد السكان الموضح تلقائيًا يوميًا في الساعة 00:00 بتوقيت UTC.',
    'في يناير 2007، كان هناك عدد 10,033,480 نسمة يعملون.',
    // The people of a counted class of places, not of the subject.
    'توجد في ألمانيا 82 مدينة يزيد عدد سكانها عن 100,000 نسمة.',
    'There are 81 cities with a population of over 100,000 people.',
    // How much a population changed.
    'ازداد تعداد سكان كندا بين 1990-2008 بنحو 5.6 مليون أي 20.4% نمو في عدد السكان مقارنة بنحو 21.7% في الولايات المتحدة.',
    'نما تعداد سكان العالم بين 1990-2008 بنسبة 27% أي 1,423 مليون.',
    'The population grew by 5.6 million between 1990 and 2008.',
    // A share and a bare year.
    'حوالي 65% من سكان فرنسا كاثوليك حسب تعداد 1999.',
  ])('refuses: %s', line => {
    expect(hasFigureOf('people', line)).toBe(false);
  });

  it('keeps the other kinds of figure as they were', () => {
    expect(hasFigureOf('any', 'بلا رقم')).toBe(true);
    expect(hasFigureOf('date', 'افتتحت بوابة براندنبورغ في 22 ديسمبر عام 1989.')).toBe(true);
    expect(hasFigureOf('duration', 'تستغرق العملية نحو 15 دقيقة.')).toBe(true);
  });

  it('fails the share of the world as an answer line to the question it once led', () => {
    const check = checkAnswerLine('كم عدد سكان أستراليا؟', 'على الرغم من أن عدد سكان أستراليا يبلغ 0.3% فقط من سكان العالم، ساهمت أستراليا بنسبة 4.1% من الأبحاث المنشورة في العالم عام 2020، ما يجعلها واحدة من أفضل 10 مساهمين في الأبحاث في العالم.');
    expect(check).toEqual({ ok: false, reasons: ['needs_unit'] });
  });
});

describe('the judge and a population lead', () => {
  const source = '**المصدر:** [ويكيبيديا — ألمانيا](https://ar.wikipedia.org/wiki/%D8%A3%D9%84%D9%85%D8%A7%D9%86%D9%8A%D8%A7) · قُرئت 2026-11-22 23:53 UTC';
  it('does not demote a lead that states the population for a line about cities (live 2026-11-22 23:53)', () => {
    const reply = [
      'تُعدُّ ألمانيا أكثر دول الاتحاد الأوروبي سكانا بأزبد من 83 مليون نسمة حسب إحصائيَّات 2024م، ومن بين الأكبر من حيث الكثافة السكانية في دول الاتحاد الأوروبي.',
      '', '**تفاصيل أخرى من نفس المصدر:**',
      '- في حين يشكل المهاجرون نسبة تفارب 9% من السكان، ويقارب عددهم 11 مليون نسمة بحسب مقال لوكالة رويترز.',
      '- توجد في ألمانيا 82 مدينة يزيد عدد سكانها عن 100,000 نسمة.',
      '', source,
    ].join('\n');
    const verdict = judge({ question: 'ما عدد سكان ألمانيا؟', reply, status: 'completed' });
    expect(verdict.codes).not.toContain('lead_not_best');
    expect(verdict.decision).toBe('send');
  });
});
