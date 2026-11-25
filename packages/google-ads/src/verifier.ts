import { GoogleAdsReadbackSchema, type GoogleAdsBrief, type GoogleAdsChangeSummary, type GoogleAdsVerification, type GoogleAdsVerificationCheck } from '@mohassan/contracts';
import type { GoogleAdsClient, MutateOperation, CallContext } from './client.ts';
import { canonicalJson, sha256 } from './crypto.ts';
import { GoogleAdsError } from './errors.ts';

/**
 * IndependentCampaignVerifier. It deliberately imports nothing from the draft
 * builder or the validator: it reads the operations as Google would and asks the
 * account again, so a bug in the builder cannot approve itself.
 */
const ALLOWED = new Set(['campaignBudgetOperation', 'campaignOperation', 'campaignCriterionOperation', 'adGroupOperation', 'adGroupCriterionOperation', 'adGroupAdOperation']);
const keywordLabel = (keyword: { text: string; matchType: string }) => keyword.matchType === 'EXACT' ? `[${keyword.text}]` : keyword.matchType === 'PHRASE' ? `"${keyword.text}"` : keyword.text;

interface Read { budget?: any; campaign?: any; adGroup?: any; ad?: any; locations: string[]; keywords: any[]; negatives: any[]; problems: string[] }

function readOperations(customerId: string, operations: readonly MutateOperation[]): Read {
  const read: Read = { locations: [], keywords: [], negatives: [], problems: [] };
  for (const [index, operation] of operations.entries()) {
    const entries = Object.entries(operation);
    const [kind, body] = entries[0] as [string, any];
    if (entries.length !== 1 || !ALLOWED.has(kind)) { read.problems.push(`operation ${index + 1} has a type the publisher may not run: ${kind}`); continue; }
    if (body.update !== undefined || body.remove !== undefined || body.updateMask !== undefined) { read.problems.push(`operation ${index + 1} changes or removes an existing resource`); continue; }
    const created = body.create;
    if (!created) { read.problems.push(`operation ${index + 1} creates nothing`); continue; }
    const names = [created.resourceName, created.campaign, created.adGroup, created.campaignBudget].filter((name): name is string => typeof name === 'string');
    for (const name of names) if (!new RegExp(`^customers/${customerId}/[a-zA-Z]+/-\\d+$`).test(name)) read.problems.push(`operation ${index + 1} points at a resource outside this new campaign: ${name}`);
    if (kind === 'campaignBudgetOperation') { if (read.budget) read.problems.push('more than one budget'); read.budget = created; }
    if (kind === 'campaignOperation') { if (read.campaign) read.problems.push('more than one campaign'); read.campaign = created; }
    if (kind === 'adGroupOperation') { if (read.adGroup) read.problems.push('more than one ad group'); read.adGroup = created; }
    if (kind === 'adGroupAdOperation') { if (read.ad) read.problems.push('more than one ad'); read.ad = created; }
    if (kind === 'adGroupCriterionOperation') { if (!created.keyword) read.problems.push(`operation ${index + 1} is not a keyword`); else read.keywords.push(created.keyword); }
    if (kind === 'campaignCriterionOperation') {
      if (created.language) read.problems.push('Search campaigns no longer accept language criteria');
      else if (created.location) read.locations.push(created.location.geoTargetConstant);
      else if (created.negative === true && created.keyword) read.negatives.push(created.keyword);
      else read.problems.push(`operation ${index + 1} is an unknown campaign criterion`);
    }
  }
  return read;
}

/** The change as the operations state it. This, not the brief, is what the owner approves. */
export function summarizeOperations(customerId: string, operations: readonly MutateOperation[], locationNames: ReadonlyMap<string, string>): GoogleAdsChangeSummary | null {
  const read = readOperations(customerId, operations);
  if (!read.campaign || !read.budget || !read.ad || read.campaign.status !== 'PAUSED') return null;
  const budget = BigInt(read.budget.amountMicros);
  const bidding = read.campaign.manualCpc ? 'MANUAL_CPC' : read.campaign.targetSpend ? 'MAXIMIZE_CLICKS' : read.campaign.maximizeConversions ? 'MAXIMIZE_CONVERSIONS' : 'UNKNOWN';
  return {
    customerId, campaignName: read.campaign.name, initialStatus: 'PAUSED', dailyBudgetMicros: budget.toString(), bidding,
    locations: read.locations.map(name => locationNames.get(name) ?? name), keywords: read.keywords.map(keywordLabel), negativeKeywords: read.negatives.map(keywordLabel),
    headlines: read.ad.ad.responsiveSearchAd.headlines.map((item: { text: string }) => item.text), descriptions: read.ad.ad.responsiveSearchAd.descriptions.map((item: { text: string }) => item.text),
    finalUrl: read.ad.ad.finalUrls[0], operationCount: operations.length,
    // Google's documented limits: one day can reach twice the budget, a month 30.4 times it.
    maxDailySpendMicros: (budget * 2n).toString(), maxMonthlySpendMicros: (budget * 304n / 10n).toString(),
  };
}

