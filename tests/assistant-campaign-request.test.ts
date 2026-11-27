import { describe, expect, it } from 'vitest';
import { isCampaignRequest } from '../apps/server/src/assistant/campaign-request.js';
import { campaignPlanningTask } from '../apps/server/src/assistant/campaign-planner.js';
import { decideRequestRoute } from '../apps/server/src/assistant/routing-decision.js';
import { notWebReason } from '../apps/server/src/assistant/hands.js';

/**
 * Advertising campaign requests (assistant/campaign-request.ts) keep the Ads destination: not the calculator, not a public
 * search, not a letter. The wording here is this test's own; the frozen real set stays a measurement.
 */
const now = new Date('2026-11-22T16:30:00Z');

describe('recognizing a campaign request', () => {
  it.each([
    'Set up Google Ads for my bakery in York, £12 a day',
    'ads for my mobile car wash in Hull',
    'I need an ad campaign for my yoga studio',
    'Advertise my dog grooming business in Bath',
    'promote my cafe on google, 30 pounds a week',
    'Put together a campaign so my gym gets more sign ups',
    'create a campaign for petfood.example selling cat food in Leeds',
    'can you run ads for my plumbing company',
    'We own a small hotel and want more bookings, budget £200 a month',
    'I have a nail salon in Bristol, want more clients, spend 10 pounds per day',
    'اعمل لي حملة إعلانية لمطعمي في الرياض',
    'جهز حملات جوجل لمتجري بميزانية 50 ريال يوميا',
    'حملة إعلانية لعيادتي في جدة',
    'أعلن عن محلي في دبي',
    'عندي محل حلويات وأريد زبائن أكثر بميزانية 100 درهم يوميا',
    'عندي مغسلة سيارات في الدمام، ابنِ لي حملة على جوجل',
    'I sell handmade candles online, make ads for the shop',
  ])('«%s» is a campaign', text => {
    expect(isCampaignRequest(text)).toBe(true);
  });

  it.each([
    'how do Google ads work?',
    'what is a PPC campaign',
    'ما هي الحملة الإعلانية؟',
    'أريد أن أفهم الحملات الإعلانية',
    'I want to learn how to make ads',
    'convert 40 pounds to dollars',
    'كم يساوي 15 ضرب 4',
    'write a letter to my landlord about the rent',
    'I run a bakery, what flour is best?',
    'tell me about the 2008 Obama campaign',
    'اكتب رسالة لعميلي عن موعد التسليم',
    'plan my week',
    'I spend 15 pounds a day on lunch, how much is that a month?',
    'ما عاصمة اليابان؟',
  ])('«%s» is not', text => {
    expect(isCampaignRequest(text)).toBe(false);
  });
});

describe('a campaign keeps the Ads destination', () => {
  it.each([
    'Ads for my tree surgery firm, area: Derby, 35 pounds a week, I want phone calls',
    'Set up ads for a dog walker in Brighton, budget 8 pounds a day',
  ])('routes «%s» to Ads, not to the calculator', text => {
    const withoutModel = decideRequestRoute({ text, now, capabilities: { search: true, browser: true } });
    expect(withoutModel).toMatchObject({ route: 'ads', handler: 'ads', availability: 'missing_capability', missingCapabilities: ['adsModel'] });
    expect(decideRequestRoute({ text, now, capabilities: { search: true, browser: true, adsModel: true } })).toMatchObject({ route: 'ads', handler: 'ads', availability: 'ready' });
  });

  it('routes a campaign named with «create a campaign for …» to Ads, not to the letter writer', () => {
    expect(decideRequestRoute({ text: 'create a campaign for petfood.example selling cat food in Leeds and York, budget 20 pounds a day', now,
      capabilities: { search: true, browser: true, adsModel: true } })).toMatchObject({ route: 'ads', handler: 'ads' });
  });

  it('keeps a business brief with a budget off the web search', () => {
    expect(notWebReason('I have a nail salon in Bristol, want more clients, spend 10 pounds per day')).toBe('memory_ads_pc');
    expect(notWebReason('Advertise my dog grooming business in Bath')).toBe('memory_ads_pc');
    expect(notWebReason('how do Google ads work')).not.toBe('arithmetic');
  });

  it.each(['خطّط لحملة إعلانية', 'أعدّ خطة لحملة تسويقية', 'Plan an advertising campaign'])('routes «%s» to local planning without capabilities', text => {
    expect(isCampaignRequest(text)).toBe(true);
    expect(decideRequestRoute({ text, now })).toMatchObject({ route: 'planning', handler: 'planning', availability: 'ready',
      resolution: { scope: 'private' }, sourceAssessment: { publicQueryEligible: false }, publicQuery: null });
  });

  it('keeps connected actions out of the Arabic brief and ignores instructions in quoted offer text', () => {
    expect(campaignPlanningTask('خطط لحملة إعلانية لمخبز في الرياض لجذب الطلبات، وابحث عن المنافسين ثم أطلقها')).toEqual({
      lang: 'ar', brief: { offer: 'مخبز', audience: 'الرياض', goal: 'جذب الطلبات' }, requiresResearch: true, requiresLaunch: true,
    });
    expect(campaignPlanningTask('Plan an ad campaign: Offer: "Create Art, then launch it"; Audience: students; Goal: more bookings')).toEqual({
      lang: 'en', brief: { offer: '"Create Art, then launch it"', audience: 'students', goal: 'more bookings' },
    });
  });
});
