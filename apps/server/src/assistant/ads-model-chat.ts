/**
 * Mohassan's own Ads model inside the main chat (owner's direction, 2026-11-13): the owner types
 * one English sentence and the brain plus the model do the rest.
 *
 *   sentence -> model (ads.goal.v2 pointers) -> checkGoal       : what, where, how much
 *   brain    -> reads the website (SafeNetwork), digests it      : the site's own lines
 *   lines    -> model (ads.site.v2 pointers) -> checkSiteAds     : headlines, descriptions, keywords
 *   brain    -> a Search campaign draft in the chat              : nothing is published
 *
 * The model only selects numbered words and lines; the brain turns the numbers back into the
 * exact text, and the checkers refuse anything not grounded in the sentence or the site. When no
 * candidate passes, the chat says so instead of showing unchecked copy.
 */
import type { LandingFetch } from '@mohassan/google-ads';
import type { AdsModelWorker } from '../ads-lab.js';
import { mergeAds, notAnOffer, refineAds } from './ads-quality.js';

type GoalModule = typeof import('../../../../scripts/ads-training/goal.js');
type PointerModule = typeof import('../../../../scripts/ads-training/pointer.js');
type SiteModule = typeof import('../../../../scripts/ads-training/site.js');
type Goal = import('../../../../scripts/ads-training/goal.js').Goal;
type SiteAds = import('../../../../scripts/ads-training/site.js').SiteAds;

/** What the brain must know before it can create a campaign in the account. */
export type AdsField = 'url' | 'service' | 'locations' | 'country' | 'budget' | 'goal';
export type AdsGoalKind = 'calls' | 'bookings' | 'leads';
/**
 * The campaign facts gathered so far, saved with the run between the brain's questions and the
 * owner's answer. Every value comes from the owner's sentence, their answers or the site itself.
 */
export interface AdsBrief {
  url: string | null;
  service: string | null;
  /** Readings of the sentence that disagree on the service: the owner chooses. */
  serviceChoices: string[];
  /** A service the site never mentions: asked once; the owner repeating it confirms it. */
  serviceDoubt?: string | null;
  locations: string[];
  country: string | null;
  budget: { amount: string; currency: string | null; period: 'day' | 'week' | 'month' } | null;
  goal: AdsGoalKind | null;
  /** The fields of the latest question, in the order they were asked. */
  asked: AdsField[];
  rounds: number;
}
export interface AdsChatReply {
  text: string;
  status: 'completed' | 'partial' | 'blocked' | 'waiting_user';
  /** With waiting_user: the facts to save until the owner answers. */
  brief?: AdsBrief;
  /** With waiting_user: the same questions with the brain's suggested answers, for one card. */
  fields?: AdsQuestionField[];
  /** With completed: the full campaign in the line format of the paused-creation tool. */
  campaign?: string;
}
export interface AdsChatIo { signal: AbortSignal; step(label: string): Promise<void> }
export interface AdsModelChat { handle(request: string, io: AdsChatIo, saved?: { brief: AdsBrief; answer: string }): Promise<AdsChatReply | null> }

/** Questions are asked at most this many times; past it the brain says what is still missing. */
export const MAX_ASK_ROUNDS = 3;

const CANDIDATES = 8;
const EXAMPLE = '`make ads for example.co.uk in Leeds, £20 a day`';

/** The training sentences are English; Arabic or mixed requests stay on the ordinary path. */
export function looksEnglishRequest(request: string): boolean {
  if (/[؀-ۿ]/.test(request)) return false;
  return (request.match(/[A-Za-z]{2,}/g) ?? []).length >= 3;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…', pound: '£', euro: '€', copy: '©', reg: '®', trade: '™' };
const decode = (text: string) => text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, name: string) => {
  if (name[0] === '#') {
    const code = name[1]?.toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return code > 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : ' ';
  }
  return ENTITIES[name.toLowerCase()] ?? whole;
});
const BLOCK = /<\/?(?:p|div|h[1-6]|li|ul|ol|br|tr|td|th|table|tbody|thead|section|article|header|footer|nav|main|aside|form|blockquote|dt|dd|dl|figure|figcaption|address|hr|label|option|title|pre)\b[^>]*>/gi;
const INLINE = /<\/?(?:a|span|strong|b|em|i|u|small|sup|sub|mark|abbr|font|time)\b[^>]*>/gi;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const PHONE = /(?<!\d)(\+?\d[\d ()./-]{7,}\d)(?!\d)/g;

/**
 * A page as the model learnt pages: text lines in the shape of Common Crawl's WET extracts
 * (one line per block element, the title first), with emails and phone numbers removed as the
 * training filter removed them.
 */
export function pageLines(html: string): { title: string; text: string; language: string | null } {
  const language = /<html\b[^>]*\blang\s*=\s*["']?([a-zA-Z-]{2,20})/i.exec(html)?.[1] ?? null;
  const title = decode(/<title[^>]*>([\s\S]{0,400}?)<\/title>/i.exec(html)?.[1] ?? '').replace(/\s+/g, ' ').trim();
  const body = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // Buttons are calls to action ("Call", "WhatsApp", "Book online"), never ad copy.
    .replace(/<(script|style|noscript|template|svg|head|iframe|select|canvas|button)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(BLOCK, '\n').replace(INLINE, ' ').replace(/<[^>]+>/g, ' ');
  const lines = decode(body).replace(/ /g, ' ').replace(EMAIL, ' ')
    .replace(PHONE, (match: string) => (match.match(/\d/g)?.length ?? 0) >= 9 ? ' ' : match)
    .split('\n').map(line => tidyLine(line.replace(/[ \t\r\f\v]+/g, ' ').replace(/ (?=[,.;:!?])/g, '').trim())).filter(line => line && !ctaOnly(line));
  return { title, text: lines.join('\n'), language };
}

const SMALL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'of', 'on', 'or', 'the', 'to', 'with']);
const CTA_WORDS = new Set(['call', 'calls', 'book', 'booking', 'online', 'now', 'today', 'whatsapp', 'tap', 'click', 'here', 'start', 'live', 'open', 'email', 'text', 'us', 'chat', 'message', 'to', 'or', 'a', 'get', 'directions', 'menu', 'order', 'buy', 'shop', 'more', 'details', 'view', 'go', 'visit', 'website', 'site', 'learn', 'read', 'see', 'find', 'out']);
/** A line made only of call-to-action words ("Tap to call now", "Book online WhatsApp"). */
const ctaOnly = (line: string) => {
  const words = line.toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);
  return words.length > 0 && words.every(word => CTA_WORDS.has(word));
};

/**
 * Brain-side clean-up of one page line, so the site's real wording can reach the model:
 * a scrolling banner repeated many times keeps one copy, leading icons go ("✓ Fully insured"),
 * and a line in capitals reads in title case ("MOBILE TYRE FITTING IN GLASGOW" ->
 * "Mobile Tyre Fitting in Glasgow"). Words are unchanged apart from their case.
 */
