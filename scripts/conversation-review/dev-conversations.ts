// Development evaluation only. Cases are assembled by deterministic TypeScript functions from
// explicit templates and values, with no model or API calls. Never use these cases for training.

export const corpusProvenance = {
  split: 'development-evaluation',
  method: 'deterministic templates',
  modelCalls: 0,
  apiCalls: 0,
  trainingAllowed: false,
} as const;

export const checks = ['contradiction', 'coverage', 'commitments', 'corrections', 'preferences', 'repetition'] as const;
export type Check = typeof checks[number];
export type Language = 'ar' | 'en';

export interface DevelopmentConversation {
  id: string;
  language: Language;
  messages: { id: string; role: 'assistant' | 'user'; content: string }[];
  draft: string;
  expected: Check[];
}

interface Scenario {
  check: Check;
  history: string[];
  acceptedHistory?: string[];
  rejected: string;
  accepted: string;
}

interface Setting {
  id: string;
  topic: string;
  field: string;
  before: string;
  after: string;
  mistaken: string;
  intended: string;
  name: string;
  misspelling: string;
}

function setting(
  id: string, topic: string, field: string, before: string, after: string,
  mistaken: string, intended: string, name: string, misspelling: string,
): Setting {
  return { id, topic, field, before, after, mistaken, intended, name, misspelling };
}

const english = [
  setting('library', 'library', 'capacity', '24 seats', '30 seats', 'holiday hours', 'lending rules', 'Sara', 'Sarah'),
  setting('gallery', 'gallery', 'opening date', '2027-01-12', '2027-01-19', 'ticket prices', 'room layout', 'Mina', 'Meena'),
  setting('shelter', 'shelter', 'coordinator', 'Nora', 'Tariq', 'pet adoption', 'volunteer shifts', 'Kareem', 'Karim'),
  setting('archive', 'archive', 'status', 'closed', 'open', 'public exhibits', 'photo preservation', 'Lina', 'Leena'),
  setting('clinic', 'clinic', 'budget', '900 dollars', '1,200 dollars', 'medication costs', 'appointment booking', 'Ilyas', 'Elias'),
  setting('orchard', 'orchard', 'harvest date', '2027-02-03', '2027-02-18', 'equipment repairs', 'fruit storage', 'Yasmin', 'Yasmine'),
  setting('cafeteria', 'cafeteria', 'manager', 'Sofia', 'April', 'menu planning', 'food safety', 'Noor', 'Nour'),
  setting('school', 'school', 'decision', 'approved', 'rejected', 'exam grading', 'school transport', 'Amir', 'Ameer'),
  setting('museum', 'museum', 'attendance', '450 visitors', '540 visitors', 'building repairs', 'artifact cataloguing', 'Layla', 'Leila'),
  setting('workshop', 'workshop', 'deadline', '2027-04-07', '2027-04-21', 'pricing tiers', 'material handling', 'Mariam', 'Maryam'),
  setting('theater', 'theater', 'lead', 'Faye', 'Maya', 'stage lighting', 'costume fitting', 'Adnan', 'Adnaan'),
  setting('lab', 'lab', 'status', 'inactive', 'active', 'sample transport', 'instrument calibration', 'Rami', 'Ramy'),
];

const arabic = [
  setting('library', 'المكتبة', 'السعة', '٣٢ مقعدًا', '٤٠ مقعدًا', 'ساعات الدوام', 'شروط الاستعارة', 'ليان', 'لين'),
  setting('gallery', 'المعرض', 'موعد الافتتاح', '2027-01-08', '2027-01-22', 'بيع التذاكر', 'توزيع القاعات', 'سارة', 'ساره'),
  setting('shelter', 'المأوى', 'المنسق', 'هالة', 'باسل', 'طلبات التبني', 'مناوبات المتطوعين', 'علياء', 'عليا'),
  setting('archive', 'الأرشيف', 'الحالة', 'مغلق', 'مفتوح', 'معارض الزوار', 'حفظ الصور', 'نهى', 'نها'),
  setting('clinic', 'العيادة', 'الميزانية', '١٢٠٠ ريال', '١٦٠٠ ريال', 'تكلفة الدواء', 'حجز المواعيد', 'لؤي', 'لوي'),
  setting('orchard', 'البستان', 'موعد الحصاد', '2027-02-11', '2027-02-25', 'إصلاح المعدات', 'تخزين الثمار', 'إياد', 'أياد'),
  setting('cafeteria', 'المقصف', 'المسؤول', 'زيد', 'سامر', 'قائمة الوجبات', 'سلامة الطعام', 'هدى', 'هدا'),
  setting('school', 'المدرسة', 'القرار', 'مقبول', 'مرفوض', 'تصحيح الامتحانات', 'النقل المدرسي', 'رُبى', 'ربا'),
  setting('museum', 'المتحف', 'عدد الزوار', '٥١٠ زوار', '٦٢٠ زائرًا', 'ترميم المبنى', 'فهرسة القطع', 'زُهى', 'زها'),
  setting('workshop', 'الورشة', 'الموعد النهائي', '2027-04-06', '2027-04-20', 'تسعيرة الدورات', 'التعامل مع المواد', 'مريم', 'مريَم'),
  setting('theater', 'المسرح', 'المدير', 'رباب', 'ريم', 'إضاءة الخشبة', 'قياس الأزياء', 'يحيى', 'يحي'),
  setting('lab', 'المختبر', 'الحالة', 'متوقف', 'قيد العمل', 'نقل العينات', 'معايرة الأجهزة', 'آدم', 'ادم'),
];

