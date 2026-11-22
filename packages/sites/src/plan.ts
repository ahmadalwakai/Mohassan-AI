import type { SiteBrief, SiteItem, SiteKind, SiteLang, SitePartialBrief, SiteWant } from '@mohassan/contracts';
import { SiteBriefSchema } from '@mohassan/contracts';
import { buildPages, type PageContent, type PlanOptions } from './families.ts';
import { detectKind, detectRequests } from './recognize.ts';
import { asciiDigits } from './html.ts';
import { findEmail, findNumbers, findUrl, isNone, normalize, parseItems, splitList } from './text.ts';
import { COLOUR_WORDS, KIND_COLOURS, KIND_MOODS, colourFromWord } from './theme.ts';

/** Mirrors ChatQuestionFieldSchema in @mohassan/contracts without importing the chat module. */
export interface SiteQuestionField {
  id: string;
  prompt: string;
  suggestions: { label: string; reason?: string }[];
  multiple?: boolean;
  multiline?: boolean;
  initialValue?: string;
  selected?: number[];
  placeholder?: string;
}
export interface SiteQuestion { prompt: string; fields: SiteQuestionField[]; wants: SiteWant[] }

export const MAX_ROUNDS = 6;
export const KIND_LABELS: Readonly<Record<SiteLang, Readonly<Record<SiteKind, string>>>> = {
  ar: { services: 'خدمات', restaurant: 'مطعم أو كافيه', clinic: 'عيادة', catalogue: 'متجر أو منتجات', portfolio: 'معرض أعمال', landing: 'صفحة هبوط لعرض واحد' },
  en: { services: 'Services', restaurant: 'Restaurant or café', clinic: 'Clinic', catalogue: 'Shop or products', portfolio: 'Portfolio', landing: 'Landing page for one offer' },
};
const KIND_ORDER: readonly SiteKind[] = ['services', 'restaurant', 'clinic', 'catalogue', 'portfolio', 'landing'];
const KIND_NOUN: Readonly<Record<SiteLang, Readonly<Record<SiteKind | 'unknown', string>>>> = {
  ar: { services: 'النشاط', restaurant: 'المطعم', clinic: 'العيادة', catalogue: 'المتجر', portfolio: 'صاحب الأعمال أو الاستوديو', landing: 'العرض أو العلامة', unknown: 'النشاط' },
  en: { services: 'the business', restaurant: 'the restaurant', clinic: 'the clinic', catalogue: 'the shop', portfolio: 'the person or studio', landing: 'the offer or brand', unknown: 'the business' },
};
const ITEMS_PROMPT: Readonly<Record<SiteLang, Readonly<Record<SiteKind | 'unknown', { prompt: string; placeholder: string }>>>> = {
  ar: {
    services: { prompt: 'ما الخدمات التي تقدّمها؟ خدمة في كل سطر، ويمكنك إضافة السعر بعد شرطة.', placeholder: 'مثلاً: تنظيف السجاد - 50\nنقل أثاث\nصيانة مكيفات' },
    restaurant: { prompt: 'ما أبرز أصناف القائمة؟ صنف في كل سطر، والسعر بعد شرطة إن أردت.', placeholder: 'مثلاً: شاورما لحم - 25\nفتوش\nعصير ليمون بالنعناع' },
    clinic: { prompt: 'ما الخدمات أو التخصصات التي تقدّمها العيادة؟ واحدة في كل سطر.', placeholder: 'مثلاً: تقويم الأسنان\nتبييض\nزراعة الأسنان' },
    catalogue: { prompt: 'ما المنتجات التي تعرضها؟ منتج في كل سطر، والسعر بعد شرطة إن أردت.', placeholder: 'مثلاً: عطر العود - 120\nقميص كتان\nحقيبة جلد' },
    portfolio: { prompt: 'ما الأعمال أو المشاريع التي تريد عرضها؟ عمل في كل سطر، ويمكنك إضافة وصف بعد نقطتين.', placeholder: 'مثلاً: هوية بصرية لمقهى: شعار وقائمة\nتصوير حفل زفاف\nموقع لمتجر' },
    landing: { prompt: 'ما الذي يتضمّنه العرض؟ نقطة في كل سطر.', placeholder: 'مثلاً: استشارة أولى\nخطة مكتوبة\nمتابعة لمدة أسبوع' },
    unknown: { prompt: 'ما الذي تقدّمه؟ خدمة أو صنف أو منتج في كل سطر، والسعر بعد شرطة إن أردت.', placeholder: 'مثلاً: تنظيف السجاد - 50\nنقل أثاث' },
  },
  en: {
    services: { prompt: 'Which services do you offer? One per line; add a price after a dash if you like.', placeholder: 'e.g. Carpet cleaning - £50\nFurniture removals\nAC servicing' },
    restaurant: { prompt: 'What are the main items on the menu? One per line; price after a dash if you like.', placeholder: 'e.g. Lamb shawarma - £9\nFattoush\nMint lemonade' },
    clinic: { prompt: 'Which services or specialities does the clinic offer? One per line.', placeholder: 'e.g. Orthodontics\nWhitening\nImplants' },
    catalogue: { prompt: 'Which products do you sell? One per line; price after a dash if you like.', placeholder: 'e.g. Oud perfume - £120\nLinen shirt\nLeather bag' },
    portfolio: { prompt: 'Which works or projects do you want to show? One per line; a description after a colon is welcome.', placeholder: 'e.g. Brand identity for a café: logo and menu\nWedding photography\nWebsite for a shop' },
    landing: { prompt: 'What does the offer include? One point per line.', placeholder: 'e.g. A first consultation\nA written plan\nA week of follow-up' },
    unknown: { prompt: 'What do you offer? One service, dish or product per line; price after a dash if you like.', placeholder: 'e.g. Carpet cleaning - £50\nFurniture removals' },
  },
};
type Prompt = { prompt: string; placeholder: string };
const WANT_PROMPTS: Readonly<Record<SiteLang, Partial<Record<SiteWant, Prompt>>>> = {
  ar: {
    about: { prompt: 'اكتب نص «من نحن» بكلماتك؛ سأضعه كما هو.', placeholder: 'من نحن، ماذا نقدّم، ولمن.' },
    team: { prompt: 'من أعضاء الفريق؟ في كل سطر: الاسم - الدور - نبذة قصيرة (اختيارية).', placeholder: 'مثلاً: د. سارة أحمد - طبيبة أسنان - تخصص تقويم\nمحمد علي - مدير العيادة' },
    faq: { prompt: 'ما الأسئلة الشائعة وأجوبتها؟ سؤال في سطر يليه جوابه في السطر التالي، أو «السؤال؟ الجواب».', placeholder: 'مثلاً: هل تقدّمون خدمة التوصيل؟\nنعم داخل المدينة.\nكيف أحجز؟\nعبر واتساب أو الاتصال.' },
    pricing: { prompt: 'ما الباقات أو الأسعار؟ في كل سطر: اسم الباقة - السعر - ما تتضمّنه مفصولاً بفواصل.', placeholder: 'مثلاً: الأساسية - 200 ريال شهرياً - زيارة أسبوعية، تقرير شهري\nالمتقدمة - 350 ريال شهرياً - زيارتان، دعم هاتفي' },
    projects: { prompt: 'ما المشاريع أو سابقة الأعمال؟ مشروع في كل سطر، ووصف بعد نقطتين إن أردت.', placeholder: 'مثلاً: فيلا في الرياض: تشطيب كامل\nمكتب شركة: تصميم داخلي' },
    features: { prompt: 'ما الذي يميّزكم؟ نقطة في كل سطر، بكلماتك ودون أرقام غير مؤكدة.', placeholder: 'مثلاً: فريق مرخّص\nمواعيد مرنة\nأسعار معلنة مسبقاً' },
    steps: { prompt: 'كيف تعملون مع العميل؟ خطوة في كل سطر بالترتيب.', placeholder: 'مثلاً: تواصل معنا\nزيارة ومعاينة\nتنفيذ وتسليم' },
    facts: { prompt: 'ما الأرقام التي تريد عرضها؟ في كل سطر: الرقم - وصفه. سأعرض ما تكتبه فقط.', placeholder: 'مثلاً: 500 - عميل\n12 - سنة في السوق' },
    testimonials: { prompt: 'ما آراء عملائك الحقيقية؟ في كل سطر: الاسم: الرأي. لن أكتب رأياً من عندي.', placeholder: 'مثلاً: أبو خالد: خدمة سريعة ومرتبة.' },
    posts: { prompt: 'ما الأخبار أو المقالات؟ لكل خبر: العنوان في سطر ثم نصه في الأسطر التالية، وافصل بين الأخبار بسطر فارغ.', placeholder: 'مثلاً: افتتاح فرع جديد\nافتتحنا فرعنا الثاني في حي النزهة.\n\nمواعيد العيد\nنعمل من العاشرة حتى الثانية.' },
    hours: { prompt: 'ما ساعات العمل؟ سطر لكل فترة.', placeholder: 'مثلاً: السبت إلى الخميس ١٠ صباحاً - ١١ مساءً\nالجمعة ٤ عصراً - ١١ مساءً' },
    offer: { prompt: 'ما العرض في جملة واحدة كما تريد أن يقرأه الزائر؟', placeholder: 'مثلاً: استشارة تسويقية أولى مجانية هذا الشهر' },
    city: { prompt: 'في أي مدينة أو منطقة تخدم؟ (اختياري)', placeholder: 'مثلاً: دمشق' },
    tagline: { prompt: 'جملة تعريفية قصيرة تظهر تحت الاسم (اختياري).', placeholder: 'مثلاً: خدمات تنظيف للمنازل والمكاتب' },
    address: { prompt: 'ما العنوان الذي يظهر في صفحة التواصل؟ (اختياري)', placeholder: 'مثلاً: شارع الملك فهد، مبنى 12' },
  },
  en: {
    about: { prompt: 'Write the about text in your words; it goes in as is.', placeholder: 'Who you are, what you do, and for whom.' },
    team: { prompt: 'Who is on the team? One per line: Name - Role - short bio (optional).', placeholder: 'e.g. Dr Sarah Ahmed - Dentist - orthodontics\nMohammed Ali - Clinic manager' },
    faq: { prompt: 'Which questions and answers? A question on one line and its answer on the next, or "Question? Answer".', placeholder: 'e.g. Do you deliver?\nYes, within the city.\nHow do I book?\nBy WhatsApp or phone.' },
    pricing: { prompt: 'Which plans or prices? One per line: Plan name - Price - what it includes, separated by commas.', placeholder: 'e.g. Basic - £200 a month - weekly visit, monthly report\nPlus - £350 a month - two visits, phone support' },
    projects: { prompt: 'Which projects or past work? One per line; a description after a colon if you like.', placeholder: 'e.g. Villa in Riyadh: full finishing\nCompany office: interior design' },
    features: { prompt: 'What sets you apart? One point per line, in your words, without unconfirmed numbers.', placeholder: 'e.g. Licensed team\nFlexible appointments\nPrices agreed up front' },
    steps: { prompt: 'How do you work with a client? One step per line, in order.', placeholder: 'e.g. Get in touch\nVisit and assessment\nWork and handover' },
    facts: { prompt: 'Which numbers do you want to show? One per line: number - what it counts. Only what you write is shown.', placeholder: 'e.g. 500 - clients\n12 - years in business' },
    testimonials: { prompt: 'Real reviews from your customers? One per line: Name: quote. I will not write any myself.', placeholder: 'e.g. Sam K.: Quick and tidy service.' },
    posts: { prompt: 'Which news or articles? For each: the title on one line, then its text; separate posts with an empty line.', placeholder: 'e.g. New branch opened\nWe opened our second branch in Didsbury.\n\nHoliday hours\nWe are open ten to two.' },
    hours: { prompt: 'Opening hours? One line per period.', placeholder: 'e.g. Mon–Sat 10am–11pm\nSun 4pm–11pm' },
    offer: { prompt: 'What is the offer, in one sentence as the visitor should read it?', placeholder: 'e.g. A free first marketing consultation this month' },
    city: { prompt: 'Which city or area do you serve? (optional)', placeholder: 'e.g. Manchester' },
    tagline: { prompt: 'A short line under the name (optional).', placeholder: 'e.g. Cleaning for homes and offices' },
    address: { prompt: 'Which address should the contact page show? (optional)', placeholder: 'e.g. 12 King Street' },
  },
};

