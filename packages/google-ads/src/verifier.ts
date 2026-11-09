import type { GoogleAdsBrief, GoogleAdsChangeSummary, GoogleAdsVerification, GoogleAdsVerificationCheck } from '@mohassan/contracts';
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
