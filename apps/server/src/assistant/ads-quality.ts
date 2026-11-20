/**
 * The brain's quality pass over the Ads model's checked picks (owner, 2026-11-14: "improve quality").
 *
 * The model learnt the teacher's selection rules, which accept any short line of the page: menu
 * items, legal links, opening hours, people's names, half sentences. checkSiteAds only proves a
 * line is on the site and within Google's limits; it does not say the line sells anything.
 * This pass keeps the model's picks that read as ad copy, orders them by how close they are to
 * what the site is about, and keeps as keywords only phrases a customer could search for.
 *
 * It never adds headlines or descriptions the model did not pick. The only words it adds are
 * keywords: from the owner's own sentence (service, and service + each place), and the search
 * phrases the site itself uses for what it sells (alone, and with the owner's first place).
 */
import { ADS_LIMITS } from '@mohassan/google-ads';
import { domainToUnicode } from 'node:url';

export interface AdsCopy { business: string | null; headlines: string[]; descriptions: string[]; keywords: string[] }
export interface AdsPage { site: string; title: string; text: string }
/** services: search phrases the site itself uses (its services and headings), used only for keywords. */
export interface AdsIntent { service: string | null; locations: readonly string[]; services?: readonly string[] }

const STOP = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'have', 'in', 'is', 'it', 'its', 'of', 'on', 'or', 'our',
  'that', 'the', 'their', 'this', 'to', 'we', 'with', 'you', 'your', 'us', 'all', 'more', 'new', 'get', 'can', 'will', 'not', 'any', 'one',
  'في', 'من', 'إلى', 'الى', 'على', 'عن', 'مع', 'هذه', 'هذا', 'نحن', 'لدينا', 'لك', 'لكم', 'لنا', 'كل', 'أو', 'او', 'و', 'هو', 'هي', 'يمكنك']);

/** Words that mark site furniture rather than an offer: navigation, legal, social, hours, forms, page states. */
const CHROME = new Set([
  'terms', 'conditions', 'policy', 'policies', 'privacy', 'cookie', 'cookies', 'disclaimer', 'legal', 'sitemap', 'accessibility', 'copyright',
  'top', 'page', 'menu', 'navigation', 'home', 'homepage', 'back', 'skip', 'search', 'login', 'logout', 'account', 'register', 'cart', 'basket', 'checkout',
  'facebook', 'twitter', 'instagram', 'youtube', 'linkedin', 'tiktok', 'pinterest', 'whatsapp', 'social', 'media', 'follow', 'share', 'subscribe', 'newsletter',
  'calendar', 'schedule', 'hours', 'closed', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'thanksgiving', 'christmas', 'easter', 'holidays',
  'directory', 'staff', 'careers', 'jobs', 'vacancies', 'members', 'membership', 'blog', 'news', 'articles', 'article', 'insights', 'insight', 'events', 'press',
  'history', 'timeline', 'mission', 'vision', 'values', 'goals', 'impact', 'process', 'story', 'about', 'welcome', 'hello', 'introduction',
  'contact', 'information', 'form', 'question', 'comment', 'comments', 'submit', 'send', 'message', 'enquiry', 'connect', 'join',
  'learn', 'read', 'visit', 'view', 'click', 'tap', 'download', 'watch', 'video', 'videos', 'channel', 'found', 'loading', 'error',
  'faq', 'faqs', 'help', 'support', 'reviews', 'testimonials', 'shipping', 'returns', 'vat', 'stock', 'colour', 'color', 'size', 'quantity',
  'other', 'misc', 'categories', 'category', 'tags', 'archive', 'archives', 'resources', 'links', 'scenarios', 'capability', 'capabilities',
  'partner', 'partners', 'network', 'sponsors', 'accept', 'payment', 'payments', 'visa', 'mastercard', 'amex', 'paypal', 'klarna', 'apple', 'google', 'pay',
  'الخصوصية', 'الكوكيز', 'الشروط', 'الأحكام', 'الرئيسية', 'القائمة', 'التسجيل', 'الدخول', 'السلة', 'الحقوق', 'المدونة', 'الوظائف', 'تسجيل',
]);
/** A headline that ends on one of these was cut mid-phrase ("Indian Restaurant in", "Connect With"). */
const DANGLING = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'into', 'of', 'on', 'or', 'the', 'to', 'with', 'our', 'your', 'st', 'near', 'than', 'في', 'من', 'إلى', 'الى', 'على', 'عن', 'مع', 'أو', 'او']);
/** A keyword is a search phrase, so it carries no pronoun or question word. */
const NOT_SEARCH = new Set(['who', 'what', 'when', 'where', 'why', 'how', 'which', 'i', 'me', 'my', 'we', 'our', 'us', 'you', 'your', 'it', 'they', 'them', 'he', 'she',
  'now', 'today', 'here', 'there', 'welcome', 'inspired', 'take', 'action', 'choose', 'look', 'elsewhere', 'most', 'popular', 'available', 'over', 'free',
  // Calls to action and page words: a customer does not search for "order online" or "service area".
  'order', 'shop', 'check', 'compare', 'talk', 'text', 'explore', 'request', 'book', 'call', 'area', 'areas', 'quick', 'exclusive', 'online',
  'اتصل', 'احجز', 'تواصل', 'اكتشف', 'اقرأ', 'المزيد', 'اليوم', 'الآن', 'هنا', 'أين', 'كيف', 'لماذا', 'من', 'نحن']);
