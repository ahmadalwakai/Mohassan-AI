import { OllamaProvider } from '@mohassan/providers';
/**
 * Test-only transport for the owner's local model. Scripted fakes written as
 * chat-completion handlers (`{ response_format: { json_schema: { name } } }` in,
 * `{ choices, usage }` out) answer through Ollama's /api/chat wire format, so the
 * real OllamaProvider, its queue, schema title, context checks and error mapping
 * run unchanged. No HTTP server, model or network is used.
 */
export const FIXTURE_MODEL = 'fixture-model:local';

export interface ChatCompletionRequest {
  model: string; max_completion_tokens?: number;
  response_format?: { type: 'json_schema'; json_schema: { name: string; strict: true; schema: Record<string, unknown> } };
  messages: { role: string; content: string | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[] }[];
}

export function asOllama(handler: typeof fetch, model = FIXTURE_MODEL): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.pathname === '/api/version') return Response.json({ version: 'fixture' });
    if (url.pathname === '/api/tags') return Response.json({ models: [{ name: model, digest: 'fixture-digest-000000' }] });
    if (url.pathname === '/api/ps') return Response.json({ models: [] });
    if (url.pathname !== '/api/chat') return new Response('not found', { status: 404 });
    const body = JSON.parse(String(init?.body)) as { model: string; format?: Record<string, unknown> & { title?: string }; options?: { num_predict?: number }; messages: { role: string; content: string; images?: string[] }[] };
    const { title, ...schema } = body.format ?? {};
    const request: ChatCompletionRequest = {
      model: body.model, max_completion_tokens: body.options?.num_predict,
      ...(body.format ? { response_format: { type: 'json_schema' as const, json_schema: { name: String(title ?? 'structured'), strict: true as const, schema } } } : {}),
      messages: body.messages.map(message => message.images?.length
        ? { role: message.role, content: [{ type: 'text' as const, text: message.content }, ...message.images.map(data => ({ type: 'image_url' as const, image_url: { url: `data:image/jpeg;base64,${data}` } }))] }
        : { role: message.role, content: message.content }),
    };
    const response = await handler('http://127.0.0.1:11434/v1/chat/completions', { method: 'POST', body: JSON.stringify(request), signal: init?.signal ?? null });
    if (!response.ok) return new Response(await response.text(), { status: response.status, headers: response.headers });
    const reply = await response.json() as { model?: string; choices?: { message?: { content?: string | null }; finish_reason?: string | null }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    const choice = reply.choices?.[0];
    return Response.json({
      model: reply.model ?? body.model, done: true, done_reason: choice?.finish_reason === 'length' ? 'length' : 'stop',
      message: { role: 'assistant', content: choice?.message?.content ?? '' },
      ...(reply.usage ? { prompt_eval_count: reply.usage.prompt_tokens ?? 0, eval_count: reply.usage.completion_tokens ?? 0 } : {}),
    });
  };
}

/** The AppConfig fields an isolated test needs to run with a scripted local model. */
export function fixtureLocalModel(handler: typeof fetch, model = FIXTURE_MODEL) {
  return { localModel: { model, vision: true }, aiFetch: asOllama(handler, model) };
}

/** For tests that build the chat control directly: one real OllamaProvider per model name. */
export function fixtureProviders(handler: typeof fetch, options: { vision?: boolean; timeoutMs?: number } = {}) {
  return (model: string) => new OllamaProvider({ model, fetch: asOllama(handler, model), vision: options.vision ?? true, ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) });
}
