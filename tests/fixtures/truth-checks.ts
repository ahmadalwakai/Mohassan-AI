/** Agent-written development data. Never use these triples for training. */
interface EvidencePage {
  url: string;
  quote: string;
  title?: string;
}

export interface TruthCase {
  id: string;
  scenario: string;
  language: 'ar' | 'en';
  provenance: string;
  question: string;
  pages: EvidencePage[];
  reply: string;
  correct: boolean;
  secondPage?: EvidencePage;
  /** The exact supported answer clause after dropping the unsupported claim. */
  expectedSupported?: string;
}

export const developmentProvenance = 'agent-written development case';

type Scenario = [
  id: string,
  question: string,
  quote: string,
  correct: string,
  wrong: string,
  wrongAlternative: string,
  independentQuote?: string,
];

// Each fictional record has an explicitly written answer and two distinct failure variants.
// The paired replies share a scenario ID so they can be grouped during calibration.
const english: Scenario[] = [
  ['bridge-opening', 'When did Alder Bridge open?',
    'Alder Bridge opened on 12 May 2011. Work on Alder Bridge began on 4 April 2009.',
    'Alder Bridge opened on 12 May 2011.', 'Alder Bridge opened on 21 May 2011.',
    'Work on Alder Bridge began on 4 April 2009.', 'The opening of Alder Bridge was on 12 May 2011.'],
  ['station-count', 'How many platforms does Finch Station have?',
    'Finch Station has 6 platforms. Oak Station has 9 platforms.',
    'Finch Station has 6 platforms.', 'Finch Station has 9 platforms.',
    'Oak Station has 9 platforms.', 'Finch Station has 6 platforms. Access is from the west.'],
  ['book-author', 'Who wrote The Copper Map?',
    'Mina Clarke wrote The Copper Map. Tomas Hale illustrated The Copper Map.',
    'Mina Clarke wrote The Copper Map.', 'Tomas Hale wrote The Copper Map.',
    'Tomas Hale illustrated The Copper Map.'],
  ['observatory-founding', 'Who founded Northglass Observatory?',
    'The Kestrel Society founded Northglass Observatory. The Rowan Trust owns Northglass Observatory.',
    'The Kestrel Society founded Northglass Observatory.', 'The Rowan Trust founded Northglass Observatory.',
    'The Rowan Trust owns Northglass Observatory.'],
  ['race-duration', 'How long did the Alder Race take?',
    'The Alder Race took 90 minutes. The start was delayed for 15 minutes.',
    'The Alder Race took 90 minutes.', 'The Alder Race took 90 hours.',
    'The start was delayed for 15 minutes.', 'The Alder Race took 90 minutes.'],
  ['river-distance', 'How long is the Fern River?',
    'The Fern River is 3 kilometres long. The road along the river is 5 kilometres long.',
    'The Fern River is 3 kilometres long.', 'The Fern River is 3,000 kilometres long.',
    'The road along the river is 5 kilometres long.'],
  ['median-price', 'What was the median ticket price at Bell Theatre?',
    'The median ticket price at Bell Theatre was 24 pounds. The lowest ticket price at Bell Theatre was 12 pounds.',
    'The median ticket price at Bell Theatre was 24 pounds.', 'The median ticket price at Bell Theatre was 24 dollars.',
    'The lowest ticket price at Bell Theatre was 12 pounds.'],
  ['temperature', 'What was the temperature at Reed Station?',
    'Reed Station recorded a temperature of −7 °C. Pine Station recorded a temperature of 7 °C.',
    'Reed Station recorded a temperature of −7 °C.', 'Reed Station recorded a temperature of 7 °C.',
    'Pine Station recorded a temperature of 7 °C.'],
  ['attendees', 'How many people attended the Silver Fair?',
    'The Silver Fair was attended by 1,240 people. It had 24 stalls.',
    '1,240 people attended the Silver Fair.', 'The Silver Fair was attended by 124 people.',
    'The Silver Fair had 24 stalls.', 'The Silver Fair was attended by 1,240 people.'],
  ['council-vote', 'When did the Amber Council approve the dam?',
    'The Amber Council rejected the dam on 8 June 2006. The Amber Council approved the dam on 9 July 2007.',
    'The Amber Council approved the dam on 9 July 2007.', 'The Amber Council approved the dam on 8 June 2006.',
    'The Amber Council rejected the dam on 8 June 2006.'],
  ['sale-end', 'When did the Willow Sale end?',
    'The Willow Sale ran from 2022-11-03 to 2022-11-05. The next Willow Sale was announced in December 2022.',
    'The Willow Sale ended on 2022-11-05.', 'The Willow Sale ended on 2022-11-03.',
    'The next Willow Sale was announced in December 2022.'],
  ['signed-report', 'Who signed the Juniper Audit?',
    'Ravi Das signed the Juniper Audit on behalf of Willow Labs. June Parker reviewed the Juniper Audit.',
    'Ravi Das signed the Juniper Audit.', 'June Parker signed the Juniper Audit.',
    'The Juniper Audit was signed on Monday.'],
  ['plant-failure', 'Why did the Ivy Pump stop?',
    'The Ivy Pump stopped because its fuse blew. The reservoir level rose after the Ivy Pump stopped.',
    'The Ivy Pump stopped because its fuse blew.', 'The Ivy Pump stopped because the reservoir level rose.',
    'The reservoir level rose after the Ivy Pump stopped.'],
  ['archive-location', 'Where is the Mallow Archive located?',
    'The Mallow Archive is located in Graywick. The Mallow Museum is located in Sandwick.',
    'The Mallow Archive is located in Graywick.', 'The Mallow Archive is located in Sandwick.',
    'The Mallow Museum is located in Sandwick.'],
  ['planned-count', 'How many seats does Park Hall have?',
    'Park Hall has 210 seats. The renovation would increase its capacity to 300 seats.',
    'Park Hall has 210 seats.', 'Park Hall has 300 seats.',
    'The renovation would increase Park Hall’s capacity to 300 seats.', 'Park Hall has 210 seats now.'],
  ['contract-negation', 'Who took over Cedar Transit?',
    'The Alder Board did not take over Cedar Transit. Mesa Operations took over Cedar Transit.',
    'Mesa Operations took over Cedar Transit.', 'The Alder Board took over Cedar Transit.',
    'The Alder Board did not take over Cedar Transit.'],
  ['mass-conversion', 'How much does the Lark Parcel weigh?',
    'The Lark Parcel weighs 2 kilograms. The Finch Parcel weighs 3 kilograms.',
    'The Lark Parcel weighs 2 kilograms.', 'The Lark Parcel weighs 2 grams.',
    'The Lark Parcel weighs 3 kilograms.'],
  ['treasurer', 'Who was treasurer of the Cedar Club?',
    'In the minutes, the Cedar Club treasurer is Sara Kent. The Cedar Club secretary is Luke Reed.',
    'The Cedar Club treasurer is Sara Kent.', 'Luke Reed was treasurer of the Cedar Club.',
    'The Cedar Club secretary is Luke Reed.'],
  ['press-date', 'When was the Elm Permit issued?',
    'The Elm Permit was issued on 7 February 2020. The press notice about the Elm Permit was published on 17 February 2020.',
    'The Elm Permit was issued on 7 February 2020.', 'The Elm Permit was issued on 17 February 2020.',
    'The press notice about the Elm Permit was published on 17 February 2020.'],
  ['count-category', 'How many public buses does Birch Transit operate?',
    'Birch Transit operates 18 public buses and 11 private shuttles.',
    'Birch Transit operates 18 public buses.', 'Birch Transit operates 11 public buses.',
    'Birch Transit operates 11 private shuttles.'],
  ['promotion', 'Who directed the film Lantern Road?',
    'Olivia Nair directed Lantern Road. The film was promoted by Harlow Pictures.',
    'Olivia Nair directed Lantern Road.', 'Harlow Pictures directed Lantern Road.',
    'Olivia Nair directed Lantern Road. Noah Reid wrote it.'],
  ['radius', 'What is the radius of the Ash Wheel?',
    'The radius of the Ash Wheel is 28 centimetres. The diameter is 56 centimetres.',
    'The radius of the Ash Wheel is 28 centimetres.', 'The radius of the Ash Wheel is 56 centimetres.',
    'The diameter of the Ash Wheel is 56 centimetres.'],
  ['evacuation', 'When did West Fen evacuate?',
    'West Fen evacuated on 23 September 2019. East Fen evacuated on 24 September 2019.',
    'West Fen evacuated on 23 September 2019.', 'West Fen evacuated on 24 September 2019.',
    'East Fen evacuated on 24 September 2019.', 'West Fen evacuated on 23 September 2019.'],
  ['chemical-property', 'Is the Alder Coating waterproof?',
    'The Alder Coating is waterproof. The Hazel Coating is only splash-resistant.',
    'The Alder Coating is waterproof.', 'The Alder Coating is only splash-resistant.',
    'The Hazel Coating is only splash-resistant.'],
  ['governor', 'Who appointed Mira Bell?',
    'Governor Saleh Noor appointed Mira Bell. Mira Bell appointed Owen Day.',
    'Governor Saleh Noor appointed Mira Bell.', 'Mira Bell appointed Governor Saleh Noor.',
    'Mira Bell appointed Owen Day.'],
  ['headcount', 'How many volunteers worked at the Olive Library?',
    'The Olive Library had 14 volunteers and 5 paid employees.',
    'The Olive Library had 14 volunteers.', 'The Olive Library had 5 volunteers.',
    'The Olive Library had 14 volunteers. All volunteers could work remotely.'],
];

