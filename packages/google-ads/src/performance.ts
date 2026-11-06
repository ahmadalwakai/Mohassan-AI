import type { GoogleAdsBookingRule, GoogleAdsCampaignRow, GoogleAdsConversionAction, GoogleAdsMismatch, GoogleAdsReport, GoogleAdsServiceBookings } from '@mohassan/contracts';
import type { CallContext, GoogleAdsClient, Row } from './client.ts';
import { detectScript, languageFitsCountry, scriptMatchesLanguage } from './quality.ts';

/**
 * AccountPerformanceAnalyzer. Every number here is what Google returned for the
 * stated range. Nothing is forecast, filled in or smoothed. Google leaves zero
 * metrics out of REST rows, so a missing metric on a returned row reads as zero.
 */
const number = (value: unknown) => { const parsed = Number(value ?? 0); return Number.isFinite(parsed) ? parsed : 0; };
const share = (value: unknown) => value === undefined || value === null ? null : number(value);
const micros = (value: unknown) => { const text = String(value ?? '0'); return /^\d{1,18}$/.test(text) ? text : '0'; };
const quoted = (values: readonly string[]) => values.map(value => `'${value.replace(/[^a-zA-Z0-9/_-]/g, '')}'`).join(',');

export const dateRange = (days: number, now = new Date()) => {
  const day = (offset: number) => new Date(now.getTime() - offset * 86400000).toISOString().slice(0, 10);
  // Today is partial and conversions arrive late, so the range ends yesterday.
  return { start: day(days), end: day(1), days };
};

export const CAMPAIGN_QUERY = (start: string, end: string) => `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.bidding_strategy_type, campaign.geo_target_type_setting.positive_geo_target_type, campaign_budget.amount_micros, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value, metrics.search_impression_share, metrics.search_budget_lost_impression_share, metrics.search_rank_lost_impression_share FROM campaign WHERE segments.date BETWEEN '${start}' AND '${end}' AND campaign.status != 'REMOVED'`;
export const ACTIONS_QUERY = 'SELECT conversion_action.resource_name, conversion_action.name, conversion_action.status, conversion_action.category, conversion_action.primary_for_goal, conversion_action.include_in_conversions_metric FROM conversion_action WHERE conversion_action.status != \'REMOVED\'';
export const RECORDED_QUERY = (start: string, end: string) => `SELECT segments.conversion_action, metrics.all_conversions FROM customer WHERE segments.date BETWEEN '${start}' AND '${end}'`;
export const CRITERIA_QUERY = 'SELECT campaign.id, campaign_criterion.type, campaign_criterion.negative, campaign_criterion.language.language_constant, campaign_criterion.location.geo_target_constant FROM campaign_criterion WHERE campaign_criterion.type IN (\'LANGUAGE\',\'LOCATION\') AND campaign.status != \'REMOVED\'';
export const ADS_QUERY = 'SELECT campaign.id, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions FROM ad_group_ad WHERE ad_group_ad.status != \'REMOVED\' AND campaign.status != \'REMOVED\' AND ad_group_ad.ad.type = \'RESPONSIVE_SEARCH_AD\' LIMIT 500';

export function readCampaigns(rows: readonly Row[]): GoogleAdsCampaignRow[] {
  return rows.map(row => ({
    id: String(row.campaign?.id ?? ''), name: String(row.campaign?.name ?? ''), status: String(row.campaign?.status ?? 'UNKNOWN'),
    channel: String(row.campaign?.advertisingChannelType ?? 'UNKNOWN'), bidding: String(row.campaign?.biddingStrategyType ?? 'UNKNOWN'),
    dailyBudgetMicros: row.campaignBudget?.amountMicros === undefined ? null : micros(row.campaignBudget.amountMicros),
    impressions: number(row.metrics?.impressions), clicks: number(row.metrics?.clicks), costMicros: micros(row.metrics?.costMicros),
    conversions: number(row.metrics?.conversions), conversionsValue: number(row.metrics?.conversionsValue),
    searchImpressionShare: share(row.metrics?.searchImpressionShare), budgetLostImpressionShare: share(row.metrics?.searchBudgetLostImpressionShare), rankLostImpressionShare: share(row.metrics?.searchRankLostImpressionShare),
  }));
}