function englishPreference(s: Setting, index: number): Pick<Scenario, 'history' | 'rejected' | 'accepted'> {
  const turn = `Please greet me at the ${s.topic}.`;
  switch (index % 6) {
    case 0:
      return { history: [
        ...(index === 6 ? [`My name is ${s.misspelling}.`, `Hello, ${s.misspelling}.`] : []),
        `My name is ${s.name}. Always spell it ${s.name}.`, `Understood, ${s.name}.`, turn],
        rejected: `Hello, ${s.misspelling}!`, accepted: `Hello, ${s.name}!` };
    case 1:
      return { history: ['Please always reply in English.', 'Understood.', turn],
        rejected: 'أهلًا وسهلًا بك!', accepted: 'Welcome!' };
    case 2:
      return { history: ['Keep all replies to at most 5 words.', 'Understood.', turn],
        rejected: `Welcome to our lovely and newly renovated ${s.topic}!`, accepted: `Welcome to the ${s.topic}!` };
    case 3:
      return { history: ['Always answer in bullet points.', '- Understood.', turn],
        rejected: `Welcome to the ${s.topic}!`, accepted: `- Welcome to the ${s.topic}!` };
    case 4:
      return { history: ['Use kilometers for distance in every reply.', 'Understood.',
        `How far is the ${s.topic}? The sign shows 8.047 kilometers (5 miles).`],
        rejected: `The ${s.topic} is 5 miles away.`, accepted: `The ${s.topic} is 8.047 kilometers away.` };
    default:
      return { history: ['Please avoid the phrase "as per your request" in every reply.', 'Understood.', turn],
        rejected: `As per your request, welcome to the ${s.topic}!`, accepted: `Welcome to the ${s.topic}!` };
  }
}

function arabicPreference(s: Setting, index: number): Pick<Scenario, 'history' | 'rejected' | 'accepted'> {
  const turn = `ألقِ عليّ التحية في ${s.topic}.`;
  switch (index % 6) {
    case 0:
      return { history: [
        ...(index === 6 ? [`اسمي ${s.misspelling}.`, `أهلًا يا ${s.misspelling}.`] : []),
        `اسمي ${s.name}. اكتب اسمي دائمًا ${s.name}.`, `حاضر يا ${s.name}.`, turn],
        rejected: `أهلًا يا ${s.misspelling}!`, accepted: `أهلًا يا ${s.name}!` };
    case 1:
      return { history: ['أجبني بالعربية دائمًا من فضلك.', 'حاضر.', turn],
        rejected: 'Welcome, it is good to see you.', accepted: 'أهلًا وسهلًا بك!' };
    case 2:
      return { history: ['لا تتجاوز ٥ كلمات في أي رد.', 'حاضر.', turn],
        rejected: `نرحب بك اليوم أجمل ترحيب في مقر ${s.topic} الجديد!`, accepted: `أهلًا بك في ${s.topic}!` };
    case 3:
      return { history: ['أجب دائمًا في نقاط.', '- حاضر.', turn],
        rejected: `أهلًا بك في ${s.topic}!`, accepted: `- أهلًا بك في ${s.topic}!` };
    case 4:
      return { history: ['استخدم الكيلومترات للمسافة في كل رد.', 'حاضر.',
        `ما المسافة إلى ${s.topic}؟ تعرض اللوحة ٨٫٠٤٧ كيلومتر (٥ أميال).`],
        rejected: `المسافة إلى ${s.topic} ٥ أميال.`, accepted: `المسافة إلى ${s.topic} ٨٫٠٤٧ كيلومتر.` };
    default:
      return { history: ['تجنب عبارة «كما طلبت» في كل رد.', 'حاضر.', turn],
        rejected: `كما طلبت، أهلًا بك في ${s.topic}!`, accepted: `أهلًا بك في ${s.topic}!` };
  }
}

