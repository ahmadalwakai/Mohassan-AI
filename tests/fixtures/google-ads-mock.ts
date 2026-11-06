/** A stand-in for Google's OAuth and Google Ads REST endpoints, shaped from the v26 documentation. Never contacts Google. */
export const CUSTOMER = '1234567890', MANAGER = '9999999999', CHILD = '2222222222';

export interface MockGoogle {
  fetch: typeof fetch;
  calls: { url: string; body: any; headers: Record<string, string> }[];
  mutations: { operations: any[]; validateOnly: boolean }[];
  state: {
    refreshRevoked: boolean; accessRejected: boolean; rateLimitNext: number; dailyQuota: boolean; testLevelProject: boolean; permissionDenied: boolean; outage: boolean; keywordPlanDenied: boolean; mutateFailure: 'none' | 'rejected' | 'lost_applied' | 'lost_absent'; validateFailure: boolean;
    conversionsRecorded: number; conversionActionEnabled: boolean; manager: boolean; emptyAccount: boolean; refreshIssued: boolean; campaigns: { name: string; status: string; resourceName: string; budget: string }[]; legacyLanguage: boolean; noLocations: boolean; arabicAds: boolean;
  };
}

const failure = (status: number, code: string, key: string, value: string) => Response.json({ error: { code: status, message: `raw google text with secret-looking detail ${value}`, status: code, details: [{ '@type': 'type.googleapis.com/google.ads.googleads.v26.errors.GoogleAdsFailure', errors: [{ errorCode: { [key]: value }, message: 'raw' }], requestId: 'req-failure' }] } }, { status, headers: { 'request-id': 'req-failure' } });

