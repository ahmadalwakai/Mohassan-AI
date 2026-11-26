import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type DatabaseHandle } from '@mohassan/database';
import { createGoogleAdsControl, googleAdsMigration, sourceFingerprint } from '@mohassan/google-ads';
import { brief, createMockGoogle, CUSTOMER, landingHtml } from './fixtures/google-ads-mock.ts';

describe('task-scoped paused Google Ads creation', () => {
  let store: DatabaseHandle, directory: string;
  beforeAll(async () => { store = await createDatabase(); await googleAdsMigration(store.db); await googleAdsMigration(store.db); directory = await mkdtemp(join(tmpdir(), 'mohassan-paused-')); });
  // Every case uses the same fake account number with a different remote fixture.
  // Retain the cross-owner account fence within a case, not across independent cases.
  afterEach(async () => {
    await store.db.deleteFrom('google_ads_automatic_requests').execute();
    await store.db.deleteFrom('google_ads_drafts').execute();
  });
  afterAll(async () => { await store?.close(); await rm(directory, { recursive: true, force: true }); });
  async function fixture(options: { enabled?: boolean; proven?: boolean; fetchOverride?: (base: typeof fetch) => typeof fetch } = {}) {
    const ownerId = randomUUID(), mock = createMockGoogle(), root = join(directory, ownerId), sourceDir = join(root, 'src');
    await mkdir(sourceDir, { recursive: true }); await writeFile(join(sourceDir, 'fixture.ts'), 'export const fixture = true;');
    const regressionFile = join(root, 'regression.json'), liveCheckFile = join(root, 'live.json');
    if (options.proven !== false) {
      await writeFile(regressionFile, JSON.stringify({ consecutivePasses: 20, sourceFingerprint: await sourceFingerprint(sourceDir) }));
      await writeFile(liveCheckFile, JSON.stringify({ source: 'google-ads-api-live', passed: true, customerId: CUSTOMER, checkedAt: new Date().toISOString() }));
    }
    const control = createGoogleAdsControl(store.db, { clientId: 'fixture-id', clientSecret: 'fixture-secret', tokenKey: Buffer.alloc(32, 8).toString('base64'), webOrigin: 'http://127.0.0.1:3000', publishingEnabled: options.enabled !== false, fetch: options.fetchOverride?.(mock.fetch) ?? mock.fetch, sleep: async () => undefined, gateFiles: { sourceDir, regressionFile, liveCheckFile }, fetchPage: async url => ({ status: 200, finalUrl: url, html: landingHtml(), contentLanguage: null }) });
    const url = new URL(await control.authorizationUrl(ownerId));
    await control.completeAuthorization(ownerId, 'good-code', url.searchParams.get('state')!);
    await control.selectAccount(ownerId, CUSTOMER, null);
    return { ownerId, mock, control, sourceDir };
  }
  const authority = { assertActive: async () => undefined };
  it('runs quality, independent validation and one creation-only mutation, then requires PAUSED readback', async () => {
    const f = await fixture(); f.mock.state.campaigns.push({ name: 'Existing', status: 'ENABLED', resourceName: `customers/${CUSTOMER}/campaigns/100`, budget: '10000000' });
    const saved = await f.control.createPausedCampaign(f.ownerId, brief, 'chat-paused-one', authority);
    expect(saved.state).toBe('published'); expect(saved.campaignResourceName).toBe(`customers/${CUSTOMER}/campaigns/777`);
    const writes = f.mock.mutations.filter(item => !item.validateOnly);
    expect(writes).toHaveLength(1); expect(f.mock.mutations.some(item => item.validateOnly)).toBe(true);
    expect(writes[0].operations.every(operation => Object.values(operation).every((body: any) => Boolean(body.create) && !body.update && !body.remove))).toBe(true);
    expect(writes[0].operations.find(operation => operation.campaignOperation)?.campaignOperation.create.status).toBe('PAUSED');
    expect(f.mock.state.campaigns[0]).toMatchObject({ status: 'ENABLED', budget: '10000000' });
    expect((await f.control.createPausedCampaign(f.ownerId, brief, 'chat-paused-one', authority)).id).toBe(saved.id);
    expect(f.mock.mutations.filter(item => !item.validateOnly)).toHaveLength(1);
  });
  it('allows a paused campaign with an honest tracking warning but refuses owner launch until tracking is proven', async () => {
    const f = await fixture(); f.mock.state.conversionsRecorded = 0;
    const paused = await f.control.createPausedCampaign(f.ownerId, brief, 'chat-no-conversions', authority);
    expect(paused.state).toBe('published'); expect(paused.verification?.checks.find(check => check.id === 'conversion_tracking')?.passed).toBe(false);
    const approved = await f.control.approve(f.ownerId, paused.id, 'launch', paused.revision, f.control.launchHashFor(paused)!, CUSTOMER);
    await expect(f.control.launch(f.ownerId, paused.id, approved.revision)).rejects.toMatchObject({ code: 'GOOGLE_ADS_CONVERSIONS_REQUIRED' });
    expect(f.mock.mutations.filter(item => !item.validateOnly)).toHaveLength(1); expect(f.mock.state.campaigns[0].status).toBe('PAUSED');
  });
  it('does not bypass server switch, current regression fingerprint or a live account check', async () => {
    for (const options of [{ enabled: false }, { proven: false }]) {
      const f = await fixture(options);
      await expect(f.control.createPausedCampaign(f.ownerId, brief, 'chat-gated-one', authority)).rejects.toMatchObject({ code: 'GOOGLE_ADS_PUBLISHING_CLOSED' });
      expect(f.mock.mutations).toHaveLength(0);
    }
    const f = await fixture(); await writeFile(join(f.sourceDir, 'fixture.ts'), 'export const fixture = false;');
    await expect(f.control.createPausedCampaign(f.ownerId, brief, 'chat-gated-changed', authority)).rejects.toMatchObject({ code: 'GOOGLE_ADS_PUBLISHING_CLOSED' });
  });
  it('retains an unknown result without automatically writing again, even after an explicit readback', async () => {
    const f = await fixture(); f.mock.state.mutateFailure = 'lost_applied';
    await expect(f.control.createPausedCampaign(f.ownerId, brief, 'chat-lost-one', authority)).rejects.toMatchObject({ code: 'GOOGLE_ADS_OUTCOME_UNKNOWN' });
    const retried = await f.control.createPausedCampaign(f.ownerId, brief, 'chat-lost-one', authority);
    expect(retried.state).toBe('outcome_unknown'); expect(f.mock.mutations.filter(item => !item.validateOnly)).toHaveLength(1);
    expect((await f.control.reconcile(f.ownerId, retried.id, retried.revision)).state).toBe('published');
    await f.control.createPausedCampaign(f.ownerId, brief, 'chat-lost-one', authority);
    expect(f.mock.mutations.filter(item => !item.validateOnly)).toHaveLength(1);
  });
  it('single-use request receipt fences concurrent calls and rejects conflicting same-key content', async () => {
    const f = await fixture();
    const results = await Promise.allSettled([1, 2].map(() => f.control.createPausedCampaign(f.ownerId, brief, 'chat-race-one', authority)));
    expect(results.some(result => result.status === 'fulfilled' && result.value.state === 'published')).toBe(true);
    expect(f.mock.mutations.filter(item => !item.validateOnly)).toHaveLength(1);
    await expect(f.control.createPausedCampaign(f.ownerId, { ...brief, dailyBudget: '21' }, 'chat-race-one', authority)).rejects.toMatchObject({ code: 'GOOGLE_ADS_IDEMPOTENCY' });
  });
  it('revokes the effect at the final task-authority check without a real mutation', async () => {
    const f = await fixture(); let checks = 0;
    await expect(f.control.createPausedCampaign(f.ownerId, brief, 'chat-cancel-one', { assertActive: async () => { if (++checks === 4) throw new Error('cancelled'); } })).rejects.toThrow('cancelled');
    expect(checks).toBe(4); expect(f.mock.mutations.filter(item => !item.validateOnly)).toHaveLength(0);
    expect((await f.control.drafts(f.ownerId))[0].state).toBe('failed');
  });
  it('does not report a campaign as paused if account readback instead returns ENABLED', async () => {
    const f = await fixture({ fetchOverride: base => async (input, init) => {
      const response = await base(input, init);
      if (String(init?.body).includes('WHERE campaign.name =')) {
        const data = await response.json() as any[];
        for (const result of data[0]?.results ?? []) if (result.campaign) result.campaign.status = 'ENABLED';
        return Response.json(data);
      }
      return response;
    } });
    await expect(f.control.createPausedCampaign(f.ownerId, brief, 'chat-status-one', authority)).rejects.toMatchObject({ code: 'GOOGLE_ADS_PAUSED_UNCONFIRMED' });
    expect((await f.control.drafts(f.ownerId))[0].state).toBe('failed');
    expect(await f.control.experiences(f.ownerId)).toHaveLength(0);
  });
  it.each([
    ['landing URL', 'ad.finalUrls', (data: any[]) => { data[0].results[0].adGroupAd.ad.finalUrls = ['https://other.example.com']; }, 'FROM ad_group_ad WHERE'],
    ['ad text', 'ad.headlines', (data: any[]) => { data[0].results[0].adGroupAd.ad.responsiveSearchAd.headlines[0].text = 'Unapproved offer'; }, 'FROM ad_group_ad WHERE'],
    ['keywords', 'adGroup.keywords', (data: any[]) => { data[0].results.pop(); }, 'FROM ad_group_criterion WHERE'],
    ['location', 'campaign.locations', (data: any[]) => { data[0].results[0].campaignCriterion.location.geoTargetConstant = 'geoTargetConstants/999'; }, 'FROM campaign_criterion WHERE'],
    ['network', 'campaign.networkSettings.targetContentNetwork', (data: any[]) => { data[0].results[0].campaign.networkSettings.targetContentNetwork = true; }, 'FROM campaign WHERE campaign.resource_name'],
    ['ad group', 'adGroup.name', (data: any[]) => { data[0].results[0].adGroup.name = 'Other service'; }, 'FROM ad_group WHERE'],
  ])('rejects an applied mutation when fresh %s differs and persists the field-level evidence', async (_name, field, alter, query) => {
    const f = await fixture({ fetchOverride: base => async (input, init) => {
      const response = await base(input, init);
      if (String(init?.body).includes(query)) { const data = await response.json() as any[]; alter(data); return Response.json(data); }
      return response;
    } });
    await expect(f.control.createPausedCampaign(f.ownerId, brief, `chat-mismatch-${field.replaceAll('.', '-')}`, authority)).rejects.toMatchObject({ code: 'GOOGLE_ADS_PAUSED_UNCONFIRMED' });
    const draft = (await f.control.drafts(f.ownerId))[0];
    expect(draft.state).toBe('failed');
    expect(draft.readback).toMatchObject({ passed: false, customerId: CUSTOMER });
    expect(draft.readback?.fields.find(item => item.field === field)?.passed).toBe(false);
    expect(f.mock.mutations.filter(item => !item.validateOnly)).toHaveLength(1);
    expect(await f.control.experiences(f.ownerId)).toHaveLength(0);
  });
  it('binds paused creation to the planned account, currency and time zone before preparing or writing', async () => {
    const f = await fixture();
    for (const binding of [{ customerId: '9999999999' }, { currency: 'USD' }, { timeZone: 'America/New_York' }]) {
      await expect(f.control.createPausedCampaign(f.ownerId, brief, 'chat-account-binding', { ...authority, ...binding })).rejects.toMatchObject({ code: 'GOOGLE_ADS_ACCOUNT_CHANGED' });
    }
    expect(f.mock.mutations).toHaveLength(0);
    expect(await f.control.drafts(f.ownerId)).toHaveLength(0);
  });
  it('matches the returned campaign identifier rather than a same-name resource', async () => {
    const f = await fixture({ fetchOverride: base => async (input, init) => {
      const response = await base(input, init);
      if (String(input).endsWith('googleAds:mutate') && !JSON.parse(String(init?.body)).validateOnly) return Response.json({ requestId: 'receipt-other-resource', mutateOperationResponses: [{ campaignResult: { resourceName: `customers/${CUSTOMER}/campaigns/888` } }] });
      return response;
    } });
    await expect(f.control.createPausedCampaign(f.ownerId, brief, 'chat-resource-binding', authority)).rejects.toMatchObject({ code: 'GOOGLE_ADS_PAUSED_UNCONFIRMED' });
    expect((await f.control.drafts(f.ownerId))[0].state).toBe('failed');
    expect(await f.control.experiences(f.ownerId)).toHaveLength(0);
  });
  it('reconciles an unexpected partial response using readback without repeating successful operations', async () => {
    const f = await fixture({ fetchOverride: base => async (input, init) => {
      const response = await base(input, init);
      if (String(input).endsWith('googleAds:mutate') && !JSON.parse(String(init?.body)).validateOnly) return Response.json({ partialFailureError: { code: 3, message: 'untrusted provider detail' } });
      return response;
    } });
    await expect(f.control.createPausedCampaign(f.ownerId, brief, 'chat-partial-receipt', authority)).rejects.toMatchObject({ code: 'GOOGLE_ADS_OUTCOME_UNKNOWN' });
    const unknown = (await f.control.drafts(f.ownerId))[0];
    expect(unknown.state).toBe('outcome_unknown');
    const reconciled = await f.control.reconcile(f.ownerId, unknown.id, unknown.revision);
    expect(reconciled.state).toBe('published');
    expect(reconciled.readback?.passed).toBe(true);
    expect(f.mock.mutations.filter(item => !item.validateOnly)).toHaveLength(1);
  });
  it('refreshes evidence on an already-published campaign without resubmitting a mutation', async () => {
    const f = await fixture();
    const saved = await f.control.createPausedCampaign(f.ownerId, brief, 'chat-recheck-one', authority);
    expect(saved.readback).toMatchObject({ passed: true, requestId: 'req-mutate', campaignResourceName: saved.campaignResourceName });
    expect(saved.readback?.fields.length).toBeGreaterThan(20);
    f.mock.state.campaigns[0].operations!.find(operation => operation.adGroupAdOperation).adGroupAdOperation.create.ad.finalUrls = ['https://changed.example.com'];
    const refreshed = await f.control.reconcile(f.ownerId, saved.id, saved.revision);
    expect(refreshed.state).toBe('failed');
    expect(refreshed.readback?.fields.find(field => field.field === 'ad.finalUrls')?.passed).toBe(false);
    await expect(f.control.revise(f.ownerId, refreshed.id, refreshed.revision, brief)).rejects.toMatchObject({ code: 'GOOGLE_ADS_STATE' });
    await expect(f.control.discard(f.ownerId, refreshed.id, refreshed.revision)).rejects.toMatchObject({ code: 'GOOGLE_ADS_STATE' });
    await expect(f.control.createPausedCampaign(f.ownerId, brief, 'chat-after-readback-mismatch', authority)).rejects.toMatchObject({ code: 'GOOGLE_ADS_WRITE_CONFLICT' });
    // An existing remote effect remains recoverable by a fresh read; never
    // interpret the local failed verdict as permission to create a replacement.
    f.mock.state.campaigns[0].operations!.find(operation => operation.adGroupAdOperation).adGroupAdOperation.create.ad.finalUrls = [brief.landingPageUrl];
    const recovered = await f.control.reconcile(f.ownerId, refreshed.id, refreshed.revision);
    expect(recovered.state).toBe('published'); expect(recovered.readback?.passed).toBe(true);
    expect(f.mock.mutations.filter(item => !item.validateOnly)).toHaveLength(1);
  });
  it('supports explicitly enabled paused test-account creation while refusing test-account launch', async () => {
    const f = await fixture(); f.mock.state.testAccount = true;
    await f.control.selectAccount(f.ownerId, CUSTOMER, null);
    const saved = await f.control.createPausedCampaign(f.ownerId, brief, 'chat-test-account', { ...authority, customerId: CUSTOMER, currency: 'GBP', timeZone: 'Europe/London' });
    expect(saved.state).toBe('published'); expect(saved.readback?.passed).toBe(true);
    const approved = await f.control.approve(f.ownerId, saved.id, 'launch', saved.revision, f.control.launchHashFor(saved)!, CUSTOMER);
    await expect(f.control.launch(f.ownerId, saved.id, approved.revision)).rejects.toMatchObject({ code: 'GOOGLE_ADS_TEST_ACCOUNT_LAUNCH' });
    expect(f.mock.mutations.filter(item => !item.validateOnly)).toHaveLength(1);
  });
  it('keeps absence after a lost response unknown and can discover a later commit without re-creating', async () => {
    let hideCampaign = true;
    const f = await fixture({ fetchOverride: base => async (input, init) => {
      const response = await base(input, init);
      if (hideCampaign && String(init?.body).includes('WHERE campaign.name =')) return Response.json([{ results: [] }]);
      return response;
    } });
    f.mock.state.mutateFailure = 'lost_applied';
    await expect(f.control.createPausedCampaign(f.ownerId, brief, 'chat-delayed-commit', authority)).rejects.toMatchObject({ code: 'GOOGLE_ADS_OUTCOME_UNKNOWN' });
    const unknown = (await f.control.drafts(f.ownerId))[0];
    const absent = await f.control.reconcile(f.ownerId, unknown.id, unknown.revision);
    expect(absent.state).toBe('outcome_unknown'); expect(absent.readback?.passed).toBe(false);
    hideCampaign = false;
    const found = await f.control.reconcile(f.ownerId, absent.id, absent.revision);
    expect(found.state).toBe('published'); expect(found.readback?.passed).toBe(true);
    expect(f.mock.mutations.filter(item => !item.validateOnly)).toHaveLength(1);
  });
  it('does not let concurrent reconciliation release an in-flight mutation claim', async () => {
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture({ fetchOverride: base => async (input, init) => {
      if (String(input).endsWith('googleAds:mutate') && !JSON.parse(String(init?.body)).validateOnly) { enter(); await pending; }
      return base(input, init);
    } });
    const running = f.control.createPausedCampaign(f.ownerId, brief, 'chat-inflight-claim', authority);
    await entered;
    try {
      const draft = (await f.control.drafts(f.ownerId))[0];
      expect(draft.state).toBe('publishing');
      await expect(f.control.reconcile(f.ownerId, draft.id, draft.revision)).rejects.toMatchObject({ code: 'GOOGLE_ADS_RECONCILE_PENDING' });
      expect((await f.control.draft(f.ownerId, draft.id)).state).toBe('publishing');
    } finally { release(); }
    expect((await running).state).toBe('published');
    expect(f.mock.mutations.filter(item => !item.validateOnly)).toHaveLength(1);
  });
  it('fences separate writers on the same account across distinct operation keys', async () => {
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture({ fetchOverride: base => async (input, init) => {
      if (String(input).endsWith('googleAds:mutate') && !JSON.parse(String(init?.body)).validateOnly) { enter(); await pending; }
      return base(input, init);
    } });
    const first = f.control.createPausedCampaign(f.ownerId, brief, 'writer-account-one', authority);
    await entered;
    try {
      await expect(f.control.createPausedCampaign(f.ownerId, { ...brief, dailyBudget: '21' }, 'writer-account-two', authority)).rejects.toMatchObject({ code: 'GOOGLE_ADS_WRITE_CONFLICT' });
    } finally { release(); }
    expect((await first).state).toBe('published');
    expect(f.mock.mutations.filter(item => !item.validateOnly)).toHaveLength(1);
  });
  it('does not create a recent identical campaign again under a different local key', async () => {
    const f = await fixture();
    await f.control.createPausedCampaign(f.ownerId, brief, 'duplicate-account-one', authority);
    await expect(f.control.createPausedCampaign(f.ownerId, brief, 'duplicate-account-two', authority)).rejects.toMatchObject({ code: 'GOOGLE_ADS_DUPLICATE_REVIEW_REQUIRED' });
    expect(f.mock.mutations.filter(item => !item.validateOnly)).toHaveLength(1);
  });
  it('blocks a different owner on the same account after an applied write fails readback', async () => {
    const first = await fixture({ fetchOverride: base => async (input, init) => {
      const response = await base(input, init);
      if (String(init?.body).includes('FROM ad_group_ad WHERE')) {
        const data = await response.json() as any[];
        data[0].results[0].adGroupAd.ad.finalUrls = ['https://other.example.com'];
        return Response.json(data);
      }
      return response;
    } });
    await expect(first.control.createPausedCampaign(first.ownerId, brief, 'writer-failed-remote', authority)).rejects.toMatchObject({ code: 'GOOGLE_ADS_PAUSED_UNCONFIRMED' });
    const second = await fixture();
    await expect(second.control.createPausedCampaign(second.ownerId, brief, 'writer-other-owner', authority)).rejects.toMatchObject({ code: 'GOOGLE_ADS_WRITE_CONFLICT' });
    expect(first.mock.mutations.filter(item => !item.validateOnly)).toHaveLength(1);
    expect(second.mock.mutations.filter(item => !item.validateOnly)).toHaveLength(0);
  });
  it('rejects a report for an unexpected selected account before reading remote data', async () => {
    const f = await fixture(), before = f.mock.calls.length;
    await expect(f.control.report(f.ownerId, 30, '9999999999')).rejects.toMatchObject({ code: 'GOOGLE_ADS_ACCOUNT_CHANGED' });
    expect(f.mock.calls).toHaveLength(before);
  });
  it('scopes verified remote lessons to their account and expires stale advice while retaining local validation rules', async () => {
    const f = await fixture(), common = { category: 'policy', code: 'POLICY_FINDING', strategy: 'rewrite', succeeded: false };
    await f.control.lessons.record(f.ownerId, { ...common, verifiedBy: 'local_validator' });
    await f.control.lessons.record(f.ownerId, { ...common, customerId: CUSTOMER, verifiedBy: 'google_validate_only' });
    await f.control.lessons.record(f.ownerId, { ...common, customerId: '9999999999', verifiedBy: 'google_validate_only', succeeded: true });
    await expect(f.control.lessons.record(f.ownerId, { ...common, verifiedBy: 'google_readback' })).rejects.toMatchObject({ code: 'GOOGLE_ADS_LESSON_SCOPE' });
    expect(await f.control.lessons.list(f.ownerId)).toEqual([expect.objectContaining({ source: 'local_validator', customerId: null, applicability: 'local_validation', updatedAt: expect.any(String) })]);
    const current = await f.control.lessons.list(f.ownerId, CUSTOMER);
    expect(current).toHaveLength(2);
    expect(current.find(item => item.verifiedBy === 'google_validate_only')).toMatchObject({ customerId: CUSTOMER, successes: 0, failures: 1, applicability: 'account' });
    expect((await f.control.lessons.list(f.ownerId, '9999999999')).find(item => item.verifiedBy === 'google_validate_only')).toMatchObject({ successes: 1, failures: 0 });
    await store.db.updateTable('google_ads_recovery_lessons').set({ updated_at: new Date(Date.now() - 31 * 86400000) }).where('owner_id', '=', f.ownerId).execute();
    expect(await f.control.lessons.list(f.ownerId, CUSTOMER)).toHaveLength(0);
  });
});
