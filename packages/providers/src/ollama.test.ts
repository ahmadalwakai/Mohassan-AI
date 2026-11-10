import { describe, expect, it } from 'vitest';
import { LocalModelQueue, OllamaProvider, ProviderError } from './index.js';

const MODEL = 'qwen3.5:9b-coding-local';
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

  it('names the schema with a title only, and redacts credentials before anything is sent', async () => {
    const calls: { url: string; body: any }[] = [];
    const key = 'sk-' + 'a'.repeat(24), uri = 'postgres://owner:secret-password@db.example/app';
    await new OllamaProvider({ model: MODEL, fetch: reply({}, calls) }).generate({ goal: `خطط لربط ${uri} بالمفتاح ${key}`, structured: { name: 'mohassan_cognitive_plan', schema } });
    expect(calls[0]!.body.format).toEqual({ title: 'mohassan_cognitive_plan', ...schema });
    const sent = JSON.stringify(calls[0]!.body);
    expect(sent).not.toContain(key);
    expect(sent).not.toContain('secret-password');
  });

  it('sends an image only to a model marked as vision, with its own time limit', async () => {
    const calls: { url: string; body: any }[] = [];
    const image = { mimeType: 'image/jpeg' as const, data: Buffer.from('fixture-image-bytes-0000').toString('base64') };
    await new OllamaProvider({ model: MODEL, vision: true, fetch: reply({}, calls) }).generate({ goal: 'صف لقطة الشاشة.', image });
    expect(calls[0]!.body.messages[1]).toEqual({ role: 'user', content: 'صف لقطة الشاشة.', images: [image.data] });
    const slow: typeof fetch = (_input, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    const started = Date.now();
    expect(await code(new OllamaProvider({ model: MODEL, vision: true, timeoutMs: 60000, imageTimeoutMs: 1000, fetch: slow }).generate({ goal: 'صف لقطة الشاشة.', image }))).toBe('ABORTED');
    expect(Date.now() - started).toBeLessThan(5000);
    expect(await code(new OllamaProvider({ model: MODEL, vision: true, fetch: reply({}) }).generate({ goal: 'صف لقطة الشاشة.', image: { mimeType: 'image/jpeg', data: 'not base64!' } }))).toBe('OTHER');
  });

  it('serves one request at a time, refuses beyond the waiting line, and frees a cancelled place', async () => {
    const queue = new LocalModelQueue(1);
    let active = 0, peak = 0;
    const releases: (() => void)[] = [];
    const held: typeof fetch = async () => { active += 1; peak = Math.max(peak, active); await new Promise<void>(resolve => releases.push(resolve)); active -= 1; return Response.json({ model: MODEL, done: true, done_reason: 'stop', message: { role: 'assistant', content: 'ok-text' }, prompt_eval_count: 4, eval_count: 2 }); };
    const provider = new OllamaProvider({ model: MODEL, queue, fetch: held });
    const first = provider.generate({ goal: 'الطلب الأول.' });
    const second = provider.generate({ goal: 'الطلب الثاني.' });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(queue.depth).toBe(2);
    const third = await provider.generate({ goal: 'الطلب الثالث.' }).catch(error => error);
    expect(third).toMatchObject({ code: 'MODEL_BUSY', retryable: true, usage: { inputTokens: 0, outputTokens: 0 } });
    releases.shift()!();
    await first;
    await new Promise(resolve => setTimeout(resolve, 10));
    releases.shift()!();
    await second;
    expect(peak).toBe(1);
    expect(queue.depth).toBe(0);

    const controller = new AbortController();
    const blocking = provider.generate({ goal: 'طلب يشغل النموذج.' });
    const waiting = provider.generate({ goal: 'طلب سيُلغى.', signal: controller.signal });
    await new Promise(resolve => setTimeout(resolve, 10));
    controller.abort();
    expect(await code(waiting)).toBe('ABORTED');
    expect(queue.depth).toBe(1);
    releases.shift()!();
    await blocking;
    expect(queue.depth).toBe(0);
  });
});
