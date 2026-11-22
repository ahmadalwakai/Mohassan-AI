import type { SiteBrief, SitePartialBrief, SiteWant } from '@mohassan/contracts';
import { applyAnswers, completeBrief, MAX_ROUNDS, siteQuestion, siteSentence } from '../src/index.ts';

/**
 * Realistic conversations: one opening sentence, then the answers the user would give to each field
 * the planner asks for. Numbers appear only where a real user would type them (phones, prices, facts).
 */
export interface Scenario { id: string; sentence: string; answers: Partial<Record<SiteWant, string>>; note?: string }

export const SCENARIOS: readonly Scenario[] = [
  { id: 'services-ar', sentence: 'أريد موقعاً لشركة تنظيف اسمها «لمعة» في الرياض، فيه قسم الفريق والأسئلة الشائعة ونموذج تواصل', answers: {
    items: 'تنظيف المنازل - 250 ريال\nتنظيف السجاد والكنب - 150 ريال\nتنظيف ما بعد البناء\nتعقيم وتطهير',
    contact: '0501234567 واتساب\ninfo@lamaa.sa',
    team: 'أبو فهد - مشرف الفرق - خبير تنظيف المباني\nسالم - فني تعقيم',
    faq: 'هل تحضرون المعدات؟\nنعم، كل المعدات والمواد معنا.\nهل تعملون يوم الجمعة؟\nنعم بعد صلاة الجمعة.',
    colour: 'أزرق',
  } },
  { id: 'services-en', sentence: 'Build me a website for my plumbing business Swift Plumbing in Manchester with pricing and reviews', answers: {
    items: 'Emergency call-outs\nBoiler servicing - £85\nBathroom installation\nLeak repairs',
    contact: '07700 900123 WhatsApp and phone\nhello@swiftplumbing.co.uk',
    pricing: 'Call-out - £60 - first hour, parts extra\nBoiler service - £85 - annual check, safety certificate\nBathroom fit - from £1800 - full installation, tiling',
    testimonials: 'Jane W.: Fixed our leak the same evening.\nTom R.: Clear price, tidy work.',
    city: 'Manchester',
    colour: 'teal',
  } },
  { id: 'restaurant-ar', sentence: 'ابن لي موقع لمطعم «بيت الشام» في دمشق مع القائمة وساعات العمل والخريطة', answers: {
    items: 'شاورما لحم - 25\nفتوش - 12\nكبة مقلية - 18\nمشاوي مشكلة - 60\nعصير ليمون بالنعناع - 8\nكنافة نابلسية - 15',
    contact: '0933123456 واتساب',
    hours: 'السبت إلى الخميس ١٠ صباحاً - ١١ مساءً\nالجمعة ٢ ظهراً - ١١ مساءً',
    colour: 'ذهبي',
  } },
  { id: 'restaurant-en', sentence: 'I want a website for my café called Nook Coffee in Leeds, one page, with opening hours', answers: {
    items: 'Flat white - £3.20\nFilter coffee - £2.80\nCinnamon bun - £3\nAvocado toast - £7.50',
    contact: '0113 496 0123\nhello@nookcoffee.uk',
    hours: 'Mon–Fri 7am–5pm\nSat–Sun 8am–4pm',
  } },
  { id: 'clinic-ar', sentence: 'أنشئ موقعاً لعيادة أسنان اسمها «ابتسامة» في جدة فيه الأطباء والأسئلة الشائعة وحجز عبر واتساب 0551234567', answers: {
    items: 'تقويم الأسنان\nتبييض الأسنان\nزراعة الأسنان\nعلاج اللثة\nأسنان الأطفال',
    team: 'د. سارة العمري - طبيبة أسنان - تخصص تقويم\nد. خالد يوسف - جراح فم وأسنان',
    faq: 'هل الفحص الأول مجاني؟\nالفحص الأول بموعد مسبق، والسعر عند الحجز.\nهل تقبلون التأمين؟\nنعم، التأمينات المذكورة في العيادة.',
    hours: 'السبت إلى الخميس ٩ صباحاً - ٩ مساءً',
  } },
  { id: 'clinic-en', sentence: 'Create a site for Bright Dental clinic in Birmingham with our team and FAQ', answers: {
    items: 'Check-ups\nHygienist visits\nWhitening\nInvisible braces\nEmergency appointments',
    contact: '0121 496 0456\nsmile@brightdental.uk',
    team: 'Dr Amina Shah - Principal dentist - cosmetic dentistry\nLiam Grey - Hygienist',
    faq: 'Do you take NHS patients? We are a private practice.\nIs parking available? Yes, behind the building.',
    hours: 'Mon–Fri 8:30am–6pm\nSat 9am–1pm',
  } },
  { id: 'portfolio-ar', sentence: 'صمم لي موقع لأعمالي كمصورة اسمي «سارة حداد» في عمّان مع المشاريع ومن نحن', answers: {
    items: 'تصوير حفلات الزفاف\nتصوير المنتجات\nبورتريه\nتصوير الفعاليات',
    contact: '0791234567 واتساب\nsara@example.com',
    projects: 'حفل زفاف ليلى وعمر: تغطية كاملة ليوم واحد\nمنتجات مقهى «قهوة البلد»: صور للقائمة\nمعرض فني في عمّان: توثيق الافتتاح',
    about: 'أصوّر منذ تخرّجي من كلية الفنون، وأحبّ الضوء الطبيعي والصور الصادقة. أعمل في عمّان وأسافر للمشاريع الكبيرة.',
  } },
  { id: 'portfolio-en', sentence: 'Make a portfolio site for Omar Design studio in London with projects and about', answers: {
    items: 'Brand identity\nPackaging\nWebsite design\nEditorial layout',
    contact: 'studio@omardesign.co.uk',
    projects: 'Nook Coffee: identity and menu\nGreen Leaf Grocers: packaging range\nCity Dental: website redesign',
    about: 'Omar Design is a small studio in East London. We work with independent businesses on identities that last.',
    colour: 'black',
  } },
  { id: 'catalogue-ar', sentence: 'أريد متجر إلكتروني بسيط لمنتجاتي عطور «ريحان» في الكويت، الطلب عبر واتساب 96551234567', answers: {
    items: 'عطر العود الملكي - 45 د.ك\nمسك الطهارة - 12 د.ك\nعطر الورد الطائفي - 30 د.ك\nبخور معطّر - 8 د.ك\nطقم هدايا - 60 د.ك',
    colour: 'بنفسجي',
  } },
  { id: 'catalogue-en', sentence: 'Build an online catalogue for my shop Linen & Co in Dublin with products and a contact form', answers: {
    items: 'Linen shirt - €65\nLinen trousers - €80\nTable runner - €35\nNapkin set - €28',
    contact: '+353 1 234 5678 WhatsApp\norders@linenandco.ie',
  } },
  { id: 'landing-ar', sentence: 'اعمل لي صفحة هبوط لعرض دورة تسويق اسمها «انطلق» فيها الأسعار والأسئلة الشائعة', answers: {
    offer: 'دورة تسويق رقمي عملية لأصحاب المشاريع الصغيرة، تبدأ أول الشهر',
    items: 'ست جلسات مباشرة\nقالب خطة تسويق\nمتابعة لمدة شهر',
    contact: '0501112222 واتساب',
    pricing: 'الباقة الأساسية - 600 ريال - الجلسات والقالب\nالباقة الكاملة - 900 ريال - الجلسات والقالب ومتابعة فردية',
    faq: 'هل الدورة مسجّلة؟\nالجلسات مباشرة وتُرسل التسجيلات بعدها.\nهل يوجد شهادة؟\nنعم شهادة إتمام.',
  } },
  { id: 'landing-en', sentence: 'I need a landing page for my course Launchpad with pricing, FAQ and testimonials', answers: {
    offer: 'A six-week live course that takes your idea to a first paying customer',
    items: 'Six live sessions\nWeekly feedback\nA private community',
    contact: 'hello@launchpad.example',
    pricing: 'Standard - $400 - sessions and recordings\nMentored - $900 - sessions, recordings, four mentoring calls',
    faq: 'When does it start? The first Monday of next month.\nIs there a refund? Within the first week, yes.',
    testimonials: 'Priya N.: I landed my first client in week four.\nDaniel K.: The feedback alone was worth it.',
  } },
  { id: 'edge-long-name-ar', sentence: 'أريد موقع لشركة اسمها «مؤسسة الأفق الذهبي للمقاولات العامة والتشطيبات الداخلية والخارجية والصيانة» في الدمام', answers: {
    items: 'مقاولات عامة\nتشطيبات داخلية\nصيانة دورية',
    contact: '0138123456',
  }, note: 'name near the 80-character limit' },
  { id: 'edge-email-only-en', sentence: 'Can you make a website for Harbour Accounting in Bristol', answers: {
    items: 'Bookkeeping\nSelf-assessment returns\nVAT returns\nPayroll',
    contact: 'team@harbouraccounting.co.uk',
  }, note: 'no phone, no WhatsApp: goal must be email and the form opens mail' },
  { id: 'edge-many-items-ar', sentence: 'ابن لي موقع لمطعم «المذاق» في حلب مع القائمة الكاملة', answers: {
    items: Array.from({ length: 40 }, (_, index) => `${['حمص', 'متبل', 'فتوش', 'تبولة', 'ورق عنب', 'كبة', 'سمبوسك', 'فتة', 'شاورما', 'كباب', 'شيش طاووق', 'مشاوي', 'فروج', 'منسف', 'مندي', 'كبسة', 'برياني', 'مقلوبة', 'ملوخية', 'بامية', 'فاصولياء', 'يبرق', 'شيخ المحشي', 'كوسا محشي', 'بطاطا محشية', 'كنافة', 'بقلاوة', 'مهلبية', 'أم علي', 'هريسة', 'عصير برتقال', 'عصير ليمون', 'شاي', 'قهوة', 'أيران', 'مياه', 'سلطة يونانية', 'سلطة سيزر', 'شوربة عدس', 'شوربة خضار'][index]} - ${(index + 1) * 5}`).join('\n'),
    contact: '0944123456 واتساب',
    hours: 'يومياً ١١ صباحاً - ١٢ منتصف الليل',
  }, note: 'forty items split between the home page and menu.html' },
  { id: 'edge-single-page-en', sentence: 'Create a single page site for Oak Physio clinic in Cardiff with why us, how it works and our numbers', answers: {
    items: 'Sports injuries\nBack and neck pain\nPost-surgery rehab',
    contact: '029 2018 0123 WhatsApp',
    features: 'HCPC registered physiotherapists\nEvening appointments\nTreatment plans explained in plain words',
    steps: 'Book online or by phone\nAssessment session\nTreatment plan and home exercises',
    facts: '12 - years in Cardiff\n3 - treatment rooms',
  }, note: 'one page with features, steps and user-stated facts' },
  { id: 'edge-bilingual-name-ar', sentence: 'أنشئ موقع لمطعم Sham House في لندن فيه الأخبار', answers: {
    items: 'فتة شامية - £9\nمشاوي - £14\nشاي بالنعناع - £2.50',
    contact: '020 7946 0123 واتساب',
    posts: 'افتتاح الفرع الثاني\nافتتحنا فرعنا الثاني في Edgware Road هذا الأسبوع.\n\nقائمة الشتاء\nأضفنا شوربة العدس والفريكة إلى القائمة.',
  }, note: 'Arabic site with a Latin name and news posts' },
  { id: 'edge-offer-only-en', sentence: 'Make a landing page for our weekend bakery pop-up called Crumb', answers: {
    offer: 'Sourdough and pastries at the Saturday market, pre-order on WhatsApp by Friday night',
    items: 'skip',
    contact: '07700 900987 WhatsApp',
  }, note: 'landing page without an items list' },
];

