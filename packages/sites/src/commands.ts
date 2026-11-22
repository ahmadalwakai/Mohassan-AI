import type { SiteBlock, SiteBrief, SiteKind, SiteLang, SiteMood, SitePage, SiteWant } from '@mohassan/contracts';
import { SiteBriefSchema } from '@mohassan/contracts';
import { PAGE_TITLES, placeBlock, removeBlocks } from './families.ts';
import { parseFacts, parseFaq, parsePoints, parsePosts, parsePricing, parseTeam, parseTestimonials } from './plan.ts';
import { detectKind } from './recognize.ts';
import { findEmail, findNumbers, normalize, parseItems, splitList } from './text.ts';
import { colourFromWord } from './theme.ts';

/**
 * Plain-language edits to a brief, in Arabic or English, with no model. Each command maps to a patch
 * of the brief; the site is then recomposed. A block that needs content the user has not given
 * returns `ask`, so the chat asks for it instead of inventing it. Unknown sentences return null.
 */
export type SiteCommand =
  | { kind: 'patch'; patch: Partial<SiteBrief>; summary: string }
  | { kind: 'undo'; summary: string }
  | { kind: 'ask'; want: SiteWant; title?: string; summary: string };

type BlockType = SiteBlock['type'];
const SECTION_WORDS: readonly { type: BlockType; want?: SiteWant; words: readonly string[] }[] = [
  { type: 'testimonials', want: 'testimonials', words: ['الاراء', 'اراء', 'اراء العملاء', 'الشهادات', 'التقييمات', 'reviews', 'testimonials', 'feedback'] },
  { type: 'gallery', words: ['المعرض', 'معرض', 'الصور', 'صور', 'الالبوم', 'gallery', 'photos', 'pictures', 'images'] },
  { type: 'text', want: 'about', words: ['من نحن', 'عنا', 'قصتنا', 'التعريف', 'نبذه', 'about', 'about us', 'our story'] },
  { type: 'hours', want: 'hours', words: ['المواعيد', 'ساعات العمل', 'الدوام', 'اوقات العمل', 'hours', 'opening hours', 'opening times'] },
  { type: 'cta', words: ['الدعوه', 'دعوه التواصل', 'زر التواصل', 'شريط التواصل', 'call to action', 'cta', 'contact banner'] },
  { type: 'team', want: 'team', words: ['الفريق', 'فريق', 'فريق العمل', 'الطاقم', 'الاطباء', 'الموظفين', 'team', 'staff', 'doctors'] },
  { type: 'faq', want: 'faq', words: ['الاسئله الشائعه', 'اسئله شائعه', 'الاسئله', 'اسئله', 'faq', 'faqs', 'questions'] },
  { type: 'pricing', want: 'pricing', words: ['الاسعار', 'اسعار', 'الباقات', 'باقات', 'الخطط', 'pricing', 'prices', 'plans', 'packages'] },
  { type: 'features', want: 'features', words: ['المميزات', 'مميزات', 'لماذا نحن', 'ما يميزنا', 'features', 'why us', 'benefits'] },
  { type: 'steps', want: 'steps', words: ['الخطوات', 'خطوات', 'كيف نعمل', 'طريقه العمل', 'how it works', 'steps', 'process'] },
  { type: 'facts', want: 'facts', words: ['الارقام', 'ارقام', 'الانجازات', 'الاحصائيات', 'stats', 'numbers', 'achievements', 'figures'] },
  { type: 'posts', want: 'posts', words: ['المدونه', 'مدونه', 'الاخبار', 'اخبار', 'المقالات', 'مقالات', 'blog', 'news', 'articles', 'posts'] },
  { type: 'map', words: ['الخريطه', 'خريطه', 'map', 'location map'] },
  { type: 'contact', words: ['التواصل', 'تواصل', 'نموذج التواصل', 'contact', 'contact form', 'form'] },
];
const MOODS: readonly { mood: SiteMood; words: readonly string[] }[] = [
  { mood: 'bold', words: ['اجرا', 'جريء', 'جريئا', 'جريئه', 'قوي', 'اقوي', 'صارخ', 'عصري', 'bold', 'bolder', 'strong', 'stronger', 'punchy', 'modern'] },
  { mood: 'calm', words: ['اهدا', 'هادئ', 'هادئا', 'هادئه', 'بسيط', 'ابسط', 'كلاسيكي', 'كلاسيك', 'رسمي', 'نظيف', 'calm', 'calmer', 'simple', 'simpler', 'minimal', 'classic', 'formal', 'clean', 'quiet'] },
  { mood: 'warm', words: ['ادفا', 'دافئ', 'دافئا', 'دافئه', 'ودود', 'مريح', 'ناعم', 'warm', 'warmer', 'friendly', 'cosy', 'cozy', 'soft'] },
];
const GOALS: readonly { goal: SiteBrief['goal']; words: readonly string[] }[] = [
  { goal: 'whatsapp', words: ['واتساب', 'واتس', 'whatsapp'] }, { goal: 'call', words: ['اتصال', 'الاتصال', 'مكالمه', 'الهاتف', 'call', 'calls', 'phone'] },
  { goal: 'email', words: ['بريد', 'البريد', 'ايميل', 'email', 'mail'] }, { goal: 'order', words: ['طلب', 'الطلب', 'طلبات', 'order', 'orders'] }, { goal: 'book', words: ['حجز', 'الحجز', 'موعد', 'مواعيد', 'book', 'booking', 'appointment', 'appointments'] },
];
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordIn = (norm: string, words: readonly string[]) => words.find(word => new RegExp(`(?:^|[^\\p{L}])(?:ال)?${escapeRegExp(word)}(?![\\p{L}])`, 'u').test(norm));
const rest = (text: string, pattern: RegExp) => { const match = text.match(pattern); return match?.[1]?.trim().replace(/[.؟?!]+$/u, '').trim() || null; };
const say = (lang: SiteLang, ar: string, en: string) => (lang === 'ar' ? ar : en);
const fuzzyIndex = (items: SiteBrief['items'], title: string) => { const norm = normalize(title); let index = items.findIndex(item => normalize(item.title) === norm); if (index < 0) index = items.findIndex(item => normalize(item.title).includes(norm) || norm.includes(normalize(item.title))); return index; };
const REMOVE = /(?:^|\s)(?:احذف|ازل|أزل|اخف|أخف|شيل|الغي|ألغي|remove|hide|delete|drop)(?=\s)/u;
const ADD = /(?:^|\s)(?:اضف|أضف|اظهر|أظهر|ضيف|رجع|أرجع|فعل|فعّل|اعمل|أنشئ|انشئ|add|show|enable|include|bring back|create|make)(?=\s)/u;