const hasContact = (partial: SitePartialBrief) => Boolean(partial.phone || partial.whatsapp || partial.email);
const hasContent = (partial: SitePartialBrief, want: SiteWant): boolean => {
  switch (want) {
    case 'name': return Boolean(partial.name);
    case 'kind': return Boolean(partial.kind);
    case 'contact': return hasContact(partial);
    case 'items': return Boolean(partial.items?.length);
    case 'city': return Boolean(partial.city);
    case 'hours': return Boolean(partial.hours?.length);
    case 'offer': return Boolean(partial.offer);
    case 'colour': return Boolean(partial.primary);
    case 'about': return Boolean(partial.about);
    case 'tagline': return Boolean(partial.tagline);
    case 'address': return Boolean(partial.address);
    default: { const value = (partial as unknown as Record<string, unknown>)[want]; return Array.isArray(value) && value.length > 0; }
  }
};
const ESSENTIAL: readonly SiteWant[] = ['name', 'kind', 'contact'];

/**
 * What the builder still needs, most important first: identity and contact, the main offering, then
 * every requested block without content, then optional details while the first card has room.
 */
export function missingWants(partial: SitePartialBrief): SiteWant[] {
  const skipped = new Set(partial.skipped);
  const missing: SiteWant[] = [];
  for (const want of ESSENTIAL) if (!hasContent(partial, want)) missing.push(want);
  if (partial.kind === 'landing') { if (!hasContent(partial, 'offer') && !skipped.has('offer')) missing.push('offer'); }
  if (!hasContent(partial, 'items') && !skipped.has('items')) missing.push('items');
  for (const want of partial.requested) if (!hasContent(partial, want) && !skipped.has(want) && !missing.includes(want)) missing.push(want);
  if (partial.rounds === 0) {
    if (!hasContent(partial, 'city') && !skipped.has('city')) missing.push('city');
    if ((partial.kind === 'restaurant' || partial.kind === 'clinic') && !hasContent(partial, 'hours') && !skipped.has('hours') && !missing.includes('hours')) missing.push('hours');
    if (!hasContent(partial, 'colour') && !skipped.has('colour') && partial.kind !== 'landing') missing.push('colour');
  }
  return missing;
}