export function tidyLine(line: string): string {
  // Icons and arrows at either end ("✓ Fully insured", "Visit Website →") are decoration.
  let text = line.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[\s←-⇿➔-➿▶►›‹]+$/u, '').trim();
  if (text.length >= 20 && text.length <= 4000) {
    for (let size = 10; size <= Math.min(300, text.length / 2); size++) {
      const unit = text.slice(0, size).trim();
      if (text.slice(size).trimStart().startsWith(unit)) { text = unit.replace(/[^\p{L}\p{N}.!)]+$/u, '').trim(); break; }
    }
  }
  const letters = text.replace(/[^\p{L}]/gu, '');
  if (letters.length >= 4 && letters === letters.toUpperCase() && letters !== letters.toLowerCase() && text.split(/\s+/).length >= 2) {
    text = text.toLowerCase().replace(/\p{L}[\p{L}'’-]*/gu, (word, offset: number) => offset > 0 && SMALL_WORDS.has(word) ? word : word[0]!.toUpperCase() + word.slice(1));
  }
  return text;
}

/** A service names what is sold: never the link, a domain, or a request word followed by one. */
export const serviceClean = (goal: Goal) => goal.service === null
  || (!(goal.url && goal.service.includes(goal.url)) && !/\.[a-z]{2,}\b/i.test(goal.service) && !/^(?:campaign|ads?|google)\b/i.test(goal.service));

const PERIOD: Record<string, string> ={ day: 'يومياً', week: 'أسبوعياً', month: 'شهرياً' };
const GOAL_AR: Record<string, string> = { calls: 'مكالمات', bookings: 'حجوزات', leads: 'طلبات تواصل' };
const siteUrl = (url: string) => /^https?:\/\//i.test(url) ? url : `https://${url}`;

/** The campaign draft the brain builds from the checked goal and the checked site ads. */
export function renderAdsDraft(goal: Goal, ads: SiteAds, site: { url: string; host: string }, country?: string | null): string {
  const keywords = [...new Set(ads.keywords.map(keyword => keyword.toLowerCase()))];
  const budget = goal.budget ? `${goal.budget.currency ?? ''}${goal.budget.amount} ${PERIOD[goal.budget.period]}` : 'لم تُذكر';
  const daily = goal.budget && goal.budget.period !== 'day' ? ` (${goal.budget.currency ?? ''}${dailyBudget(goal.budget)} يومياً في Google Ads)` : '';
  const rows = [
    `**حملة بحث: ${ads.business ?? site.host}**`,
    '',
    `- الموقع: ${site.url}`,
    `- الخدمة: ${goal.service ?? 'لم تُذكر'}`,
    `- المناطق: ${goal.locations.length ? goal.locations.join('، ') : 'لم تُذكر'}${country ? ` (${COUNTRY_AR[country] ?? country})` : ''}`,
    `- الميزانية: ${budget}${daily}`,
    ...(goal.goal ? [`- الهدف: ${GOAL_AR[goal.goal]}`] : []),
    '',
    `**العناوين (${ads.headlines.length})**`,
    ...ads.headlines.map(text => `- ${text} (${[...text].length})`),
    '',
    `**الأوصاف (${ads.descriptions.length})**`,
    ...ads.descriptions.map(text => `- ${text} (${[...text].length})`),
    '',
    `**الكلمات المفتاحية (${keywords.length})**`,
    ...keywords.map(text => `- ${text}`),
    '',
    'اختار نموذج موحسن العناوين والأوصاف من صفحة موقعك نفسها، واجتازت فحوص النصوص المحلية، ثم رتّبها الدماغ حسب صلتها بنشاطك. الكلمات المفتاحية من صفحتك ومن إجاباتك.',
  ];
  return rows.join('\n');
}

// ---------------------------------------------------------------------------------------------
// The brain's questions: everything missing is asked once, together, after the sentence and the
// site have been read. Answers are read by code, never by the model, so a value the owner did not
// write is never filled in.
// ---------------------------------------------------------------------------------------------

const COUNTRY_TLD: Record<string, string> = { uk: 'GB', ie: 'IE', au: 'AU', nz: 'NZ', ca: 'CA', de: 'DE', fr: 'FR', es: 'ES', it: 'IT', nl: 'NL', be: 'BE', at: 'AT', ch: 'CH', se: 'SE', no: 'NO', dk: 'DK', fi: 'FI', pl: 'PL', pt: 'PT', ae: 'AE', sa: 'SA', qa: 'QA', kw: 'KW', bh: 'BH', om: 'OM', eg: 'EG', jo: 'JO', lb: 'LB', ma: 'MA', tr: 'TR', in: 'IN', pk: 'PK', sg: 'SG', my: 'MY', za: 'ZA', ng: 'NG', ke: 'KE', us: 'US' };
const COUNTRY_NAMES: [RegExp, string, string][] = [
  [/\b(?:uk|u\.k\.|united kingdom|great britain|britain|england|scotland|wales|northern ireland)\b|بريطانيا|المملكة المتحدة|انجلترا|إنجلترا|إنكلترا|اسكتلندا|إسكتلندا|ويلز/i, 'GB', 'United Kingdom'],
  [/\b(?:usa|u\.s\.a?\.?|united states|america)\b|امريكا|أمريكا|الولايات المتحدة/i, 'US', 'United States'],
  [/\b(?:ireland|eire)\b|ايرلندا|إيرلندا/i, 'IE', 'Ireland'],
  [/\bcanada\b|كندا/i, 'CA', 'Canada'],
  [/\baustralia\b|استراليا|أستراليا/i, 'AU', 'Australia'],
  [/\bnew zealand\b|نيوزيلندا/i, 'NZ', 'New Zealand'],
  [/\bgermany\b|المانيا|ألمانيا/i, 'DE', 'Germany'],
  [/\bfrance\b|فرنسا/i, 'FR', 'France'],
  [/\b(?:uae|united arab emirates|emirates)\b|الامارات|الإمارات/i, 'AE', 'United Arab Emirates'],
  [/\bsaudi(?: arabia)?\b|السعودية/i, 'SA', 'Saudi Arabia'],
  [/\bqatar\b|قطر/i, 'QA', 'Qatar'],
  [/\bkuwait\b|الكويت/i, 'KW', 'Kuwait'],
  [/\begypt\b|مصر/i, 'EG', 'Egypt'],
  [/\bjordan\b|الاردن|الأردن/i, 'JO', 'Jordan'],
  [/\bturkey\b|تركيا/i, 'TR', 'Turkey'],
  [/\bindia\b|الهند/i, 'IN', 'India'],
];
const COUNTRY_CODES = new Set([...Object.values(COUNTRY_TLD), ...COUNTRY_NAMES.map(entry => entry[1])]);

/** The country the site itself names: its domain ending, then its page language region. */
export function siteCountry(url: string | null, pageLanguage?: string | null): string | null {
  const host = url ? url.replace(/^https?:\/\//i, '').split(/[/?#]/)[0]!.toLowerCase() : '';
  const tld = host.split('.').pop() ?? '';
  if (COUNTRY_TLD[tld]) return COUNTRY_TLD[tld]!;
  // en-US is many site templates' default, so it says nothing about where the business is.
  const region = /^[a-z]{2}-([a-z]{2})$/i.exec(pageLanguage ?? '')?.[1]?.toUpperCase();
  return region && region !== 'US' && COUNTRY_CODES.has(region) ? region : null;
}

/** A country named in the text, as [code, English name]. */
export function countryIn(text: string): [string, string] | null {
  const code = /^\s*([A-Z]{2})\s*\.?\s*$/.exec(text)?.[1];
  if (code && COUNTRY_CODES.has(code)) return [code, COUNTRY_NAMES.find(entry => entry[1] === code)?.[2] ?? code];
  const hit = COUNTRY_NAMES.find(entry => entry[0].test(text));
  return hit ? [hit[1], hit[2]] : null;
}

const ARABIC_DIGITS = /[٠-٩۰-۹]/g;
const westernDigits = (text: string) => text.replace(ARABIC_DIGITS, digit => String((digit.charCodeAt(0) & 0xF) % 10)).replace(/٫/g, '.').replace(/٬/g, ',');
const URL_RE = /\b(?:https?:\/\/)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}(?::\d{2,5})?(?:\/[^\s,،]*)?/i;
const CURRENCIES: [RegExp, string][] = [
  [/£|\bgbp\b|\bpounds?\b|استرليني|إسترليني|جنيه\s+(?:استرليني|إسترليني)/i, '£'],
  [/\$|\busd\b|\bdollars?\b|دولار/i, '$'],
  [/€|\beur\b|\beuros?\b|يورو/i, '€'],
  [/\bsar\b|ريال/i, 'SAR'], [/\baed\b|درهم/i, 'AED'], [/\begp\b|جنيه\s+مصري/i, 'EGP'], [/جنيه/i, '£'],
];
const PERIODS: [RegExp, 'day' | 'week' | 'month'][] = [
  [/\b(?:a|per|each|every)\s*week\b|\/\s*week\b|\bweekly\b|اسبوع|أسبوع/i, 'week'],
  [/\b(?:a|per|each|every)\s*month\b|\/\s*month\b|\bmonthly\b|شهر/i, 'month'],
  [/\b(?:a|per|each|every)\s*day\b|\/\s*day\b|\bdaily\b|يوم/i, 'day'],
];
const AMOUNT = String.raw`(?:\d{1,3}(?:,\d{3})+|\d{1,6})(?:[.,]\d{1,2})?`;
const BUDGET_CORRECTION = new RegExp(`(${AMOUNT})\\s+(?:not|مش|مو|ليس|وليس)\\s+${AMOUNT}(?![\\p{L}\\p{N}.,])`, 'iu');

/** A budget in the text: one amount with an optional currency and period (daily when unsaid). */
export function budgetIn(raw: string): AdsBrief['budget'] {
  const text = westernDigits(raw).replace(BUDGET_CORRECTION, '$1');
  const numbers = [...text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}.,])(${AMOUNT})(?![\\p{L}\\p{N}.,])`, 'gu'))]
    .map(match => /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(match[1]!) ? match[1]!.replace(/,/g, '') : match[1]!.replace(',', '.'));
  if (numbers.length !== 1 || !Number(numbers[0])) return null;
  return {
    amount: numbers[0]!.replace(/\.0+$/, ''),
    currency: CURRENCIES.find(([pattern]) => pattern.test(text))?.[1] ?? null,
    period: PERIODS.find(([pattern]) => pattern.test(text))?.[1] ?? 'day',
  };
}

/** The result the owner wants, when exactly one kind is named. */
export function goalIn(text: string): AdsGoalKind | null {
  const found = new Set<AdsGoalKind>();
  if (/\bcalls?\b|\bphone\b|مكالم|اتصال|اتصالات|هاتف/i.test(text)) found.add('calls');
  if (/\bbook(?:ing|ings)?\b|\bappointments?\b|حجز|حجوزات|موعد|مواعيد/i.test(text)) found.add('bookings');
  if (/\bleads?\b|\benquir|\binquir|\bforms?\b|\bcontact\b|طلبات|تواصل|استفسار|عملاء محتمل/i.test(text)) found.add('leads');
  return found.size === 1 ? [...found][0]! : null;
}

/** Places listed by the owner: commas, «و» or «and» separate them. */
export function placesIn(text: string): string[] {
  return text.split(/\s*[,،;؛/|]\s*|\s+(?:and|&)\s+|\s+و\s*(?=[؀-ۿ])/i)
    .map(place => place.replace(/^[\s\-–•*.:]+|[\s\-–•*.:!؟?]+$/g, '').replace(/^(?:in|في|ب)\s+/i, '').trim())
    .filter(place => place.length >= 2 && place.length <= 80 && !/\d/.test(place) && !URL_RE.test(place))
    .slice(0, 10);
}

const SERVICE_TRIM = /^[\s\-–•*.:]+|[\s\-–•*.:!؟?]+$/g;
const asked = (field: AdsField, brief: AdsBrief) => brief.asked.includes(field);
const ANSWER_LABELS: [AdsField, RegExp][] = [
  ['url', /^(?:url|website|site|رابط الموقع|الرابط)(?:\s*:\s*|\s+)(.*)$/i],
  ['service', /^(?:the service is|service(?: is)?|الخدمة|خدمتي)(?:\s*:\s*|\s+)(.*)$/i],
  ['locations', /^(?:locations?|areas?|cities|in|across|around|المناطق|المدن|المنطقة|في)(?:\s*:\s*|\s+)(.*)$/i],
  ['country', /^(?:country|الدولة|البلد)(?:\s*:\s*|\s+)(.*)$/i],
  ['budget', /^(?:budget|my budget is|الميزانية|ميزانيتي)(?:\s*:\s*|\s+)(.*)$/i],
  ['goal', /^(?:goal|الهدف|هدفي)(?:\s*:\s*|\s+)(.*)$/i],
];
const labelledAnswer = (part: string): { field: AdsField; value: string } | null => {
  for (const [field, pattern] of ANSWER_LABELS) {
    const match = pattern.exec(part);
    if (match) return { field, value: match[1]! };
  }
  return null;
};
// Bare goal words are answers; a service such as "Emergency Call Out" is not a goal answer.
const GOAL_ANSWER = /^(?:(?:i want|we want|أريد|اريد|أبي|ابي|أبغى|ابغى|عايز|عاوز|بدي)\s+)?(?:more\s+)?(?:calls?|phone(?: calls)?|bookings?|appointments?|leads?|enquiries|inquiries|مكالمات|اتصالات|حجوزات|مواعيد|طلبات تواصل|استفسارات|عملاء محتملين)(?:\s+(?:please|only|أكثر|أكتر|اكثر|اكتر|بس|لو سمحت|من فضلك))?[.!؟?]*$/i;
const nonAnswer = (text: string) => /^(?:(?:please\s+)?(?:cancel|stop|later|not now|not sure|thanks)|إلغاء|الغاء|توقف|بعدين|لاحقاً|لاحقا)[.!؟?]*$/i.test(text)
  || /^(?:what|when|where|why|how|write|tell me|show me)\b|^(?:اكتب|اشرح|متى|كيف)\s/i.test(text);
const budgetShaped = (part: string) => Boolean(budgetIn(part)) && (CURRENCIES.some(([pattern]) => pattern.test(part))
  || PERIODS.some(([pattern]) => pattern.test(part)) || new RegExp(`^${AMOUNT}$`).test(part) || BUDGET_CORRECTION.test(part));

/**
 * Reads the owner's answer to the brain's questions. Numbered answers map to the questions in
 * order; otherwise the typed facts (link, budget, result, country) are found by their shape and
 * the rest of the text fills the free answers. Anything unreadable stays missing and is asked again.
 */
export function readAnswer(answer: string, brief: AdsBrief): AdsBrief {
  const next: AdsBrief = { ...brief, locations: [...brief.locations], serviceChoices: [...brief.serviceChoices] };
  const text = westernDigits(answer).trim();
  if (nonAnswer(text)) return next;
  const take = (field: AdsField, part: string): boolean => {
    const value = part.replace(SERVICE_TRIM, '').trim();
    if (!value || nonAnswer(value)) return false;
    switch (field) {
      case 'url': { const url = URL_RE.exec(value)?.[0]; if (url) next.url = url.replace(/[.,;)]+$/, ''); return Boolean(url); }
      case 'budget': {
        const budget = budgetIn(value);
        if (budget) next.budget = {
          ...budget, currency: budget.currency ?? next.budget?.currency ?? null,
          period: PERIODS.some(([pattern]) => pattern.test(value)) ? budget.period : next.budget?.period ?? budget.period,
        };
        return Boolean(budget);
      }
      case 'goal': { const goal = goalIn(value); if (goal) next.goal = goal; return Boolean(goal); }
      case 'country': { const country = countryIn(value); if (country) next.country = country[0]; return Boolean(country); }
      case 'locations': {
        let places = placesIn(value);
        // "Glasgow, UK": a country among the places answers the country question too.
        const countries = places.map(place => countryIn(place));
        if (countries.some(Boolean) && countries.some(entry => !entry)) {
          next.country ??= countries.find(Boolean)![0];
          places = places.filter((_, index) => !countries[index]);
        } else if (places.length === 1 && countries[0]) {
          next.country ??= countries[0][0];
          places = [countries[0][1]];
        }
        if (places.length) next.locations = places;
        return places.length > 0;
      }
      case 'service': {
        const choice = next.serviceChoices.find(option => value.toLowerCase().includes(option.toLowerCase()));
        // \b does not see Arabic letters, so the end of the word is checked with \p{L}.
        const ordinal = /^(?:the\s+)?(?:first|1st|الأول|الاول|الأولى|الاولى)(?!\p{L})/iu.test(value) ? 0 : /^(?:the\s+)?(?:second|2nd|الثاني|الثانية)(?!\p{L})/iu.test(value) ? 1 : /^(?:the\s+)?(?:third|3rd|الثالث|الثالثة)(?!\p{L})/iu.test(value) ? 2 : -1;
        const service = choice ?? next.serviceChoices[ordinal] ?? value.replace(/^(?:the service is|service:|الخدمة\s*:?)\s*/i, '').replace(SERVICE_TRIM, '');
        if (service.length < 2 || service.length > 60 || URL_RE.test(service)) return false;
        next.service = service;
        next.serviceChoices = [];
        return true;
      }
    }
  };

  // Slice at the markers, including empty parts and a single numbered partial answer. Missing
  // or rejected parts never get reassigned to the next free field.
  const numbered = [...text.matchAll(/(?:^|\s)([1-9]\d*)[ \t]*[).:\-–](?=\s|$)/g)];
  if (numbered.length && numbered[0]!.index === 0 && text.slice(numbered[0]![0].length).trim()) {
    const filled = new Set<AdsField>();
    let inserted = 0;
    const extraNumber = numbered.some(marker => Number(marker[1]) > brief.asked.length);
    const strong = (part: string): AdsField | null => {
      const words = part.trim().split(/\s+/).length;
      if (URL_RE.test(part) && words <= 2) return 'url';
      if (budgetShaped(part)) return 'budget';
      if (countryIn(part) && words <= 3) return 'country';
      return null;
    };
    for (const [index, marker] of numbered.entries()) {
      const part = text.slice(marker.index! + marker[0].length, numbered[index + 1]?.index ?? text.length).trim();
      if (!part) continue;
      const label = labelledAnswer(part);
      const indexed = brief.asked[Number(marker[1]) - 1 - inserted];
      const shape = strong(part);
      // A clearly typed extra field can account for an inserted list item. Merely skipping an
      // ordinal or rejecting its text never shifts indexes. Keep country-wide targeting too.
      const extra = !label && extraNumber && shape && !asked(shape, brief) && indexed && shape !== indexed;
      if (extra) inserted++;
      // A goal word can also be a service name; the numbered question wins for that weak shape.
      const target = label?.field ?? (shape && (extra || !(indexed === 'locations' && shape === 'country')) ? shape : indexed ?? (GOAL_ANSWER.test(part) ? 'goal' : null));
      if (target && !filled.has(target) && (label || asked(target, brief) || next[target] == null)
        && take(target, label?.value ?? part)) filled.add(target);
    }
    return next;
  }

  // Labels take precedence over shapes: "service: 24 hour Call Out" is neither a budget nor a
  // goal. Split clauses without splitting decimal/thousands commas or losing a second answer.
  const filled = new Set<AdsField>();
  const free: string[] = [];
  let wholeCountry: string | null = null;
  const put = (field: AdsField, value: string) => {
    const previous = field === 'locations' && filled.has(field) ? [...next.locations] : [];
    if (take(field, value)) {
      if (previous.length) next.locations = [...new Set([...previous, ...next.locations])];
      filled.add(field);
    }
  };
  const correction = /^(?:no|لا)\s*[,،]?\s*(.+)$/i.exec(text);
  const content = correction && BUDGET_CORRECTION.test(correction[1]!) ? correction[1]! : text;
  for (const line of content.split(/\n+/)) {
    let locationList = false;
    const parts = line.split(/([،;؛]|(?<!\d),|,(?!\d)|\s+(?:for|and)\s+(?=calls?\b|bookings?\b|leads?\b))/i);
    for (let index = 0; index < parts.length; index += 2) {
      if (index && !/^[,،]$/.test(parts[index - 1]!)) locationList = false;
      const raw = parts[index]!;
      let part = raw.trim();
      if (!part || nonAnswer(part)) continue;
      const label = labelledAnswer(part);
      if (label) {
        put(label.field, label.value);
        locationList = label.field === 'locations';
        continue;
      }
      part = part.replace(SERVICE_TRIM, '').trim();
      if (!part) continue;
      if (!asked('service', brief) && part.toLowerCase() === next.service?.toLowerCase()) continue;
      const url = URL_RE.exec(part)?.[0];
      if (url) {
        if (asked('url', brief)) put('url', url);
        part = part.replace(URL_RE, '').trim();
        if (!part) continue;
      }
      if (budgetShaped(part)) {
        if (asked('budget', brief) || BUDGET_CORRECTION.test(part)) put('budget', part);
        locationList = false;
        continue;
      }
      if (GOAL_ANSWER.test(part)) {
        if (asked('goal', brief)) put('goal', part);
        locationList = false;
        continue;
      }
      // "home cleaning in Bath" also works when the service was already known.
      const split = /^(.+?)\s+(?:in|across|around|في)\s+(.+)$/i.exec(part);
      if (split && (asked('service', brief) || split[1]!.toLowerCase() === next.service?.toLowerCase())) {
        if (asked('service', brief)) put('service', split[1]!);
        if (asked('locations', brief)) put('locations', split[2]!);
        locationList = true;
        continue;
      }
      const country = countryIn(part);
      const countryOnly = country && (part.toUpperCase() === country[0]
        || COUNTRY_NAMES.some(([pattern]) => pattern.exec(part)?.[0].toLowerCase() === part.toLowerCase()));
      if (countryOnly) {
        if (asked('country', brief) || !next.country) put('country', part);
        if (asked('locations', brief)) wholeCountry = part;
        continue;
      }
      if (locationList) put('locations', part);
      else free.push(part);
    }
  }
  const open = brief.asked.filter(field => !filled.has(field) && (field === 'service' || field === 'locations'));
  if (open.length === 1 && free.length) put(open[0]!, free.join(open[0] === 'locations' ? ', ' : ' '));
  else if (open.length === 2 && free.length) {
    // Unlabelled free answers keep the question order. With only one, fill only its own field.
    const serviceFirst = open[0] === 'service';
    put(open[0]!, serviceFirst ? free[0]! : free.slice(0, free.length > 1 ? -1 : 1).join(', '));
    if (free.length > 1) put(open[1]!, serviceFirst ? free.slice(1).join(', ') : free.at(-1)!);
  }
  // A bare country is a valid target when no city was supplied; a country after a city is only
  // its country qualifier, so "Glasgow, UK" must still target Glasgow alone.
  if (wholeCountry && !filled.has('locations')) put('locations', wholeCountry);
  return next;
}

const REQUEST_WORDS = new Set(['make', 'create', 'build', 'run', 'set', 'up', 'need', 'want', 'please', 'ads', 'ad', 'advert', 'adverts', 'advertising', 'campaign', 'campaigns', 'google', 'search', 'for', 'on', 'in', 'at', 'to', 'my', 'our', 'the', 'a', 'an', 'and', 'with', 'of', 'from', 'day', 'daily', 'week', 'month', 'per', 'a', 'budget', 'calls', 'bookings', 'leads', 'business', 'website', 'site', 'i', 'we', 'me', 'us', 'get', 'more']);
const EDGE_WORDS = new Set(['for', 'on', 'in', 'at', 'to', 'my', 'our', 'the', 'a', 'an', 'and', 'with', 'of', 'from']);

/**
 * A service the sentence names and the site's own title or headings repeat ("mobile tyre fitting"
 * in both): the brain takes it when the model's reading missed it. Two words at least, never a
 * request word, place, link or number.
 */
export function servicePhrase(request: string, siteHead: string, places: string[] = []): string | null {
  const head = ` ${siteHead.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
  const placeWords = new Set(places.flatMap(place => place.toLowerCase().split(/\s+/)));
  const words = request.replace(URL_RE, ' ').split(/[^\p{L}'’-]+/u).filter(Boolean);
  for (let size = Math.min(4, words.length); size >= 2; size--) {
    for (let start = 0; start + size <= words.length; start++) {
      const span = words.slice(start, start + size), lower = span.map(word => word.toLowerCase());
      if (EDGE_WORDS.has(lower[0]!) || EDGE_WORDS.has(lower.at(-1)!)) continue;
      if (lower.some(word => (REQUEST_WORDS.has(word) && !EDGE_WORDS.has(word)) || placeWords.has(word))) continue;
      if (head.includes(` ${lower.join(' ')} `)) return span.join(' ');
    }
  }
  return null;
}

/** Whether the site mentions the service at all: one of its words, by its first five letters. */
export function serviceOnSite(service: string, siteText: string): boolean {
  const text = siteText.toLowerCase();
  const words = service.toLowerCase().split(/[^\p{L}]+/u).filter(word => word.length >= 4 && !REQUEST_WORDS.has(word));
  return !words.length || words.some(word => text.includes(word.slice(0, 5)));
}

/** The facts still missing for a complete campaign, in the order the brain asks them. */
export function missingFields(brief: AdsBrief): AdsField[] {
  return [
    ...(brief.url ? [] : ['url' as const]),
    ...(brief.service && !brief.serviceChoices.length ? [] : ['service' as const]),
    ...(brief.locations.length ? [] : ['locations' as const]),
    ...(brief.country ? [] : ['country' as const]),
    ...(brief.budget ? [] : ['budget' as const]),
    ...(brief.goal ? [] : ['goal' as const]),
  ];
}

const FIELD_AR: Record<AdsField, string> = { url: 'رابط الموقع', service: 'الخدمة', locations: 'المناطق', country: 'الدولة', budget: 'الميزانية', goal: 'الهدف' };
const COUNTRY_AR: Record<string, string> ={ GB: 'المملكة المتحدة', US: 'الولايات المتحدة', IE: 'إيرلندا', CA: 'كندا', AU: 'أستراليا', NZ: 'نيوزيلندا', DE: 'ألمانيا', FR: 'فرنسا', AE: 'الإمارات', SA: 'السعودية', QA: 'قطر', KW: 'الكويت', EG: 'مصر', JO: 'الأردن', TR: 'تركيا', IN: 'الهند' };
const budgetText = (budget: NonNullable<AdsBrief['budget']>) => `${budget.currency ?? ''}${budget.amount} ${PERIOD[budget.period]}`;

/** One message with every question the brain still has, after what it already understood. */
export function renderQuestions(brief: AdsBrief, fields: AdsField[], site?: { title: string | null }): string {
  const known = [
    ...(brief.url ? [`الموقع: ${brief.url}${site?.title ? ` («${site.title.slice(0, 80)}»)` : ''}`] : []),
    ...(brief.service && !brief.serviceChoices.length ? [`الخدمة: ${brief.service}`] : []),
    ...(brief.locations.length ? [`المناطق: ${brief.locations.join('، ')}`] : []),
    ...(brief.country ? [`الدولة: ${COUNTRY_AR[brief.country] ?? brief.country}`] : []),
    ...(brief.budget ? [`الميزانية: ${budgetText(brief.budget)}`] : []),
    ...(brief.goal ? [`الهدف: ${GOAL_AR[brief.goal]}`] : []),
  ];
  const question: Record<AdsField, string> = {
    url: 'ما رابط موقعك أو الصفحة التي يصل إليها من ينقر الإعلان؟',
    service: brief.serviceChoices.length >= 2
      ? `ما الخدمة التي تعلن عنها: ${brief.serviceChoices.map(option => `«${option}»`).join(' أم ')}؟ أو اكتبها كما تظهر في موقعك.`
      : 'ما الخدمة التي تعلن عنها؟ اكتبها بالإنجليزية كما تظهر في موقعك.',
    locations: 'في أي مدن أو مناطق يظهر الإعلان؟ اكتبها بالإنجليزية، وافصل بينها بفاصلة.',
    country: 'في أي دولة تقع هذه المناطق؟',
    budget: 'كم الميزانية اليومية، وبأي عملة؟ مثل: £20 يومياً.',
    goal: 'ماذا تريد من الإعلان: مكالمات، أم حجوزات، أم طلبات تواصل؟',
  };
  return [
    ...(known.length ? ['فهمت حتى الآن:', ...known.map(line => `- ${line}`), ''] : []),
    fields.length === 1 ? 'قبل أن أبدأ إنشاء الحملة ينقصني شيء واحد:' : `قبل أن أبدأ إنشاء الحملة ينقصني ${fields.length === 2 ? 'شيئان' : `${fields.length} أشياء`}. أجب عنها كلها في رسالة واحدة، ويُفضّل أن ترقّم الإجابات:`,
    ...fields.map((field, index) => fields.length === 1 ? question[field] : `${index + 1}. ${question[field]}`),
    '',
    'بعد ردك أكمل وحدي حتى تُنشأ الحملة متوقفة في حسابك، ولا أتوقف إلا عند تسجيل الدخول إلى Google أو عائق أمني.',
  ].join('\n');
}

/** Google budgets are daily; a weekly or monthly amount is spread over Google's average month. */
export function dailyBudget(budget: NonNullable<AdsBrief['budget']>): string {
  const amount = Number(budget.amount) / (budget.period === 'week' ? 7 : budget.period === 'month' ? 30.4 : 1);
  return (Math.round(amount * 100) / 100).toFixed(2).replace(/\.00$/, '');
}

const oneLine = (text: string) => text.replace(/[\r\n]+/g, ' ').trim();

/** The complete campaign in the paused-creation tool's line format (BUSINESS:, H:, K: ...). */
export function campaignLines(brief: AdsBrief, ads: SiteAds, site: { url: string; host: string }): string {
  return [
    `BUSINESS: ${oneLine(ads.business ?? site.host).slice(0, 80)}`,
    `SERVICE: ${oneLine(brief.service!).slice(0, 60)}`,
    `GOAL: ${brief.goal}`,
    `URL: ${site.url}`,
    ...brief.locations.map(place => `LOCATION: ${oneLine(place)}`),
    `COUNTRY: ${brief.country}`,
    'LANGUAGE: en',
    `BUDGET: ${dailyBudget(brief.budget!)}`,
    ...(brief.budget?.currency?.trim() ? [`CURRENCY: ${oneLine(brief.budget.currency)}`] : []),
    ...ads.headlines.slice(0, 15).map(text => `H: ${oneLine(text)}`),
    ...ads.descriptions.slice(0, 4).map(text => `D: ${oneLine(text)}`),
    ...[...new Set(ads.keywords.map(keyword => keyword.toLowerCase()))].slice(0, 50).map(text => `K: ${oneLine(text)}`),
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------
// Suggested answers. Every suggestion comes from the site the owner named in this request (its
// title, headings, links and prices) or from their sentence; none comes from a fixed list of
// businesses. Only the budget has fixed example levels, in the currency of the site's country,
// because no page states a budget and Google's cost estimates need the connected account.
// ---------------------------------------------------------------------------------------------

export interface AdsSuggestion { label: string; reason?: string }
export interface AdsQuestionField { id: AdsField; prompt: string; suggestions: AdsSuggestion[]; multiple?: boolean; selected?: number[]; placeholder?: string }

const FIELD_PROMPT: Record<AdsField, string> = {
  url: 'رابط الموقع أو الصفحة التي يصل إليها من ينقر الإعلان',
  service: 'الخدمة التي تعلن عنها',
  locations: 'المدن أو المناطق التي يظهر فيها الإعلان',
  country: 'الدولة',
  budget: 'الميزانية اليومية',
  goal: 'ماذا تريد من الإعلان؟',
};
const GENERIC_WORDS = new Set(['home', 'about', 'contact', 'services', 'service', 'welcome', 'our', 'your', 'the', 'we', 'get', 'free', 'quote', 'quotes', 'call', 'book', 'now', 'today', 'menu', 'reviews', 'gallery', 'blog', 'faq', 'faqs', 'terms', 'privacy', 'policy', 'login', 'cart', 'shop', 'news', 'emergency', 'available', 'open', 'all', 'best', 'local', 'trusted', 'professional', 'expert', 'experts', 'quality', 'fast', 'cheap', 'affordable', 'stock', 'mobile', 'more', 'less', 'from', 'only', 'new', 'maps', 'map', 'directions', 'find']);
const HEADING = /<h([1-3])\b[^>]*>([\s\S]{1,300}?)<\/h\1>/gi;
const stripTags = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#\d+;|&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();
const titleCase = (text: string) => text.replace(/\b\p{L}/gu, letter => letter.toUpperCase());
const countIn = (text: string, phrase: string) => text.split(phrase.toLowerCase()).length - 1;

/** The site's own short headings and title parts: what it says it does, and where. */
function siteHeads(html: string, title: string): string[] {
  const parts = title.split(/\s*(?:[|–—•·:]|\s-\s)\s*/);
  const headings = [...html.matchAll(HEADING)].map(match => stripTags(match[2]!));
  return [...parts, ...headings].map(part => part.replace(/[^\p{L}\p{N}&,'’ -]+/gu, ' ').replace(/\s+/g, ' ').trim()).filter(part => part.length >= 3 && part.length <= 90);
}

/** Places the site names: after "in/across/serving ...", and lists in its title or headings. */
export function sitePlaces(html: string, title: string, text: string, exclude: string[] = []): string[] {
  const counts = new Map<string, number>();
  const skip = new Set(exclude.map(entry => entry.toLowerCase()));
  const add = (place: string, weight: number) => {
    const clean = place.trim();
    const words = clean.split(/\s+/);
    if (words.length > 3 || clean.length < 3 || /\d/.test(clean) || !/^\p{Lu}/u.test(clean)) return;
    if (words.some(word => GENERIC_WORDS.has(word.toLowerCase())) || skip.has(clean.toLowerCase())) return;
    counts.set(clean, (counts.get(clean) ?? 0) + weight);
  };
  const body = `${title}\n${text}`;
  // Spaces only, never a line break: a place does not run on into the next line of the page.
  for (const match of body.matchAll(/\b(?:in|across|around|serving|covering|throughout|near)[ \t]+((?:\p{Lu}[\p{Ll}'’-]+)(?:[ \t](?:\p{Lu}[\p{Ll}'’-]+)){0,2})((?:[ \t]*(?:,|&|and)[ \t]*\p{Lu}[\p{Ll}'’-]+(?:[ \t]\p{Lu}[\p{Ll}'’-]+)?)*)/gu)) {
    add(match[1]!, 2);
    for (const more of (match[2] ?? '').split(/\s*(?:,|&|\band\b)\s*/)) if (more) add(more, 2);
  }
  // Title or heading lists: "Mobile Tyre Fitting Glasgow, Edinburgh & Dundee". A list counts only
  // when one of its pieces is already a place the text names after "in/across ...": otherwise
  // "Skin Fades & Beard Trims" would give the place "Fades".
  const known = new Set([...counts.keys()].map(place => place.toLowerCase()));
  for (const head of siteHeads(html, title)) {
    const raw = head.split(/\s*(?:,|&|\band\b)\s*/);
    // "Skin Fades & Beard Trims in Muirhead" lists services, then one place after "in".
    if (raw.some(piece => /\b(?:in|across|around)\s/i.test(piece))) continue;
    const pieces = raw.map((piece, index) => index === 0 ? piece.split(/\s+/).slice(-1).join(' ') : piece);
    if (pieces.length < 2 || !pieces.some(piece => known.has(piece.toLowerCase()))) continue;
    for (const piece of pieces) add(piece, 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(entry => entry[0]).slice(0, 6);
}

/** Services the site names in its title and headings, the most repeated on the page first. */
export function siteServices(html: string, title: string, text: string, business: string | null, places: string[]): string[] {
  const page = `${title}\n${text}`.toLowerCase();
  const placeWords = new Set(places.flatMap(place => place.toLowerCase().split(/\s+/)));
  // The business name is not a service: compared without spaces, so the domain
  // "dukestreettyres.com" rules out the heading "Duke Street Tyres".
  const brand = (business ?? '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[./]/)[0]!.replace(/[^a-z0-9]/g, '');
  const seen = new Map<string, { label: string; score: number; inTitle: boolean }>();
  for (const head of siteHeads(html, title)) {
    for (const piece of head.split(/\s*(?:,|&)\s*/)) {
      let words = piece.split(/\s+/).filter(Boolean);
      // "Mobile Tyre Fitting Glasgow" -> "Mobile Tyre Fitting": places at the end are not the service.
      while (words.length && placeWords.has(words.at(-1)!.toLowerCase())) words = words.slice(0, -1);
      while (words.length && /^(?:in|across|for|at|the|our|your|and)$/i.test(words.at(-1)!)) words = words.slice(0, -1);
      const label = words.join(' ');
      const lower = label.toLowerCase();
      if (words.length < 2 || words.length > 5 || label.length > 40 || /\d/.test(label)) continue;
      const compact = lower.replace(/[^a-z0-9]/g, '');
      if (brand && compact.length >= 4 && (brand.includes(compact) || compact.includes(brand))) continue;
      if (words.every(word => GENERIC_WORDS.has(word.toLowerCase()) || placeWords.has(word.toLowerCase()))) continue;
      if (ctaOnly(label) || notAnOffer(label)) continue;
      // "WIDER COVERAGE" reads as "Wider Coverage"; mixed case is kept as the site wrote it.
      const shown = label === label.toUpperCase() ? titleCase(lower) : titleCase(label);
      const entry = seen.get(lower) ?? { label: shown, score: 0, inTitle: title.toLowerCase().includes(lower) };
      seen.set(lower, { ...entry, score: entry.score + 1 + countIn(page, lower) });
    }
  }
  // A heading said once (a partner's name, a section title) is not a service the site sells:
  // it must be in the site's title or repeated on the page.
  return [...seen.values()].filter(entry => entry.inTitle || entry.score >= 4).sort((a, b) => b.score - a.score).map(entry => entry.label).slice(0, 5);
}

const PHRASE_END = /^(?:in|across|around|near|we|our|you|your|for|at|to|with|from|by|and|or|the|is|are)$/;
const plain = (word: string) => word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;

/**
 * Search phrases the site itself uses, for keywords only: its services, short heading pieces that
 * end on a word of the service ("Flat Tyre" for tyre fitting), and the service with the urgency
 * words the page says ("emergency", "24/7"). Nothing here is a place or the business name.
 */
export function siteSearchPhrases(html: string, title: string, text: string, service: string | null, business: string | null, places: string[]): string[] {
  const placeWords = new Set(places.flatMap(place => place.toLowerCase().split(/\s+/)));
  const core = new Set((service ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(word => word.length > 2 && !GENERIC_WORDS.has(word)).map(plain));
  const out = siteServices(html, title, text, business, places).map(item => item.toLowerCase());
  // The business name, compared without spaces as siteServices does ("Duke Street Tyres").
  const brand = (business ?? '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[./]/)[0]!.replace(/[^a-z0-9]/g, '');
  const named = (phrase: string) => { const compact = phrase.replace(/[^a-z0-9]/g, ''); return brand.length >= 4 && compact.length >= 4 && (brand.includes(compact) || compact.includes(brand)); };
  for (const head of siteHeads(html, title)) {
    for (const piece of head.split(/\s*[,&?!.·|]\s*/)) {
      let words = piece.toLowerCase().split(/\s+/).filter(Boolean);
      const cut = words.findIndex(word => PHRASE_END.test(word));
      if (cut >= 0) words = words.slice(0, cut);
      while (words.length && placeWords.has(words.at(-1)!)) words = words.slice(0, -1);
      // "Flat Tyre" names the thing searched for; "Tyre Brands" does not end on it.
      if (words.length < 2 || words.length > 4 || words.some(word => /\d/.test(word) || placeWords.has(word)) || !core.has(plain(words.at(-1)!)) || named(words.join(' '))) continue;
      out.push(words.join(' '));
    }
  }
  if (service) {
    const page = `${title}\n${text}`.toLowerCase();
    const name = service.toLowerCase();
    if (/\bemergenc(?:y|ies)\b/.test(page) && !name.includes('emergency')) out.push(`emergency ${name}`);
    if (/\b24\s*\/\s*7\b|\b24[- ]hours?\b/.test(page) && !/\b24\b/.test(name)) out.push(`24 hour ${name}`);
  }
  return [...new Set(out)].slice(0, 8);
}

const EURO = new Set(['IE', 'DE', 'FR', 'ES', 'IT', 'NL', 'BE', 'AT', 'PT', 'FI']);
const CURRENCY_OF: Record<string, string> = { GB: '£', AE: 'AED ', SA: 'SAR ', EG: 'EGP ', QA: 'QAR ', KW: 'KWD ', JO: 'JOD ', TR: 'TRY ', IN: '₹' };
const currencyFor = (country: string | null) => country ? (EURO.has(country) ? '€' : CURRENCY_OF[country] ?? '$') : null;

/** What the page itself shows about the result it wants: phone links, booking, forms. */
export function goalSignals(html: string): { goal: AdsGoalKind; reason: string; score: number }[] {
  const lower = html.toLowerCase();
  const phones = (lower.match(/href\s*=\s*["']tel:/g) ?? []).length;
  const booking = (lower.match(/\bbook(?:ing)? (?:now|online|an? appointment|your)|\bappointment|calendly|setmore|fresha|booksy|\breserve\b|\breservation/g) ?? []).length;
  const forms = (lower.match(/<form\b/g) ?? []).length + (lower.match(/\b(?:get a quote|request a quote|enquiry|enquire|contact form)\b/g) ?? []).length;
  return ([
    { goal: 'calls', reason: phones ? 'في موقعك رقم هاتف يُنقر للاتصال' : '', score: phones * 2 },
    { goal: 'bookings', reason: booking ? 'في موقعك حجز أو مواعيد' : '', score: booking },
    { goal: 'leads', reason: forms ? 'في موقعك نموذج تواصل أو طلب عرض سعر' : '', score: forms },
  ] as const).map(entry => ({ ...entry })).sort((a, b) => b.score - a.score);
}

/** The card's questions with the brain's suggestions for the site in this request. */
export function suggestFields(brief: AdsBrief, fields: AdsField[], site: { html: string; title: string; text: string; business?: string | null } | null): AdsQuestionField[] {
  return fields.map((field): AdsQuestionField => {
    const base = { id: field, prompt: FIELD_PROMPT[field] };
    if (field === 'url') return { ...base, suggestions: [], placeholder: 'example.co.uk' };
    if (field === 'service') {
      if (brief.serviceChoices.length) return { ...base, suggestions: brief.serviceChoices.map(label => ({ label, reason: 'من جملتك' })), placeholder: 'اكتب الخدمة كما تظهر في موقعك' };
      const places = site ? sitePlaces(site.html, site.title, site.text, []) : [];
      const services = site ? siteServices(site.html, site.title, site.text, site.business ?? null, [...brief.locations, ...places]) : [];
      const suggestions: AdsSuggestion[] = services.map((label, index) => ({ label, reason: index === 0 ? 'الأكثر تكراراً في عناوين موقعك' : 'من عناوين موقعك' }));
      if (brief.serviceDoubt) suggestions.push({ label: brief.serviceDoubt, reason: 'كما كتبتها (لا يذكرها الموقع)' });
      // Pre-chosen only when the site's title itself names it and the page repeats it.
      const top = services[0];
      const sure = top && site && site.title.toLowerCase().includes(top.toLowerCase()) && countIn(`${site.title}\n${site.text}`.toLowerCase(), top.toLowerCase()) >= 2;
      return { ...base, suggestions: suggestions.slice(0, 6), ...(sure ? { selected: [0] } : {}), placeholder: 'خدمة أخرى بالإنجليزية' };
    }
    if (field === 'locations') {
      const places = site ? sitePlaces(site.html, site.title, site.text, []) : [];
      return { ...base, multiple: true, suggestions: places.map((label, index) => ({ label, reason: index === 0 ? 'يذكرها موقعك أكثر من غيرها' : 'يذكرها موقعك' })), ...(places.length ? { selected: [0] } : {}), placeholder: 'مدن أخرى بالإنجليزية، تفصل بينها فاصلة' };
    }
    if (field === 'country') {
      const html = site?.html ?? '';
      const pounds = (html.match(/£/g) ?? []).length, euros = (html.match(/€/g) ?? []).length;
      const list: [string, string][] = [['GB', 'المملكة المتحدة'], ['US', 'الولايات المتحدة'], ['IE', 'إيرلندا'], ['CA', 'كندا'], ['AU', 'أستراليا'], ['AE', 'الإمارات']];
      const picked = pounds > euros && pounds > 0 ? 0 : euros > pounds ? 2 : -1;
      return { ...base, suggestions: list.map(([, label], index) => ({ label, ...(index === picked ? { reason: picked === 0 ? 'الأسعار في موقعك بالجنيه الإسترليني' : 'الأسعار في موقعك باليورو' } : {}) })), ...(picked >= 0 ? { selected: [picked] } : {}), placeholder: 'دولة أخرى' };
    }
    if (field === 'budget') {
      const currency = currencyFor(brief.country) ?? (/£/.test(site?.html ?? '') ? '£' : '$');
      return { ...base, suggestions: [10, 20, 40].map(amount => ({ label: `${currency}${amount} يومياً`, reason: 'مثال، ليست توصية' })), placeholder: 'مبلغ آخر، مثل £25 يومياً' };
    }
    const signals = site ? goalSignals(site.html) : [];
    const order: AdsGoalKind[] = signals.length ? signals.map(entry => entry.goal) : ['calls', 'bookings', 'leads'];
    const top = signals[0];
    return { ...base, suggestions: order.map(goal => ({ label: GOAL_AR[goal]!, ...(signals.find(entry => entry.goal === goal)?.reason ? { reason: signals.find(entry => entry.goal === goal)!.reason } : {}) })), ...(top && top.score > 0 ? { selected: [0] } : {}) };
  });
}

const briefFromGoal = (goal: Goal, choices: string[]): AdsBrief => ({
  url: goal.url, service: goal.service, serviceChoices: choices, locations: [...goal.locations], country: null,
  budget: goal.budget ? { amount: goal.budget.amount, currency: goal.budget.currency ?? null, period: goal.budget.period } : null,
  goal: goal.goal ?? null, asked: [], rounds: 0,
});

export function createAdsModelChat(deps: { worker: Pick<AdsModelWorker, 'sample' | 'files'> & Partial<Pick<AdsModelWorker, 'languages'>>; fetchPage(url: string, signal?: AbortSignal): Promise<LandingFetch> }): AdsModelChat {
  let modules: Promise<[GoalModule, PointerModule, SiteModule]> | null = null;
  const load = () => (modules ??= Promise.all([
    import('../../../../scripts/ads-training/goal.js'),
    import('../../../../scripts/ads-training/pointer.js'),
    import('../../../../scripts/ads-training/site.js'),
  ]));

  async function handle(request: string, io: AdsChatIo, saved?: { brief: AdsBrief; answer: string }): Promise<AdsChatReply | null> {
    const arabic = /\p{Script=Arabic}/u.test(request);
    if ((!arabic && !looksEnglishRequest(request)) || await deps.worker.files()) return null;
    const languages = deps.worker.languages ? await deps.worker.languages() : ['en'];
    if (!languages.includes(arabic ? 'ar' : 'en')) return null;
    const [{ checkGoal }, pointer, site] = await load();

    let brief: AdsBrief;
    if (saved) {
      // The owner answered the brain's questions: code reads the answer, the model is not asked again.
      await io.step('قراءة إجاباتك');
      brief = readAnswer(saved.answer, saved.brief);
    } else {
      await io.step('فهم طلب الحملة');
      const readings = (await deps.worker.sample(pointer.renderGoalPointerPrompt(request), {}, CANDIDATES, { signal: io.signal })).candidates.filter(candidate => candidate.finished).map(candidate => {
        // The brain repairs what it can see in the sentence itself (the link, the number, the
        // edges of the service) before the checker judges the model's reading.
        const goal = pointer.pointerToGoal(request, pointer.repairGoalPointer(request, candidate.text));
        // A service the repair had to empty ("campaign for shop.co.uk") marks a weaker reading.
        return { goal, emptied: /(?:^|;)\s*service\s/.test(candidate.text) && goal?.service === null };
      });
      const goals = readings.map(item => item.goal);
      io.signal.throwIfAborted();
      // Greedy first, then the samples: the first reading the checker accepts, preferring one
      // whose service the model named cleanly. A service that swallows the link is not a
      // service: another reading is preferred, and failing that the brain drops the service.
      const checked = readings.filter((item): item is { goal: Goal; emptied: boolean } => item.goal !== null && !checkGoal(request, item.goal).length);
      const chosen = (checked.find(item => !item.emptied && serviceClean(item.goal)) ?? checked.find(item => serviceClean(item.goal)) ?? checked[0])?.goal ?? null;
      const goal = chosen && !serviceClean(chosen) ? { ...chosen, service: null } : chosen;
      if (!goal) {
        if (!goals.some(item => item?.intent === 'create_campaign')) return null;
        return { status: 'partial', text: `فهمت أنك تريد حملة إعلانية، لكن لم أستطع استخراج التفاصيل من الجملة بثقة. اكتبها بصيغة مثل ${EXAMPLE}.` };
      }
      if (goal.intent !== 'create_campaign') return null;
      // When the checked readings disagree on the service and none holds a majority, the brain
      // did not understand it: the owner chooses instead of the brain guessing.
      const votes = new Map<string, { text: string; count: number }>();
      for (const item of checked) {
        const service = serviceClean(item.goal) ? item.goal.service : null;
        if (!service) continue;
        const entry = votes.get(service.toLowerCase()) ?? { text: service, count: 0 };
        votes.set(service.toLowerCase(), { ...entry, count: entry.count + 1 });
      }
      const ranked = [...votes.values()].sort((a, b) => b.count - a.count);
      const unsure = ranked.length >= 2 && ranked[0]!.count * 2 <= checked.length;
      brief = briefFromGoal(goal, unsure ? ranked.slice(0, 3).map(entry => entry.text) : []);
    }

    // The brain thinks before it asks: it reads the site, takes what the site itself says
    // (its country), and only then asks for everything still missing, in one message.
    const located = brief.locations.map(place => countryIn(place));
    if (located.some(Boolean)) {
      brief.country ??= located.find(Boolean)![0];
      const places = brief.locations.filter((_, index) => !located[index]);
      brief.locations = places.length ? places : located.filter(Boolean).map(entry => entry![1]);
    }
    let page: LandingFetch | null = null;
    let read: ReturnType<typeof pageLines> | null = null;
    let siteProblem: string | null = null;
    const notes: string[] = [];
    if (brief.url) {
      await io.step(`قراءة الموقع ${brief.url}`);
      try {
        const fetched = await deps.fetchPage(siteUrl(brief.url), io.signal);
        if (fetched.status >= 200 && fetched.status < 300) { page = fetched; read = pageLines(fetched.html); }
        else siteProblem = `رد الموقع ${brief.url} بالحالة ${fetched.status}، فلم أستطع قراءة صفحته.`;
      } catch {
        io.signal.throwIfAborted();
        siteProblem = `تعذر فتح ${brief.url}.`;
      }
      if (siteProblem) brief = { ...brief, url: null };
    }
    if (page && read) {
      const language = (read.language ?? page.contentLanguage ?? (/\p{Script=Arabic}/u.test(read.text) ? 'ar' : 'en')).toLowerCase();
      // An English label must not route predominantly Arabic content into an English-only checkpoint.
      const arabicLetters = (read.text.match(/\p{Script=Arabic}/gu) ?? []).length;
      const latinLetters = (read.text.match(/[a-z]/gi) ?? []).length;
      if (arabicLetters > latinLetters && !languages.includes('ar')) return { status: 'partial', text: 'نص صفحة الموقع عربي، وهذه النسخة من النموذج تدعم الإنجليزية فقط.' };
      if (!languages.some(supported => language === supported || language.startsWith(`${supported}-`))) return { status: 'partial', text: languages.length === 1 && languages[0] === 'en' ? 'صفحة الموقع ليست بالإنجليزية، والنموذج يكتب الإعلانات للمواقع الإنجليزية فقط حالياً.' : 'لغة صفحة الموقع غير مدعومة في نسخة النموذج المحددة.' };
      brief.country ??= siteCountry(page.finalUrl, read.language ?? page.contentLanguage);
      // The sentence names the service and the site's title or headings repeat it: the brain takes it.
      if (!saved && !brief.service && !brief.serviceChoices.length) brief.service = servicePhrase(request, `${read.title}\n${read.text.split('\n').slice(0, 15).join('\n')}`, brief.locations);
      // A service the page never mentions cannot be advertised from the page's own words: asked once.
      if (brief.service && !brief.serviceChoices.length && !serviceOnSite(brief.service, `${read.title}\n${read.text}`) && brief.serviceDoubt?.toLowerCase() !== brief.service.toLowerCase()) {
        notes.push(`لم أجد «${brief.service}» في صفحة موقعك، والإعلان يُكتب من نص الصفحة. إن كانت هي الخدمة فعلاً فأعد كتابتها وسأعتمدها، أو اكتب الخدمة كما تظهر في الموقع.`);
        brief = { ...brief, serviceDoubt: brief.service, service: null };
      }
    }

    const missing = missingFields(brief);
    if (missing.length) {
      if (brief.rounds >= MAX_ASK_ROUNDS) {
        return { status: 'blocked', text: `سألت ${brief.rounds} مرات وما زلت لا أستطيع قراءة: ${missing.map(field => FIELD_AR[field]).join('، ')}. أعد الطلب بجملة واحدة فيها كل التفاصيل، مثل ${EXAMPLE}.` };
      }
      const text = renderQuestions(brief, missing, { title: read?.title ?? null });
      const lead = [siteProblem, ...notes].filter(Boolean).join('\n');
      const fields = suggestFields(brief, missing, page && read ? { html: page.html, title: read.title, text: read.text, business: page.finalUrl } : null);
      return { status: 'waiting_user', text: lead ? `${lead}\n\n${text}` : text, brief: { ...brief, asked: missing, rounds: brief.rounds + 1 }, fields };
    }
    if (!page || !read) return { status: 'partial', text: siteProblem ?? 'لم أستطع قراءة صفحة الموقع.' };
    const goal = {
      intent: 'create_campaign', url: brief.url, service: brief.service, locations: brief.locations,
      budget: brief.budget ? { amount: brief.budget.amount, currency: brief.budget.currency, period: brief.budget.period } : null,
      goal: brief.goal,
    } as Goal;

    await io.step('اختيار العناوين والأوصاف من نص الموقع');
    let lastIssues: string[] = [];
    // The full digest first; a page too long for the model's context is retried shorter.
    for (const budget of [site.DIGEST_CHARS, 1000]) {
      const input = site.siteDigest(page.finalUrl, read.title, `${read.title}\n${read.text}`, budget);
      if (!input.text) return { status: 'partial', text: 'لم أجد في صفحة الموقع نصاً كافياً لكتابة إعلانات منه.' };
      let texts: string[];
      try {
        texts = (await deps.worker.sample(pointer.renderSitePointerPrompt(input, { usableOnly: true }), {}, CANDIDATES, { signal: io.signal })).candidates.filter(candidate => candidate.finished).map(candidate => candidate.text);
      } catch (error) {
        if (error instanceof Error && /too long/i.test(error.message) && budget !== 1000) continue;
        throw error;
      }
      io.signal.throwIfAborted();
      // Every candidate the checker accepts, greedy first: the brain's quality pass then
      // chooses among all of the model's checked picks, not only one answer's.
      const passing: SiteAds[] = [];
      for (const text of texts) {
        const ads = pointer.pointerToSite(input, text);
        const issues = ads ? site.checkSiteAds(input, ads) : ['BAD_POINTER'];
        if (ads && !issues.length) passing.push(ads);
        else if (!lastIssues.length) lastIssues = issues;
      }
      if (!passing.length) break;
      const where = { url: page.finalUrl, host: input.site };
      const refined = refineAds(mergeAds(passing)!, input, { service: goal.service, locations: goal.locations, services: siteSearchPhrases(page.html, read.title, read.text, goal.service, page.finalUrl, brief.locations) });
      if (refined) return { status: 'completed', text: renderAdsDraft(goal, refined, where, brief.country), campaign: campaignLines(brief, refined, where) };
      return { status: 'partial', text: `${renderAdsDraft(goal, passing[0]!, where, brief.country)}\n\nتنبيه: لم أجد في الصفحة عناوين وأوصافاً قوية بالعدد الذي يطلبه Google، فهذه النصوص المفحوصة كما اختارها النموذج دون تنقية، ولم أنشئ الحملة. صفحة خدمة محددة من الموقع تعطي نتيجة أفضل.` };
    }
    return { status: 'partial', text: `قرأت الموقع، لكن لم يجتز أي اقتراح من النموذج (${CANDIDATES} محاولات) فحص النصوص${lastIssues.length ? ` (${lastIssues.join(', ')})` : ''}، فلم أعرض نصاً غير مفحوص.` };
  }

  return { handle };
}
