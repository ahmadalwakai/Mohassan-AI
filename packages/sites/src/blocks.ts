import type { SiteBlock, SiteItem, SiteKind, SitePage } from '@mohassan/contracts';
import { heroArtSvg, initialOf } from './art.ts';
import { attrs, el, escapeAttribute, escapeText, oneLine, paragraphs, telDigits } from './html.ts';
import { iconSvg } from './icons.ts';
import { HIGHLIGHT_COUNT, PAGE_TITLES } from './families.ts';
import { normalize } from './text.ts';
import type { RenderContext, SiteImageAsset } from './types.ts';

/* ---------- links and buttons ---------- */

export function waLink(number: string, message: string): string {
  return `https://wa.me/${telDigits(number).replace('+', '')}?text=${encodeURIComponent(message)}`;
}
export function primaryAction(ctx: RenderContext, item?: SiteItem): { href: string; label: string; icon: string } | null {
  const { brief, writer } = ctx;
  const { labels } = writer;
  switch (brief.goal) {
    case 'whatsapp': return brief.whatsapp ? { href: waLink(brief.whatsapp, labels.messages.enquiry.replace('{name}', brief.name)), label: labels.buttons.whatsapp, icon: 'message-circle' } : null;
    case 'order': return brief.whatsapp ? { href: waLink(brief.whatsapp, labels.messages.order.replace('{item}', item?.title ?? '')), label: labels.buttons.order, icon: 'shopping-bag' } : null;
    case 'book': return brief.whatsapp ? { href: waLink(brief.whatsapp, labels.messages.book), label: labels.buttons.book, icon: 'calendar-days' } : brief.phone ? { href: `tel:${telDigits(brief.phone)}`, label: labels.buttons.book, icon: 'phone' } : null;
    case 'email': return brief.email ? { href: `mailto:${brief.email}`, label: labels.buttons.email, icon: 'mail' } : null;
    case 'call': default: return brief.phone ? { href: `tel:${telDigits(brief.phone)}`, label: labels.buttons.call, icon: 'phone' } : null;
  }
}
const contactHref = (ctx: RenderContext) => (ctx.pages.some(page => page.path === 'contact.html') ? 'contact.html' : ctx.page.path === 'index.html' ? '#contact' : 'index.html#contact');
function secondaryAction(ctx: RenderContext): { href: string; label: string } | null {
  const itemsPage = ctx.pages.find(page => page.path !== 'index.html' && page.blocks.some(block => block.type === 'items' && !block.items));
  if (ctx.page.path !== itemsPage?.path && itemsPage) return { href: itemsPage.path, label: ctx.writer.labels.nav.items[ctx.kind] };
  if (ctx.page.path === 'contact.html') return null;
  if (ctx.pages.some(page => page.blocks.some(block => block.type === 'contact'))) return { href: contactHref(ctx), label: ctx.writer.labels.nav.contact };
  return null;
}
const button = (href: string, label: string, kind: 'primary' | 'ghost' | 'small', icon?: string, external = false) => el('a', { class: `btn btn-${kind}`, href, ...(external ? { rel: 'noopener', target: '_blank' } : {}) }, icon ? iconSvg(icon, { size: kind === 'small' ? 16 : 18 }) : '', el('span', {}, escapeText(label)));

/* ---------- icons by keyword ---------- */