const same = (first: readonly string[], second: readonly string[]) => canonicalJson([...first].sort()) === canonicalJson([...second].sort());
const toMicros = (value: string) => { const [whole = '0', fraction = ''] = value.split('.'); return BigInt(`${whole}${fraction.padEnd(6, '0')}`).toString(); };

export interface VerifyInput {
  draftId: string; customerId: string; brief: GoogleAdsBrief; operations: readonly MutateOperation[]; storedHash: string;
  geoResourceNames: readonly string[]; maxDailyBudgetMicros: bigint; context: CallContext & { customerId: string };
  /** Only a creation-only PAUSED request may defer tracking; launch always checks it again. */
  allowUnprovenConversionsForPaused?: boolean;
}

export interface PublishedFieldEvidence { field: string; expected: string | null; actual: string | null; passed: boolean }
export interface PublishedCampaignEvidence {
  checkedAt: string; customerId: string; campaignResourceName: string; passed: boolean; fields: PublishedFieldEvidence[]; resourceNames: string[]; requestId: string | null;
}

/** Read every material field from Google after a write. Validation and mutate receipts are not read-back evidence. */
export async function verifyPublishedCampaign(client: Pick<GoogleAdsClient, 'search'>, input: {
  customerId: string; campaignResourceName: string; operations: readonly MutateOperation[];
  expectedStatus: 'PAUSED' | 'ENABLED'; context: CallContext & { customerId: string };
}): Promise<PublishedCampaignEvidence> {
  const { customerId, campaignResourceName, context } = input;
  if (context.customerId !== customerId || !new RegExp(`^customers/${customerId}/campaigns/\\d+$`).test(campaignResourceName)) {
    throw new GoogleAdsError('GOOGLE_ADS_ACCOUNT_CHANGED', 'حساب التنفيذ لا يطابق الحساب المفوّض لهذه الحملة.', 409);
  }
  const intended = readOperations(customerId, input.operations);
  const fields: PublishedFieldEvidence[] = [];
  const value = (item: unknown): string | null => {
    if (item === undefined || item === null) return null;
    const text = typeof item === 'string' ? item : canonicalJson(item);
    return text.length <= 4000 ? text : `sha256:${sha256(text)} (${text.length} characters)`;
  };
  const add = (field: string, expected: unknown, actual: unknown) => fields.push({ field, expected: value(expected), actual: value(actual), passed: canonicalJson(expected ?? null) === canonicalJson(actual ?? null) });
  if (intended.problems.length || !intended.campaign || !intended.budget || !intended.adGroup || !intended.ad) {
    throw new GoogleAdsError('GOOGLE_ADS_READBACK_INTENT', 'عمليات الحملة المخزنة غير مكتملة؛ لا يمكن إثبات النتيجة.', 409);
  }
  // Resource names are validated above, rather than interpolating page or model text into GAQL.
  const where = `WHERE campaign.resource_name = '${campaignResourceName}'`;
  const campaigns = await client.search(`SELECT campaign.resource_name, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.bidding_strategy_type, campaign.contains_eu_political_advertising, campaign.campaign_budget, campaign.network_settings.target_google_search, campaign.network_settings.target_search_network, campaign.network_settings.target_content_network, campaign.network_settings.target_partner_search_network, campaign.geo_target_type_setting.positive_geo_target_type, campaign.geo_target_type_setting.negative_geo_target_type, campaign_budget.amount_micros, campaign_budget.delivery_method, campaign_budget.explicitly_shared FROM campaign ${where}`, context);
  add('campaign.count', 1, campaigns.length);
  const row = campaigns[0], campaign = row?.campaign, budget = row?.campaignBudget;
  add('campaign.resourceName', campaignResourceName, campaign?.resourceName);
  add('campaign.name', intended.campaign.name, campaign?.name);
  add('campaign.status', input.expectedStatus, campaign?.status);
  add('campaign.advertisingChannelType', intended.campaign.advertisingChannelType, campaign?.advertisingChannelType);
  add('campaign.containsEuPoliticalAdvertising', intended.campaign.containsEuPoliticalAdvertising, campaign?.containsEuPoliticalAdvertising);
  add('budget.resourceInAccount', true, typeof campaign?.campaignBudget === 'string' && new RegExp(`^customers/${customerId}/campaignBudgets/\\d+$`).test(campaign.campaignBudget));
  const bidding = intended.campaign.manualCpc ? 'MANUAL_CPC' : intended.campaign.targetSpend ? 'TARGET_SPEND' : 'MAXIMIZE_CONVERSIONS';
  add('campaign.biddingStrategyType', bidding, campaign?.biddingStrategyType);
  for (const key of ['targetGoogleSearch', 'targetSearchNetwork', 'targetContentNetwork', 'targetPartnerSearchNetwork']) add(`campaign.networkSettings.${key}`, intended.campaign.networkSettings?.[key] ?? false, campaign?.networkSettings?.[key] ?? false);
  for (const key of ['positiveGeoTargetType', 'negativeGeoTargetType']) add(`campaign.geoTargetTypeSetting.${key}`, intended.campaign.geoTargetTypeSetting?.[key], campaign?.geoTargetTypeSetting?.[key]);
  add('budget.amountMicros', String(intended.budget.amountMicros), budget?.amountMicros === undefined ? null : String(budget.amountMicros));
  add('budget.deliveryMethod', intended.budget.deliveryMethod, budget?.deliveryMethod);
  add('budget.explicitlyShared', intended.budget.explicitlyShared, budget?.explicitlyShared ?? false);
  const groups = await client.search(`SELECT ad_group.resource_name, ad_group.campaign, ad_group.name, ad_group.status, ad_group.type FROM ad_group ${where} AND ad_group.status != 'REMOVED'`, context);
  add('adGroup.count', 1, groups.length);
  const group = groups[0]?.adGroup;
  add('adGroup.resourceInAccount', true, typeof group?.resourceName === 'string' && new RegExp(`^customers/${customerId}/adGroups/\\d+$`).test(group.resourceName));
  add('adGroup.campaign', campaignResourceName, group?.campaign);
  for (const key of ['name', 'status', 'type']) add(`adGroup.${key}`, intended.adGroup[key], group?.[key]);
  const criteria = await client.search(`SELECT campaign_criterion.type, campaign_criterion.negative, campaign_criterion.location.geo_target_constant, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type FROM campaign_criterion ${where} AND campaign_criterion.status != 'REMOVED'`, context);
  const sorted = (items: unknown[]) => items.map(item => canonicalJson(item)).sort();
  add('campaign.locations', sorted(intended.locations), sorted(criteria.filter(item => item.campaignCriterion?.type === 'LOCATION').map(item => item.campaignCriterion.location?.geoTargetConstant)));
  add('campaign.negativeKeywords', sorted(intended.negatives), sorted(criteria.filter(item => item.campaignCriterion?.negative === true && item.campaignCriterion?.keyword).map(item => item.campaignCriterion.keyword)));
  add('campaign.criteria.count', intended.locations.length + intended.negatives.length, criteria.length);
  const keywords = await client.search(`SELECT ad_group_criterion.ad_group, ad_group_criterion.status, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type FROM ad_group_criterion ${where} AND ad_group_criterion.status != 'REMOVED'`, context);
  add('adGroup.keywords', sorted(intended.keywords.map(keyword => ({ adGroup: group?.resourceName, status: 'ENABLED', keyword }))), sorted(keywords.map(item => ({ adGroup: item.adGroupCriterion?.adGroup, status: item.adGroupCriterion?.status, keyword: item.adGroupCriterion?.keyword }))));
  const ads = await client.search(`SELECT ad_group_ad.ad_group, ad_group_ad.status, ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions, ad_group_ad.ad.responsive_search_ad.path1, ad_group_ad.ad.responsive_search_ad.path2 FROM ad_group_ad ${where} AND ad_group_ad.status != 'REMOVED'`, context);
  add('ad.count', 1, ads.length);
  const ad = ads[0]?.adGroupAd, rsa = ad?.ad?.responsiveSearchAd, expected = intended.ad.ad;
  add('ad.adGroup', group?.resourceName ?? null, ad?.adGroup);
  add('ad.status', intended.ad.status, ad?.status);
  add('ad.finalUrls', expected.finalUrls, ad?.ad?.finalUrls);
  for (const key of ['headlines', 'descriptions']) add(`ad.${key}`, sorted(expected.responsiveSearchAd[key].map((item: any) => item.text)), sorted((rsa?.[key] ?? []).map((item: any) => item.text)));
  for (const key of ['path1', 'path2']) add(`ad.${key}`, expected.responsiveSearchAd[key] ?? '', rsa?.[key] ?? '');
  return GoogleAdsReadbackSchema.parse({ checkedAt: new Date().toISOString(), customerId, campaignResourceName, passed: fields.every(field => field.passed), fields, resourceNames: [campaignResourceName, campaign?.campaignBudget, group?.resourceName].filter((name): name is string => typeof name === 'string'), requestId: null }) as PublishedCampaignEvidence;
}

