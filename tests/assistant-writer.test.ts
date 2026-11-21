import { describe, expect, it } from 'vitest';
import { ChatQuestionFieldSchema } from '@mohassan/contracts';
import { composeLetter, numberedAnswers, unsupportedWriting, writingQuestion, writingTask } from '../apps/server/src/assistant/writer.js';

describe('writingTask', () => {
  it('takes letters and emails in Arabic and English, with their kind', () => {
    expect(writingTask('اكتب رسالة بريد احترافية')).toEqual({ kind: 'general', lang: 'ar' });
    expect(writingTask('اكتب لي رسالة اعتذار لعميل')).toEqual({ kind: 'apology', lang: 'ar' });
    expect(writingTask('اكتب رسالة شكر لفريق العمل')).toEqual({ kind: 'thanks', lang: 'ar' });
    expect(writingTask('Draft an email to my landlord about the heating')).toEqual({ kind: 'general', lang: 'en' });
  });

  it('answers plainly for writing a frame cannot do', () => {
    expect(writingTask('ترجم hello للعربي')).toEqual({ unsupported: 'الترجمة', lang: 'ar' });
    expect(writingTask('صحح الأخطاء الإملائية في رسالتي')).toMatchObject({ unsupported: 'تحسين نص أو إعادة صياغته' });
    expect(writingTask('Write a poem about the sea')).toEqual({ unsupported: 'poems', lang: 'en' });
    expect(unsupportedWriting({ unsupported: 'الترجمة', lang: 'ar' })).toContain('لا يملك نموذج كتابة');
  });

  it('leaves Ads, search and other requests alone', () => {
    expect(writingTask('اكتب مسودة لحملة بحث Google Ads')).toBeNull();
    expect(writingTask('كم سعر الذهب اليوم')).toBeNull();
    expect(writingTask('افتح يوتيوب')).toBeNull();
  });
});

describe('letter card and frame', () => {
  it('asks four valid questions with the guessed kind chosen in advance', () => {
    const card = writingQuestion({ kind: 'apology', lang: 'ar' });
    expect(card.fields.map(field => field.id)).toEqual(['to', 'kind', 'details', 'from']);
    for (const field of card.fields) expect(ChatQuestionFieldSchema.safeParse(field).success).toBe(true);
    expect(card.fields[1].suggestions[0].label).toBe('اعتذار');
    expect(card.fields[1].selected).toEqual([0]);
  });

  it('reads the numbered reply on separate lines or on one line', () => {
    expect(numberedAnswers('1. خالد\n2. شكر\n3. على التعاون\n4. موحسن', 4)).toEqual(['خالد', 'شكر', 'على التعاون', 'موحسن']);
    expect(numberedAnswers('1. Ms Brown 2. Request 3. two days off next week 4. Sam', 4)).toEqual(['Ms Brown', 'Request', 'two days off next week', 'Sam']);
  });

  it('keeps the owner\'s words exactly and frames them by the chosen kind', () => {
    const details = 'تأخر التسليم يومين بسبب الشحن، وسيصل الطلب يوم الأحد';
    const letter = composeLetter({ kind: 'general', lang: 'ar' }, `1. الأستاذ خالد\n2. اعتذار\n3. ${details}\n4. موحسن`);
    expect(letter.complete).toBe(true);
    expect(letter.text).toContain('**الموضوع:** اعتذار');
    expect(letter.text).toContain('الأستاذ خالد المحترم،');
    expect(letter.text).toContain(details);
    expect(letter.text).toContain('لم يكتبها نموذج');
    const english = composeLetter({ kind: 'general', lang: 'en' }, '1. Ms Brown 2. Request 3. two days off next week 4. Sam');
    expect(english.text).toContain('Dear Ms Brown,');
    expect(english.text).toContain('**Subject:** Request');
  });

  it('marks a letter with missing answers as partial and shows the gaps', () => {
    const letter = composeLetter({ kind: 'thanks', lang: 'ar' }, '2. شكر');
    expect(letter.complete).toBe(false);
    expect(letter.text).toContain('[اكتب التفاصيل هنا]');
  });
});
