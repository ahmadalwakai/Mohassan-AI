import { describe, expect, it } from 'vitest';
import { classifyQuestion, extractAnswerType, type AnswerType, type AnswerTypeCandidate } from '../apps/server/src/assistant/selection/answer-types.js';

const extract = (question: string, text: string, context: Omit<AnswerTypeCandidate, 'text'> = {}) =>
  extractAnswerType(classifyQuestion(question), { text, ...context });

describe('answer types for the page ranker', () => {
  it.each<[string, string, AnswerType]>([
    ['Who invented the telephone?', 'من اخترع الهاتف؟', 'person'],
    ['Which organization runs the observatory?', 'ما الجهة التي تدير المرصد؟', 'organization'],
    ['Where was Ada Lovelace born?', 'أين ولدت آدا لوفلايس؟', 'place'],
    ['When did Algeria become independent?', 'متى استقلت الجزائر؟', 'date'],
    ['How old is Messi?', 'كم عمر ميسي؟', 'quantity'],
    ['Explain why the sky is blue.', 'اشرح لماذا السماء زرقاء؟', 'reason'],
    ['How does a barometer work?', 'كيف يعمل مقياس الضغط؟', 'method'],
    ['What is a barometer?', 'ما المقصود بالبارومتر؟', 'definition'],
    ['Which is longer, the Nile or the Rhine?', 'أيهما أطول النيل أم الراين؟', 'comparison'],
    ['Which river is definitively longer, the Amazon or the Nile?', 'أيهما أعمق، خندق ماريانا أم بحيرة بايكال؟', 'comparison'],
    ['The Nile is wide', 'نهر النيل واسع', 'unknown'],
  ])('classifies %s and %s as %s', (en, ar, type) => {
    expect(classifyQuestion(en)).toMatchObject({ type, language: 'en' });
    expect(classifyQuestion(ar)).toMatchObject({ type, language: 'ar' });
  });

  it('looks for the requested person role before treating a name as evidence', () => {
    const question = 'Who invented the telephone?';
    expect(extract(question, 'The telephone was invented by Alexander Graham Bell.')).toEqual({ value: 'Alexander Graham Bell', strength: 3, cue: 'person-role' });
    expect(extract(question, 'Charles Bourseul and Alexander Graham Bell have both been credited with the invention of the telephone.')).toMatchObject({ cue: 'credited-people' });
    expect(extract(question, 'John Taylor was a captain in 1844.')).toBeNull();
    expect(extract(question, 'The First Telephone was invented in 1876.')).toBeNull();
    expect(extract('من كتب البؤساء؟', 'المؤلف | فيكتور هوغو', { kind: 'table', cells: ['المؤلف', 'فيكتور هوغو'] })).toMatchObject({ value: 'فيكتور هوغو', cue: 'person-field' });
    expect(extract('من اخترع الهاتف؟', 'اخترع ألكسندر غراهام بيل الهاتف.')).toMatchObject({ cue: 'person-role' });
    expect(extract('من أنشأ برج إيفل؟', 'أنشأ برج إيفل ليكون جديد معرض باريس 1889.')).toBeNull();
    expect(extract('من أنشأ برج إيفل؟', 'أنشئ من طرف غوستاف إيفل ومعاونيه.')).toMatchObject({ cue: 'person-role' });
    expect(extract('Who is Ada Lovelace?', 'Ada Lovelace', { kind: 'title' })).toMatchObject({ strength: 1, cue: 'person-title' });
  });

  it('requires the organization to fill the requested role', () => {
    const question = 'Which organization runs the space telescope?';
    expect(extract(question, 'The space telescope was funded by the International Science Foundation and operates near Earth.')).toBeNull();
    expect(extract(question, 'The space telescope is operated by NASA.')).toMatchObject({ cue: 'organization-role' });
    expect(extract(question, 'Operator | NASA', { kind: 'table', cells: ['Operator', 'NASA'] })).toMatchObject({ value: 'NASA' });
    expect(extract('ما الجهة التي تدير المرصد؟', 'تشرف على المرصد مؤسسة العلوم الوطنية.')).toMatchObject({ cue: 'organization-role' });
    expect(classifyQuestion('ما جامعة الدول العربية؟')).toMatchObject({ type: 'definition' });
    expect(extract('ما جامعة الدول العربية؟', 'جامعة الدول العربيةالعلم | جامعة الدول العربيةالشعار', { kind: 'table' })).toBeNull();
  });

  it('finds a location or a date for the event named in the question', () => {
    expect(extract('Where was Ada Lovelace born?', 'Ada Lovelace was born in London.')).toMatchObject({ cue: 'location-predicate' });
    expect(extract('Where was Ada Lovelace born?', 'Ada Lovelace died in Marylebone.')).toBeNull();
    expect(extract('In what region of the world is Japan?', 'Japan is an island country in East Asia.')).toMatchObject({ cue: 'location-predicate' });
    expect(extract('ما عاصمة لبنان؟', 'بيروت هي عاصمة لبنان.')).toMatchObject({ cue: 'location-predicate' });
    expect(extract('متى استقلت الجزائر؟', 'تحقق استقلالها في ٥ يوليو ١٩٦٢.')).toMatchObject({ cue: 'date-mention' });
    expect(extract('متى استقلت الجزائر؟', 'وُلد المؤرخ في الجزائر عام 1930.')).toBeNull();
    expect(extract('When was Ada Lovelace born?', 'Born | 10 December 1815', { kind: 'table' })).toMatchObject({ value: '10 December 1815', cue: 'date-field' });
    expect(extract('Where was Ibn Khaldun born?', 'Ibn Khaldun was born in Tunis.')).toMatchObject({ cue: 'location-predicate' });
    expect(extract('أين ولد ابن خلدون؟', 'وُلد ابن خلدون في تونس.')).toMatchObject({ cue: 'location-predicate' });
    expect(extract('When did the Berlin Wall fall?', 'The fall of the Berlin Wall paved the way for German reunification, which formally took place on 3 October 1990.')).toBeNull();
    expect(extract('When did the Berlin Wall fall?', 'The Berlin Wall fell on 9 November 1989.')).toMatchObject({ cue: 'date-mention' });
  });

  it('distinguishes current age and observed quantities from incidental or forecast numbers', () => {
    const age = 'How old is Lionel Messi?';
    const date = 'Date of birth | 24 June 1987 (age 39)';
    expect(extract(age, date, { kind: 'table' })).toMatchObject({ value: date, cue: 'age-mention' });
    expect(extract('كم عمر ميسي؟', 'الميلاد | 24 يونيو 1987 (العمر 39 سنة)', { kind: 'table' })).toMatchObject({ cue: 'age-mention' });
    expect(extract(age, 'Lionel Messi joined Barcelona at the age of 13.')).toBeNull();
    expect(extract('How old was Lionel Messi when he joined Barcelona?', 'Lionel Messi joined Barcelona at the age of 13.')).toMatchObject({ cue: 'age-mention' });
    const population = 'What is the population of France?';
    expect(extract(population, 'France has a population of 68 million people.')).toMatchObject({ cue: 'quantity-with-cue' });
    expect(extract(population, 'France’s population is projected to reach 75 million people in 2050.')).toBeNull();
    expect(extract('How tall is the Eiffel Tower?', 'The Eiffel Tower was built in 1889.')).toBeNull();
    expect(extract('كم يبلغ ارتفاع برج إيفل؟', 'يبلغ ارتفاع برج إيفل ٣٣٠ مترا.')).toMatchObject({ cue: 'quantity-with-cue' });
    expect(extract('How long is the Amazon River?', 'Length | 6,575 km', { kind: 'table' })).toMatchObject({ value: '6,575 km', cue: 'quantity-field' });
    expect(extract('How long did the meeting last?', 'The meeting lasted 45 minutes.')).toMatchObject({ cue: 'quantity-with-cue' });
  });

  it('finds causes in prose and lists while skipping prompts and purpose clauses', () => {
    expect(extract('Why do earthquakes occur?', 'Earthquakes occur because tectonic plates shift.')).toMatchObject({ cue: 'causal-connective' });
    expect(extract('لماذا تحدث الزلازل؟', 'تحدث الزلازل بسبب حركة الصفائح الأرضية.')).toMatchObject({ cue: 'causal-connective' });
    expect(extract('لماذا تحدث الزلازل؟', 'تحدث الزلازل لأن الصفائح تتحرك فجأة.')).toMatchObject({ cue: 'causal-connective' });
    expect(extract('لماذا تحدث الزلازل؟', 'تحدث الزلازل بسبب عوامل عدة، أهمها:')).toBeNull();
    expect(extract('لماذا يتشكل البرق الموجب؟', 'تميل البروق الموجبة لأن تتشكل في العواصف.')).toBeNull();
    expect(extract('Why do earthquakes occur?', 'Movement of tectonic plates', { kind: 'list', heading: 'Causes of earthquakes' })).toMatchObject({ cue: 'cause-field' });
    expect(extract('Why is Cairo called the city of a thousand minarets?', 'Cairo is titled "the city of a thousand minarets" for its preponderance of Islamic architecture.')).toMatchObject({ cue: 'explicit-reason' });
  });

  it('uses prose, steps, and leads to recognize methods and definitions', () => {
    expect(extract('How does a barometer work?', 'A barometer measures air pressure by tracking the height of a mercury column.')).toMatchObject({ cue: 'method-connective' });
    expect(extract('كيف يعمل المولد؟', 'ينتج المولد الكهرباء عن طريق تدوير مغناطيس قرب ملف.')).toMatchObject({ cue: 'method-connective' });
    expect(extract('How do I replace the filter?', 'Turn off the water supply.', { kind: 'list', heading: 'Steps' })).toMatchObject({ cue: 'method-step' });
    expect(extract('How does a barometer work?', 'The barometer was invented by Evangelista Torricelli.')).toBeNull();
    expect(extract('كيف يحدث كسوف الشمس؟', 'يحدث كسوف الشمس عندما يمر القمر أمام الشمس.')).toMatchObject({ cue: 'method-mechanism' });
    expect(extract('What is a barometer?', 'A barometer is an instrument that measures atmospheric pressure.', { kind: 'lead' })).toMatchObject({ strength: 3, cue: 'defining-predicate' });
    expect(extract('ما البارومتر؟', 'البارومتر هو جهاز لقياس الضغط الجوي.', { kind: 'lead' })).toMatchObject({ strength: 3, cue: 'defining-predicate' });
  });

  it('recognizes a directional comparison instead of a bare threshold', () => {
    const question = 'Which is larger, Africa or Asia?';
    expect(extract(question, 'Asia is larger than Africa.')).toMatchObject({ cue: 'directional-comparison' });
    expect(extract(question, "Africa is the world's second-largest and second-most populous continent after Asia.")).toMatchObject({ cue: 'directional-comparison' });
    expect(extract(question, 'Africa has more than 50 countries.')).toBeNull();
    expect(extract('أيهما أكبر مساحة اليابان أم بريطانيا؟', 'تزيد مساحتها عن مساحة بريطانيا بمقدار مرة ونصف.')).toMatchObject({ cue: 'directional-comparison' });
    expect(extract('Compare Japan and Britain.', 'Japan measures 378,000 square kilometres, whereas Britain measures 243,000.')).toMatchObject({ cue: 'paired-contrast' });
  });
});
