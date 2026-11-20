import { describe, expect, it } from 'vitest';
import type { AnswerType, Intent, Lang } from '../apps/server/src/assistant/mind/contract.js';
import { buildFrame } from '../apps/server/src/assistant/mind/frame.js';
import { matchText, normalizeRequest } from '../apps/server/src/assistant/mind/normalize.js';

const examples: readonly [Intent, readonly string[], readonly string[]][] = [
  ['identity', [
    'أرجوك، من أنت بالضبط؟', 'ما اسمك يا مساعد؟', 'مِين أنت؟', 'أنت مين يا صديق؟', 'عرّف بنفسك باختصار',
    'قدم نفسك لنا', 'من صنعك؟', 'وش اسمك بالضبط؟',
  ], [
    'Kindly introduce yourself.', 'Who are you, anyway?', 'What is your name, exactly?', 'What are you?', 'Who created you?',
    'Who made you please?', 'Please, what can you do?', 'Tell me about yourself.',
  ]],
  ['smalltalk', [
    'السَّلام عليكم!', 'هلا بك يا صديقي', 'كيف حالك اليوم؟', 'يعطيك العافية!', 'كيفك؟',
    'شكراً جزيلاً يا مساعد!', 'صباح النور.', 'مع السلامة!', 'جزاك الله خيرًا.',
  ], [
    'Good afternoon.', 'Nice to meet you!', 'Hey there!', 'Hello, good morning!', 'How are you doing today?',
    'Thanks so much, friend!', 'Much appreciated.', 'Goodbye.', 'Thank you for your time.',
  ]],
  ['compute', [
    'احسب ٢٩ زائد ١٧', 'اجمع ٣٧ و٤٢', 'ما ناتج 25 ÷ 4؟', 'كم ٣٧٪ من 880؟', 'حول ٧٢ رطل إلى كيلوغرام',
    '٨٠ كيلومترا كم ميلًا؟', 'احسبي جذر ١٤٤', 'لو سمحت اطرح ٩ من ٤٧', 'سبعة في المئة من ١٠٠',
    'أي يوم من الأسبوع يصادف ٣٠ سبتمبر ٢٠٢٧؟', 'كم يوم بين ١٠ يناير و١٥ أبريل؟', 'ما تاريخ بعد ١٧ يوما؟',
    'كم الساعة في نيروبي؟', 'فرق التوقيت بين داكا ولشبونة', 'حولي ٥٠٠ مل إلى لترات', '١٨×٦؟',
  ], [
    'Work out 45 * 26', 'Calculate fifteen divided by five.', 'Please convert 68 Fahrenheit to Celsius.', 'Evaluate 6^3.', 'Compute 89 − 22.',
    'How many yards are in 42 feet?', 'Multiply 19 by 23.', 'What is 37 percent of 890?', '24 / 6?',
    'What day of the week was November 8 2022?', 'How many months between April and December?', 'What date is 35 days before December 8?',
    'What time is it in Lusaka?', 'What is the time difference between Bergen and Dakar?', 'Convert 3.4 l into ml.', 'Add 15 to 36.',
  ]],
  ['memory_recall', [
    'ما رقم ملفي عند المورد؟', 'أخبرني عن عنوان شركتنا.', 'كم ميزانيتي الشهرية؟', 'ما أسماء منتجات متجري؟',
    'من ذاكرتي المحفوظة، ما اسم المورد السابق؟', 'وين موعدي القادم؟', 'قل لي ما عنوان مكتبي.', 'متى ينتهي حجزنا؟',
  ], [
    'When does my lease renew?', 'Which of our projects is due first?', 'Tell me the name of my dentist.', 'What is our reference number?',
    'Look up almonds in my saved memories.', 'What is my postal address? Return the value only.', 'Give me my workshop time.', 'Where is our regional office?',
  ]],
  ['memory_save', [
    'تذكّر أن اسم قطّي سكر.', 'احفظ: رمز المخزن ألف.', 'لا تنس موقعي المفضل.', 'رجاءً، احفظ ملاحظة لنفسي.',
  ], [
    'Remember that Elsie reads in the afternoon.', 'Save this: the paper is blue.', 'Keep in mind that Hugo is away on Monday.', "Don't forget the annex has a side door.",
  ]],
  ['fact_question', [
    'متى افتتح جسر البوابة الذهبية؟', 'وين تقع مونتفيديو؟', 'ما معنى الإزاحة؟', 'هل يتجمد الهيليوم بسهولة؟',
    'كيف نمت مدينة بخارى؟', 'كم يبلغ ارتفاع جبل آرارات؟', 'ابحث عن اكتشافات في تلوث المنشآت.', 'ما سعر صرف اليورو مقابل الين؟',
  ], [
    'Where was the Dnieper first surveyed?', 'When did the museum at Orsay open?', 'Does copper conduct heat well?', 'How high is Mount Ruapehu?',
    'Who invented the stethoscope?', 'Research river ice dynamics.', 'How much is 90 CHF in JPY?', 'Why are fricatives heard differently?',
  ]],
  ['compare', [
    'قارن طول الطريق المعبد وطول طريق الميناء.', 'أيهما أخف النحاس أم الألومنيوم؟', 'ما هو أثقل من ثاني أكسيد الكربون؟',
    'هذا النوع أفضل من النوع السابق؟', 'أيهما أقل تكلفة، النقل بالقطار أم بالقارب؟', 'مقارنة بين القوس الدائري والقوس المدبب',
  ], [
    'Compare the acidity of oranges and pears.', 'Which one is heavier, wool or silk?', 'Is the Bessemer process older than the Siemens process?',
    'Bristol versus Norwich by area', 'Which has a longer range, model A or model B?', 'Is mica lighter than quartz?',
  ]],
  ['site_check', [
    'افحص الموقع https://garden.example/health', 'اختبر هذا الرابط https://forum.example/tree', 'راجع صفحة https://wood.example/',
    'ما حالة الموقع signal.example؟', 'هل يعمل هذا الرابط https://page.example/sample؟',
  ], [
    'Audit the website https://meadow.example/docs.', 'Inspect this page https://vault.example/rules.', 'Check the site https://oak.example/',
    'Is the website up? https://maps.example/tiles', 'Find redirects for https://house.example/policies.',
  ]],
  ['site_question', [
    'ما العنوان المكتوب في https://museum.example/زيارة؟', 'وين موقع الفرع حسب صفحة https://north.example/فرع؟',
    'هل يذكر https://trades.example/سوق منطقة التغطية؟',
  ], [
    'What dates are mentioned at https://hall.example/events?', 'Tell me the inventory at shop.example.', 'How much does a ticket cost on https://fair.example/info?',
  ]],
  ['open_site', [
    'افتح https://saffron.example/list', 'ادخل موقع network.example',
  ], [
    'Browse https://page.example/table', 'Visit spring.example',
  ]],
  ['write', [
    'ترجم الجملة التالية للفرنسية.', 'ألف قصة عن الربيع.', 'أعد صياغة الرسالة بلباقة.', 'صغ وصفا لورشة الأعمال.',
    'أنشئ قصيدة عن حديقة الزيتون.', 'اصنع شعارا لمعرض الخزف.',
  ], [
    'Translate this note into Norwegian.', 'Write a sonnet about a water mill.', 'Make up a short introduction.', 'Draft a newspaper letter.',
    'Generate a comic story about a stubborn bicycle.', 'Could you professionally paraphrase the circular?',
  ]],
  ['explain', [
    'اشرح طريقة تحضير الطلاء.', 'فسر نظرية التشابه.', 'لخّص هذا الفصل لزملائك.', 'علمني مبادئ الطباعة.',
  ], [
    'Teach me how brass valves work.', 'Explain the job of the chief clerk.', 'Summarize the second chapter.', 'Walk me through the experiment.',
  ]],
  ['ads', ['جهز حملة إعلانية لمقهى.', 'أنشئ حملة في حساب إعلانات جوجل.'], ['Create a campaign in my Google Ads account.', 'Make a Google Ads draft for a florist.']],
  ['coding', ['اكتب دالة لتحويل المتجهات.', 'أضف اختبار برمجي لجمع مصفوفتين.'], ['Write a function to compare fractions.', 'Fix the password parsing bug.']],
  ['computer', ['اضغط على الزر المتاح.', 'افتح النافذة الحالية.'], ['Open the settings window.', 'Scroll the screen down.']],
  ['unknown', ['طيب، إذن.', 'الموضوع.'], ['Do it.', 'The beige one.']],
];

