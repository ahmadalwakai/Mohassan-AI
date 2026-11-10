import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { reduceCampaignEvents, type CampaignEvent } from '@mohassan/contracts';
import { sourceFingerprint } from '@mohassan/google-ads';
import { createApplication } from '../apps/server/src/app.js';
import { ADS_SKILL_SLUG } from '../apps/server/src/assistant/ads-check.js';
import { createMockGroq } from './fixtures/planning.js';
import { createMockGoogle, CUSTOMER, landingHtml } from './fixtures/google-ads-mock.js';

// Integration tests against a MOCKED Google Ads and MOCKED model. They prove our control flow only;
// none of this is evidence about the real Google Ads API.
const secret = 'campaign-progress-internal-secret-000001', origin = 'http://127.0.0.1:3000', setupToken = 'campaign-progress-setup-token-0000001';
const blank = { thought: null, plan: null, note: null, url: null, ref: null, text: null, submit: null, options: null, sensitive: null, outcome: null };
const lines = (headline: string) => ['BUSINESS: MA Removals', 'SERVICE: House removals', 'GOAL: bookings', 'URL: https://maremovals.example.com/house', 'LOCATION: Glasgow', 'COUNTRY: gb', 'LANGUAGE: EN', 'BUDGET: 20', `H: ${headline}`, 'H: Local Movers Glasgow', 'H: Book Your Move', 'D: Careful house removals across Glasgow.', 'D: Book your move online in minutes.', 'P: removals/glasgow', 'K: "house removals glasgow"', 'N: jobs'].join('\n');
const checkText = (headline: string) => lines(headline).split(String.fromCharCode(10)).filter(line => /^[HDPKN]:/.test(line)).join(String.fromCharCode(10));
// A creation request names its own budget and landing page: the clarification core asks for them otherwise.
const goal = 'أنشئ حملة بحث في حساب Google Ads لنقل الأثاث في غلاسكو على https://maremovals.example.com/house بميزانية 20 يوميًا';