/** Content supplied in the same sentence after a colon, e.g. "أضف قسم الفريق: سارة - طبيبة". */
const inlineContent = (raw: string) => { const match = raw.match(/[:：]\s*([\s\S]+)$/u); return match?.[1]?.trim() || null; };

function blockFromContent(want: SiteWant, text: string, lang: SiteLang): SiteBlock | null {
  const titles = PAGE_TITLES[lang];
  switch (want) {
    case 'about': return { type: 'text', title: titles.about, body: text.slice(0, 4000) };
    case 'team': { const members = parseTeam(text); return members.length ? { type: 'team', members } : null; }
    case 'faq': { const entries = parseFaq(text); return entries.length ? { type: 'faq', entries } : null; }
    case 'pricing': { const plans = parsePricing(text); return plans.length ? { type: 'pricing', plans } : null; }
    case 'projects': { const items = parseItems(text, 60); return items.length ? { type: 'items', title: titles.projects, layout: 'tiles', items } : null; }
    case 'features': { const points = parsePoints(text, 12); return points.length ? { type: 'features', points } : null; }
    case 'steps': { const steps = parsePoints(text, 8); return steps.length ? { type: 'steps', steps } : null; }
    case 'facts': { const items = parseFacts(text); return items.length ? { type: 'facts', items } : null; }
    case 'posts': { const posts = parsePosts(text); return posts.length ? { type: 'posts', posts } : null; }
    default: return null;
  }
}

