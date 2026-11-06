import { describe, expect, it } from 'vitest';
import { GoogleAdsBriefSchema, GoogleAdsReportSchema } from '@mohassan/contracts';
import {
  ADS_LIMITS, GoogleAdsClient, GoogleAdsError, analyzeAccount, bookingsByService, budgetToMicros, buildOperations, campaignStrategy, canonicalJson, chooseBidding, detectScript, evidenceGates, negativeBlocks, operationsHash, optimize, parseKeyword, parseTokenKey, readLandingPage, seal, sourceFingerprint, summarizeOperations, unseal, validateAdText, validateBrief, verifyDraft,
} from '@mohassan/google-ads';
import { mkdtemp, readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brief as baseBrief, createMockGoogle, CUSTOMER, landingHtml } from './fixtures/google-ads-mock.js';

const brief = GoogleAdsBriefSchema.parse(baseBrief);
const key = Buffer.alloc(32, 7);
const DRAFT = '11111111-2222-4333-8444-555555555555';
const geo = [{ name: 'Glasgow', resourceName: 'geoTargetConstants/1007', countryCode: 'GB' }];
const makeClient = (mock: ReturnType<typeof createMockGoogle>) => new GoogleAdsClient({ clientId: 'id', clientSecret: 'secret', fetch: mock.fetch, sleep: async () => undefined, random: () => 0 });
const context = { refreshToken: 'refresh', customerId: CUSTOMER };
const errors = (issues: { severity: string; code: string }[]) => issues.filter(issue => issue.severity === 'error').map(issue => issue.code);

describe('token protection', () => {
  it('seals with authenticated context and never stores plain text', () => {
    const sealed = seal('refresh-token-secret', key, 'owner-a');
    expect(sealed).not.toContain('refresh-token-secret');
    expect(unseal(sealed, key, 'owner-a')).toBe('refresh-token-secret');
    expect(() => unseal(sealed, key, 'owner-b')).toThrow(GoogleAdsError);
    expect(() => unseal(sealed, Buffer.alloc(32, 8), 'owner-a')).toThrow(GoogleAdsError);
    expect(() => unseal(`${sealed.slice(0, -4)}AAAA`, key, 'owner-a')).toThrow(GoogleAdsError);
  });
  it('refuses a key of the wrong size', () => {
    expect(() => parseTokenKey('short')).toThrow('32 random bytes');
    expect(parseTokenKey(Buffer.alloc(32, 1).toString('base64'))).toHaveLength(32);
  });
  it('hashes the same content the same way whatever the key order', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe(canonicalJson({ a: [{ c: 2, d: 1 }], b: 1 }));
  });
});

