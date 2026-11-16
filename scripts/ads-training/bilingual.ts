/** Synthetic bilingual training examples. Labels come from construction, never model output. */
import { createHash } from 'node:crypto';
import { canonicalJson, rng } from './lib.js';
import { checkGoal, type Goal, type Currency } from './goal.js';
import { goalToPointer, pointerToGoal, renderGoalPointerPrompt, GOAL_POINTER_CAPABILITY } from './pointer.js';

export type Language = 'en' | 'ar';
export interface BilingualRow {
  id: string; capability: string; language: Language; family: string; split: string;
  source: 'synthetic'; input: { message: string }; output: Goal; prompt: string; target: string;
}
const VOCAB = {
  en: {
    services: ['mobile tyre fitting', 'house removals', 'plumbing', 'locksmith', 'hair salon', 'carpet cleaning', 'window cleaning', 'roof repairs', 'electrician', 'dental clinic', 'physiotherapy', 'yoga lessons', 'personal training', 'driving lessons', 'math tutoring', 'accountancy', 'web design', 'wedding photography', 'flower delivery', 'bakery', 'coffee shop', 'car repairs', 'mot testing', 'car valeting', 'solar panel installation', 'boiler repairs', 'gardening', 'landscaping', 'pest control', 'skip hire', 'storage', 'nail salon', 'beauty treatments', 'massage therapy', 'pet sitting', 'dog walking', 'veterinary care', 'opticians', 'pharmacy', 'estate agency', 'translation services', 'printing', 'sign making', 'gym classes', 'martial arts lessons', 'dance classes', 'music lessons', 'childcare', 'home care', 'taxi service', 'airport transfers', 'courier service', 'van hire', 'kitchen fitting', 'bathroom fitting', 'flooring', 'painting and decorating', 'plastering', 'tree surgery', 'handyman services', 'appliance repair', 'phone repairs', 'computer repairs', 'it support', 'catering', 'event planning', 'furniture shop', 'clothing shop', 'jewellery', 'skincare products', 'pet food', 'online courses', 'accounting software'],
    places: ['Glasgow', 'London', 'Leeds', 'Bristol', 'Manchester', 'Oxford', 'Liverpool', 'York', 'Newcastle', 'Edinburgh', 'Belfast', 'Cardiff', 'Cambridge', 'Brighton', 'Nottingham', 'Dubai', 'Riyadh', 'Cairo', 'Amman', 'Abu Dhabi', 'New York', 'Los Angeles', 'Sydney', 'Toronto'],
    modifiers: ['local', 'mobile', 'commercial', 'residential', 'professional', 'emergency', 'private', 'weekend'],
    openings: ['create a Google Ads campaign', 'make a search ad campaign', 'I need Google ads', 'please set up advertising on Google', 'help me launch a search campaign', 'I want to advertise on Google', 'can you build a campaign for me', 'start Google advertising', 'we would like a Google Ads campaign', 'prepare a search campaign', 'I need a new advertising campaign', 'put together Google ads', 'could you make ads on Google', 'help me promote my business on Google', 'I would like to run a Google campaign', 'we need a paid search campaign'],
    validation: ['could you arrange a search advertising campaign', 'please prepare advertising for Google search', 'we are ready to start a Google Ads campaign', 'I am looking to get a campaign on Google running'],
    other: ['What is Google Ads?', 'Explain how advertising budgets work', 'Do not create a campaign', 'I only want to review my existing ads', 'Stop the current campaign', 'Translate this sentence into Arabic', 'Write a TypeScript function to add two numbers', 'How is the weather today?', 'Show me yesterday campaign results', 'Change my account password', 'I do not want to launch ads yet', 'Please explain cost per click'],
    otherValidation: ['Explain what a search campaign is', 'Cancel my advertising request', 'Do not launch any Google ads', 'Show the statistics of my campaign', 'Please repair my TypeScript code', 'Only review this website, without creating ads', 'How can I change the email address?', 'Translate the following paragraph'],
  },
  ar: {
    services: ['تركيب الإطارات', 'نقل الأثاث', 'السباكة', 'فتح الأقفال', 'صالون حلاقة', 'تنظيف السجاد', 'تنظيف النوافذ', 'إصلاح الأسقف', 'خدمات الكهرباء', 'عيادة أسنان', 'العلاج الطبيعي', 'دروس اليوغا', 'التدريب الشخصي', 'تعليم القيادة', 'دروس الرياضيات', 'المحاسبة', 'تصميم المواقع', 'تصوير حفلات الزفاف', 'توصيل الزهور', 'مخبز', 'مقهى', 'إصلاح السيارات', 'فحص السيارات', 'غسيل السيارات', 'تركيب الطاقة الشمسية', 'إصلاح التدفئة', 'العناية بالحدائق', 'تنسيق الحدائق', 'مكافحة الحشرات', 'تأجير الحاويات', 'التخزين', 'صالون أظافر', 'خدمات التجميل', 'جلسات التدليك', 'رعاية الحيوانات', 'تمشية الكلاب', 'عيادة بيطرية', 'محل نظارات', 'صيدلية', 'وكالة عقارية', 'خدمات الترجمة', 'الطباعة', 'تصميم اللافتات', 'نادي رياضي', 'الفنون القتالية', 'دروس الموسيقى', 'رعاية الأطفال', 'الرعاية المنزلية', 'سيارات الأجرة', 'توصيل المطار', 'توصيل الطرود', 'تأجير السيارات', 'تركيب المطابخ', 'تركيب الحمامات', 'تركيب الأرضيات', 'أعمال الدهان', 'إصلاح الأجهزة', 'صيانة الهواتف', 'صيانة الحواسيب', 'الدعم التقني', 'تقديم الطعام', 'تنظيم المناسبات', 'متجر أثاث', 'متجر ملابس', 'مجوهرات', 'منتجات العناية بالبشرة', 'طعام الحيوانات', 'دورات عبر الإنترنت', 'برامج المحاسبة'],
    places: ['غلاسكو', 'لندن', 'ليدز', 'بريستول', 'مانشستر', 'أكسفورد', 'ليفربول', 'يورك', 'نيوكاسل', 'إدنبرة', 'بلفاست', 'كارديف', 'كامبريدج', 'دبي', 'الرياض', 'القاهرة', 'عمان', 'أبو ظبي', 'جدة', 'الدمام', 'الدوحة', 'الكويت', 'بيروت', 'دمشق'],
    modifiers: ['خدمات', 'أعمال', 'متجر', 'مركز'],
    openings: ['أريد حملة إعلانات على جوجل', 'أنشئ حملة إعلانية', 'جهز لي إعلان بحث على جوجل', 'بدي إعلانات على جوجل', 'اعمل لي حملة جوجل', 'أحتاج إعلان على Google', 'ساعدني في إطلاق حملة إعلانية', 'أبغى حملة إعلانات بحث', 'ممكن تسوي لي حملة على جوجل', 'نريد بدء الإعلان على جوجل', 'أرغب في إنشاء حملة إعلانية', 'حضّر حملة Google Ads', 'عايز أعمل إعلانات جوجل', 'سوي لي حملة بحث', 'أريد الترويج لنشاطي عبر إعلانات جوجل', 'محتاج حملة إعلانية جديدة'],
    validation: ['هل يمكنك إعداد حملة لإعلانات البحث', 'نود إطلاق إعلانات في بحث جوجل', 'رتب لي حملة تسويقية عبر Google Ads', 'أبحث عن مساعدة لإنشاء إعلان جوجل'],
    other: ['ما هي إعلانات جوجل؟', 'اشرح لي كيف تعمل ميزانية الإعلان', 'لا تنشئ حملة إعلانية', 'أريد مراجعة الإعلانات الموجودة فقط', 'أوقف الحملة الحالية', 'ترجم هذه الجملة إلى الإنجليزية', 'اكتب دالة TypeScript تجمع رقمين', 'كيف الطقس اليوم؟', 'أرني نتائج الحملة بالأمس', 'غيّر كلمة المرور', 'لا أريد إطلاق إعلانات الآن', 'اشرح تكلفة النقرة'],
    otherValidation: ['وضح معنى حملة البحث', 'ألغ طلب الإعلان', 'لا تطلق أي إعلان على جوجل', 'اعرض إحصاءات حملتي', 'ساعدني في إصلاح كود TypeScript', 'راجع الموقع فقط دون إنشاء إعلانات', 'كيف أغير البريد الإلكتروني؟', 'ترجم الفقرة التالية'],
  },
};