const arabic: Scenario[] = [
  ['bridge-opening', 'متى افتتح جسر الصفصاف؟',
    'افتتح جسر الصفصاف في ١٢ مايو ٢٠١١. بدأ بناء جسر الصفصاف في ٤ أبريل ٢٠٠٩.',
    'افتتح جسر الصفصاف في 12 مايو 2011.', 'افتتح جسر الصفصاف في ٢١ مايو ٢٠١١.',
    'بدأ بناء جسر الصفصاف في ٤ أبريل ٢٠٠٩.', 'افتتح جسر الصفصاف في ١٢ مايو ٢٠١١.'],
  ['station-count', 'كم عدد أرصفة محطة النورس؟',
    'في محطة النورس ٦ أرصفة. في محطة الزيتون ٩ أرصفة.',
    'في محطة النورس ٦ أرصفة.', 'في محطة النورس ٩ أرصفة.',
    'في محطة الزيتون ٩ أرصفة.', 'في محطة النورس ٦ أرصفة. الدخول من الجانب الغربي.'],
  ['book-author', 'من كتب رواية طريق السدر؟',
    'كتب أمين نجيب رواية طريق السدر. رسمت هناء جابر غلاف رواية طريق السدر.',
    'كتب أمين نجيب رواية طريق السدر.', 'كتبت هناء جابر رواية طريق السدر.',
    'رسمت هناء جابر غلاف رواية طريق السدر.'],
  ['observatory-founding', 'من أسس مرصد الندى؟',
    'أسست جمعية السمت مرصد الندى. تدير مؤسسة المدار مرصد الندى.',
    'أسست جمعية السمت مرصد الندى.', 'أسست مؤسسة المدار مرصد الندى.',
    'تدير مؤسسة المدار مرصد الندى.'],
  ['race-duration', 'كم استغرق سباق السرو؟',
    'استغرق سباق السرو ٩٠ دقيقة. تأخر انطلاق السباق ١٥ دقيقة.',
    'استغرق سباق السرو ٩٠ دقيقة.', 'استغرق سباق السرو ٩٠ ساعة.',
    'تأخر انطلاق السباق ١٥ دقيقة.', 'استغرق سباق السرو ٩٠ دقيقة.'],
  ['river-distance', 'كم يبلغ طول نهر الصفاء؟',
    'يبلغ طول نهر الصفاء ٣ كيلومترات. يبلغ طول الطريق المحاذي للنهر ٥ كيلومترات.',
    'يبلغ طول نهر الصفاء ٣ كيلومترات.', 'يبلغ طول نهر الصفاء ٣٠٠٠ كيلومتر.',
    'يبلغ طول الطريق المحاذي للنهر ٥ كيلومترات.'],
  ['median-price', 'كم بلغ السعر الوسيط لتذكرة مسرح الزهر؟',
    'بلغ السعر الوسيط لتذكرة مسرح الزهر ٢٤ دينارًا. بلغ أدنى سعر لتذكرة مسرح الزهر ١٢ دينارًا.',
    'بلغ السعر الوسيط لتذكرة مسرح الزهر ٢٤ دينارًا.', 'بلغ السعر الوسيط لتذكرة مسرح الزهر ٢٤ درهمًا.',
    'بلغ أدنى سعر لتذكرة مسرح الزهر ١٢ دينارًا.'],
  ['temperature', 'كم كانت درجة الحرارة في محطة الربوة؟',
    'سجلت محطة الربوة درجة حرارة −٧ درجات مئوية. سجلت محطة الميناء درجة حرارة ٧ درجات مئوية.',
    'سجلت محطة الربوة درجة حرارة −٧ درجات مئوية.', 'سجلت محطة الربوة درجة حرارة ٧ درجات مئوية.',
    'سجلت محطة الميناء درجة حرارة ٧ درجات مئوية.'],
  ['attendees', 'كم شخصًا حضر معرض الورق؟',
    'حضر معرض الورق ١٬٢٤٠ شخصًا. شارك فيه ٢٤ عارضًا.',
    'حضر معرض الورق ١٬٢٤٠ شخصًا.', 'حضر معرض الورق ١٢٤ شخصًا.',
    'شارك في معرض الورق ٢٤ عارضًا.', 'حضر معرض الورق ١٢٤٠ شخصًا.'],
  ['council-vote', 'متى وافق مجلس المروج على بناء السد؟',
    'رفض مجلس المروج بناء السد في ٨ يونيو ٢٠٠٦. وافق مجلس المروج على بناء السد في ٩ يوليو ٢٠٠٧.',
    'وافق مجلس المروج على بناء السد في ٩ يوليو ٢٠٠٧.', 'وافق مجلس المروج على بناء السد في ٨ يونيو ٢٠٠٦.',
    'رفض مجلس المروج بناء السد في ٨ يونيو ٢٠٠٦.'],
  ['sale-end', 'متى انتهى مزاد الحور؟',
    'أقيم مزاد الحور من ٢٠٢٢-١١-٠٣ إلى ٢٠٢٢-١١-٠٥. أُعلن المزاد المقبل في ديسمبر ٢٠٢٢.',
    'انتهى مزاد الحور في ٢٠٢٢-١١-٠٥.', 'انتهى مزاد الحور في ٢٠٢٢-١١-٠٣.',
    'أُعلن المزاد المقبل في ديسمبر ٢٠٢٢.'],
  ['signed-report', 'من وقع تقرير دار الينبوع؟',
    'وقّعت سلمى سعد تقرير دار الينبوع نيابة عن شركة الغد. راجع بدر شريف تقرير دار الينبوع.',
    'وقّعت سلمى سعد تقرير دار الينبوع.', 'وقّع بدر شريف تقرير دار الينبوع.',
    'وُقّع تقرير دار الينبوع يوم الاثنين.'],
  ['plant-failure', 'لماذا توقفت مضخة الروضة؟',
    'توقفت مضخة الروضة لأن الصمام انكسر. ارتفع مستوى الخزان بعد توقف مضخة الروضة.',
    'توقفت مضخة الروضة لأن الصمام انكسر.', 'توقفت مضخة الروضة لأن مستوى الخزان ارتفع.',
    'ارتفع مستوى الخزان بعد توقف مضخة الروضة.'],
  ['archive-location', 'أين يقع أرشيف الساقية؟',
    'يقع أرشيف الساقية في مدينة الروابي. يقع متحف الساقية في مدينة المنارة.',
    'يقع أرشيف الساقية في مدينة الروابي.', 'يقع أرشيف الساقية في مدينة المنارة.',
    'يقع متحف الساقية في مدينة المنارة.'],
  ['planned-count', 'كم عدد مقاعد قاعة البستان؟',
    'تضم قاعة البستان ٢١٠ مقاعد. من المخطط رفع طاقتها إلى ٣٠٠ مقعد.',
    'تضم قاعة البستان ٢١٠ مقاعد.', 'تضم قاعة البستان ٣٠٠ مقعد.',
    'من المخطط رفع طاقة قاعة البستان إلى ٣٠٠ مقعد.', 'تضم قاعة البستان ٢١٠ مقاعد حاليًا.'],
  ['contract-negation', 'من استحوذ على شركة النقل الساحلي؟',
    'لم تستحوذ شركة الأشرعة على شركة النقل الساحلي. استحوذت مجموعة الشاطئ على شركة النقل الساحلي.',
    'استحوذت مجموعة الشاطئ على شركة النقل الساحلي.', 'استحوذت شركة الأشرعة على شركة النقل الساحلي.',
    'لم تستحوذ شركة الأشرعة على شركة النقل الساحلي.'],
  ['mass-conversion', 'كم يبلغ وزن طرد الرمان؟',
    'يبلغ وزن طرد الرمان ٤ كيلوغرامات. يبلغ وزن طرد التين ٣ كيلوغرامات.',
    'يبلغ وزن طرد الرمان ٤ كيلوغرامات.', 'يبلغ وزن طرد الرمان ٤ غرامات.',
    'يبلغ وزن طرد الرمان ٣ كيلوغرامات.'],
  ['treasurer', 'من كان أمين صندوق نادي النجمة؟',
    'أمين صندوق نادي النجمة هو سامر رضوان. أمين سر نادي النجمة هو جلال محمود.',
    'أمين صندوق نادي النجمة هو سامر رضوان.', 'أمين صندوق نادي النجمة هو جلال محمود.',
    'أمين سر نادي النجمة هو جلال محمود.'],
  ['press-date', 'متى صدر تصريح الساحة؟',
    'صدر تصريح الساحة في ٧ فبراير ٢٠٢٠. نُشر البيان عن تصريح الساحة في ١٧ فبراير ٢٠٢٠.',
    'صدر تصريح الساحة في ٧ فبراير ٢٠٢٠.', 'صدر تصريح الساحة في ١٧ فبراير ٢٠٢٠.',
    'نُشر البيان عن تصريح الساحة في ١٧ فبراير ٢٠٢٠.'],
  ['count-category', 'كم حافلة عامة تدير شركة نقل العقيق؟',
    'تدير شركة نقل العقيق ١٨ حافلة عامة و١١ مركبة خاصة.',
    'تدير شركة نقل العقيق ١٨ حافلة عامة.', 'تدير شركة نقل العقيق ١١ حافلة عامة.',
    'تدير شركة نقل العقيق ١١ مركبة خاصة.'],
  ['promotion', 'من أخرج فيلم شباك الليل؟',
    'أخرجت ريم خليل فيلم شباك الليل. روّجت شركة الشرفة لفيلم شباك الليل.',
    'أخرجت ريم خليل فيلم شباك الليل.', 'أخرجت شركة الشرفة فيلم شباك الليل.',
    'أخرجت ريم خليل فيلم شباك الليل. كتب السيناريو عمر ناصر.'],
  ['radius', 'كم يبلغ نصف قطر عجلة المنارة؟',
    'يبلغ نصف قطر عجلة المنارة ٢٨ سنتيمترًا. يبلغ قطرها ٥٦ سنتيمترًا.',
    'يبلغ نصف قطر عجلة المنارة ٢٨ سنتيمترًا.', 'يبلغ نصف قطر عجلة المنارة ٥٦ سنتيمترًا.',
    'يبلغ قطر عجلة المنارة ٥٦ سنتيمترًا.'],
  ['evacuation', 'متى أُخلي حي النخيل الغربي؟',
    'أخلي حي النخيل الغربي في ٢٣ سبتمبر ٢٠١٩. أخلي حي النخيل الشرقي في ٢٤ سبتمبر ٢٠١٩.',
    'أخلي حي النخيل الغربي في ٢٣ سبتمبر ٢٠١٩.', 'أخلي حي النخيل الغربي في ٢٤ سبتمبر ٢٠١٩.',
    'أخلي حي النخيل الشرقي في ٢٤ سبتمبر ٢٠١٩.', 'أخلي حي النخيل الغربي في ٢٣ سبتمبر ٢٠١٩.'],
  ['weatherproof', 'هل طلاء الندى عازل للماء؟',
    'طلاء الندى عازل للماء. طلاء الغد مقاوم للرذاذ فقط.',
    'طلاء الندى عازل للماء.', 'طلاء الندى مقاوم للرذاذ فقط.',
    'طلاء الغد مقاوم للرذاذ فقط.'],
  ['governor', 'من عيّن نور كامل؟',
    'عيّن المحافظ طارق سلام نور كامل. عيّنت نور كامل سامي عادل.',
    'عيّن المحافظ طارق سلام نور كامل.', 'عيّنت نور كامل المحافظ طارق سلام.',
    'عيّنت نور كامل سامي عادل.'],
  ['headcount', 'كم متطوعًا عمل في مكتبة القرنفل؟',
    'عمل في مكتبة القرنفل ١٤ متطوعًا و٥ موظفين بأجر.',
    'عمل في مكتبة القرنفل ١٤ متطوعًا.', 'عمل في مكتبة القرنفل ٥ متطوعين.',
    'عمل في مكتبة القرنفل ١٤ متطوعًا. تمكن جميع المتطوعين من العمل عن بعد.'],
];

