import { z } from 'zod';
import { GoogleAdsBriefSchema, GoogleAdsCustomerIdSchema, type CampaignCheck, type GoogleAdsBrief } from '@mohassan/contracts';
import { budgetToMicros } from '@mohassan/google-ads';
import { ambiguousBudgetPeriod, budgetNumbers, checkGoal, CURRENCY_WORDS, PERIOD_WORDS } from '../../../../scripts/ads-training/goal.js';
import { budgetIn, countryIn, dailyBudget, goalIn, placesIn, serviceClean, type AdsField } from './ads-model-chat.js';
import { maskRequestLiteralData } from './request-constraints.js';
import { requestsPausedCampaign } from './tools.js';

/** Values must come from actual owner answers interpreted by host code, never
 * from model output, page text, memory or a proposed campaign. */
export interface CampaignAuthorizationAnswer { field: AdsField; value: string }
export interface CampaignAuthorizationInput {
  request: string;
  answers?: readonly CampaignAuthorizationAnswer[];
  brief: GoogleAdsBrief;
  account: { customerId: string; currency: string; timeZone: string };
}
export interface CampaignAuthorizationResult {
  passed: boolean;
  checks: CampaignCheck[];
  issues: { field: string; code: string; message: string }[];
  scope: { customerId: string; currency: string; timeZone: string; dailyBudget: string; landingPageUrl: string; service: string; locations: string[]; goal: string; countryCode: string | null } | null;
}

const Input = z.object({ request: z.string().min(1).max(8000), answers: z.array(z.object({ field: z.enum(['url', 'service', 'locations', 'country', 'budget', 'goal']), value: z.string().min(1).max(2000) }).strict()).max(24).optional(),
  brief: GoogleAdsBriefSchema, account: z.object({ customerId: GoogleAdsCustomerIdSchema, currency: z.string().regex(/^[A-Z]{3}$/), timeZone: z.string().min(1).max(128) }).passthrough() });
const fold = (text: string) => text.normalize('NFKC').replace(/[\u0640\u064b-\u065f\u0670]/gu, '').replace(/[أإآٱ]/gu, 'ا').toLowerCase().replace(/\s+/gu, ' ').trim();
const western = (text: string) => text.replace(/[٠-٩]/gu, value => String(value.charCodeAt(0) - 0x660)).replace(/[۰-۹]/gu, value => String(value.charCodeAt(0) - 0x6f0));
/** Only explicit account/customer ID directives in the current owner request.
 * Quoted page instructions are masked before any account is selected or read. */