export async function verifyConversionTracking(client: Pick<GoogleAdsClient, 'search'>, context: CallContext & { customerId: string }): Promise<GoogleAdsVerificationCheck> {
  try {
    const actions = await client.search('SELECT conversion_action.resource_name, conversion_action.name, conversion_action.status, conversion_action.include_in_conversions_metric FROM conversion_action WHERE conversion_action.status = \'ENABLED\'', context);
    const counted = actions.filter(row => row.conversionAction?.includeInConversionsMetric === true);
    const recorded = await client.search('SELECT segments.conversion_action, metrics.all_conversions FROM customer WHERE segments.date DURING LAST_30_DAYS', context);
    const names = new Set(counted.map(row => row.conversionAction.resourceName));
    const proven = recorded.filter(row => names.has(row.segments?.conversionAction) && Number(row.metrics?.allConversions ?? 0) > 0);
    const detail = !counted.length ? 'no enabled conversion action counts toward conversions' : !proven.length ? 'enabled conversion actions exist, but none recorded a conversion in 30 days, so tracking is unproven' : `${proven.length} of ${counted.length} counted actions recorded conversions in the last 30 days`;
    return { id: 'conversion_tracking', passed: counted.length > 0 && proven.length > 0, detail };
  } catch (error) { rethrowUnlessExpected(error); return { id: 'conversion_tracking', passed: false, detail: error instanceof GoogleAdsError ? error.message : 'conversion tracking could not be read' }; }
}

