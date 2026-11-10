import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AgentBrowser, BrowserError, type SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import { fixtureProviders } from './fixtures/local-model.js';

const OWNER = 'owner-1';
const PASSWORD = 'fixture-pass-9931';
const CODE = '482913';

/** A small real site: public home, sign-in, code step, then an account page. */
function fixtureSite() {
  const state = { deleted: false, passwordAttempts: 0, codesSeen: 0, redirectRejectedPassword: false, cookieChoices: [] as string[], cookieImageAborts: 0, landingFontRequests: 0, landingBackgroundRequests: [] as string[] };
  const page = (title: string, body: string) => `<!doctype html><html lang="ar"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
  const server = createServer((request, response) => {
    const cookies = request.headers.cookie ?? '';
    const respond = (html: string, headers: Record<string, string> = {}) => { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...headers }); response.end(html); };
    const redirect = (location: string, headers: Record<string, string> = {}) => { response.writeHead(303, { location, ...headers }); response.end(); };
    const url = new URL(request.url ?? '/', 'http://site');
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const form = new URLSearchParams(body);
      if (url.pathname === '/ads') {
        if (!cookies.includes('cookie_choice=reject')) return redirect(`/consent${url.search}`);
        return respond(page('Ads landing page', `
          <style>@font-face { font-family: Ads; src: url(/oversized-landing-font) format("woff2"); } h1 { font-family: Ads, sans-serif; }</style>
          <h1>Advertising home</h1><iframe src="/landing-frame" hidden></iframe>
          <script>
            fetch('/landing-analytics', { method: 'POST', body: 'page-view' }).catch(() => {
              document.title = 'Ads landing page (analytics blocked)';
            });
          </script>`));
      }
      if (url.pathname === '/slow-consent-image') {
        response.once('close', () => { state.cookieImageAborts += 1; });
        return;
      }
      if (url.pathname === '/oversized-landing-font') {
        state.landingFontRequests += 1;
        response.writeHead(200, { 'content-type': 'font/woff2' });
        response.end(Buffer.alloc(2_000_001));
        return;
      }
      if (url.pathname === '/landing-analytics' || url.pathname === '/landing-frame') {
        state.landingBackgroundRequests.push(`${request.method} ${url.pathname}`);
        return respond(page('Background request received', '<p>Unapproved request reached the server.</p>'));
      }
      if (url.pathname === '/consent' && request.method === 'POST') {
        state.cookieChoices.push(body);
        if (form.get('choice') === 'reject' && form.get('continue') === '/ads') {
          return redirect('/ads', { 'set-cookie': 'cookie_choice=reject; Path=/' });
        }
      }
      if (url.pathname === '/consent') {
        const pendingImage = url.searchParams.has('slow') ? '<img src="/slow-consent-image" alt="">' : '';
        return respond(page('Cookie consent', `<h1>Before you continue</h1><p>We use cookies.</p><form method="post"><input type="hidden" name="continue" value="/ads"><button name="choice" value="reject">Reject all</button></form>${pendingImage}`));
      }
      if (url.pathname === '/login' && request.method === 'POST') {
        state.passwordAttempts += 1;
        if (form.get('username') === 'owner@example.test' && form.get('password') === PASSWORD) return redirect('/verify', { 'set-cookie': 'step=code; Path=/' });
        if (state.redirectRejectedPassword) return redirect('/login');
        return respond(page('Sign in', '<p>Wrong password</p><form method="post" action="/login"><input name="username" type="email" aria-label="Email"><input name="password" type="password" aria-label="Password"><button>Sign in</button></form>'));
      }
      if (url.pathname === '/login') return respond(page('Sign in', '<form method="post" action="/login"><input name="username" type="email" aria-label="Email"><input name="password" type="password" aria-label="Password"><button>Sign in</button></form>'));
      if (url.pathname === '/verify' && request.method === 'POST') {
        state.codesSeen += 1;
        if (form.get('code') === CODE) return redirect('/account', { 'set-cookie': 'session=ok; Path=/' });
        return redirect('/verify');
      }
      if (url.pathname === '/verify') return respond(page('Verify', '<form method="post" action="/verify"><label>Verification code <input name="code" autocomplete="one-time-code"></label><button>Verify</button></form>'));
      if (url.pathname === '/account') {
        if (!cookies.includes('session=ok')) return redirect('/login');
        return respond(page('Account', state.deleted ? '<main><h1>Account deleted</h1></main>' : '<main><h1>Balance: 1250</h1><form method="post" action="/delete"><button>Delete account</button></form></main>'));
      }
      if (url.pathname === '/delete') { state.deleted = true; return redirect('/account'); }
      return respond(page('Home', '<main><h1>Welcome</h1><a href="/account">Account</a></main>'));
    });
  });
  return { server, state };
}

type Script = (prompt: string, call: number) => Record<string, unknown>;

function scriptedGroq(script: Script) {
  const prompts: string[] = [];
  const transport = async (_url: unknown, init: any) => {
    const request = JSON.parse(init.body);
    const prompt = request.messages.map((message: any) => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n');
    prompts.push(prompt);
    const decision = { thought: null, plan: null, note: null, url: null, ref: null, text: null, submit: null, options: null, sensitive: null, outcome: null, ...script(request.messages.at(-1).content, prompts.length) };
    return new Response(JSON.stringify({
      model: request.model, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(decision) } }], usage: { prompt_tokens: 100, completion_tokens: 20 },
    }), { status: 200, headers: { 'x-ratelimit-remaining-tokens': '7000', 'x-ratelimit-reset-tokens': '1s' } });
  };
  return { prompts, transport: transport as typeof fetch };
}

/** Finds the ref of an element from the page description sent to the model. */
const refOf = (prompt: string, label: string) => new RegExp(`(e\\d+) \\w+ "${label}`).exec(prompt)?.[1] ?? null;

describe('the assistant finishing real work', () => {
  let site: ReturnType<typeof fixtureSite>;
  let origin: string;
  let profile: string;
  let store: Awaited<ReturnType<typeof createDatabase>>;
  let control: Awaited<ReturnType<typeof createCommandChatControl>>;

  beforeAll(async () => {
    site = fixtureSite();
    await new Promise<void>((resolve) => site.server.listen(0, '127.0.0.1', resolve));
    const address = (site.server as Server).address();
    origin = `http://127.0.0.1:${(address as { port: number }).port}`;
  });
  afterAll(async () => { await new Promise((resolve) => site.server.close(resolve)); });

  beforeEach(async () => {
    Object.assign(site.state, { deleted: false, passwordAttempts: 0, codesSeen: 0, redirectRejectedPassword: false, cookieChoices: [], cookieImageAborts: 0, landingFontRequests: 0, landingBackgroundRequests: [] });
    profile = await mkdtemp(path.join(tmpdir(), 'mohassan-agent-'));
    store = await createDatabase();
    await migrate(store.db);
  });
  afterEach(async () => {
    await control?.shutdown();
    await store.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  async function start(script: Script, searchProvider?: SearchProvider) {
    const groq = scriptedGroq(script);
    control = await createCommandChatControl(store.db, {
      models: { fast: ['fast-model'], deep: ['deep-model'], vision: 'vision-model' }, createProvider: fixtureProviders(groq.transport),
      browser: new AgentBrowser({ profileDir: profile, testOrigins: [origin], channel: null }),
      networkPolicy: { testOrigins: [origin] }, searchProvider,
    });
    return groq;
  }

  async function settle(id: string) {
    await control.settled(id);
    return control.detail(OWNER, id);
  }

  it('answers plain questions at once, with no browser', async () => {
    const groq = await start(() => ({ tool: 'answer', text: 'باريس', outcome: 'done' }));
    const { id } = await control.create(OWNER, { goal: 'ما عاصمة فرنسا؟' });
    const result = await settle(id);
    expect(result.status).toBe('idle');
    expect(result.messages.at(-1)?.text).toBe('باريس');
    expect(result.browser).toBeNull();
    expect(groq.prompts).toHaveLength(1);
  });

  it('opens a site with no model call', async () => {
    const groq = await start(() => { throw new Error('the model should not be needed'); });
    const { id } = await control.create(OWNER, { goal: `افتح ${origin}/` });
    const result = await settle(id);
    expect(result.status).toBe('idle');
    expect(result.messages.at(-1)?.text).toContain('Home');
    expect(result.browser?.live).toBe(true);
    expect(groq.prompts).toHaveLength(0);
    expect((await control.screen(OWNER, id)).length).toBeGreaterThan(500);
  });

  it('completes the approved cookie submission with background page traffic blocked', async () => {
    const groq = await start(() => { throw new Error('the model should not be needed'); });
    const goal = `افتح ${origin}/ads?slow=1 واعرض لي لقطة من الصفحة بعد تحميلها.`;
    const { id } = await control.create(OWNER, { goal });
    const waiting = await settle(id);
    expect(waiting.status, waiting.error ?? '').toBe('waiting_approval');
    expect(waiting.approval?.prompt).toContain('رفض ملفات الارتباط غير الضرورية');
    expect(waiting.approval?.detail).toContain('POST /consent');
    expect(waiting.browser?.url).toBe(`${origin}/consent?slow=1`);
    await expect.poll(() => site.state.cookieImageAborts).toBe(1);
    expect(site.state.cookieChoices).toEqual([]);
    expect(groq.prompts).toHaveLength(0);

    await control.approve(OWNER, id, { approvalId: waiting.approval!.id, approved: true });
    const finished = await settle(id);
    expect(site.state.landingFontRequests).toBe(1);
    expect(site.state.landingBackgroundRequests).toEqual(['GET /landing-frame']); // Option A: a same-site GET frame loads; the POST beacon stays blocked.
    expect(finished.status, finished.error ?? '').toBe('idle');
    expect(finished.browser).toMatchObject({ url: `${origin}/ads`, title: 'Ads landing page (analytics blocked)' });
    expect(finished.messages.at(-1)?.text).toContain('Ads landing page');
    expect(finished.messages.at(-1)?.text).toContain('لقطة');
    expect((await control.screen(OWNER, id)).length).toBeGreaterThan(500);

    const next = await control.create(OWNER, { goal });
    const reopened = await settle(next.id);
    expect(reopened.status, reopened.error ?? '').toBe('idle');
    expect(reopened.approval).toBeNull();
    expect(reopened.browser).toMatchObject({ url: `${origin}/ads?slow=1`, title: 'Ads landing page (analytics blocked)' });
    expect(reopened.messages.at(-1)?.text).toContain('Ads landing page');
    expect(reopened.messages.at(-1)?.text).toContain('لقطة');
    expect((await control.screen(OWNER, next.id)).length).toBeGreaterThan(500);
    expect(groq.prompts).toHaveLength(0);
    expect(site.state.landingBackgroundRequests).toEqual(['GET /landing-frame', 'GET /landing-frame']);
    expect(site.state.cookieChoices).toEqual(['continue=%2Fads&choice=reject']);
    const receipts = await store.db.selectFrom('chat_effect_receipts').select(['method', 'status', 'response_status']).execute();
    expect(receipts).toEqual([{ method: 'POST', status: 'responded', response_status: 303 }]);
  }, 60000);

  it('leaves the cookie form untouched when the owner declines', async () => {
    const groq = await start(() => { throw new Error('the model should not be needed'); });
    const { id } = await control.create(OWNER, { goal: `افتح ${origin}/ads` });
    const waiting = await settle(id);
    expect(waiting.status, waiting.error ?? '').toBe('waiting_approval');

    await control.approve(OWNER, id, { approvalId: waiting.approval!.id, approved: false });
    const finished = await settle(id);
    expect(finished.status, finished.error ?? '').toBe('idle');
    expect(finished.browser?.url).toBe(`${origin}/consent`);
    expect(finished.messages.at(-1)?.text).toContain('وصلت إلى صفحة إعدادات ملفات الارتباط');
    expect(site.state.cookieChoices).toEqual([]);
    expect(groq.prompts).toHaveLength(0);
  }, 60000);

  it('leaves sign-in to the owner when explicitly requested', async () => {
    const groq = await start(() => { throw new Error('the model should not be needed'); });
    const { id } = await control.create(OWNER, { goal: `افتح ${origin}/account حتى أسجّل الدخول بنفسي.` });
    const result = await settle(id);

    expect(result.status, result.error ?? '').toBe('idle');
    expect(result.secure).toBeNull();
    expect(result.approval).toBeNull();
    expect(result.browser).toMatchObject({ url: `${origin}/login`, live: true });
    expect(result.messages.at(-1)?.text).toContain('توقفت عند صفحة تسجيل الدخول');
    expect(result.messages.at(-1)?.text).toContain('بنفسك');
    expect(site.state.passwordAttempts).toBe(0);
    expect(groq.prompts).toHaveLength(0);
    const run = await store.db.selectFrom('chat_runs').select('status').where('conversation_id', '=', id).executeTakeFirstOrThrow();
    expect(run.status).toBe('partial');
  }, 60000);

  it('asks for fresh secrets after rejected password and OTP redirect to the same URL without replay', async () => {
    await start(prompt => prompt.includes('Balance: 1250') ? {tool:'answer',text:'اكتمل الدخول بعد تصحيح البيانات.',outcome:'done'} : {tool:'open',url:`${origin}/account`});
    site.state.redirectRejectedPassword=true;
    const {id}=await control.create(OWNER,{goal:'سجل الدخول إلى الحساب التجريبي وتحقق من الصفحة.'});
    const login=await settle(id);expect(login.status).toBe('waiting_input');expect(login.secure?.kind).toBe('login');
    await control.secureSubmit(OWNER,id,{requestId:login.secure!.id,action:'submit',values:{username:'owner@example.test',password:'incorrect-secret'}});
    const passwordRetry=await settle(id);expect(passwordRetry.status,passwordRetry.error??'').toBe('waiting_input');expect(passwordRetry.secure?.note).toContain('لم يقبل الموقع هذه البيانات');
    expect(site.state.passwordAttempts).toBe(1);expect(site.state.codesSeen).toBe(0);
    await control.secureSubmit(OWNER,id,{requestId:passwordRetry.secure!.id,action:'submit',values:{username:'owner@example.test',password:PASSWORD}});
    const code=await settle(id);expect(code.secure?.kind).toBe('code');expect(site.state.passwordAttempts).toBe(2);
    await control.secureSubmit(OWNER,id,{requestId:code.secure!.id,action:'submit',values:{code:'193857'}});
    const codeRetry=await settle(id);expect(codeRetry.status,codeRetry.error??'').toBe('waiting_input');expect(codeRetry.secure?.note).toContain('لم يقبل الموقع الرمز السابق');
    expect(site.state.codesSeen).toBe(1);expect(site.state.passwordAttempts).toBe(2);
    await control.secureSubmit(OWNER,id,{requestId:codeRetry.secure!.id,action:'submit',values:{code:CODE}});
    const done=await settle(id);expect(done.status,done.error??'').toBe('idle');expect(done.messages.at(-1)?.text).toBe('اكتمل الدخول بعد تصحيح البيانات.');
    expect(site.state.passwordAttempts).toBe(2);expect(site.state.codesSeen).toBe(2);expect(site.state.deleted).toBe(false);
    const stored=JSON.stringify([await store.db.selectFrom('chat_messages').selectAll().execute(),await store.db.selectFrom('chat_runs').selectAll().execute(),await store.db.selectFrom('chat_events').selectAll().execute()]);
    for(const secret of [PASSWORD,CODE,'incorrect-secret','193857'])expect(stored).not.toContain(secret);
  },60000);

  it('stops for a sign-in and a code, continues the task, and asks before deleting', async () => {
    const groq = await start((prompt) => {
      if (prompt.includes('Account deleted')) return { tool: 'answer', text: 'حُذف الحساب.', outcome: 'done' };
      if (prompt.includes('Balance: 1250')) return { tool: 'click', ref: refOf(prompt, 'Delete account') };
      return { tool: 'open', url: `${origin}/account`, plan: ['فتح الحساب', 'حذف الحساب'] };
    });
    const { id } = await control.create(OWNER, { goal: 'ادخل إلى حسابي واحذفه' });

    const login = await settle(id);
    expect(login.status).toBe('waiting_input');
    expect(login.secure).toMatchObject({ kind: 'login', fields: [{ id: 'username' }, { id: 'password' }] });
    const callsBeforeLogin = groq.prompts.length;

    await control.secureSubmit(OWNER, id, { requestId: login.secure!.id, action: 'submit', values: { username: 'owner@example.test', password: 'wrong-password-1' } });
    const retry = await settle(id);
    expect(retry.status,retry.error??'').toBe('waiting_input');
    expect(retry.secure?.note).toMatch(/لم يقبل/);

    await control.secureSubmit(OWNER, id, { requestId: retry.secure!.id, action: 'submit', values: { username: 'owner@example.test', password: PASSWORD } });
    const code = await settle(id);
    expect(code.secure).toMatchObject({ kind: 'code', fields: [{ id: 'code' }] });
    expect(groq.prompts.length).toBe(callsBeforeLogin);

    await control.secureSubmit(OWNER, id, { requestId: code.secure!.id, action: 'submit', values: { code: CODE } });
    const approval = await settle(id);
    expect(approval.status).toBe('waiting_approval');
    expect(approval.approval?.prompt).toContain('Delete account');
    expect(site.state.deleted).toBe(false);

    await control.approve(OWNER, id, { approvalId: approval.approval!.id, approved: true });
    const finished = await settle(id);
    expect(site.state.deleted,finished.error??'').toBe(true);
    expect(finished.status).toBe('idle');
    expect(finished.messages.at(-1)?.text).toBe('حُذف الحساب.');
    expect(finished.steps.map((step) => step.text).join(' ')).toContain('اكتمل تسجيل الدخول');

    const stored = JSON.stringify([
      await store.db.selectFrom('chat_messages').selectAll().execute(),
      await store.db.selectFrom('chat_runs').selectAll().execute(),
      await store.db.selectFrom('chat_events').selectAll().execute(),
      await store.db.selectFrom('chat_conversations').selectAll().execute(),
    ]);
    const everything = `${stored}\n${groq.prompts.join('\n')}`;
    expect(everything).not.toContain(PASSWORD);
    expect(everything).not.toContain('wrong-password-1');
    expect(everything).not.toContain(CODE);
  }, 60000);

  it('respects a refused action', async () => {
    let refused = false;
    await start((prompt) => {
      if (prompt.includes('refused this action')) { refused = true; return { tool: 'answer', text: 'لم أنفذ الحذف.', outcome: 'partial' }; }
      if (prompt.includes('Balance: 1250')) return { tool: 'click', ref: refOf(prompt, 'Delete account') };
      return { tool: 'open', url: `${origin}/account` };
    });
    const { id } = await control.create(OWNER, { goal: 'ادخل إلى حسابي' });
    const login = await settle(id);
    await control.secureSubmit(OWNER, id, { requestId: login.secure!.id, action: 'submit', values: { username: 'owner@example.test', password: PASSWORD } });
    const code = await settle(id);
    await control.secureSubmit(OWNER, id, { requestId: code.secure!.id, action: 'submit', values: { code: CODE } });
    const approval = await settle(id);
    await control.approve(OWNER, id, { approvalId: approval.approval!.id, approved: false });
    const finished = await settle(id);
    expect(refused).toBe(true);
    expect(site.state.deleted).toBe(false);
    expect(finished.status).toBe('idle');
  }, 60000);

  it('remembers the sign-in on the next visit', async () => {
    await start((prompt) => prompt.includes('Balance: 1250')
      ? { tool: 'answer', text: 'الرصيد 1250', outcome: 'done' }
      : { tool: 'open', url: `${origin}/account` });
    const { id } = await control.create(OWNER, { goal: 'كم رصيدي؟' });
    const login = await settle(id);
    await control.secureSubmit(OWNER, id, { requestId: login.secure!.id, action: 'submit', values: { username: 'owner@example.test', password: PASSWORD } });
    const code = await settle(id);
    await control.secureSubmit(OWNER, id, { requestId: code.secure!.id, action: 'submit', values: { code: CODE } });
    await settle(id);
    const attempts = site.state.passwordAttempts;
    const second = await control.create(OWNER, { goal: 'كم رصيدي الآن؟' });
    const result = await settle(second.id);
    expect(result.messages.at(-1)?.text).toBe('الرصيد 1250');
    expect(site.state.passwordAttempts).toBe(attempts);
  }, 60000);

  it('recovers from a failed step instead of stopping', async () => {
    await start((prompt, call) => {
      if (call === 1) return { tool: 'click', ref: 'e99' };
      if (prompt.includes('failed:') && !prompt.includes('Welcome')) return { tool: 'open', url: `${origin}/` };
      return { tool: 'answer', text: 'وصلت إلى الصفحة.', outcome: 'done' };
    });
    const { id } = await control.create(OWNER, { goal: 'اذهب إلى الرئيسية بأي طريقة' });
    const result = await settle(id);
    expect(result.status).toBe('idle');
    expect(result.messages.at(-1)?.text).toBe('وصلت إلى الصفحة.');
  }, 40000);

  it('runs a repeated search once, even reworded in another order', async () => {
    const queries: string[] = [];
    const provider: SearchProvider = { name: 'fixture', search: async (question) => { queries.push(question); return [{ title: 'Alpha docs', url: 'https://example.test/alpha', snippet: 'alpha beta' }]; } };
    await start((prompt, call) => {
      if (prompt.includes('You already searched')) return { tool: 'answer', text: 'وجدت المصدر.', outcome: 'done' };
      return { tool: 'search', text: call === 1 ? 'alpha beta' : 'Beta  ALPHA' };
    }, provider);
    const { id } = await control.create(OWNER, { goal: 'ابحث عن alpha beta' });
    const result = await settle(id);
    expect(queries).toEqual(['alpha beta']);
    expect(result.status).toBe('idle');
    expect(result.messages.at(-1)?.text).toBe('وجدت المصدر.');
  }, 40000);

  it('stops rewording a search that finds nothing and goes to the site', async () => {
    const queries: string[] = [];
    const provider: SearchProvider = { name: 'fixture', search: async (question) => { queries.push(question); throw new BrowserError('RESEARCH_SEARCH_UNAVAILABLE', 'no results', 502); } };
    await start((prompt) => {
      if (prompt.includes('Welcome')) return { tool: 'answer', text: 'فتحت الموقع مباشرة.', outcome: 'done' };
      if (prompt.includes('Web search gave nothing usable')) return { tool: 'open', url: `${origin}/` };
      return { tool: 'search', text: 'alpha beta' };
    }, provider);
    const { id } = await control.create(OWNER, { goal: 'ابحث عن alpha beta' });
    const result = await settle(id);
    expect(queries).toHaveLength(1);
    expect(result.messages.at(-1)?.text).toBe('فتحت الموقع مباشرة.');
  }, 40000);

  it('never reaches private addresses', async () => {
    const browser = new AgentBrowser({ profileDir: profile, channel: null });
    await expect(browser.open('o', randomUUID(), 'http://127.0.0.1:9/')).rejects.toMatchObject({ code: 'AGENT_NETWORK_DENIED' });
    await expect(browser.isAllowed('http://169.254.169.254/latest/meta-data')).resolves.toBe(false);
    await expect(browser.isAllowed('http://printer.local/')).resolves.toBe(false);
    await browser.close();
    await start(() => ({ tool: 'answer', text: 'تم', outcome: 'done' }));
  }, 30000);

  it('deletes a conversation for its owner only, closing its page and every row', async () => {
    await start(() => { throw new Error('the model should not be needed'); });
    const { id } = await control.create(OWNER, { goal: `افتح ${origin}/` });
    const opened = await settle(id);
    expect(opened.browser?.live).toBe(true);
    await expect(control.remove('someone-else', id)).rejects.toMatchObject({ code: 'CHAT_NOT_FOUND' });
    await expect(control.remove(OWNER, id)).resolves.toEqual({ ok: true });
    await expect(control.detail(OWNER, id)).rejects.toMatchObject({ code: 'CHAT_NOT_FOUND' });
    expect((await control.list(OWNER)).conversations.some((item) => item.id === id)).toBe(false);
    for (const table of ['chat_messages', 'chat_runs', 'chat_events', 'chat_observations'] as const) {
      expect(await store.db.selectFrom(table).select('id').where('conversation_id', '=', id).execute(), table).toHaveLength(0);
    }
    await expect(control.screen(OWNER, id)).rejects.toMatchObject({ code: 'CHAT_NOT_FOUND' });
  }, 40000);

  it('deletes a conversation while it is still waiting on the owner', async () => {
    await start(() => ({ tool: 'open', url: `${origin}/account` }));
    const { id } = await control.create(OWNER, { goal: 'افتح حسابي واعرض الرصيد' });
    expect((await settle(id)).status).toBe('waiting_input');
    await expect(control.remove(OWNER, id)).resolves.toEqual({ ok: true });
    await expect(control.detail(OWNER, id)).rejects.toMatchObject({ code: 'CHAT_NOT_FOUND' });
  }, 40000);

  it('stops on request and forgets the sign-in', async () => {
    await start(() => ({ tool: 'open', url: `${origin}/account` }));
    const { id } = await control.create(OWNER, { goal: 'افتح حسابي واعرض الرصيد' });
    const login = await settle(id);
    const stopped = await control.cancel(OWNER, id);
    expect(stopped.status).toBe('idle');
    expect(stopped.secure).toBeNull();
    await expect(control.secureSubmit(OWNER, id, { requestId: login.secure!.id, action: 'submit', values: { password: 'x' } })).rejects.toMatchObject({ code: 'CHAT_SECURE_CHANGED' });
    await sql`SELECT 1`.execute(store.db);
  }, 40000);
});