/** Applies an answer to an `ask` result: the user supplied the content a block needed. */
export function fulfilWant(brief: SiteBrief, want: SiteWant, text: string): Partial<SiteBrief> | null {
  if (want === 'testimonials') { const entries = parseTestimonials(text); if (!entries.length) return null; return { testimonials: entries.slice(0, 12), pages: placeBlock(brief.pages, { type: 'testimonials' }, brief.lang) }; }
  if (want === 'hours') { const lines = splitList(text).slice(0, 7).map(line => line.slice(0, 80)); if (!lines.length) return null; return { hours: lines, pages: placeBlock(brief.pages, { type: 'hours' }, brief.lang) }; }
  const block = blockFromContent(want, text, brief.lang);
  if (!block) return null;
  // Replace an earlier block of the same kind (for items: only a second list such as projects), then place the new one.
  const cleared = brief.pages
    .map(page => ({ ...page, blocks: page.blocks.filter(existing => !(existing.type === block.type && (block.type !== 'items' || Boolean((existing as { items?: unknown }).items)))) }))
    .filter(page => page.path === 'index.html' || page.blocks.length > 0);
  return { pages: placeBlock(cleared, block, brief.lang) };
}

export function siteCommand(text: string, brief: SiteBrief): SiteCommand | null {
  const raw = text.trim();
  if (!raw) return null;
  const norm = normalize(raw);
  const lang = brief.lang;
  if (/^(?:تراجع|ارجع|الغ|الغي|رجع|undo|revert|go back)(?![\p{L}])/u.test(norm)) return { kind: 'undo', summary: say(lang, 'تراجعت عن آخر تعديل.', 'Undid the last change.') };

  // Colour: "غيّر اللون إلى أزرق", "make it green", "#1d4ed8".
  if (/(?:لون|الوان|colou?r|theme)/u.test(norm) || /^#[0-9a-f]{6}$/i.test(raw) || /(?:اجعله|خليه|خله|make it)\s+(?:ازرق|اخضر|احمر|اصفر|بنفسجي|وردي|بني|اسود|برتقالي|ذهبي|فيروزي|blue|green|red|yellow|purple|pink|brown|black|orange|gold|teal|navy)/u.test(norm)) {
    const colour = colourFromWord(raw);
    if (colour) return { kind: 'patch', patch: { primary: colour.hex }, summary: say(lang, `غيّرت اللون الأساسي إلى ${colour.word}.`, `Changed the main colour to ${colour.word}.`) };
  }
  // Name.
  const name = rest(raw, /(?:غيّر|غير|بدّل|بدل|اجعل|خلي|خل)\s+(?:ال)?(?:اسم|الاسم)(?:\s+(?:الموقع|النشاط|المطعم|العياده|العيادة|المتجر))?\s+(?:إلى|الى|ل|ليكون|يكون|=|:)?\s*(.+)$/iu) ?? rest(raw, /(?:change|set|rename|update)\s+(?:the\s+)?(?:name|title|business name|site name)\s+(?:to|as|=|:)?\s*(.+)$/iu);
  if (name) { const clean = name.replace(/^[«"“'‘]+|[»"”'’]+$/gu, '').trim().slice(0, 80); if (clean) return { kind: 'patch', patch: { name: clean }, summary: say(lang, `غيّرت الاسم إلى «${clean}».`, `Changed the name to "${clean}".`) }; }
  // Tagline.
  const tagline = rest(raw, /(?:غيّر|غير|بدّل|بدل|اجعل|اضف|أضف|اكتب)\s+(?:ال)?(?:شعار|العنوان الفرعي|الوصف المختصر|الجمله التعريفيه|الجملة التعريفية)\s+(?:إلى|الى|ل|:)?\s*(.+)$/iu) ?? rest(raw, /(?:change|set|add|write)\s+(?:the\s+)?(?:tagline|slogan|subtitle|strapline)\s+(?:to|as|:)?\s*(.+)$/iu);
  if (tagline) { const clean = tagline.replace(/^[«"“'‘]+|[»"”'’]+$/gu, '').slice(0, 140); return { kind: 'patch', patch: { tagline: clean }, summary: say(lang, 'غيّرت الجملة التعريفية.', 'Changed the tagline.') }; }
  // Hours.
  const hours = rest(raw, /(?:ساعات العمل|الدوام|المواعيد|اوقات العمل|أوقات العمل|opening hours|hours|opening times)\s*(?:هي|هو|إلى|الى|:|=|are|is|to)?\s*([\s\S]+)$/iu);
  if (hours && !REMOVE.test(norm)) { const list = splitList(hours).slice(0, 7).map(line => line.slice(0, 80)); if (list.length) return { kind: 'patch', patch: { hours: list, pages: placeBlock(brief.pages, { type: 'hours' }, lang) }, summary: say(lang, 'حدّثت ساعات العمل.', 'Updated the opening hours.') }; }
  // Contact details.
  if (/(?:رقم|الرقم|هاتف|الهاتف|جوال|الجوال|موبايل|واتساب|واتس|phone|number|whatsapp|mobile)/u.test(norm)) {
    const numbers = findNumbers(raw);
    if (numbers.length) {
      const whatsappOnly = /(?:واتساب|واتس|whatsapp)/u.test(norm) && !/(?:هاتف|الهاتف|جوال|الجوال|اتصال|phone|call)/u.test(norm);
      const patch: Partial<SiteBrief> = whatsappOnly ? { whatsapp: numbers[0]!.digits } : numbers.some(number => number.whatsapp) ? { whatsapp: numbers.find(number => number.whatsapp)!.digits, ...(numbers.find(number => !number.whatsapp) ? { phone: numbers.find(number => !number.whatsapp)!.digits } : {}) } : { phone: numbers[0]!.digits };
      if (/(?:نفسه|نفس الرقم|same number|same)/u.test(norm) && !patch.whatsapp) patch.whatsapp = patch.phone;
      return { kind: 'patch', patch, summary: say(lang, 'حدّثت أرقام التواصل.', 'Updated the contact numbers.') };
    }
    if (/(?:نفسه|نفس الرقم|same number|same)/u.test(norm) && /(?:واتساب|واتس|whatsapp)/u.test(norm) && brief.phone) return { kind: 'patch', patch: { whatsapp: brief.phone }, summary: say(lang, 'اعتمدت رقم الهاتف للواتساب أيضاً.', 'Used the phone number for WhatsApp too.') };
  }
  const email = findEmail(raw);
  if (email && /(?:بريد|البريد|ايميل|إيميل|email|mail)/iu.test(norm)) return { kind: 'patch', patch: { email }, summary: say(lang, 'حدّثت البريد.', 'Updated the email.') };
  // Address / city / map.
  const map = raw.match(/https:\/\/(?:maps\.app\.goo\.gl|(?:www\.)?google\.[a-z.]+\/maps|goo\.gl\/maps|maps\.apple\.com|(?:www\.)?openstreetmap\.org)[^\s"'<>]*/iu);
  if (map) return { kind: 'patch', patch: { mapUrl: map[0], pages: placeBlock(brief.pages, { type: 'map' }, lang) }, summary: say(lang, 'أضفت رابط الخريطة.', 'Added the map link.') };
  const address = rest(raw, /(?:العنوان|عنواننا|عنوان المحل|عنوان المطعم|address|our address)\s*(?:هو|:|=|is)?\s*(.+)$/iu);
  if (address) return { kind: 'patch', patch: { address: address.slice(0, 200) }, summary: say(lang, 'حدّثت العنوان.', 'Updated the address.') };
  const city = rest(raw, /(?:المدينه|المدينة|المنطقه|المنطقة|city|area|location)\s*(?:هي|:|=|is|to)?\s*(.+)$/iu);
  if (city && !map) return { kind: 'patch', patch: { city: city.slice(0, 60) }, summary: say(lang, 'حدّثت المدينة.', 'Updated the city.') };
  // Single page / multi page.
  if (/(?:صفحه واحده|بصفحه واحده|one page|single page|one-page|single-page)/u.test(norm)) {
    const index = brief.pages.find(page => page.path === 'index.html')!;
    const merged = [index, ...brief.pages.filter(page => page !== index)].flatMap(page => page.blocks);
    return { kind: 'patch', patch: { pages: [{ path: 'index.html', title: brief.name, inNav: true, blocks: merged.filter((block, position) => merged.findIndex(other => other.type === block.type && JSON.stringify(other) === JSON.stringify(block)) === position).slice(0, 16) }] }, summary: say(lang, 'جمعت الموقع في صفحة واحدة.', 'Merged the site into one page.') };
  }
  // Sections: remove, or add (with inline content, or an ask).
  const sectionRemove = REMOVE.test(norm), sectionAdd = ADD.test(norm);
  if (sectionRemove || sectionAdd) {
    for (const section of SECTION_WORDS) {
      if (!wordIn(norm.split(/[:：]/)[0]!, section.words)) continue;
      if (sectionRemove) {
        if (section.type === 'contact' && /form|نموذج/.test(norm)) return { kind: 'patch', patch: { pages: brief.pages.map(page => ({ ...page, blocks: page.blocks.map(block => (block.type === 'contact' ? { ...block, form: false } : block)) })) }, summary: say(lang, 'أزلت نموذج التواصل.', 'Removed the contact form.') };
        return { kind: 'patch', patch: { pages: removeBlocks(brief.pages, section.type) }, summary: say(lang, 'أخفيت القسم.', 'Hid the section.') };
      }
      const supplied = inlineContent(raw);
      if (section.type === 'gallery') return { kind: 'patch', patch: { pages: placeBlock(brief.pages, { type: 'gallery' }, lang) }, summary: say(lang, 'فعّلت قسم الصور؛ يظهر عندما ترفع صوراً من لوحة المواقع.', 'Enabled the gallery; it appears once you upload photos from the sites panel.') };
      if (section.type === 'map') return brief.mapUrl ? { kind: 'patch', patch: { pages: placeBlock(brief.pages, { type: 'map' }, lang) }, summary: say(lang, 'أضفت الخريطة.', 'Added the map.') } : { kind: 'ask', want: 'address', summary: say(lang, 'أرسل لي رابط موقعكم على خرائط Google والعنوان، وسأضيف الخريطة.', 'Send me your Google Maps link and the address, and I will add the map.') };
      if (section.type === 'cta') return { kind: 'patch', patch: { pages: placeBlock(brief.pages, { type: 'cta' }, lang) }, summary: say(lang, 'أظهرت شريط التواصل.', 'Showed the contact banner.') };
      if (section.type === 'contact') return { kind: 'patch', patch: { pages: brief.pages.some(page => page.blocks.some(block => block.type === 'contact')) ? brief.pages.map(page => ({ ...page, blocks: page.blocks.map(block => (block.type === 'contact' ? { ...block, form: true } : block)) })) : placeBlock(brief.pages, { type: 'contact', form: true }, lang) }, summary: say(lang, 'أضفت نموذج التواصل.', 'Added the contact form.') };
      if (section.want === 'testimonials') { if (supplied) { const patch = fulfilWant(brief, 'testimonials', supplied); if (patch) return { kind: 'patch', patch, summary: say(lang, 'أضفت آراء عملائك كما كتبتها.', 'Added your customers’ reviews as written.') }; } if (brief.testimonials.length) return { kind: 'patch', patch: { pages: placeBlock(brief.pages, { type: 'testimonials' }, lang) }, summary: say(lang, 'أظهرت قسم الآراء.', 'Showed the reviews.') }; return { kind: 'ask', want: 'testimonials', summary: say(lang, 'لأعرض قسم الآراء أحتاج آراءً حقيقية من عملائك: اكتب في كل سطر الاسم ثم نقطتين ثم الرأي، ولن أكتب رأياً من عندي.', 'To show reviews I need real ones from your customers: one per line as Name: quote. I will not write any myself.') }; }
      if (section.want === 'hours') { if (brief.hours?.length) return { kind: 'patch', patch: { pages: placeBlock(brief.pages, { type: 'hours' }, lang) }, summary: say(lang, 'أظهرت ساعات العمل.', 'Showed the opening hours.') }; return { kind: 'ask', want: 'hours', summary: say(lang, 'اكتب لي ساعات العمل، سطر لكل فترة، وسأضيفها.', 'Send me the opening hours, one line per period, and I will add them.') }; }
      if (section.want) {
        if (supplied) { const patch = fulfilWant(brief, section.want, supplied); if (patch) return { kind: 'patch', patch, summary: say(lang, 'أضفت القسم بمحتواك.', 'Added the section with your content.') }; }
        const ask: Record<string, [string, string]> = {
          about: ['لأضيف «من نحن» اكتب لي نصه بكلماتك، ولن أكتب عنك شيئاً من عندي.', 'To add an about section, send me its text in your words; I will not write anything about you myself.'],
          team: ['من أعضاء الفريق؟ في كل سطر: الاسم - الدور - نبذة قصيرة (اختيارية).', 'Who is on the team? One per line: Name - Role - short bio (optional).'],
          faq: ['ما الأسئلة وأجوبتها؟ سؤال في سطر يليه جوابه في السطر التالي.', 'Which questions and answers? A question on one line and its answer on the next.'],
          pricing: ['ما الباقات؟ في كل سطر: الاسم - السعر - ما تتضمّنه مفصولاً بفواصل.', 'Which plans? One per line: Name - Price - what it includes, comma separated.'],
          projects: ['ما المشاريع؟ مشروع في كل سطر، ووصف بعد نقطتين إن أردت.', 'Which projects? One per line; a description after a colon if you like.'],
          features: ['ما الذي يميّزكم؟ نقطة في كل سطر بكلماتك.', 'What sets you apart? One point per line, in your words.'],
          steps: ['كيف تعملون؟ خطوة في كل سطر بالترتيب.', 'How do you work? One step per line, in order.'],
          facts: ['ما الأرقام؟ في كل سطر: الرقم - وصفه. أعرض ما تكتبه فقط.', 'Which numbers? One per line: number - what it counts. Only what you write is shown.'],
          posts: ['ما الأخبار؟ العنوان في سطر ثم النص، وسطر فارغ بين الأخبار.', 'Which news? Title on one line, then the text; an empty line between posts.'],
        };
        const [ar, en] = ask[section.want] ?? ['اكتب لي المحتوى وسأضيفه كما هو.', 'Send me the content and I will add it as is.'];
        return { kind: 'ask', want: section.want, summary: say(lang, ar, en) };
      }
    }
  }
  // Custom page: "أضف صفحة الشروط: النص".
  const page = raw.match(/^(?:اضف|أضف|انشئ|أنشئ|اعمل|add|create|make)\s+(?:صفحه|صفحة|a\s+page|page)\s+(?:باسم\s+|بعنوان\s+|called\s+|titled\s+|named\s+)?([^:：\n]{2,60}?)\s*(?:[:：]\s*([\s\S]+))?$/iu);
  if (page) {
    const title = page[1]!.trim().replace(/^[«"“]+|[»"”]+$/gu, '');
    const body = page[2]?.trim();
    const path = `page-${brief.pages.length + 1}.html`;
    if (body) {
      const newPage: SitePage = { path, title: title.slice(0, 60), inNav: true, blocks: [{ type: 'text', title: title.slice(0, 80), body: body.slice(0, 4000) }] };
      return { kind: 'patch', patch: { pages: [...brief.pages.filter(item => item.path !== 'contact.html'), newPage, ...brief.pages.filter(item => item.path === 'contact.html')].slice(0, 12) }, summary: say(lang, `أضفت صفحة «${title}».`, `Added the page "${title}".`) };
    }
    return { kind: 'ask', want: 'about', title: title.slice(0, 60), summary: say(lang, `اكتب لي نص صفحة «${title}» بكلماتك وسأضعه كما هو.`, `Send me the text of the "${title}" page in your words and I will add it as is.`) };
  }
  // Items: add / remove.
  const added = rest(raw, /^(?:اضف|أضف|زد|ضيف|اضيف|add|include)\s+(?:خدمه|خدمة|صنف|طبق|منتج|عمل|مشروع|بند|نقطه|نقطة|a\s+)?(?:service|dish|product|item|work|project|point)?\s*[:：]?\s*([\s\S]+)$/iu);
  if (added && !SECTION_WORDS.some(section => wordIn(normalize(added), section.words))) {
    const items = parseItems(added, 60 - brief.items.length);
    if (items.length) {
      const merged = [...brief.items];
      for (const item of items) if (fuzzyIndex(merged, item.title) < 0) merged.push(item);
      return { kind: 'patch', patch: { items: merged.slice(0, 60), pages: placeBlock(brief.pages, { type: 'items' }, lang) }, summary: say(lang, items.length === 1 ? `أضفت «${items[0]!.title}».` : 'أضفت العناصر.', items.length === 1 ? `Added "${items[0]!.title}".` : 'Added the items.') };
    }
  }
  const removed = rest(raw, /^(?:احذف|ازل|أزل|شيل|الغي|ألغي|remove|delete|drop)\s+(?:خدمه|خدمة|صنف|طبق|منتج|عمل|مشروع|بند|the\s+)?(?:service|dish|product|item|work|project)?\s*[:：]?\s*(.+)$/iu);
  if (removed) {
    const index = fuzzyIndex(brief.items, removed);
    if (index >= 0) { const items = brief.items.filter((_, position) => position !== index); return { kind: 'patch', patch: { items }, summary: say(lang, `حذفت «${brief.items[index]!.title}».`, `Removed "${brief.items[index]!.title}".`) }; }
  }
  // Price of an existing item: "سعر تنظيف السجاد 60".
  const priced = raw.match(/(?:سعر|السعر|price of|price for)\s+(.+?)\s*(?:هو|=|:|is|to)?\s*([^\s].{0,30})$/iu);
  if (priced && /\d/.test(normalize(priced[2]!))) { const index = fuzzyIndex(brief.items, priced[1]!); if (index >= 0) { const items = brief.items.map((item, position) => (position === index ? { ...item, price: priced[2]!.trim().slice(0, 40) } : item)); return { kind: 'patch', patch: { items }, summary: say(lang, `حدّثت سعر «${brief.items[index]!.title}».`, `Updated the price of "${brief.items[index]!.title}".`) }; } }
  // Mood / style.
  for (const entry of MOODS) if (wordIn(norm, entry.words) && /(?:اجعله|خليه|خله|اجعل|صممه|نمط|ستايل|شكل|تصميم|make it|make the|style|look|design|feel)/u.test(norm)) return { kind: 'patch', patch: { mood: entry.mood }, summary: say(lang, 'غيّرت طابع التصميم.', 'Changed the design mood.') };
  // Language.
  if (/(?:اجعله|حوله|حوّله|ترجمه|ترجم|بدل اللغه|بدّل اللغة|غير اللغه|غيّر اللغة|make it|switch|translate|change the language|in)\b/u.test(norm) || /(?:لغه|اللغه|language)/u.test(norm)) {
    if (/(?:انجليزي|انجليزيه|انكليزي|english)/u.test(norm) && brief.lang !== 'en') return { kind: 'patch', patch: { lang: 'en' }, summary: 'Switched the site to English; your own texts stay as you wrote them.' };
    if (/(?:عربي|عربيه|arabic)/u.test(norm) && brief.lang !== 'ar') return { kind: 'patch', patch: { lang: 'ar' }, summary: 'حوّلت الموقع إلى العربية؛ نصوصك تبقى كما كتبتها.' };
  }
  // Kind.
  const kindChange = raw.match(/(?:اجعله|حوله|حوّله|غيّر النوع إلى|غير النوع الى|النوع|make it a|make it an|change (?:the )?type to|it is a|it's a)\s+(.+)$/iu);
  if (kindChange) { const kind = detectKind(kindChange[1]!)?.kind as SiteKind | undefined; if (kind && kind !== brief.kind) return { kind: 'patch', patch: { kind }, summary: say(lang, 'غيّرت نوع الموقع.', 'Changed the kind of site.') }; }
  // Goal.
  if (/(?:الهدف|هدف الموقع|الزر الرئيسي|goal|main button|primary action)/u.test(norm)) {
    for (const entry of GOALS) if (wordIn(norm, entry.words)) {
      const allowed = entry.goal === 'whatsapp' || entry.goal === 'order' ? Boolean(brief.whatsapp) : entry.goal === 'call' ? Boolean(brief.phone) : entry.goal === 'email' ? Boolean(brief.email) : Boolean(brief.whatsapp || brief.phone);
      if (allowed) return { kind: 'patch', patch: { goal: entry.goal }, summary: say(lang, 'غيّرت هدف الزر الرئيسي.', 'Changed the main button goal.') };
    }
  }
  return null;
}

/** Applies a patch and validates; throws a ZodError when the result is not a valid brief. */
export function applyPatch(brief: SiteBrief, patch: Partial<SiteBrief>): SiteBrief {
  const next = { ...brief, ...patch };
  if (next.goal === 'whatsapp' || next.goal === 'order') { if (!next.whatsapp) next.goal = next.phone ? 'call' : 'email'; }
  if (next.goal === 'call' && !next.phone) next.goal = next.whatsapp ? 'whatsapp' : 'email';
  if (next.goal === 'email' && !next.email) next.goal = next.whatsapp ? 'whatsapp' : 'call';
  if (next.goal === 'book' && !next.whatsapp && !next.phone) next.goal = 'email';
  if (!next.pages.some(page => page.path === 'index.html')) next.pages = [{ path: 'index.html', title: next.name, inNav: true, blocks: [{ type: 'hero' }, { type: 'contact' }] }, ...next.pages];
  return SiteBriefSchema.parse(next);
}

/** Example commands shown when a sentence is not understood. */
export function commandExamples(lang: SiteLang): string[] {
  return lang === 'ar'
    ? ['غيّر اللون إلى أزرق', 'غيّر الاسم إلى «…»', 'أضف خدمة تنظيف السجاد - 50', 'احذف خدمة …', 'رقم الواتساب 0501234567', 'ساعات العمل: السبت إلى الخميس ١٠ - ١١', 'أضف قسم الفريق: سارة - طبيبة أسنان', 'أضف قسم الأسئلة الشائعة', 'أضف صفحة الشروط: …', 'احذف قسم الصور', 'اجعله صفحة واحدة', 'اجعله أجرأ', 'اجعله بالإنجليزية', 'تراجع']
    : ['change the colour to blue', 'change the name to "…"', 'add service Carpet cleaning - £50', 'remove service …', 'WhatsApp number 07700900123', 'opening hours: Mon–Sat 10–11', 'add a team section: Sarah - Dentist', 'add an FAQ section', 'add a page Terms: …', 'hide the gallery', 'make it one page', 'make it bolder', 'make it Arabic', 'undo'];
}
