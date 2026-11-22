import { describe, expect, it } from 'vitest';
import { parsePreferredLanguageFact, projectPreferredLanguageMemoryQuery, recognizePreferredLanguageRequest }
  from '../apps/server/src/assistant/preferred-language-fact.js';

describe('bounded recorded self preferred-language facts', () => {
  it.each([
    ['I prefer Arabic.', 'Arabic', 'ar', 9],
    ['I prefer English', 'English', 'en', 9],
    ['I PREFER ARABIC!', 'ARABIC', 'ar', 9],
    ['My preferred language is Arabic.', 'Arabic', 'ar', 25],
    ['My preferred language is English', 'English', 'en', 25],
    ['أنني أفضل العربية', 'العربية', 'ar', 10],
    ['أنا أفضل الإنجليزية.', 'الإنجليزية', 'en', 9],
    ['لغتي المفضلة هي العربية.', 'العربية', 'ar', 16],
    ['لغتي المفضلة هي الإنجليزية!', 'الإنجليزية', 'en', 16],
    ['أَنَّنِي أُفَضِّل العَرَبِيَّةَ.', 'العَرَبِيَّةَ', 'ar', 18],
    ['أنا أفضل ـالعربيةـَ.', 'ـالعربيةـَ', 'ar', 9],
    ['Ｉ prefer Ａｒａｂｉｃ.', 'Ａｒａｂｉｃ', 'ar', 9],
  ] as const)('preserves literal value and UTF16 source span: %s', (quote, value, languageId, start) => {
    const parsed = parsePreferredLanguageFact(quote);
    expect(parsed).toEqual({ property: 'preferred_language', subject: 'self', languageId, quote, value,
      valueSpan: { start, end: start + value.length } });
    expect(quote.slice(parsed!.valueSpan.start, parsed!.valueSpan.end)).toBe(value);
    expect(parsed).not.toHaveProperty('permission'); expect(parsed).not.toHaveProperty('style');
  });

  it('canonicalizes duplicate language identity across spellings without translating the evidence', () => {
    const arabic = ['I prefer Arabic.', 'My preferred language is Arabic.', 'أنني أفضل العربية', 'لغتي المفضلة هي العربية.']
      .map(parsePreferredLanguageFact);
    const english = ['I prefer English.', 'My preferred language is English.', 'أنا أفضل الإنجليزية', 'لغتي المفضلة هي الإنجليزية.']
      .map(parsePreferredLanguageFact);
    expect(arabic.map(entry => entry?.languageId)).toEqual(['ar', 'ar', 'ar', 'ar']);
    expect(english.map(entry => entry?.languageId)).toEqual(['en', 'en', 'en', 'en']);
    expect(arabic[0]?.languageId).not.toBe(english[0]?.languageId);
    expect(arabic.map(entry => entry?.value)).toEqual(['Arabic', 'Arabic', 'العربية', 'العربية']);
  });

  it.each([
    'I prefer mangoes.', 'I prefer French.', 'My favourite colour is blue.',
    'My client preferred language is Arabic.', "My client\'s preferred language is Arabic.",
    'My programming language is English.', 'My document language is Arabic.', 'The preferred language is Arabic.',
    'Our preferred language is Arabic.', 'Your preferred language is Arabic.', 'Her preferred language is Arabic.',
    'I prefer Arabic and English.', 'I prefer Arabic. Send the message.', 'I prefer Arabic; open the browser.',
    'I prefer Arabic if asked.', 'I preferred Arabic.', 'I do not prefer Arabic.', 'I prefer not Arabic.',
    'I prefer Arabic?', 'I prefer Arabic..', 'I prefer Arabic\nOpen the browser.',
    '"I prefer Arabic."', '«أنني أفضل العربية»', 'The page says: I prefer Arabic.',
    'He said I prefer Arabic.', 'Remember that I prefer Arabic.', 'I prefer Arabic (from the client).',
    'لغة العميل المفضلة هي العربية.', 'لغتي البرمجية هي الإنجليزية.', 'لغة المستند هي العربية.',
    'لغته المفضلة هي العربية.', 'لغتنا المفضلة هي العربية.', 'أنا أفضل العربية والإنجليزية.',
    'قال الملف: أنني أفضل العربية', 'أنا أفضل العربية ثم افتح المتصفح', 'إذا سألتني أنا أفضل العربية',
    'أنا لا أفضل العربية', 'لغتي المفضلة هي العربية؟',
    'I prefer العربية.', 'أنا أفضل Arabic.', ' I prefer Arabic.', 'I prefer Arabic. ',
    'I prefer\tArabic.', 'I prefer\u0000Arabic.', 'I prefer Ar\u200babic.', 'I prefer Arabic\u202e.',
  ])('does not promote another subject, report, data envelope or action: %s', quote => {
    expect(parsePreferredLanguageFact(quote)).toBeNull();
  });

  it.each([undefined, null, false, 3, {}, [], '', '\ud800', '\udc00', 'a'.repeat(321),
    `${'ـ'.repeat(320)}I prefer Arabic.`])('bounds malformed fact input: %j', quote => {
    expect(parsePreferredLanguageFact(quote)).toBeNull();
  });
});