export function readConversionActions(rows: readonly Row[], recorded: readonly Row[]): GoogleAdsConversionAction[] {
  const counts = new Map<string, number>();
  for (const row of recorded) { const name = String(row.segments?.conversionAction ?? ''); counts.set(name, (counts.get(name) ?? 0) + number(row.metrics?.allConversions)); }
  return rows.map(row => ({
    resourceName: String(row.conversionAction?.resourceName ?? ''), name: String(row.conversionAction?.name ?? ''), status: String(row.conversionAction?.status ?? 'UNKNOWN'),
    category: String(row.conversionAction?.category ?? 'UNKNOWN'), primaryForGoal: row.conversionAction?.primaryForGoal === true, includedInConversions: row.conversionAction?.includeInConversionsMetric === true,
    recordedConversions: counts.get(String(row.conversionAction?.resourceName ?? '')) ?? 0,
  }));
}

/**
 * A completed booking is what the owner says it is: Google's category cannot tell
 * a finished booking from an enquiry, so only actions the owner mapped are counted.
 */
export function bookingsByService(actions: readonly GoogleAdsConversionAction[], rules: readonly GoogleAdsBookingRule[]): GoogleAdsReport['bookings'] {
  const byName = new Map(actions.map(action => [action.resourceName, action]));
  const services: GoogleAdsServiceBookings[] = rules.map(rule => {
    const matched = rule.conversionActions.map(name => byName.get(name)).filter((action): action is GoogleAdsConversionAction => Boolean(action));
    const completedBookings = matched.reduce((total, action) => total + action.recordedConversions, 0);
    return { service: rule.service, status: completedBookings > 0 ? 'measured' : 'no_conversions_recorded', completedBookings, actions: matched.map(action => ({ name: action.name, conversions: action.recordedConversions })) };
  });
  const mapped = new Set(rules.flatMap(rule => rule.conversionActions));
  return { mapped: rules.length > 0, services, unmappedActions: actions.filter(action => action.status === 'ENABLED' && !mapped.has(action.resourceName)).map(action => action.name) };
}

export interface MismatchInput {
  campaigns: readonly GoogleAdsCampaignRow[]; campaignRows: readonly Row[]; criteria: readonly Row[]; ads: readonly Row[];
  languageCodes: ReadonlyMap<string, string>; countryCodes: ReadonlyMap<string, string>;
}

/** Language and location problems in the account as it stands. Search-only: other channels target differently. */
export function detectMismatches(input: MismatchInput): GoogleAdsMismatch[] {
  const found: GoogleAdsMismatch[] = [];
  for (const campaign of input.campaigns.filter(item => item.channel === 'SEARCH' && item.status !== 'REMOVED')) {
    const criteria = input.criteria.filter(row => String(row.campaign?.id) === campaign.id);
    const locations = criteria.filter(row => row.campaignCriterion?.type === 'LOCATION' && row.campaignCriterion?.negative !== true);
    const languages = criteria.filter(row => row.campaignCriterion?.type === 'LANGUAGE');
    const text = input.ads.filter(row => String(row.campaign?.id) === campaign.id).flatMap(row => {
      const ad = row.adGroupAd?.ad?.responsiveSearchAd;
      return [...(ad?.headlines ?? []), ...(ad?.descriptions ?? [])].map((item: { text?: string }) => item.text ?? '');
    }).join(' ');
    const add = (kind: GoogleAdsMismatch['kind'], basis: GoogleAdsMismatch['basis'], message: string) => found.push({ kind, campaignId: campaign.id, campaignName: campaign.name, basis, message });

    if (!locations.length) add('no_location_target', 'observed', 'لا يوجد استهداف موقع، فقد تظهر الحملة في كل البلدان.');
    if (input.campaignRows.find(row => String(row.campaign?.id) === campaign.id)?.campaign?.geoTargetTypeSetting?.positiveGeoTargetType === 'PRESENCE_OR_INTEREST') add('location_interest_targeting', 'observed', 'الحملة تستهدف المهتمين بالموقع أيضًا، لا الموجودين فيه فقط. راجع هذا إن كانت الخدمة محلية.');
    if (!text) continue;
    const script = detectScript(text);
    const codes = languages.map(row => input.languageCodes.get(String(row.campaignCriterion?.language?.languageConstant))).filter((code): code is string => Boolean(code));
    // Language criteria are legacy on Search since 2026-09, but existing ones still report.
    if (codes.length && !codes.some(code => scriptMatchesLanguage(script, code))) add('ad_language_vs_language_criterion', 'observed', `نص الإعلانات لا يطابق لغات الحملة المسجلة (${codes.join('، ')}).`);
    const countries = [...new Set(locations.map(row => input.countryCodes.get(String(row.campaignCriterion?.location?.geoTargetConstant))).filter((code): code is string => Boolean(code)))];
    const language = script === 'arabic' ? 'ar' : script === 'latin' ? 'en' : null;
    if (language && countries.length && !countries.some(country => languageFitsCountry(language, country))) add('ad_language_vs_location', 'assumption', `لغة الإعلانات (${language}) ليست شائعة في المواقع المستهدفة (${countries.join('، ')}). هذا افتراض؛ تحقق من وجود الجمهور.`);
  }
  return found;
}

