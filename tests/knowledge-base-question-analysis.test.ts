import { describe, expect, it } from 'vitest';
import { KNOWLEDGE_PROPERTIES, mapKnowledgeProperty } from '../packages/knowledge-base/src/qa-properties.ts';
import { analyzeKnowledgeQuestion, knowledgeQuestionLanguage } from '../packages/knowledge-base/src/question-analysis.ts';

describe('knowledge property mapping', () => {
  it('recognizes the documented labels and aliases in both languages', () => {
    for (const { property, aliases } of Object.values(KNOWLEDGE_PROPERTIES)) {
      for (const language of ['ar', 'en'] as const) {
        for (const phrase of aliases[language]) expect(mapKnowledgeProperty(phrase, language)).toEqual(property);
      }
    }
    expect(mapKnowledgeProperty('عَاصِمَة', 'ar')?.id).toBe('P36');
    expect(mapKnowledgeProperty('population density', 'en')).toBeUndefined();
    expect(mapKnowledgeProperty('original language', 'en')).toBeUndefined();
  });
});

describe('knowledge question analysis', () => {
  it.each([
    ['ما عاصمة بلجيكا؟', 'ar', 'P36', 'entity', 'بلجيكا'],
    ['What is France’s capital?', 'en', 'P36', 'entity', 'france'],
    ['وش العملة اللي يستخدمونها في النرويج؟', 'ar', 'P38', 'entity', 'النرويج'],
    ['عاصمة كندا شو؟', 'ar', 'P36', 'entity', 'كندا'],
    ['كام عدد السكان في المغرب؟', 'ar', 'P1082', 'quantity', 'المغرب'],
    ['How many people live in Belgium?', 'en', 'P1082', 'quantity', 'belgium'],
    ['Who is the head of government of Belgium?', 'en', 'P6', 'entity', 'belgium'],
    ['من رئيس الدولة في بلجيكا؟', 'ar', 'P35', 'entity', 'بلجيكا'],
    ['أين وُلِد أحمد زويل؟', 'ar', 'P19', 'entity', 'احمد زويل'],
    ['متى تأسست جامعة كامبريدج؟', 'ar', 'P571', 'date', 'جامعه كامبريدج'],
    ['مَن أسس أوبرا سيدني؟', 'ar', 'P112', 'entity', 'اوبرا سيدني'],
    ['تأسست آبل امتى؟', 'ar', 'P571', 'date', 'ابل'],
    ['When was Ada Lovelace born?', 'en', 'P569', 'date', 'ada lovelace'],
    ['Who wrote the Arrival movie?', 'en', 'P58', 'entity', 'the arrival movie'],
    ['Where is CERN headquartered?', 'en', 'P159', 'entity', 'cern'],
    ['وين مقر شركة سوني؟', 'ar', 'P159', 'entity', 'شركه سوني'],
  ])('maps %s to one relation and a typed answer', (text, language, id, expected, entity) => {
    expect(analyzeKnowledgeQuestion(text)).toMatchObject({ kind: 'lookup', language, property: { id }, expected, entity: { text: entity } });
  });

  it('keeps literal name variants for linking ahead of generic descriptors', () => {
    expect(analyzeKnowledgeQuestion('What is the population of the City of London?')).toMatchObject({
      entity: { text: 'the city of london', category: 'places', alternatives: ['city of london', 'london'] },
    });
    expect(analyzeKnowledgeQuestion('What is the capital of the country of Georgia?')).toMatchObject({
      kind: 'lookup', entity: { text: 'the country of georgia', category: 'countries', alternatives: ['country of georgia', 'georgia'] },
    });
    expect(analyzeKnowledgeQuestion('ما عاصمة دولة الكويت؟')).toMatchObject({
      kind: 'lookup', entity: { text: 'دوله الكويت', category: 'countries', alternatives: ['الكويت'] },
    });
    expect(analyzeKnowledgeQuestion('What is the capital of the Netherlands?')).toMatchObject({
      entity: { text: 'the netherlands', alternatives: ['netherlands'] },
    });
  });

  it('extracts an explicit year separately from the latest or earliest constraint', () => {
    expect(analyzeKnowledgeQuestion('ما أحدث عدد سكان بلجيكا في سنة ٢٠٢٠؟')).toMatchObject({
      time: { year: 2020, order: 'latest' }, entity: { text: 'بلجيكا' },
    });
    expect(analyzeKnowledgeQuestion('In 2020, what was the population of Belgium?')).toMatchObject({
      time: { year: 2020 }, entity: { text: 'belgium' },
    });
    expect(analyzeKnowledgeQuestion('When was A Tale of Two Cities first published?')).toMatchObject({
      property: { id: 'P577' }, time: { order: 'earliest' },
    });
    expect(analyzeKnowledgeQuestion('What is the occupation of Earliest Population of Earth?')).toMatchObject({
      entity: { text: 'earliest population of earth' },
    });
    expect(analyzeKnowledgeQuestion('What is the occupation of Earliest Population of Earth?')).not.toHaveProperty('time');
  });

  it('builds explicit paths for nested entity relations', () => {
    expect(analyzeKnowledgeQuestion('What is the country of citizenship of the founder of Huda Beauty?')).toMatchObject({
      kind: 'path', property: { id: 'P27' }, hops: [{ id: 'P112' }], entity: { text: 'huda beauty' },
    });
    expect(analyzeKnowledgeQuestion('ما عاصمة البلد اللي اتولد فيه نجيب محفوظ؟')).toMatchObject({
      kind: 'path', property: { id: 'P36' }, hops: [{ id: 'P19' }], countryOfBirth: true,
      entity: { text: 'نجيب محفوظ', category: 'people' },
    });
    expect(analyzeKnowledgeQuestion('What are the official languages of the headquarters of CERN?')).toMatchObject({
      kind: 'path', property: { id: 'P37' }, hops: [{ id: 'P159' }], multiple: true,
    });
  });

  it('builds numeric and dated comparisons and identifies bounded or category superlatives', () => {
    expect(analyzeKnowledgeQuestion('قارن بين بلجيكا وفرنسا من حيث المساحة؟')).toMatchObject({
      kind: 'compare', property: { id: 'P2046', unit: 'Q712226' },
      entities: [{ text: 'بلجيكا' }, { text: 'فرنسا' }],
    });
    expect(analyzeKnowledgeQuestion('Which has a larger population, Belgium or France?')).toMatchObject({
      kind: 'compare', expected: 'entity', property: { id: 'P1082' }, direction: 'max',
    });
    expect(analyzeKnowledgeQuestion('Which book was published earlier, Pride and Prejudice or Emma?')).toMatchObject({
      kind: 'compare', property: { id: 'P577' }, direction: 'min', time: { order: 'earliest' },
      entities: [{ text: 'pride and prejudice' }, { text: 'emma' }],
    });
    expect(analyzeKnowledgeQuestion('Which is the most populous country in the world?')).toMatchObject({
      kind: 'superlative', category: 'countries', direction: 'max', property: { id: 'P1082' },
    });
    expect(analyzeKnowledgeQuestion('Which is the smallest country by area among Belgium and France?')).toMatchObject({
      kind: 'superlative', category: 'countries', direction: 'min', property: { id: 'P2046' },
      entities: [{ text: 'belgium' }, { text: 'france' }],
    });
  });

  it('distinguishes a quantity statement from a count of recorded entities', () => {
    expect(analyzeKnowledgeQuestion('How many employees does Sony have?')).toMatchObject({
      kind: 'lookup', property: { id: 'P1128' }, expected: 'quantity',
    });
    expect(analyzeKnowledgeQuestion('How many awards did Toni Morrison win?')).toMatchObject({
      kind: 'count', property: { id: 'P166', answerType: 'entity' }, expected: 'quantity',
    });
    expect(analyzeKnowledgeQuestion('كم عدد اللغات الرسمية في سويسرا؟')).toMatchObject({
      kind: 'count', property: { id: 'P37' }, entity: { text: 'سويسرا' }, expected: 'quantity',
    });
  });

  it.each([
    'Why is Canada so large?',
    'ما رأيك في عدد سكان بلجيكا؟',
    'How many moons were discovered before 1900?',
    'What was the population of Brussels?',
    'How many people lived in Brussels?',
    'What is the current head of state of Italy?',
    'Who is X married to?',
    'How many wives did X have?',
    'Which is the most populous country by area?',
    'What was the population of Brussels in -500?',
    'What is the capital of the country where Ada was born in 1815?',
    'ما عاصمة فرنسا؟ وما عملة كندا؟',
    'Open https://example.com and tell me what is the date',
  ])('leaves %s unsupported', (text) => {
    expect(analyzeKnowledgeQuestion(text)).toBeUndefined();
  });

  it('uses the language of the question rather than the script of a mixed-language entity', () => {
    expect(knowledgeQuestionLanguage('What is the population of برلين?')).toBe('en');
    expect(knowledgeQuestionLanguage('متى تأسست Apple؟')).toBe('ar');
  });
});
