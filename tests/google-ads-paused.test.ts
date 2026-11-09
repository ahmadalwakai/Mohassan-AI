import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type DatabaseHandle } from '@mohassan/database';
import { createGoogleAdsControl, googleAdsMigration, sourceFingerprint } from '@mohassan/google-ads';
import { brief, createMockGoogle, CUSTOMER, landingHtml } from './fixtures/google-ads-mock.ts';

describe('task-scoped paused Google Ads creation', () => {
  let store: DatabaseHandle, directory: string;
  beforeAll(async () => { store = await createDatabase(); await googleAdsMigration(store.db); await googleAdsMigration(store.db); directory = await mkdtemp(join(tmpdir(), 'mohassan-paused-')); });
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
});
