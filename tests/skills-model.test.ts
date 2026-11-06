import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDatabase } from '@mohassan/database';
import { createAIControl } from '../apps/server/src/ai.js';

let store: Awaited<ReturnType<typeof createDatabase>>;
beforeAll(async () => { store = await createDatabase(); });
afterAll(async () => { await store?.close(); });

it('routes skill model calls only through the existing configured ModelRouter and provider', async () => {
  const requests: any[] = [];
  const ai = await createAIControl(store.db, {apiKey: 'fixture-no-live-key', model: 'configured/fast', reasoningModel: 'configured/reasoning', fetch: (async (_url, init) => {
    const body = JSON.parse(String(init?.body)); requests.push(body);
    return new Response(JSON.stringify({model: body.model, choices: [{message: {content: '{"summary":"Verified fixture text"}'}, finish_reason: 'stop'}], usage: {prompt_tokens: 8, completion_tokens: 6}}), {status: 200});
  }) as typeof fetch});
  const structured = {name: 'skill_result', schema: {type: 'object', properties: {summary: {type: 'string'}}, required: ['summary'], additionalProperties: false}};
  const fast = await ai.generateSkill({goal: 'Summarize this controlled fixture text.', structured});
  const deep = await ai.generateSkill({goal: 'Review concurrency and workflow dependencies in this controlled fixture.', structured});
  expect(requests.map(request => request.model)).toEqual(['configured/fast', 'configured/reasoning']);
  expect(fast.usage).toEqual({inputTokens: 8, outputTokens: 6});
  expect(deep.text).toBe('{"summary":"Verified fixture text"}');
  expect((await ai.status()).status).toBe('verified');
});

it('keeps original rate-limit metadata and does not replay a paid skill operation implicitly', async () => {
  let calls = 0;
  const ai = await createAIControl(store.db, {apiKey: 'fixture-no-live-key', model: 'configured/fast', reasoningModel: 'configured/reasoning', fetch: (async () => {
    calls++; return new Response('{}', {status: 429, headers: {'retry-after': '600'}});
  }) as typeof fetch});
  await expect(ai.generateSkill({goal: 'Summarize a controlled fixture.'})).rejects.toMatchObject({name: 'ProviderError', code: 'RATE_LIMITED', httpStatus: 429, retryAfterMs: 600000, model: 'configured/fast', usage: {inputTokens: 0, outputTokens: 0}});
  expect(calls).toBe(1);
});

it('rejects unconfigured model execution before making any provider request', async () => {
  let calls = 0;
  const ai = await createAIControl(store.db, {fetch: (async () => { calls++; throw new Error('unexpected'); }) as typeof fetch});
  await expect(ai.generateSkill({goal: 'Summarize the controlled fixture.'})).rejects.toMatchObject({code: 'NOT_CONFIGURED'});
  expect(calls).toBe(0);
});
