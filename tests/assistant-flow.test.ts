import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AgentBrowser } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';

const OWNER = 'owner-1';
const PASSWORD = 'fixture-pass-9931';
const CODE = '482913';

/** A small real site: public home, sign-in, code step, then an account page. */
function fixtureSite() {
  const state = { deleted: false, passwordAttempts: 0, codesSeen: 0 };
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
      if (url.pathname === '/login' && request.method === 'POST') {
        state.passwordAttempts += 1;
        if (form.get('username') === 'owner@example.test' && form.get('password') === PASSWORD) return redirect('/verify', { 'set-cookie': 'step=code; Path=/' });
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
    Object.assign(site.state, { deleted: false, passwordAttempts: 0, codesSeen: 0 });
    profile = await mkdtemp(path.join(tmpdir(), 'mohassan-agent-'));
    store = await createDatabase();
    await migrate(store.db);
  });
  afterEach(async () => {
    await control?.shutdown();
    await store.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  async function start(script: Script) {
    const groq = scriptedGroq(script);
    control = await createCommandChatControl(store.db, {
      apiKey: 'fixture-key-not-real', models: { fast: ['fast-model'], deep: ['deep-model'], vision: 'vision-model' }, fetch: groq.transport,
      browser: new AgentBrowser({ profileDir: profile, testOrigins: [origin], channel: null }),
      networkPolicy: { testOrigins: [origin] },
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
    expect(retry.status).toBe('waiting_input');
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
    expect(site.state.deleted).toBe(true);
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

  it('never reaches private addresses', async () => {
    const browser = new AgentBrowser({ profileDir: profile, channel: null });
    await expect(browser.open('o', randomUUID(), 'http://127.0.0.1:9/')).rejects.toMatchObject({ code: 'AGENT_NETWORK_DENIED' });
    await expect(browser.isAllowed('http://169.254.169.254/latest/meta-data')).resolves.toBe(false);
    await expect(browser.isAllowed('http://printer.local/')).resolves.toBe(false);
    await browser.close();
    await start(() => ({ tool: 'answer', text: 'تم', outcome: 'done' }));
  }, 30000);

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