const ICON_WORDS: readonly [RegExp, string][] = [
  [/هاتف|اتصال|phone|call/u, 'phone'], [/تنظيف|نظافه|غسيل|clean|wash/u, 'spray-can'], [/سجاد|كنب|اثاث|furniture|sofa|carpet|upholster/u, 'sofa'],
  [/نقل|شحن|توصيل|moving|removal|delivery|courier|van|truck/u, 'truck'], [/سياره|سيارات|ميكانيك|car|mot|garage|auto/u, 'car'], [/كهرباء|كهربائي|electric/u, 'zap'],
  [/سباك|ماء|مياه|تسرب|plumb|water|leak|pipe/u, 'droplets'], [/تكييف|تبريد|مكيف|air con|ac |hvac|cooling|fridge/u, 'snowflake'], [/دهان|طلاء|paint/u, 'paint-roller'],
  [/نجار|خشب|carpent|wood|joiner/u, 'hammer'], [/حديقه|حدائق|اشجار|garden|landscap|lawn|tree/u, 'trees'], [/امن|حراسه|كاميرات|security|guard|cctv|alarm/u, 'shield-check'],
  [/قانون|محامي|محاماه|قضايا|law|legal|solicitor|visa|تاشير/u, 'scale'], [/محاسبه|ضرائب|حسابات|account|tax|bookkeep|payroll/u, 'calculator'], [/تسويق|اعلان|marketing|ads|advert|social media/u, 'megaphone'],
  [/تصوير|صور|فوتو|photo|camera|shoot/u, 'camera'], [/تصميم|شعار|هويه|design|logo|brand|graphic/u, 'palette'], [/برمجه|موقع|تطبيق|ويب|code|web|app|software|develop/u, 'laptop'],
  [/تعليم|درس|دروس|تدريس|tutor|lesson|class|course|teach|school/u, 'graduation-cap'], [/اسنان|تقويم|تبييض|dental|tooth|teeth|orthodont|whitening|implant/u, 'smile'], [/عيون|نظر|بصر|eye|optic|vision|lens/u, 'eye'],
  [/جلديه|بشره|skin|derma|facial/u, 'sparkle'], [/قلب|ضغط|heart|cardio|blood/u, 'heart-pulse'], [/اطفال|طفل|رضع|child|kids|baby|pediatric|paediatric/u, 'baby'],
  [/تجميل|مكياج|beauty|makeup|cosmetic/u, 'sparkles'], [/شعر|حلاقه|قص|hair|barber|cut|salon/u, 'scissors'], [/لياقه|رياضه|تمارين|gym|fitness|training|workout/u, 'dumbbell'],
  [/قهوه|كوفي|شاي|coffee|tea|latte|espresso/u, 'coffee'], [/بيتزا|pizza/u, 'pizza'], [/برجر|برغر|ساندويش|burger|sandwich|wrap/u, 'sandwich'], [/كيك|حلوي|حلويات|تورته|cake|sweet|dessert|pastry|cookie/u, 'cake'],
  [/ايس كريم|بوظه|ice cream|gelato/u, 'ice-cream-cone'], [/شاورما|مشاوي|مشوي|لحم|كباب|steak|grill|kebab|shawarma|meat|lamb|chicken/u, 'beef'], [/سمك|بحري|fish|seafood|prawn|shrimp/u, 'fish'],
  [/عصير|مشروب|سموذي|juice|drink|smoothie|soda|shake/u, 'cup-soda'], [/فطور|بيض|breakfast|egg|brunch/u, 'egg'], [/خبز|مخبوزات|كرواسون|bread|bakery|croissant|pastr/u, 'croissant'], [/شوربه|حساء|soup/u, 'soup'],
  [/قميص|ملابس|فستان|عبايه|shirt|cloth|dress|abaya|fashion|wear/u, 'shirt'], [/عطر|عود|بخور|perfume|oud|fragrance|scent/u, 'flower-2'], [/حقيبه|شنطه|bag|purse|backpack/u, 'shopping-bag'],
  [/مجوهرات|ذهب|خاتم|jewel|gold|ring|diamond|silver/u, 'gem'], [/هديه|هدايا|gift|present/u, 'gift'], [/جوال|موبايل|هاتف ذكي|mobile|smartphone|iphone|samsung/u, 'smartphone'],
  [/كتاب|كتب|book|novel|reading/u, 'book-open'], [/سفر|سياحه|طيران|travel|flight|tour|trip|holiday/u, 'plane'], [/فندق|سكن|اقامه|hotel|stay|room|bed/u, 'bed'], [/عقار|شقه|منزل|بيت|فيلا|property|house|home|flat|apartment|estate|villa/u, 'house'],
  [/بناء|مقاولات|ترميم|تشطيب|construction|build|renovation|roof|finishing/u, 'hard-hat'], [/ترجمه|لغه|translate|language/u, 'globe'], [/طباعه|print/u, 'printer'], [/موسيقي|music|dj|sound/u, 'music'], [/فيديو|مونتاج|video|film|edit/u, 'video'],
  [/استشاره|استشارات|consult|advice|strategy/u, 'handshake'], [/حجز|موعد|book|appointment|reserv/u, 'calendar-days'], [/وقت|مواعيد|ساعات|time|hours|schedule/u, 'clock'], [/تسليم|bike|scooter/u, 'bike'],
  [/ورشه|اعمال|مشروع|project|work|portfolio/u, 'briefcase'], [/معرض|لوحه|فن|art|exhibition|gallery|painting/u, 'palette'], [/كتابه|محتوي|مقال|writing|content|article|copy/u, 'pen-tool'], [/هندسه|معماري|architect|engineer|plan|drawing/u, 'ruler'],
];
const KIND_ICON: Readonly<Record<SiteKind, string>> = { services: 'wrench', restaurant: 'utensils', clinic: 'stethoscope', portfolio: 'sparkles', catalogue: 'shopping-bag', landing: 'check' };
export function iconFor(item: Pick<SiteItem, 'title' | 'detail'>, kind: SiteKind): string {
  const text = normalize(`${item.title} ${item.detail ?? ''}`);
  for (const [pattern, icon] of ICON_WORDS) if (pattern.test(text)) return icon;
  return KIND_ICON[kind];
}

