import type { GoogleAdsBrief, GoogleAdsMarket, GoogleAdsRecommendation, GoogleAdsReport, GoogleAdsStrategy } from '@mohassan/contracts';
import type { CallContext, GoogleAdsClient, Row } from './client.ts';
import type { Bidding } from './draft.ts';
import { GoogleAdsError } from './errors.ts';

/** MarketIntelligenceEngine, CampaignStrategyEngine and PerformanceOptimizationEngine: deterministic, and each output names its basis. */

const numberOrNull = (value: unknown) => value === undefined || value === null ? null : Number(value);
const micros = (value: unknown) => /^\d{1,18}$/.test(String(value ?? '')) ? String(value) : null;

export const searchTermsQuery = (start: string, end: string) => `SELECT search_term_view.search_term, campaign.id, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM search_term_view WHERE segments.date BETWEEN '${start}' AND '${end}' ORDER BY metrics.cost_micros DESC LIMIT 200`;

export const readSearchTerms = (rows: readonly Row[]): GoogleAdsMarket['searchTerms']['items'] => rows.map(row => ({
  term: String(row.searchTermView?.searchTerm ?? ''), campaignId: String(row.campaign?.id ?? ''), impressions: Number(row.metrics?.impressions ?? 0),
  clicks: Number(row.metrics?.clicks ?? 0), costMicros: micros(row.metrics?.costMicros) ?? '0', conversions: Number(row.metrics?.conversions ?? 0),
}));

export async function marketIntelligence(client: Pick<GoogleAdsClient, 'search' | 'generateKeywordIdeas'>, context: CallContext & { customerId: string }, input: { seeds: string[]; geoResourceNames: string[]; range: { start: string; end: string } }): Promise<GoogleAdsMarket> {
  const terms = await client.search(searchTermsQuery(input.range.start, input.range.end), context);
  const searchTerms: GoogleAdsMarket['searchTerms'] = { basis: 'observed', source: 'Google Ads search terms report', items: readSearchTerms(terms) };
  const source = 'Google Ads Keyword Planner';
  try {
    const rows = await client.generateKeywordIdeas({ keywordSeed: { keywords: input.seeds }, geoTargetConstants: input.geoResourceNames, keywordPlanNetwork: 'GOOGLE_SEARCH', includeAdultKeywords: false }, context);
    const items = rows.slice(0, 100).map(row => ({
      text: String(row.text ?? ''), avgMonthlySearches: numberOrNull(row.keywordIdeaMetrics?.avgMonthlySearches), competition: row.keywordIdeaMetrics?.competition ?? null,
      lowTopOfPageBidMicros: micros(row.keywordIdeaMetrics?.lowTopOfPageBidMicros), highTopOfPageBidMicros: micros(row.keywordIdeaMetrics?.highTopOfPageBidMicros),
    }));
    return { fetchedAt: new Date().toISOString(), keywordIdeas: { status: 'available', basis: 'estimate', source, reason: null, items }, searchTerms };
  } catch (error) {
    // Explorer access restricts keyword planning. The observed half of the answer still stands.
    if (error instanceof GoogleAdsError && ['GOOGLE_ADS_UNAUTHORIZED', 'GOOGLE_ADS_RATE_LIMITED', 'GOOGLE_ADS_DAILY_QUOTA'].includes(error.code)) throw error;
    return { fetchedAt: new Date().toISOString(), keywordIdeas: { status: 'unavailable', basis: 'estimate', source, reason: error instanceof GoogleAdsError ? error.message : 'تعذرت قراءة تقديرات الكلمات.', items: [] }, searchTerms };
  }
}

/** Google's guidance for conversion bidding wants steady volume; 15 in 30 days is this product's own threshold, and it says so. */
const CONVERSIONS_FOR_SMART_BIDDING = 15;

export function chooseBidding(report: GoogleAdsReport | null): Bidding {
  return report && report.totals.conversions >= CONVERSIONS_FOR_SMART_BIDDING ? 'MAXIMIZE_CONVERSIONS' : 'MANUAL_CPC';
}

