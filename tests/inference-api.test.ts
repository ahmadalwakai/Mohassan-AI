import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AgentBrowser } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { createApplication } from '../apps/server/src/app.js';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import { createInferenceControl } from '../apps/server/src/inference.js';

const KEY = 'freellmapi-fixture-key-never-in-http-0001';
const GROQ_KEY = 'groq-fixture-key-never-in-http-0001';
const origin = 'http://127.0.0.1:3000';
const secret = 'isolated-inference-internal-fixture-secret-01';
const headers = { 'x-mohassan-internal': secret, origin };
const decision = (fields: Record<string, unknown>) => JSON.stringify({ thought: null, plan: null, note: null, url: null, ref: null, text: null, submit: null, options: null, sensitive: null, outcome: null, ...fields });
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...extra } });

type Reply = (body: any) => Response;
/** One fake transport for both hosts: a FreeLLMAPI gateway on :3001 and Groq. */
function transport(free: Reply, groq: Reply = body => json({ model: body.model, choices: [{ finish_reason: 'stop', message: { content: decision({ tool: 'answer', text: 'من Groq', outcome: 'done' }) } }], usage: { prompt_tokens: 50, completion_tokens: 9 } })) {
  const calls: { host: string; path: string; body: any; auth: string | null }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ host: url.host, path: url.pathname, body, auth: (init?.headers as Record<string, string> | undefined)?.Authorization ?? null });
    if (url.host === '127.0.0.1:3001') {
      if (url.pathname === '/v1/models') return json({ object: 'list', data: [{ id: 'auto', owned_by: 'freellmapi', available: true }, { id: 'llama-3.3-70b', owned_by: 'groq', available: true, execution_status: 'ready', supported_parameters: ['stream', 'response_format', 'tools'] }] });
      if (url.pathname === '/v1/usage') return json({ month: '2026-11', resetsAt: '2026-12-01T00:00:00.000Z', requests: 4, tokens: 1200, byPlatform: [] });
      return free(body);
    }
    return groq(body);
  }) as typeof globalThis.fetch;
  return { fetch, calls, chat: (host: string) => calls.filter(call => call.host === host && call.path.endsWith('/chat/completions')) };
}

