import { describe, expect, it } from 'vitest';
import { incidentalLabel, splitReplyDirective } from '../apps/server/src/assistant/reply-directive.js';
import { calculatorForm, composeReferencedComputation, computationReference, computedRecord, evaluateReferencedComputation, latestComputedResult,
  missingReferenceQuestion, referencedValueFromAnswer, withReferencedValue } from '../apps/server/src/assistant/computation-reference.js';
import { evaluateLocalComputation } from '../apps/server/src/assistant/local-computation.js';
import { explainedQuestion, parseHands, reasonAnswers, webQuestion } from '../apps/server/src/assistant/hands.js';
import { assessRequestScope } from '../apps/server/src/assistant/request-scope.js';
import { composeDocumentSpec, documentQuestion, documentTask } from '../apps/server/src/assistant/documents.js';

/**
 * The live functional test of 2026-11-23: a label in front of a request and a closing instruction about the reply made a
 * calculation fail and a question look private. These tests use the live wordings, then other operands, other labels and
 * both languages, and the requests that must not change.
 */
describe('a request, its label and its closing instruction about the reply', () => {
  it('splits the live calculation request into the calculation, the label and an Arabic one-sentence reply', () => {
    expect(splitReplyDirective('QA test 2026-11-23: Calculate 37 × 24 and reply with the result in one short Arabic sentence.')).toMatchObject({
      body: 'Calculate 37 × 24', label: 'QA test 2026-11-23', directive: { lang: 'ar', sentences: 1, brief: true },
    });
  });

  it('reads other labels and directives in both languages', () => {
    expect(splitReplyDirective('Case 12 — what is 7 * 6? Answer in English.')).toMatchObject({ body: 'what is 7 * 6', label: 'Case 12', directive: { lang: 'en' } });
    expect(splitReplyDirective('اختبار 4: احسب 15 × 4 وأجب بجملة إنجليزية قصيرة')).toMatchObject({ body: 'احسب 15 × 4', label: 'اختبار 4', directive: { lang: 'en', sentences: 1 } });
    expect(splitReplyDirective('احسب 12 ضرب 9 في جملة واحدة بالعربية')).toMatchObject({ body: 'احسب 12 ضرب 9', label: null, directive: { lang: 'ar', sentences: 1 } });
    expect(splitReplyDirective('Explain why rain falls in two short Arabic sentences.')).toMatchObject({ body: 'Explain why rain falls', directive: { lang: 'ar', sentences: 2 } });
    expect(splitReplyDirective('اشرح لماذا تسقط الأمطار في جملتين قصيرتين')).toMatchObject({ body: 'اشرح لماذا تسقط الأمطار', directive: { sentences: 2 } });
    expect(splitReplyDirective('Search the web for the official IANA documentation about example domains. Return the page title and source link.'))
      .toMatchObject({ body: 'Search the web for the official IANA documentation about example domains', directive: { fields: ['title', 'link'] } });
    expect(splitReplyDirective('ما عاصمة فرنسا؟ وأعطني العنوان والرابط')).toMatchObject({ body: 'ما عاصمة فرنسا', directive: { fields: ['title', 'link'] } });
  });

  it('leaves fields, topics, instructions and plain requests whole', () => {
    for (const text of ['Title: Sample Document. Body: Hello', 'Unit tests: how do I write them for React?', 'Test results: my blood test shows high iron, what does it mean?',
      'Translate: hello world', 'Budget: 40 pounds a week', 'How do I write unit tests in Python?', 'Open https://example.com/ and report the page heading and the first sentence from the live page.',
      'Calculate 37 × 24.', 'ما عاصمة اليابان؟']) {
      expect(splitReplyDirective(text), text).toMatchObject({ label: null, directive: null });
    }
    expect(incidentalLabel('Note: remember to bring milk')).toEqual({ label: 'Note', rest: 'remember to bring milk' });
    expect(incidentalLabel('What is this: a test?')).toBeNull();
  });

  it('preserves a trailing word in a multiword Arabic subject', () => {
    // Development-only. MASSIVE 1.0 ar-SA rows 13255 and 12714, joined at the annotated slot.
    const body = 'من فضلك أعطني معلومات عن مقهى بلكونة ورد';
    expect(splitReplyDirective(body)).toMatchObject({ body, label: null, directive: null });
  });
});

