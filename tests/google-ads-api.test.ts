import { mkdtemp, mkdir, writeFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GoogleAdsStatusSchema } from '@mohassan/contracts';
import { sourceFingerprint, type GoogleAdsConfig } from '@mohassan/google-ads';
import { createApplication } from '../apps/server/src/app.js';
import { brief, createMockGoogle, CHILD, CUSTOMER, landingHtml, MANAGER, type MockGoogle } from './fixtures/google-ads-mock.js';

const secret = 'google-ads-api-internal-secret-00000001', origin = 'http://127.0.0.1:3000', setupToken = 'google-ads-api-setup-token-000000001';
const tokenKey = Buffer.alloc(32, 9).toString('base64');
type App = Awaited<ReturnType<typeof createApplication>>;
const open: App[] = [];
afterEach(async () => { await Promise.all(open.splice(0).map(application => application.app.close())); });

async function evidence(customerId: string | null) {
  const directory = await mkdtemp(join(tmpdir(), 'mohassan-ads-api-'));
  const sourceDir = join(directory, 'src'), regressionFile = join(directory, 'regression.json'), liveCheckFile = join(directory, 'live.json');
  await mkdir(sourceDir);
  await cp(new URL('../packages/google-ads/src/errors.ts', import.meta.url), join(sourceDir, 'errors.ts'));
  if (customerId) {
    await writeFile(regressionFile, JSON.stringify({ consecutivePasses: 20, sourceFingerprint: await sourceFingerprint(sourceDir) }));
    await writeFile(liveCheckFile, JSON.stringify({ passed: true, source: 'google-ads-api-live', customerId, checkedAt: new Date().toISOString() }));
  }
  return { sourceDir, regressionFile, liveCheckFile };
}

async function start(options: { configured?: boolean; publishing?: boolean; proven?: boolean; page?: GoogleAdsConfig['fetchPage'] } = {}) {
  const mock = createMockGoogle(), { configured = true, publishing = true, proven = true } = options;
  const directory = await mkdtemp(join(tmpdir(), 'mohassan-ads-app-'));
  const application = await createApplication({
    authSecret: 'google-ads-api-auth-secret-000000000001', internalSecret: secret, setupToken, webOrigin: origin, production: false, runWorker: false, codingAllowedRoots: [directory], browserProfileDir: join(directory, 'profile'), browserChannel: null, testRequestLimit: 2000,
    googleAds: { ...(configured ? { clientId: 'client-id', clientSecret: 'client-secret', tokenKey } : {}), publishingEnabled: publishing, fetch: mock.fetch, sleep: async () => undefined, gateFiles: await evidence(proven ? CUSTOMER : null), authorizationUrl: 'https://accounts.example.test/auth', fetchPage: options.page ?? (async url => ({ status: 200, finalUrl: url, html: landingHtml(), contentLanguage: null })) },
  });
  open.push(application);
  const app = application.app, account = { email: 'owner@example.test', password: 'Google-ads-api-password-42', name: 'Ads owner' };
  await app.inject({ method: 'POST', url: '/api/setup', headers: { 'x-mohassan-internal': secret, origin }, payload: { ...account, setupToken } });
  const login = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: { 'x-mohassan-internal': secret, origin }, payload: account });
  const cookie = [login.headers['set-cookie']].flat().filter(Boolean).map(value => String(value).split(';')[0]).join('; ');
  const headers = { 'x-mohassan-internal': secret, origin, cookie };
  const get = (url: string) => app.inject({ url, headers });
  const post = (url: string, payload: object = {}, extra: Record<string, string> = {}) => app.inject({ method: 'POST', url, headers: { ...headers, ...extra }, payload });
  return { application, mock, get, post, headers, app };
}

type Harness = Awaited<ReturnType<typeof start>>;