describe('provider settings API', () => {
  let application: Awaited<ReturnType<typeof createApplication>>;
  let cookie = '';
  const fake = transport(() => json({ error: { code: 'rate_limit_exceeded' } }, 429));
  beforeAll(async () => {
    application = await createApplication({
      authSecret: 'isolated-inference-auth-fixture-secret-0001', internalSecret: secret, setupToken: 'isolated-inference-setup-fixture-token-001', webOrigin: origin, production: false, runWorker: false,
      groqApiKey: GROQ_KEY, aiFetch: fake.fetch,
      inference: { freellmapi: { enabled: false, baseUrl: 'http://127.0.0.1:3001', apiKey: KEY, models: ['auto'], freeOnly: true }, automaticFallback: true, allowPaidFallback: false },
    });
    await application.app.inject({ method: 'POST', url: '/api/setup', headers, payload: { name: 'مالك اختبار المزودين', email: 'providers@example.test', password: 'Providers-Only-Fixture-Password-42', setupToken: 'isolated-inference-setup-fixture-token-001' } });
    const signin = await application.app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers, payload: { email: 'providers@example.test', password: 'Providers-Only-Fixture-Password-42' } });
    cookie = (Array.isArray(signin.headers['set-cookie']) ? signin.headers['set-cookie'] : [signin.headers['set-cookie']]).filter(Boolean).map(value => String(value).split(';')[0]).join('; ');
  });
  afterAll(async () => { await application?.app.close(); });

  it('requires a session and never returns the keys', async () => {
    expect((await application.app.inject({ url: '/api/ai/providers', headers })).statusCode).toBe(401);
    const response = await application.app.inject({ url: '/api/ai/providers', headers: { ...headers, cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json().freellmapi).toMatchObject({ configured: true, baseUrl: 'http://127.0.0.1:3001/v1', settings: { enabled: false, models: ['auto'], freeOnly: true } });
    expect(response.body).not.toContain(KEY);
    expect(response.body).not.toContain(GROQ_KEY);
    expect(fake.chat('127.0.0.1:3001')).toHaveLength(0);
  });

  it('validates settings, checks Origin and persists the toggle', async () => {
    const bad = await application.app.inject({ method: 'POST', url: '/api/ai/providers/freellmapi/settings', headers: { ...headers, cookie }, payload: { enabled: true, models: [], automaticFallback: true, freeOnly: true } });
    expect(bad.statusCode).toBe(400);
    const extra = await application.app.inject({ method: 'POST', url: '/api/ai/providers/freellmapi/settings', headers: { ...headers, cookie }, payload: { enabled: true, models: ['auto'], automaticFallback: true, freeOnly: true, apiKey: 'x' } });
    expect(extra.statusCode).toBe(400);
    const foreign = await application.app.inject({ method: 'POST', url: '/api/ai/providers/freellmapi/settings', headers: { ...headers, cookie, origin: 'https://evil.example' }, payload: { enabled: true, models: ['auto'], automaticFallback: true, freeOnly: true } });
    expect(foreign.statusCode).toBe(403);
    const saved = await application.app.inject({ method: 'POST', url: '/api/ai/providers/freellmapi/settings', headers: { ...headers, cookie }, payload: { enabled: true, models: ['auto:fast', 'auto'], automaticFallback: true, freeOnly: true } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().freellmapi.settings).toEqual({ enabled: true, models: ['auto:fast', 'auto'], automaticFallback: true, freeOnly: true });
    const row = await application.database.db.selectFrom('ai_provider_settings').selectAll().executeTakeFirstOrThrow();
    expect(row.models).toEqual(['auto:fast', 'auto']);
  });

  it('checks the gateway by discovery and usage only, without spending quota', async () => {
    const response = await application.app.inject({ method: 'POST', url: '/api/ai/providers/freellmapi/check', headers: { ...headers, cookie }, payload: {} });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.freellmapi.health).toMatchObject({ status: 'reachable', readyModels: 1 });
    expect(body.freellmapi.models.map((model: { id: string }) => model.id)).toEqual(['auto', 'llama-3.3-70b']);
    expect(body.freellmapi.gatewayUsage).toMatchObject({ month: '2026-11', requests: 4, tokens: 1200 });
    expect(fake.chat('127.0.0.1:3001')).toHaveLength(0);
    expect(fake.calls.filter(call => call.host === '127.0.0.1:3001').every(call => call.auth === `Bearer ${KEY}`)).toBe(true);
    const workspace = await application.app.inject({ url: '/api/workspace', headers: { ...headers, cookie } });
    expect(workspace.json().integrations.find((item: { id: string }) => item.id === 'freellmapi')).toMatchObject({ status: 'connected' });
  });
});

describe('provider settings without a configured gateway', () => {
  it('refuses to enable FreeLLMAPI', async () => {
    const store = await createDatabase();
    try {
      await migrate(store.db);
      const control = await createInferenceControl(store.db, { freellmapi: { enabled: true } });
      expect(control.active()).toBe(false);
      expect(control.routerFor('fast')).toBeNull();
      await expect(control.save('owner', { enabled: true, models: ['auto'], automaticFallback: true, freeOnly: true })).rejects.toMatchObject({ statusCode: 409 });
    } finally { await store.close(); }
  });
});