/* ---------- shared pieces ---------- */

/** A section heading; when it repeats the page title it stays in the outline but not on screen. */
const sectionHead = (title: string, lead?: string, ctx?: RenderContext) => {
  const repeats = ctx && ctx.page.path !== 'index.html' && oneLine(title) === oneLine(ctx.page.title);
  return el('div', { class: 'section-head' }, el('h2', repeats ? { class: 'sr-only' } : {}, escapeText(oneLine(title))), lead ? el('p', { class: 'lead' }, escapeText(lead)) : '');
};
const imageTag = (image: SiteImageAsset, className: string, sizes: string, eager = false) => {
  const src = `assets/${image.id}.${image.ext}`;
  const srcset = image.small ? `assets/${image.id}-small.${image.ext} 640w, ${src} ${image.width}w` : undefined;
  return `<img${attrs({ class: className, src, srcset, sizes: srcset ? sizes : undefined, alt: image.alt, width: image.width, height: image.height, loading: eager ? 'eager' : 'lazy', decoding: 'async' })}>`;
};
const asset = (ctx: RenderContext, id?: string) => (id ? ctx.images.find(image => image.id === id) : undefined);
const section = (id: string, className: string, ...children: string[]) => el('section', { class: `section ${className}`, id }, el('div', { class: 'container' }, ...children));

/* ---------- blocks ---------- */

type Block<T extends SiteBlock['type']> = Extract<SiteBlock, { type: T }>;