async function connect({ post, get }: Harness) {
  const authorization = (await post('/api/google-ads/connect')).json().authorizationUrl as string;
  const state = new URL(authorization).searchParams.get('state')!;
  const callback = await get(`/api/google-ads/oauth/callback?code=good-code&state=${state}`);
  expect(callback.statusCode).toBe(302);
  expect(callback.headers.location).toContain('connected');
  expect((await post('/api/google-ads/accounts/select', { customerId: CUSTOMER, loginCustomerId: null })).statusCode).toBe(200);
}

async function step(harness: Harness, draft: any, name: string, extra: object = {}) {
  const response = await harness.post(`/api/google-ads/drafts/${draft.id}/${name}`, { expectedRevision: draft.revision, ...extra });
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}

async function verified(harness: Harness, key = 'draft-key-0001') {
  const created = await harness.post('/api/google-ads/drafts', brief, { 'idempotency-key': key });
  expect(created.statusCode, created.body).toBe(200);
  const saved = await step(harness, created.json(), 'save');
  const valid = await step(harness, saved, 'validate');
  expect(valid.state, JSON.stringify(valid.validation?.issues)).toBe('validated');
  const checked = await step(harness, valid, 'verify');
  expect(checked.state, JSON.stringify(checked.verification?.checks)).toBe('verified');
  return checked;
}

const approve = (harness: Harness, draft: any, hash = draft.draftHash, customerId = CUSTOMER) => harness.post(`/api/google-ads/drafts/${draft.id}/approve-publish`, { expectedRevision: draft.revision, draftHash: hash, customerId });
const writes = (mock: MockGoogle) => mock.mutations.filter(item => !item.validateOnly);