function field(partial: SitePartialBrief, want: SiteWant): SiteQuestionField {
  const lang = partial.lang, ar = lang === 'ar';
  const noun = KIND_NOUN[lang][partial.kind ?? 'unknown'];
  if (want === 'name') return { id: 'name', prompt: ar ? `ما اسم ${noun} كما تريده أن يظهر في الموقع؟` : `What is the name of ${noun}, as it should appear on the site?`, suggestions: [], placeholder: ar ? 'الاسم كما يُكتب في اللافتة' : 'The name as written on your sign' };
  if (want === 'kind') return { id: 'kind', prompt: ar ? 'ما نوع الموقع؟' : 'What kind of site is it?', suggestions: KIND_ORDER.map(kind => ({ label: KIND_LABELS[lang][kind] })) };
  if (want === 'contact') return { id: 'contact', prompt: ar ? 'كيف يتواصل معك الزوّار؟ اكتب رقم الهاتف، وإن كان على واتساب أضف كلمة «واتساب» بجانبه، وبريدك إن أردت.' : 'How should visitors reach you? Write the phone number, add the word "WhatsApp" next to it if it is on WhatsApp, and an email if you like.', suggestions: [], multiline: true, placeholder: ar ? 'مثلاً: 0501234567 واتساب\ninfo@example.com' : 'e.g. 07700 900123 WhatsApp\ninfo@example.com' };
  if (want === 'items') { const items = ITEMS_PROMPT[lang][partial.kind ?? 'unknown']; return { id: 'items', prompt: items.prompt, suggestions: [], multiline: true, placeholder: items.placeholder }; }
  if (want === 'colour') {
    const defaultHex = partial.primary ?? KIND_COLOURS[partial.kind ?? 'services']!;
    const options = COLOUR_WORDS.slice(0, 6);
    const selected = options.findIndex(colour => colour.hex === defaultHex);
    return { id: 'colour', prompt: ar ? 'ما اللون الأساسي للموقع؟ اختر لوناً أو اكتب رمزاً سداسياً.' : 'Main colour of the site? Pick one or type a hex code.', suggestions: options.map(colour => ({ label: ar ? colour.ar : colour.en })), ...(selected >= 0 ? { selected: [selected] } : {}), placeholder: ar ? 'مثلاً #1d4ed8' : 'e.g. #1d4ed8' };
  }
  const prompt = WANT_PROMPTS[lang][want]!;
  const multiline = !['city', 'offer', 'tagline', 'address'].includes(want);
  return { id: want, prompt: prompt.prompt, suggestions: [], ...(multiline ? { multiline: true } : {}), placeholder: prompt.placeholder };
}