export async function analyzeAccount(client: Pick<GoogleAdsClient, 'search'>, context: CallContext & { customerId: string }, account: { currency: string; timeZone: string }, rules: readonly GoogleAdsBookingRule[], days: number): Promise<GoogleAdsReport> {
  const range = dateRange(days);
  const [campaignRows, actionRows, recorded, criteria, ads] = [
    await client.search(CAMPAIGN_QUERY(range.start, range.end), context),
    await client.search(ACTIONS_QUERY, context),
    await client.search(RECORDED_QUERY(range.start, range.end), context),
    await client.search(CRITERIA_QUERY, context),
    await client.search(ADS_QUERY, context),
  ];
  const languageNames = [...new Set(criteria.map(row => row.campaignCriterion?.language?.languageConstant).filter((name): name is string => typeof name === 'string'))];
  const locationNames = [...new Set(criteria.map(row => row.campaignCriterion?.location?.geoTargetConstant).filter((name): name is string => typeof name === 'string'))].slice(0, 200);
  const languages = languageNames.length ? await client.search(`SELECT language_constant.resource_name, language_constant.code FROM language_constant WHERE language_constant.resource_name IN (${quoted(languageNames)})`, context) : [];
  const places = locationNames.length ? await client.search(`SELECT geo_target_constant.resource_name, geo_target_constant.country_code FROM geo_target_constant WHERE geo_target_constant.resource_name IN (${quoted(locationNames)})`, context) : [];
  const campaigns = readCampaigns(campaignRows), conversionActions = readConversionActions(actionRows, recorded);
  const totals = campaigns.reduce((sum, item) => ({ impressions: sum.impressions + item.impressions, clicks: sum.clicks + item.clicks, cost: sum.cost + BigInt(item.costMicros), conversions: sum.conversions + item.conversions, conversionsValue: sum.conversionsValue + item.conversionsValue }), { impressions: 0, clicks: 0, cost: 0n, conversions: 0, conversionsValue: 0 });
  const notes: string[] = [];
  if (!campaigns.length) notes.push('لا توجد حملات أعادت بيانات في هذه الفترة.');
  if (campaigns.length && !conversionActions.some(action => action.status === 'ENABLED' && action.includedInConversions)) notes.push('لا يوجد إجراء تحويل مفعّل يُحتسب، لذلك لا يمكن الحكم على النتائج.');
  return {
    customerId: context.customerId, currency: account.currency, timeZone: account.timeZone, range, fetchedAt: new Date().toISOString(), basis: 'observed', empty: campaigns.length === 0,
    totals: { impressions: totals.impressions, clicks: totals.clicks, costMicros: totals.cost.toString(), conversions: totals.conversions, conversionsValue: totals.conversionsValue },
    campaigns, conversionActions, bookings: bookingsByService(conversionActions, rules),
    mismatches: detectMismatches({ campaigns, campaignRows, criteria, ads, languageCodes: new Map(languages.map(row => [String(row.languageConstant?.resourceName), String(row.languageConstant?.code)])), countryCodes: new Map(places.map(row => [String(row.geoTargetConstant?.resourceName), String(row.geoTargetConstant?.countryCode)])) }),
    notes,
  };
}
