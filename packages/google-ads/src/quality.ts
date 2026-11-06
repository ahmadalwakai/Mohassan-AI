import type { GoogleAdsBrief, GoogleAdsIssue, GoogleAdsLanding } from '@mohassan/contracts';

/**
 * AdQualityValidator. Limits come from Google's help pages (answer/7684791,
 * answer/10286719, keyword limits answer/2453981, editorial policy answer/6021546).
 * Code counts because models miscount, and code never approves what nobody stated.
 */
export const ADS_LIMITS = Object.freeze({ headline: 30, description: 90, path: 15, minHeadlines: 3, maxHeadlines: 15, minDescriptions: 2, maxDescriptions: 4, maxPaths: 2, keywordChars: 80, keywordWords: 10 });

/** Google counts each Chinese, Japanese and Korean character as two. */
const DOUBLE_WIDTH = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
export const adsLength = (text: string) => [...text].reduce((total, character) => total + (DOUBLE_WIDTH.test(character) ? 2 : 1), 0);

/** Offers a model tends to invent. They pass only when the owner or the landing page said them. */
export const CLAIM = /24\s*\/\s*7|\bfree\b|\bguarantee[sd]?\b|\bcheapest\b|\bbest\b|\bsave\b|\binsured\b|\baward\S*|\bsame[- ]day\b|\bno\.?\s?1\b|#1|\d+\s*%|[£$€]\s*\d[\d,.]*|\d+\+?\s*(?:years?|reviews?|stars?)\b|\bdiscounts?\b|\d+\+?\s*(?:سنوات|سنة|عامًا|عاما|أعوام|تقييم\S*|نجوم)|خصم|تخفيض\S*|مجان\S*|ضمان|مضمون\S*|[ينت]ضمن|الأفضل|الأرخص/giu;