/** The next card: at most six fields for what is still missing, or null when the brief is complete. */
export function siteQuestion(partial: SitePartialBrief): SiteQuestion | null {
  const missing = missingWants(partial);
  if (!missing.length) return null;
  const ar = partial.lang === 'ar';
  const wants = missing.slice(0, 6);
  const kindLine = partial.kind
    ? (ar ? `فهمتُ أنك تريد موقعاً لـ${KIND_LABELS.ar[partial.kind]}${partial.kindReason ? ` (${partial.kindReason})` : ''}${partial.name ? ` باسم «${partial.name}»` : ''}.` : `I understood you want a ${KIND_LABELS.en[partial.kind].toLocaleLowerCase()} site${partial.kindReason ? ` (${partial.kindReason})` : ''}${partial.name ? ` named "${partial.name}"` : ''}.`)
    : (ar ? 'فهمتُ أنك تريد موقعاً.' : 'I understood you want a website.');
  const requestedLine = partial.requested.length && partial.rounds === 0
    ? (ar ? ` وطلبتَ أيضاً: ${partial.requested.map(want => WANT_LABELS.ar[want]).join('، ')}.` : ` You also asked for: ${partial.requested.map(want => WANT_LABELS.en[want]).join(', ')}.`)
    : '';
  const remaining = missing.length - wants.length;
  const intro = partial.rounds === 0
    ? (ar ? `${kindLine}${requestedLine} أبني الموقع من كلماتك أنت دون أن أضيف شيئاً من عندي، فأسألك عمّا أحتاجه${remaining > 0 ? ' على دفعات' : ''}:` : `${kindLine}${requestedLine} I build the site from your own words and add nothing of my own, so I ask for what I need${remaining > 0 ? ', in a few steps' : ''}:`)
    : (ar ? `شكراً. بقي ما يلي${remaining > 0 ? ' (ثم القليل بعده)' : ''}. اكتب «لا» لأي بند لا تريده:` : `Thanks. Still needed${remaining > 0 ? ' (then a little more)' : ''}. Write "no" for anything you don't want:`);
  return { prompt: intro, fields: wants.map(want => field(partial, want)), wants };
}
export const WANT_LABELS: Readonly<Record<SiteLang, Readonly<Record<SiteWant, string>>>> = {
  ar: { name: 'الاسم', kind: 'النوع', contact: 'التواصل', items: 'الخدمات أو الأصناف', city: 'المدينة', hours: 'ساعات العمل', offer: 'العرض', colour: 'اللون', about: 'من نحن', team: 'الفريق', faq: 'الأسئلة الشائعة', pricing: 'الأسعار', projects: 'المشاريع', features: 'المميزات', steps: 'خطوات العمل', facts: 'الأرقام', testimonials: 'آراء العملاء', posts: 'الأخبار', tagline: 'الجملة التعريفية', address: 'العنوان' },
  en: { name: 'name', kind: 'kind', contact: 'contact', items: 'services or items', city: 'city', hours: 'opening hours', offer: 'the offer', colour: 'colour', about: 'about', team: 'team', faq: 'FAQ', pricing: 'pricing', projects: 'projects', features: 'features', steps: 'how it works', facts: 'numbers', testimonials: 'reviews', posts: 'news', tagline: 'tagline', address: 'address' },
};

