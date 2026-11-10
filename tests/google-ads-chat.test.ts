import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApplication } from '../apps/server/src/app.js';
import { ADS_SKILL_SLUG } from '../apps/server/src/assistant/ads-check.js';
import { parseAdsDraft } from '../apps/server/src/assistant/tools.js';
import { createMockGroq } from './fixtures/planning.js';
import { createMockGoogle, CUSTOMER, landingHtml } from './fixtures/google-ads-mock.js';

const secret = 'google-ads-chat-internal-secret-0000001', origin = 'http://127.0.0.1:3000', setupToken = 'google-ads-chat-setup-token-00000001';
const blank = { thought: null, plan: null, note: null, url: null, ref: null, text: null, submit: null, options: null, sensitive: null, outcome: null };
const draftText = ['BUSINESS: MA Removals', 'SERVICE: House removals', 'GOAL: bookings', 'URL: https://maremovals.example.com/house', 'LOCATION: Glasgow', 'COUNTRY: gb', 'LANGUAGE: EN', 'BUDGET: 20', 'H: Glasgow House Removals', 'H: Local Movers Glasgow', 'H: Book Your Move', 'D: Careful house removals across Glasgow.', 'D: Book your move online in minutes.', 'P: removals/glasgow', 'K: "house removals glasgow"', 'N: jobs'].join('\n');

describe('parseAdsDraft', () => {
  it('reads the plain-line form into the shared contract', () => {
    expect(parseAdsDraft(draftText, 'حملة نقل')).toMatchObject({ countryCode: 'GB', adLanguage: 'en', dailyBudget: '20', paths: ['removals', 'glasgow'], locations: ['Glasgow'], ownerFacts: ['حملة نقل'], keywords: ['"house removals glasgow"'] });
  });
  it('names missing fields so the model can fix them', () => {
    expect(() => parseAdsDraft('H: One', 'x')).toThrow(/businessName/);
    expect(() => parseAdsDraft('nonsense line', 'x')).toThrow('not understood');
  });
});