/** Nobody can buy or promise a position, so these fail even when the owner wrote them. */
const POSITION_PROMISE = /\b(?:top|first|#?1|number one|no\.?\s?1)\b[^.!?]{0,20}\b(?:google|search results?|rank(?:ing)?|position)\b|\b(?:rank|ranked|ranking)\s+(?:first|#?1|top|number one)\b|\bguaranteed?\s+(?:rank\w*|position|clicks?|leads?|results?|bookings?)\b|(?:الأول[ىة]?|المركز الأول|أول نتيجة|الصدارة)[^.!؟]{0,20}(?:جوجل|غوغل|google|نتائج البحث)/iu;

const INVALID_KEYWORD = /[!@%^*=;~`<>?\\|{}]/;
const PHONE = /(?:\+|00)?\d[\d\s().-]{7,}\d/;
const WEBSITE = /\bhttps?:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|net|org|co\.uk|uk|io|ai|sa|ae)\b/i;
const EMOJI = /\p{Extended_Pictographic}/u;
const CLICK_HERE = /\bclick here\b|اضغط هنا|انقر هنا/i;

/** Languages a country's searchers commonly use. A hint, always reported as an assumption. */
const COUNTRY_LANGUAGES: Readonly<Record<string, readonly string[]>> = Object.freeze({ GB: ['en'], IE: ['en'], US: ['en', 'es'], CA: ['en', 'fr'], AU: ['en'], NZ: ['en'], SA: ['ar', 'en'], AE: ['ar', 'en'], EG: ['ar', 'en'], QA: ['ar', 'en'], KW: ['ar', 'en'], BH: ['ar', 'en'], OM: ['ar', 'en'], JO: ['ar', 'en'], FR: ['fr'], DE: ['de'], ES: ['es'], IT: ['it'] });
export const languageFitsCountry = (language: string, country: string) => { const known = COUNTRY_LANGUAGES[country]; return known ? known.includes(language) : true; };

/** Script is what can be proven from text. Latin languages cannot be told apart this way. */
export function detectScript(text: string): 'arabic' | 'latin' | 'cjk' | 'other' | null {
  const counts = { arabic: 0, latin: 0, cjk: 0, other: 0 };
  for (const character of text) {
    if (/\p{Script=Arabic}/u.test(character)) counts.arabic += 1;
    else if (/\p{Script=Latin}/u.test(character)) counts.latin += 1;
    else if (DOUBLE_WIDTH.test(character)) counts.cjk += 1;
    else if (/\p{L}/u.test(character)) counts.other += 1;
  }
  const top = (Object.entries(counts) as [keyof typeof counts, number][]).sort((a, b) => b[1] - a[1])[0]!;
  return top[1] ? top[0] : null;
}
const scriptOf = (language: string) => language === 'ar' || language === 'fa' || language === 'ur' ? 'arabic' : ['zh', 'ja', 'ko'].includes(language) ? 'cjk' : ['ru', 'uk', 'el', 'he', 'hi', 'th'].includes(language) ? 'other' : 'latin';
export const scriptMatchesLanguage = (script: string | null, language: string) => script === null || script === scriptOf(language);

export type MatchType = 'BROAD' | 'PHRASE' | 'EXACT';
export function parseKeyword(raw: string): { text: string; matchType: MatchType } {
  const value = raw.trim();
  if (value.startsWith('[') && value.endsWith(']')) return { text: value.slice(1, -1).trim(), matchType: 'EXACT' };
  if (value.startsWith('"') && value.endsWith('"') && value.length > 1) return { text: value.slice(1, -1).trim(), matchType: 'PHRASE' };
  return { text: value, matchType: 'BROAD' };
}

const words = (text: string) => text.toLocaleLowerCase().split(/\s+/).filter(Boolean);

/** A negative blocks a keyword when all its words appear in it; exact and phrase negatives are narrower. */
export function negativeBlocks(negative: { text: string; matchType: MatchType }, keyword: { text: string }) {
  const blocked = words(negative.text), target = words(keyword.text);
  if (negative.matchType === 'EXACT') return blocked.join(' ') === target.join(' ');
  if (negative.matchType === 'PHRASE') return ` ${target.join(' ')} `.includes(` ${blocked.join(' ')} `);
  return blocked.every(word => target.includes(word));
}

export interface TextInput { headlines: string[]; descriptions: string[]; paths: string[]; keywords: string[]; negativeKeywords: string[] }

/** Text rules shared by the chat's ads_check and the draft validator. `evidence` undefined means claims are not judged. */
export function validateAdText(input: TextInput, evidence?: string, adLanguage?: string): GoogleAdsIssue[] {
  const issues: GoogleAdsIssue[] = [];
  const error = (code: string, field: string, message: string) => issues.push({ code, severity: 'error', field, message });
  const warning = (code: string, field: string, message: string) => issues.push({ code, severity: 'warning', field, message });
  const measure = (kind: 'headline' | 'description' | 'path', items: string[], limit: number) => {
    const seen = new Set<string>();
    items.forEach((text, index) => {
      const field = `${kind} ${index + 1}`;
      if (!text) { error('EMPTY', field, `${field} is empty`); return; }
      // Inserted text changes the length at serving time, so its size cannot be proven here.
      if (/[{}]/.test(text)) error('INSERTED_TEXT', field, `${field} has inserted text that cannot be counted, use plain text: ${JSON.stringify(text)}`);
      const length = adsLength(text);
      if (length > limit) error('TOO_LONG', field, `${field} is ${length} characters, limit ${limit}: ${JSON.stringify(text)}`);
      const key = text.toLocaleLowerCase();
      if (seen.has(key)) error('DUPLICATE', field, `${field} repeats an earlier one: ${JSON.stringify(text)}`);
      seen.add(key);
    });
  };
  measure('headline', input.headlines, ADS_LIMITS.headline);
  measure('description', input.descriptions, ADS_LIMITS.description);
  measure('path', input.paths, ADS_LIMITS.path);

  if (input.headlines.length || input.descriptions.length) {
    if (input.headlines.length < ADS_LIMITS.minHeadlines) error('TOO_FEW', 'headlines', `${input.headlines.length} headlines, an ad needs at least ${ADS_LIMITS.minHeadlines}`);
    if (input.headlines.length > ADS_LIMITS.maxHeadlines) error('TOO_MANY', 'headlines', `${input.headlines.length} headlines, an ad holds at most ${ADS_LIMITS.maxHeadlines}`);
    if (input.descriptions.length < ADS_LIMITS.minDescriptions) error('TOO_FEW', 'descriptions', `${input.descriptions.length} descriptions, an ad needs at least ${ADS_LIMITS.minDescriptions}`);
    if (input.descriptions.length > ADS_LIMITS.maxDescriptions) error('TOO_MANY', 'descriptions', `${input.descriptions.length} descriptions, an ad holds at most ${ADS_LIMITS.maxDescriptions}`);
  }
  if (input.paths.length > ADS_LIMITS.maxPaths) error('TOO_MANY', 'paths', `${input.paths.length} paths, an ad holds at most ${ADS_LIMITS.maxPaths}`);

  const copy: [string, string][] = [...input.headlines.map((text, index): [string, string] => [`headline ${index + 1}`, text]), ...input.descriptions.map((text, index): [string, string] => [`description ${index + 1}`, text])];
  for (const [field, text] of copy) {
    if (POSITION_PROMISE.test(text)) error('POSITION_PROMISE', field, `No one can promise a Google position or a result: ${JSON.stringify(text)}`);
    if (evidence !== undefined) {
      const known = evidence.toLocaleLowerCase();
      for (const [claim] of text.matchAll(CLAIM)) if (!known.includes(claim.toLocaleLowerCase())) error('UNSUPPORTED_CLAIM', field, `"${claim}" was not stated by the owner or the open page. Remove it, or ask the owner: ${JSON.stringify(text)}`);
    }
    if (field.startsWith('headline') && text.includes('!')) error('POLICY_PUNCTUATION', field, `Google does not allow an exclamation mark in a headline: ${JSON.stringify(text)}`);
    if ((text.match(/!/g) ?? []).length > 1) error('POLICY_PUNCTUATION', field, `Google allows at most one exclamation mark in a description: ${JSON.stringify(text)}`);
    if (/([!?.,؟])\1/.test(text)) error('POLICY_PUNCTUATION', field, `Repeated punctuation is not allowed: ${JSON.stringify(text)}`);
    // A brand can be written in capitals, so the exact spelling must appear in the evidence.
    if ([...text.matchAll(/\b[A-Z]{4,}\b/g)].some(([word]) => !evidence?.includes(word))) error('POLICY_CAPITALS', field, `Words in full capitals are not allowed: ${JSON.stringify(text)}`);
    if ((PHONE.exec(text)?.[0].replace(/\D/g, '').length ?? 0) >= 9) error('POLICY_PHONE', field, `Put a phone number in a call asset, not in ad text: ${JSON.stringify(text)}`);
    if (WEBSITE.test(text)) error('POLICY_WEBSITE', field, `Ad text cannot carry a web address: ${JSON.stringify(text)}`);
    if (EMOJI.test(text)) error('POLICY_SYMBOLS', field, `Emoji are not allowed in ad text: ${JSON.stringify(text)}`);
    if (CLICK_HERE.test(text)) error('POLICY_CALL_TO_ACTION', field, `Generic "click here" text is not allowed: ${JSON.stringify(text)}`);
    // Words the evidence states, such as a Latin brand in an Arabic ad, do not decide the language.
    const own = adLanguage ? text.split(/\s+/).filter(word => !evidence?.toLocaleLowerCase().includes(word.toLocaleLowerCase())).join(' ') : '';
    if (adLanguage && !scriptMatchesLanguage(detectScript(own), adLanguage)) error('LANGUAGE_MISMATCH', field, `Text is not written in the campaign language (${adLanguage}): ${JSON.stringify(text)}`);
  }

  const parsed = input.keywords.map(parseKeyword), negatives = input.negativeKeywords.map(parseKeyword);
  const checkKeyword = (raw: string, field: string, seen: Set<string>) => {
    const keyword = parseKeyword(raw);
    if (!keyword.text) { error('EMPTY', field, `${field} is empty`); return; }
    if (/(?:^|\s)\+\S/.test(keyword.text)) error('KEYWORD_SYNTAX', field, `${field} uses broad match modifier, which new keywords cannot use. Write it as "phrase", [exact] or plain broad: ${JSON.stringify(raw)}`);
    if (INVALID_KEYWORD.test(keyword.text)) error('KEYWORD_SYNTAX', field, `${field} has a character keywords cannot use: ${JSON.stringify(raw)}`);
    if (adsLength(keyword.text) > ADS_LIMITS.keywordChars) error('TOO_LONG', field, `${field} is over ${ADS_LIMITS.keywordChars} characters: ${JSON.stringify(raw)}`);
    if (words(keyword.text).length > ADS_LIMITS.keywordWords) error('TOO_LONG', field, `${field} is over ${ADS_LIMITS.keywordWords} words: ${JSON.stringify(raw)}`);
    const key = `${keyword.matchType}:${words(keyword.text).join(' ')}`;
    if (seen.has(key)) error('DUPLICATE', field, `${field} repeats an earlier one: ${JSON.stringify(raw)}`);
    seen.add(key);
  };
  const seenKeywords = new Set<string>(), seenNegatives = new Set<string>();
  input.keywords.forEach((raw, index) => checkKeyword(raw, `keyword ${index + 1}`, seenKeywords));
  input.negativeKeywords.forEach((raw, index) => checkKeyword(raw, `negative keyword ${index + 1}`, seenNegatives));
  if (evidence !== undefined) parsed.forEach((keyword, index) => {
    if (keyword.text && CLAIM.test(keyword.text)) warning('KEYWORD_CLAIM', `keyword ${index + 1}`, `Keyword implies an offer; check the page supports it: ${JSON.stringify(keyword.text)}`);
    CLAIM.lastIndex = 0;
  });
  for (const negative of negatives) for (const keyword of parsed) if (negative.text && keyword.text && negativeBlocks(negative, keyword)) error('NEGATIVE_BLOCKS_KEYWORD', 'negative keywords', `Negative ${JSON.stringify(negative.text)} would block keyword ${JSON.stringify(keyword.text)}`);
  return issues;
}

export function validateBrief(brief: GoogleAdsBrief, landing: GoogleAdsLanding | null, landingText: string): GoogleAdsIssue[] {
  const evidence = [...brief.ownerFacts, brief.businessName, brief.service, landingText].join('\n');
  const issues = validateAdText(brief, evidence, brief.adLanguage);
  const add = (code: string, severity: 'error' | 'warning', field: string, message: string) => issues.push({ code, severity, field, message });
  if (!brief.headlines.length) add('TOO_FEW', 'error', 'headlines', 'The draft has no headlines.');
  if (!brief.descriptions.length) add('TOO_FEW', 'error', 'descriptions', 'The draft has no descriptions.');
  if (!brief.keywords.length) add('TOO_FEW', 'error', 'keywords', 'The draft has no keywords.');
  if (!brief.landingPageUrl.startsWith('https://')) add('LANDING_NOT_HTTPS', 'error', 'landing page', 'The landing page must use HTTPS.');
  if (!languageFitsCountry(brief.adLanguage, brief.countryCode)) add('LANGUAGE_LOCATION_MISMATCH', 'warning', 'language', `Assumption: ${brief.adLanguage} is not a language commonly used in ${brief.countryCode}. Check that this audience exists.`);
  if (landing) {
    if (!landing.reachable) add('LANDING_UNREACHABLE', 'error', 'landing page', `The landing page did not load${landing.status ? ` (HTTP ${landing.status})` : ''}.`);
    else {
      if (landing.finalUrl && !sameSite(landing.requestedUrl, landing.finalUrl)) add('LANDING_REDIRECT', 'error', 'landing page', `The page redirects to another site: ${landing.finalUrl}`);
      if (landing.language && landing.language.slice(0, 2).toLowerCase() !== brief.adLanguage) add('LANDING_LANGUAGE_MISMATCH', 'error', 'landing page', `The page declares language ${landing.language}, the ads are in ${brief.adLanguage}.`);
      const page = landingText.toLocaleLowerCase();
      if (!brief.keywords.some(keyword => words(parseKeyword(keyword).text).some(word => word.length > 2 && page.includes(word)))) add('LANDING_RELEVANCE', 'warning', 'landing page', 'None of the keywords appear on the landing page, which can lower ad quality.');
    }
  }
  return issues;
}

const sameSite = (first: string, second: string) => {
  const site = (value: string) => new URL(value).hostname.replace(/^www\./, '');
  return site(first) === site(second);
};

/** Reads only what a validator needs from HTML, and never executes it. */
export function readLandingPage(requestedUrl: string, finalUrl: string, status: number, html: string, contentLanguage: string | null): { landing: GoogleAdsLanding; text: string } {
  const language = /<html\b[^>]*\blang\s*=\s*["']?([a-zA-Z-]{2,20})/i.exec(html)?.[1] ?? contentLanguage?.split(',')[0]?.trim() ?? null;
  const title = /<title[^>]*>([^<]{1,200})/i.exec(html)?.[1]?.trim() ?? null;
  const text = html.replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60000);
  return { landing: { requestedUrl, finalUrl, status, language, title, reachable: status >= 200 && status < 300 }, text };
}