export const kindByLabel = (lang: SiteLang, label: string): SiteKind | null => {
  const norm = normalize(label);
  for (const kind of KIND_ORDER) if (normalize(KIND_LABELS[lang][kind]) === norm || normalize(KIND_LABELS[lang === 'ar' ? 'en' : 'ar'][kind]) === norm) return kind;
  return detectKind(label)?.kind ?? null;
};

/* ---------- parsers for block content ---------- */

const dashSplit = (line: string) => line.split(/\s+[-–—]\s+|\s*[|｜]\s*/u).map(part => part.trim()).filter(Boolean);
export function parseTeam(answer: string) {
  return splitList(answer).map(line => { const [name, role, bio] = dashSplit(line); return name ? { name: name.slice(0, 60), ...(role ? { role: role.slice(0, 80) } : {}), ...(bio ? { bio: bio.slice(0, 300) } : {}) } : null; }).filter((member): member is NonNullable<typeof member> => Boolean(member)).slice(0, 24);
}
export function parseFaq(answer: string) {
  const lines = answer.split(/\r?\n/).map(line => line.replace(/^(?:س|ج|q|a)\s*[:：.)-]\s*/iu, '').trim()).filter(Boolean);
  const entries: { question: string; answer: string }[] = [];
  let pending: string | null = null;
  for (const line of lines) {
    const inline = line.match(/^(.+?[؟?])\s+(.+)$/u);
    if (inline && !pending) { entries.push({ question: inline[1]!.slice(0, 200), answer: inline[2]!.slice(0, 1000) }); continue; }
    if (pending === null) pending = line;
    else { entries.push({ question: pending.slice(0, 200), answer: line.slice(0, 1000) }); pending = null; }
  }
  return entries.slice(0, 30);
}
export function parsePricing(answer: string) {
  return splitList(answer.replace(/\n/g, '\n')).map(line => {
    const [name, price, rest, ...more] = line.split(/\s+[-–—]\s+|\s*[|｜]\s*/u).map(part => part.trim());
    if (!name) return null;
    const features = [rest, ...more].filter(Boolean).join(' ').split(/\s*[,،;؛]\s*|\s+و\s+|\s+and\s+/u).map(part => part.trim()).filter(Boolean).slice(0, 12);
    return { name: name.slice(0, 60), ...(price ? { price: price.slice(0, 40) } : {}), features };
  }).filter((plan): plan is NonNullable<typeof plan> => Boolean(plan)).slice(0, 6);
}
export function parsePoints(answer: string, limit = 12) {
  return splitList(answer).map(line => { const [title, detail] = line.split(/\s*[:：]\s*|\s+[-–—]\s+/u).map(part => part.trim()); return title ? { title: title.slice(0, 80), ...(detail ? { detail: detail.slice(0, 300) } : {}) } : null; }).filter((point): point is NonNullable<typeof point> => Boolean(point)).slice(0, limit);
}
export function parseFacts(answer: string) {
  return splitList(answer).map(line => {
    const ascii = asciiDigits(line);
    const dashed = ascii.match(/^\s*([+~≈]?\s*[\d.,]+\s*[%+kKmM]?)\s*(?:[-–—:：]\s*)?(.+)$/u) ?? ascii.match(/^(.+?)\s*[:：-]\s*([+~≈]?\s*[\d.,]+\s*[%+kKmM]?)\s*$/u);
    if (!dashed) return null;
    const [, first, second] = dashed;
    const value = /\d/.test(first!) ? first! : second!, label = /\d/.test(first!) ? second! : first!;
    return { value: value.replace(/\s+/g, '').slice(0, 20), label: label.trim().slice(0, 60) };
  }).filter((fact): fact is NonNullable<typeof fact> => Boolean(fact)).slice(0, 6);
}
export function parseTestimonials(answer: string) {
  return splitList(answer.replace(/\n/g, '\n')).map(line => { const match = line.match(/^(.{1,60}?)\s*[:：\-–—]\s*(.+)$/u); return match ? { name: match[1]!.trim(), quote: match[2]!.trim().replace(/^[«"“]+|[»"”]+$/gu, '').slice(0, 400) } : null; }).filter((entry): entry is NonNullable<typeof entry> => Boolean(entry && entry.quote.length > 0)).slice(0, 12);
}
export function parsePosts(answer: string) {
  return answer.split(/\n\s*\n/).map(block => block.trim()).filter(Boolean).map(block => {
    const [title, ...body] = block.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (!title) return null;
    const dated = title.match(/^(.+?)\s*[|｜]\s*(.+)$/u);
    return { title: (dated ? dated[1]! : title).slice(0, 120), ...(dated ? { date: dated[2]!.slice(0, 40) } : {}), body: (body.join('\n') || title).slice(0, 4000) };
  }).filter((post): post is NonNullable<typeof post> => Boolean(post)).slice(0, 30);
}

