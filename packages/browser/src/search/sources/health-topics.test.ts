import { describe, expect, it } from 'vitest';
import { englishHealthTopic, isKnownHealthTopic } from './health-topics.js';

describe('Arabic health query topics', () => {
  // WHO Arabic and English diabetes fact sheets, checked 2026-11-27.
  // https://www.who.int/ar/news-room/fact-sheets/detail/diabetes
  // https://www.who.int/news-room/fact-sheets/detail/diabetes
  it('maps the sourced topic within a question and preserves documented subtypes', () => {
    expect(englishHealthTopic('ما أعراض دَاء السُّكَّـرِيّ؟')).toBe('Diabetes');
    expect(englishHealthTopic('دراسات عن داء السكري من النمط ٢')).toBe('Type 2 diabetes');
  });

  it('recognizes exact topics in either language without treating longer strings as bare topics', () => {
    expect(isKnownHealthTopic(' داء السُّكَّـرِيّ ')).toBe(true);
    expect(isKnownHealthTopic('DIABETES')).toBe(true);
    expect(isKnownHealthTopic('diabetes printer')).toBe(false);
  });

  // WHO Arabic and English hepatitis B fact sheets, checked 2026-11-27.
  // https://www.who.int/ar/news-room/fact-sheets/detail/hepatitis-b
  // https://www.who.int/news-room/fact-sheets/detail/hepatitis-b
  it('retains the Latin letter in a bilingual topic', () => {
    expect(englishHealthTopic('كيف ينتشر التهاب الكبد B؟')).toBe('Hepatitis B');
  });

  it('does not narrow a question covering two listed topics to one', () => {
    expect(englishHealthTopic('دراسات عن السكري والربو')).toBeUndefined();
  });

  it('leaves unlisted topics and partial matches untranslated', () => {
    expect(englishHealthTopic('ما أعراض الصداع؟')).toBeUndefined();
    expect(englishHealthTopic('معلومات عن السلطنة')).toBeUndefined();
  });
});