function englishScenarios(s: Setting, index: number): Scenario[] {
  const claim = (value: string) => [
    `${s.topic} ${s.field}: ${value}.`,
    `The ${s.field} for the ${s.topic} is ${value}.`,
    `The ${s.topic} ${s.field} is ${value}.`,
  ][index % 3];
  const factHistory = [`What is the ${s.field} of the ${s.topic}?`, claim(s.before)];
  const update = `What is the current ${s.field} for the ${s.topic}?`;
  const request = [
    'Give me the delivery address and the contact phone number.',
    'What is the delivery address? What is the contact phone number?',
    'Please list:\n1. The delivery address\n2. The contact phone number',
  ][index % 3];
  const street = `${10 + index} Cedar Lane`;
  const address = `Delivery address: ${street}.`;
  const phone = `202-555-01${String(index).padStart(2, '0')}`;
  const task = ['supply list', 'volunteer roster', 'setup checklist'][index % 3];
  const priorProposal = `Use a shared calendar to coordinate ${s.topic} visits. Let visitors reserve time slots.`;
  const correction = [
    `No, I meant ${s.intended}, not ${s.mistaken}.`,
    `That's wrong. I asked about ${s.intended}, not ${s.mistaken}.`,
    `Correction: the topic is ${s.intended}, not ${s.mistaken}.`,
  ][index % 3];
  return [
    { check: 'contradiction', history: [...factHistory, update],
      acceptedHistory: [...factHistory, `The official update changes the ${s.field} from ${s.before} to ${s.after}. ${claim(s.after)} ${update}`],
      rejected: claim(s.after), accepted: claim(s.after) },
    { check: 'coverage', history: [`Help me track deliveries for the ${s.topic}.`, `The shipping form lists ${street} and ${phone}.`, request],
      rejected: address, accepted: `${address} ${index % 2 ? 'I’ll provide the contact phone number later.' : `Contact phone number: ${phone}.`}` },
    { check: 'commitments', history: [`How is the ${s.topic} event plan coming along?`,
      `The outline is ready. ${index % 2 ? 'I’ll' : 'I will'} include the ${task} in my next event update.`,
      ...(index % 3 === 2 ? ['What do you mean by an outline?', 'An outline lists the main topics in order.'] : []),
      'What is the next step for the event?'], rejected: 'Review the event outline first.',
      accepted: `Review the event outline first. ${index % 3 === 1 ? `The ${task} is still pending.`
        : `${task[0].toUpperCase() + task.slice(1)}: ${['markers and labels', 'Nadia and Iman', 'check the door and chairs'][index % 3]}.`}` },
    { check: 'corrections', history: [`What topic did I mean for the ${s.topic} handout?`, `The handout focuses on ${s.mistaken}.`, `${correction} Please state the intended subject.`],
      rejected: `The requested subject is ${s.mistaken}.`, accepted: `The requested subject is ${s.intended}.` },
    { check: 'preferences', ...englishPreference(s, index) },
    { check: 'repetition', history: [`Suggest a way to coordinate ${s.topic} visits.`, priorProposal,
      ['I rejected that answer. Give me a different approach.', "That doesn't work for me. Suggest another approach.",
        'No, please try a different idea.'][index % 3],
      ...(index % 2 ? ['Try a staffed walk-in desk.', 'Can you suggest one more approach?'] : [])],
      rejected: index % 2 ? priorProposal.replace('. ', '\n\n') : priorProposal,
      accepted: 'Set up a dedicated phone line so visitors can book by calling.' },
  ];
}