const EMPTY: Goal = { intent: 'other', url: null, service: null, locations: [], budget: null, goal: null };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const digitScript = (text: string, which: number) => which === 0 ? text : text.replace(/\d/g, d => String.fromCharCode((which === 1 ? 0x660 : 0x6f0) + Number(d))).replace('.', '٫');
const fill = (template: string, value: string) => template.replace('{x}', value);

export function makeBilingualGoals(options: { count: number; split: 'train' | 'validation'; seed: number }): BilingualRow[] {
  const random = rng(options.seed), result: BilingualRow[] = [], seen = new Set<string>();
  for (let attempt = 0; result.length < options.count; attempt++) {
    if (attempt > options.count * 30) throw new Error('Could not create enough distinct goal examples');
    const language: Language = result.length % 2 ? 'ar' : 'en', v = VOCAB[language], ar = language === 'ar';
    let message: string, output: Goal, family: string;
    if (random.next() < 0.12) {
      const prefix = ar ? random.pick(['', 'لو سمحت ', 'مرحبا، ', 'من فضلك ']) : random.pick(['', 'Hi, ', 'Please, ', 'Hello, ']);
      const base = random.pick(options.split === 'train' ? v.other : v.otherValidation);
      // Optional clearly labelled context must not turn a non-create request into campaign creation.
      const context = random.next() < 0.7 ? (ar ? ` موقع النشاط ${random.pick(['north', 'green', 'bright', 'fresh'])}${random.int(900)}.example، المنطقة ${random.pick(v.places)}` : ` Business website ${random.pick(['north', 'green', 'bright', 'fresh'])}${random.int(900)}.example, area ${random.pick(v.places)}`) : '';
      message = prefix + base + context;
      output = { ...EMPTY, locations: [] }; family = 'other';
    } else {
      const parts: string[] = [];
      const openings = options.split === 'train' ? v.openings : v.validation;
      const opening = random.pick(openings);
      family = `${language}-opening-${options.split}-${openings.indexOf(opening)}`;
      parts.push(opening);
      output = { ...EMPTY, intent: 'create_campaign', locations: [] };
      if (random.next() < 0.88) {
        let service = random.pick(v.services);
        if (!ar && random.next() < 0.2) service = `${random.pick(v.modifiers)} ${service}`;
        // Include mixed-language services so a foreign business term stays verbatim.
        if (ar && random.next() < 0.12) service = random.pick(VOCAB.en.services);
        const attached = ar && /\p{Script=Arabic}/u.test(service) && random.next() < 0.3;
        if (attached && service.startsWith('ال')) service = service.slice(2);
        output.service = service;
        parts.push(attached ? `إعلان ل${service}` : fill(random.pick(ar ? ['الخدمة هي {x}', 'نشاطي هو {x}', 'لخدمة {x}', 'لدينا {x}', 'نقدم {x}', 'المجال {x}'] : ['for {x}', 'our service is {x}', 'I offer {x}', 'we sell {x}', 'the business is {x}', 'service: {x}']), service));
      }
      if (random.next() < 0.86) {
        const host = `${random.pick(['north', 'bright', 'green', 'fresh', 'local', 'happy', 'clear', 'blue'])}${random.pick(['studio', 'works', 'homes', 'care', 'shop', 'team'])}${random.int(9999)}.${random.pick(['co.uk', 'com', 'net', 'org', 'ae', 'sa'])}`;
        output.url = random.pick(['', 'www.', 'https://', 'https://www.']) + host + (random.next() < 0.15 ? '/services' : '');
        parts.push(fill(random.pick(ar ? ['الموقع {x}', 'رابط الموقع {x}', 'موقعي هو {x}', 'عنوان الموقع {x}', 'website {x}'] : ['website {x}', 'my site is {x}', 'URL: {x}', 'for the website {x}', 'the link is {x}', 'website address {x}']), output.url));
      }
      if (random.next() < 0.9) {
        const places = ar && random.next() < 0.1 ? VOCAB.en.places : v.places;
        output.locations = random.sample(places, random.next() < 0.2 ? 3 : random.next() < 0.3 ? 2 : 1);
        const arabicPlaces = /^\p{Script=Arabic}/u.test(output.locations[0]!);
        const text = output.locations.join(ar ? arabicPlaces ? random.pick([' و ', ' و']) : ' و ' : random.pick([' and ', ', ', ' & ']));
        parts.push(ar && arabicPlaces && random.next() < 0.3 ? `ب${text}` : fill(random.pick(ar ? ['في {x}', 'استهدف {x}', 'المنطقة {x}', 'المدن المستهدفة {x}', 'للعملاء في {x}', 'نغطي {x}'] : ['in {x}', 'target {x}', 'locations: {x}', 'for people in {x}', 'serving {x}', 'across {x}', 'around {x}', 'covering {x}']), text));
      }
      if (random.next() < 0.86) {
        const amount = String(random.int(500) + 5) + (random.next() < 0.15 ? random.pick(['.50', '.99', '.25']) : '');
        const period = random.pick(['day', 'week', 'month'] as const), currency = random.pick<Currency | null>(ar ? ['£', '$', '€', 'SAR', 'AED', null] : ['£', '$', '€', null]);
        output.budget = { amount, currency, period };
        const number = ar ? digitScript(amount, random.int(3)) : amount;
        const currencyText = currency === 'SAR' ? 'ريال سعودي' : currency === 'AED' ? 'درهم إماراتي' : currency ?? '';
        const money = currency && ['£', '$', '€'].includes(currency) ? currencyText + number : `${number} ${currencyText}`.trim();
        const units = ar ? { day: ['يوميا', 'يومياً', 'كل يوم', 'في اليوم'], week: ['أسبوعيا', 'أسبوعياً', 'كل أسبوع'], month: ['شهريا', 'شهرياً', 'كل شهر'] } : { day: ['per day', 'a day', 'daily', 'each day'], week: ['per week', 'weekly', 'each week'], month: ['per month', 'monthly', 'each month'] };
        parts.push(`${random.pick(ar ? ['الميزانية', 'ميزانيتي', 'أخصص', 'بميزانية'] : ['budget', 'my budget is', 'we can spend', 'with a budget of'])} ${money} ${random.pick(units[period])}`);
      }
      if (random.next() < 0.7) {
        const goal = random.pick(['calls', 'bookings', 'leads'] as const); output.goal = goal;
        const phrases = ar ? { calls: ['هدفي مكالمات', 'أريد اتصالات', 'نريد مكالمات هاتفية'], bookings: ['الهدف حجوزات', 'أريد مواعيد', 'نريد حجوزات جديدة'], leads: ['أريد طلبات تواصل', 'الهدف استفسارات', 'نريد طلبات عروض أسعار'] } : { calls: ['I want phone calls', 'goal: calls', 'make the phone ring'], bookings: ['I need bookings', 'goal: appointments', 'we want more reservations'], leads: ['I want leads', 'goal: enquiries', 'we need quote requests'] };
        parts.push(random.pick(phrases[goal]));
      }
      // Clause order varies independently of task values. No field is inferred from domain vocabulary.
      const body = random.next() < 0.65 ? random.sample(parts, parts.length) : parts;
      message = body.join(random.pick(ar ? ['، ', ' - ', '. ', ' ؛ '] : [', ', ' - ', '. ', '; '])) + random.pick(ar ? ['', ' من فضلك', ' شكرا'] : ['', ' please', ' thanks']);
    }
    const id = hash(message).slice(0, 24);
    if (seen.has(id)) continue;
    const target = goalToPointer(message, output);
    if (!target) throw new Error(`Unrepresentable synthetic label: ${message}`);
    const back = pointerToGoal(message, target);
    const issues = checkGoal(message, output);
    if (!back || canonicalJson(back) !== canonicalJson(output) || issues.length) throw new Error(`Invalid synthetic label (${issues.join(',')}): ${message}\n${JSON.stringify(output)}`);
    seen.add(id);
    result.push({ id, capability: GOAL_POINTER_CAPABILITY, language, family, split: options.split, source: 'synthetic', input: { message }, output, prompt: renderGoalPointerPrompt(message), target });
  }
  return result;
}