describe('connection states', () => {
  it('reports not configured with setting names, and no values', async () => {
    const { get, post } = await start({ configured: false });
    const status = (await get('/api/google-ads/status')).json();
    expect(GoogleAdsStatusSchema.parse(status)).toMatchObject({ state: 'not_configured', missingSettings: ['GOOGLE_ADS_CLIENT_ID', 'GOOGLE_ADS_CLIENT_SECRET', 'GOOGLE_ADS_TOKEN_KEY'] });
    expect(status.publishing.available).toBe(false);
    expect((await post('/api/google-ads/connect')).statusCode).toBe(409);
  });
  it('requires a session on every route', async () => {
    const { app } = await start();
    const noSession = { 'x-mohassan-internal': secret, origin };
    for (const url of ['/api/google-ads/status', '/api/google-ads/report', '/api/google-ads/drafts', '/api/google-ads/accounts', '/api/google-ads/audit']) expect((await app.inject({ url, headers: noSession })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/google-ads/connect', headers: noSession, payload: {} })).statusCode).toBe(401);
  });
  it('uses PKCE, a single-use state and the exact scope', async () => {
    const harness = await start(), { post, get, mock } = harness;
    const url = new URL((await post('/api/google-ads/connect')).json().authorizationUrl);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ scope: 'https://www.googleapis.com/auth/adwords', access_type: 'offline', code_challenge_method: 'S256', redirect_uri: `${origin}/api/google-ads/oauth/callback` });
    const state = url.searchParams.get('state')!;
    expect((await get(`/api/google-ads/oauth/callback?code=good-code&state=${state}`)).headers.location).toContain('connected');
    expect((await get(`/api/google-ads/oauth/callback?code=good-code&state=${state}`)).headers.location).toContain('failed');
    expect(mock.calls.find(call => call.body?.grant_type === 'authorization_code')?.body.code_verifier).toBeTruthy();
  });
  it('rejects a forged state and a denied consent without echoing input', async () => {
    const { get } = await start();
    expect((await get('/api/google-ads/oauth/callback?code=good-code&state=forged-state-value-000')).headers.location).toContain('failed');
    const denied = await get('/api/google-ads/oauth/callback?error=access_denied&state=<script>');
    expect(denied.headers.location).toBe('/?googleAds=denied#tools');
  });
  it('fails when Google gives no refresh token', async () => {
    const harness = await start(); harness.mock.state.refreshIssued = false;
    const state = new URL((await harness.post('/api/google-ads/connect')).json().authorizationUrl).searchParams.get('state');
    expect((await harness.get(`/api/google-ads/oauth/callback?code=good-code&state=${state}`)).headers.location).toContain('failed');
    expect((await harness.get('/api/google-ads/status')).json().state).toBe('disconnected');
  });
  it('stores the token encrypted and never returns it', async () => {
    const harness = await start();
    await connect(harness);
    const row = await harness.application.database.db.selectFrom('google_ads_connections' as never).selectAll().executeTakeFirstOrThrow() as { sealed_refresh_token: string };
    expect(row.sealed_refresh_token.startsWith('v1.')).toBe(true);
    expect(row.sealed_refresh_token).not.toContain('refresh-token-secret');
    for (const url of ['/api/google-ads/status', '/api/google-ads/audit', '/api/google-ads/accounts']) expect((await harness.get(url)).body).not.toContain('refresh-token-secret');
    const audit = await harness.application.database.db.selectFrom('google_ads_audit' as never).selectAll().execute();
    expect(JSON.stringify(audit)).not.toContain('refresh-token-secret');
  });
  it('lists direct and manager-linked accounts', async () => {
    const harness = await start();
    const state = new URL((await harness.post('/api/google-ads/connect')).json().authorizationUrl).searchParams.get('state');
    await harness.get(`/api/google-ads/oauth/callback?code=good-code&state=${state}`);
    expect((await harness.get('/api/google-ads/status')).json().state).toBe('needs_account');
    const { items } = (await harness.get('/api/google-ads/accounts')).json();
    expect(items.map((item: { customerId: string; loginCustomerId: string | null }) => [item.customerId, item.loginCustomerId])).toEqual([[CUSTOMER, null], [MANAGER, null], [CHILD, MANAGER]]);
    expect((await harness.post('/api/google-ads/accounts/select', { customerId: MANAGER, loginCustomerId: null })).json().error.code).toBe('GOOGLE_ADS_MANAGER_ACCOUNT');
  });
  it('moves to unauthorized when Google revokes access, and recovers by reconnecting', async () => {
    const harness = await start();
    await connect(harness);
    harness.mock.state.accessRejected = true;
    expect((await harness.get('/api/google-ads/report')).statusCode).toBe(401);
    const status = (await harness.get('/api/google-ads/status')).json();
    expect(status).toMatchObject({ state: 'unauthorized' });
    expect(status.publishing.available).toBe(false);
    expect((await harness.get('/api/google-ads/report')).statusCode).toBe(401);
    expect((await harness.get('/api/google-ads/audit')).json().items.map((item: { type: string }) => item.type)).toContain('authorization_lost');
    harness.mock.state.accessRejected = false;
    await connect(harness);
    expect((await harness.get('/api/google-ads/status')).json().state).toBe('connected');
  });
  it('shows rate limiting with a wait, then recovers', async () => {
    const harness = await start();
    await connect(harness);
    harness.mock.state.rateLimitNext = 50;
    const response = await harness.get('/api/google-ads/report');
    expect(response.statusCode).toBe(429);
    expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
    const status = (await harness.get('/api/google-ads/status')).json();
    expect(status.state).toBe('rate_limited');
    expect(status.retryAfterSeconds).toBeGreaterThan(0);
    harness.mock.state.rateLimitNext = 0;
    expect((await harness.get('/api/google-ads/report')).statusCode).toBe(200);
    expect((await harness.get('/api/google-ads/status')).json().state).toBe('connected');
  });
  it('disconnects, revokes at Google and erases the token', async () => {
    const harness = await start();
    await connect(harness);
    expect((await harness.post('/api/google-ads/disconnect')).json().state).toBe('disconnected');
    expect(harness.mock.calls.some(call => call.url.includes('/revoke'))).toBe(true);
    const row = await harness.application.database.db.selectFrom('google_ads_connections' as never).selectAll().executeTakeFirstOrThrow() as { sealed_refresh_token: string | null };
    expect(row.sealed_refresh_token).toBeNull();
    expect((await harness.get('/api/google-ads/report')).statusCode).toBe(409);
  });
  it('shows a real connection on the integrations card', async () => {
    const harness = await start();
    const card = async () => (await harness.get('/api/workspace')).json().integrations.find((item: { id: string }) => item.id === 'ads');
    expect((await card()).status).toBe('needs_configuration');
    await connect(harness);
    expect((await card()).status).toBe('connected');
  });
});