export function createMockGoogle(): MockGoogle {
  const state: MockGoogle['state'] = { refreshRevoked: false, accessRejected: false, rateLimitNext: 0, dailyQuota: false, testLevelProject: false, permissionDenied: false, outage: false, keywordPlanDenied: false, mutateFailure: 'none', validateFailure: false, conversionsRecorded: 7, conversionActionEnabled: true, manager: false, emptyAccount: false, refreshIssued: true, campaigns: [], legacyLanguage: false, noLocations: false, arabicAds: false };
  const calls: MockGoogle['calls'] = [], mutations: MockGoogle['mutations'] = [];
  let tokens = 0;

  function search(customerId: string, query: string): Record<string, unknown>[] {
    const from = /FROM\s+(\w+)/.exec(query)?.[1];
    if (from === 'customer_client') return customerId === MANAGER ? [{ customerClient: { id: CHILD, descriptiveName: 'Child Removals', currencyCode: 'GBP', timeZone: 'Europe/London', manager: false, testAccount: false, status: 'ENABLED' } }] : [];
    if (from === 'customer' && query.includes('customer.id')) return [{ customer: { id: customerId, descriptiveName: customerId === MANAGER ? 'Manager' : 'MA Removals', currencyCode: 'GBP', timeZone: 'Europe/London', manager: customerId === MANAGER || state.manager, testAccount: false, status: 'ENABLED' } }];
    if (from === 'customer') return state.conversionsRecorded ? [{ segments: { conversionAction: `customers/${customerId}/conversionActions/11` }, metrics: { allConversions: state.conversionsRecorded } }, { segments: { conversionAction: `customers/${customerId}/conversionActions/12` }, metrics: { allConversions: 2 } }] : [];
    if (from === 'conversion_action') return state.conversionActionEnabled ? [{ conversionAction: { resourceName: `customers/${customerId}/conversionActions/11`, name: 'Booking: House removals', status: 'ENABLED', category: 'BOOK_APPOINTMENT', primaryForGoal: true, includeInConversionsMetric: true } }, { conversionAction: { resourceName: `customers/${customerId}/conversionActions/12`, name: 'Booking: Man and van', status: 'ENABLED', category: 'BOOK_APPOINTMENT', primaryForGoal: true, includeInConversionsMetric: true } }] : [];
    if (from === 'campaign_criterion') return [...(state.noLocations ? [] : [{ campaign: { id: '100' }, campaignCriterion: { type: 'LOCATION', location: { geoTargetConstant: 'geoTargetConstants/2826' } } }]), ...(state.legacyLanguage ? [{ campaign: { id: '100' }, campaignCriterion: { type: 'LANGUAGE', language: { languageConstant: 'languageConstants/1019' } } }] : [])];
    if (from === 'ad_group_ad') return [{ campaign: { id: '100' }, adGroupAd: { ad: { responsiveSearchAd: { headlines: [{ text: state.arabicAds ? 'نقل أثاث في غلاسكو' : 'Glasgow Removals' }], descriptions: [{ text: state.arabicAds ? 'احجز موعدك اليوم' : 'Book your move today' }] } } } }];
    if (from === 'language_constant') return [{ languageConstant: { resourceName: 'languageConstants/1019', code: 'ar' } }];
    if (from === 'geo_target_constant') return [{ geoTargetConstant: { resourceName: 'geoTargetConstants/2826', countryCode: 'GB' } }];
    if (from === 'search_term_view') return [{ searchTermView: { searchTerm: 'free removal boxes' }, campaign: { id: '100' }, metrics: { impressions: '90', clicks: '14', costMicros: '21000000' } }, { searchTermView: { searchTerm: 'house removals glasgow' }, campaign: { id: '100' }, metrics: { impressions: '300', clicks: '40', costMicros: '62000000', conversions: 5 } }];
    if (from === 'campaign' && query.includes('WHERE campaign.name =')) {
      const name = /campaign\.name = '((?:[^'\\]|\\.)*)'/.exec(query)?.[1]?.replace(/\\(.)/g, '$1');
      const found = state.campaigns.find(item => item.name === name);
      return found ? [{ campaign: { resourceName: found.resourceName, status: found.status, name: found.name }, campaignBudget: { amountMicros: found.budget } }] : [];
    }
    if (from === 'campaign' && query.includes('metrics.')) return state.emptyAccount ? [] : [{ campaign: { id: '100', name: 'Existing Search', status: 'ENABLED', advertisingChannelType: 'SEARCH', biddingStrategyType: 'MAXIMIZE_CONVERSIONS', geoTargetTypeSetting: { positiveGeoTargetType: 'PRESENCE_OR_INTEREST' } }, campaignBudget: { amountMicros: '30000000' }, metrics: { impressions: '4200', clicks: '310', costMicros: '412500000', conversions: 18.5, conversionsValue: 0, searchImpressionShare: 0.42, searchBudgetLostImpressionShare: 0.31, searchRankLostImpressionShare: 0.12 } }];
    if (from === 'campaign') return state.campaigns.map(item => ({ campaign: { id: item.resourceName.split('/').pop(), name: item.name } }));
    throw new Error(`Mock has no answer for: ${query}`);
  }

  function applyMutation(customerId: string, body: any) {
    for (const operation of body.mutateOperations) {
      const update = operation.campaignOperation?.update;
      if (update) { const found = state.campaigns.find(item => item.resourceName === update.resourceName); if (found) found.status = update.status; continue; }
      const created = operation.campaignOperation?.create;
      if (created) state.campaigns.push({ name: created.name, status: created.status, resourceName: `customers/${customerId}/campaigns/777`, budget: body.mutateOperations[0].campaignBudgetOperation.create.amountMicros });
    }
  }

  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = init?.body instanceof URLSearchParams ? Object.fromEntries(init.body.entries()) : init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url: url.href, body, headers });
    if (url.href === 'https://oauth2.googleapis.com/revoke') return new Response('{}');
    if (url.href === 'https://oauth2.googleapis.com/token') {
      if (body.grant_type === 'authorization_code') return body.code === 'good-code' ? Response.json({ access_token: 'access-1', refresh_token: state.refreshIssued ? 'refresh-token-secret' : undefined, scope: 'https://www.googleapis.com/auth/adwords', expires_in: 3600 }) : Response.json({ error: 'invalid_grant' }, { status: 400 });
      if (state.refreshRevoked) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      tokens += 1;
      return Response.json({ access_token: `access-${tokens}`, expires_in: 3600 });
    }
    if (url.host !== 'googleads.googleapis.com') throw new Error(`Mock refuses ${url.host}`);
    if (!url.pathname.startsWith('/v26/')) throw new Error(`Unexpected API version: ${url.pathname}`);
    if (state.outage) throw new TypeError('network down');
    if (state.accessRejected) return failure(401, 'UNAUTHENTICATED', 'authenticationError', 'OAUTH_TOKEN_REVOKED');
    if (state.rateLimitNext > 0) { state.rateLimitNext -= 1; return failure(429, 'RESOURCE_EXHAUSTED', 'quotaError', 'RESOURCE_TEMPORARILY_EXHAUSTED'); }
    if (state.dailyQuota) return failure(429, 'RESOURCE_EXHAUSTED', 'quotaError', 'RESOURCE_EXHAUSTED');
    if (state.testLevelProject) return failure(403, 'PERMISSION_DENIED', 'authorizationError', 'CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION');
    if (state.permissionDenied) return failure(403, 'PERMISSION_DENIED', 'authorizationError', 'USER_PERMISSION_DENIED');
    const path = url.pathname.slice('/v26/'.length);
    if (path === 'customers:listAccessibleCustomers') return Response.json({ resourceNames: [`customers/${CUSTOMER}`, `customers/${MANAGER}`] });
    if (path === 'geoTargetConstants:suggest') return Response.json({ geoTargetConstantSuggestions: body.locationNames.names.flatMap((name: string) => name === 'Atlantis' ? [] : [{ geoTargetConstant: { resourceName: `geoTargetConstants/${1000 + name.length}`, name, countryCode: body.countryCode, status: 'ENABLED' } }]) });
    const match = /^customers\/(\d{10})(?:\/googleAds)?:(\w+)$/.exec(path);
    if (!match) throw new Error(`Mock has no route: ${path}`);
    const [, customerId, method] = match as unknown as [string, string, string];
    if (method === 'searchStream') return Response.json([{ results: search(customerId, body.query), requestId: 'req-search' }]);
    if (method === 'generateKeywordIdeas') return state.keywordPlanDenied ? failure(403, 'PERMISSION_DENIED', 'authorizationError', 'ACTION_NOT_PERMITTED') : Response.json({ results: [{ text: 'removals glasgow', keywordIdeaMetrics: { avgMonthlySearches: '1900', competition: 'HIGH', lowTopOfPageBidMicros: '900000', highTopOfPageBidMicros: '3500000' } }] });
    if (method === 'mutate') {
      mutations.push({ operations: body.mutateOperations, validateOnly: body.validateOnly });
      if (body.partialFailure !== false) throw new Error('Mutate must be atomic');
      if (body.validateOnly) return state.validateFailure ? failure(400, 'INVALID_ARGUMENT', 'adError', 'POLICY_FINDING') : Response.json({ requestId: 'req-validate' });
      if (state.mutateFailure === 'rejected') return failure(400, 'INVALID_ARGUMENT', 'campaignError', 'DUPLICATE_CAMPAIGN_NAME');
      if (state.mutateFailure === 'lost_applied') { applyMutation(customerId, body); throw new TypeError('connection reset'); }
      if (state.mutateFailure === 'lost_absent') throw new TypeError('connection reset');
      applyMutation(customerId, body);
      return Response.json({ requestId: 'req-mutate', mutateOperationResponses: [{ campaignResult: { resourceName: `customers/${customerId}/campaigns/777` } }] });
    }
    throw new Error(`Mock has no method: ${method}`);
  };
  return { fetch: fetcher, calls, mutations, state };
}

export const landingHtml = (language = 'en') => `<!doctype html><html lang="${language}"><head><title>MA Removals Glasgow</title></head><body><h1>House removals in Glasgow</h1><p>Local movers with free quotes and insured moves.</p><script>ignored()</script></body></html>`;

export const brief = {
  businessName: 'MA Removals', service: 'House removals', goal: 'bookings' as const, landingPageUrl: 'https://maremovals.example.com/house', locations: ['Glasgow'], countryCode: 'GB', adLanguage: 'en', dailyBudget: '20',
  ownerFacts: ['We offer free quotes.'], headlines: ['Glasgow House Removals', 'Local Movers Glasgow', 'Free Moving Quotes'], descriptions: ['Careful house removals across Glasgow.', 'Book your move online in minutes.'],
  paths: ['removals', 'glasgow'], keywords: ['"house removals glasgow"', '[removals glasgow]'], negativeKeywords: ['jobs', 'boxes'],
};
