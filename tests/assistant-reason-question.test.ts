import { describe, expect, it } from 'vitest';
import { aspectKind, checkAnswerLine, isMetaLine, isReasonQuestion, statesReason } from '../apps/server/src/assistant/answer-check.js';
import { fold, reasonAnswers, reasonSubject } from '../apps/server/src/assistant/hands.js';
import { assessRequestScope } from '../apps/server/src/assistant/request-scope.js';
import { superlativeEvidence } from '../apps/server/src/assistant/source-superlative.js';

// «لماذا السماء زرقاء؟» was refused before any search until 2026-11-23: the Arabic question words of request-scope.ts had no
// «لماذا». Searched as it was, it quoted whatever shared its words (artifacts/agent-gaps-2026-11-22/after-cycle-fixes/
// why-probe-after.json), so a reason is now quoted only from a sentence that states the cause of what was asked.
describe('an Arabic why-question is a public question', () => {
  it.each(['لماذا السماء زرقاء؟', 'لماذا يتغير لون أوراق الشجر في الخريف؟', 'ليش السماء زرقاء؟', 'ليه البحر مالح', 'لماذا تهاجر الطيور'])('%s', request => {
    expect(assessRequestScope(request)).toMatchObject({ source: 'public_lookup', operation: 'lookup', scope: 'public', publicQueryEligible: true });
  });

  it('leaves a bare why, a pointing why and a supplied text as they were', () => {
    expect(assessRequestScope('لماذا؟')).toMatchObject({ source: 'unresolved', publicQueryEligible: false, reasons: ['missing_target'] });
    expect(assessRequestScope('لماذا')).toMatchObject({ source: 'unresolved', publicQueryEligible: false });
    expect(assessRequestScope('لماذا فعلت ذلك')).toMatchObject({ source: 'unresolved', reasons: ['unresolved_reference'] });
    expect(assessRequestScope('ترجم: لماذا السماء زرقاء؟')).toMatchObject({ source: 'supplied_content', operation: 'transform' });
    expect(assessRequestScope('لا تبحث في الويب. لماذا السماء زرقاء؟').publicQueryEligible).toBe(false);
  });

  it('does not read the particle «لم» as a why', () => {
    // A statement, as before: whatever it is taken for, it is not a question about a reason.
    expect(isReasonQuestion('لم أجد الملف')).toBe(false);
  });
});

describe('a question that asks for a reason', () => {
  it.each(['لماذا السماء زرقاء؟', 'ليش السماء زرقاء؟', 'ليه القمر بيتغير شكله؟', 'ما سبب زرقة السماء؟', 'ما هو سبب تسمية القاهرة بهذا الاسم؟', 'ما أسباب الحرب العالمية الأولى؟',
    'Why is the sky blue?', 'Why did the Roman Empire fall?', 'What causes earthquakes?', 'What is the reason for the fall of Rome?'])('%s', question => {
    expect(isReasonQuestion(question)).toBe(true);
    expect(aspectKind(question)).toBe('causes');
  });

  it.each(['ما عاصمة فرنسا؟', 'كم عدد سكان مصر؟', 'ما أعراض المياه البيضاء؟', 'What is photosynthesis?', 'لماذا؟', 'كيف تتكون الغيوم؟'])('not %s', question => {
    expect(isReasonQuestion(question)).toBe(false);
  });

  it('names the thing the reason is asked about', () => {
    expect(reasonSubject('لماذا السماء زرقاء؟')).toBe('السماء');
    expect(reasonSubject('لماذا تهاجر الطيور؟')).toBe('الطيور');
    expect(reasonSubject('لماذا البحر الميت مالح جدا؟')).toBe('البحر الميت');
    expect(reasonSubject('ما سبب زرقة السماء؟')).toBe('السماء');
    expect(reasonSubject('ما هو سبب تسمية القاهرة بهذا الاسم؟')).toBe('القاهرة');
    expect(reasonSubject('ما أسباب الحرب العالمية الأولى؟')).toBe('الحرب العالمية الأولى');
    expect(reasonSubject('Why is the sky blue?')).toBe('sky');
    expect(reasonSubject('Why do birds migrate?')).toBe('birds');
    expect(reasonSubject('Why did the Roman Empire fall?')).toBe('Roman Empire');
    expect(reasonSubject('What is the reason for the fall of Rome?')).toBe('Rome');
    expect(reasonSubject('ما عاصمة فرنسا؟')).toBe('');
  });
});