describe('ad quality validator', () => {
  const clean = { headlines: ['Glasgow Removals', 'Local Movers', 'Book Online'], descriptions: ['Careful house removals.', 'Book your move today.'], paths: [], keywords: ['house removals'], negativeKeywords: ['jobs'] };
  it('passes clean copy', () => expect(errors(validateAdText(clean, 'x', 'en'))).toEqual([]));
  it.each([
    ['Rank #1 on Google', 'POSITION_PROMISE'], ['Top of Google today', 'POSITION_PROMISE'], ['Guaranteed Leads Fast', 'POSITION_PROMISE'], ['الأول على جوجل', 'POSITION_PROMISE'],
    ['Best Removals', 'UNSUPPORTED_CLAIM'], ['20% Off Moves', 'UNSUPPORTED_CLAIM'], ['خصم خاص', 'UNSUPPORTED_CLAIM'],
    ['Move Today!', 'POLICY_PUNCTUATION'], ['Move Today??', 'POLICY_PUNCTUATION'], ['CHEAP Moves', 'POLICY_CAPITALS'], ['Call 0141 555 0100', 'POLICY_PHONE'], ['Visit www.ma.com', 'POLICY_WEBSITE'], ['Moves 🚚 Fast', 'POLICY_SYMBOLS'], ['Click here to book', 'POLICY_CALL_TO_ACTION'],
  ])('rejects %s', (text, code) => {
    expect(errors(validateAdText({ ...clean, headlines: [text, ...clean.headlines] }, 'nothing stated'))).toContain(code);
  });
  it('accepts a claim the evidence states', () => {
    expect(errors(validateAdText({ ...clean, headlines: ['Free Quotes', ...clean.headlines] }, 'We give free quotes'))).toEqual([]);
  });
  it('applies position rules even when the owner stated them', () => {
    expect(errors(validateAdText({ ...clean, headlines: ['Rank #1 on Google', ...clean.headlines] }, 'rank #1 on google'))).toContain('POSITION_PROMISE');
  });
  it('accepts a brand in capitals only when the evidence spells it that way', () => {
    expect(errors(validateAdText({ ...clean, headlines: ['IKEA Furniture Moves', ...clean.headlines] }, 'We move IKEA furniture'))).toEqual([]);
    expect(errors(validateAdText({ ...clean, headlines: ['IKEA Furniture Moves', ...clean.headlines] }, 'we move ikea furniture'))).toContain('POLICY_CAPITALS');
  });
  it('does not read short number runs as a phone number', () => {
    expect(errors(validateAdText({ ...clean, headlines: ['Moves 2024 - 2026', ...clean.headlines] }, 'x'))).not.toContain('POLICY_PHONE');
  });
  it('lets a stated Latin brand sit in an Arabic ad', () => {
    const arabic = { ...clean, headlines: ['MA Removals غلاسكو', 'نقل أثاث', 'نقل منازل'], descriptions: ['نقل أثاث بعناية.', 'احجز اليوم.'] };
    expect(errors(validateAdText(arabic, 'MA Removals', 'ar'))).toEqual([]);
    expect(errors(validateAdText({ ...arabic, headlines: ['Unknown Latin Words', 'نقل أثاث', 'نقل منازل'] }, 'MA Removals', 'ar'))).toContain('LANGUAGE_MISMATCH');
  });
  it('rejects copy in the wrong script for the campaign language', () => {
    expect(errors(validateAdText({ ...clean, headlines: ['نقل أثاث', ...clean.headlines] }, 'x', 'en'))).toContain('LANGUAGE_MISMATCH');
    expect(detectScript('نقل أثاث في غلاسكو')).toBe('arabic');
    expect(detectScript('12 34')).toBeNull();
  });
  it('checks keywords and negatives', () => {
    expect(errors(validateAdText({ ...clean, keywords: ['a!b'] }))).toContain('KEYWORD_SYNTAX');
    expect(errors(validateAdText({ ...clean, keywords: ['+house +removals'] }))).toContain('KEYWORD_SYNTAX');
    expect(errors(validateAdText({ ...clean, keywords: ['x'.repeat(ADS_LIMITS.keywordChars + 1)] }))).toContain('TOO_LONG');
    expect(errors(validateAdText({ ...clean, keywords: ['a b c d e f g h i j k'] }))).toContain('TOO_LONG');
    expect(errors(validateAdText({ ...clean, keywords: ['house', 'HOUSE'] }))).toContain('DUPLICATE');
    expect(errors(validateAdText({ ...clean, keywords: ['house jobs glasgow'], negativeKeywords: ['jobs'] }))).toContain('NEGATIVE_BLOCKS_KEYWORD');
  });
  it('reads match types and negative reach', () => {
    expect(parseKeyword('[a b]')).toEqual({ text: 'a b', matchType: 'EXACT' });
    expect(parseKeyword('"a b"')).toEqual({ text: 'a b', matchType: 'PHRASE' });
    expect(parseKeyword('a b')).toEqual({ text: 'a b', matchType: 'BROAD' });
    expect(negativeBlocks({ text: 'cheap move', matchType: 'BROAD' }, { text: 'move cheap glasgow' })).toBe(true);
    expect(negativeBlocks({ text: 'cheap move', matchType: 'PHRASE' }, { text: 'move cheap glasgow' })).toBe(false);
    expect(negativeBlocks({ text: 'glasgow', matchType: 'EXACT' }, { text: 'move glasgow' })).toBe(false);
  });
  it('validates the landing page', () => {
    const read = (language: string, finalUrl = brief.landingPageUrl, status = 200) => readLandingPage(brief.landingPageUrl, finalUrl, status, landingHtml(language), null);
    const issues = (page: ReturnType<typeof read>) => errors(validateBrief(brief, page.landing, page.text));
    expect(issues(read('en'))).toEqual([]);
    expect(issues(read('ar'))).toContain('LANDING_LANGUAGE_MISMATCH');
    expect(issues(read('en', 'https://other.example.org/'))).toContain('LANDING_REDIRECT');
    expect(issues(read('en', brief.landingPageUrl, 404))).toContain('LANDING_UNREACHABLE');
    expect(read('en').text).not.toContain('ignored');
  });
  it('warns, as an assumption, when the language is unusual for the country', () => {
    const page = readLandingPage(brief.landingPageUrl, brief.landingPageUrl, 200, landingHtml('ar'), null);
    const arabic = { ...brief, adLanguage: 'ar', headlines: ['نقل أثاث', 'نقل منازل', 'نقل سريع'], descriptions: ['نقل أثاث بعناية.', 'احجز اليوم.'] };
    const warning = validateBrief(arabic, page.landing, page.text).find(issue => issue.code === 'LANGUAGE_LOCATION_MISMATCH');
    expect(warning).toMatchObject({ severity: 'warning' });
    expect(warning?.message).toContain('Assumption');
  });
  it('catches a claim the page does not make', () => {
    const page = readLandingPage(brief.landingPageUrl, brief.landingPageUrl, 200, landingHtml(), null);
    expect(errors(validateBrief({ ...brief, ownerFacts: [], headlines: [...brief.headlines, '20 Years Experience'] }, page.landing, page.text))).toContain('UNSUPPORTED_CLAIM');
  });
});