describe('a calculation with a label and an instruction about the reply', () => {
  it('calculates the live request and answers in one Arabic sentence', () => {
    const result = evaluateLocalComputation('QA test 2026-11-23: Calculate 37 × 24 and reply with the result in one short Arabic sentence.')!;
    expect(result).toMatchObject({ status: 'completed', lang: 'ar', text: 'ناتج 37 × 24 هو 888.' });
    // The sentence is a computed claim with its own evidence, as the chat's supervision requires.
    expect(result.claims).toEqual([{ text: 'ناتج 37 × 24 هو 888.', support: ['calculation-reply'], status: 'confirmed' }]);
    expect(result.evidence.map(item => item.quote)).toEqual(['37 * 24 = 888', 'ناتج 37 × 24 هو 888.']);
  });

  it('follows the requested language with other operands and labels', () => {
    expect(evaluateLocalComputation('Test case 7: compute 19 * 21 and answer in one short English sentence.')?.text).toBe('19 × 21 equals 399.');
    expect(evaluateLocalComputation('اختبار ٥: احسب ١٢ × ٩ وأجب بجملة إنجليزية قصيرة')).toMatchObject({ lang: 'en', text: '12 × 9 equals 108.' });
    expect(evaluateLocalComputation('Calculate 5 + 5 in Arabic')).toMatchObject({ lang: 'ar', text: 'ناتج 5 + 5 هو 10.' });
    // Without a directive the calculator's own line stays as it was.
    expect(evaluateLocalComputation('Calculate 37 × 24.')?.text).toBe('37 * 24 = 888');
  });

  it('never turns a label or an instruction into a calculation of other words', () => {
    expect(evaluateLocalComputation('QA test 2026-11-23: how do I write unit tests?')).toBeNull();
    expect(evaluateLocalComputation('Reply in one short Arabic sentence.')).toBeNull();
    expect(evaluateLocalComputation('Budget: 40 pounds a week')).toBeNull();
  });
});

describe('a calculation on an earlier result', () => {
  const previous = computedRecord(evaluateLocalComputation('Calculate 37 × 24.')!)!;
  const on = (text: string, value = previous.value) => {
    const reference = computationReference(text);
    return reference ? evaluateReferencedComputation(withReferencedValue(text, reference, value))?.text ?? null : 'no reference';
  };

  it('records the result a calculation leaves for the next turn', () => {
    expect(previous).toEqual({ expression: '37 * 24', value: '888', line: '37 * 24 = 888' });
    expect(latestComputedResult([{ trail: [{ action: 'calculate', result: '37 * 24 = 888' }] }])).toEqual(previous);
    expect(latestComputedResult([{ computed: { expression: '125 / 5', value: '25', line: '125 / 5 = 25' } }, { computed: previous }])?.value).toBe('25');
    expect(latestComputedResult([{ trail: [{ action: 'search x', result: 'results' }] }])).toBeNull();
  });

  it('writes the earlier result into the request, in English and Arabic', () => {
    expect(on('Add 12 to your previous result.')).toBe('(12) + (888) = 900');
    expect(on('Multiply it by 3')).toBe('(888) * (3) = 2664');
    expect(on('Subtract 5 from the last answer')).toBe('(888) - (5) = 883');
    expect(on('What is the previous result times 2?')).toBe('888 * 2 = 1776');
    expect(on('أضف 12 إلى النتيجة السابقة')).toBe('(12) + (888) = 900');
    expect(on('اضرب الناتج السابق في 3')).toBe('(888) * (3) = 2664');
    expect(on('اطرح 8 منها')).toBe('(888) - (8) = 880');
    expect(on('أضف 12 عليها', '60')).toBe('(12) + (60) = 72');
    expect(calculatorForm('أضف 12 إلى 888')).toBe('اجمع 12 مع 888');
  });

  it('does not take a result that is not an operand of a calculation', () => {
    expect(computationReference('What is the result of the election?')).toBeNull();
    expect(computationReference('Tell me about it')).toBeNull();
    expect(computationReference('Show me the previous result page')).toBeNull();
  });

  it('uses the existing calculator to double a referenced value in either language', () => {
    expect(on('Would you please double the previous total and report the answer?', '-2.5')).toBe('(-2.5) * 2 = -5');
    expect(on('ضاعف هذا الرقم.', '7')).toBe('(7) * 2 = 14');
    expect(on('ضاعفها!', '8')).toBe('(8) * 2 = 16');
    expect(computationReference('Double the previous value, then save it.')).toBeNull();
    expect(computationReference('Double the string thickness.')).toBeNull();
  });

  it('uses a referenced quantity without changing its stated conversion units', () => {
    const request = 'Would you convert this from miles to yards?';
    expect(computationReference(request)?.phrase).toBe('this');
    expect(on(request, '2')).toBe('2 miles = 3520 yards');
    expect(on('Convert it from seconds to kilograms.', '2')).not.toContain(' = ');
  });

  it('shows the calculation and where the earlier value came from, each line a computed claim', () => {
    const result = evaluateReferencedComputation('Add 12 to 888.')!;
    const shown = composeReferencedComputation(result, { value: '888', line: '37 * 24 = 888', from: 'conversation' });
    expect(shown.text).toBe('12 + 888 = 900\n888 is the previous result in this conversation (37 * 24 = 888).');
    expect(shown.claims.map(claim => claim.text).join('\n')).toBe(shown.text);
    expect(shown.claims.every(claim => claim.support.every(id => shown.evidence.some(item => item.id === id && item.quote === claim.text)))).toBe(true);
  });

  it('reads the number the owner gives when the conversation had none', () => {
    expect(referencedValueFromAnswer('888')).toEqual({ value: '888', line: null });
    expect(referencedValueFromAnswer('٨٨٨')).toEqual({ value: '888', line: null });
    expect(referencedValueFromAnswer('1,250.5')).toEqual({ value: '1250.5', line: null });
    expect(referencedValueFromAnswer('37 × 24')).toEqual({ value: '888', line: '37 * 24 = 888' });
    expect(referencedValueFromAnswer('hello')).toBeNull();
    const reference = computationReference('Add 12 to your previous result.')!;
    expect(missingReferenceQuestion('Add 12 to your previous result.', reference).prompt).toContain('Which result do you mean by “your previous result”?');
    expect(missingReferenceQuestion('أضف 12 إلى النتيجة السابقة', computationReference('أضف 12 إلى النتيجة السابقة')!).lang).toBe('ar');
  });
});