/** Folds a card's answers into the partial brief; "no" skips an optional block; empty answers change nothing. */
export function applyAnswers(partial: SitePartialBrief, answers: Readonly<Record<string, string>>): SitePartialBrief {
  const next: SitePartialBrief = { ...partial, skipped: [...partial.skipped], rounds: partial.rounds + 1 };
  const skip = (want: SiteWant) => { if (!ESSENTIAL.includes(want) && !next.skipped.includes(want)) next.skipped.push(want); };
  for (const [id, raw] of Object.entries(answers)) {
    const value = raw?.trim();
    if (!value) continue;
    const want = id as SiteWant;
    if (isNone(value)) { skip(want); continue; }
    switch (want) {
      case 'name': next.name = value.replace(/\s+/g, ' ').replace(/^[«"“]+|[»"”]+$/gu, '').slice(0, 80); break;
      case 'kind': { const kind = kindByLabel(partial.lang, value); if (kind) { next.kind = kind; next.kindReason = undefined; } break; }
      case 'items': { const items = parseItems(value, 60); if (items.length) next.items = items; break; }
      case 'contact': {
        const numbers = findNumbers(value);
        const whatsapp = numbers.find(number => number.whatsapp)?.digits, phone = numbers.find(number => !number.whatsapp)?.digits;
        if (whatsapp) next.whatsapp = whatsapp;
        if (phone) next.phone = phone;
        else if (whatsapp && /(?:^|\s)(?:و|and)\s*(?:اتصال|هاتف|phone|call)/iu.test(value)) next.phone = whatsapp;
        const email = findEmail(value); if (email) next.email = email;
        break;
      }
      case 'city': next.city = value.replace(/^(?:في|in)\s+/iu, '').slice(0, 60); break;
      case 'address': next.address = value.slice(0, 200); { const map = findUrl(value); if (map && /maps|goo\.gl/.test(map)) next.mapUrl = map; } break;
      case 'hours': { const hours = splitList(value).slice(0, 7).map(line => line.slice(0, 80)); if (hours.length) next.hours = hours; break; }
      case 'offer': next.offer = value.slice(0, 300); break;
      case 'tagline': next.tagline = value.slice(0, 140); break;
      case 'colour': { const colour = colourFromWord(value); if (colour) { next.primary = colour.hex; next.colourWord = colour.word; } else skip('colour'); break; }
      case 'about': next.about = value.slice(0, 4000); break;
      case 'team': { const team = parseTeam(value); if (team.length) next.team = team; break; }
      case 'faq': { const faq = parseFaq(value); if (faq.length) next.faq = faq; break; }
      case 'pricing': { const pricing = parsePricing(value); if (pricing.length) next.pricing = pricing; break; }
      case 'projects': { const projects = parseItems(value, 60); if (projects.length) next.projects = projects; break; }
      case 'features': { const features = parsePoints(value, 12); if (features.length) next.features = features; break; }
      case 'steps': { const steps = parsePoints(value, 8); if (steps.length) next.steps = steps; break; }
      case 'facts': { const facts = parseFacts(value); if (facts.length) next.facts = facts; else skip('facts'); break; }
      case 'testimonials': { const testimonials = parseTestimonials(value); if (testimonials.length) next.testimonials = testimonials; break; }
      case 'posts': { const posts = parsePosts(value); if (posts.length) next.posts = posts; break; }
      default: break;
    }
  }
  // Optional wants asked once and left empty are not asked again.
  for (const want of missingWants(partial).filter(want => !ESSENTIAL.includes(want) && want in answers && !hasContent(next, want))) skip(want);
  return next;
}