describe('campaign draft builder', () => {
  const operations = buildOperations(brief, DRAFT, CUSTOMER, geo, 'MANUAL_CPC');
  const campaign = (operations[1] as any).campaignOperation.create;
  it('converts money without floating point', () => {
    expect(budgetToMicros('20')).toBe('20000000');
    expect(budgetToMicros('0.07')).toBe('70000');
    expect(budgetToMicros('19.99')).toBe('19990000');
  });
  it('starts paused and reaches only Google Search', () => {
    expect(campaign).toMatchObject({ status: 'PAUSED', advertisingChannelType: 'SEARCH', containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING', networkSettings: { targetContentNetwork: false, targetPartnerSearchNetwork: false } });
  });
  it('never adds a language criterion, which Google rejects on Search', () => {
    expect(JSON.stringify(operations)).not.toContain('language');
  });
  it('only creates, and keeps the same hash for the same content', () => {
    for (const operation of operations) expect(Object.values(operation)[0]).toHaveProperty('create');
    expect(operationsHash(CUSTOMER, operations)).toBe(operationsHash(CUSTOMER, buildOperations(brief, DRAFT, CUSTOMER, geo, 'MANUAL_CPC')));
    expect(operationsHash(CUSTOMER, operations)).not.toBe(operationsHash(CUSTOMER, buildOperations({ ...brief, dailyBudget: '21' }, DRAFT, CUSTOMER, geo, 'MANUAL_CPC')));
  });
  it('summarizes from operations, with Google\'s spend limits', () => {
    const summary = summarizeOperations(CUSTOMER, operations, new Map([[geo[0]!.resourceName, 'Glasgow']]))!;
    expect(summary).toMatchObject({ initialStatus: 'PAUSED', dailyBudgetMicros: '20000000', maxDailySpendMicros: '40000000', maxMonthlySpendMicros: '608000000', locations: ['Glasgow'], finalUrl: brief.landingPageUrl });
    expect(summary.keywords).toEqual(brief.keywords);
  });
});

describe('independent verifier', () => {
  const operations = buildOperations(brief, DRAFT, CUSTOMER, geo, 'MANUAL_CPC');
  const run = (mock: ReturnType<typeof createMockGoogle>, ops = operations, overrides: Partial<Parameters<typeof verifyDraft>[1]> = {}) => verifyDraft(makeClient(mock), { draftId: DRAFT, customerId: CUSTOMER, brief, operations: ops, storedHash: operationsHash(CUSTOMER, ops), geoResourceNames: [geo[0]!.resourceName], maxDailyBudgetMicros: 100_000_000n, context, ...overrides });
  const failed = async (result: ReturnType<typeof verifyDraft>) => (await result).checks.filter(check => !check.passed).map(check => check.id);
  const tamper = (edit: (copy: any[]) => void) => { const copy = structuredClone(operations) as any[]; edit(copy); return copy; };

  it('passes a correct draft and sends Google one validate-only request', async () => {
    const mock = createMockGoogle();
    const result = await run(mock);
    expect(result.passed, JSON.stringify(result.checks)).toBe(true);
    expect(mock.mutations).toHaveLength(1);
    expect(mock.mutations[0]!.validateOnly).toBe(true);
  });
  it('detects edits made after the owner saw the draft', async () => {
    expect(await failed(run(createMockGoogle(), operations, { storedHash: 'different' }))).toContain('draft_correctness');
  });
  it.each([
    ['a changed budget', (copy: any[]) => { copy[0].campaignBudgetOperation.create.amountMicros = '90000000'; }],
    ['an enabled campaign', (copy: any[]) => { copy[1].campaignOperation.create.status = 'ENABLED'; }],
    ['a language criterion', (copy: any[]) => { copy.push({ campaignCriterionOperation: { create: { campaign: `customers/${CUSTOMER}/campaigns/-2`, language: { languageConstant: 'languageConstants/1000' } } } }); }],
    ['Display network', (copy: any[]) => { copy[1].campaignOperation.create.networkSettings.targetContentNetwork = true; }],
    ['a changed headline', (copy: any[]) => { copy.at(-1).adGroupAdOperation.create.ad.responsiveSearchAd.headlines[0].text = 'Changed'; }],
  ])('rejects %s and asks Google nothing', async (_name, edit) => {
    const mock = createMockGoogle();
    const result = await run(mock, tamper(edit));
    expect(result.checks.find(check => check.id === 'draft_correctness')?.passed).toBe(false);
    expect(mock.mutations).toHaveLength(0);
  });
  it.each([
    ['an update to an existing campaign', (copy: any[]) => { copy.push({ campaignOperation: { update: { resourceName: `customers/${CUSTOMER}/campaigns/100`, status: 'PAUSED' }, updateMask: 'status' } }); }],
    ['a removal', (copy: any[]) => { copy.push({ campaignOperation: { remove: `customers/${CUSTOMER}/campaigns/100` } }); }],
    ['a conversion action change', (copy: any[]) => { copy.push({ conversionActionOperation: { update: { resourceName: `customers/${CUSTOMER}/conversionActions/11`, status: 'REMOVED' } } }); }],
    ['an ad group added to an existing campaign', (copy: any[]) => { copy.push({ adGroupOperation: { create: { campaign: `customers/${CUSTOMER}/campaigns/100`, name: 'x' } } }); }],
  ])('refuses %s', async (_name, edit) => {
    const mock = createMockGoogle();
    expect(await failed(run(mock, tamper(edit)))).toContain('existing_resources_preserved');
    expect(mock.mutations).toHaveLength(0);
  });
  it('refuses a budget over the ceiling', async () => {
    expect(await failed(run(createMockGoogle(), operations, { maxDailyBudgetMicros: 10_000_000n }))).toContain('draft_correctness');
  });
  it('refuses a name that already exists', async () => {
    const mock = createMockGoogle();
    mock.state.campaigns.push({ name: (operations[1] as any).campaignOperation.create.name, status: 'PAUSED', resourceName: `customers/${CUSTOMER}/campaigns/5`, budget: '1' });
    expect(await failed(run(mock))).toContain('existing_resources_preserved');
  });
  it('fails conversion tracking when no action exists or none recorded anything', async () => {
    const none = createMockGoogle(); none.state.conversionActionEnabled = false;
    expect(await failed(run(none))).toContain('conversion_tracking');
    const silent = createMockGoogle(); silent.state.conversionsRecorded = 0;
    const result = await run(silent);
    expect(result.checks.find(check => check.id === 'conversion_tracking')?.detail).toContain('unproven');
    expect(result.passed).toBe(false);
  });
  it('fails on a manager account and on missing write permission', async () => {
    const manager = createMockGoogle(); manager.state.manager = true;
    expect(await failed(run(manager))).toContain('account_permissions');
    const denied = createMockGoogle(); denied.state.permissionDenied = true;
    expect(await failed(run(denied))).toEqual(expect.arrayContaining(['account_permissions', 'google_validate_only']));
  });
  it('records Google\'s policy rejection', async () => {
    const mock = createMockGoogle(); mock.state.validateFailure = true;
    const result = await run(mock);
    expect(result.checks.find(check => check.id === 'google_validate_only')?.detail).toContain('POLICY_FINDING');
  });
});

describe('API client', () => {
  it('sends no developer token unless configured', async () => {
    const mock = createMockGoogle();
    await makeClient(mock).search('SELECT customer.id FROM customer LIMIT 1', context);
    expect(mock.calls.at(-1)!.headers).not.toHaveProperty('developer-token');
    await new GoogleAdsClient({ clientId: 'id', clientSecret: 'secret', developerToken: 'legacy', fetch: mock.fetch }).search('SELECT customer.id FROM customer LIMIT 1', context);
    expect(mock.calls.at(-1)!.headers['developer-token']).toBe('legacy');
  });
  it('sends the manager header when acting through a manager', async () => {
    const mock = createMockGoogle();
    await makeClient(mock).search('SELECT customer.id FROM customer LIMIT 1', { ...context, loginCustomerId: '9999999999' });
    expect(mock.calls.at(-1)!.headers['login-customer-id']).toBe('9999999999');
  });
  it('retries a short rate limit on reads, within a limit', async () => {
    const mock = createMockGoogle(); mock.state.rateLimitNext = 2;
    expect(await makeClient(mock).search('SELECT customer.id FROM customer LIMIT 1', context)).toHaveLength(1);
    const stuck = createMockGoogle(); stuck.state.rateLimitNext = 50;
    await expect(makeClient(stuck).search('SELECT customer.id FROM customer LIMIT 1', context)).rejects.toMatchObject({ code: 'GOOGLE_ADS_RATE_LIMITED', statusCode: 429 });
    expect(stuck.calls.filter(call => call.url.includes('searchStream'))).toHaveLength(4);
  });
  it('does not retry the daily quota or a write', async () => {
    const quota = createMockGoogle(); quota.state.dailyQuota = true;
    await expect(makeClient(quota).search('SELECT customer.id FROM customer LIMIT 1', context)).rejects.toMatchObject({ code: 'GOOGLE_ADS_DAILY_QUOTA' });
    expect(quota.calls.filter(call => call.url.includes('searchStream'))).toHaveLength(1);
    const limited = createMockGoogle(); limited.state.rateLimitNext = 1;
    await expect(makeClient(limited).mutate([{}], false, context)).rejects.toMatchObject({ code: 'GOOGLE_ADS_RATE_LIMITED' });
    expect(limited.calls.filter(call => call.url.includes('mutate'))).toHaveLength(1);
  });
  it('explains Test-level projects and keeps Google\'s raw text out', async () => {
    const mock = createMockGoogle(); mock.state.testLevelProject = true;
    const error = await makeClient(mock).search('SELECT customer.id FROM customer LIMIT 1', context).catch(caught => caught as GoogleAdsError);
    expect(error).toMatchObject({ code: 'GOOGLE_ADS_ACCESS_LEVEL', statusCode: 403 });
    expect((error as GoogleAdsError).message).toContain('Explorer');
    expect((error as GoogleAdsError).message).not.toContain('raw google text');
  });
  it('reports a revoked sign-in as unauthorized', async () => {
    const mock = createMockGoogle(); mock.state.refreshRevoked = true;
    await expect(makeClient(mock).search('SELECT customer.id FROM customer LIMIT 1', context)).rejects.toMatchObject({ code: 'GOOGLE_ADS_UNAUTHORIZED', statusCode: 401 });
  });
  it('caches the access token in memory', async () => {
    const mock = createMockGoogle(), client = makeClient(mock);
    await client.search('SELECT customer.id FROM customer LIMIT 1', context);
    await client.search('SELECT customer.id FROM customer LIMIT 1', context);
    expect(mock.calls.filter(call => call.url.includes('oauth2'))).toHaveLength(1);
  });
});

describe('account analysis', () => {
  const account = { currency: 'GBP', timeZone: 'Europe/London' };
  const analyze = (mock: ReturnType<typeof createMockGoogle>, rules: Parameters<typeof analyzeAccount>[3] = []) => analyzeAccount(makeClient(mock), context, account, rules, 30);

  it('reports exactly what Google returned and satisfies the contract', async () => {
    const report = await analyze(createMockGoogle());
    expect(GoogleAdsReportSchema.parse(report).basis).toBe('observed');
    expect(report.totals).toEqual({ impressions: 4200, clicks: 310, costMicros: '412500000', conversions: 18.5, conversionsValue: 0 });
    expect(report.campaigns[0]).toMatchObject({ budgetLostImpressionShare: 0.31, dailyBudgetMicros: '30000000' });
  });
  it('ends the range yesterday, because today is partial', async () => {
    const report = await analyze(createMockGoogle());
    expect(Date.parse(report.range.end)).toBeLessThan(Date.now() - 12 * 3600000);
  });
  it('states an empty account instead of inventing one', async () => {
    const mock = createMockGoogle(); mock.state.emptyAccount = true;
    const report = await analyze(mock);
    expect(report).toMatchObject({ empty: true, campaigns: [], totals: { clicks: 0, costMicros: '0' } });
    expect(report.notes.join()).toContain('لا توجد حملات');
  });
  it('counts bookings per service only where the owner mapped real conversions', async () => {
    const report = await analyze(createMockGoogle(), [{ service: 'House removals', conversionActions: [`customers/${CUSTOMER}/conversionActions/11`] }, { service: 'Man and van', conversionActions: [`customers/${CUSTOMER}/conversionActions/12`] }]);
    expect(report.bookings.services.map(item => [item.service, item.completedBookings])).toEqual([['House removals', 7], ['Man and van', 2]]);
    expect((await analyze(createMockGoogle())).bookings).toMatchObject({ mapped: false, services: [] });
    expect(bookingsByService([], [{ service: 'X', conversionActions: [`customers/${CUSTOMER}/conversionActions/1`] }]).services[0]).toMatchObject({ status: 'no_conversions_recorded', completedBookings: 0 });
  });
  it('finds language and location mismatches', async () => {
    const mock = createMockGoogle(); mock.state.legacyLanguage = true; mock.state.arabicAds = false;
    const kinds = (await analyze(mock)).mismatches.map(item => item.kind);
    expect(kinds).toEqual(expect.arrayContaining(['ad_language_vs_language_criterion', 'location_interest_targeting']));
    const arabic = createMockGoogle(); arabic.state.arabicAds = true;
    const location = (await analyze(arabic)).mismatches.find(item => item.kind === 'ad_language_vs_location');
    expect(location).toMatchObject({ basis: 'assumption' });
    const nowhere = createMockGoogle(); nowhere.state.noLocations = true;
    expect((await analyze(nowhere)).mismatches.map(item => item.kind)).toContain('no_location_target');
  });
});

describe('strategy and optimization', () => {
  const report = () => analyzeAccount(makeClient(createMockGoogle()), context, { currency: 'GBP', timeZone: 'UTC' }, [], 30);
  it('bids on conversions only with enough observed conversions', async () => {
    const current = await report();
    expect(chooseBidding(current)).toBe('MAXIMIZE_CONVERSIONS');
    expect(chooseBidding({ ...current, totals: { ...current.totals, conversions: 3 } })).toBe('MANUAL_CPC');
    expect(chooseBidding(null)).toBe('MANUAL_CPC');
  });
  it('labels estimates and refuses to guess without data', async () => {
    const current = await report();
    const estimate = campaignStrategy(brief, current, { fetchedAt: '', searchTerms: { basis: 'observed', source: '', items: [] }, keywordIdeas: { status: 'available', basis: 'estimate', source: 'p', reason: null, items: [{ text: 'a', avgMonthlySearches: 10, competition: 'HIGH', lowTopOfPageBidMicros: '1000000', highTopOfPageBidMicros: '4000000' }] } }, 'GBP');
    expect(estimate.recommendations.find(item => item.title.includes('نقرة'))).toMatchObject({ basis: 'estimate' });
    const blind = campaignStrategy(brief, current, null, 'GBP');
    expect(blind.recommendations.some(item => item.title.includes('لا توقع'))).toBe(true);
    expect(blind.recommendations.some(item => item.basis === 'estimate')).toBe(false);
  });
  it('blocks a launch without conversion tracking', async () => {
    const current = await report();
    expect(campaignStrategy(brief, { ...current, conversionActions: [] }, null, 'GBP').blockers.join()).toContain('تحويل');
  });
  it('recommends nothing that spends before tracking is proven', async () => {
    const current = await report();
    const items = optimize({ ...current, conversionActions: current.conversionActions.map(action => ({ ...action, recordedConversions: 0 })) }, null);
    expect(items.map(item => item.type)).toEqual(['fix_conversion_tracking']);
  });
  it('uses thresholds and asks for approval on every change', async () => {
    const current = await report();
    const items = optimize(current, { searchTerms: { basis: 'observed', source: '', items: [{ term: 'free boxes', campaignId: '100', impressions: 90, clicks: 14, costMicros: '21000000', conversions: 0 }, { term: 'small sample', campaignId: '100', impressions: 5, clicks: 2, costMicros: '100', conversions: 0 }] } });
    expect(items.map(item => item.id)).toContain('negative-100-free boxes');
    expect(items.map(item => item.id)).not.toContain('negative-100-small sample');
    expect(items.map(item => item.type)).toContain('review_budget');
    expect(items.every(item => item.requiresApproval)).toBe(true);
    expect(JSON.stringify(items)).not.toMatch(/سيرتفع|ستزيد|will increase|guarantee/i);
  });
});

describe('evidence gates', () => {
  async function files() {
    const directory = await mkdtemp(join(tmpdir(), 'mohassan-ads-gates-'));
    const sourceDir = join(directory, 'src');
    await mkdir(sourceDir);
    await cp(new URL('../packages/google-ads/src/errors.ts', import.meta.url), join(sourceDir, 'errors.ts'));
    return { sourceDir, regressionFile: join(directory, 'regression.json'), liveCheckFile: join(directory, 'live.json') };
  }
  const passed = (gates: { id: string; passed: boolean }[], id: string) => gates.find(gate => gate.id === id)?.passed;

  it('stays closed with no evidence', async () => {
    const gates = await evidenceGates(await files(), CUSTOMER, false);
    expect([passed(gates, 'regression_runs'), passed(gates, 'live_read_check')]).toEqual([false, false]);
  });
  it('needs 20 runs of this exact code', async () => {
    const paths = await files(), sourceFingerprintValue = await sourceFingerprint(paths.sourceDir);
    await writeFile(paths.regressionFile, JSON.stringify({ consecutivePasses: 19, sourceFingerprint: sourceFingerprintValue }));
    expect(passed(await evidenceGates(paths, CUSTOMER, false), 'regression_runs')).toBe(false);
    await writeFile(paths.regressionFile, JSON.stringify({ consecutivePasses: 20, sourceFingerprint: sourceFingerprintValue }));
    expect(passed(await evidenceGates(paths, CUSTOMER, false), 'regression_runs')).toBe(true);
    await writeFile(join(paths.sourceDir, 'errors.ts'), `${await readFile(join(paths.sourceDir, 'errors.ts'), 'utf8')}\n// changed`);
    expect(passed(await evidenceGates(paths, CUSTOMER, false), 'regression_runs')).toBe(false);
  });
  it('binds the live check to the account and to a recent date', async () => {
    const paths = await files(), now = Date.parse('2026-11-06T12:00:00Z');
    const write = (value: object) => writeFile(paths.liveCheckFile, JSON.stringify({ passed: true, source: 'google-ads-api-live', customerId: CUSTOMER, checkedAt: '2026-11-05T12:00:00Z', ...value }));
    await write({});
    expect(passed(await evidenceGates(paths, CUSTOMER, false, now), 'live_read_check')).toBe(true);
    expect(passed(await evidenceGates(paths, '5555555555', false, now), 'live_read_check')).toBe(false);
    await write({ checkedAt: '2026-10-01T12:00:00Z' });
    expect(passed(await evidenceGates(paths, CUSTOMER, false, now), 'live_read_check')).toBe(false);
    await write({ source: 'mock' });
    expect(passed(await evidenceGates(paths, CUSTOMER, false, now), 'live_read_check')).toBe(false);
  });
  it('refuses a test account as a publishing target', async () => {
    expect(passed(await evidenceGates(await files(), CUSTOMER, true), 'production_account')).toBe(false);
  });
});