export function campaignRequestedAccountIds(request: string): string[] {
  const text = western(maskRequestLiteralData(request));
  return [...new Set([...text.matchAll(/(?:\b(?:account|customer)(?:\s*(?:id|number))?|(?:رقم\s+)?حساب(?:ي|نا)?(?:\s+(?:جوجل|غوغل|Google\s+Ads|الإعلانات|الاعلانات))?)(?:\s*(?:id|number|رقم))?\s*(?:[:#=]\s*)?(\d{3}[-\s]?\d{3}[-\s]?\d{4})(?!\d)/giu)].map(match => match[1].replace(/\D/gu, '')))];
}
const URLS = /(?:https?:\/\/|www\.)[^\s<>"'`]+|(?<![@\p{L}\p{N}_])(?:[a-z0-9-]+\.)+[a-z]{2,24}(?:\/[^\s<>"'`]+)?/giu;
const withoutUrls = (text: string) => text.replace(URLS, value => ' '.repeat(value.length));
const cleanUrl = (text: string): string | null => {
  try { const url = new URL(/^[a-z]+:\/\//iu.test(text) ? text : `https://${text}`); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
};
const urlsIn = (text: string) => [...new Set([...text.matchAll(URLS)].map(match => cleanUrl(match[0].replace(/[.,;!?)؟]+$/gu, ''))).filter((value): value is string => Boolean(value)))];
const budgetMarker = /\bbudget\b|ميزاني[ةه]|ميزانيتي|بميزاني[ةه]/iu;
const moneyMention = (text: string) => Object.values(CURRENCY_WORDS).some(pattern => pattern.test(text));
const periodsIn = (text: string) => Object.entries(PERIOD_WORDS).filter(([, pattern]) => pattern.test(text)).map(([period]) => period as 'day' | 'week' | 'month');
function budgetSource(text: string): { text: string; value: NonNullable<ReturnType<typeof budgetIn>> } | null {
  const stripped = withoutUrls(text);
  const marked = [...stripped.matchAll(/(?:\bbudget\b|ميزاني[ةه]|ميزانيتي|بميزاني[ةه])\s*[:=]?\s*([^;\n!?؛؟]{1,160})/giu)].map(match => match[0]);
  const clauses = stripped.split(/[;\n،]|(?<!\d),(?!\d)/gu).filter(part => budgetMarker.test(part) || moneyMention(part));
  if ([...marked, ...clauses].some(part => new Set(budgetNumbers(part)).size > 1 && /\bor\b|\bbetween\b|(?:^|\s)(?:أو|او|بين)(?:\s|$)/iu.test(part))) return null;
  const candidates = [...new Set([...marked, ...clauses, stripped])].flatMap(part => {
    const value = budgetIn(part);
    return value && (marked.includes(part) || moneyMention(part) || periodsIn(part).length) ? [{ text: part, value }] : [];
  });
  if (!candidates.length) return null;
  // A clearly marked budget wins over unrelated numbers elsewhere (phone,
  // account, service hours). Conflicting budget clauses never select a value.
  const explicit = candidates.filter(item => budgetMarker.test(item.text));
  const considered = candidates.filter(item => budgetMarker.test(item.text) || periodsIn(item.text).length);
  const signatures = new Set(considered.map(item => JSON.stringify([budgetToMicros(item.value.amount), item.value.currency, periodsIn(item.text)])));
  return signatures.size === 1 ? (explicit[0] ?? considered[0]) : null;
}
const canonicalPlaces = (values: readonly string[]) => [...new Set(values.map(fold))].sort();
const samePlaces = (left: readonly string[], right: readonly string[]) => JSON.stringify(canonicalPlaces(left)) === JSON.stringify(canonicalPlaces(right));
function countriesIn(text: string): string[] {
  const words = withoutUrls(text).match(/[\p{L}.]+/gu) ?? [];
  const found = new Set<string>();
  for (let index = 0; index < words.length; index++) for (let size = 1; size <= 4 && index + size <= words.length; size++) {
    const part = words.slice(index, index + size).join(' ');
    // Do not interpret ordinary two-letter words such as "in" as ISO codes.
    if (size === 1 && words[index].length === 2 && !/^(?:GB|UK|US|CA|AU|NZ|SA|AE|EG)$/u.test(words[index])) continue;
    const country = countryIn(part); if (country) found.add(country[0]);
  }
  return [...found];
}
function requestPlaces(text: string): string[] | null {
  const clean = withoutUrls(text);
  const labelled = [...clean.matchAll(/(?:^|\n)(?:locations?|areas?|cities|المناطق|المدن|المنطقة)\s*[:=]\s*([^\n;؛]+)/giu)].map(match => match[1]);
  const spans = labelled.length ? labelled : [...clean.matchAll(/\b(?:in|targeting|target|around|covering|serving|across|for people in)\s+|(?:في|استهدف|استهداف|نغطي|المناطق|المدن)\s*[:=]?\s+/giu)].map(match => {
    const tail = clean.slice(match.index! + match[0].length);
    return tail.split(/\s+(?:with|using|for|budget|daily|per day|to get|goal|i want|we want|website|landing page|url|service)\b|[;.!?؛\n]|(?=[£€$])|(?:،|,)?\s*(?:الميزانية|بميزانية|الرابط|الموقع|الخدمة|الهدف)/iu)[0];
  });
  const groups = spans.map(span => span.replace(/[,،:\s]+$/gu, '').replace(/\s+(?:only|فقط)$/iu, '').trim())
    .filter(span => span && !/\b(?:my|our|the|google|ads|account|campaign)\b|حساب|اعلانات|حملة/iu.test(span))
    .map(span => placesIn(span)).map(values => {
      // Reuse the own Ads answer parser's convention: "Glasgow, UK" supplies
      // the country alongside the city, not a second whole-country target.
      const countries = values.map(value => countryIn(value));
      return countries.some(Boolean) && countries.some(value => !value) ? values.filter((_value, index) => !countries[index]) : values;
    }).filter(values => values.length);
  if (!groups.length || groups.some(values => !samePlaces(values, groups[0]))) return null;
  return groups[0];
}
function currencyMatches(text: string, accountCurrency: string, country: string | null): boolean {
  const currencies = Object.entries(CURRENCY_WORDS).filter(([, pattern]) => pattern.test(text)).map(([currency]) => currency);
  if (currencies.length > 1) return false;
  const code = /\b(GBP|USD|CAD|AUD|NZD|EUR|SAR|AED|EGP)\b/iu.exec(text)?.[1].toUpperCase();
  if (code) return code === accountCurrency;
  const currency = currencies[0];
  if (!currency) return !/جنيه|ريال|درهم/iu.test(text); // An unspecified unit uses the observed account currency; an ambiguous named unit does not.
  if (currency === '$') {
    const byCountry: Record<string, string> = { US: 'USD', CA: 'CAD', AU: 'AUD', NZ: 'NZD' };
    return Boolean(country && byCountry[country] === accountCurrency);
  }
  return ({ '£': 'GBP', '€': 'EUR', SAR: 'SAR', AED: 'AED', EGP: 'EGP' } as Record<string, string>)[currency] === accountCurrency;
}

/** This host boundary proves that the candidate matches material values the
 * owner actually supplied. An inferred proposal remains a proposal until the
 * missing or ambiguous fields are answered; site text grants no spend scope. */
export function authorizeCampaignBrief(raw: CampaignAuthorizationInput): CampaignAuthorizationResult {
  const parsed = Input.safeParse(raw);
  if (!parsed.success) return { passed: false, scope: null, checks: [{ id: 'authorization_input', passed: false, detail: 'The trusted request, account or proposed brief is invalid.' }], issues: [{ field: 'input', code: 'ADS_AUTHORIZATION_INPUT', message: 'The trusted request, account or proposed brief is invalid.' }] };
  const { brief, account } = parsed.data;
  const request = maskRequestLiteralData(parsed.data.request);
  const answers = parsed.data.answers ?? [];
  const answer = (field: AdsField) => answers.findLast(item => item.field === field)?.value;
  const trustedText = [request, ...answers.map(item => maskRequestLiteralData(item.value))].join('\n');
  const checks: CampaignCheck[] = [], issues: CampaignAuthorizationResult['issues'] = [];
  const add = (field: string, passed: boolean, code: string, message: string) => { checks.push({ id: `scope_${field}`, passed, detail: message.slice(0, 600) }); if (!passed) issues.push({ field, code, message }); };
  add('intent', requestsPausedCampaign(request), 'ADS_CREATION_NOT_REQUESTED', 'The current owner request must explicitly authorize creating a campaign; quoted instructions cannot grant it.');
  // The existing brief cannot encode bidding limits or ad schedules. Do not
  // silently replace explicit constraints with the adapter's default strategy.
  const unsupportedConstraint = /\b(?:max(?:imum)?\s*(?:cpc|bid)|target\s*(?:cpa|roas)|bid\s*cap|cost\s+per\s+click|ad\s+schedule)\b|\b(?:cpc|cpa|roas)\s*(?:[:=<>]|of\b|under\b|below\b|at\s+most\b|[£$€\d])|\b(?:run|show|serve)\b[^;\n.!?]{0,35}\bonly\b[^;\n.!?]{0,35}\b(?:weekdays?|weekends?|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}:\d{2})\b|(?:سقف|حد\s+اقصى|حد\s+أقصى)\s+(?:لـ?\s*)?(?:عرض\s+السعر|سعر\s+النقرة|تكلفة\s+النقرة)|(?:جدول|جدولة)\s+(?:الاعلان|الإعلان|الاعلانات|الإعلانات)/iu.test(withoutUrls(trustedText));
  add('constraints', !unsupportedConstraint, 'ADS_UNSUPPORTED_MATERIAL_CONSTRAINT', 'This creation path cannot represent bidding caps, target CPA/ROAS or ad schedules. Review a supported concrete proposal before writing; no constraint may be silently dropped.');
  const identifiers = campaignRequestedAccountIds(parsed.data.request);
  add('account', identifiers.every(id => id === account.customerId), 'ADS_AUTHORIZED_ACCOUNT_MISMATCH', 'Any account ID explicitly named by the owner must equal the observed target account.');
  const urls = urlsIn(answer('url') ?? request), targetUrl = cleanUrl(brief.landingPageUrl);
  add('url', urls.length === 1 && urls[0] === targetUrl, urls.length === 1 ? 'ADS_LANDING_SCOPE_MISMATCH' : 'ADS_LANDING_SCOPE_REQUIRED', 'Supply one exact landing page URL and keep the campaign destination equal to it.');
  const countries = answer('country') ? [countryIn(answer('country')!)?.[0]].filter((value): value is string => Boolean(value)) : countriesIn(request);
  const explicitCountry = countries.length === 1 ? countries[0] : null;
  add('country', countries.length <= 1 && (!answer('country') || countries.length === 1) && (explicitCountry === null || explicitCountry === brief.countryCode), 'ADS_COUNTRY_SCOPE_MISMATCH', 'One unambiguous country explicitly named by the owner must match the proposed target country.');
  const selectedBudget = budgetSource(answer('budget') ?? request);
  const periods = selectedBudget ? periodsIn(selectedBudget.text) : [];
  const amountGrounded = Boolean(selectedBudget && budgetNumbers(selectedBudget.text).some(amount => budgetToMicros(amount) === budgetToMicros(selectedBudget.value.amount)));
  const negativeBudget = Boolean(selectedBudget && /(?:^|[^\d])[-−]\s*(?:[£$€]\s*)?\d|[£$€]\s*[-−]\s*\d|\b(?:minus|negative)\s+(?:[£$€]\s*)?\d|(?:سالب|ناقص)\s*\d/iu.test(western(selectedBudget.text)));
  const budgetUnambiguous = Boolean(selectedBudget && periods.length === 1 && !ambiguousBudgetPeriod(selectedBudget.text, selectedBudget.value.amount));
  const expectedBudget = selectedBudget && budgetUnambiguous ? dailyBudget({ ...selectedBudget.value, period: periods[0] }) : null;
  const hardSpendCap = /\b(?:spend|spending)\b.{0,24}\b(?:no more than|never|not exceed|at most)\b|لا\s+(?:تصرف|تنفق)|لا\s+يتجاوز\s+الانفاق/iu.test(answer('budget') ?? request);
  add('budget', Boolean(expectedBudget && amountGrounded && !negativeBudget && !hardSpendCap && budgetToMicros(expectedBudget) === budgetToMicros(brief.dailyBudget)),
    hardSpendCap ? 'ADS_HARD_SPEND_CAP_UNSUPPORTED' : expectedBudget ? 'ADS_BUDGET_SCOPE_MISMATCH' : 'ADS_BUDGET_SCOPE_REQUIRED',
    hardSpendCap ? 'Google Ads average daily budgets do not enforce a hard daily spend cap; clarify the permitted average budget before creation.' : 'Supply one positive budget and period. The proposed average daily budget must equal the existing day/week/month conversion of that amount.');
  add('currency', Boolean(selectedBudget && currencyMatches(selectedBudget.text, account.currency, explicitCountry)), 'ADS_CURRENCY_SCOPE_MISMATCH', 'The stated money unit must match the observed account currency; no currency conversion or relabelling is authorized.');
  const locationAnswer = answer('locations');
  const locations = locationAnswer ? placesIn(locationAnswer) : requestPlaces(request);
  const radius = /\b\d+(?:\.\d+)?\s*(?:miles?|mi|kilomet(?:er|re)s?|km)\b|\d+\s*(?:ميل|اميال|أميال|كيلومتر|كم)/iu.test(locationAnswer ?? request);
  add('locations', Boolean(locations?.length && !radius && samePlaces(locations, brief.locations)), radius ? 'ADS_RADIUS_SCOPE_UNSUPPORTED' : locations ? 'ADS_LOCATION_SCOPE_MISMATCH' : 'ADS_LOCATION_SCOPE_REQUIRED',
    radius ? 'This campaign path supports named locations, not a radius. Confirm supported geography before creation; do not replace a radius with a wider city.' : 'All proposed locations must exactly equal the locations supplied by the owner.');
  const goalAnswer = answer('goal');
  const goalText = goalAnswer ?? [...withoutUrls(request).matchAll(/(?:\bgoal\s*[:=]?|\b(?:i|we)\s+(?:want|need)|\b(?:get|generate|drive|increase|more)\s+|\bfor\s+(?:more\s+)?(?=calls?|bookings?|leads?)|(?:الهدف|هدفي|للحصول على|اريد|أريد|ابغى|أبغى|نريد|زيادة)\s*[:=]?)([^\n;؛.!?]{1,100})/giu)].map(match => match[1]).join('\n');
  const goal = goalIn(goalText);
  add('goal', goal !== null && goal === brief.goal, goal ? 'ADS_GOAL_SCOPE_MISMATCH' : 'ADS_GOAL_SCOPE_REQUIRED', 'The conversion goal must match one unambiguous goal supplied by the owner.');
  const serviceAnswer = answer('service');
  const serviceGoal = { intent: 'create_campaign' as const, url: null, service: fold(brief.service), locations: [], budget: null, goal: null };
  // Creation authority is checked independently above. The older goal checker
  // also calls "do not launch" a negated create, although PAUSED creation is
  // precisely what the owner may authorize while forbidding activation.
  const grounding = checkGoal(fold(withoutUrls(trustedText)), serviceGoal).filter(issue => issue !== 'NEGATED_CREATE_REQUEST');
  add('service', !grounding.length && serviceClean(serviceGoal) && (!serviceAnswer || fold(serviceAnswer) === fold(brief.service)), 'ADS_SERVICE_SCOPE_REQUIRED', 'The service must be stated by the owner, and must match an explicit service answer when one was given.');
  const passed = checks.every(item => item.passed);
  return { passed, checks, issues, scope: passed ? { customerId: account.customerId, currency: account.currency, timeZone: account.timeZone, dailyBudget: expectedBudget!, landingPageUrl: targetUrl!, service: brief.service, locations: [...brief.locations], goal: brief.goal, countryCode: explicitCountry } : null };
}