function hero(ctx: RenderContext, block: Block<'hero'>): string {
  const { brief, writer } = ctx;
  const variant = block.variant ?? ctx.variants.hero;
  const heroAsset = asset(ctx, block.image) ?? asset(ctx, brief.images.find(image => image.role === 'hero')?.id);
  const title = block.title ?? writer.text('heroTitle');
  const lead = block.lead ?? (brief.kind === 'landing' && brief.offer ? brief.offer : brief.tagline ?? writer.text('heroLead'));
  const action = primaryAction(ctx), secondary = secondaryAction(ctx);
  const actions = el('div', { class: 'actions' }, action ? button(action.href, action.label, 'primary', action.icon, action.href.startsWith('https://')) : '', secondary ? button(secondary.href, secondary.label, 'ghost') : '');
  const cityLine = brief.city ? el('p', { class: 'eyebrow' }, iconSvg('map-pin', { size: 16 }), el('span', {}, escapeText(brief.city))) : '';
  const art = heroAsset ? imageTag(heroAsset, 'hero-img', '(min-width: 760px) 50vw, 100vw', true) : el('div', { class: 'hero-art' }, heroArtSvg(ctx.theme, ctx.seed, initialOf(brief.name)));
  const text = el('div', { class: 'hero-text' }, cityLine, el('h1', {}, escapeText(oneLine(title))), lead ? el('p', { class: 'hero-lead' }, escapeText(oneLine(lead))) : '', actions);
  if (variant === 'centered') return el('section', { class: 'hero hero-centered', id: 'top' }, el('div', { class: 'container' }, text));
  return el('section', { class: `hero ${variant === 'cover' ? 'hero-cover' : 'hero-split'}`, id: 'top' }, el('div', { class: 'container hero-grid' }, text, art));
}
export function pageTitleBlock(ctx: RenderContext): string {
  return el('section', { class: 'hero hero-small' }, el('div', { class: 'container' }, el('h1', {}, escapeText(ctx.page.title))));
}
function itemCard(ctx: RenderContext, item: SiteItem): string {
  const image = asset(ctx, item.image);
  const price = item.price ? el('span', { class: 'price' }, escapeText(item.price)) : '';
  const order = ctx.kind === 'catalogue' && ctx.brief.whatsapp ? button(waLink(ctx.brief.whatsapp, ctx.writer.labels.messages.order.replace('{item}', item.title)), ctx.writer.labels.buttons.order, 'small', 'message-circle', true) : '';
  return el('article', { class: 'card' }, image ? imageTag(image, 'card-img', '(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw') : el('span', { class: 'card-icon' }, iconSvg(iconFor(item, ctx.kind), { size: 26 })), el('h3', {}, escapeText(oneLine(item.title))), item.detail ? el('p', {}, escapeText(item.detail)) : '', price || order ? el('div', { class: 'card-foot' }, price, order) : '');
}
const menuRow = (item: SiteItem) => el('li', { class: 'menu-row' }, el('div', { class: 'menu-text' }, el('h3', {}, escapeText(oneLine(item.title))), item.detail ? el('p', {}, escapeText(item.detail)) : ''), item.price ? el('span', { class: 'menu-price' }, escapeText(item.price)) : '');
const listRow = (ctx: RenderContext, item: SiteItem) => el('li', { class: 'list-row' }, el('span', { class: 'list-icon' }, iconSvg(iconFor(item, ctx.kind), { size: 20 })), el('div', {}, el('h3', {}, escapeText(oneLine(item.title))), item.detail ? el('p', {}, escapeText(item.detail)) : ''), item.price ? el('span', { class: 'price' }, escapeText(item.price)) : '');
function tile(ctx: RenderContext, item: SiteItem, index: number): string {
  const own = asset(ctx, item.image);
  const gallery = ctx.images.filter(image => image.role === 'gallery');
  const image = own ?? (gallery.length ? gallery[index % gallery.length] : undefined);
  const visual = image ? imageTag(image, 'tile-img', '(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw') : el('div', { class: `tile-art tile-art-${(index % 3) + 1}` }, iconSvg(iconFor(item, ctx.kind), { size: 34 }));
  return el('article', { class: 'tile' }, visual, el('div', { class: 'tile-text' }, el('h3', {}, escapeText(oneLine(item.title))), item.detail ? el('p', {}, escapeText(item.detail)) : '', item.price ? el('span', { class: 'price' }, escapeText(item.price)) : ''));
}
function itemsBlock(ctx: RenderContext, block: Block<'items'>, id: string): string {
  const { brief, writer } = ctx;
  const own = Boolean(block.items);
  const all = block.items ?? brief.items;
  if (!all.length) return '';
  const limit = block.limit ?? (own ? undefined : block.limit);
  const items = limit ? all.slice(0, limit) : all;
  const layout = block.layout ?? (own ? 'tiles' : ctx.variants.items);
  const fullPage = !own ? ctx.pages.find(page => page.path !== ctx.page.path && page.blocks.some(other => other.type === 'items' && !other.items && !other.limit)) : undefined;
  const title = block.title ?? (own ? PAGE_TITLES[ctx.lang].projects! : writer.text(limit && all.length > items.length ? 'highlightsTitle' : 'itemsTitle'));
  const lead = block.lead ?? (own ? undefined : writer.text('itemsLead'));
  const body = layout === 'menu' ? el('ul', { class: 'menu-list' }, ...items.map(menuRow)) : layout === 'tiles' ? el('div', { class: 'tiles' }, ...items.map((item, index) => tile(ctx, item, index))) : layout === 'list' ? el('ul', { class: 'list-rows' }, ...items.map(item => listRow(ctx, item))) : el('div', { class: 'cards' }, ...items.map(item => itemCard(ctx, item)));
  const more = fullPage && all.length > items.length ? el('p', { class: 'more' }, button(fullPage.path, writer.labels.buttons.viewAll, 'ghost')) : '';
  return section(id, 'items', sectionHead(title, lead, ctx), body, more);
}
const text = (block: Block<'text'>, ctx: RenderContext, id: string) => {
  const image = asset(ctx, block.image);
  return section(id, `about ${image ? 'about-grid' : ''}`, el('div', {}, block.title ? sectionHead(block.title, undefined, ctx) : '', el('div', { class: 'prose' }, paragraphs(block.body))), image ? imageTag(image, 'about-img', '(min-width: 760px) 40vw, 100vw') : '');
};
const features = (block: Block<'features'>, ctx: RenderContext, id: string) => section(id, 'features', sectionHead(block.title ?? PAGE_TITLES[ctx.lang].features!, block.lead, ctx), el('ul', { class: 'points' }, ...block.points.map(point => el('li', {}, el('span', { class: 'point-icon' }, iconSvg('check', { size: 18 })), el('div', {}, el('h3', {}, escapeText(oneLine(point.title))), point.detail ? el('p', {}, escapeText(point.detail)) : '')))));
const steps = (block: Block<'steps'>, ctx: RenderContext, id: string) => section(id, 'steps', sectionHead(block.title ?? PAGE_TITLES[ctx.lang].steps!, block.lead, ctx), el('ol', { class: 'steps-list' }, ...block.steps.map(step => el('li', {}, el('h3', {}, escapeText(oneLine(step.title))), step.detail ? el('p', {}, escapeText(step.detail)) : ''))));
const gallery = (block: Block<'gallery'>, ctx: RenderContext, id: string) => {
  const images = block.images ? block.images.map(imageId => asset(ctx, imageId)).filter((image): image is SiteImageAsset => Boolean(image)) : ctx.images.filter(image => image.role === 'gallery');
  if (!images.length) return '';
  return section(id, 'gallery', sectionHead(block.title ?? ctx.writer.text('galleryTitle'), undefined, ctx), el('div', { class: 'gallery-grid' }, ...images.map(image => el('figure', {}, imageTag(image, 'gallery-img', '(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw'), el('figcaption', { class: 'sr-only' }, escapeText(image.alt))))));
};
const team = (block: Block<'team'>, ctx: RenderContext, id: string) => section(id, 'team', sectionHead(block.title ?? PAGE_TITLES[ctx.lang].team!, block.lead, ctx), el('div', { class: 'people' }, ...block.members.map(member => {
  const image = asset(ctx, member.image);
  return el('article', { class: 'person' }, image ? imageTag(image, 'person-img', '160px') : el('span', { class: 'person-initial', 'aria-hidden': 'true' }, escapeText(initialOf(member.name))), el('h3', {}, escapeText(oneLine(member.name))), member.role ? el('p', { class: 'role' }, escapeText(member.role)) : '', member.bio ? el('p', {}, escapeText(member.bio)) : '');
})));
const faq = (block: Block<'faq'>, ctx: RenderContext, id: string) => section(id, 'faq', sectionHead(block.title ?? PAGE_TITLES[ctx.lang].faq!, undefined, ctx), el('div', { class: 'faq-list' }, ...block.entries.map((entry, index) => el('details', index === 0 ? { open: true } : {}, el('summary', {}, el('span', {}, escapeText(oneLine(entry.question))), iconSvg('chevron-down', { size: 20 })), el('div', { class: 'faq-answer prose' }, paragraphs(entry.answer))))));
const pricing = (block: Block<'pricing'>, ctx: RenderContext, id: string) => section(id, 'pricing', sectionHead(block.title ?? PAGE_TITLES[ctx.lang].pricing!, block.lead, ctx), el('div', { class: 'plans' }, ...block.plans.map(plan => el('article', { class: `plan ${plan.featured ? 'plan-featured' : ''}` }, el('h3', {}, escapeText(oneLine(plan.name))), plan.price ? el('p', { class: 'plan-price' }, el('strong', {}, escapeText(plan.price)), plan.period ? el('span', {}, escapeText(plan.period)) : '') : '', plan.features.length ? el('ul', {}, ...plan.features.map(feature => el('li', {}, iconSvg('check', { size: 16 }), el('span', {}, escapeText(feature))))) : '', plan.note ? el('p', { class: 'plan-note' }, escapeText(plan.note)) : '', (() => { const action = primaryAction(ctx); return action ? button(action.href, action.label, 'primary', action.icon, action.href.startsWith('https://')) : ''; })()))));
const testimonials = (block: Block<'testimonials'>, ctx: RenderContext, id: string) => {
  const entries = block.entries ?? ctx.brief.testimonials;
  if (!entries.length) return '';
  return section(id, 'testimonials', sectionHead(block.title ?? ctx.writer.text('testimonialsTitle'), undefined, ctx), el('div', { class: 'quotes' }, ...entries.map(quote => el('figure', { class: 'quote' }, iconSvg('quote', { size: 22 }), el('blockquote', {}, el('p', {}, escapeText(quote.quote))), el('figcaption', {}, escapeText(quote.name))))));
};
const facts = (block: Block<'facts'>, ctx: RenderContext, id: string) => section(id, 'facts', block.title ? sectionHead(block.title) : '', el('dl', { class: 'facts-grid' }, ...block.items.map(fact => el('div', { class: 'fact' }, el('dd', {}, escapeText(fact.value)), el('dt', {}, escapeText(fact.label))))));
const hours = (block: Block<'hours'>, ctx: RenderContext, id: string) => {
  const lines = block.lines ?? ctx.brief.hours ?? [];
  if (!lines.length) return '';
  return section(id, 'hours', el('div', { class: 'hours-card' }, el('span', { class: 'card-icon' }, iconSvg('clock', { size: 26 })), el('div', {}, el('h2', {}, escapeText(block.title ?? ctx.writer.text('hoursTitle'))), el('ul', { class: 'hours-list' }, ...lines.map(line => el('li', {}, escapeText(line)))))));
};
const cta = (block: Block<'cta'>, ctx: RenderContext, id: string) => {
  const { writer } = ctx;
  const action = primaryAction(ctx);
  const hasContact = ctx.pages.some(page => page.blocks.some(other => other.type === 'contact'));
  if (!action && !hasContact) return '';
  return el('section', { class: 'section cta', id }, el('div', { class: 'container cta-band' }, el('div', {}, el('h2', {}, escapeText(oneLine(block.title ?? writer.text('ctaTitle')))), el('p', {}, escapeText(block.lead ?? writer.text('ctaLead')))), el('div', { class: 'actions' }, action ? button(action.href, action.label, 'primary', action.icon, action.href.startsWith('https://')) : '', hasContact && ctx.page.path !== 'contact.html' ? button(contactHref(ctx), writer.labels.nav.contact, 'ghost') : '')));
};
const contactCard = (icon: string, label: string, value: string, href?: string, external = false) => el('div', { class: 'contact-card' }, el('span', { class: 'card-icon' }, iconSvg(icon, { size: 24 })), el('div', {}, el('span', { class: 'contact-label' }, escapeText(label)), href ? el('a', { href, ...(external ? { rel: 'noopener', target: '_blank' } : {}) }, escapeText(value)) : el('span', {}, escapeText(value))));
function social(ctx: RenderContext): string {
  const links = Object.entries(ctx.brief.social ?? {}).filter((entry): entry is [string, string] => Boolean(entry[1]));
  if (!links.length) return '';
  const icons: Record<string, string> = { instagram: 'instagram', facebook: 'facebook', youtube: 'youtube', linkedin: 'linkedin', tiktok: 'music', x: 'send' };
  return el('div', { class: 'social' }, el('span', { class: 'contact-label' }, escapeText(ctx.writer.labels.fields.follow)), ...links.map(([network, href]) => el('a', { href, rel: 'noopener', target: '_blank', 'aria-label': network }, iconSvg(icons[network] ?? 'globe', { size: 20 }))));
}
function contactForm(ctx: RenderContext): string {
  const { brief, writer, options } = ctx;
  const { form } = writer.labels;
  const endpoint = options.formEndpoint;
  const note = endpoint ? form.noteEndpoint : brief.whatsapp ? form.noteWhatsapp : brief.email ? form.noteEmail : null;
  if (!note) return '';
  const action = endpoint ?? (brief.whatsapp ? waLink(brief.whatsapp, '') : `mailto:${brief.email}`);
  const data = { 'data-whatsapp': !endpoint && brief.whatsapp ? telDigits(brief.whatsapp).replace('+', '') : undefined, 'data-email': !endpoint && !brief.whatsapp ? brief.email : undefined, 'data-subject': form.subject.replace('{name}', brief.name) };
  const input = (name: string, label: string, type = 'text') => el('label', { class: 'field' }, el('span', {}, escapeText(label)), `<input${attrs({ name, type, required: true, autocomplete: name === 'name' ? 'name' : 'off' })}>`);
  return el('form', { class: 'contact-form', method: 'post', action, ...(endpoint ? {} : { 'data-compose': 'true' }), ...data },
    endpoint ? `<input type="hidden" name="site" value="${escapeAttribute(brief.name)}">` : '',
    el('div', { class: 'field-row' }, input('name', form.name), input('contact', form.contact)),
    el('label', { class: 'field' }, el('span', {}, escapeText(form.message)), `<textarea name="message" rows="5" required></textarea>`),
    el('button', { class: 'btn btn-primary', type: 'submit' }, iconSvg('send', { size: 18 }), el('span', {}, escapeText(form.send))),
    el('p', { class: 'form-note' }, escapeText(note)),
  );
}
const contact = (block: Block<'contact'>, ctx: RenderContext, id: string) => {
  const { brief, writer } = ctx;
  const { labels } = writer;
  const cards = [
    brief.phone ? contactCard('phone', labels.fields.phone, brief.phone, `tel:${telDigits(brief.phone)}`) : '',
    brief.whatsapp ? contactCard('message-circle', labels.fields.whatsapp, brief.whatsapp, waLink(brief.whatsapp, labels.messages.enquiry.replace('{name}', brief.name)), true) : '',
    brief.email ? contactCard('mail', labels.fields.email, brief.email, `mailto:${brief.email}`) : '',
    brief.address || brief.city ? contactCard('map-pin', labels.fields.address, [brief.address, brief.city].filter(Boolean).join(brief.lang === 'ar' ? '، ' : ', '), brief.mapUrl, true) : '',
  ];
  const form = block.form ? contactForm(ctx) : '';
  return section(id, 'contact', sectionHead(block.title ?? writer.text('contactTitle'), block.lead ?? writer.text('contactLead')), el('div', { class: form ? 'contact-layout' : '' }, el('div', { class: 'contact-grid' }, ...cards), form), social(ctx));
};
const map = (_block: Block<'map'>, ctx: RenderContext, id: string) => {
  const { brief, writer } = ctx;
  if (!brief.mapUrl && !brief.address) return '';
  return section(id, 'map', el('div', { class: 'map-card' }, el('span', { class: 'card-icon' }, iconSvg('navigation', { size: 26 })), el('div', {}, brief.address ? el('p', {}, escapeText(brief.address)) : '', brief.mapUrl ? button(brief.mapUrl, writer.labels.buttons.directions, 'ghost', 'external-link', true) : '')));
};
const posts = (block: Block<'posts'>, ctx: RenderContext, id: string) => section(id, 'posts', sectionHead(block.title ?? PAGE_TITLES[ctx.lang].posts!, undefined, ctx), el('div', { class: 'posts' }, ...block.posts.map(post => el('article', { class: 'post' }, el('h3', {}, escapeText(oneLine(post.title))), post.date ? el('p', { class: 'post-date' }, escapeText(post.date)) : '', el('div', { class: 'prose' }, paragraphs(post.body))))));