/** One of these alone says nothing about this business ("Solutions", "Quality"). */
const GENERIC = new Set(['industries', 'industry', 'solutions', 'solution', 'services', 'service', 'products', 'product', 'installation', 'warranty', 'research',
  'strategy', 'quality', 'family', 'growth', 'experience', 'integrity', 'parent', 'parents', 'academics', 'properties', 'collection', 'collections',
  'portfolio', 'gallery', 'projects', 'work', 'team', 'company', 'overview', 'features', 'pricing', 'prices', 'offers', 'deals', 'leveraging', 'budget', 'premium', 'standard',
  'الخدمات', 'خدمات', 'المنتجات', 'الجودة', 'الفريق', 'الشركة', 'الأسعار', 'المشاريع', 'العروض']);
/** Shop labels with no offer in them ("Most popular", "Mid-range", "Best sellers"). */
const FILLER = new Set(['most', 'popular', 'mid', 'range', 'best', 'seller', 'sellers', 'bestseller', 'bestsellers', 'featured', 'latest', 'recommended', 'top', 'rated',
  'new', 'arrivals', 'trending', 'special', 'offers', 'offer', 'deals', 'deal', 'sale', 'budget', 'premium', 'standard', 'basic', 'luxury', 'value', 'choice', 'pick', 'picks', 'favourite', 'favourites', 'favorite', 'favorites']);
const FILE = /\.(?:png|jpe?g|gif|svg|webp|pdf|docx?)$/i;

const tokens = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const stem = (word: string) => word.length > 4 && word.endsWith('ies') ? `${word.slice(0, -3)}y` : word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
const content = (text: string) => tokens(text).filter(word => word.length > 2 && !STOP.has(word) && !/^\d+$/.test(word)).map(stem);

/** "Mary T", "Shon H": a first name and an initial is a person, not an offer. */
const PERSON = /^\p{Lu}\p{Ll}+ \p{Lu}\.?$/u;
/** A word glued to a number ("What We Buy3") is a broken extract. */
const GLUED = /\p{Ll}\d+$|\p{Ll}\p{Lu}\p{Ll}*\p{Lu}/u;
const NON_ENGLISH = /[äöüßàâçèêëîïôûùÿñ]/i;