function arabicScenarios(s: Setting, index: number): Scenario[] {
  const pronoun = ['السعة', 'الميزانية', 'الحالة'].includes(s.field) ? 'هي' : 'هو';
  const claim = (value: string) => [
    `${s.field} في ${s.topic}: ${value}.`,
    `${s.field} لجهة ${s.topic} ${pronoun} ${value}.`,
    `${s.field} في ${s.topic} ${pronoun} ${value}.`,
  ][index % 3];
  const factHistory = [`ما ${s.field} في ${s.topic}؟`, claim(s.before)];
  const update = `ما آخر تحديث عن ${s.field} في ${s.topic}؟`;
  const request = [
    'أعطني عنوان التسليم ورقم هاتف التواصل.',
    'ما عنوان التسليم؟ وما رقم هاتف التواصل؟',
    'أعطني البيانات التالية:\n١. عنوان التسليم\n٢. رقم هاتف التواصل',
  ][index % 3];
  const streetNumber = String(10 + index).replace(/\d/gu, digit => '٠١٢٣٤٥٦٧٨٩'[Number(digit)]);
  const street = `${streetNumber} شارع الندى`;
  const address = `عنوان التسليم: ${street}.`;
  const phone = `202-555-0${150 + index}`;
  const task = ['قائمة المواد', 'كشف المتطوعين', 'قائمة التجهيز'][index % 3];
  const priorProposal = `استخدم تقويمًا مشتركًا لترتيب زيارات ${s.topic}. دع الزوار يحجزون المواعيد عبره.`;
  const correction = [
    `لا، قصدت ${s.intended} وليس ${s.mistaken}.`,
    `هذا خطأ. سؤالي عن ${s.intended} وليس ${s.mistaken}.`,
    `تصحيح: الموضوع هو ${s.intended} وليس ${s.mistaken}.`,
  ][index % 3];
  return [
    { check: 'contradiction', history: [...factHistory, update],
      acceptedHistory: [...factHistory, `التحديث الرسمي غيّر ${s.field} من ${s.before} إلى ${s.after}. ${claim(s.after)} ${update}`],
      rejected: claim(s.after), accepted: claim(s.after) },
    { check: 'coverage', history: [`ساعدني في متابعة شحنات ${s.topic}.`, `يتضمن نموذج الشحن ${street} والرقم ${phone}.`, request],
      rejected: address, accepted: `${address} ${index % 2 ? 'سأقدّم رقم هاتف التواصل لاحقًا.' : `رقم هاتف التواصل: ${phone}.`}` },
    { check: 'commitments', history: [`أين وصلنا في التحضير لفعالية ${s.topic}؟`,
      `المخطط جاهز. ${index % 2 ? 'سأضيف' : 'سأرفق'} ${task} في تحديث الفعالية التالي.`,
      ...(index % 3 === 2 ? ['ماذا تقصد بالمخطط؟', 'المخطط يرتب الموضوعات الرئيسية.'] : []),
      'ما الخطوة التالية في الفعالية؟'], rejected: 'راجع مخطط الفعالية أولًا.',
      accepted: `راجع مخطط الفعالية أولًا. ${index % 3 === 1 ? `${task} ما زال قيد الانتظار.`
        : `${task}: ${['أقلام وملصقات', 'نادية وإيمان', 'تفقد الباب والكراسي'][index % 3]}.`}` },
    { check: 'corrections', history: [`ما الموضوع الذي قصدته لمنشور ${s.topic}؟`, `يركز المنشور على ${s.mistaken}.`, `${correction} اذكر الموضوع المقصود.`],
      rejected: `الموضوع المطلوب هو ${s.mistaken}.`, accepted: `الموضوع المطلوب هو ${s.intended}.` },
    { check: 'preferences', ...arabicPreference(s, index) },
    { check: 'repetition', history: [`اقترح طريقة لترتيب زيارات ${s.topic}.`, priorProposal,
      ['رفضت هذا الجواب. أعطني طريقة مختلفة.', 'هذا لا يناسبني. اقترح طريقة أخرى.',
        'لا، جرّب فكرة ثانية من فضلك.'][index % 3],
      ...(index % 2 ? ['خصّص مكتب استقبال للزيارات المباشرة.', 'هل تقترح طريقة إضافية؟'] : [])],
      rejected: index % 2 ? priorProposal.replace('. ', '\n\n') : priorProposal,
      accepted: 'خصّص رقم هاتف للزوار كي يتصلوا ويحجزوا موعدًا.' },
  ];
}

function buildConversations(
  language: Language, settings: Setting[], scenarios: (s: Setting, index: number) => Scenario[],
): DevelopmentConversation[] {
  return settings.flatMap((s, index) => scenarios(s, index).flatMap((scenario) => {
    const build = (clean: boolean): DevelopmentConversation => {
      const id = `${language}-${s.id}-${scenario.check}-${clean ? 'clean' : 'issue'}`;
      const history = clean ? scenario.acceptedHistory ?? scenario.history : scenario.history;
      return {
        id, language,
        messages: history.map((content, turn) => ({ id: `${id}-${turn}`, role: turn % 2 ? 'assistant' : 'user', content })),
        draft: clean ? scenario.accepted : scenario.rejected,
        expected: clean ? [] : [scenario.check],
      };
    };
    return [build(false), build(true)];
  }));
}

export function developmentConversations(): DevelopmentConversation[] {
  return [...buildConversations('en', english, englishScenarios), ...buildConversations('ar', arabic, arabicScenarios)];
}
