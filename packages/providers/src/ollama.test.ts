import { describe, expect, it } from 'vitest';
import { OllamaProvider, ProviderError, ollamaInventory } from './index.js';

/**
 * A fixture name only. Every call here goes through an injected fetch, so these tests
 * need neither a running Ollama service nor any installed model weights.
 */
const MODEL = 'fixture-local-model:test';
const schema = { type: 'object', properties: { status: { type: 'string' } }, required: ['status'], additionalProperties: false };

function reply(body: Record<string, unknown>, calls: { url: string; body: any }[] = []): typeof fetch {
  return async (input, init) => {
    calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return Response.json({ model: MODEL, done: true, done_reason: 'stop', message: { role: 'assistant', content: '{"status":"ok"}' }, prompt_eval_count: 40, eval_count: 6, ...body });
  };
}

async function code(promise: Promise<unknown>) {
  try { await promise; return 'resolved'; } catch (error) { return error instanceof ProviderError ? error.code : 'OTHER'; }
}

describe('OllamaProvider', () => {
  it('refuses any origin that is not on this computer', () => {
    for (const baseUrl of ['http://10.0.0.5:11434', 'https://127.0.0.1:11434', 'http://example.com', 'http://user:pw@127.0.0.1:11434', 'http://127.0.0.1:11434/v1']) {
      expect(() => new OllamaProvider({ model: MODEL, baseUrl })).toThrow(ProviderError);
    }
    expect(new OllamaProvider({ model: MODEL }).origin).toBe('http://127.0.0.1:11434');
  });

  it('sends one non-streaming /api/chat call with the schema in format and thinking off', async () => {
    const calls: { url: string; body: any }[] = [];
    const provider = new OllamaProvider({ model: MODEL, fetch: reply({}, calls) });
    const result = await provider.generate({ goal: 'أعد الحالة.', system: 'نظام', maxTokens: 200, structured: { name: 'decision', schema } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://127.0.0.1:11434/api/chat');
    expect(calls[0]!.body).toMatchObject({ model: MODEL, stream: false, think: false, format: schema, options: { num_predict: 200, temperature: 0, seed: 42 } });
    expect(calls[0]!.body.tools).toBeUndefined();
    expect(result).toMatchObject({ text: '{"status":"ok"}', model: MODEL, usage: { inputTokens: 40, outputTokens: 6 }, usageEstimated: false, provider: 'ollama' });
  });

  it('pins generation settings and rejects invalid sampling configuration', async () => {
    const calls: { url: string; body: any }[] = [];
    await new OllamaProvider({ model: MODEL, temperature: 0.3, seed: 123, fetch: reply({}, calls) }).generate({ goal: 'اكتب عبارة قصيرة.' });
    expect(calls[0]!.body.options).toMatchObject({ temperature: 0.3, seed: 123 });
    for (const temperature of [NaN, Infinity, -1, 3]) expect(() => new OllamaProvider({ model: MODEL, temperature })).toThrow(ProviderError);
    for (const seed of [NaN, Infinity, -1, 1.5, 2147483648]) expect(() => new OllamaProvider({ model: MODEL, seed })).toThrow(ProviderError);
  });

  it('rejects incomplete, mismatched, empty and thinking-only replies with known usage', async () => {
    const goal = { goal: 'أعد الحالة.' };
    expect(await code(new OllamaProvider({ model: MODEL, fetch: reply({ done_reason: 'length' }) }).generate(goal))).toBe('INCOMPLETE_RESPONSE');
    expect(await code(new OllamaProvider({ model: MODEL, fetch: reply({ done: false }) }).generate(goal))).toBe('INCOMPLETE_RESPONSE');
    expect(await code(new OllamaProvider({ model: MODEL, fetch: reply({ model: 'other:latest' }) }).generate(goal))).toBe('MODEL_MISMATCH');
    expect(await code(new OllamaProvider({ model: MODEL, fetch: reply({ message: { role: 'assistant', content: '  ' } }) }).generate(goal))).toBe('INVALID_RESPONSE');
    expect(await code(new OllamaProvider({ model: MODEL, fetch: reply({ message: { role: 'assistant', content: '<think>x' } }) }).generate(goal))).toBe('INVALID_RESPONSE');
    try { await new OllamaProvider({ model: MODEL, fetch: reply({ done_reason: 'length' }) }).generate(goal); }
    catch (error) { expect((error as ProviderError).usage).toEqual({ inputTokens: 40, outputTokens: 6 }); }
  });

  it('refuses prompts that could be truncated by the context window, before or after the call', async () => {
    let called = false;
    const provider = new OllamaProvider({ model: MODEL, contextTokens: 4096, fetch: async () => { called = true; return Response.json({}); } });
    expect(await code(provider.generate({ goal: 'س'.repeat(12000), maxTokens: 1000 }))).toBe('PROMPT_TOO_LARGE');
    expect(called).toBe(false);
    expect(await code(new OllamaProvider({ model: MODEL, contextTokens: 4096, fetch: reply({ prompt_eval_count: 4000 }) }).generate({ goal: 'أعد الحالة.', maxTokens: 200 }))).toBe('PROMPT_TRUNCATED');
  });

  it('never accepts images and maps network failures without leaking details', async () => {
    const provider = new OllamaProvider({ model: MODEL, fetch: async () => { throw new TypeError('connect ECONNREFUSED 127.0.0.1:11434'); } });
    expect(await code(provider.generate({ goal: 'صف الصورة.', image: { mimeType: 'image/png', data: 'A'.repeat(16) } }))).toBe('IMAGE_UNSUPPORTED');
    expect(await code(provider.generate({ goal: 'أعد الحالة.' }))).toBe('NETWORK_ERROR');
  });
});

/** A fake Ollama that records every path it is asked for. */
function service(models: { name: string; digest?: string }[] | 'down', paths: string[] = []): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    paths.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    if (models === 'down') throw new TypeError('connect ECONNREFUSED 127.0.0.1:11434');
    if (url.pathname === '/api/version') return Response.json({ version: '0.12.0' });
    if (url.pathname === '/api/tags') return Response.json({ models });
    if (url.pathname === '/api/ps') return Response.json({ models: [] });
    if (url.pathname === '/api/chat') return Response.json({ error: `model '${MODEL}' not found` }, { status: 404 });
    return Response.json({}, { status: 404 });
  };
}