export function campaignStrategy(brief: GoogleAdsBrief, report: GoogleAdsReport | null, market: GoogleAdsMarket | null, currency: string): GoogleAdsStrategy {
  const recommendations: GoogleAdsStrategy['recommendations'] = [], blockers: string[] = [];
  const add = (title: string, reason: string, basis: GoogleAdsStrategy['recommendations'][number]['basis'], source: string) => recommendations.push({ title, reason, basis, source });
  add('حملة بحث واحدة ومجموعة إعلانية واحدة لهذه الخدمة', 'الكلمات والإعلان وصفحة الهبوط كلها عن خدمة واحدة.', 'assumption', 'قاعدة بناء الحملات في هذه المهارة');
  add('استهداف الموجودين فعلًا في الموقع', 'الخدمة المحلية لا تستفيد ممن يهتم بالمكان من خارجه.', 'assumption', 'إعداد Presence في Google Ads');
  add('لا يُضبط استهداف لغة', 'أوقفت Google استهداف اللغة اليدوي لحملات البحث في سبتمبر 2026؛ لغة الإعلان وصفحة الهبوط هي ما يُفحص.', 'observed', 'developers.google.com/google-ads/api/docs/deprecations');
  if (!report) blockers.push('لا يوجد تقرير حديث للحساب، فالاقتراحات لا تستند إلى بياناته.');
  else {
    const bidding = chooseBidding(report);
    add(bidding === 'MAXIMIZE_CONVERSIONS' ? 'تعظيم التحويلات' : 'تكلفة نقرة يدوية للبداية', `سجل الحساب ${report.totals.conversions} تحويلًا في ${report.range.days} يومًا؛ الحد المعتمد هنا ${CONVERSIONS_FOR_SMART_BIDDING} تحويلًا.`, 'observed', `تقرير الحساب ${report.range.start} إلى ${report.range.end}`);
    if (!report.conversionActions.some(action => action.status === 'ENABLED' && action.includedInConversions)) blockers.push('لا يوجد إجراء تحويل مفعّل يُحتسب، فلا يصلح إطلاق الحملة.');
  }
  const bids = market?.keywordIdeas.items.map(item => Number(item.highTopOfPageBidMicros ?? 0)).filter(value => value > 0) ?? [];
  if (bids.length) {
    const typical = [...bids].sort((a, b) => a - b)[Math.floor(bids.length / 2)]!;
    const clicks = Math.floor(Number(brief.dailyBudget) * 1_000_000 / typical);
    add(`الميزانية تعادل نحو ${clicks} نقرة يوميًا عند الوسيط`, `وسيط أعلى عرض لأعلى الصفحة ${(typical / 1_000_000).toFixed(2)} ${currency}. تقدير من Keyword Planner، وليس وعدًا.`, 'estimate', 'Google Ads Keyword Planner');
  } else add('لا توقع للنقرات أو التكلفة', 'لا توجد تقديرات من Keyword Planner لهذه الكلمات، ولن نخمّن رقمًا.', 'observed', 'Google Ads Keyword Planner');
  return { recommendations, blockers };
}

const SAMPLE_CLICKS = 10;
const BUDGET_LOST = 0.2;

export function optimize(report: GoogleAdsReport, market: Pick<GoogleAdsMarket, 'searchTerms'> | null): GoogleAdsRecommendation[] {
  const items: GoogleAdsRecommendation[] = [];
  const add = (item: Omit<GoogleAdsRecommendation, 'requiresApproval'>) => items.push({ ...item, requiresApproval: true });
  const tracked = report.conversionActions.some(action => action.status === 'ENABLED' && action.includedInConversions && action.recordedConversions > 0);
  if (!tracked) {
    add({ id: 'fix-tracking', type: 'fix_conversion_tracking', title: 'أصلح تتبع التحويلات أولًا', reason: 'لم يُسجَّل أي تحويل في هذه الفترة، فأي تغيير في الإنفاق سيكون بلا دليل.', basis: 'observed', campaignId: null, observed: { actions: report.conversionActions.length } });
    return items;
  }
  for (const mismatch of report.mismatches) add({ id: `mismatch-${mismatch.campaignId}-${mismatch.kind}`, type: 'review_mismatch', title: `راجع «${mismatch.campaignName}»`, reason: mismatch.message, basis: mismatch.basis, campaignId: mismatch.campaignId, observed: { kind: mismatch.kind } });
  for (const term of market?.searchTerms.items ?? []) if (term.clicks >= SAMPLE_CLICKS && term.conversions === 0) add({ id: `negative-${term.campaignId}-${term.term}`, type: 'add_negative_keyword', title: `فكر في استبعاد «${term.term}»`, reason: `${term.clicks} نقرة بلا تحويل في الفترة نفسها.`, basis: 'observed', campaignId: term.campaignId, observed: { clicks: term.clicks, costMicros: term.costMicros, conversions: term.conversions } });
  for (const campaign of report.campaigns.filter(item => item.status === 'ENABLED')) {
    if (campaign.impressions === 0) add({ id: `idle-${campaign.id}`, type: 'review_no_impressions', title: `«${campaign.name}» بلا ظهور`, reason: 'الحملة مفعلة ولم تسجل أي ظهور في الفترة.', basis: 'observed', campaignId: campaign.id, observed: { impressions: 0 } });
    else if ((campaign.budgetLostImpressionShare ?? 0) >= BUDGET_LOST && campaign.conversions > 0) add({ id: `budget-${campaign.id}`, type: 'review_budget', title: `الميزانية تحد «${campaign.name}»`, reason: 'تفقد الحملة ظهورًا بسبب الميزانية وهي تحقق تحويلات. لا يوجد توقع لأثر الزيادة.', basis: 'observed', campaignId: campaign.id, observed: { budgetLost: campaign.budgetLostImpressionShare ?? 0, conversions: campaign.conversions } });
    else if ((campaign.rankLostImpressionShare ?? 0) >= 0.4) add({ id: `rank-${campaign.id}`, type: 'review_ad_rank', title: `ترتيب إعلان «${campaign.name}» ضعيف`, reason: 'تفقد الحملة كثيرًا من الظهور بسبب ترتيب الإعلان، فراجع النص وصفحة الهبوط قبل رفع العروض.', basis: 'observed', campaignId: campaign.id, observed: { rankLost: campaign.rankLostImpressionShare ?? 0 } });
  }
  if (!items.length) add({ id: 'more-data', type: 'collect_more_data', title: 'لا تغيير مقترح الآن', reason: `لا يوجد ما يتجاوز حد العينة (${SAMPLE_CLICKS} نقرات).`, basis: 'observed', campaignId: null, observed: { clicks: report.totals.clicks } });
  return items;
}