describe('a sentence that states the cause of what was asked', () => {
  it.each([
    ['لماذا السماء زرقاء؟', 'تبدو السماء زرقاء بسبب تبعثر ضوء الشمس في الغلاف الجوي.'],
    ['لماذا تكون السماء زرقاء؟', 'تشتت جزيئات الهواء ضوء الشمس الأزرق أكثر من الأحمر، ولذلك تبدو السماء زرقاء.'],
    ['لماذا السماء زرقاء؟', 'السماء جميلة في النهار، وتبدو زرقاء بسبب تبعثر الضوء.'],
    ['ما سبب زرقة السماء؟', 'إن سبب زرقة السماء هو تبعثر الضوء القادم من الشمس.'],
    ['لماذا سميت القاهرة بهذا الاسم؟', 'سُميت القاهرة بهذا الاسم نسبةً إلى النجم القاهر.'],
    ['لماذا سميت القاهرة بهذا الاسم؟', 'وسُميت بهذا الاسم نسبةً إلى النجم القاهر الذي ظهر وقت بنائها.'],
    ['لماذا انقرضت الديناصورات؟', 'انقرضت الديناصورات غير الطيرية قبل 66 مليون سنة نتيجةً لاصطدام كويكب بالأرض.'],
    ['لماذا تحدث الزلازل؟', 'تحدث الزلازل بسبب عوامل عدة، أهمها: الانفجار البركاني الذي يرافقه زلزال.'],
    ['ما أسباب الحرب العالمية الأولى؟', 'من أسباب الحرب العالمية الأولى اغتيال ولي عهد النمسا.'],
    ['Why is the sky blue?', 'The sky appears blue because air molecules scatter blue light more than red.'],
    ['Why is the sky blue?', 'Air molecules scatter blue light more strongly than red light, which is why the sky looks blue.'],
    ['Why is the sky blue?', 'For the example of the Sun at zenith, in broad daylight, the sky is blue due to Rayleigh scattering.'],
    ['Why did the Roman Empire fall?', 'The main reason the Roman Empire fell was pressure on its borders.'],
    ['What causes earthquakes?', 'Earthquakes result from a sudden release of energy in the lithosphere.'],
  ])('%s ← %s', (question, line) => {
    expect(reasonAnswers(question, line)).toBe(true);
    expect(checkAnswerLine(question, line).ok).toBe(true);
  });

  it('reads the explanation from a page about the cause when that sentence names both cause and effect', () => {
    const line = 'يتسبب تبعثر رايلي لضوء الشمس في الغلاف الجوي ظاهرة النشر الإشعاعي للسماء، وهو السبب الرئيسي للون الأزرق للسماء واللون المصفر للشمس.';
    expect(reasonAnswers('لماذا تكون السماء زرقاء؟', line, false)).toBe(true);
  });

  // Every line below was shown as the answer to its question in the live runs of 2026-11-23, before the rule or between its versions.
  it.each([
    ['Why is the sky blue?', 'In addition, the Argentina national football team is known as the albicelestes due to the sky blue and white of its shirt.'],
    ['Why is the sky blue?', 'Color "Sky Blue" redirects here.'],
    ['Why is the sky blue?', 'The reason the sky is blue is often discussed in science classrooms.'],
    ['Why is the sky blue?', 'The sky is blue because scientists are still studying why.'],
    ['Why is the sky blue?', 'The sky is not blue because of Rayleigh scattering.'],
    ['ليش السماء زرقاء؟', 'السماء الزرقاء (الإنجليزية: Blue Sky) هو فيلم دراما تم إنتاجه في الولايات المتحدة.'],
    ['لماذا تكون السماء زرقاء؟', 'تكون السماء مظلمة بسبب غياب ضوء الشمس.'],
    ['لماذا تكون السماء زرقاء؟', 'إن سبب ظهور السماء بألوان مختلفة ليس سوى انعكاس وانكسار الضوء القادم من الشمس.'],
    ['لماذا نرى البرق قبل أن نسمع الرعد؟', 'تميل البروق الموجبة لأن تتشكّل بشكلٍ أكبر في العواصف الثلجية، كما هو الحال في العواصف.'],
    ['ليه القمر بيتغير شكله؟', 'مع ملاحظة أن المسافة المدارية الحالية للقمر، والتي تقدر بثلاثين مرة قدر قطر الأرض، نتيجة لقوى المد.'],
    ['لماذا سميت القاهرة بهذا الاسم؟', 'حافة الفول سُميت بهذا الاسم نسبةً إلى زهرة عطرية، قد تكون الياسمين العربي.'],
    ['لماذا انقرضت الديناصورات؟', 'كان العلماء يعتقدون أن الديناصورات ساهمت في تسريع وتيرة انقراض الحيوانات الأخرى بسبب افتراسها.'],
    ['لماذا تدور الأرض حول الشمس؟', 'تُقَدّر مدة دوران الأرض حول محورها بالنسبة للشمس بنحو 24 ساعة.'],
  ])('not %s ← %s', (question, line) => {
    expect(reasonAnswers(question, line)).toBe(false);
  });

  it('does not take «لأن» before a verb, «بالنسبة لـ» or a match score for a cause', () => {
    expect(statesReason('تميل البروق الموجبة لأن تتشكّل بشكلٍ أكبر في العواصف الثلجية.')).toBe(false);
    expect(statesReason('تُقَدّر مدة دوران الأرض حول محورها بالنسبة للشمس.')).toBe(false);
    expect(statesReason('نتيجة المباراة كانت 2-1.')).toBe(false);
    expect(statesReason('يعود تاريخ المدينة إلى القرن العاشر.')).toBe(false);
    expect(statesReason('وذلك لأن الضوء أسرع من الصوت.')).toBe(true);
    expect(statesReason('يعود ذلك إلى ميلان محور الأرض.')).toBe(true);
  });

  it('fails a sentence with no cause as the answer line of a why-question', () => {
    expect(checkAnswerLine('ليش السماء زرقاء؟', 'السماء الزرقاء (الإنجليزية: Blue Sky) هو فيلم دراما تم إنتاجه في الولايات المتحدة.')).toEqual({ ok: false, reasons: ['needs_aspect'] });
  });

  it('takes a hatnote for a line about the page', () => {
    // Led the answer to «ما أسباب الحرب العالمية الثانية؟» (live 2026-11-23).
    expect(isMetaLine('المقالات الرئيسة: أسباب الحرب العالمية الثانية و العلاقات الدولية (1919-1939)')).toBe(true);
    expect(isMetaLine('المقالة الرئيسية: تاريخ مصر')).toBe(true);
    expect(isMetaLine('Main article: Causes of World War II')).toBe(true);
    expect(isMetaLine('من أسباب الحرب العالمية الأولى اغتيال ولي عهد النمسا.')).toBe(false);
  });
});