const primaryPage = (scenario: string, quote: string): EvidencePage => ({ url: `https://registry.example/${scenario}`, quote });
const independentPage = (scenario: string, quote: string): EvidencePage => ({ url: `https://news.example/${scenario}`, quote });

function scenarioCases(language: TruthCase['language'], records: Scenario[]): TruthCase[] {
  return records.flatMap(([id, question, quote, correct, wrong, wrongAlternative, independentQuote]) => {
    const scenario = `${language}-${id}`;
    const shared = { scenario, question, language, provenance: developmentProvenance, pages: [primaryPage(scenario, quote)] };
    return [
      { ...shared, id: `${scenario}-correct`, reply: correct, correct: true,
        ...(independentQuote ? { secondPage: independentPage(scenario, independentQuote) } : {}) },
      { ...shared, id: `${scenario}-wrong`, reply: wrong, correct: false },
      { ...shared, id: `${scenario}-wrong-alternative`, reply: wrongAlternative, correct: false,
        ...(wrongAlternative.startsWith(`${correct} `) ? { expectedSupported: correct } : {}) },
    ];
  });
}

type CorroborationScenario = [
  id: string,
  language: TruthCase['language'],
  question: string,
  trueQuote: string,
  falseQuote: string,
  independentQuote: string,
  unrelatedQuote: string,
];

