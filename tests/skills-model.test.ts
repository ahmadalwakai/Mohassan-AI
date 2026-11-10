import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDatabase } from '@mohassan/database';
import { createAIControl } from '../apps/server/src/ai.js';
import { createLocalModel } from '../apps/server/src/local-model.js';
import { asOllama } from './fixtures/local-model.js';

let store: Awaited<ReturnType<typeof createDatabase>>;
beforeAll(async () => { store = await createDatabase(); });
afterAll(async () => { await store?.close(); });
const MODEL = 'configured-local:q4';

it('routes skill model calls only through the configured local model', async () => {
  const requests: any[] = [];
  const ai = await createAIControl(store.db, {localModel: createLocalModel({model: MODEL, fetch: asOllama((async (_url, init) => {
    const body = JSON.parse(String(init?.body)); requests.push(body);
    return Response.json({model: body.model, choices: [{message: {content: '{"summary":"Verified fixture text"}'}, finish_reason: 'stop'}], usage: {prompt_tokens: 8, completion_tokens: 6}});
  }) as typeof fetch, MODEL)})});
  const structured = {name: 'skill_result', schema: {type: 'object', properties: {summary: {type: 'string'}}, required: ['summary'], additionalProperties: false}};
  const fast = await ai.generateSkill({goal: 'Summarize this controlled fixture text.', structured});
  const deep = await ai.generateSkill({goal: 'Review concurrency and workflow dependencies in this controlled fixture.', structured});
  expect(requests.map(request => request.model)).toEqual([MODEL, MODEL]);
  expect(requests[0].response_format.json_schema.name).toBe('skill_result');
  expect(fast.usage).toEqual({inputTokens: 8, outputTokens: 6});
  expect(deep.text).toBe('{"summary":"Verified fixture text"}');
  expect((await ai.status()).status).toBe('verified');
});

it('does not replay a skill operation implicitly when the local model fails', async () => {
  let calls = 0;
  const ai = await createAIControl(store.db, {localModel: createLocalModel({model: MODEL, fetch: (async () => { calls++; return new Response('{}', {status: 503}); }) as typeof fetch})});
  await expect(ai.generateSkill({goal: 'Summarize a controlled fixture.'})).rejects.toMatchObject({name: 'ProviderError', code: 'UPSTREAM_ERROR', httpStatus: 503, model: MODEL});
  expect(calls).toBe(1);
});

it('rejects unconfigured model execution before making any provider request', async () => {
  const ai = await createAIControl(store.db, {localModel: createLocalModel(undefined)});
  await expect(ai.generateSkill({goal: 'Summarize the controlled fixture.'})).rejects.toMatchObject({code: 'NOT_CONFIGURED'});
});
