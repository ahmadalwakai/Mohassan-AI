import { foldText } from './stems.ts';

export const AD_GUIDANCE_SLUGS = ['google-ads-campaign', 'copywriting'] as const;

const AD_SUBJECT = String.raw`(?:google ads|adwords|adverts?|advertisements?|ad campaigns?|search campaigns?|paid search|ppc|ad copy|ad groups?|ads?(?!\s+block(?:er|ing)s?\b))`;
const AD_TASK = new RegExp(String.raw`\b(?:write|draft|create|make|build|prepare|set\s*up|start|run|launch|plan|review|optimi[sz]e|manage)\b[^.!?]{0,60}\b${AD_SUBJECT}\b|\b(?:need|want)\s+(?:(?:an?|some|new)\s+){0,2}${AD_SUBJECT}\b|^\s*${AD_SUBJECT}\s+for\b`, 'u');
const ADVERTISE = /\badvertise\s+(?:my|our)\b/u;
const CAMPAIGN_BRIEF = /\b(?:create|make|build|set\s*up|launch|run|plan|need|want)\s+(?:me\s+)?(?:an?\s+)?campaign\s+for\s+(?:my\b|our\b|https?:\/\/|[\w.-]+\.[a-z]{2,}\b)/u;
const OTHER_CAMPAIGN = /\b(?:facebook|instagram|meta|tiktok|linkedin|bing|microsoft|youtube|snapchat|pinterest)\s+(?:ads?|campaigns?)\b|\bon\s+(?:facebook|instagram|tiktok|linkedin|bing|youtube|snapchat|pinterest)\b|\b(?:email|political|fundraising|awareness|election|vaccination)\s+campaign\b/u;
const GOOGLE_ADS = /\b(?:google ads|adwords)\b/u;
const BUSINESS = /\b(?:(?:i|we)\s+(?:run|own|have|operate|manage)\s+(?:(?:an?|the)\s+)?|(?:my|our)\s+)(?:[a-z]+\s+){0,2}(?:business|company|shop|store|clinic|practice|firm|agency|restaurant|services?|studio|salon|barbershop|garage|bakery|gym|hotel)\b/u;
const CUSTOMER_GOAL = /\b(?:more|new|increase|attract|bring in|get)\b[^.!?]{0,28}\b(?:customers|clients|bookings|calls|leads|sales|enquiries|inquiries|appointments)\b/u;
const PERIOD_BUDGET = /(?:[£$€]\s*\d|\b\d+(?:[.,]\d+)?\s*(?:pounds?|quid|dollars?|euros?|gbp|usd|eur)\b|\bbudget\b)[^.!?]{0,32}\b(?:(?:a|per|each|every)\s+(?:day|week|month)|daily|weekly|monthly)\b|\b(?:daily|weekly|monthly)\s+budget\b/u;

/** English ad briefs can describe the work without sharing any terms with the available skill's metadata. */
export function wantsAdGuidance(goal: string): boolean {
  const text = foldText(goal.slice(0, 16000)).replace(/[_‐‑-]+/gu, ' ').replace(/\s+/gu, ' ');
  if (OTHER_CAMPAIGN.test(text) && !GOOGLE_ADS.test(text)) return false;
  return AD_TASK.test(text) || ADVERTISE.test(text) || CAMPAIGN_BRIEF.test(text)
    || BUSINESS.test(text) && (/\bpromote\s+(?:my|our)\b/u.test(text) || CUSTOMER_GOAL.test(text) && PERIOD_BUDGET.test(text));
}
