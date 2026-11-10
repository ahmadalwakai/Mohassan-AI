import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatConversationSchema, ChatDecisionStreamSchema } from '@mohassan/contracts';
import { sourceFingerprint } from '@mohassan/google-ads';
import { createApplication } from '../apps/server/src/app.js';
import { ADS_SKILL_SLUG } from '../apps/server/src/assistant/ads-check.js';
import { createMockGroq } from './fixtures/planning.js';
import { createMockGoogle, CUSTOMER, landingHtml } from './fixtures/google-ads-mock.js';
import { fixtureLocalModel } from './fixtures/local-model.js';

/**
 * The clarification core through the real chat routes: embedded Postgres, the
 * real command-chat control, a scripted model and a mock Google Ads API. No live
 * provider, account or production database is reachable from this file.
 */
const secret = 'goal-clarify-internal-secret-000000001', origin = 'http://127.0.0.1:3000', setupToken = 'goal-clarify-setup-token-000000000001';
const blank = { thought: null, plan: null, note: null, url: null, ref: null, text: null, submit: null, options: null, sensitive: null, outcome: null };
const lines = (budget = '20', url = 'https://maremovals.example.com/house') => ['BUSINESS: MA Removals', 'SERVICE: House removals', 'GOAL: bookings', `URL: ${url}`, 'LOCATION: Glasgow', 'COUNTRY: gb', 'LANGUAGE: EN', `BUDGET: ${budget}`, 'H: Glasgow House Removals', 'H: Local Movers Glasgow', 'H: Book Your Move', 'D: Careful house removals across Glasgow.', 'D: Book your move online in minutes.', 'P: removals/glasgow', 'K: "house removals glasgow"', 'N: jobs'].join('\n');
const checkText = () => lines().split('\n').filter(line => /^[HDPKN]:/.test(line)).join('\n');
const MISSING = 'أنشئ حملة بحث في حساب Google Ads لنقل الأثاث';
const COMPLETE = 'أنشئ حملة بحث في حساب Google Ads لنقل الأثاث في غلاسكو على https://maremovals.example.com/house بميزانية 20 يوميًا';
type Decision = Record<string, unknown>;

