/**
 * ads.site.v1: a website's text -> ad copy for a Search campaign, in the site's own words.
 *
 * siteDigest (brain, deterministic) shortens a page to what fits the model: the title and the
 * page's lines in order, without repeated menus, cookie banners or broken characters.
 * siteAds is the teacher: it picks the business name, headlines (30 characters), descriptions
 * (90 characters) and keywords from the digest. Nothing is invented, so every label is
 * grounded by construction. checkSiteAds is the gate for both labels and model answers:
 * Google's text rules (validateAdText) plus "every line must be on the site".
 * English and Arabic text contracts. Keywords keep the site's casing; the brain lowercases them.
 */
import { createHash } from 'node:crypto';
import { domainToUnicode } from 'node:url';
import { ADS_LIMITS, adsLength, validateAdText } from '../../packages/google-ads/src/quality.js';
import { canonicalJson } from './lib.js';

export const SITE_CAPABILITY = 'ads.site.v1';
export const SITE_DATASET_VERSION = 'ads-site-v1';
export const DIGEST_CHARS = 1600;
export interface SiteInput { site: string; title: string; text: string }
export interface SiteAds { business: string | null; headlines: string[]; descriptions: string[]; keywords: string[] }

// ---------------------------------------------------------------- digest
const JUNK_LINE = /skip to (main )?content|\bmenu\b|open menu|close menu|^back$|^folder:|expand|collapse|cookie|copyright|©|all rights reserved|privacy|log ?in|sign (in|up)|my account|\bcart\b|basket|^search|powered by|javascript|^share$|^follow us|تخطي\s+(?:إلى\s+)?المحتوى|ملفات\s+(?:تعريف\s+الارتباط|الكوكيز)|حقوق\s+(?:الطبع|النشر)|جميع\s+الحقوق\s+محفوظة|سياسة\s+الخصوصية|تسجيل\s+(?:الدخول|دخول)|سلة\s+(?:التسوق|المشتريات)/iu;
/** The crawler stored some apostrophes and dashes as U+FFFD: "We�ve" is "We've", a lone one is a dash. */
const repair = (line: string) => line.replace(/[​-‍﻿]/g, '').replace(/(?<=\p{L})�(?=\p{L})/gu, "'").replace(/\s*�\s*/g, ' - ').replace(/\s+/g, ' ').trim();

export function siteDigest(url: string, title: string, text: string, budget = DIGEST_CHARS): SiteInput {
  const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  const cleanTitle = repair(title).slice(0, 150);
  const seen = new Set<string>([cleanTitle.toLowerCase()]);
  const kept: string[] = [];
  let used = 0;
  for (const raw of text.split('\n').slice(1)) {
    let line = repair(raw);
    if (line.length < 3 || !/\p{L}{2}/u.test(line) || JUNK_LINE.test(line)) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (line.length > 300) line = line.slice(0, 300).replace(/\s+\S*$/, '').replace(/[^.!]*$/, '') || line.slice(0, 300).replace(/\s+\S*$/, '');
    if (used + line.length + 1 > budget) break;
    kept.push(line);
    used += line.length + 1;
  }
  return { site: host, title: cleanTitle, text: kept.join('\n') };
}

// ---------------------------------------------------------------- teacher
const NAV = new Set(['home', 'about', 'about us', 'services', 'our services', 'contact', 'contact us', 'gallery', 'blog', 'blogs', 'location', 'locations',
  'faq', 'faqs', 'testimonials', 'reviews', 'team', 'our team', 'meet the team', 'news', 'shop', 'portfolio', 'careers', 'read more', 'learn more', 'more',
  'view all', 'see all', 'view more', 'all service areas', 'service areas', 'areas we serve', 'call now', 'call us', 'get started', 'submit', 'send',
  'quick links', 'useful links', 'links', 'resources', 'projects', 'events', 'store', 'register', 'account', 'english', 'dispatch', 'what we do',
  'who we are', 'our work', 'our story', 'get in touch', 'book now', 'enquire now', 'next', 'previous', 'close', 'open', 'help', 'support', 'company',
  'information', 'products', 'categories', 'customer service', 'opening hours', 'hours', 'address', 'phone', 'email', 'name', 'message', 'map',
  // Form fields and widgets.
  'select page', 'email address', 'zip code', 'postcode', 'post code', 'first name', 'last name', 'full name', 'your name', 'your email', 'phone number',
  'comments', 'subject', 'date', 'time', 'city', 'state', 'country', 'required', 'send message', 'submit form', 'toggle navigation', 'navigation',
  'main navigation', 'primary menu', 'sitemap', 'site map', 'related posts', 'recent posts', 'latest news', 'categories', 'archives', 'tags',
  'الرئيسية', 'الصفحة الرئيسية', 'من نحن', 'عنا', 'خدماتنا', 'الخدمات', 'تواصل معنا', 'اتصل بنا', 'اتصل الآن', 'اتصل الان', 'احجز الآن', 'احجز الان',
  'معلومات الاتصال', 'معرض الصور', 'المدونة', 'الأخبار', 'الاسئلة الشائعة', 'الأسئلة الشائعة', 'المزيد', 'اقرأ المزيد', 'عرض الكل', 'القائمة', 'إغلاق', 'اغلاق', 'بحث', 'المتجر', 'حسابي', 'تسجيل الدخول', 'العربية', 'الإنجليزية', 'عنوان البريد الإلكتروني', 'رقم الهاتف', 'الاسم', 'إرسال', 'ارسال']);