describe('reports', () => {
  it('returns observed figures and rejects unsupported ranges', async () => {
    const harness = await start();
    await connect(harness);
    const report = (await harness.get('/api/google-ads/report?days=30')).json();
    expect(report).toMatchObject({ basis: 'observed', currency: 'GBP', totals: { clicks: 310 } });
    expect((await harness.get('/api/google-ads/report?days=31')).statusCode).toBe(400);
  });
  it('keeps booking counts separate per mapped service and refuses double counting', async () => {
    const harness = await start();
    await connect(harness);
    const action = `customers/${CUSTOMER}/conversionActions/11`, other = `customers/${CUSTOMER}/conversionActions/12`;
    expect((await harness.post('/api/google-ads/booking-map', { rules: [{ service: 'A one', conversionActions: [action] }, { service: 'B two', conversionActions: [action] }] })).statusCode).toBe(400);
    expect((await harness.post('/api/google-ads/booking-map', { rules: [{ service: 'A one', conversionActions: ['customers/5555555555/conversionActions/1'] }] })).statusCode).toBe(400);
    expect((await harness.post('/api/google-ads/booking-map', { rules: [{ service: 'A one', conversionActions: [action] }, { service: 'B two', conversionActions: [other] }] })).statusCode).toBe(200);
    expect((await harness.get('/api/google-ads/report')).json().bookings.services.map((item: { completedBookings: number }) => item.completedBookings)).toEqual([7, 2]);
  });
  it('separates observed search terms from Keyword Planner estimates', async () => {
    const harness = await start();
    await connect(harness);
    const market = (await harness.post('/api/google-ads/market', { seeds: ['house removals'], locations: ['Glasgow'], countryCode: 'GB' })).json();
    expect(market.keywordIdeas).toMatchObject({ status: 'available', basis: 'estimate' });
    expect(market.searchTerms.basis).toBe('observed');
  });
  it('still answers with observed data when Explorer access blocks keyword planning', async () => {
    const harness = await start();
    await connect(harness);
    harness.mock.state.keywordPlanDenied = true;
    const market = (await harness.post('/api/google-ads/market', { seeds: ['house removals'] })).json();
    expect(market.keywordIdeas).toMatchObject({ status: 'unavailable', items: [] });
    expect(market.searchTerms.items.length).toBeGreaterThan(0);
  });
  it('recommends from observed terms', async () => {
    const harness = await start();
    await connect(harness);
    const { items } = (await harness.get('/api/google-ads/recommendations')).json();
    expect(items.map((item: { id: string }) => item.id)).toContain('negative-100-free removal boxes');
    expect((await harness.get('/api/google-ads/recommendations')).json().report.basis).toBe('observed');
  });
});

