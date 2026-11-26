import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type DatabaseHandle } from '@mohassan/database';
import { createInferenceControl, withoutExternalAI, type InferenceConfig } from '../apps/server/src/inference.js';

const KEY = 'fixture-opt-in-key-never-a-real-credential';
const FAST = 'openai/gpt-oss-20b', DEEP = 'openai/gpt-oss-120b', VISION = 'qwen/qwen3.8-27b';
const goal = { goal: 'Inspect the authorized account only.', maxTokens: 128 };
function fixture(options: { models?: string[]; status?: number; configuredModels?: string[] } = {}) {
  const calls: { path: string; body: any }[] = [];
  const transport = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin !== 'https://api.groq.com') throw new Error('Unexpected external origin in fixture');
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ path: url.pathname, body });
    if (url.pathname.endsWith('/models')) return Response.json(options.status ? { error: { message: 'untrusted upstream detail' } } : { data: (options.models ?? [FAST, DEEP, VISION]).map(id => ({ id, active: true })) }, { status: options.status ?? 200 });
    if (url.pathname.endsWith('/chat/completions')) return Response.json({ model: body.model, choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 8, completion_tokens: 4 } });
    throw new Error('Unexpected fixture endpoint');
  }) as typeof fetch;
  const config: InferenceConfig = { assistantOptIn: { groq: { apiKey: KEY, fast: [options.configuredModels?.[0] ?? FAST], deep: [options.configuredModels?.[1] ?? DEEP], vision: options.configuredModels?.[2] ?? VISION } }, fetch: transport };
  return { config, calls, generations: () => calls.filter(call => call.path.endsWith('/chat/completions')) };
}

