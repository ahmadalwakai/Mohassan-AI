import { describe, expect, it } from 'vitest';
import { ChatQuestionFieldSchema } from '@mohassan/contracts';
import { composeLetter, numberedAnswers, unsupportedWriting, writingQuestion, writingTask, type WritingTask } from '../apps/server/src/assistant/writer.js';

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

  it.each([
    ['Can you write an apology letter to my clients?', 'apology', 'en'],
    ['اكتب رسالة اعتذار لعملائي', 'apology', 'ar'],
    ['Could you draft a letter for our company about a late delivery?', 'general', 'en'],
    ['ممكن تكتب لي رسالة شكر لزملائي؟', 'thanks', 'ar'],
  ])('preserves the requested writing operation for an owned subject: %s', (request, kind, lang) => {
    expect(writingTask(request)).toMatchObject({ kind, lang });
  });

  it.each([
    ['Can you translate my message into French?', 'translation', 'en'],
    ['هل يمكنك أن تترجم رسالتي إلى الإنجليزية؟', 'الترجمة', 'ar'],
    ['Would you translate into English: تم تأجيل اللقاء', 'translation', 'en'],
    ['Hello, could you rewrite this note: Please send the invoice.', 'rewriting a text', 'en'],
  ])('recognises modal transformations without pretending a template can perform them: %s', (request, unsupported, lang) => {
    expect(writingTask(request)).toEqual({ unsupported, lang });
  });

  it('distinguishes a letter about another domain from generating that domain artifact', () => {
    expect(writingTask('Write an apology email about our advertising campaign.')).toMatchObject({ kind: 'apology' });
    expect(writingTask('Write a function called sendEmail in TypeScript.')).toBeNull();
    expect(writingTask('اكتب كود لإرسال رسالة')).toBeNull();
    expect(writingTask('Write search ads for a cleaning company.')).toBeNull();
    expect(writingTask('Can you translate a Google Ads email into Arabic?')).toMatchObject({ unsupported: 'translation' });
    expect(writingTask('How do I write an apology letter?')).toBeNull();
    expect(writingTask('Remember to write the invoice tomorrow.')).toBeNull();
  });

  it('retains an explicit literal body without normalising its characters or newlines', () => {
    const body = 'مرحبًا أحمد،\n\n١. احتفظ بالرمز AX-82.\n٢. الموعد 09:30.  المسافة مهمة.';
    const task = writingTask(`اكتب رسالة بالنص «${body}»`) as WritingTask;
    expect(task).toMatchObject({ kind: 'general', lang: 'ar', suppliedText: body });
    expect(task.pendingDelivery).toBeUndefined();
    const field = writingQuestion(task).fields.find(item => item.id === 'details')!;
    expect(field).toMatchObject({ multiline: true, initialValue: body });
    expect(ChatQuestionFieldSchema.safeParse(field).success).toBe(true);
  });

  it('treats a quoted send instruction as body data, and an outer send clause as pending delivery', () => {
    const body = 'Please send the invoice to accounting.';
    const draft = writingTask(`Write an email saying "${body}"`) as WritingTask;
    expect(draft).toMatchObject({ suppliedText: body });
    expect(draft.pendingDelivery).toBeUndefined();
    const pending = writingTask(`Write an email saying "${body}" and send it to Alice.`) as WritingTask;
    expect(pending).toMatchObject({ suppliedText: body, pendingDelivery: true });
    expect(writingTask('اكتب رسالة شكر ثم أرسلها إلى الفريق')).toMatchObject({ pendingDelivery: true });
  });

  it('does not add delivery merely because a subject or body mentions sending', () => {
    expect((writingTask('Draft a note about sending invoices.') as WritingTask).pendingDelivery).toBeUndefined();
    expect((writingTask('Write an email but do not send it.') as WritingTask).pendingDelivery).toBeUndefined();
    expect((writingTask('Write an email and send it. Actually, do not send it.') as WritingTask).pendingDelivery).toBeUndefined();
    expect((writingTask('اكتب رسالة ولا ترسلها') as WritingTask).pendingDelivery).toBeUndefined();
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

  it('preserves structured multiline details, embedded numbered lines and signature exactly', () => {
    const details = 'Please follow these steps:\n1. Check stock.\n2. Pack the order.\n3. Book collection.\n4. Notify accounting.\nKeep code 1. unchanged.';
    const from = 'Mina Patel\nOperations team';
    const letter = composeLetter({ kind: 'request', lang: 'en' }, { to: 'Ms Stone', kind: 'Request', details, from });
    expect(letter).toMatchObject({ complete: true, draftComplete: true, pendingDelivery: false });
    expect(letter.text).toContain(details);
    expect(letter.text).toContain(from);
    expect(letter.text).toContain('Dear Ms Stone,');
  });

  it('uses the current literal supplied body if the details are not replaced', () => {
    const suppliedText = '  Keep this indentation.\n\nSecond line: ٢٥ units.  ';
    const letter = composeLetter({ kind: 'general', lang: 'en', suppliedText }, { to: 'The service team', kind: 'General message', details: '', from: 'Nora' });
    expect(letter.text).toContain(suppliedText);
    expect(letter.draftComplete).toBe(true);
    const replacement = 'Use this exact replacement instead.';
    expect(composeLetter({ kind: 'general', lang: 'en', suppliedText }, { to: 'The service team', kind: '', details: replacement, from: 'Nora' }).text).toContain(replacement);
  });

  it('marks requested delivery partial even when the draft is fully filled', () => {
    const task = writingTask('Write an email and send it to the client.') as WritingTask;
    const letter = composeLetter(task, { to: 'Ms Brown', kind: 'Request', details: 'Please confirm the appointment.', from: 'Sam' });
    expect(letter).toMatchObject({ draftComplete: true, pendingDelivery: true, complete: false });
    expect(letter.text).toContain('has not been sent or published');
    const arabic = composeLetter({ kind: 'thanks', lang: 'ar', pendingDelivery: true }, { to: 'فريق الدعم', kind: 'شكر', details: 'شكرًا على تعاونكم.', from: 'سارة' });
    expect(arabic.complete).toBe(false);
    expect(arabic.text).toContain('لم تُرسل ولم تُنشر');
  });

  it.each(['him', 'لها', '[recipient]', '?'])('does not claim a complete draft with an unresolved recipient: %s', to => {
    const letter = composeLetter({ kind: 'general', lang: 'en' }, { to, kind: '', details: 'Please confirm.', from: 'Sam' });
    expect(letter).toMatchObject({ complete: false, draftComplete: false });
    expect(letter.text).toContain('Dear [recipient],');
    expect(letter.text).toContain('Specify the recipient');
  });
});