describe('draft states', () => {
  it('walks preview, draft, validated and verified without any account write', async () => {
    const harness = await start();
    await connect(harness);
    const draft = await verified(harness);
    expect(draft.summary).toMatchObject({ initialStatus: 'PAUSED', dailyBudgetMicros: '20000000' });
    expect(writes(harness.mock)).toHaveLength(0);
    expect(harness.mock.mutations.every(item => item.validateOnly)).toBe(true);
  });
  it('is idempotent on the request key', async () => {
    const harness = await start();
    await connect(harness);
    const headers = { 'idempotency-key': 'same-key-0001' };
    const first = (await harness.post('/api/google-ads/drafts', brief, headers)).json();
    const second = (await harness.post('/api/google-ads/drafts', brief, headers)).json();
    expect(second.id).toBe(first.id);
    expect((await harness.post('/api/google-ads/drafts', { ...brief, dailyBudget: '30' }, headers)).statusCode).toBe(409);
    expect((await harness.get('/api/google-ads/drafts')).json().items).toHaveLength(1);
  });
  it('refuses skipped steps', async () => {
    const harness = await start();
    await connect(harness);
    const preview = (await harness.post('/api/google-ads/drafts', brief, { 'idempotency-key': 'skip-key-0001' })).json();
    for (const name of ['validate', 'verify', 'publish', 'launch']) expect((await harness.post(`/api/google-ads/drafts/${preview.id}/${name}`, { expectedRevision: preview.revision })).statusCode).toBe(409);
    expect((await approve(harness, preview)).statusCode).toBe(409);
  });
  it('rejects stale revisions', async () => {
    const harness = await start();
    await connect(harness);
    const preview = (await harness.post('/api/google-ads/drafts', brief, { 'idempotency-key': 'stale-key-001' })).json();
    await step(harness, preview, 'save');
    expect((await harness.post(`/api/google-ads/drafts/${preview.id}/save`, { expectedRevision: preview.revision })).statusCode).toBe(409);
  });
  it('rejects a draft with an unsupported claim and returns it to revision', async () => {
    const harness = await start();
    await connect(harness);
    const created = (await harness.post('/api/google-ads/drafts', { ...brief, headlines: [...brief.headlines, 'Best Rated 10 Years'] }, { 'idempotency-key': 'claim-key-001' })).json();
    const rejected = await step(harness, await step(harness, created, 'save'), 'validate');
    expect(rejected.state).toBe('rejected');
    expect(rejected.validation.issues.map((issue: { code: string }) => issue.code)).toContain('UNSUPPORTED_CLAIM');
    expect((await harness.post(`/api/google-ads/drafts/${rejected.id}/verify`, { expectedRevision: rejected.revision })).statusCode).toBe(409);
    const revised = (await harness.post(`/api/google-ads/drafts/${rejected.id}/revise`, { expectedRevision: rejected.revision, brief })).json();
    expect(revised).toMatchObject({ state: 'preview', validation: null });
  });
  it('rejects a location Google does not know', async () => {
    const harness = await start();
    await connect(harness);
    const created = (await harness.post('/api/google-ads/drafts', { ...brief, locations: ['Glasgow', 'Atlantis'] }, { 'idempotency-key': 'atlantis-key1' })).json();
    const rejected = await step(harness, await step(harness, created, 'save'), 'validate');
    expect(rejected.validation.issues.map((issue: { code: string }) => issue.code)).toContain('LOCATION_UNRESOLVED');
  });
  it('rejects an unreachable landing page', async () => {
    const harness = await start({ page: async () => { throw new Error('offline'); } });
    await connect(harness);
    const created = (await harness.post('/api/google-ads/drafts', brief, { 'idempotency-key': 'landing-key-1' })).json();
    const rejected = await step(harness, await step(harness, created, 'save'), 'validate');
    expect(rejected.state).toBe('rejected');
    expect(rejected.validation.issues.map((issue: { code: string }) => issue.code)).toContain('LANDING_UNREACHABLE');
  });
  it('stays unverified when conversion tracking is unproven', async () => {
    const harness = await start();
    await connect(harness);
    harness.mock.state.conversionsRecorded = 0;
    const created = (await harness.post('/api/google-ads/drafts', brief, { 'idempotency-key': 'tracking-key1' })).json();
    const valid = await step(harness, await step(harness, created, 'save'), 'validate');
    const checked = await step(harness, valid, 'verify');
    expect(checked.state).toBe('validated');
    expect((await approve(harness, checked)).statusCode).toBe(409);
  });
  it('discards a draft', async () => {
    const harness = await start();
    await connect(harness);
    const preview = (await harness.post('/api/google-ads/drafts', brief, { 'idempotency-key': 'discard-key-1' })).json();
    await step(harness, preview, 'discard');
    expect((await harness.get('/api/google-ads/drafts')).json().items).toHaveLength(0);
  });
});