export type Completion = { brief: SiteBrief } | { missing: SiteWant[] };
export interface CompleteExtras { images?: SiteBrief['images']; social?: SiteBrief['social']; mood?: SiteBrief['mood']; goal?: SiteBrief['goal']; form?: boolean; map?: boolean; requestText?: string }

/** A full brief from the partial one, with defaults only where a default is structure, never a fact. */
export function completeBrief(partial: SitePartialBrief, extras: CompleteExtras = {}): Completion {
  const missing = ESSENTIAL.filter(want => !hasContent(partial, want));
  if (missing.length) return { missing };
  const kind = partial.kind!;
  const requests = extras.requestText ? detectRequests(extras.requestText) : null;
  const items = partial.items ?? [];
  const goalWanted = extras.goal ?? (partial.whatsapp ? (kind === 'catalogue' ? 'order' : kind === 'clinic' ? 'book' : 'whatsapp') : partial.phone ? (kind === 'clinic' ? 'book' : 'call') : 'email');
  const goal = goalWanted === 'book' && !partial.whatsapp && !partial.phone ? 'email' : goalWanted === 'order' && !partial.whatsapp ? (partial.phone ? 'call' : 'email') : goalWanted;
  const core = {
    lang: partial.lang, kind, name: partial.name!, items, offer: partial.offer, hours: partial.hours, testimonials: partial.testimonials ?? [], images: extras.images ?? [], mapUrl: partial.mapUrl, address: partial.address,
  };
  const content: PageContent = { about: partial.about, team: partial.team, faq: partial.faq, pricing: partial.pricing, projects: partial.projects, features: partial.features, steps: partial.steps, facts: partial.facts, posts: partial.posts };
  const options: PlanOptions = { singlePage: partial.singlePage, form: extras.form ?? requests?.form ?? undefined, map: extras.map ?? requests?.map ?? Boolean(partial.mapUrl) };
  const brief = SiteBriefSchema.parse({
    lang: partial.lang,
    kind,
    name: partial.name!,
    ...(partial.tagline ? { tagline: partial.tagline } : {}),
    ...(partial.city ? { city: partial.city } : {}),
    ...(partial.address ? { address: partial.address } : {}),
    ...(partial.phone ? { phone: partial.phone } : {}),
    ...(partial.whatsapp ? { whatsapp: partial.whatsapp } : {}),
    ...(partial.email ? { email: partial.email } : {}),
    ...(partial.mapUrl ? { mapUrl: partial.mapUrl } : {}),
    ...(partial.hours?.length ? { hours: partial.hours } : {}),
    items,
    ...(partial.offer ? { offer: partial.offer } : {}),
    images: extras.images ?? [],
    primary: partial.primary ?? KIND_COLOURS[kind]!,
    mood: extras.mood ?? KIND_MOODS[kind]!,
    goal,
    testimonials: partial.testimonials ?? [],
    ...(extras.social ? { social: extras.social } : {}),
    pages: buildPages(core, content, options),
  });
  return { brief };
}

/** Rebuilds the pages of an existing brief after a content change, keeping the user's page choices where possible. */
export function rebuildPages(brief: SiteBrief, content: PageContent, options: PlanOptions): SiteBrief['pages'] {
  return buildPages(brief, content, options);
}