describe('the assistant routed through FreeLLMAPI', () => {
  let store: Awaited<ReturnType<typeof createDatabase>>;
  let profile: string;
  let control: Awaited<ReturnType<typeof createCommandChatControl>> | undefined;
  beforeEach(async () => { profile = await mkdtemp(path.join(tmpdir(), 'mohassan-inference-')); store = await createDatabase(); await migrate(store.db); });
  afterEach(async () => { await control?.shutdown(); control = undefined; await store.close(); await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

  async function start(fake: ReturnType<typeof transport>, settings: { enabled: boolean; freeOnly: boolean; allowPaidFallback?: boolean }) {
    const inference = await createInferenceControl(store.db, {
      freellmapi: { enabled: settings.enabled, baseUrl: 'http://127.0.0.1:3001', apiKey: KEY, models: ['auto'], freeOnly: settings.freeOnly },
      groq: { apiKey: GROQ_KEY, fast: ['fast-model'], deep: ['deep-model'] }, automaticFallback: true, allowPaidFallback: settings.allowPaidFallback ?? false, fetch: fake.fetch,
    });
    control = await createCommandChatControl(store.db, {
      apiKey: GROQ_KEY, inference, models: { fast: ['fast-model'], deep: ['deep-model'], vision: 'vision-model' }, fetch: fake.fetch,
      browser: new AgentBrowser({ profileDir: profile, channel: null }),
    });
    return { control, inference };
  }
  async function ask(goal: string) {
    const { id } = await control!.create('owner-1', { goal });
    await control!.settled(id);
    const receipts = await store.db.selectFrom('chat_model_receipts').select(['model', 'status']).orderBy('started_at').execute();
    return { detail: await control!.detail('owner-1', id), receipts };
  }

  it('answers through a free model and records the receipt and usage', async () => {
    const fake = transport(() => json({ model: 'llama-3.3-70b', choices: [{ finish_reason: 'stop', message: { content: '```json\n' + decision({ tool: 'answer', text: 'باريس', outcome: 'done' }) + '\n```' } }], usage: { prompt_tokens: 80, completion_tokens: 12 } }, 200, { 'x-routed-via': 'groq/llama-3.3-70b' }));
    const { inference } = await start(fake, { enabled: true, freeOnly: true });
    const { detail, receipts } = await ask('ما عاصمة فرنسا؟');
    expect(detail.messages.at(-1)?.text).toBe('باريس');
    expect(receipts).toEqual([{ model: 'freellmapi:auto', status: 'succeeded' }]);
    expect(fake.chat('api.groq.com')).toHaveLength(0);
    expect(fake.chat('127.0.0.1:3001')[0]!.body).toMatchObject({ model: 'auto', response_format: { type: 'json_schema' } });
    const status = await inference.status();
    expect(status.usage.totals).toMatchObject({ inputTokens: 80, outputTokens: 12, estimatedCostUsd: 0 });
    expect(status.usage.recorded).toEqual([expect.objectContaining({ model: 'freellmapi:auto', requests: 1, inputTokens: 80 })]);
  });

  it('stays free-only when every free model is rate-limited', async () => {
    const fake = transport(() => json({ error: { code: 'rate_limit_exceeded' } }, 429, { 'retry-after': '600' }));
    await start(fake, { enabled: true, freeOnly: true });
    const { detail, receipts } = await ask('ما عاصمة فرنسا؟');
    expect(fake.chat('api.groq.com')).toHaveLength(0);
    expect(fake.chat('127.0.0.1:3001')).toHaveLength(1);
    expect(detail.status).not.toBe('running');
    expect(receipts).toEqual([{ model: 'freellmapi:auto', status: 'failed' }]);
  });

  it('continues on Groq only when the server allows paid fallback', async () => {
    const fake = transport(() => json({ error: { code: 'rate_limit_exceeded' } }, 429));
    await start(fake, { enabled: true, freeOnly: false, allowPaidFallback: true });
    const { detail, receipts } = await ask('ما عاصمة فرنسا؟');
    expect(detail.messages.at(-1)?.text).toBe('من Groq');
    expect(receipts).toEqual([{ model: 'freellmapi:auto', status: 'failed' }, { model: 'groq:deep-model', status: 'succeeded' }]);
  });

  it('keeps the original Groq path while FreeLLMAPI is off', async () => {
    const fake = transport(() => { throw new Error('FreeLLMAPI must not be called'); });
    await start(fake, { enabled: false, freeOnly: true });
    const { detail, receipts } = await ask('ما عاصمة فرنسا؟');
    expect(detail.messages.at(-1)?.text).toBe('من Groq');
    expect(receipts).toEqual([{ model: 'deep-model', status: 'succeeded' }]);
    expect(fake.calls.filter(call => call.host === '127.0.0.1:3001')).toHaveLength(0);
  });
});