describe('a sentence that states the requested extreme', () => {
  it.each([
    ['ما هي أكبر دولة عربية من حيث المساحة؟', 'الجزائر أكبر دولة عربية مساحةً.'],
    ['ما أكبر الدول العربية مساحةً؟', 'الجزائر هي أكبر بلد في العالم العربي من حيث المساحة.'],
    ['ما هو أطول نهر في العالم؟', 'نهر النيل أطول أنهار العالم.'],
    ['Which country is largest in the world by area?', "Russia is the world's largest country by area."],
    ['Which mountain is the highest in Africa?', "Kilimanjaro is Africa's highest mountain."],
  ])('%s ← %s', (question, line) => {
    expect(superlativeEvidence(fold(question))?.(fold(line))).toBe(true);
  });

  it.each([
    ['ما هي أكبر دولة عربية من حيث المساحة؟', 'مصر هي أكبر دولة عربية من حيث عدد السكان، وتبلغ مساحتها نحو مليون كيلومتر مربع.'],
    ['ما هي أكبر دولة عربية من حيث المساحة؟', 'ليست مصر أكبر دولة عربية من حيث المساحة.'],
    ['ما هي أكبر دولة عربية من حيث المساحة؟', 'بمساحة تبلغ 1 000 000 كيلومتر مربع، مصر هي ثالث أكبر بلد في العالم، والثالثة عربياً.'],
    ['ما هي أكبر دولة عربية من حيث المساحة؟', 'بعدد سكان يبلغ 110 ملايين نسمة، مصر هي عاشر أكبر بلد في العالم، والأولى عربياً.'],
    ['What is the largest country in the world by area?', 'This does not show which is the largest country in the world by area.'],
    ['What is the highest mountain in the world?', 'The highest mountain in the world is unknown.'],
  ])('not %s ← %s', (question, line) => {
    expect(superlativeEvidence(fold(question))?.(fold(line))).toBe(false);
  });
});