describe('the assistant with a connected account', () => {
  const open: Awaited<ReturnType<typeof createApplication>>[] = [];
  afterEach(async () => { await Promise.all(open.splice(0).map(item => item.app.close())); });

  async function scenario(script: Record<string, unknown>[], connected: boolean, goal: string) {
    const directory = await mkdtemp(join(tmpdir(), 'mohassan-ads-chat-'));
    const google = createMockGoogle(), groq = createMockGroq(), seen: { prompt: string; tools: string[] }[] = [];
    const scripted: typeof fetch = async (input, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (body.response_format?.json_schema?.name !== 'decision') return groq.fetch(input, init);
      seen.push({ prompt: body.messages.at(-1).content, tools: body.response_format.json_schema.schema.properties.tool.enum });
      const next = script.shift() ?? { tool: 'answer', text: 'انتهيت.', outcome: 'done' };
      return Response.json({ model: body.model, choices: [{ message: { content: JSON.stringify({ ...blank, ...next }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
    };
    const application = await createApplication({
      authSecret: 'google-ads-chat-auth-secret-0000000001', internalSecret: secret, setupToken, webOrigin: origin, production: false, runWorker: false, skillEngineEnabled: true, codingAllowedRoots: [directory], browserProfileDir: join(directory, 'profile'), browserChannel: null, groqApiKey: 'unit-fixture-key-only', aiFetch: scripted, testRequestLimit: 2000,
      googleAds: { clientId: 'client-id', clientSecret: 'client-secret', tokenKey: Buffer.alloc(32, 3).toString('base64'), publishingEnabled: true, fetch: google.fetch, sleep: async () => undefined, fetchPage: async url => ({ status: 200, finalUrl: url, html: landingHtml(), contentLanguage: null }) },
    });
    open.push(application);
    const app = application.app, account = { email: 'ads-chat@example.test', password: 'Google-ads-chat-password-42', name: 'Ads chat' };
    const base = { 'x-mohassan-internal': secret, origin };
    await app.inject({ method: 'POST', url: '/api/setup', headers: base, payload: { ...account, setupToken } });
    const login = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: base, payload: account });
    const headers = { ...base, cookie: [login.headers['set-cookie']].flat().filter(Boolean).map(value => String(value).split(';')[0]).join('; ') };
    const post = (url: string, payload: object) => app.inject({ method: 'POST', url, headers, payload });
    if (connected) {
      const state = new URL((await post('/api/google-ads/connect', {})).json().authorizationUrl).searchParams.get('state');
      await app.inject({ url: `/api/google-ads/oauth/callback?code=good-code&state=${state}`, headers });
      await post('/api/google-ads/accounts/select', { customerId: CUSTOMER, loginCustomerId: null });
    }
    let skill = (await app.inject({ url: '/api/skills?category=marketing', headers })).json().items.find((item: { slug: string }) => item.slug === ADS_SKILL_SLUG);
    skill = (await post(`/api/skills/${skill.id}/inspect`, { expectedRevision: skill.revision })).json().skill;
    await post(`/api/skills/${skill.id}/activate`, { expectedRevision: skill.revision, approve: true });
    const created = await post('/api/chat/conversations', { goal });
    await application.chat.settled(created.json().id);
    const id: string = created.json().id;
    const read = async () => (await app.inject({ url: `/api/chat/conversations/${id}`, headers })).json();
    const choose = async (optionId: string) => {
      const response = await post(`/api/chat/conversations/${id}/respond`, { questionId: (await read()).question.id, optionId });
      await application.chat.settled(id);
      return response;
    };
    const signIn = async () => {
      const state = new URL((await post('/api/google-ads/connect', {})).json().authorizationUrl).searchParams.get('state');
      await app.inject({ url: `/api/google-ads/oauth/callback?code=good-code&state=${state}`, headers });
    };
    return { seen, google, headers, app, detail: await read(), read, choose, signIn };
  }

  it('offers the account tools only with the skill, and reads real figures', async () => {
    const { seen, detail } = await scenario([{ tool: 'ads_status' }, { tool: 'ads_report' }, { tool: 'answer', text: 'تقرير الحساب.', outcome: 'done' }], true, 'حلل حساب Google Ads');
    expect(seen[0]!.tools).toEqual(expect.arrayContaining(['ads_status', 'ads_report', 'ads_draft']));
    expect(seen[1]!.prompt).toContain('connection: connected');
    expect(seen[2]!.prompt).toContain('Observed from Google Ads');
    expect(seen[2]!.prompt).toContain('310 clicks');
    expect(detail.status).toBe('idle');
  }, 60000);

  it('saves a preview from chat and cannot write to the account', async () => {
    const { seen, google, app, headers } = await scenario([{ tool: 'ads_draft', text: draftText }, { tool: 'answer', text: 'حُفظت المعاينة.', outcome: 'done' }], true, 'جهز مسودة حملة Google Ads لشركة نقل');
    expect(seen[1]!.prompt).toContain('Saved preview');
    expect(google.mutations).toHaveLength(0);
    const { items } = (await app.inject({ url: '/api/google-ads/drafts', headers })).json();
    expect(items).toHaveLength(1);
    expect(items[0].state).toBe('preview');
    for (const tools of seen.map(item => item.tools)) expect(tools.some(tool => /publish|launch|approve/.test(tool))).toBe(false);
  }, 60000);

  it('asks for Google sign-in when a tool needs the account, then continues the same task', async () => {
    const { seen, detail, read, choose, signIn } = await scenario([{ tool: 'ads_status' }, { tool: 'ads_report' }, { tool: 'ads_report' }, { tool: 'answer', text: 'تقرير الحساب.', outcome: 'done' }], false, 'حلل حساب Google Ads');
    expect(seen[1]!.prompt).toContain('connection: disconnected');
    expect(seen).toHaveLength(2);
    expect(detail.status).toBe('waiting_user');
    expect(detail.question).toMatchObject({ action: 'google_ads_connect', options: [{ id: 'connect' }, { id: 'connected' }, { id: 'stop' }] });

    await signIn();
    await choose('connected');
    const account = await read();
    expect(account.status).toBe('waiting_user');
    expect(account.question.action).toBeUndefined();
    expect(account.question.options.map((option: { label: string }) => option.label)).toEqual([`MA Removals (${CUSTOMER})`, expect.stringContaining('Child Removals'), 'توقف هنا']);
    expect(seen).toHaveLength(2);

    await choose('a1');
    expect(seen[2]!.prompt).toContain('the user signed in on Google; account MA Removals is connected');
    expect(seen[3]!.prompt).toContain('Observed from Google Ads');
    expect((await read()).status).toBe('idle');
  }, 60000);

  it('asks for sign-in before any model call when a campaign in the account is requested, and does not trust an unproven "done"', async () => {
    const { seen, detail, read, choose } = await scenario([], false, 'أنشئ حملة بحث في حساب Google Ads لشركة نقل في غلاسكو على https://maremovals.example.com بميزانية 20 يوميًا');
    expect(seen).toHaveLength(0);
    expect(detail.question.action).toBe('google_ads_connect');
    await choose('connected');
    const again = await read();
    expect(seen).toHaveLength(0);
    expect(again.status).toBe('waiting_user');
    expect(again.question.action).toBe('google_ads_connect');
    expect(again.messages.at(-1).text).toContain('لم يكتمل تسجيل الدخول');
    expect((await choose('stop')).statusCode).toBe(200);
    expect((await read()).status).not.toBe('waiting_user');
  }, 60000);
});