// The authored record fixes the known value. A mock source may misreport it, which permits
// measurement of both a wrong answer caught and a correct answer lost to a genuine conflict.
const corroborationScenarios: CorroborationScenario[] = [
  ['ferry-departure', 'en', 'When did the Larch Ferry depart?',
    'The Larch Ferry departed on 16 August 2018.', 'The Larch Ferry departed on 18 August 2018.',
    'The Larch Ferry departed on 16 August 2018. The crossing was calm.', 'The Larch Ferry arrived on 18 August 2018.'],
  ['crane-count', 'en', 'How many cranes does Harrow Port have?',
    'Harrow Port has 12 cranes.', 'Harrow Port has 21 cranes.',
    'Harrow Port has 12 cranes. The wharf is open.', 'Timber Port has 21 cranes.'],
  ['factory-opening', 'en', 'When did Garnet Mill open?',
    'Garnet Mill opened on 20 January 1986.', 'Garnet Mill opened on 20 January 1987.',
    'Garnet Mill opened on 20 January 1986. The first shift began at dawn.', 'Garnet Mill was refurbished in January 1987.'],
  ['school-capacity', 'en', 'How many classrooms does Wren School have?',
    'Wren School has 16 classrooms.', 'Wren School has 19 classrooms.',
    'Wren School has 16 classrooms. Staff offices are separate.', 'Wren School plans to have 19 classrooms after its expansion.'],
  ['ferry-departure', 'ar', 'متى غادرت عبّارة السندس؟',
    'غادرت عبّارة السندس في ١٦ أغسطس ٢٠١٨.', 'غادرت عبّارة السندس في ١٨ أغسطس ٢٠١٨.',
    'غادرت عبّارة السندس في ١٦ أغسطس ٢٠١٨. كان العبور هادئًا.', 'وصلت عبّارة السندس في ١٨ أغسطس ٢٠١٨.'],
  ['crane-count', 'ar', 'كم رافعة في ميناء المرجان؟',
    'في ميناء المرجان ١٢ رافعة.', 'في ميناء المرجان ٢١ رافعة.',
    'في ميناء المرجان ١٢ رافعة. الرصيف مفتوح.', 'في ميناء الموج ٢١ رافعة.'],
  ['factory-opening', 'ar', 'متى افتتح مصنع الياسمين؟',
    'افتتح مصنع الياسمين في ٢٠ يناير ١٩٨٦.', 'افتتح مصنع الياسمين في ٢٠ يناير ١٩٨٧.',
    'افتتح مصنع الياسمين في ٢٠ يناير ١٩٨٦. بدأ العمل عند الفجر.', 'جُدّد مصنع الياسمين في يناير ١٩٨٧.'],
  ['school-capacity', 'ar', 'كم فصلًا دراسيًا في مدرسة السنابل؟',
    'في مدرسة السنابل ١٦ فصلًا دراسيًا.', 'في مدرسة السنابل ١٩ فصلًا دراسيًا.',
    'في مدرسة السنابل ١٦ فصلًا دراسيًا. مكاتب الموظفين في مبنى منفصل.', 'تخطط مدرسة السنابل لرفع العدد إلى ١٩ فصلًا دراسيًا.'],
];