describe('publishing', () => {
  async function approved(options: Parameters<typeof start>[0] = {}) {
    const harness = await start(options);
    await connect(harness);
    const draft = await verified(harness);
    const response = await approve(harness, draft);
    expect(response.statusCode, response.body).toBe(200);
    return { harness, draft: response.json() };
  }

  it.each([
    ['the server switch', { publishing: false }, 'server_switch'],
    ['regression and live evidence', { proven: false }, 'regression_runs'],
  ])('stays closed without %s, whatever the owner approved', async (_name, options, gate) => {
    const { harness, draft } = await approved(options);
    const status = (await harness.get('/api/google-ads/status')).json();
    expect(status.publishing.available).toBe(false);
    expect(status.publishing.gates.find((item: { id: string }) => item.id === gate).passed).toBe(false);
    const response = await harness.post(`/api/google-ads/drafts/${draft.id}/publish`, { expectedRevision: draft.revision });
    expect(response.json().error.code).toBe('GOOGLE_ADS_PUBLISHING_CLOSED');
    expect(writes(harness.mock)).toHaveLength(0);
  });
  it('needs an approval of the exact hash and account', async () => {
    const harness = await start();
    await connect(harness);
    const draft = await verified(harness);
    expect((await approve(harness, draft, 'a'.repeat(64))).json().error.code).toBe('GOOGLE_ADS_APPROVAL_MISMATCH');
    expect((await approve(harness, draft, draft.draftHash, '5555555555')).json().error.code).toBe('GOOGLE_ADS_APPROVAL_MISMATCH');
    expect((await harness.post(`/api/google-ads/drafts/${draft.id}/publish`, { expectedRevision: draft.revision })).statusCode).toBe(409);
    expect(writes(harness.mock)).toHaveLength(0);
  });
  it('refuses an expired approval and writes nothing, leaving the owner to approve again', async () => {
    const { harness, draft } = await approved();
    await harness.application.database.db.updateTable('google_ads_approvals' as never).set({ expires_at: new Date(Date.now() - 1000) } as never).execute();
    const response = await harness.post(`/api/google-ads/drafts/${draft.id}/publish`, { expectedRevision: draft.revision });
    expect(response.json().error.code).toBe('GOOGLE_ADS_APPROVAL_REQUIRED');
    expect(writes(harness.mock)).toHaveLength(0);
    expect((await harness.get(`/api/google-ads/drafts/${draft.id}`)).json().state).toBe('approved');
  });
  it('voids an approval when the draft is edited', async () => {
    const { harness, draft } = await approved();
    const revised = (await harness.post(`/api/google-ads/drafts/${draft.id}/revise`, { expectedRevision: draft.revision, brief: { ...brief, dailyBudget: '50' } })).json();
    expect(revised.draftHash).not.toBe(draft.draftHash);
    expect((await harness.post(`/api/google-ads/drafts/${draft.id}/publish`, { expectedRevision: revised.revision })).statusCode).toBe(409);
    expect(writes(harness.mock)).toHaveLength(0);
  });
  it('publishes paused, once, confirms from the account and records verified experience', async () => {
    const { harness, draft } = await approved();
    const published = await step(harness, draft, 'publish');
    expect(published.state).toBe('published');
    expect(published.campaignResourceName).toBe(`customers/${CUSTOMER}/campaigns/777`);
    expect(writes(harness.mock)).toHaveLength(1);
    expect(harness.mock.state.campaigns[0]!.status).toBe('PAUSED');
    const repeat = await harness.post(`/api/google-ads/drafts/${draft.id}/publish`, { expectedRevision: published.revision });
    expect(repeat.statusCode).toBe(409);
    expect(writes(harness.mock)).toHaveLength(1);
    const { items } = (await harness.get('/api/google-ads/experiences')).json();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'publish_confirmed', evidence: { source: 'google_ads_api', figures: { status: 'PAUSED' } } });
    const types = (await harness.get('/api/google-ads/audit')).json().items.map((item: { type: string }) => item.type);
    expect(types).toEqual(expect.arrayContaining(['publish_approved', 'publish_started', 'publish_applied', 'publish_confirmed']));
  });
  it('lets only one of two simultaneous publishes write', async () => {
    const { harness, draft } = await approved();
    const results = await Promise.all([1, 2].map(() => harness.post(`/api/google-ads/drafts/${draft.id}/publish`, { expectedRevision: draft.revision })));
    expect(results.map(item => item.statusCode).sort()).toEqual([200, 409]);
    expect(writes(harness.mock)).toHaveLength(1);
  });
  it('reports a rejection and writes nothing further', async () => {
    const { harness, draft } = await approved();
    harness.mock.state.mutateFailure = 'rejected';
    const response = await harness.post(`/api/google-ads/drafts/${draft.id}/publish`, { expectedRevision: draft.revision });
    expect(response.statusCode).toBe(422);
    expect((await harness.get(`/api/google-ads/drafts/${draft.id}`)).json().state).toBe('failed');
    expect(writes(harness.mock)).toHaveLength(1);
  });
  it('never repeats a write after a lost response, and finds the applied campaign', async () => {
    const { harness, draft } = await approved();
    harness.mock.state.mutateFailure = 'lost_applied';
    const response = await harness.post(`/api/google-ads/drafts/${draft.id}/publish`, { expectedRevision: draft.revision });
    expect(response.json().error.code).toBe('GOOGLE_ADS_OUTCOME_UNKNOWN');
    const unknown = (await harness.get(`/api/google-ads/drafts/${draft.id}`)).json();
    expect(unknown.state).toBe('outcome_unknown');
    expect(writes(harness.mock)).toHaveLength(1);
    expect((await step(harness, unknown, 'reconcile')).state).toBe('published');
    expect(writes(harness.mock)).toHaveLength(1);
  });
  it('returns to draft when the read shows nothing was created, and needs a new approval', async () => {
    const { harness, draft } = await approved();
    harness.mock.state.mutateFailure = 'lost_absent';
    await harness.post(`/api/google-ads/drafts/${draft.id}/publish`, { expectedRevision: draft.revision });
    const unknown = (await harness.get(`/api/google-ads/drafts/${draft.id}`)).json();
    const settled = await step(harness, unknown, 'reconcile');
    expect(settled).toMatchObject({ state: 'draft', verification: null });
    expect((await harness.post(`/api/google-ads/drafts/${draft.id}/publish`, { expectedRevision: settled.revision })).statusCode).toBe(409);
    expect(writes(harness.mock)).toHaveLength(1);
  });
  it('launches only with a second approval, and confirms from the account', async () => {
    const { harness, draft } = await approved();
    const published = await step(harness, draft, 'publish');
    expect((await harness.post(`/api/google-ads/drafts/${draft.id}/launch`, { expectedRevision: published.revision })).statusCode).toBe(409);
    expect(harness.mock.state.campaigns[0]!.status).toBe('PAUSED');
    const { hash } = (await harness.get(`/api/google-ads/drafts/${draft.id}/launch-hash`)).json();
    expect((await harness.post(`/api/google-ads/drafts/${draft.id}/approve-launch`, { expectedRevision: published.revision, draftHash: draft.draftHash, customerId: CUSTOMER })).json().error.code).toBe('GOOGLE_ADS_APPROVAL_MISMATCH');
    const ready = await step(harness, published, 'approve-launch', { draftHash: hash, customerId: CUSTOMER });
    expect(ready.state).toBe('launch_approved');
    const live = await step(harness, ready, 'launch');
    expect(live.state).toBe('live');
    expect(harness.mock.state.campaigns[0]!.status).toBe('ENABLED');
    const update = writes(harness.mock).at(-1)!.operations[0].campaignOperation;
    expect(update).toMatchObject({ updateMask: 'status', update: { status: 'ENABLED' } });
    expect((await harness.get('/api/google-ads/experiences')).json().items.map((item: { kind: string }) => item.kind)).toContain('launch_confirmed');
  });
});