describe('OllamaProvider with no usable local model', () => {
  it('distinguishes an empty model list, a missing selected model and an unreachable service', async () => {
    expect(await code(new OllamaProvider({ model: MODEL, fetch: service([]) }).inspect())).toBe('NO_LOCAL_MODELS');
    expect(await code(new OllamaProvider({ model: MODEL, fetch: service([{ name: 'another:latest' }]) }).inspect())).toBe('MODEL_UNAVAILABLE');
    expect(await code(new OllamaProvider({ model: MODEL, fetch: service('down') }).inspect())).toBe('NETWORK_ERROR');
    await expect(new OllamaProvider({ model: MODEL, fetch: service([{ name: MODEL, digest: 'sha256:abc' }]) }).inspect()).resolves.toMatchObject({ model: MODEL, digest: 'sha256:abc' });
  });

  it('maps a chat call for an uninstalled model to MODEL_UNAVAILABLE once, with no pull, retry or other host', async () => {
    const paths: string[] = [];
    expect(await code(new OllamaProvider({ model: MODEL, fetch: service([], paths) }).generate({ goal: 'أعد الحالة.' }))).toBe('MODEL_UNAVAILABLE');
    expect(paths).toEqual(['POST /api/chat']);
  });

  it('reports inventory read-only: unreachable, no models, or the installed names', async () => {
    const paths: string[] = [];
    expect(await ollamaInventory({ fetch: service('down', paths) })).toEqual({ status: 'unreachable', origin: 'http://127.0.0.1:11434' });
    expect(await ollamaInventory({ fetch: service([], paths) })).toEqual({ status: 'no_models', origin: 'http://127.0.0.1:11434', version: '0.12.0' });
    expect(await ollamaInventory({ fetch: service([{ name: 'a:1' }, { name: 'b:2' }], paths) })).toMatchObject({ status: 'ready', models: ['a:1', 'b:2'] });
    expect(paths.every(path => path === 'GET /api/tags' || path === 'GET /api/version')).toBe(true);
    await expect(ollamaInventory({ baseUrl: 'http://10.0.0.5:11434' })).rejects.toThrow(ProviderError);
  });
});