/** Renders one block. Blocks without content render nothing, so a page never shows an empty section. */
export function renderBlock(ctx: RenderContext, block: SiteBlock, index: number): string {
  const id = ctx.page.blocks.filter((other, position) => other.type === block.type && position < index).length ? `${block.type}-${index}` : block.type;
  switch (block.type) {
    case 'hero': return hero(ctx, block);
    case 'items': return itemsBlock(ctx, block, id);
    case 'text': return text(block, ctx, id);
    case 'features': return features(block, ctx, id);
    case 'steps': return steps(block, ctx, id);
    case 'gallery': return gallery(block, ctx, id);
    case 'team': return team(block, ctx, id);
    case 'faq': return faq(block, ctx, id);
    case 'pricing': return pricing(block, ctx, id);
    case 'testimonials': return testimonials(block, ctx, id);
    case 'facts': return facts(block, ctx, id);
    case 'hours': return hours(block, ctx, id);
    case 'contact': return contact(block, ctx, id);
    case 'map': return map(block, ctx, id);
    case 'cta': return cta(block, ctx, id);
    case 'posts': return posts(block, ctx, id);
    default: return '';
  }
}

/* ---------- header, footer, 404 ---------- */

const ANCHOR_TYPES: readonly SiteBlock['type'][] = ['items', 'text', 'features', 'steps', 'gallery', 'team', 'faq', 'pricing', 'testimonials', 'posts', 'contact'];
function navLinks(ctx: RenderContext): { href: string; label: string; current: boolean }[] {
  const { brief, writer, pages } = ctx;
  const multi = pages.filter(page => page.inNav);
  if (multi.length > 1) return multi.map(page => ({ href: page.path, label: page.path === 'index.html' ? writer.labels.nav.home : page.title, current: page.path === ctx.page.path }));
  const index = pages.find(page => page.path === 'index.html') ?? pages[0]!;
  const titles = PAGE_TITLES[ctx.lang];
  const labelFor = (block: SiteBlock): string => {
    switch (block.type) {
      case 'items': return block.items ? block.title ?? titles.projects! : writer.labels.nav.items[brief.kind];
      case 'text': return block.title ?? titles.about!;
      case 'contact': return writer.labels.nav.contact;
      case 'gallery': return writer.labels.nav.gallery;
      default: return (block as { title?: string }).title ?? titles[block.type] ?? block.type;
    }
  };
  const seen = new Set<string>();
  return index.blocks.flatMap((block, position) => {
    if (!ANCHOR_TYPES.includes(block.type) || seen.has(block.type)) return [];
    seen.add(block.type);
    const id = index.blocks.filter((other, at) => other.type === block.type && at < position).length ? `${block.type}-${position}` : block.type;
    return [{ href: `${ctx.page.path === 'index.html' ? '' : 'index.html'}#${id}`, label: labelFor(block), current: false }];
  }).slice(0, 6);
}
export function header(ctx: RenderContext): string {
  const { brief, writer } = ctx;
  const links = navLinks(ctx);
  const action = primaryAction(ctx);
  return el('header', { class: 'site-header' }, el('div', { class: 'container header-row' },
    el('a', { class: 'brand', href: 'index.html' }, `<img class="brand-mark" src="assets/logo.svg" alt="" width="40" height="40">`, el('span', { class: 'brand-name' }, escapeText(oneLine(brief.name)))),
    `<button class="nav-toggle" type="button" aria-expanded="false" aria-controls="site-nav" aria-label="${escapeAttribute(writer.labels.buttons.menu)}">${iconSvg('menu', { size: 24, className: 'icon-open' })}${iconSvg('x', { size: 24, className: 'icon-close' })}</button>`,
    el('nav', { id: 'site-nav', class: 'site-nav', 'aria-label': writer.labels.buttons.menu }, el('ul', {}, ...links.map(link => el('li', {}, el('a', { href: link.href, ...(link.current ? { 'aria-current': 'page' } : {}) }, escapeText(link.label))))), action ? button(action.href, action.label, 'primary', action.icon, action.href.startsWith('https://')) : ''),
  ));
}
export function footer(ctx: RenderContext): string {
  const { brief, writer } = ctx;
  const nav = ctx.pages.filter(page => page.inNav);
  const line = [brief.phone, brief.email, brief.city].filter(Boolean).map(value => escapeText(value!)).join(' · ');
  return el('footer', { class: 'site-footer' }, el('div', { class: 'container footer-grid' },
    el('div', {}, el('strong', { class: 'brand-name' }, escapeText(oneLine(brief.name))), brief.tagline ? el('p', {}, escapeText(brief.tagline)) : '', line ? el('p', { class: 'footer-line' }, line) : ''),
    nav.length > 1 ? el('nav', { 'aria-label': writer.labels.nav.home }, el('ul', {}, ...nav.map(page => el('li', {}, el('a', { href: page.path }, escapeText(page.path === 'index.html' ? writer.labels.nav.home : page.title)))))) : '',
    el('p', { class: 'rights' }, escapeText(writer.text('footerRights'))),
  ));
}
export function notFound(ctx: RenderContext): string {
  const { writer } = ctx;
  return el('section', { class: 'hero hero-small notfound' }, el('div', { class: 'container' }, el('h1', {}, escapeText(writer.text('notFoundTitle'))), el('p', { class: 'lead' }, escapeText(writer.text('notFoundLead'))), el('div', { class: 'actions' }, button('index.html', writer.labels.buttons.backHome, 'primary', ctx.dir === 'rtl' ? 'arrow-right' : 'arrow-left'))));
}
export const pageOf = (ctx: RenderContext, path: string): SitePage | undefined => ctx.pages.find(page => page.path === path);
