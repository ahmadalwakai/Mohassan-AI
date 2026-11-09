import { describe, expect, it, vi } from 'vitest';
import { FreeLLMAPIProvider, ProviderError, normalizeFreeLLMAPIBaseUrl } from './index.js';

const KEY = 'freellmapi-fixture-unified-key-0001';
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const completion = (content: string, extra: Record<string, unknown> = {}) => ({ model: 'llama-3.3-70b', choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 12, completion_tokens: 4 }, ...extra });
const provider = (fetch: typeof globalThis.fetch, model = 'auto', extra: Record<string, unknown> = {}) => new FreeLLMAPIProvider({ baseUrl: 'http://127.0.0.1:3001', apiKey: KEY, model, fetch, ...extra });

function sse(frames: string[], options: { hold?: boolean } = {}) {
  const encoder = new TextEncoder();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      if (!options.hold) controller.close();
    },
    cancel() { cancelled = true; },
  });
  return { response: new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', 'x-routed-via': 'groq/llama-3.3-70b' } }), cancelled: () => cancelled };
}

describe('FreeLLMAPI provider initialisation', () => {
  it('requires the unified key and a safe base URL', () => {
    expect(() => new FreeLLMAPIProvider({ baseUrl: 'http://127.0.0.1:3001', apiKey: '', model: 'auto' })).toThrow(ProviderError);
    expect(() => normalizeFreeLLMAPIBaseUrl('http://gateway.example.com')).toThrow(/HTTPS/);
    expect(() => normalizeFreeLLMAPIBaseUrl('https://user:pass@gateway.example.com')).toThrow();
    expect(normalizeFreeLLMAPIBaseUrl('http://127.0.0.1:3001')).toBe('http://127.0.0.1:3001/v1');
    expect(normalizeFreeLLMAPIBaseUrl('https://gw.example.com/v1/')).toBe('https://gw.example.com/v1');
  });
});

describe('model discovery', () => {
  it('reads the documented catalog fields and drops malformed rows', async () => {
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('http://127.0.0.1:3001/v1/models');
      expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
      return json({ object: 'list', data: [
        { id: 'auto', object: 'model', owned_by: 'freellmapi', context_window: 131072, available: true },
        { id: 'llama-3.3-70b', owned_by: 'groq', context_window: 131072, available: true, execution_status: 'ready', supported_parameters: ['temperature', 'stream', 'response_format', 'tools', 'tool_choice'] },
        { id: 'gemma-3', owned_by: 'google', available: true, execution_status: 'exhausted', supported_parameters: ['temperature', 'stream'] },
        { id: 'no spaces allowed', owned_by: 'x' },
        { owned_by: 'missing-id' },
      ] });
    });
    const models = await provider(fetch as typeof globalThis.fetch).listModels();
    expect(models.map(model => model.id)).toEqual(['auto', 'llama-3.3-70b', 'gemma-3']);
    expect(models[0]).toMatchObject({ router: true, executionStatus: 'ready', supportsTools: false });
    expect(models[1]).toMatchObject({ router: false, supportsTools: true, supportsStructuredOutput: true, executionStatus: 'ready' });
    expect(models[2]).toMatchObject({ supportsTools: false, supportsStructuredOutput: false, executionStatus: 'exhausted' });
  });

  it('reports an authentication failure without leaking the key', async () => {
    const fetch = async () => json({ error: { message: `bad key ${KEY}`, type: 'invalid_request_error' } }, 401);
    const error = await provider(fetch as typeof globalThis.fetch).listModels().catch(caught => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code: 'AUTHENTICATION_FAILED', retryable: false, httpStatus: 401 });
    expect(error.message).not.toContain(KEY);
  });

  it('marks an unreachable gateway as a zero-usage failure', async () => {
    const fetch = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); };
    await expect(provider(fetch as typeof globalThis.fetch).listModels()).rejects.toMatchObject({ code: 'GATEWAY_UNREACHABLE', usage: { inputTokens: 0, outputTokens: 0 } });
  });
});