const variants = examples.flatMap(([intent, ar, en]) =>
  ([['ar', ar], ['en', en]] as const).flatMap(([language, requests]) => requests.map(request => ({ intent, language, request }))));

describe('request framing by language', () => {
  it.each(variants)('$language $intent · $request', ({ intent, language, request }) => {
    const frame = buildFrame(request);
    expect(frame.lang).toBe(language);
    expect(frame.intent).toBe(intent);
    expect(frame.matched[0]?.intent ?? 'unknown').toBe(intent);
  });

  it.each<[Lang, string, string[], string | null]>([
    ['en', 'What is its price?', ['question'], 'money'],
    ['en', 'Which city hosted the congress?', [], 'place'],
    ['ar', 'ما هذا؟', ['question'], 'text'],
    ['ar', 'لو سمحت، افتح الموقع', ['website'], 'text'],
    ['en', 'Please calculate', ['expression'], 'number'],
    ['en', 'Remember', ['memory_content'], 'text'],
    ['ar', 'لو سمحت', ['question'], null],
    ['en', 'How far is that?', ['question'], 'number'],
    ['ar', 'كم يبلغ وزنه؟', ['question'], 'number'],
    ['en', 'What is the depth?', ['question'], 'number'],
  ])('identifies language, missing fields and answer type for %s %s', (_lang, prompt, missing, answerType) => {
    expect(buildFrame(prompt)).toMatchObject({ lang: _lang, missing, answerType });
  });

  it('retains the full explicit destination and separately classifies personal data', () => {
    const frame = buildFrame('What is my invoice due date according to https://billing.example/PDFs/رقم١?ref=Seven?');
    expect(frame).toMatchObject({ lang: 'en', personal: true, intent: 'memory_recall' });
    expect(frame.urls).toEqual(['https://billing.example/PDFs/%D8%B1%D9%82%D9%85%D9%A1?ref=Seven']);
    expect(frame.matched.map(entry => entry.rule)).toContain('question-with-address');
    expect(frame.focus).not.toContain('billing');
  });

  it('validates explicit addresses without promoting credentials, mail, and code names into links', () => {
    expect(buildFrame('Does Node.js run this script? Write staff@mail.example.').urls).toEqual([]);
    const credentials = buildFrame('Look at https://guest:secret@staff.example/schedule');
    expect(credentials.urls).toEqual([]);
    expect(credentials.focus).not.toContain('secret');
    expect(buildFrame('What did <https://planet.example/Visit?place=Seven#maps> say?').urls).toEqual(['https://planet.example/Visit?place=Seven#maps']);
  });

  it('preserves useful text through compatibility normalization, Arabic folding, and courtesy removal', () => {
    expect(normalizeRequest('  لَوْ سَمَحْت، مِن فَضْلك: عِلْمُ الأحياء ١۲３  ')).toEqual({
      lang: 'ar', text: 'علم الأحياء 123', match: 'علم الاحياء 123',
    });
    expect(matchText('إمــارة على الهُدى ١۲')).toBe('اماره علي الهدي 12');
    expect(normalizeRequest('please compare https://oak.example/وَ١?keep=Ａ').text).toBe('compare https://oak.example/وَ١?keep=Ａ');
  });

  it.each<[Lang, string, Intent, string, string]>([
    ['ar', 'أورد رسوم تسجيل مركز الفخار البلدي.', 'fact_question', 'money', 'factual-report'],
    ['en', 'Provide the founding year of the coastal ferry.', 'fact_question', 'date', 'factual-report'],
    ['ar', 'بيّن الفرق بين طول جسر الوادي وطول جسر الحقول.', 'compare', 'number', 'comparison'],
    ['en', 'Report conflicting depth estimates for the limestone quarry.', 'compare', 'number', 'comparison'],
    ['ar', 'اذكر التقديرات المتعارضة لسكان الجزيرة.', 'compare', 'list', 'comparison'],
    ['en', 'State the differences between the kiln designs.', 'compare', 'number', 'comparison'],
    ['ar', 'السعة الاسمية: https://cistern.example/spec', 'site_question', 'number', 'field-with-address'],
    ['en', 'Enrollment fee: https://conservatory.example/admission', 'site_question', 'money', 'field-with-address'],
    ['ar', 'على https://museum.example/events، موعد إغلاق المعرض', 'site_question', 'date', 'field-with-address'],
    ['en', 'From https://rail.example/tickets: quote the cancellation terms.', 'site_question', 'text', 'field-with-address'],
    ['ar', 'اعرض عنوان مكتبي حسب https://directory.example/staff', 'memory_recall', 'place', 'owner-data'],
    ['en', 'State the terms of my account renewal from https://membership.example/plans.', 'memory_recall', 'text', 'owner-data'],
  ])('frames a factual phrase in %s — %s', (lang, prompt, intent, answerType, rule) => {
    const frame = buildFrame(prompt);
    expect(frame).toMatchObject({ lang, intent, answerType, missing: [] });
    expect(frame.matched[0]?.rule).toBe(rule);
  });

  it('keeps terse fields grounded and leaves unknown effects outside factual reporting', () => {
    expect(buildFrame('Report a broken chair to facilities.')).toMatchObject({ intent: 'unknown', missing: ['question'] });
    expect(buildFrame('اعرض المسافة.')).toMatchObject({ intent: 'fact_question', missing: ['question'] });
    const price = buildFrame('Return the fee only at https://dock.example/visits.');
    expect(price).toMatchObject({ intent: 'site_question', answerType: 'money', valueOnly: true });
    expect(price.focus).toContain('fee');
    expect(price.focus).not.toContain('return');
  });

  it.each<[Lang, string, Intent, AnswerType]>([
    ['en', 'Give the garden admission charge printed on https://botany.example/visitors.', 'site_question', 'money'],
    ['ar', 'اعرض بدل العضوية، مبلغ رسوم التمديد المذكور في https://civic.example/renew.', 'site_question', 'money'],
    ['en', 'Extract the steel drum wall thickness shown on https://drums.example/gauge.', 'site_question', 'number'],
    ['en', 'Compare both archives on the year the market hall opened.', 'compare', 'date'],
    ['ar', 'بيّن ما اختلفت فيه الروايات حول عام بناء المنارة.', 'compare', 'date'],
    ['en', 'Show the reports’ differing estimates of the total count for the census.', 'compare', 'number'],
    ['ar', 'قارن تقديرات المصادر من حيث عدد الأشجار في الحديقة.', 'compare', 'number'],
  ])('recognizes the requested property in %s — %s', (lang, prompt, intent, answerType) => {
    const frame = buildFrame(prompt);
    expect(frame).toMatchObject({ lang, intent, answerType });
  });

  it('selects the requested measure instead of a date named only in source attribution', () => {
    expect(buildFrame('Give the monthly membership cost reported in the latest dated notice at https://members.example/fees.'))
      .toMatchObject({ intent: 'site_question', answerType: 'money' });
  });

  it.each<[Lang, string, AnswerType]>([
    ['en', 'Merrin lighthouse height', 'number'],
    ['ar', 'عدد سكان بلدة عين الصفصاف', 'number'],
    ['en', 'Capital of Saint Lucia', 'place'],
    ['ar', 'تاريخ نشر معجم الموانئ السريانية', 'date'],
    ['en', 'Alder Marsh visitor centre business hours', 'text'],
    ['ar', 'مؤلف رواية سكة الغيم', 'name'],
  ])('extracts the topic and property of a nominal %s request — %s', (lang, prompt, answerType) => {
    const frame = buildFrame(prompt);
    expect(frame).toMatchObject({ lang, intent: 'fact_question', answerType, missing: [] });
    expect(frame.matched[0]?.rule).toBe('property-and-topic');
  });

  it.each([
    'Check it, please.', 'Verify the previous item.', 'افحصها من فضلك.', 'تحقق من هذا.',
    'Population count.', 'عدد السكان فقط.', 'Delete the calendar date.',
  ])('requires a subject for %s', (request) => {
    expect(buildFrame(request)).toMatchObject({ intent: 'unknown', missing: ['question'] });
  });

  it.each<[Lang, string]>([
    ['en', '3,825 minus 135, just the number please.'],
    ['en', '6 multiplied by (13) — answer only, thanks.'],
    ['ar', '٣٬٨٠٥ ناقص ٢٣٠، الرقم بس لو سمحت.'],
    ['ar', '٨ بالمية من ٨٧٥؟ الناتج فقط، شكراً.'],
    ['ar', 'قديش ٢٨ ع ٤، بلا خطوات من فضلك؟'],
  ])('recognizes arithmetic and scalar output in %s — %s', (lang, prompt) => {
    const frame = buildFrame(prompt);
    expect(frame).toMatchObject({ lang, intent: 'compute', answerType: 'number', valueOnly: true, missing: [] });
    expect(frame.text).toMatch(/(?:please|thanks|لو سمحت|اشكرا|شكرا|من فضلك)/iu);
  });

  it('identifies depth as a measurement and treats a requested year as a scalar', () => {
    expect(buildFrame('How deep is the entrance shaft in Sable Pit?')).toMatchObject({ intent: 'fact_question', answerType: 'number' });
    expect(buildFrame('How deep is that?')).toMatchObject({ answerType: 'number', missing: ['question'] });
    expect(buildFrame('Report just the founding year of Pine Ridge observatory.')).toMatchObject({ intent: 'fact_question', answerType: 'date', valueOnly: true });
    expect(buildFrame('When was the Stoneford theatre opened? Year only, please.')).toMatchObject({ answerType: 'date', valueOnly: true });
  });
});
