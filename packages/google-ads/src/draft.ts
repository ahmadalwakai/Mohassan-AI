import type { GoogleAdsBrief } from '@mohassan/contracts';
import type { MutateOperation } from './client.ts';
import { canonicalJson, sha256 } from './crypto.ts';
import { parseKeyword } from './quality.ts';

/**
 * CampaignDraftBuilder. Turns a brief into the exact operations Google would run.
 * It only creates. The campaign starts PAUSED, so publishing spends nothing, and
 * language criteria are left out because Google rejects them on Search since 2026-09.
 */
export type Bidding = 'MANUAL_CPC' | 'MAXIMIZE_CLICKS' | 'MAXIMIZE_CONVERSIONS';

const BIDDING_FIELDS: Record<Bidding, Record<string, object>> = { MANUAL_CPC: { manualCpc: {} }, MAXIMIZE_CLICKS: { targetSpend: {} }, MAXIMIZE_CONVERSIONS: { maximizeConversions: {} } };

export const budgetToMicros = (value: string): string => {
  const [whole = '0', fraction = ''] = value.split('.');
  return (BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'))).toString();
};

/** The suffix is the idempotency marker: Google refuses a second campaign with the same name. */
export const campaignNameFor = (brief: GoogleAdsBrief, draftId: string) => `${brief.service} | ${brief.locations[0]} [m-${draftId.slice(0, 8)}]`;

export interface GeoTarget { name: string; resourceName: string; countryCode: string }

export function buildOperations(brief: GoogleAdsBrief, draftId: string, customerId: string, geoTargets: readonly GeoTarget[], bidding: Bidding): MutateOperation[] {
  const name = campaignNameFor(brief, draftId);
  const budget = `customers/${customerId}/campaignBudgets/-1`, campaign = `customers/${customerId}/campaigns/-2`, adGroup = `customers/${customerId}/adGroups/-3`;
  const finalUrls = [brief.landingPageUrl];
  const [path1, path2] = brief.paths;
  return [
    { campaignBudgetOperation: { create: { resourceName: budget, name: `${name} budget`, amountMicros: budgetToMicros(brief.dailyBudget), deliveryMethod: 'STANDARD', explicitlyShared: false } } },
    { campaignOperation: { create: {
      resourceName: campaign, name, status: 'PAUSED', advertisingChannelType: 'SEARCH', campaignBudget: budget,
      networkSettings: { targetGoogleSearch: true, targetSearchNetwork: false, targetContentNetwork: false, targetPartnerSearchNetwork: false },
      geoTargetTypeSetting: { positiveGeoTargetType: 'PRESENCE', negativeGeoTargetType: 'PRESENCE' },
      containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
      ...BIDDING_FIELDS[bidding],
    } } },
    ...geoTargets.map(target => ({ campaignCriterionOperation: { create: { campaign, location: { geoTargetConstant: target.resourceName } } } })),
    ...brief.negativeKeywords.map(parseKeyword).map(keyword => ({ campaignCriterionOperation: { create: { campaign, negative: true, keyword } } })),
    { adGroupOperation: { create: { resourceName: adGroup, campaign, name: brief.service, status: 'ENABLED', type: 'SEARCH_STANDARD' } } },
    ...brief.keywords.map(parseKeyword).map(keyword => ({ adGroupCriterionOperation: { create: { adGroup, status: 'ENABLED', keyword } } })),
    { adGroupAdOperation: { create: { adGroup, status: 'ENABLED', ad: { finalUrls, responsiveSearchAd: {
      headlines: brief.headlines.map(text => ({ text })), descriptions: brief.descriptions.map(text => ({ text })),
      ...(path1 ? { path1 } : {}), ...(path2 ? { path2 } : {}),
    } } } } },
  ];
}

export const operationsHash = (customerId: string, operations: readonly MutateOperation[]) => sha256(canonicalJson({ customerId, operations }));