const corroborationCases: TruthCase[] = corroborationScenarios.flatMap(
  ([id, language, question, trueQuote, falseQuote, independentQuote, unrelatedQuote]) => {
    const scenario = `${language}-second-${id}`;
    const shared = { scenario, question, language, provenance: developmentProvenance };
    return [
      { ...shared, id: `${scenario}-confirms`, correct: true, reply: trueQuote,
        pages: [primaryPage(scenario, trueQuote)], secondPage: independentPage(scenario, independentQuote) },
      { ...shared, id: `${scenario}-catches`, correct: false, reply: falseQuote,
        pages: [primaryPage(scenario, falseQuote)], secondPage: independentPage(scenario, independentQuote) },
      { ...shared, id: `${scenario}-disputes-correct`, correct: true, reply: trueQuote,
        pages: [primaryPage(scenario, trueQuote)], secondPage: independentPage(scenario, falseQuote) },
      { ...shared, id: `${scenario}-unrelated`, correct: true, reply: trueQuote,
        pages: [primaryPage(scenario, trueQuote)], secondPage: independentPage(scenario, unrelatedQuote) },
    ];
  },
);

const agentGaps = 'docs/AGENT-GAPS-2026-11-22.md';
const judgeHandover = 'docs/HANDOVER-2026-11-22-JUDGE-SHADOW.md';
const wikipedia = (language: TruthCase['language'], article: string): string =>
  `https://${language}.wikipedia.org/wiki/${encodeURIComponent(article.replaceAll(' ', '_'))}`;

