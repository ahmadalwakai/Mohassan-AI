import { describe, expect, it } from 'vitest';
import { DIALECT_MAPPINGS, foldForUnderstanding, normalize } from '../apps/server/src/assistant/understanding/normalization.js';

// Agent-written development cases. These are behavioral regression tests and are never used as training data.
describe('shared Arabic normalization', () => {
  it('keeps the display text byte-for-byte and folds Arabic spelling and both digit sets for matching', () => {
    const displayText = '  أَ إ آ ٱ مَـدْرَسَةٌ هُدَى مَسْؤُول مَسْئُول ٠١٢٣٤٥٦٧٨٩ ۰۱۲۳۴۵۶۷۸۹ Café  ';
    expect(normalize(displayText)).toMatchObject({
      displayText, matchText: 'ا ا ا ا مدرسه هدي مسءول مسءول 0123456789 0123456789 café', isArabizi: false,
    });
    expect(normalize('اِحْسِب ۱۲ + ٣').parserText).toBe('اِحْسِب 12 + 3');
    expect(normalize('إمتى؟').matchText).toBe(normalize('امتي؟').matchText);
  });

  it.each([
    ['لِمَادَا تتساقط الأوراق؟', 'لماذا تتساقط الاوراق؟'],
    ['هٰاذا جدار', 'هذا جدار'],
    ['ازاى أصلحها؟', 'كيف اصلحها؟'],
    ['عافاك كيفاش نسجل؟', 'كيف نسجل؟'],
    ['الانترنيت', 'الانترنت'],
    ['ماهي بلاد الشام؟', 'ما هي بلاد الشام؟'],
    ['منهو صاحب الكتاب؟', 'من هو صاحب الكتاب؟'],
    ['آية قرآنية', 'ايه قرانيه'],
  ])('corrects closed-set spelling variants in %s while keeping distinct Arabic words', (phrase, expected) => {
    expect(normalize(phrase).matchText).toBe(expected);
  });

  it.each([
    ['مرحبا، لماذا تهاجر الطيور؟', 'لماذا تهاجر الطيور؟'],
    ['صباح الخير إيه فوائد المشي؟', 'ما فواءد المشي؟'],
    ['يعطيك العافية، شو عاصمة كندا؟', 'ما عاصمه كندا؟'],
    ['يسعد صباحك، مين الممثل؟', 'من الممثل؟'],
    ['عفاك، بقداش البطاقة؟', 'كم البطاقه؟'],
    ['هلا والله، لو تكرمت وين السوق؟', 'اين السوق؟'],
    ['معلش، مين عمل الشاي؟', 'من عمل الشاي؟'],
    ['السلام عليكم ورحمة الله، من ألّف الكتاب؟', 'من الف الكتاب؟'],
    ['Hello, why do birds migrate?', 'why do birds migrate?'],
    ['أهلين، كيف حالك؟', 'مرحبا، كيف حالك؟'],
    ['أهلا وسهلا!', 'مرحبا!'],
  ])('handles a greeting or courtesy in %s', (phrase, expected) => {
    expect(normalize(phrase).matchText).toBe(expected);
  });

  it.each([
    ['فين المحطة؟', 'اين المحطه؟'],
    ['شلون أستخرج الشهادة؟', 'كيف استخرج الشهاده؟'],
    ['منو ألّف الكتاب؟', 'من الف الكتاب؟'],
    ['الزجاج ده بيكسر ليه؟', 'الزجاج هذا بيكسر لماذا؟'],
    ['القلم ده ليه', 'القلم هذا ليه'],
    ['ماهو أكبر كوكب؟', 'ما هو اكبر كوكب؟'],
    ['ماهو جاهز', 'ليس جاهز'],
    ['الملف ماهو لي', 'الملف ليس لي'],
    ['مش جاهز', 'ليس جاهز'],
    ['مو واضح', 'ليس واضح'],
    ['ماهو ابحث في الانترنت', 'ليس ابحث في الانترنت'],
    ['موعد الرحلة', 'موعد الرحله'],
    ['دول أوروبا', 'دول اوروبا'],
    ['ما عدد دول أفريقيا؟', 'ما عدد دول افريقيا؟'],
    ['الرجال دول مهندسون', 'الرجال هءلاء مهندسون'],
    ['دير مار جرجس', 'دير مار جرجس'],
    ['أبي مهندس', 'ابي مهندس'],
    ['أبي تعريف الطيور', 'اريد تعريف الطيور'],
    ['نبي الله', 'نبي الله'],
    ['وأين الفندق؟', 'واين الفندق؟'],
    ['ووين الفندق؟', 'واين الفندق؟'],
  ])('maps whole dialect words and recognizes ambiguous expressions in %s', (phrase, expected) => {
    expect(normalize(phrase).matchText).toBe(expected);
  });

  it('keeps request wording and possessives available to the host parsers', () => {
    expect(normalize('هلا والله، لو سمحت شوفلي الملف تبعي')).toEqual({
      displayText: 'هلا والله، لو سمحت شوفلي الملف تبعي', parserText: 'شوف لي الملف تبعي',
      matchText: 'انظر لي الملف لي', isArabizi: false,
    });
    expect(normalize('أنا عايز ابحث عن NASA')).toMatchObject({ parserText: 'ابحث عن NASA', matchText: 'انا اريد ابحث عن nasa' });
    expect(normalize('عايز عربية')).toMatchObject({ parserText: 'أريد عربية', matchText: 'اريد عربيه' });
  });

  it.each(DIALECT_MAPPINGS)('maps $from from $dialects to $to', ({ from, to, dialects }) => {
    const examples: Record<string, string> = {
      أبي: 'أبي مساعدة', نبي: 'نبي مساعدة', ماهو: 'ماهو جاهز',
    };
    const phrase = examples[from] ?? `${from}؟`;
    expect(dialects.length).toBeGreaterThan(0);
    expect(normalize(phrase).matchText).toBe(foldForUnderstanding(phrase.replace(from, to)));
  });

  it.each([
    ['shu esm el2ahera?', 'ما اسم القاهره?'],
    ['fein elkitab?', 'اين الكتاب?'],
    ['eh 2anwa3 2ahwa?', 'ما انواع قهوه?'],
    ['meen katab elkitab?', 'من كتب الكتاب?'],
    ['mar7aba, ezay a3raf sa3a NASDAQ?', 'كيف اعرف ساعه nasdaq?'],
    ['3ayz a3mel 5obz', 'اريد اعمل خبز'],
    ['kam 6aba2 fel beit?', 'كم طبق في بيت?'],
    ['shoufli 7al elbeit', 'انظر لي حال البيت'],
    ['wen 8atar?', 'اين قطر?'],
    ['meen 9awwar 9oura?', 'من صور صوره?'],
    ["shu 3'areeb?", 'ما غريب?'],
    ['wash 8arya 9a7ra?', 'هل قريه صحراء?'],
    ['shkun 5tara3 elkitab?', 'من اخترع الكتاب?'],
    ['leish 6alab elkitab?', 'لماذا طلب الكتاب?'],
  ])('transliterates Arabizi %s', (phrase, expected) => {
    expect(normalize(phrase)).toMatchObject({ displayText: phrase, matchText: expected, isArabizi: true });
  });

  it.each([
    'Wash dishes', 'Sho Group forecast', 'Show me 2FA codes and 8GB options', 'I run Python 3.12',
    '3rd example', 'What is 2 + 3?', 'Product v6.3-alpha', 'Open https://example.com/shlon?x=3ayz',
    'Search /tmp/3ayz.json and next_shlon.ts', 'Mail test-3ayz@example.com', 'اكتب `3ayz` بلغة عربية',
    'ترجم: فين 3ayz ۸', '«ازاي 3ayz ۸»',
  ])('does not transliterate literal or ordinary mixed-language text %s', phrase => {
    expect(normalize(phrase)).toMatchObject({ displayText: phrase, parserText: phrase, isArabizi: false });
  });

  it.each([
    ['اكتب فين في حقل البحث', 'اكتب فين في حقل البحث'],
    ['اكتب ١٢٣ في حقل الرقم', 'اكتب ١٢٣ في حقل الرقم'],
    ['اضغط على زر فين', 'اضغط على زر فين'],
    ['معلش، عايز اضغط على زر فين', 'اضغط على زر فين'],
    ['3ayz aktob ۱۲ في حقل البحث', 'اكتب ۱۲ في حقل البحث'],
    ['Hello, type فين into the search field', 'type فين into the search field'],
    ['افتح الصفحة ثم اضغط على زر فين', 'افتح الصفحة ثم اضغط على زر فين'],
  ])('preserves unquoted parser operands in %s', (phrase, expected) => {
    expect(normalize(phrase).parserText).toBe(expected);
  });

  it('keeps file paths, names, URLs, email addresses, and transform payloads in matched Arabizi text', () => {
    expect(normalize('wen NASA 3ayz.txt /tmp/3ayz https://example.com/shlon?x=3ayz test-3ayz@example.com').parserText)
      .toBe('أين NASA 3ayz.txt /tmp/3ayz https://example.com/shlon?x=3ayz test-3ayz@example.com');
    expect(normalize('tarjem: وين 3ayz ۸').parserText).toBe('ترجم: وين 3ayz ۸');
  });
});
