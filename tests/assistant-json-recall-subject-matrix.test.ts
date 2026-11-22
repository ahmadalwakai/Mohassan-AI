import { describe, expect, it } from 'vitest';
import { reviewMemoryRecallEvidence } from '../apps/server/src/assistant/memory-recall-evidence.js';

/** Independent literal identity matrix; visible development data, never a holdout. */
const pairs = [
  { lang: 'en', field: 'city', key: 'city', subjects: ['Alpha depot', 'Cedar workshop'], values: ['Bristol', 'Leeds'] },
  { lang: 'en', field: 'code', key: 'code', subjects: ['Lantern gallery', 'Orbit bakery'], values: ['LG-218', 'OB-731'] },
  { lang: 'en', field: 'color', key: 'color', subjects: ['North hall', 'South hall'], values: ['Indigo', 'Amber'] },
  { lang: 'ar', field: 'مدينة', key: 'city', subjects: ['مستودع النخيل', 'مخزن المرجان'], values: ['مسقط', 'صحار'] },
  { lang: 'ar', field: 'اسم', key: 'name', subjects: ['ورشة الندى', 'قاعة السرو'], values: ['نسيم', 'صفاء'] },
  { lang: 'ar', field: 'رمز', key: 'code', subjects: ['رصيف النورس', 'رصيف اللؤلؤ'], values: ['ZT-84', 'QL-26'] },
] as const;
const cases = pairs.flatMap(pair => [0, 1].map(index => ({ ...pair,
  subject: pair.subjects[index]!, otherSubject: pair.subjects[1 - index]!, value: pair.values[index]!, otherValue: pair.values[1 - index]!,
})));
function request(row: typeof cases[number]) {
  return row.lang === 'en'
    ? `From my memory, return the ${row.field} of my ${row.subject} as JSON only with key "${row.key}" as a string.`
    : `من ذاكرتي، أعد ${row.field} ${row.subject} بصيغة JSON فقط بالمفتاح "${row.key}" كنص.`;
}
function note(row: typeof cases[number], subject: string, value: string) {
  return row.lang === 'en' ? `The ${subject} ${row.field} is ${value}.` : `${row.field} ${subject} هو ${value}.`;
}
describe('generic JSON keys preserve the requested subject across independent entity/field pairs', () => {
  it.each(cases)('rejects a value belonging only to the other $lang $subject', async row => {
    const proposal = JSON.stringify({ [row.key]: row.otherValue });
    const reviewed = await reviewMemoryRecallEvidence(request(row), proposal,
      [note(row, row.otherSubject, row.otherValue)], new AbortController().signal);
    expect(reviewed.status, JSON.stringify(reviewed)).not.toBe('verified');
  });
  it.each(cases)('keeps the exact requested $lang $subject value despite a competing subject', async row => {
    const answer = JSON.stringify({ [row.key]: row.value });
    const reviewed = await reviewMemoryRecallEvidence(request(row), answer,
      [note(row, row.otherSubject, row.otherValue), note(row, row.subject, row.value)], new AbortController().signal);
    expect(reviewed.status, JSON.stringify(reviewed)).toBe('verified');
    if (reviewed.status === 'verified') expect(reviewed.answer).toBe(answer);
  });
});