describe('chat completions', () => {
  it('returns text, usage and the routing headers', async () => {
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ model: 'auto', stream: false, response_format: { type: 'json_schema' } });
      expect(body.messages[1].content).toContain('hello');
      return json(completion('{"ok":true}'), 200, { 'x-routed-via': 'groq%2Fllama-3.3-70b', 'x-fallback-attempts': '1', 'x-fallback-trail': 'cerebras/qwen key1=rate_limited' });
    });
    const result = await provider(fetch as typeof globalThis.fetch).generate({ goal: 'hello there', structured: { name: 'check', schema: { type: 'object' } } });
    expect(result).toMatchObject({ text: '{"ok":true}', model: 'llama-3.3-70b', usage: { inputTokens: 12, outputTokens: 4 }, usageEstimated: false, provider: 'freellmapi' });
    expect(result.routing).toEqual({ routedVia: 'groq/llama-3.3-70b', platform: 'groq', fallbackAttempts: 1, fallbackTrail: 'cerebras/qwen key1=rate_limited' });
  });

  it('estimates usage, and says so, when the upstream omits it', async () => {
    const fetch = async () => json({ model: 'm', choices: [{ finish_reason: 'stop', message: { content: 'hi' } }] });
    const result = await provider(fetch as typeof globalThis.fetch).generate({ goal: 'hello there' });
    expect(result.usageEstimated).toBe(true);
    expect(result.usage.inputTokens).toBeGreaterThan(0);
  });

  it('maps rate limits and quota exhaustion with the provider delay', async () => {
    const limited = await provider((async () => json({ error: { code: 'rate_limit_exceeded' } }, 429, { 'retry-after': '7' })) as typeof globalThis.fetch).generate({ goal: 'hello there' }).catch(error => error);
    expect(limited).toMatchObject({ code: 'RATE_LIMITED', retryable: true, httpStatus: 429, retryAfterMs: 7000, usage: { inputTokens: 0, outputTokens: 0 } });
    const exhausted = await provider((async () => json({ error: { code: 'quota_exceeded' } }, 429)) as typeof globalThis.fetch).generate({ goal: 'hello there' }).catch(error => error);
    expect(exhausted).toMatchObject({ code: 'QUOTA_EXHAUSTED', retryable: false });
    const noTools = await provider((async () => json({ error: { code: 'no_tools_model' } }, 400)) as typeof globalThis.fetch).generate({ goal: 'hello there' }).catch(error => error);
    expect(noTools).toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' });
  });

  it('rejects truncated output and oversized bodies', async () => {
    const truncated = await provider((async () => json({ ...completion('half'), choices: [{ finish_reason: 'length', message: { content: 'half' } }] })) as typeof globalThis.fetch).generate({ goal: 'hello there' }).catch(error => error);
    expect(truncated).toMatchObject({ code: 'INCOMPLETE_RESPONSE' });
    const huge = await provider((async () => new Response('x'.repeat(300000), { status: 200 })) as typeof globalThis.fetch).generate({ goal: 'hello there' }).catch(error => error);
    expect(huge).toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
  });
});

describe('streaming', () => {
  it('yields deltas, then one done event with usage', async () => {
    const stream = sse([
      'data: {"model":"llama-3.3-70b","choices":[{"delta":{"content":"Hel"}}]}\n\n',
      ': keep-alive\n\n',
      'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n',
      'data: [DONE]\n\n',
    ]);
    const events = [];
    for await (const event of provider((async () => stream.response) as typeof globalThis.fetch).stream({ goal: 'say hello' })) events.push(event);
    expect(events.filter(event => event.type === 'delta').map(event => event.type === 'delta' && event.text).join('')).toBe('Hello');
    const done = events.at(-1);
    expect(done?.type === 'done' && done.result).toMatchObject({ text: 'Hello', model: 'llama-3.3-70b', usage: { inputTokens: 5, outputTokens: 2 }, usageEstimated: false, routing: { platform: 'groq' } });
  });

  it('closes the upstream stream when the consumer stops early', async () => {
    const stream = sse(['data: {"choices":[{"delta":{"content":"a"}}]}\n\n'], { hold: true });
    for await (const event of provider((async () => stream.response) as typeof globalThis.fetch).stream({ goal: 'say hello' })) { expect(event.type).toBe('delta'); break; }
    expect(stream.cancelled()).toBe(true);
  });

  it('cancels on abort and reports it as aborted', async () => {
    const stream = sse(['data: {"choices":[{"delta":{"content":"a"}}]}\n\n'], { hold: true });
    const controller = new AbortController();
    const run = (async () => { for await (const event of provider((async () => stream.response) as typeof globalThis.fetch).stream({ goal: 'say hello', signal: controller.signal })) if (event.type === 'delta') controller.abort(); })();
    await expect(run).rejects.toMatchObject({ code: 'ABORTED' });
    expect(stream.cancelled()).toBe(true);
  });

  it('fails a stream that stalls or reports an error frame', async () => {
    const stalled = sse(['data: {"choices":[{"delta":{"content":"a"}}]}\n\n'], { hold: true });
    const consume = async (response: Response, extra = {}) => { for await (const _ of provider((async () => response) as typeof globalThis.fetch, 'auto', extra).stream({ goal: 'say hello' })) { /* drain */ } };
    await expect(consume(stalled.response, { streamStallMs: 1000 })).rejects.toMatchObject({ code: 'STREAM_STALLED' });
    expect(stalled.cancelled()).toBe(true);
    await expect(consume(sse(['data: {"error":{"message":"upstream died"}}\n\n']).response)).rejects.toMatchObject({ code: 'STREAM_INTERRUPTED' });
    await expect(consume(sse(['data: {"choices":[{"delta":{"content":"a"}}]}\n\n']).response)).rejects.toMatchObject({ code: 'STREAM_INTERRUPTED' });
  });
});

describe('usage ledger', () => {
  it('parses the documented GET /v1/usage shape', async () => {
    const fetch = async (url: unknown) => { expect(String(url)).toBe('http://127.0.0.1:3001/v1/usage'); return json({ month: '2026-11', resetsAt: '2026-12-01T00:00:00.000Z', requests: 3, tokens: 900, byPlatform: [{ platform: 'groq', requests: 3, tokens: 900 }], byKey: [] }); };
    await expect(provider(fetch as typeof globalThis.fetch).usage()).resolves.toMatchObject({ month: '2026-11', requests: 3, tokens: 900, byPlatform: [{ platform: 'groq' }] });
  });
});
