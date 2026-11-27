import { matchText, normalizeRequest } from './mind/normalize.js';

const CAMPAIGN_PLAN_AR = new RegExp(
  String.raw`^(?:(?:ممكن|هل يمكنك|هل تستطيع|ساعدني (?:في|على))\s+)?` +
  String.raw`(?:خطط(?:\s+(?:لي|لنا))?\s+ل?|(?:(?:ضع|اكتب|[اأ]عد|جهز)\s+(?:لي\s+)?)?خط[ةه]\s+ل?)` +
  String.raw`(?:ال)?حمل(?:[ةه]|تي|تنا)\s+(?:ال)?(?:[اأإ]علاني[ةه]|تسويقي[ةه]|(?:[اأإ]علانات|جوجل)(?:\s+(?:جوجل|الإعلانية))?)(?=\s|[\p{P}]|$)`, 'iu',
);
const CAMPAIGN_EN = '(?:(?:an?|the|my|our) )?(?:ad(?:vertising)?|marketing|google ads) campaign';
const CAMPAIGN_PLAN_EN = new RegExp(
  String.raw`^(?:(?:can you|could you|would you|help me)\s+)?` +
  String.raw`(?:(?:plan(?: out)?|(?:draft|write|prepare|make|create) (?:me )?(?:a )?plan for) ${CAMPAIGN_EN}|` +
  String.raw`(?:(?:draft|write|prepare|make|create) (?:me )?)?${CAMPAIGN_EN} plan)(?=\s|[\p{P}]|$)`, 'iu',
);

/** An explicit request for a campaign plan can be fulfilled without creating a campaign. */
export function parseCampaignPlanRequest(request: string): { lang: 'ar' | 'en'; brief: string } | null {
  if (!request.trim() || request.length > 8000) return null;
  const { text } = normalizeRequest(request);
  const arabic = CAMPAIGN_PLAN_AR.exec(text)?.[0];
  if (arabic) return { lang: 'ar', brief: text.slice(arabic.length) };
  const english = CAMPAIGN_PLAN_EN.exec(text)?.[0];
  return english ? { lang: 'en', brief: text.slice(english.length) } : null;
}

/**
 * Whether a message asks for an advertising campaign (the task cycle's step 2, «فهم الطلب»), for the routes that must not take
 * one: the calculator (a daily budget is a number), the public search (a private business is not a web question) and the
 * letter writer («create a campaign for …» is not a letter). On the frozen 107 real requests of 2026-11-22, five campaign
 * requests went there (artifacts/agent-gaps-2026-11-22/before): «Ads for boiler repair, … 40 pounds a week» and «Set up ads …»
 * to the calculator, «Advertise my removals company …» and «I run a barbershop … want more bookings, spend 15 pounds per day»
 * to a refused search, and «create a campaign for <site> selling …» to a letter. The forms below are written generally; the
 * unit tests use their own wording.
 *
 * Two kinds count:
 * - an explicit request: a verb of making or running with an advertising word («set up ads», «اعمل حملة إعلانية»), an
 *   advertising word followed by what it is for («Ads for boiler repair»), or «advertise/promote/أعلن عن» with an object;
 * - an implicit brief: the owner's business, a wish for more customers, and a budget per day, week or month.
 * A question about advertising («how do Google ads work?», «ما هي الحملة الإعلانية؟») is neither: it stays a question.
 */

const AD_WORD_EN = '(?:ads?|adverts?|advertisements?|advertising|campaigns?|google ads|adwords|ppc|pay per click)';
const AD_WORD_AR = '(?:حمله|حملات|حملتي|حملتنا|اعلان|اعلانات|اعلاني|اعلانيه|اعلانيا)';
const MAKE_EN = '(?:make|create|run|set ?up|launch|start|build|prepare|draft|design|put together|manage|do|organi[sz]e|plan|get|give me)';
const MAKE_AR = '(?:اعمل|اعملي|سوي|سويلي|جهز|جهزلي|انشئ|انشيء|ابني|ابن|اطلق|شغل|صمم|حضر|ابدا|ابغي|ابي|اريد|بدي|نريد|عايز|ودي|اعدلي|اعد)';
const QUESTION_START = /^(?:what|how|why|when|where|who|which|whats|hows|is|are|does|do|did|should|would|tell me about|explain|define)\b|^(?:ما|ماذا|كيف|لماذا|متي|اين|من هو|من هي|هل|اشرح|عرف)(?= |$)/u;
/** «I want to know how ads work», «أريد أن أفهم الحملات»: learning about advertising is a question, not a campaign. */
const LEARNING = /\b(?:know|understand|learn|explain|meaning|definition|difference|history)\b|(?:^| )(?:اعرف|افهم|اتعلم|معرفه|فهم|معني|تعريف|الفرق|تاريخ)(?= |$)/u;