/** Page chrome or a call to action, never an offer: also used to filter suggested services. */
export function notAnOffer(text: string): boolean {
  return junk(text) || tokens(text).some(word => NOT_SEARCH.has(word) || OFFER_NOISE.has(word));
}
/** Words of site furniture that are not services ("Fully Insured", "Processed by Stripe"). */
const OFFER_NOISE = new Set(['insured', 'insurance', 'stripe', 'processed', 'works', 'related', 'questions', 'roll', 'stocked', 'trusted', 'rated', 'guarantee', 'guaranteed', 'secure', 'checked', 'certified', 'approved', 'accredited', 'coverage', 'pricing', 'prices', 'price', 'breakdown', 'example', 'examples', 'real']);

function junk(text: string): boolean {
  const words = tokens(text);
  const last = text.trim().split(/\s+/).at(-1)?.toLowerCase().replace(/[^\p{L}]/gu, '') ?? '';
  return !words.length || words.some(word => CHROME.has(word)) || /\bcheck\s+out\b/i.test(text) || FILE.test(text.trim())
    || (words.length === 1 && GENERIC.has(words[0]!)) || words.every(word => FILLER.has(word)) || DANGLING.has(last) || PERSON.test(text) || NON_ENGLISH.test(text)
    || text.split(/\s+/).some(word => GLUED.test(word));
}

interface Topic { core: Set<string>; frequency: Map<string, number>; business: Set<string> }
function topicOf(page: AdsPage, intent: AdsIntent | null, business: string | null): Topic {
  const businessWords = new Set(content(business ?? ''));
  const core = new Set([...content(page.title), ...content(intent?.service ?? '')].filter(word => !CHROME.has(word)));
  const frequency = new Map<string, number>();
  for (const word of content(page.text)) frequency.set(word, (frequency.get(word) ?? 0) + 1);
  return { core, frequency, business: businessWords };
}

/** Higher means closer to what the site sells; below 1 the line says nothing about it. */
function relevance(text: string, topic: Topic): number {
  const words = content(text);
  const core = words.filter(word => topic.core.has(word) && !topic.business.has(word)).length;
  const echoed = words.filter(word => (topic.frequency.get(word) ?? 0) >= 2).length;
  return core * 3 + echoed;
}

const squash = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const TLD = new Set(['com', 'co', 'uk', 'org', 'net', 'au', 'ca', 'nz', 'ie', 'us', 'io', 'in', 'za', 'info', 'biz', 'www', 'ae', 'sa', 'example']);
/** "Duke Street Tyres" names dukestreettyres.com: the name, squashed, starts the domain's main label or the label starts it. */
export function namesSite(name: string, site: string): boolean {
  const label = domainToUnicode(site).toLowerCase().split('.').filter(part => !TLD.has(part)).sort((a, b) => b.length - a.length)[0] ?? '';
  const key = squash(name);
  return key.length >= 3 && label.length >= 3 && (label.startsWith(key) && key.length >= label.length * 0.5 || key.startsWith(label));
}

const cap = (text: string) => text.replace(/^\p{Ll}/u, letter => letter.toUpperCase());

/** " duke street " sits inside " duke street tyres ": whole words only, so "Tyre" is not inside "Tyres". */
const wordsOf = (text: string) => ` ${tokens(text).join(' ')} `;
/** A line that is only a piece of a longer kept line ("Duke", "Duke Street" next to "Duke Street Tyres") adds nothing. */
function withoutFragments(lines: string[]): string[] {
  const keys = lines.map(wordsOf);
  return lines.filter((_, index) => !keys.some((other, at) => at !== index && other.length > keys[index]!.length && other.includes(keys[index]!)));
}
/**
 * Lines that differ only in their numbers ("From £55 fitted", "From £75 fitted") say one thing:
 * one is kept, the first in order, except that a "from" price keeps its lowest, which is what
 * "from" means.
 */