describe('an instruction to explain is a question about the world', () => {
  it('searches the question an instruction to explain carries, with the reply instruction kept apart', () => {
    expect(explainedQuestion('Explain why rain falls')).toBe('why rain falls');
    expect(explainedQuestion('اشرح لماذا تسقط الأمطار')).toBe('لماذا تسقط الأمطار');
    expect(webQuestion('Explain why rain falls in two short Arabic sentences.')).toEqual([{ kind: 'search', query: 'why rain falls', site: null, ask: true, reply: { lang: 'ar', sentences: 2 } }]);
    expect(webQuestion('Describe how vaccines work.')).toEqual([{ kind: 'search', query: 'how vaccines work', site: null, ask: true }]);
  });

  it('does not take a cause stated for one place or season as the cause asked about in general', () => {
    // The sentence the live check of 2026-11-23 showed for «اشرح لماذا تسقط الأمطار».
    const regional = 'نظام البحر المتوسط يوجد في غرب القارات وتسقط به الأمطار في فصل الشتاء بسبب هبوب الرياح الغربية العكسية.';
    expect(reasonAnswers('لماذا تسقط الأمطار', regional)).toBe(false);
    expect(reasonAnswers('why rain falls', 'In the tropics rain falls in summer because the monsoon winds bring moist air.')).toBe(false);
    // The English sentence the live check of 2026-11-23 showed for «Explain why rain falls».
    expect(reasonAnswers('why rain falls', 'Within Asia, rainfall is favored across its southern portion from India east into Japan due to the monsoon advecting moisture.')).toBe(false);
    expect(reasonAnswers('why rain falls', 'United States rainfall climatology Orographic precipitation occurs on the windward side and is caused by rising moist air.')).toBe(false);
    // A named body before the cause is not a place: «For the example of the Sun at zenith … the sky is blue due to …» answers.
    expect(reasonAnswers('Why is the sky blue?', 'For the example of the Sun at zenith, in broad daylight, the sky is blue due to Rayleigh scattering.')).toBe(true);
    expect(reasonAnswers('why rain falls', 'Rain falls because the droplets in a cloud grow too heavy for the rising air to hold them up.')).toBe(true);
    expect(reasonAnswers('لماذا تسقط الأمطار', 'تسقط الأمطار بسبب تكاثف بخار الماء في السحب حتى تثقل القطرات.')).toBe(true);
    // A question about that case itself is answered by it.
    expect(reasonAnswers('لماذا تسقط الأمطار في فصل الشتاء', regional)).toBe(true);
  });

  it('is a public question, while one about the owner stays private', () => {
    for (const text of ['Explain why rain falls in two short Arabic sentences.', 'Describe how vaccines work', 'اشرح لماذا تسقط الأمطار في جملتين قصيرتين', 'وضح كيف تعمل البراكين']) {
      expect(assessRequestScope(text), text).toMatchObject({ source: 'public_lookup', scope: 'public', publicQueryEligible: true });
    }
    expect(assessRequestScope('Explain why my account was blocked')).toMatchObject({ scope: 'private', publicQueryEligible: false });
    expect(assessRequestScope('Explain why it happened')).toMatchObject({ publicQueryEligible: false });
  });
});