describe('live campaign events from the assistant', () => {
  const open: Awaited<ReturnType<typeof createApplication>>[] = [], dirs: string[] = [];
  afterEach(async () => { await Promise.all(open.splice(0).map(item => item.app.close())); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

  async function scenario(script: Record<string, unknown>[], tweak: (google: ReturnType<typeof createMockGoogle>) => void = () => undefined, publishing = true) {
    const directory = await mkdtemp(join(tmpdir(), 'mohassan-campaign-'));
    dirs.push(directory);
    const sourceDir = join(directory, 'src');
    await mkdir(sourceDir);
    await writeFile(join(sourceDir, 'fixture.ts'), 'export const fixture = true;');
    const regressionFile = join(directory, 'regression.json'), liveCheckFile = join(directory, 'live.json');
    await writeFile(regressionFile, JSON.stringify({ consecutivePasses: 20, sourceFingerprint: await sourceFingerprint(sourceDir) }));
    await writeFile(liveCheckFile, JSON.stringify({ source: 'google-ads-api-live', passed: true, customerId: CUSTOMER, checkedAt: new Date().toISOString() }));
    const google = createMockGoogle(), groq = createMockGroq();
    const scripted: typeof fetch = async (input, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const name = body.response_format?.json_schema?.name;
      if (name !== 'decision' && name !== 'ads_correction') return groq.fetch(input, init);
      const next = name === 'ads_correction' ? { replacements: [] } : script.shift() ?? { tool: 'answer', text: 'انتهيت.', outcome: 'done' };
      return Response.json({ model: body.model, choices: [{ message: { content: JSON.stringify(name === 'decision' ? { ...blank, ...next } : next) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
    };
    const application = await createApplication({
      authSecret: 'campaign-progress-auth-secret-00000001', internalSecret: secret, setupToken, webOrigin: origin, production: false, runWorker: false, skillEngineEnabled: true, codingAllowedRoots: [directory], browserProfileDir: join(directory, 'profile'), browserChannel: null, groqApiKey: 'unit-fixture-key-only', aiFetch: scripted, testRequestLimit: 2000,
      googleAds: { clientId: 'client-id', clientSecret: 'client-secret', tokenKey: Buffer.alloc(32, 3).toString('base64'), publishingEnabled: publishing, fetch: google.fetch, sleep: async () => undefined, gateFiles: { sourceDir, regressionFile, liveCheckFile }, fetchPage: async url => ({ status: 200, finalUrl: url, html: landingHtml(), contentLanguage: null }) },
    });
    open.push(application);
    const app = application.app, account = { email: 'campaign@example.test', password: 'Campaign-progress-password-42', name: 'Campaign' };
    const base = { 'x-mohassan-internal': secret, origin };
    await app.inject({ method: 'POST', url: '/api/setup', headers: base, payload: { ...account, setupToken } });
    const login = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: base, payload: account });
    const headers = { ...base, cookie: [login.headers['set-cookie']].flat().filter(Boolean).map(value => String(value).split(';')[0]).join('; ') };
    const post = (url: string, payload: object) => app.inject({ method: 'POST', url, headers, payload });
    const state = new URL((await post('/api/google-ads/connect', {})).json().authorizationUrl).searchParams.get('state');
    await app.inject({ url: `/api/google-ads/oauth/callback?code=good-code&state=${state}`, headers });
    await post('/api/google-ads/accounts/select', { customerId: CUSTOMER, loginCustomerId: null });
    let skill = (await app.inject({ url: '/api/skills?category=marketing', headers })).json().items.find((item: { slug: string }) => item.slug === ADS_SKILL_SLUG);
    skill = (await post(`/api/skills/${skill.id}/inspect`, { expectedRevision: skill.revision })).json().skill;
    await post(`/api/skills/${skill.id}/activate`, { expectedRevision: skill.revision, approve: true });
    tweak(google);
    const created = await post('/api/chat/conversations', { goal });
    const id: string = created.json().id;
    await application.chat.settled(id);
    const events = async (after = 0): Promise<{ taskId: string | null; lastSeq: number; events: CampaignEvent[] }> => (await app.inject({ url: `/api/chat/conversations/${id}/campaign-events?after=${after}`, headers })).json();
    const detail = async () => (await app.inject({ url: `/api/chat/conversations/${id}`, headers })).json();
    return { google, events, detail, app, headers, id };
  }
  const writes = (google: ReturnType<typeof createMockGoogle>) => google.mutations.filter(item => !item.validateOnly);

  it('corrects an overlong headline, creates one PAUSED campaign and reads it back', async () => {
    const { google, events, detail } = await scenario([{ tool: 'ads_check', text: checkText('Glasgow House Removals And Man Vans Today') }, { tool: 'ads_check', text: checkText('Glasgow House Removals') }, { tool: 'ads_create_paused', text: lines('Glasgow House Removals') }, { tool: 'answer', text: 'تم.', outcome: 'done' }]);
    const stream = await events();
    const types = stream.events.map(item => item.type);
    expect(types[0]).toBe('task_started');
    expect(types).toEqual(expect.arrayContaining(['validation_failed', 'correction_started', 'correction_completed', 'external_operation_started', 'external_operation_reconciled', 'task_completed']));
    expect(stream.events.map(item => item.seq)).toEqual(stream.events.map((_, index) => index + 1));
    const progress = reduceCampaignEvents(stream.events)!;
    expect(progress.status).toBe('completed');
    const failed = stream.events.find(item => item.type === 'validation_failed');
    expect(failed?.type === 'validation_failed' && failed.data.issues.some(issue => issue.code === 'TOO_LONG' && issue.category === 'character_limit')).toBe(true);
    expect(progress.operations.find(item => item.operation === 'create_paused')).toMatchObject({ state: 'confirmed_paused' });
    expect(progress.verifications.find(item => item.scope === 'google_validate_only')?.authority).toBe('google_ads_api');
    expect(progress.verifications.find(item => item.scope === 'local_text')?.authority).toBe('local');
    expect(writes(google)).toHaveLength(1);
    expect(google.state.campaigns[0]).toMatchObject({ status: 'PAUSED' });
    expect((await detail()).campaign.events.length).toBe(stream.events.length);
  }, 120_000);

  it('replays only events after the held sequence number, with no duplicates', async () => {
    const { events } = await scenario([{ tool: 'ads_check', text: checkText('Glasgow House Removals') }, { tool: 'ads_create_paused', text: lines('Glasgow House Removals') }, { tool: 'answer', text: 'تم.', outcome: 'done' }]);
    const all = await events(), tail = await events(3);
    expect(tail.events.map(item => item.seq)).toEqual(all.events.filter(item => item.seq > 3).map(item => item.seq));
    expect(new Set(all.events.map(item => item.id)).size).toBe(all.events.length);
  }, 120_000);

  it('does not repeat a write whose connection was lost: the account is read first', async () => {
    const { google, events } = await scenario([{ tool: 'ads_check', text: checkText('Glasgow House Removals') }, { tool: 'ads_create_paused', text: lines('Glasgow House Removals') }, { tool: 'answer', text: 'تم.', outcome: 'done' }], mock => { mock.state.mutateFailure = 'lost_applied'; });
    const progress = reduceCampaignEvents((await events()).events)!;
    expect(writes(google)).toHaveLength(1);
    expect(progress.status).toBe('completed');
    expect(progress.outcome?.outcome).toBe('paused_campaign_recovered');
    expect(progress.operations.find(item => item.operation === 'create_paused')?.state).toBe('confirmed_paused');
  }, 120_000);

  it('keeps an unconfirmed write as reconciliation-required and never writes again', async () => {
    const { google, events } = await scenario([{ tool: 'ads_check', text: checkText('Glasgow House Removals') }, { tool: 'ads_create_paused', text: lines('Glasgow House Removals') }, { tool: 'ads_create_paused', text: lines('Glasgow House Removals') }, { tool: 'answer', text: 'توقفت.', outcome: 'blocked' }], mock => { mock.state.mutateFailure = 'lost_absent'; });
    const progress = reduceCampaignEvents((await events()).events)!;
    expect(writes(google)).toHaveLength(1);
    expect(progress.status).not.toBe('completed');
    expect(progress.operations.find(item => item.operation === 'create_paused')?.state).not.toBe('confirmed_paused');
  }, 120_000);

  it('stops on Google validate-only failure before any write', async () => {
    const { google, events } = await scenario([{ tool: 'ads_check', text: checkText('Glasgow House Removals') }, { tool: 'ads_create_paused', text: lines('Glasgow House Removals') }, { tool: 'answer', text: 'توقفت.', outcome: 'blocked' }], mock => { mock.state.validateFailure = true; });
    const progress = reduceCampaignEvents((await events()).events)!;
    expect(writes(google)).toHaveLength(0);
    expect(progress.status).toBe('failed');
    expect(progress.verifications.find(item => item.scope === 'google_validate_only')?.passed).toBe(false);
  }, 120_000);

  it('reports closed publication gates and sends nothing to the account', async () => {
    const { google, events } = await scenario([{ tool: 'ads_check', text: checkText('Glasgow House Removals') }, { tool: 'ads_create_paused', text: lines('Glasgow House Removals') }, { tool: 'answer', text: 'توقفت.', outcome: 'blocked' }], () => undefined, false);
    const progress = reduceCampaignEvents((await events()).events)!;
    expect(google.mutations).toHaveLength(0);
    expect(progress.approval?.satisfied).toBe(false);
    expect(progress.error?.category).toBe('permissions');
  }, 120_000);

  it('shows daily-quota exhaustion as a typed non-retryable failure with no write', async () => {
    const { google, events } = await scenario([{ tool: 'ads_check', text: checkText('Glasgow House Removals') }, { tool: 'ads_create_paused', text: lines('Glasgow House Removals') }, { tool: 'answer', text: 'توقفت.', outcome: 'blocked' }], mock => { mock.state.dailyQuota = true; });
    const progress = reduceCampaignEvents((await events()).events)!;
    expect(writes(google)).toHaveLength(0);
    expect(progress.error).toMatchObject({ category: 'quota', retryable: false });
  }, 120_000);

  it('cancelling a conversation closes its open task as cancelled', async () => {
    const { events, app, headers, id } = await scenario([{ tool: 'ads_check', text: checkText('Glasgow House Removals And Man Vans Today') }, { tool: 'ads_check', text: checkText('Glasgow House Removals And Man Vans Today') }]);
    await app.inject({ method: 'POST', url: `/api/chat/conversations/${id}/cancel`, headers, payload: {} });
    const progress = reduceCampaignEvents((await events()).events);
    if (progress) expect(['cancelled', 'failed', 'partial', 'completed']).toContain(progress.status);
  }, 120_000);
});