// These are reconstructed regression triples, not copies of the missing live logs. Where a
// tracked test preserves the excerpt it is cited below. The other excerpts are deliberately
// short reconstructions of the reported defect. Reserved hosts denote missing original URLs.
function reconstructedCase(
  id: string, language: TruthCase['language'], question: string, url: string, quote: string,
  provenance: string, reply = quote, correct = false,
): TruthCase {
  return { id, scenario: id, language, question, pages: [{ url, quote }], reply, correct,
    provenance: `${developmentProvenance}; documented reconstruction from ${provenance}` };
}

const recordedWrong = reconstructedCase;

function recordedCorrect(id: string, language: TruthCase['language'], question: string, url: string, quote: string, provenance: string, title?: string): TruthCase {
  const item = reconstructedCase(id, language, question, url, quote, provenance, quote, true);
  return { ...item, pages: [{ url, quote, title }] };
}

const recordedCases: TruthCase[] = [
  recordedWrong('probe-model', 'ar', 'على أي نموذج لغوي تعمل؟', 'https://skill.example/machine-learning',
    'تعلّم الآلة مجال يدرس الخوارزميات التي تتعلم من البيانات.', `${agentGaps}, 22:27 probe (skill named, reply unavailable)`,
    'إليك مهارة تعلّم الآلة.'),
  recordedWrong('probe-private-language', 'ar', 'ما هي لغتي المفضلة؟', 'https://search.example/language',
    'العربية من اللغات الأكثر استعمالًا في المنطقة.', `${agentGaps}, 22:27 probe (wrong route, reply unavailable)`,
    'لغتك المفضّلة هي العربية.'),
  recordedWrong('probe-private-phone', 'ar', 'ما هو رقم جوالي؟', 'https://search.example/telephone',
    'أرقام الجوال في هذه القائمة أرقام للاتصال بخدمة العملاء.', `${agentGaps}, 22:27 probe (wrong route, reply unavailable)`,
    'يمكنك معرفة رقم جوالك من قائمة أرقام الدعم.'),
  recordedWrong('probe-australia-share', 'ar', 'كم عدد سكان أستراليا؟', wikipedia('ar', 'أستراليا'),
    'على الرغم من أن عدد سكان أستراليا يبلغ 0.3% فقط من سكان العالم، ساهمت أستراليا بنسبة 4.1% من الأبحاث المنشورة في العالم عام 2020، ما يجعلها واحدة من أفضل 10 مساهمين في الأبحاث في العالم.',
    `${agentGaps}, 22:27 probe; tests/assistant-population-statement.test.ts`, '0.3% من سكان العالم'),
  recordedWrong('probe-pride-author', 'en', 'Who wrote Pride and Prejudice?', wikipedia('en', 'Dolly Alderton'),
    'Dolly Alderton wrote Everything I Know About Love.', `${agentGaps}, 22:27 probe (page named, reply unavailable)`),
  recordedWrong('gap-bmw-image', 'ar', 'bmw logo — لون أسود على خلفية بيضاء', wikipedia('ar', 'لون'),
    'بالنسبة للمرآة الانعكاس يكون مختلفًا.', `${agentGaps}, rq091 (reply begins with the quoted clause)`),
  recordedWrong('gap-self-capabilities', 'ar', 'ما هي قدراتك؟', 'https://archive.example/book-title',
    'عنوان الكتاب: قدرات الذكاء الاصطناعي.', `${agentGaps}, section 1 (book title used, title and reply unavailable)`),
  recordedWrong('gap-japan-capital-why', 'ar', 'لماذا طوكيو هي العاصمة؟', wikipedia('ar', 'طوكيو'),
    'طوكيو هي عاصمة اليابان.', `${agentGaps}, why-probe limitations (follow-up subject expanded from previous question)`),
  recordedWrong('gap-telephone', 'en', 'Who invented the telephone?', 'https://archive.example/telephone',
    'The captain was John Taylor in 1844.', `${agentGaps}, follow-up probe (person and year recorded, full reply unavailable)`),
  recordedWrong('gap-messi-age', 'ar', 'كم عمر ميسي؟', 'https://archive.example/messi',
    'ورد في المقال عمر ابن ميسي، وهو ١٢ عامًا.', `${agentGaps}, follow-up probe (son named as the subject, age and reply unavailable)`,
    'عمر ابن ميسي ١٢ عامًا.'),
  recordedWrong('gap-germany-cities', 'ar', 'كم عدد سكان ألمانيا؟', wikipedia('ar', 'ألمانيا'),
    'يعيش في ألمانيا أزيد من 83 مليون نسمة. وتضم البلاد 82 مدينة يزيد عدد سكانها عن 100,000 نسمة.',
    `${agentGaps}, 23:53 probe (two figures recorded)`, '82 مدينة يزيد عدد سكانها عن 100,000 نسمة'),
  recordedWrong('gap-canada-growth', 'ar', 'كم عدد سكان كندا؟', wikipedia('ar', 'كندا'),
    'ازداد تعداد سكان كندا بين 1990-2008 بنحو 5.6 مليون أي 20.4% نمو في عدد السكان مقارنة بنحو 21.7% في الولايات المتحدة.',
    `${agentGaps}, 23:53 probe; tests/assistant-population-statement.test.ts`),
  recordedWrong('gap-ur-hamlet', 'en', 'Who wrote Hamlet?', wikipedia('en', 'Hamlet'),
    'In 1936 Andrew Cairncross suggested that, until more becomes known, it may be assumed that Shakespeare wrote the Ur-Hamlet.',
    `${agentGaps}, 23:53 probe; tests/assistant-hands-subject-name.test.ts`),
  recordedWrong('gap-red-sea-name', 'ar', 'لماذا سمي البحر الأحمر بهذا الاسم؟', wikipedia('ar', 'البحر الأحمر'),
    'سمي بحر القلزم بهذا الاسم نسبةً إلى مدينة القلزم.', `${agentGaps}, why probe (explanation for old name recorded)`),
  recordedWrong('gap-sky-film', 'ar', 'ليش السماء زرقاء؟', wikipedia('ar', 'السماء الزرقاء'),
    'السماء الزرقاء فيلم درامي.', `${agentGaps}, why probe (wrong film page, reply unavailable)`),
  recordedWrong('gap-cairo-district', 'ar', 'لماذا سميت القاهرة بهذا الاسم؟', 'https://archive.example/cairo-neighborhood',
    'حيّ الجمالية أحد أحياء القاهرة.', `${agentGaps}, why probe (wrong neighbourhood, reply unavailable)`),
  recordedWrong('gap-sky-redirect', 'en', 'Why is the sky blue?', wikipedia('en', 'Sky_blue'),
    'Color "Sky Blue" redirects here.', `${agentGaps}, why probe (quoted reply)`),
  recordedWrong('gap-sky-gauge', 'ar', 'ما سبب زرقة السماء؟', wikipedia('ar', 'مقياس الزرقة'),
    'مقياس الزرقة', `${agentGaps}, why probe (quoted reply)`),
  recordedWrong('handover-japan-population', 'en', 'How many people live in Japan?', wikipedia('en', 'Japan'),
    'It is part of the Greater Tokyo Area, the biggest metropolitan area in the world with 37.4 million people (2024).',
    `${judgeHandover}, 13:44 probe; tests/assistant-date-questions.test.ts`),
  recordedWrong('handover-egypt-population', 'en', 'How many people live in Egypt?', wikipedia('en', 'Egypt'),
    'Egypt has also drawn international condemnation for mass death sentences, including a 2014 ruling sentencing 529 people to death in a single hearing.',
    `${judgeHandover}, 13:44 probe; tests/assistant-date-questions.test.ts`),
  recordedWrong('handover-algeria-independence', 'ar', 'متى استقلت الجزائر؟', wikipedia('ar', 'الجزائر'),
    'خرجت مظاهرات في الجزائر في 10 ديسمبر 1960.', `${judgeHandover}, 14:26 probe, d5 (event and date recorded)`),
  recordedWrong('handover-berlin-wall', 'en', 'When did the Berlin Wall fall?', wikipedia('en', 'Berlin_Wall'),
    'Germany was reunified on 3 October 1990.', `${judgeHandover}, 14:26 probe, e1 (event and date recorded)`),
  recordedWrong('handover-morocco-population', 'ar', 'كم عدد سكان المغرب؟', wikipedia('ar', 'صباح (المغرب)'),
    'بلغ مجموع عدد سكان صباح (المغرب) حسب إحصاءات 2004 حوالي 12912 نسمة يعيشون في 2229 أسرة.',
    `${judgeHandover}, 06:10 probe; tests/assistant-judge.test.ts`),
  recordedWrong('handover-japan-travel', 'en', 'What is the best time to visit Japan?', wikipedia('en', 'The_Third_Murder'),
    'The trio visit Misumi again, this time showing him a magazine he may have come across that includes an article about a wife that paid a man to murder her husband for insurance.',
    `${judgeHandover}, 06:13 probe; tests/assistant-hands-page-choice.test.ts`),
  recordedWrong('handover-train-ticket', 'en', 'find train teckit from glasgow to london tomorow', wikipedia('en', 'CrossCountry'),
    '2 trains per day extends to and from Glasgow Central, calling at Haymarket and Motherwell.',
    `${judgeHandover}, rq036; tests/assistant-hands-page-choice.test.ts`),
  recordedWrong('handover-berat-battle', 'ar', 'كم تستغرق عملية المياه البيضاء؟', wikipedia('ar', 'معركة المياه البيضاء'),
    'معركة المياة البيضاء جزء من الحروب العثمانية في أوروبا والحروب العثمانية الألبانية التاريخ 2 سبتمبر 1457م /12 شوال 861 هـ الموقع شمال وسط ألبانيا …',
    `${judgeHandover}, rq018; tests/assistant-judge.test.ts`),
  recordedWrong('handover-japan-mountains', 'ar', 'كم عدد سكان اليابان؟', wikipedia('ar', 'اليابان'),
    'تحتل المناطق الجبلية ما يزيد عن 70% من أرض اليابان.', `${judgeHandover}, 08:30 probe (the recorded question was a follow-up about Japan)`),
  recordedCorrect('handover-japan-population-right', 'en', 'How many people live in Japan?', wikipedia('en', 'Japan'),
    "With a population of almost 123 million as of 2026, it is the world's 11th most populous country.",
    `${judgeHandover}, 14:02 and 14:26 probes; tests/assistant-date-questions.test.ts`, 'Japan'),
  recordedCorrect('handover-japan-capital-right', 'ar', 'ما عاصمة اليابان؟', wikipedia('ar', 'طوكيو'),
    'طوكيو هي عاصمة اليابان وأكبر مدنها، وتقع على خليج طوكيو.', `${judgeHandover}, 05:38 probe; tests/assistant-hands-page-choice.test.ts`),
  recordedCorrect('gap-pride-author-right', 'en', 'Who wrote Pride and Prejudice?', wikipedia('en', 'Pride and Prejudice'),
    'Pride and Prejudice is a novel by English author Jane Austen.', `${agentGaps}; tests/assistant-hands-subject-name.test.ts`),
];