describe('browser and search commands with a reply instruction', () => {
  it('searches what follows «search the web for», and the named fields ask for a page that was read', () => {
    expect(parseHands('Search the web for the official IANA documentation about example domains. Return the page title and source link.')).toEqual([
      { kind: 'search', query: 'the official IANA documentation about example domains', site: null, ask: true, exactQuery: true, reply: { fields: ['title', 'link'] } },
    ]);
    expect(parseHands('search the internet for solar eclipse dates')).toEqual([{ kind: 'search', query: 'solar eclipse dates', site: null }]);
    expect(parseHands('ابحث في الإنترنت عن مواعيد الكسوف')).toEqual([{ kind: 'search', query: 'مواعيد الكسوف', site: null }]);
  });

  it('opens a page and asks about it when the request says «and report …»', () => {
    expect(parseHands('Open https://example.com/ and report the page heading and the first sentence from the live page.')).toEqual([
      { kind: 'open', url: 'https://example.com/', name: 'example.com' },
      { kind: 'ask_page', question: 'the page heading and the first sentence from the live page' },
    ]);
    expect(parseHands('افتح https://example.com وانقل لي العنوان وأول جملة في الصفحة')).toEqual([
      { kind: 'open', url: 'https://example.com', name: 'example.com' },
      { kind: 'ask_page', question: 'العنوان وأول جملة في الصفحة' },
    ]);
    // «and read the page» stays a read step.
    expect(parseHands('open https://example.com and read the page')?.map(step => step.kind)).toEqual(['open', 'read']);
  });
});

describe('a PDF request that writes out its fields', () => {
  it('reads the live request as a new file: name, title, words, design, one page, English reply', () => {
    const task = documentTask('Create a downloadable one-page PDF named sample.pdf. Title: Sample Document. Body: Hello from the browser. Arabic text: مرحباً، هذا مستند تجريبي. Use a plain white background and black text. The content is complete; generate the file now and provide its download link.');
    expect(task).toEqual({ kind: 'create', lang: 'en', title: 'Sample Document', fileName: 'sample.pdf', theme: 'plain', accent: '#000000', pages: 1,
      suppliedText: 'Hello from the browser.\n\nمرحباً، هذا مستند تجريبي.' });
    const spec = composeDocumentSpec(task as Parameters<typeof composeDocumentSpec>[0]).spec;
    expect(spec).toMatchObject({ title: 'Sample Document', theme: 'plain', accent: '#000000',
      blocks: [{ kind: 'paragraph', text: 'Hello from the browser.' }, { kind: 'paragraph', text: 'مرحباً، هذا مستند تجريبي.' }] });
  });

  it('reads other phrasings in both languages as new files', () => {
    expect(documentTask('I need a PDF named notes.pdf. Title: Notes. Body: Buy milk.')).toMatchObject({ kind: 'create', title: 'Notes', fileName: 'notes.pdf', suppliedText: 'Buy milk.' });
    expect(documentTask('أريد ملف PDF باسم ملخص.pdf. العنوان: ملخص الاجتماع. النص: نوقشت الميزانية.'))
      .toMatchObject({ kind: 'create', lang: 'ar', title: 'ملخص الاجتماع', fileName: 'ملخص.pdf', suppliedText: 'نوقشت الميزانية.' });
    expect(documentTask('PDF please. Title: Visit plan. Body: Arrive at nine.')).toMatchObject({ kind: 'create', title: 'Visit plan', suppliedText: 'Arrive at nine.' });
    expect(documentTask('Create a PDF with a blue background. Title: Notes. Body: Hello.')).toMatchObject({ kind: 'create', unsupportedDesign: ['blue background'] });
  });

  it('keeps edits of existing files as edits', () => {
    expect(documentTask('Set the title of the last PDF to Annual report', { hasDocuments: true })).toMatchObject({ kind: 'edit', operation: 'metadata', title: 'Annual report' });
    expect(documentTask('Rotate the file called report.pdf')).toMatchObject({ kind: 'edit', operation: 'rotate', sources: [{ kind: 'path', path: 'report.pdf' }] });
    expect(documentTask('add a watermark "DRAFT" to the last PDF')).toMatchObject({ kind: 'edit', operation: 'watermark', text: 'DRAFT' });
  });

  it('asks only for what an incomplete request is missing; the guided card keeps its three questions', () => {
    const titled = documentTask('Create a PDF titled Weekly Notes')!;
    expect(documentQuestion(titled as Parameters<typeof documentQuestion>[0]).fields.map(field => field.id)).toEqual(['content', 'style']);
    const guided = documentTask('اصنع لي ملف PDF من نصّ أكتبه')!;
    expect(documentQuestion(guided as Parameters<typeof documentQuestion>[0]).fields.map(field => field.id)).toEqual(['title', 'content', 'style']);
  });
});
