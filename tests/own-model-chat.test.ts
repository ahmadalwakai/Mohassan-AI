import type { AgentBrowser } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { expect, it, vi } from 'vitest';
import { createOwnModelReply } from '../apps/server/src/assistant/own-model-reply.js';
import { ROUTES } from '../apps/server/src/assistant/router.js';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import type { OwnModelGates } from '../apps/server/src/own-model-gates.js';

it('observes both decisions in chat and sends the host quote when model phrasing fails review', async () => {
  const database = await createDatabase();
  const url = 'https://own-model-fixture.test/japan';
  const quote = 'Tokyo is the capital of Japan and the largest city in the country.';
  const evidence = `${quote} Tokyo is home to about 14 million people according to the latest census.`;
  const search = vi.fn(async () => [{ title: 'Capital of Japan', url, snippet: evidence }]);
  const browser = {
    setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; }, async close() {},
  } as unknown as AgentBrowser;
  const calibration = { temperature: 1, minConfidence: 0.8, minMargin: 0.3 };
  const workerSha = 'a'.repeat(64);
  const routerSha = 'b'.repeat(64);
  const gates = { get: (capability, digest) => digest === workerSha
    ? capability === 'phrasing' ? { mode: 'active' } : { mode: 'shadow', calibration, routerSha256: routerSha }
    : undefined } as OwnModelGates;
  const record = vi.fn();
  const choose = vi.fn<Parameters<typeof createOwnModelReply>[0]['provider']['choose']>().mockImplementation(async ({ options }) => ({
    option: options.find(choice => choice.id === 'chat' || choice.id === 'follow_up_property')?.id ?? null, confidence: 0.9,
  }));
  const generate = vi.fn(async () => ({
    text: 'Penguins nest on exposed rock.', model: 'fixture', provider: 'fixture', usage: { inputTokens: 1, outputTokens: 1 },
  }));
  const ownModel = createOwnModelReply({
    provider: { choose, generate, health: () => ({ state: 'ready', configSha256: workerSha, generation: true, decisions: true,
      identity: { modelId: 'fixture', tokenizerId: 'fixture', checkpointId: 'fixture' } }) },
    gates: () => gates,
    router: async () => ({
      headerSha256: routerSha, buckets: 1, dim: 1, routes: ROUTES, embedding: new Float32Array(1),
      weight: new Float32Array(ROUTES.length), bias: Float32Array.from(ROUTES, route => route === 'chat' ? 2 : Number(route === 'web_search')),
    }),
    record,
  });
  let control: Awaited<ReturnType<typeof createCommandChatControl>> | undefined;
  try {
    await migrate(database.db);
    control = await createCommandChatControl(database.db, {
      models: { fast: [], deep: [], vision: '' }, browser, ownModel, searchProvider: { name: 'fixture', search },
      readPage: async () => ({ url, title: 'Capital of Japan', text: evidence, status: 200 }),
    });
    const owner = 'own-model-chat-fixture';
    const { id } = await control.create(owner, { goal: 'What is the capital of Japan?' });
    await control.settled(id);
    const first = await control.detail(owner, id);
    expect(first.error).toBeNull();
    expect(first.messages.at(-1)?.text).toContain(quote);
    expect(first.messages.at(-1)?.text).not.toContain('Penguins');
    expect(generate).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ capability: 'phrasing', outcome: 'rejected', judgeRejected: true }));
    await vi.waitFor(() => {
      expect(record).toHaveBeenCalledWith(expect.objectContaining({ capability: 'route-choice', outcome: 'chosen', agreed: false }));
    });

    await control.send(owner, id, { text: 'And what is its population?' });
    await control.settled(id);
    expect(search).toHaveBeenCalledTimes(2);
    expect((await control.detail(owner, id)).error).toBeNull();
    await vi.waitFor(() => {
      expect(record).toHaveBeenCalledWith(expect.objectContaining({ capability: 'follow-up-turn-type', outcome: 'chosen', agreed: true }));
    });
  } finally {
    await control?.shutdown();
    await database.close();
  }
});
