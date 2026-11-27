import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GoogleAdsAccountOptionSchema, GoogleAdsApprovalSchema, GoogleAdsAuditEntrySchema,
  GoogleAdsBookingMapSchema, GoogleAdsBriefSchema, GoogleAdsDraftActionSchema, GoogleAdsDraftSchema,
  GoogleAdsExperienceSchema, GoogleAdsMarketInputSchema, GoogleAdsMarketSchema, GoogleAdsRecommendationSchema,
  GoogleAdsReportSchema, GoogleAdsReviseSchema, GoogleAdsSelectAccountSchema, GoogleAdsStatusSchema,
  type GoogleAdsDraft,
} from '@mohassan/contracts';
import { REQUIRED_REGRESSION_RUNS, sourceFingerprint } from '@mohassan/google-ads';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { brief, createMockGoogle, CUSTOMER, landingHtml } from './fixtures/google-ads-mock.js';
import { checkError, checkJson, openClientApiApp } from './support/client-api-app.js';

const items = <Item>(schema: z.ZodType<Item>) => z.strictObject({ items: z.array(schema) });

// OAuth responses and publishing-gate fixtures follow the existing offline route tests (retrieved 2026-11-27).
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/tests/google-ads-api.test.ts#L16
it('validates the Google Ads replies through a real member session and the local Google stub', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mohassan-client-api-ads-'));
  let fixture: Awaited<ReturnType<typeof openClientApiApp>> | undefined;
  try {
    const sourceDir = fileURLToPath(new URL('../packages/google-ads/src', import.meta.url));
    const regressionFile = join(directory, 'regression.json');
    const liveCheckFile = join(directory, 'live.json');
    await Promise.all([
      writeFile(regressionFile, JSON.stringify({ consecutivePasses: REQUIRED_REGRESSION_RUNS, sourceFingerprint: await sourceFingerprint(sourceDir) })),
      writeFile(liveCheckFile, JSON.stringify({ passed: true, source: 'google-ads-api-live', customerId: CUSTOMER, checkedAt: new Date().toISOString() })),
    ]);
    const mock = createMockGoogle();
    fixture = await openClientApiApp({ googleAds: {
      clientId: 'fixture-ads-client', clientSecret: 'fixture-ads-client-secret', tokenKey: Buffer.alloc(32, 9).toString('base64'),
      publishingEnabled: true, gateFiles: { sourceDir, regressionFile, liveCheckFile },
      authorizationUrl: 'https://accounts.example.test/auth', sleep: async () => undefined,
      fetch: mock.fetch, fetchPage: async url => ({ status: 200, finalUrl: url, html: landingHtml(), contentLanguage: null }),
    } });
    const { send, setupOwner, inviteMember } = fixture;
    const member = await inviteMember(await setupOwner());
    const base = '/api/google-ads';
    const get = (path: string) => send('GET', `${base}/${path}`, member);
    const post = (path: string, body: object = {}, headers?: Record<string, string>) => send('POST', `${base}/${path}`, member, body, headers);

    checkError(await send('GET', `${base}/status`), 401, 'UNAUTHORIZED');
    expect(checkJson(await get('status'), 200, GoogleAdsStatusSchema).state).toBe('disconnected');
    const authorization = checkJson(await post('connect'), 200, z.strictObject({ authorizationUrl: z.url() }));
    const state = new URL(authorization.authorizationUrl).searchParams.get('state');
    expect(typeof state).toBe('string');
    const callbackPath = `oauth/callback?${new URLSearchParams({ code: 'good-code', state: state! })}`;
    const callback = await get(callbackPath);
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe('/?googleAds=connected#tools');
    checkError(await send('GET', `${base}/${callbackPath}`), 401, 'UNAUTHORIZED');
    const { items: accounts } = checkJson(await get('accounts'), 200, items(GoogleAdsAccountOptionSchema));
    expect(accounts.some(account => account.customerId === CUSTOMER)).toBe(true);
    const selection = GoogleAdsSelectAccountSchema.parse({ customerId: CUSTOMER, loginCustomerId: null });
    expect(checkJson(await post('accounts/select', selection), 200, GoogleAdsStatusSchema).state).toBe('connected');

    const report = checkJson(await get('report?days=30'), 200, GoogleAdsReportSchema);
    const [conversion] = report.conversionActions;
    expect(conversion).toBeDefined();
    const mapping = GoogleAdsBookingMapSchema.parse({ rules: [{ service: conversion!.name, conversionActions: [conversion!.resourceName] }] });
    checkJson(await post('booking-map', mapping), 200, z.strictObject({ ok: z.literal(true) }));
    checkJson(await get('recommendations?days=30'), 200, z.strictObject({
      report: GoogleAdsReportSchema, items: z.array(GoogleAdsRecommendationSchema),
    }));
    const market = GoogleAdsMarketInputSchema.parse({ seeds: ['house removals'], locations: brief.locations, countryCode: brief.countryCode });
    checkJson(await post('market', market), 200, GoogleAdsMarketSchema);
    mock.state.rateLimitNext = 50;
    const limited = await get('report');
    checkError(limited, 429, 'GOOGLE_ADS_RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    mock.state.rateLimitNext = 0;

    const createDraft = async () => checkJson(await post('drafts', GoogleAdsBriefSchema.parse(brief), { 'idempotency-key': randomUUID() }),
      200, GoogleAdsDraftSchema);
    const action = (draft: GoogleAdsDraft) => GoogleAdsDraftActionSchema.parse({ expectedRevision: draft.revision });
    const step = async (draft: GoogleAdsDraft, name: string, body: object = action(draft)) =>
      checkJson(await post(`drafts/${draft.id}/${name}`, body), 200, GoogleAdsDraftSchema);
    const approval = (draft: GoogleAdsDraft, draftHash = draft.draftHash) => GoogleAdsApprovalSchema.parse({
      expectedRevision: draft.revision, draftHash, customerId: draft.customerId,
    });
    async function approvePublish(preview: GoogleAdsDraft) {
      const saved = await step(preview, 'save');
      const validated = await step(saved, 'validate');
      const verified = await step(validated, 'verify');
      return step(verified, 'approve-publish', approval(verified));
    }

    const preview = await createDraft();
    const list = checkJson(await get('drafts'), 200, items(GoogleAdsDraftSchema));
    expect(list.items.some(draft => draft.id === preview.id)).toBe(true);
    checkJson(await get(`drafts/${preview.id}`), 200, GoogleAdsDraftSchema);
    checkError(await get(`drafts/${randomUUID()}`), 404, 'GOOGLE_ADS_DRAFT_MISSING');
    checkError(await post(`drafts/${preview.id}/publish`, action(preview)), 409, 'GOOGLE_ADS_STATE');
    const revised = await step(preview, 'revise', GoogleAdsReviseSchema.parse({
      ...action(preview), brief: { ...brief, dailyBudget: String(Number(brief.dailyBudget) + 1) },
    }));
    const approved = await approvePublish(revised);
    const published = await step(approved, 'publish');
    const launchHash = checkJson(await get(`drafts/${published.id}/launch-hash`), 200, z.strictObject({ hash: z.string().regex(/^[a-f0-9]{64}$/).nullable() }));
    const ready = await step(published, 'approve-launch', approval(published, launchHash.hash!));
    expect((await step(ready, 'launch')).state).toBe('live');

    const next = await approvePublish(await createDraft());
    mock.state.mutateFailure = 'lost_applied';
    checkError(await post(`drafts/${next.id}/publish`, action(next)), 409, 'GOOGLE_ADS_OUTCOME_UNKNOWN');
    const unknown = checkJson(await get(`drafts/${next.id}`), 200, GoogleAdsDraftSchema);
    expect((await step(unknown, 'reconcile')).state).toBe('published');
    expect((await step(await createDraft(), 'discard')).state).toBe('discarded');

    checkJson(await get('audit'), 200, items(GoogleAdsAuditEntrySchema));
    checkJson(await get('experiences'), 200, items(GoogleAdsExperienceSchema));
    expect(checkJson(await post('disconnect'), 200, GoogleAdsStatusSchema).state).toBe('disconnected');
  } finally {
    try { await fixture?.close(); } finally { await rm(directory, { recursive: true, force: true }); }
  }
});