const EXPLICIT: RegExp[] = [
  // «make ads for …», «can you set up a Google Ads campaign», «put together a campaign so …», «I sell tyres, make ads for it»
  new RegExp(`(?:^|[,;] |\\band )(?:please |pls |kindly )?(?:(?:can|could|would|will) you |help me |lets |let us )?${MAKE_EN}\\b[^.?!]{0,60}\\b${AD_WORD_EN}\\b`, 'u'),
  // «I need an ad campaign for my studio», «we want Google Ads»
  new RegExp(`^(?:please |pls |kindly )?(?:i|we) (?:want|need|would like)\\b[^.?!]{0,60}\\b${AD_WORD_EN}\\b`, 'u'),
  // «Ads for boiler repair», «Google Ads for my dental clinic», «a campaign for tyrerescue.uk»
  new RegExp(`^(?:an? |some |the )?(?:google )?${AD_WORD_EN} (?:for|to promote|to advertise|about)\\b`, 'u'),
  // «Advertise my removals company», «promote my shop on Google»
  /^(?:please |can you |could you |help me )?(?:advertise|promote|market) (?:my|our|the|a|an|this)\b/u,
  // «اعمل لي حملة إعلانية», «جهز حملات لمتجري», «أريد إعلانًا على جوجل لمحلي», «عندي محل …، ابنِ لي حملة»
  new RegExp(`(?:^| |،|,)(?:من فضلك |لو سمحت |ممكن |هل يمكنك |هل تستطيع |ارجو |و)?${MAKE_AR}(?: لي| لنا)?(?: ان (?:تعمل|تسوي|تجهز|تنشئ))?(?: \\S+){0,4}? (?:ال)?${AD_WORD_AR}(?= |$)`, 'u'),
  // «حملة إعلانية لمطعمي», «إعلانات جوجل لعيادتي»
  new RegExp(`^${AD_WORD_AR}(?: (?:اعلانيه|جوجل|google|google ads|ممول|ممولة|مدفوعه))? (?:ل|لـ)`, 'u'),
  // «أعلن عن متجري», «روّج لمحلي»
  /^(?:من فضلك |لو سمحت |ممكن )?(?:اعلن|اعلني|روج|روجي|سوق) (?:عن|ل)/u,
];

/** The owner's business, a wish for more of its customers, and a budget per period: a campaign brief without the word «ads». */
const BUSINESS_EN = /\b(?:i|we) (?:run|own|have|manage|operate|opened)\b[^.?!]{0,40}\b(?:business|company|shop|store|salon|barbershop|barber|restaurant|cafe|clinic|practice|firm|agency|garage|bakery|studio|gym|hotel|service|services|plumbing|removals|locksmith)\b|\b(?:my|our)\b[^.?!]{0,30}\b(?:business|company|shop|store|salon|barbershop|restaurant|cafe|clinic|practice|firm|agency|garage|bakery|studio|gym|hotel|services?)\b/u;
const BUSINESS_AR = /(?:^| )(?:عندي|لدي|عندنا|لدينا|املك|نملك|افتتحت|فتحت)(?: \S+){0,2} (?:محل|متجر|شركه|مطعم|صالون|عياده|مكتب|ورشه|مخبز|نادي|فندق|مشروع|مقهي|كافيه)(?= |$)|(?:^| )(?:محلي|متجري|شركتي|مطعمي|صالوني|عيادتي|مكتبي|ورشتي|مخبزي|مشروعي|نشاطي)(?= |$)/u;
const MORE_CUSTOMERS_EN = /\b(?:more|new|extra|increase|grow|boost|attract|bring in|get)\b[^.?!]{0,25}\b(?:customers|clients|bookings|calls|leads|sales|orders|visitors|traffic|footfall|enquiries|inquiries|patients|appointments|sign ?ups|diners|guests)\b/u;
const MORE_CUSTOMERS_AR = /(?:زبائن|زباين|عملاء|حجوزات|مكالمات|مبيعات|طلبات|زوار|مرضي|مواعيد|اتصالات)(?: \S+)? (?:اكثر|اكتر|اضافيه|جدد|زياده)|(?:زياده|ازيد|اكثر|المزيد من) (?:ال)?(?:زبائن|زباين|عملاء|حجوزات|مبيعات|طلبات|زوار|مكالمات)/u;
const BUDGET = /(?:£|\$|€)\s?\d+|\b\d+(?:[.,]\d+)?\s?(?:pounds?|quid|dollars?|euros?|gbp|usd|eur|k)\b|\bbudget\b|\d+\s?(?:جنيه|ريال|درهم|دينار|دولار|يورو|باوند|استرليني)|ميزانيه/u;
const PERIOD = /\b(?:a|per|each|every|\/)\s?(?:day|week|month)\b|\b(?:daily|weekly|monthly)\b|(?:يوميا|يومي|في اليوم|باليوم|اسبوعيا|اسبوعي|في الاسبوع|شهريا|شهري|في الشهر|بالشهر)/u;

export function isCampaignRequest(request: string): boolean {
  if (typeof request !== 'string' || !request.trim() || request.length > 2000) return false;
  if (parseCampaignPlanRequest(request)) return true;
  const text = matchText(request.normalize('NFKC')).replace(/[«»"“”'’‘`]/gu, '').replace(/[!?؟]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  const asking = LEARNING.test(text) || QUESTION_START.test(text) && !/^(?:can|could|would|will) you\b|^هل (?:يمكنك|تستطيع|ممكن)(?= |$)/u.test(text);
  if (!asking && EXPLICIT.some(pattern => pattern.test(text))) return true;
  const business = BUSINESS_EN.test(text) || BUSINESS_AR.test(text);
  const more = MORE_CUSTOMERS_EN.test(text) || MORE_CUSTOMERS_AR.test(text);
  return business && more && BUDGET.test(text) && PERIOD.test(text);
}