function distinct(lines: string[]): string[] {
  const groups = new Map<string, string[]>();
  for (const line of lines) {
    const key = tokens(line).map(word => /\d/.test(word) ? '#' : word).join(' ');
    groups.set(key, [...(groups.get(key) ?? []), line]);
  }
  const lowest = (group: string[]) => group.reduce((best, line) => (Number(/\d+(?:\.\d+)?/.exec(line)?.[0] ?? Infinity) < Number(/\d+(?:\.\d+)?/.exec(best)?.[0] ?? Infinity) ? line : best));
  const keep = new Set([...groups.entries()].map(([key, group]) => group.length > 1 && /(?:^| )from #/.test(key) ? lowest(group) : group[0]!));
  return lines.filter(line => keep.delete(line));
}

/**
 * Picks the copy that sells. Returns null when fewer than Google's minimum headlines or
 * descriptions survive, so the caller can say so instead of showing weak copy.
 */
export function refineAds(ads: AdsCopy, page: AdsPage, intent: AdsIntent | null): AdsCopy | null {
  // The business name must spell the start of the domain, as the teacher's always did; a
  // picked line that does not ("Indian Restaurant in" for royalkingofspice...) is not the name.
  const business = ads.business !== null && namesSite(ads.business, page.site) ? ads.business : null;
  const topic = topicOf(page, intent, business);
  const isBusiness = (text: string) => business !== null && text.toLowerCase() === business.toLowerCase();

  const scored = ads.headlines.filter(text => isBusiness(text) || !junk(text)).map((text, order) => ({ text, order, score: isBusiness(text) ? 1000 : relevance(text, topic) }))
    // A line none of whose words the site repeats or names in its title ("Quality", "Growth",
    // "Speedy Van") says nothing about the offer; a product the site repeats ("Breads") does.
    .filter(item => item.score >= 1);
  const headlines = distinct(withoutFragments(scored.sort((a, b) => b.score - a.score || a.order - b.order).map(item => cap(item.text)))).slice(0, ADS_LIMITS.maxHeadlines);

  const descriptions = distinct(ads.descriptions.filter(text => !PERSON.test(text) && relevance(text, topic) >= 1)).slice(0, ADS_LIMITS.maxDescriptions);

  const keywords: string[] = [];
  const addKeyword = (text: string) => { const value = text.toLowerCase().replace(/\s+/g, ' ').trim(); if (value && !keywords.includes(value)) keywords.push(value); };
  // The owner's own words first: they name what is sold and where.
  if (intent?.service) {
    addKeyword(intent.service);
    for (const place of intent.locations) addKeyword(`${intent.service} ${place}`);
  }
  // Then the phrases the site itself uses for what it sells, alone and in the first place the
  // owner chose ("flat tyre", "flat tyre glasgow"): what customers search.
  for (const service of intent?.services ?? []) {
    const words = tokens(service);
    if (words.length < 2 || words.length > 5 || junk(service) || words.some(word => NOT_SEARCH.has(word)) || isBusiness(service) || relevance(service, topic) < 1) continue;
    addKeyword(service);
    if (intent?.locations[0]) addKeyword(`${service} ${intent.locations[0]}`);
  }
  for (const text of ads.keywords) {
    const words = tokens(text);
    if (words.length < 2 || words.length > 5 || junk(text) || words.some(word => NOT_SEARCH.has(word)) || isBusiness(text)) continue;
    if (relevance(text, topic) < 2) continue;
    addKeyword(text);
  }

  if (headlines.length < ADS_LIMITS.minHeadlines || descriptions.length < ADS_LIMITS.minDescriptions) return null;
  return { business, headlines, descriptions, keywords: keywords.slice(0, 15) };
}

/** Union of several checked answers, in order: more of the model's own picks to choose from. */
export function mergeAds(list: readonly AdsCopy[]): AdsCopy | null {
  if (!list.length) return null;
  const unique = (values: string[], max: number) => {
    const seen = new Set<string>(), out: string[] = [];
    for (const value of values) { const key = value.toLowerCase(); if (!seen.has(key) && out.length < max) { seen.add(key); out.push(value); } }
    return out;
  };
  return {
    business: list[0]!.business,
    headlines: unique(list.flatMap(item => item.headlines), 40),
    descriptions: unique(list.flatMap(item => item.descriptions), 12),
    keywords: unique(list.flatMap(item => item.keywords), 40),
  };
}