export async function verifyDraft(client: Pick<GoogleAdsClient, 'search' | 'mutate'>, input: VerifyInput): Promise<GoogleAdsVerification> {
  const { customerId, brief, operations, context } = input;
  const checks: GoogleAdsVerificationCheck[] = [];
  const add = (id: GoogleAdsVerificationCheck['id'], problems: string[], passed: string) => checks.push({ id, passed: !problems.length, detail: problems.length ? problems.join(' | ') : passed });
  const read = readOperations(customerId, operations);
  const hash = sha256(canonicalJson({ customerId, operations }));

  // 1. Correctness, from the operations alone.
  const wrong: string[] = [...read.problems.filter(problem => !/changes or removes|may not run|outside this new/.test(problem))];
  if (hash !== input.storedHash) wrong.push('the operations no longer match the saved draft');
  if (!read.budget || !read.campaign || !read.adGroup || !read.ad) wrong.push('the campaign is incomplete');
  else {
    if (read.campaign.status !== 'PAUSED') wrong.push('a new campaign must start paused');
    if (read.campaign.advertisingChannelType !== 'SEARCH') wrong.push('only Search campaigns are supported');
    if (read.campaign.networkSettings?.targetContentNetwork !== false || read.campaign.networkSettings?.targetPartnerSearchNetwork !== false) wrong.push('the campaign reaches networks the owner did not ask for');
    const micros = String(read.budget.amountMicros);
    if (micros !== toMicros(brief.dailyBudget)) wrong.push(`the budget is ${micros} micros, the owner asked for ${toMicros(brief.dailyBudget)}`);
    if (BigInt(micros) > input.maxDailyBudgetMicros) wrong.push('the daily budget is over the configured ceiling');
    if (read.budget.explicitlyShared !== false) wrong.push('the budget must not be shared with existing campaigns');
    if (!read.campaign.name?.includes(`[m-${input.draftId.slice(0, 8)}]`)) wrong.push('the campaign name lost its draft marker');
    const ad = read.ad.ad?.responsiveSearchAd;
    if (read.ad.ad?.finalUrls?.[0] !== brief.landingPageUrl) wrong.push('the final URL differs from the brief');
    if (!same((ad?.headlines ?? []).map((item: any) => item.text), brief.headlines)) wrong.push('the headlines differ from the brief');
    if (!same((ad?.descriptions ?? []).map((item: any) => item.text), brief.descriptions)) wrong.push('the descriptions differ from the brief');
    if (!same(read.keywords.map(keywordLabel), brief.keywords.map(normalizeKeyword))) wrong.push('the keywords differ from the brief');
    if (!same(read.negatives.map(keywordLabel), brief.negativeKeywords.map(normalizeKeyword))) wrong.push('the negative keywords differ from the brief');
    if (!read.locations.length || !same(read.locations, input.geoResourceNames)) wrong.push('the locations differ from the resolved targets');
  }
  add('draft_correctness', wrong, `${operations.length} operations match the saved brief`);

  // 2. Nothing existing is touched: no update, no remove, no conversion action.
  const touching = read.problems.filter(problem => /changes or removes|may not run|outside this new/.test(problem));
  try {
    const existing = await client.search('SELECT campaign.id, campaign.name FROM campaign WHERE campaign.status != \'REMOVED\'', context);
    if (read.campaign && existing.some(row => row.campaign?.name === read.campaign.name)) touching.push('a campaign with this name already exists');
    add('existing_resources_preserved', touching, `only creates new resources; ${existing.length} existing campaigns stay as they are`);
  } catch (error) { rethrowUnlessExpected(error); add('existing_resources_preserved', [...touching, 'could not read the existing campaigns'], ''); }

  // 3. Fresh account read, not the cached connection row.
  try {
    const [customer] = await client.search('SELECT customer.id, customer.manager, customer.status FROM customer LIMIT 1', context);
    const problems: string[] = [];
    if (!customer?.customer) problems.push('the account could not be read');
    else {
      if (String(customer.customer.id) !== customerId) problems.push('the account answering is not the selected account');
      if (customer.customer.manager === true) problems.push('a manager account cannot hold campaigns');
      if (customer.customer.status !== 'ENABLED') problems.push(`the account status is ${customer.customer.status}`);
    }
    add('account_permissions', problems, 'the account is enabled and readable; write permission is proven by the validate-only request below');
  } catch (error) { rethrowUnlessExpected(error); add('account_permissions', [error instanceof GoogleAdsError ? error.message : 'the account could not be read'], ''); }

  // 4. Still recorded honestly when PAUSED creation is allowed with a warning.
  checks.push(await verifyConversionTracking(client, context));

  // 5. Google checks the same request, executing nothing. Only if the plan itself is sound.
  if (checks.some(check => ['draft_correctness', 'existing_resources_preserved'].includes(check.id) && !check.passed)) add('google_validate_only', ['skipped: the draft has local problems'], '');
  else try {
    await client.mutate([...operations], true, context);
    add('google_validate_only', [], 'Google accepted the request in validate-only mode; nothing was created');
  } catch (error) {
    rethrowUnlessExpected(error);
    const codes = error instanceof GoogleAdsError ? error.options.googleCodes ?? [] : [];
    add('google_validate_only', [`${error instanceof GoogleAdsError ? error.message : 'Google did not accept the request'}${codes.length ? ` [${codes.slice(0, 5).join(', ')}]` : ''}`], '');
  }
  return { passed: checks.every(check => check.passed || input.allowUnprovenConversionsForPaused === true && check.id === 'conversion_tracking'), checkedAt: new Date().toISOString(), draftHash: hash, checks };
}

/** Sign-in and rate-limit failures are the connection's state, not a finding about the draft. */
function rethrowUnlessExpected(error: unknown) {
  if (error instanceof GoogleAdsError && ['GOOGLE_ADS_UNAUTHORIZED', 'GOOGLE_ADS_RATE_LIMITED', 'GOOGLE_ADS_DAILY_QUOTA', 'GOOGLE_ADS_UNAVAILABLE'].includes(error.code)) throw error;
}

function normalizeKeyword(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('[') && value.endsWith(']')) return `[${value.slice(1, -1).trim()}]`;
  if (value.startsWith('"') && value.endsWith('"') && value.length > 1) return `"${value.slice(1, -1).trim()}"`;
  return value;
}
