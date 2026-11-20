/**
 * The owner's flow end to end through the real chat (owner's direction, 2026-11-15): one English
 * command, the brain asks everything it is missing in one message, the owner answers once, signs
 * in on Google's page, and the campaign is created PAUSED without any other stop.
 */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sourceFingerprint } from '@mohassan/google-ads';
import { createApplication } from '../apps/server/src/app.js';
import { MAX_ASK_ROUNDS, pageLines } from '../apps/server/src/assistant/ads-model-chat.js';
import { goalToPointer, siteToPointer, GOAL_POINTER_CAPABILITY } from '../scripts/ads-training/pointer.js';
import { siteAds, siteDigest } from '../scripts/ads-training/site.js';
import { createMockGoogle, CUSTOMER } from './fixtures/google-ads-mock.js';

const secret = 'ads-own-chat-internal-secret-00000001', origin = 'http://127.0.0.1:3000', setupToken = 'ads-own-chat-setup-token-000000001';
const SITE = 'https://kerbsidetyres.co.uk/';
const HTML = `<!doctype html><html lang="en-GB"><head><title>Kerbside Tyres | Mobile Tyre Fitting Wigan</title></head><body>
<h1>Kerbside Tyres</h1><h2>Mobile Tyre Fitting</h2><h2>Emergency Tyre Repair</h2><h3>Puncture Repair Service</h3>
<p>We fit new tyres at your home or workplace across Wigan.</p><p>Our vans carry budget and premium tyres for most cars and vans.</p></body></html>`;
const MESSAGE = 'make ads for kerbsidetyres.co.uk in Wigan, £20 a day';