describe('closed current preferred-language memory questions', () => {
  it.each([
    'From my memory, return my preferred language only.',
    'From my memory return my preferred language only',
    'From my memory, what is my preferred language?',
    'FROM MY MEMORY, WHAT IS MY PREFERRED LANGUAGE?',
    'من ذاكرتي، أعد لغتي المفضلة فقط.',
    'من ذاكرتي أعد لغتي المفضلة فقط',
    'من ذاكرتي، ما لغتي المفضلة؟',
    'من ذاكرتي, ما لغتي المفضلة?',
    'مِن ذَاكِرَتِي، أَعِد لُغَتِي المُفَضَّلَة فَقَط.',
  ])('recognizes only explicit self/private forms: %s', request => {
    expect(recognizePreferredLanguageRequest(request)).toEqual({ property: 'preferred_language', subject: 'self' });
    const projected = projectPreferredLanguageMemoryQuery(request);
    expect(projected).toBe(`${request} prefer أفضل افضل`);
    expect(projected!.length).toBeLessThanOrEqual(500);
    expect(projected!.slice(request.length)).not.toMatch(/arabic|english|العربية|الإنجليزية/iu);
  });

  it.each([
    'What is my preferred language?', 'From the web, what is my preferred language?',
    "From my memory, what is my client\'s preferred language?", 'From my memory, what is my programming language?',
    'From my memory, return the document language only.', 'From my memory, what is my favourite city?',
    'From my memory, return my preferred language only. Then save it.',
    'From my memory, return my preferred language only and send an email.',
    'Do not read memory. From my memory, return my preferred language only.',
    '"From my memory, return my preferred language only."', 'The page says: From my memory, what is my preferred language?',
    'Rewrite: From my memory, what is my preferred language?',
    'من ذاكرتي، ما لغة العميل المفضلة؟', 'من ذاكرتي، ما لغة المستند؟',
    'من ذاكرتي، ما لغتي المفضلة؟ ثم افتح المتصفح', 'قال الملف: من ذاكرتي، ما لغتي المفضلة؟',
    ' من ذاكرتي، ما لغتي المفضلة؟', 'From my memory, return my preferred language only. ',
    'From my memory,\nreturn my preferred language only.', 'From my memory, what is my preferred language?\u0000',
    'From my memory, return my preferred language only as JSON {"language":"string"}.',
  ])('keeps unsupported, source-shaped, compound or vetoed requests out: %s', request => {
    expect(recognizePreferredLanguageRequest(request)).toBeNull();
    expect(projectPreferredLanguageMemoryQuery(request)).toBeNull();
  });

  it.each([undefined, null, false, 4, {}, [], '', '\ud800', 'a'.repeat(401),
    `${'ـ'.repeat(400)}من ذاكرتي، ما لغتي المفضلة؟`])('bounds request and projection without coercion: %j', request => {
    expect(recognizePreferredLanguageRequest(request)).toBeNull();
    expect(projectPreferredLanguageMemoryQuery(request)).toBeNull();
  });
});