export interface ScenarioRun { scenario: Scenario; brief: SiteBrief; partial: SitePartialBrief; rounds: number; fieldsAsked: string[]; unanswered: SiteWant[] }

/** Plays a scenario through the planner exactly as the chat would, answering each card from the scenario. */
export function runScenario(scenario: Scenario): ScenarioRun {
  let partial = siteSentence(scenario.sentence);
  if (!partial) throw new Error(`${scenario.id}: sentence not recognised as a site request`);
  const fieldsAsked: string[] = [];
  const unanswered: SiteWant[] = [];
  let rounds = 0;
  while (rounds < MAX_ROUNDS) {
    const question = siteQuestion(partial);
    if (!question) break;
    rounds++;
    const answers: Record<string, string> = {};
    for (const want of question.wants) {
      fieldsAsked.push(want);
      const answer = scenario.answers[want];
      if (answer !== undefined) answers[want] = answer;
      else { unanswered.push(want); answers[want] = 'skip'; }
    }
    partial = applyAnswers(partial, answers);
  }
  const completion = completeBrief(partial, { requestText: scenario.sentence });
  if ('missing' in completion) throw new Error(`${scenario.id}: still missing ${completion.missing.join(', ')} after ${rounds} rounds`);
  return { scenario, brief: completion.brief, partial, rounds, fieldsAsked, unanswered };
}