const KEYWORD_START = /^(?:(call|get|book|contact|request|free|find|see|view|read|learn|welcome|meet|why|how|what|our|we|your|you|the|a|an|and|for|with|to|in|at|from|by|about|all|more|best|top|new)\b|(?:اتصل|احجز|تواصل|اطلب|شاهد|اقرأ|اكتشف|نحن|أهلا|مرحبا|لماذا|كيف|ماذا)(?:\s|$))/iu;
const ODD = /[?؟|~•·»«{}<>@#*_=+\\/]|\.{2,}|…/;
export const words = (text: string) => text.split(/\s+/).filter(Boolean);
const norm = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
export const titleSegments = (title: string) => title.split(/\s+[|–—~:-]\s+|\s*\|\s*|:\s+/).map(part => part.trim()).filter(Boolean);
const hostLabel = (site: string) => domainToUnicode(site).split('.').filter(part => !['com', 'co', 'uk', 'org', 'net', 'au', 'ca', 'nz', 'ie', 'us', 'io', 'in', 'za', 'info', 'biz', 'ae', 'sa', 'example'].includes(part)).sort((a, b) => b.length - a.length)[0] ?? site;

/** The site's name as the business name is matched against ("kerbsidetyres.co.uk" -> "kerbsidetyres"). */
export const businessKey = (site: string) => norm(hostLabel(site));

/** The longest word-prefix of one title segment or line that spells the start of the domain name, or null. */
export function businessPrefix(candidate: string, host: string): string | null {
  if (host.length < 3) return null;
  const parts = words(candidate);
  for (let k = parts.length; k >= 1; k--) {
    const prefix = parts.slice(0, k).join(' ').replace(/[,.;:&-]+$/, '').trim();
    const key = norm(prefix);
    if (key.length >= Math.max(3, host.length * 0.6) && host.startsWith(key) && adsLength(prefix) <= ADS_LIMITS.headline && !ODD.test(prefix)) return prefix;
  }
  return null;
}

/** The business is the longest word-prefix of a title segment or line that spells the domain name. */
export function businessName(input: SiteInput): string | null {
  const host = businessKey(input.site);
  if (host.length < 3) return null;
  let best: string | null = null;
  for (const candidate of [...titleSegments(input.title), ...input.text.split('\n').slice(0, 40)]) {
    const prefix = businessPrefix(candidate, host);
    if (prefix && (!best || norm(best).length < norm(prefix).length)) best = prefix;
    if (best && norm(best) === host) break;
  }
  return best;
}

const allCaps = (text: string) => /\b[A-Z]{4,}\b/.test(text) && text === text.toUpperCase();
export function headlineOk(text: string) {
  const count = words(text).length;
  return adsLength(text) >= 4 && adsLength(text) <= ADS_LIMITS.headline && count >= 1 && count <= 6 && /^\p{L}/u.test(text)
    && !ODD.test(text) && !/[!():]/.test(text) && !NAV.has(text.toLowerCase()) && !allCaps(text) && !/\p{N}{5,}/u.test(text);
}
export const trimLine = (text: string) => /\.{2,}|…/.test(text) ? '' : text.replace(/[\s,;:.-]+$/, '').trim();
// A sentence opening like this needs its second half, so it is never cut short.
const SUBORDINATE = /^(?:(?:if|when|whether|although|while|as|because|since|for|with|at|in|from|even|once|after|before|by|to|whatever|whenever|are|is|do|does|can|have|has|will|would|should|could|looking|need)\b|(?:إذا|اذا|عندما|حينما|لأن|لانه|لأنه|بينما|رغم|بالرغم|هل)(?:\s|$))/iu;
// A comma may end a description only where a new clause starts after it, never inside a list.
const CLAUSE_AFTER = /^(?:delivering|providing|offering|ensuring|making|helping|giving|including|allowing|serving|which|so|but|and (?:we|our|they|it)|while|where)\b/i;

/** Sentences that fit, then a long sentence cut at a comma where its first clause ends. Questions are skipped. */
export function descriptionCandidates(sentence: string): string[] {
  const text = sentence.trim();
  if (/[?؟]$/.test(text) || SUBORDINATE.test(text)) return [];
  if (adsLength(text) <= ADS_LIMITS.description) return [text];
  let cut: string | null = null;
  for (const match of text.matchAll(/,\s+/g)) {
    const prefix = text.slice(0, match.index).trim();
    if (adsLength(prefix) + 1 > ADS_LIMITS.description) break;
    if (CLAUSE_AFTER.test(text.slice(match.index! + match[0].length))) cut = `${prefix}.`;
  }
  return cut ? [cut] : [];
}

/** A description the teacher would use: a whole sentence of 35-90 characters and 6+ words. */
export const descriptionOk = (text: string) => adsLength(text) >= 35 && adsLength(text) <= ADS_LIMITS.description && words(text).length >= 6
  && /^(?:\p{Lu}|\p{Script=Arabic})/u.test(text) && /[.!]$/.test(text) && !ODD.test(text) && !allCaps(text);

/** Sentences of one digest line, as the teacher and the pointer format split them. */
export const sentencesOf = (line: string) => line.split(/(?<=[.!?])\s+/);

/** Keywords are the short headlines that read as search terms (brain rule, shared by teacher and pointer decoder). */
export const keywordsFrom = (headlines: readonly string[], business: string | null) => headlines.filter(text => text !== business && words(text).length >= 2
  && words(text).length <= 4 && !/\p{N}/u.test(text) && !KEYWORD_START.test(text) && !/[!?؟.,،؛'"()]/.test(text)).slice(0, 10);

export function siteAds(input: SiteInput): SiteAds | null {
  const business = businessName(input);
  const lines = input.text.split('\n');
  const headlines: string[] = [], keys = new Set<string>();
  const addHeadline = (text: string) => { const key = text.toLowerCase(); if (!keys.has(key) && headlineOk(text)) { keys.add(key); headlines.push(text); } };
  if (business) addHeadline(business);
  for (const candidate of [...titleSegments(input.title), ...lines]) {
    if (headlines.length >= ADS_LIMITS.maxHeadlines) break;
    addHeadline(trimLine(candidate));
  }
  const descriptions: string[] = [];
  for (const line of lines) {
    for (const text of sentencesOf(line).flatMap(descriptionCandidates)) {
      if (descriptions.length < ADS_LIMITS.maxDescriptions && descriptionOk(text) && !descriptions.some(item => item.toLowerCase() === text.toLowerCase())) descriptions.push(text);
    }
  }
  const ads = { business, headlines, descriptions, keywords: keywordsFrom(headlines, business) };
  return headlines.length >= ADS_LIMITS.minHeadlines && descriptions.length >= ADS_LIMITS.minDescriptions && ads.keywords.length >= 2 && !checkSiteAds(input, ads).length ? ads : null;
}

// ---------------------------------------------------------------- gate
/** Accepts an answer only when Google's text rules pass and every line is on the site. Returns issue codes. */
export function checkSiteAds(input: SiteInput, output: unknown): string[] {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return ['NOT_OBJECT'];
  const ads = output as Record<string, unknown>;
  if (Object.keys(ads).sort().join(',') !== 'business,descriptions,headlines,keywords') return ['BAD_KEYS'];
  const list = (value: unknown) => Array.isArray(value) && value.every(item => typeof item === 'string') ? value as string[] : null;
  const headlines = list(ads.headlines), descriptions = list(ads.descriptions), keywords = list(ads.keywords);
  if (!headlines || !descriptions || !keywords || (ads.business !== null && typeof ads.business !== 'string')) return ['BAD_TYPE'];
  const evidence = `${input.title}\n${input.text}`, known = evidence.toLowerCase();
  const language = /\p{Script=Arabic}/u.test(evidence) ? 'ar' : 'en';
  const issues = new Set<string>(validateAdText({ headlines, descriptions, paths: [], keywords, negativeKeywords: [] }, evidence, language)
    .filter(issue => issue.severity === 'error').map(issue => issue.code));
  if (typeof ads.business === 'string' && !known.includes(ads.business.toLowerCase())) issues.add('UNGROUNDED_BUSINESS');
  if (headlines.some(text => !known.includes(text.toLowerCase()))) issues.add('UNGROUNDED_HEADLINE');
  // A description may end where the site's sentence continued after a comma, so its final stop is not compared.
  if (descriptions.some(text => !known.includes(text.replace(/[.!]$/, '').toLowerCase()))) issues.add('UNGROUNDED_DESCRIPTION');
  if (keywords.some(text => !known.includes(text.toLowerCase()))) issues.add('UNGROUNDED_KEYWORD');
  if (!keywords.length) issues.add('NO_KEYWORDS');
  if (keywords.length > 10) issues.add('TOO_MANY_KEYWORDS');
  if (headlines.some(text => NAV.has(text.toLowerCase()))) issues.add('NAV_HEADLINE');
  return [...issues].sort();
}

export const siteId = (input: SiteInput) => createHash('sha256').update(JSON.stringify([SITE_CAPABILITY, input])).digest('hex').slice(0, 16);
/** Sites are split by host hash, so a held-out site is never seen in training under another page. */
export const hostBucket = (site: string) => parseInt(createHash('sha256').update(site).digest('hex').slice(0, 8), 16) % 100;
export const renderSitePrompt = (input: SiteInput) => `Ads task:\n${canonicalJson({ capability: SITE_CAPABILITY, input })}\nOutput:\n`;
export const renderSiteTarget = (output: SiteAds) => canonicalJson(output);