describe('own Ads model: ask once, then create the campaign PAUSED', () => {
  const open: Awaited<ReturnType<typeof createApplication>>[] = [];
  afterEach(async () => { await Promise.all(open.splice(0).map(item => item.app.close())); });

  it('asks every missing fact in one message, then signs in and creates the campaign without another stop', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mohassan-ads-own-'));
    const sourceDir = join(directory, 'src');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'fixture.ts'), 'export const fixture = true;');
    const regressionFile = join(directory, 'regression.json'), liveCheckFile = join(directory, 'live.json');
    await writeFile(regressionFile, JSON.stringify({ consecutivePasses: 20, sourceFingerprint: await sourceFingerprint(sourceDir) }));
    await writeFile(liveCheckFile, JSON.stringify({ source: 'google-ads-api-live', passed: true, customerId: CUSTOMER, checkedAt: new Date().toISOString() }));

    const read0 = pageLines(HTML);
    const input = siteDigest(SITE, read0.title, `${read0.title}\n${read0.text}`);
    const goalAnswer = goalToPointer(MESSAGE, { intent: 'create_campaign', url: 'kerbsidetyres.co.uk', service: null, locations: ['Wigan'], budget: { amount: '20', currency: '£', period: 'day' }, goal: null })!;
    const siteAnswer = siteToPointer(input, siteAds(input)!)!;
    const prompts: string[] = [];
    const worker = {
      files: async () => null,
      sample: async (prompt: string) => {
        prompts.push(prompt);
        return { candidates: [{ text: prompt.startsWith(`Ads task: ${GOAL_POINTER_CAPABILITY}`) ? goalAnswer : siteAnswer, finished: true }], ms: 1 };
      },
    };
    const google = createMockGoogle();
    const application = await createApplication({
      authSecret: 'ads-own-chat-auth-secret-000000000001', internalSecret: secret, setupToken, webOrigin: origin, production: false, runWorker: false, codingAllowedRoots: [directory], browserProfileDir: join(directory, 'profile'), browserChannel: null, testRequestLimit: 2000,
      adsModelWorker: worker,
      googleAds: { clientId: 'client-id', clientSecret: 'client-secret', tokenKey: Buffer.alloc(32, 5).toString('base64'), publishingEnabled: true, fetch: google.fetch, sleep: async () => undefined, gateFiles: { sourceDir, regressionFile, liveCheckFile }, fetchPage: async url => ({ status: 200, finalUrl: url, html: HTML, contentLanguage: null }) },
    });
    open.push(application);
    const app = application.app, account = { email: 'ads-own@example.test', password: 'Ads-own-chat-password-42', name: 'Owner' };
    const base = { 'x-mohassan-internal': secret, origin };
    await app.inject({ method: 'POST', url: '/api/setup', headers: base, payload: { ...account, setupToken } });
    const login = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: base, payload: account });
    const headers = { ...base, cookie: [login.headers['set-cookie']].flat().filter(Boolean).map(value => String(value).split(';')[0]).join('; ') };
    const post = (url: string, payload: object) => app.inject({ method: 'POST', url, headers, payload });

    const created = await post('/api/chat/conversations', { goal: MESSAGE });
    const id: string = created.json().id;
    await application.chat.settled(id);
    const read = async () => (await app.inject({ url: `/api/chat/conversations/${id}`, headers })).json();
    const choose = async (optionId: string) => { await post(`/api/chat/conversations/${id}/respond`, { questionId: (await read()).question.id, optionId }); await application.chat.settled(id); };

    // 1. One message with every question the brain still has (the country came from .co.uk).
    let detail = await read();
    expect(detail.status).toBe('waiting_user');
    expect(detail.question.prompt).toMatch(/1\. ما الخدمة[\s\S]*2\. ماذا تريد من الإعلان/);
    expect(detail.question.prompt).not.toContain('في أي دولة');
    expect(detail.question.prompt).toContain('الدولة: المملكة المتحدة');
    expect(google.mutations).toHaveLength(0);

    // 2. One answer; the next stop is Google's own sign-in page, nothing in between.
    await post(`/api/chat/conversations/${id}/messages`, { text: '1. Mobile Tyre Fitting\n2. calls' });
    await application.chat.settled(id);
    detail = await read();
    expect(detail.status).toBe('waiting_user');
    expect(detail.question.action).toBe('google_ads_connect');
    expect(google.mutations).toHaveLength(0);
    // The owner sees the draft before signing in, not only after the campaign exists.
    const draft = detail.messages.at(-1).text as string;
    expect(draft).toContain('Mobile Tyre Fitting');
    expect(draft).toContain('Google');

    const state = new URL((await post('/api/google-ads/connect', {})).json().authorizationUrl).searchParams.get('state');
    await app.inject({ url: `/api/google-ads/oauth/callback?code=good-code&state=${state}`, headers });
    await choose('connected');
    detail = await read();
    if (detail.status === 'waiting_user' && detail.question.options.some((option: { id: string }) => option.id === 'a1')) {
      const pick = detail.question.options.find((option: { label: string }) => option.label.includes(CUSTOMER)) ?? detail.question.options[0];
      await choose(pick.id);
      detail = await read();
    }

    // 3. Created PAUSED, read back, and reported in Arabic.
    const last = detail.messages.at(-1).text as string;
    expect(detail.status, last).toBe('idle');
    expect(last).toContain('أُنشئت الحملة في حسابك وهي متوقفة');
    // Shown once, before sign-in: the report does not repeat the whole draft.
    expect(detail.messages.filter((message: { text: string }) => message.text === draft)).toHaveLength(1);
    expect(last).not.toContain(draft);
    expect(google.mutations.length).toBeGreaterThan(0);
    const operations = JSON.stringify(google.mutations);
    // The campaign itself is PAUSED (its ad group and ad are enabled inside it, as Google expects).
    const campaigns = [...operations.matchAll(/"campaignOperation":\{"create":\{[^{}]*"status":"(\w+)"/g)].map(match => match[1]);
    expect(campaigns.length).toBeGreaterThan(0);
    expect(new Set(campaigns)).toEqual(new Set(['PAUSED']));
    expect(operations).toContain('"amountMicros":"20000000"');
    expect(operations).toContain('"text":"mobile tyre fitting wigan"');
    expect(google.mutations.at(-1)).toMatchObject({ validateOnly: false });
    // The goal model was asked once; the answers were read by code.
    expect(prompts.filter(prompt => prompt.startsWith(`Ads task: ${GOAL_POINTER_CAPABILITY}`))).toHaveLength(1);
  }, 90000);

  it('asks only what a partial answer leaves missing and stops after MAX_ASK_ROUNDS', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mohassan-ads-partial-'));
    const sourceDir = join(directory, 'src');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'fixture.ts'), 'export const fixture = true;');
    const regressionFile = join(directory, 'regression.json'), liveCheckFile = join(directory, 'live.json');
    await writeFile(regressionFile, JSON.stringify({ consecutivePasses: 20, sourceFingerprint: await sourceFingerprint(sourceDir) }));
    await writeFile(liveCheckFile, JSON.stringify({ source: 'google-ads-api-live', passed: true, customerId: CUSTOMER, checkedAt: new Date().toISOString() }));

    const goalAnswer = goalToPointer(MESSAGE, { intent: 'create_campaign', url: 'kerbsidetyres.co.uk', service: null, locations: ['Wigan'], budget: { amount: '20', currency: '£', period: 'day' }, goal: null })!;
    const prompts: string[] = [];
    const worker = {
      files: async () => null,
      sample: async (prompt: string) => {
        prompts.push(prompt);
        return { candidates: [{ text: goalAnswer, finished: true }], ms: 1 };
      },
    };
    const google = createMockGoogle();
    const application = await createApplication({
      authSecret: 'ads-own-chat-auth-secret-000000000001', internalSecret: secret, setupToken, webOrigin: origin, production: false, runWorker: false, codingAllowedRoots: [directory], browserProfileDir: join(directory, 'profile'), browserChannel: null, testRequestLimit: 2000,
      adsModelWorker: worker,
      googleAds: { clientId: 'client-id', clientSecret: 'client-secret', tokenKey: Buffer.alloc(32, 5).toString('base64'), publishingEnabled: true, fetch: google.fetch, sleep: async () => undefined, gateFiles: { sourceDir, regressionFile, liveCheckFile }, fetchPage: async url => ({ status: 200, finalUrl: url, html: HTML, contentLanguage: null }) },
    });
    open.push(application);
    const app = application.app, account = { email: 'ads-partial@example.test', password: 'Ads-own-chat-password-42', name: 'Owner' };
    const base = { 'x-mohassan-internal': secret, origin };
    await app.inject({ method: 'POST', url: '/api/setup', headers: base, payload: { ...account, setupToken } });
    const login = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: base, payload: account });
    const headers = { ...base, cookie: [login.headers['set-cookie']].flat().filter(Boolean).map(value => String(value).split(';')[0]).join('; ') };
    const post = (url: string, payload: object) => app.inject({ method: 'POST', url, headers, payload });
    const created = await post('/api/chat/conversations', { goal: MESSAGE });
    const id: string = created.json().id;
    await application.chat.settled(id);
    const read = async () => (await app.inject({ url: `/api/chat/conversations/${id}`, headers })).json();
    const answer = async (text: string) => {
      expect((await post(`/api/chat/conversations/${id}/messages`, { text })).statusCode).toBe(200);
      await application.chat.settled(id);
      return read();
    };

    let detail = await read();
    expect(detail.status).toBe('waiting_user');
    expect(detail.question.fields.map((field: { id: string }) => field.id)).toEqual(['service', 'goal']);
    const questionIds = new Set<string>([detail.question.id]);

    // The owner answers just one question. The saved service must survive every later round.
    detail = await answer('Mobile Tyre Fitting');
    for (let round = 2; round <= MAX_ASK_ROUNDS; round++) {
      expect(detail.status).toBe('waiting_user');
      expect(detail.question.fields.map((field: { id: string }) => field.id)).toEqual(['goal']);
      expect(detail.question.prompt).toContain('الخدمة: Mobile Tyre Fitting');
      expect(detail.question.prompt).toContain('ماذا تريد من الإعلان');
      expect(detail.question.prompt).not.toContain('ما الخدمة التي تعلن عنها');
      expect(detail.question.action).toBeUndefined();
      questionIds.add(detail.question.id);
      expect(google.mutations).toHaveLength(0);
      detail = await answer('not sure');
    }

    expect(questionIds.size).toBe(MAX_ASK_ROUNDS);
    expect(detail.status).toBe('idle');
    expect(detail.question).toBeNull();
    expect(detail.messages.at(-1).text).toContain(`سألت ${MAX_ASK_ROUNDS} مرات`);
    expect(detail.messages.at(-1).text).toContain('ما زلت لا أستطيع قراءة: الهدف');
    expect(google.mutations).toHaveLength(0);
    // No extra model inference or sign-in is attempted while the campaign facts are incomplete.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(`Ads task: ${GOAL_POINTER_CAPABILITY}`);
  }, 90000);
});