const labelledConversions: TruthCase[] = [
  { id: 'en-kilograms-labelled', scenario: 'en-mass-conversion', language: 'en', provenance: developmentProvenance,
    question: 'How much does the Lark Parcel weigh?', pages: [primaryPage('en-mass-conversion', 'The Lark Parcel weighs 2 kilograms.')],
    reply: 'The Lark Parcel weighs 2,000 grams (converted from 2 kilograms).', correct: true },
  { id: 'en-kilograms-unlabelled', scenario: 'en-mass-conversion', language: 'en', provenance: developmentProvenance,
    question: 'How much does the Lark Parcel weigh?', pages: [primaryPage('en-mass-conversion', 'The Lark Parcel weighs 2 kilograms.')],
    reply: 'The Lark Parcel weighs 2,000 grams.', correct: true },
  { id: 'ar-kilograms-labelled', scenario: 'ar-mass-conversion', language: 'ar', provenance: developmentProvenance,
    question: 'كم يبلغ وزن طرد الرمان؟', pages: [primaryPage('ar-mass-conversion', 'يبلغ وزن طرد الرمان ٤ كيلوغرامات.')],
    reply: 'يبلغ وزن طرد الرمان ٤٠٠٠ غرام (تحويلًا من ٤ كيلوغرامات).', correct: true },
  { id: 'ar-kilograms-arithmetic', scenario: 'ar-mass-conversion', language: 'ar', provenance: developmentProvenance,
    question: 'كم يبلغ وزن طرد الرمان؟', pages: [primaryPage('ar-mass-conversion', 'يبلغ وزن طرد الرمان ٤ كيلوغرامات.')],
    reply: 'يبلغ وزن طرد الرمان ٤٠٠ غرام (تحويلًا من ٤ كيلوغرامات).', correct: false },
];

export const truthCases: TruthCase[] = [
  ...scenarioCases('en', english),
  ...scenarioCases('ar', arabic),
  ...corroborationCases,
  ...labelledConversions,
  ...recordedCases,
];