describe('goal clarification in the chat', () => {
  const open: Awaited<ReturnType<typeof createApplication>>[] = [], dirs: string[] = [];
  afterEach(async () => { await Promise.all(open.splice(0).map(item => item.app.close().catch(() => undefined))); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

  async function harness(options: { script?: Decision[]; connect?: boolean; skill?: boolean; directory?: string; persist?: boolean; modelDown?: boolean } = {}) {
    const directory = options.directory ?? await mkdtemp(join(tmpdir(), 'mohassan-clarify-'));
    if (!options.directory) dirs.push(directory);
    const sourceDir = join(directory, 'src'), regressionFile = join(directory, 'regression.json'), liveCheckFile = join(directory, 'live.json');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'fixture.ts'), 'export const fixture = true;');
    await writeFile(regressionFile, JSON.stringify({ consecutivePasses: 20, sourceFingerprint: await sourceFingerprint(sourceDir) }));
    await writeFile(liveCheckFile, JSON.stringify({ source: 'google-ads-api-live', passed: true, customerId: CUSTOMER, checkedAt: new Date().toISOString() }));
    const google = createMockGoogle(), groq = createMockGroq(), seen: { prompt: string; tools: string[] }[] = [], script = options.script ?? [];
    const scripted: typeof fetch = async (input, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const name = body.response_format?.json_schema?.name;
      if (name !== 'decision' && name !== 'ads_correction') return groq.fetch(input, init);
      if (options.modelDown) return new Response(JSON.stringify({ error: { message: 'unavailable' } }), { status: 503 });
      if (name === 'ads_correction') return Response.json({ model: body.model, choices: [{ message: { content: JSON.stringify({ replacements: [] }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
      seen.push({ prompt: body.messages.at(-1).content, tools: body.response_format.json_schema.schema.properties.tool.enum });
      const next = script.shift() ?? { tool: 'answer', text: 'انتهيت.', outcome: 'done' };
      return Response.json({ model: body.model, choices: [{ message: { content: JSON.stringify({ ...blank, ...next }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
    };
    const application = await createApplication({
      authSecret: 'goal-clarify-auth-secret-00000000000001', internalSecret: secret, setupToken, webOrigin: origin, production: false, runWorker: false, skillEngineEnabled: true,
      ...(options.persist ? { dataDir: join(directory, 'db') } : {}),
      codingAllowedRoots: [directory], browserProfileDir: join(directory, 'profile'), browserChannel: null, ...fixtureLocalModel(scripted), testRequestLimit: 2000,
      googleAds: { clientId: 'client-id', clientSecret: 'client-secret', tokenKey: Buffer.alloc(32, 3).toString('base64'), publishingEnabled: true, fetch: google.fetch, sleep: async () => undefined, gateFiles: { sourceDir, regressionFile, liveCheckFile }, fetchPage: async url => ({ status: 200, finalUrl: url, html: landingHtml(), contentLanguage: null }) },
    });
    open.push(application);
    const app = application.app, account = { email: 'clarify@example.test', password: 'Goal-clarify-password-42', name: 'Clarify' };
    const base = { 'x-mohassan-internal': secret, origin };
    await app.inject({ method: 'POST', url: '/api/setup', headers: base, payload: { ...account, setupToken } });
    const login = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: base, payload: account });
    const headers = { ...base, cookie: [login.headers['set-cookie']].flat().filter(Boolean).map(value => String(value).split(';')[0]).join('; ') };
    const post = (url: string, payload: object) => app.inject({ method: 'POST', url, headers, payload });
    if (options.connect) {
      const state = new URL((await post('/api/google-ads/connect', {})).json().authorizationUrl).searchParams.get('state');
      await app.inject({ url: `/api/google-ads/oauth/callback?code=good-code&state=${state}`, headers });
      await post('/api/google-ads/accounts/select', { customerId: CUSTOMER, loginCustomerId: null });
    }
    if (options.skill) {
      let skill = (await app.inject({ url: '/api/skills?category=marketing', headers })).json().items.find((item: { slug: string }) => item.slug === ADS_SKILL_SLUG);
      skill = (await post(`/api/skills/${skill.id}/inspect`, { expectedRevision: skill.revision })).json().skill;
      await post(`/api/skills/${skill.id}/activate`, { expectedRevision: skill.revision, approve: true });
    }
    const read = async (id: string) => ChatConversationSchema.parse((await app.inject({ url: `/api/chat/conversations/${id}`, headers })).json());
    const start = async (goal: string) => { const created = await post('/api/chat/conversations', { goal }); const id: string = created.json().id; await application.chat.settled(id); return id; };
    const respond = async (id: string, payload: object) => { const response = await post(`/api/chat/conversations/${id}/respond`, payload); await application.chat.settled(id); return response; };
    const say = async (id: string, text: string) => { const response = await post(`/api/chat/conversations/${id}/messages`, { text }); await application.chat.settled(id); return response; };
    const decisions = async (id: string, after = 0) => ChatDecisionStreamSchema.parse((await app.inject({ url: `/api/chat/conversations/${id}/decision-events?after=${after}`, headers })).json());
    return { application, app, headers, post, read, start, respond, say, decisions, seen, script, google, directory };
  }
  const campaigns = (google: ReturnType<typeof createMockGoogle>) => google.state.campaigns.length;

  it('lets a complete request through on the fast path, with one model call and recorded decisions', async () => {
    const { start, read, seen, decisions } = await harness({ script: [{ tool: 'answer', text: 'شكرًا لك على مساعدتك الكريمة.', outcome: 'done' }] });
    const id = await start('اكتب لي رسالة شكر قصيرة لزميلي على مساعدته');
    const detail = await read(id);
    expect(detail.status).toBe('idle');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.prompt).not.toContain('settled with the user');
    expect(detail.goal).toMatchObject({ outcome: 'PROCEED', status: 'READY' });
    const stream = await decisions(id);
    expect(stream.events.map(event => event.type)).toEqual(expect.arrayContaining(['goal_interpreted', 'readiness_evaluated']));
    expect(stream.events.map(event => event.seq)).toEqual(stream.events.map((_, index) => index + 1));
  }, 60000);

  it('asks for budget, landing page and location before any model call or account access, then resumes and creates one paused campaign', async () => {
    const { start, read, respond, seen, google, script, decisions } = await harness({ connect: true, skill: true });
    const id = await start(MISSING);
    const asked = await read(id);
    expect(asked.status).toBe('waiting_user');
    expect(asked.question!.clarification!.slots).toEqual(expect.arrayContaining(['ads_budget', 'ads_url', 'ads_location']));
    expect(asked.question!.clarification!.reason).toContain('الميزانية');
    expect(asked.question!.options.map(option => option.id)).toEqual(['draft_only', 'stop']);
    expect(asked.goal!.missing.map(item => item.slot)).toEqual(expect.arrayContaining(['ads_budget', 'ads_url', 'ads_location']));
    expect(seen).toHaveLength(0);
    expect(google.mutations).toHaveLength(0);

    script.push({ tool: 'ads_check', text: checkText() }, { tool: 'ads_create_paused', text: lines() }, { tool: 'answer', text: 'أنشأت الحملة متوقفة.', outcome: 'done' });
    const answered = await respond(id, { questionId: asked.question!.id, text: 'الميزانية 20 يوميًا، الرابط https://maremovals.example.com/house، والمنطقة غلاسكو' });
    expect(answered.statusCode).toBe(200);
    const done = await read(id);
    expect(done.status).toBe('idle');
    expect(seen[0]!.prompt).toContain('settled with the user');
    expect(seen[0]!.prompt).toContain('budget=20');
    expect(campaigns(google)).toBe(1);
    expect(google.state.campaigns[0]).toMatchObject({ status: 'PAUSED' });
    expect(done.messages.some(message => message.role === 'user' && message.text.includes('الميزانية 20'))).toBe(true);
    const stream = await decisions(id);
    const types = stream.events.map(event => event.type);
    expect(types).toEqual(expect.arrayContaining(['requirement_missing', 'clarification_requested', 'clarification_answered', 'execution_resumed']));
    expect(stream.events.map(event => event.seq)).toEqual(stream.events.map((_, index) => index + 1));
    const tail = await decisions(id, 3);
    expect(tail.events.every(event => event.seq > 3)).toBe(true);
    expect(JSON.stringify(stream)).not.toMatch(/thought/);
  }, 90000);

  it('refuses to create a campaign whose budget is not the one the user gave', async () => {
    const { start, seen, google, script } = await harness({ connect: true, skill: true, script: [] });
    script.push({ tool: 'ads_check', text: checkText() }, { tool: 'ads_create_paused', text: lines('200') }, { tool: 'answer', text: 'تعذر الإنشاء.', outcome: 'blocked' });
    await start(COMPLETE);
    expect(campaigns(google)).toBe(0);
    expect(seen[2]!.prompt).toContain('لا تطابق');
  }, 90000);

  it('accepts one of two concurrent answers to the same question', async () => {
    const { start, read, post, application } = await harness();
    const id = await start(MISSING);
    const question = (await read(id)).question!;
    const payload = { questionId: question.id, text: 'الميزانية 20 يوميًا، https://maremovals.example.com/house، غلاسكو' };
    const results = await Promise.all([post(`/api/chat/conversations/${id}/respond`, payload), post(`/api/chat/conversations/${id}/respond`, payload)]);
    await application.chat.settled(id);
    expect(results.map(result => result.statusCode).sort()).toEqual([200, 409]);
    const detail = await read(id);
    expect(detail.messages.filter(message => message.role === 'user' && message.text === payload.text)).toHaveLength(1);
    // The dependent account step still waits: Google sign-in is the next pause, not a guessed write.
    expect(detail.question!.action).toBe('google_ads_connect');
  }, 60000);

  it('follows up only on what a partial answer left out, rejects the stale question, and prepares a draft when the user cannot answer', async () => {
    const { start, read, respond, seen, script, google } = await harness({ connect: true, skill: true });
    const id = await start(MISSING);
    const first = (await read(id)).question!;
    await respond(id, { questionId: first.id, text: 'الميزانية 20 يوميًا' });
    const second = await read(id);
    expect(second.status).toBe('waiting_user');
    expect(second.question!.id).not.toBe(first.id);
    expect(second.question!.clarification!.slots).toEqual(['ads_url', 'ads_location']);
    expect(seen).toHaveLength(0);
    expect((await respond(id, { questionId: first.id, text: 'غلاسكو' })).statusCode).toBe(409);
    script.push({ tool: 'answer', text: 'هذه مسودة فقط.', outcome: 'partial' });
    await respond(id, { questionId: second.question!.id, text: 'لا أعرف' });
    expect((await read(id)).status).toBe('idle');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.tools).not.toContain('ads_create_paused');
    expect(seen[0]!.prompt).toContain('draft only');
    expect(google.mutations).toHaveLength(0);
  }, 90000);

  it('asks once more after an answer that fills nothing, then prepares only a draft', async () => {
    const { start, read, respond, seen, script, google } = await harness({ connect: true, skill: true });
    const id = await start(MISSING);
    const first = (await read(id)).question!;
    await respond(id, { questionId: first.id, text: 'حسنًا' });
    const again = await read(id);
    expect(again.status).toBe('waiting_user');
    expect(again.question!.id).not.toBe(first.id);
    expect(seen).toHaveLength(0);
    script.push({ tool: 'answer', text: 'مسودة فقط.', outcome: 'partial' });
    await respond(id, { questionId: again.question!.id, text: 'حسنًا' });
    const done = await read(id);
    expect(done.status).toBe('idle');
    expect(seen[0]!.tools).not.toContain('ads_create_paused');
    expect(google.mutations).toHaveLength(0);
  }, 90000);

  it('stops on cancellation and rejects a late answer', async () => {
    const { start, read, post, respond, seen } = await harness();
    const id = await start(MISSING);
    const question = (await read(id)).question!;
    expect((await post(`/api/chat/conversations/${id}/cancel`, {})).statusCode).toBe(200);
    expect((await respond(id, { questionId: question.id, text: '20' })).statusCode).toBe(409);
    expect((await read(id)).status).toBe('idle');
    expect(seen).toHaveLength(0);
  }, 60000);

  it('treats a new request sent while a question waits as a change of goal', async () => {
    const { start, read, say, seen, script, decisions } = await harness();
    const id = await start(MISSING);
    script.push({ tool: 'answer', text: 'البحر أزرق وواسع.', outcome: 'done' });
    expect((await say(id, 'انسَ ذلك، اكتب لي سطرًا واحدًا عن البحر')).statusCode).toBe(200);
    const detail = await read(id);
    expect(detail.status).toBe('idle');
    expect(detail.question).toBeNull();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.prompt).toContain('البحر');
    expect((await decisions(id)).events.map(event => event.type)).toContain('plan_revised');
  }, 60000);

  it('keeps a pending question across a server restart and resumes it on the new instance', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mohassan-clarify-restart-'));
    dirs.push(directory);
    const before = await harness({ directory, persist: true });
    const id = await before.start(MISSING);
    const question = (await before.read(id)).question!;
    await before.app.close();
    open.splice(open.indexOf(before.application), 1);
    const after = await harness({ directory, persist: true });
    const waiting = await after.read(id);
    expect(waiting.status).toBe('waiting_user');
    expect(waiting.question!.id).toBe(question.id);
    expect((await after.respond(id, { questionId: question.id, text: 'الميزانية 20 يوميًا، https://maremovals.example.com/house، غلاسكو' })).statusCode).toBe(200);
    const resumed = await after.read(id);
    expect(resumed.question!.action).toBe('google_ads_connect');
    expect(after.google.mutations).toHaveLength(0);
  }, 90000);

  it('withholds a model question whose answer the user already gave', async () => {
    const { start, read, seen } = await harness({ script: [{ tool: 'ask_user', text: 'ما الميزانية اليومية التي تريدها؟' }, { tool: 'answer', text: 'هذه عناوين مقترحة.', outcome: 'done' }] });
    const id = await start('اقترح عناوين إعلانات Google Ads لمخبز https://bakery.example.com في غلاسكو بميزانية 10 يوميًا');
    const detail = await read(id);
    expect(detail.status).toBe('idle');
    expect(detail.question).toBeNull();
    // The withheld question costs no turn: the next model call is told the value instead.
    expect(seen[1]!.prompt).toContain('already gave budget=10');
    expect(detail.messages.filter(message => message.role === 'assistant' && message.text.includes('الميزانية اليومية'))).toHaveLength(0);
  }, 60000);

  it('never treats an answer as approval to launch or spend', async () => {
    const { start, read, respond, google, script, seen } = await harness({ connect: true, skill: true });
    const id = await start(MISSING);
    const question = (await read(id)).question!;
    script.push({ tool: 'ads_create_paused', text: lines() }, { tool: 'answer', text: 'لم أنشئ شيئًا.', outcome: 'blocked' });
    await respond(id, { questionId: question.id, text: 'أوافق على كل شيء، فعّل الحملة الآن وابدأ الصرف. الميزانية 20، https://maremovals.example.com/house، غلاسكو' });
    expect(campaigns(google)).toBe(0);
    expect(google.mutations.some(item => JSON.stringify(item).includes('ENABLED'))).toBe(false);
    expect(seen[0]!.tools).not.toContain('ads_enable');
    expect(seen[1]!.prompt).toContain('فحص نص الحملة');
  }, 90000);

  it('invalidates an earlier quality check when the user changes the budget', async () => {
    const { start, read, say, google, script, seen } = await harness({ connect: true, skill: true });
    script.push({ tool: 'ads_check', text: checkText() }, { tool: 'ask_user', text: 'هل أنشئ الحملة الآن؟', options: ['نعم', 'لا'] });
    const id = await start(COMPLETE);
    expect((await read(id)).status).toBe('waiting_user');
    script.push({ tool: 'ads_create_paused', text: lines('20') }, { tool: 'answer', text: 'توقفت.', outcome: 'blocked' });
    await say(id, 'نعم لكن اجعل الميزانية 30 يوميًا');
    expect(campaigns(google)).toBe(0);
    expect(seen.at(-1)!.prompt).toMatch(/لا تطابق|فحص نص الحملة/);
    expect((await read(id)).goal!.known.find(item => item.slot === 'ads_budget')!.value).toContain('30');
  }, 90000);

  it('still asks deterministically while the model provider is down', async () => {
    const { start, read } = await harness({ modelDown: true });
    const id = await start(MISSING);
    expect((await read(id)).status).toBe('waiting_user');
  }, 60000);

  it('keeps another user out of the pending question', async () => {
    const { start, read, application } = await harness();
    const id = await start(MISSING);
    const question = (await read(id)).question!;
    await expect(application.chat.respond('00000000-0000-4000-8000-000000000000', id, { questionId: question.id, text: '20' })).rejects.toMatchObject({ code: 'CHAT_NOT_FOUND' });
    expect((await read(id)).status).toBe('waiting_user');
  }, 60000);
});