describe('owner-controlled assistant provider opt-in', () => {
  let store: DatabaseHandle;
  beforeAll(async () => { store = await createDatabase(); });
  afterEach(async () => { await store.db.deleteFrom('ai_assistant_settings').execute(); });
  afterAll(async () => { await store.close(); });

  it('keeps configured keys inactive with no network call until an explicit owner opt-in', async () => {
    const f = fixture(), control = await createInferenceControl(store.db, f.config);
    expect(control.active()).toBe(false); expect(control.routerFor('deep')).toBeNull(); expect(control.visionProvider()).toBeNull();
    expect(control.candidates('fast')).toEqual([]);
    expect((await control.status()).assistant).toMatchObject({ configured: true, enabled: false, active: false, automaticFallback: false, allowPaidFallback: false });
    await expect(control.checkAssistant()).rejects.toMatchObject({ code: 'DISABLED_BY_OWNER' });
    expect(JSON.stringify(await control.status())).not.toContain(KEY);
    expect(f.calls).toHaveLength(0);
    expect(withoutExternalAI(f.config).assistantOptIn).toBeUndefined();
  });
  it('enables only after catalog discovery and sends no generation during the owner check', async () => {
    const f = fixture(), control = await createInferenceControl(store.db, f.config);
    const status = await control.saveAssistant('owner-fixture', { enabled: true });
    expect(status.assistant).toMatchObject({ enabled: true, active: true, checkedAt: expect.any(String) });
    expect(f.calls).toHaveLength(1); expect(f.calls[0].path).toBe('/openai/v1/models'); expect(f.generations()).toHaveLength(0);
    expect(control.candidates('deep')).toHaveLength(1); expect(control.candidates('deep')[0]).toMatchObject({ model: DEEP, capabilities: { structured: true, vision: false } });
    expect(control.candidates('fast')[0].model).toBe(FAST); expect(control.visionProvider()?.model).toBe(VISION);
    expect(await store.db.selectFrom('ai_assistant_settings').select('updated_by').executeTakeFirst()).toEqual({ updated_by: 'owner-fixture' });
  });
  it('uses the selected verified planner for an actual routed request and keeps fallback disabled', async () => {
    const f = fixture(), control = await createInferenceControl(store.db, f.config);
    await control.saveAssistant('owner-fixture', { enabled: true });
    const result = await control.routerFor('deep')!.generate({ ...goal, structured: { name: 'fixture_plan', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } } }, { validate: text => JSON.parse(text).ok === true });
    expect(result).toMatchObject({ model: DEEP, providerId: 'groq', cost: 'paid' });
    expect(f.generations()).toHaveLength(1); expect(f.generations()[0].body.model).toBe(DEEP);
    expect(f.generations()[0].body.response_format).toMatchObject({ type: 'json_schema', json_schema: { name: 'fixture_plan', strict: true } });
    expect(control.freeActive()).toBe(false);
  });
  it('never treats unlisted or unknown configured models as planner or vision capabilities', async () => {
    const f = fixture({ models: ['unknown-vision'], configuredModels: ['unknown-vision', 'unlisted-model', 'unknown-vision'] });
    const control = await createInferenceControl(store.db, f.config);
    const status = await control.saveAssistant('owner-fixture', { enabled: true });
    expect(status.assistant).toMatchObject({ active: false, code: 'MODEL_CAPABILITY_UNAVAILABLE' });
    expect(status.assistant?.models.every(model => !model.structured && !model.vision)).toBe(true);
    expect(control.routerFor('deep')).toBeNull(); expect(control.visionProvider()).toBeNull(); expect(f.generations()).toHaveLength(0);
  });
  it('does not route a screenshot through a verified text-only model when vision is unavailable', async () => {
    const f = fixture({ models: [FAST, DEEP] }), control = await createInferenceControl(store.db, f.config);
    await control.saveAssistant('owner-fixture', { enabled: true });
    expect(control.visionProvider()).toBeNull();
    await expect(control.routerFor('deep')!.generate({ ...goal, image: { mimeType: 'image/png', data: Buffer.from('fixture screenshot').toString('base64') } })).rejects.toBeDefined();
    expect(f.generations()).toHaveLength(0);
  });
  it('uses the documented listed vision model through the existing image adapter only after opt-in', async () => {
    const f = fixture(), control = await createInferenceControl(store.db, f.config);
    await control.saveAssistant('owner-fixture', { enabled: true });
    const data = Buffer.from('fixture screenshot bytes, not a live image').toString('base64');
    const vision = control.visionProvider()!;
    await vision.provider.generate({ ...goal, image: { mimeType: 'image/png', data } });
    expect(f.generations()).toHaveLength(1);
    expect(f.generations()[0].body).toMatchObject({ model: VISION, messages: expect.arrayContaining([expect.objectContaining({ role: 'user', content: expect.arrayContaining([expect.objectContaining({ type: 'image_url', image_url: { url: `data:image/png;base64,${data}` } })]) })]) });
  });
  it('reports rejected credentials without readiness or raw upstream details', async () => {
    const f = fixture({ status: 401 }), control = await createInferenceControl(store.db, f.config);
    const status = await control.saveAssistant('owner-fixture', { enabled: true });
    expect(status.assistant).toMatchObject({ enabled: true, active: false, checkedAt: null, code: 'AUTHENTICATION_FAILED' });
    expect(JSON.stringify(status)).not.toContain('untrusted upstream detail'); expect(f.generations()).toHaveLength(0);
  });
  it('revokes cached routers, clears readiness and cannot send a pending request after disable', async () => {
    const f = fixture(), control = await createInferenceControl(store.db, f.config);
    await control.saveAssistant('owner-fixture', { enabled: true });
    const previous = control.routerFor('deep')!;
    await control.saveAssistant('owner-fixture', { enabled: false });
    expect(control.active()).toBe(false); expect(control.visionProvider()).toBeNull();
    expect((await control.status()).assistant?.checkedAt).toBeNull();
    await expect(previous.generate(goal)).rejects.toBeDefined(); expect(f.generations()).toHaveLength(0);
    await expect(control.saveAssistant('owner-fixture', { enabled: true, apiKey: 'client-supplied' })).rejects.toBeDefined();
  });
  it('restores intentional opt-in after restart but expires stale discovery without automatic network calls', async () => {
    const f = fixture(), first = await createInferenceControl(store.db, f.config);
    await first.saveAssistant('owner-fixture', { enabled: true });
    const restored = await createInferenceControl(store.db, f.config);
    expect(restored.active()).toBe(true); expect(f.calls).toHaveLength(1);
    await store.db.updateTable('ai_assistant_settings').set({ checked_at: new Date(Date.now() - 25 * 3600000) }).execute();
    await restored.refreshAssistant();
    expect(restored.active()).toBe(false); expect(restored.visionProvider()).toBeNull();
    expect((await restored.status()).assistant).toMatchObject({ code: 'MODEL_CHECK_REQUIRED', active: false }); expect(f.calls).toHaveLength(1);
  });
  it('discards a catalog check that finishes after the owner disables the provider', async () => {
    const f = fixture(), base = f.config.fetch!;
    let pause = false, enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; }), wait = new Promise<void>(resolve => { release = resolve; });
    f.config.fetch = async (input, init) => { if (pause && String(input).endsWith('/models')) { enter(); await wait; } return base(input, init); };
    const control = await createInferenceControl(store.db, f.config);
    await control.saveAssistant('owner-fixture', { enabled: true });
    pause = true;
    const checking = control.checkAssistant();
    await entered;
    try { await control.saveAssistant('owner-fixture', { enabled: false }); } finally { release(); }
    const status = await checking;
    expect(status.assistant).toMatchObject({ enabled: false, active: false, checkedAt: null });
    expect(control.visionProvider()).toBeNull(); expect(f.generations()).toHaveLength(0);
    expect((await store.db.selectFrom('ai_assistant_settings').select('models').executeTakeFirst())?.models).toEqual([]);
  });
  it('fails closed on malformed catalog data and future verification timestamps without discovery', async () => {
    const f = fixture(), control = await createInferenceControl(store.db, f.config);
    await control.saveAssistant('owner-fixture', { enabled: true });
    await store.db.updateTable('ai_assistant_settings').set({ models: JSON.stringify('not valid catalog JSON') }).execute();
    await control.refreshAssistant();
    expect(control.active()).toBe(false); expect(control.visionProvider()).toBeNull();
    await store.db.updateTable('ai_assistant_settings').set({ models: JSON.stringify([FAST, DEEP, VISION]), checked_at: new Date(Date.now() + 3600000) }).execute();
    await control.refreshAssistant();
    expect(control.active()).toBe(false); expect(control.routerFor('fast')).toBeNull();
    expect(f.calls).toHaveLength(1);
  });
});
