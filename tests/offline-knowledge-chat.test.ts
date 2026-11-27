import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentBrowser } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import { importWikidata } from '../packages/knowledge-base/src/wikidata.ts';

const owner = 'offline-knowledge-test';
const goal = 'How many people live in Belgium?';
const arabicGoal = 'كم عدد سكان بلجيكا؟';
// The projection and its hashes are documented in fixtures/knowledge-base/WIKIDATA.md.
const dumpDate = '2026-11-16';
const source = 'https://dumps.wikimedia.org/wikidatawiki/entities/20261116/wikidata-20261116-all.json.gz';
let directory: string;
let databasePath: string;
let database: Awaited<ReturnType<typeof createDatabase>>;
let control: Awaited<ReturnType<typeof createCommandChatControl>>;
const search = vi.fn(async (_query: string) => []);

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mohassan-offline-answer-'));
  databasePath = join(directory, 'wikidata.sqlite');
  const inputPath = fileURLToPath(new URL('./fixtures/knowledge-base/wikidata-20261116-projected.json', import.meta.url));
  await importWikidata({ inputPath, databasePath, source, dumpDate });
  database = await createDatabase();
  await migrate(database.db);
  const browser = { setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; }, async close() {} };
  control = await createCommandChatControl(database.db, {
    models: { fast: [], deep: [], vision: '' }, browser: browser as unknown as AgentBrowser,
    searchProvider: { name: 'isolated-search', search },
  });
});

afterEach(() => {
  search.mockClear();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await control?.shutdown();
  await database?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function ask(text: string) {
  const { id } = await control.create(owner, { goal: text });
  await control.settled(id);
  return control.detail(owner, id);
}

it('keeps the original search path with the flag unset even when the answer is indexed', async () => {
  vi.stubEnv('MOHASSAN_OFFLINE_KNOWLEDGE', undefined);
  vi.stubEnv('MOHASSAN_OFFLINE_KNOWLEDGE_STORE', databasePath);
  const reply = await ask(goal);
  expect(search.mock.calls.some(([query]) => /belgium/iu.test(query))).toBe(true);
  expect(reply.messages.at(-1)?.text).not.toContain('Wikidata Q31');
});

it('answers in English and Arabic from the latest observation and cites the dated revision before any search', async () => {
  vi.stubEnv('MOHASSAN_OFFLINE_KNOWLEDGE', '1');
  vi.stubEnv('MOHASSAN_OFFLINE_KNOWLEDGE_STORE', databasePath);
  // P1082 and the observed date are the unmodified Q31 statements in the projection above.
  for (const [question, expected] of [[goal, '11,825,551 (as of 2025-01-01)'], [arabicGoal, '11,825,551 (اعتبارًا من 2025-01-01)']]) {
    const reply = await ask(question);
    expect(reply.error).toBeNull();
    expect(reply.messages.at(-1)?.text).toContain(expected);
    expect(reply.messages.at(-1)?.text).toContain('[Wikidata Q31](https://www.wikidata.org/wiki/Special:PermanentLink/2569315931)');
    expect(reply.messages.at(-1)?.text).toContain(dumpDate);
  }
  expect(search).not.toHaveBeenCalled();
});

it('continues through the same search path when the claim or snapshot is unavailable', async () => {
  const missingFact = 'What is the population of France?';
  vi.stubEnv('MOHASSAN_OFFLINE_KNOWLEDGE', undefined);
  vi.stubEnv('MOHASSAN_OFFLINE_KNOWLEDGE_STORE', databasePath);
  const original = await ask(missingFact);
  const originalQueries = search.mock.calls.map(([query]) => query);
  expect(originalQueries.length).toBeGreaterThan(0);
  search.mockClear();
  vi.stubEnv('MOHASSAN_OFFLINE_KNOWLEDGE', '1');
  const missing = await ask(missingFact);
  expect(missing.messages.at(-1)?.text).toBe(original.messages.at(-1)?.text);
  expect(search.mock.calls.map(([query]) => query)).toEqual(originalQueries);

  search.mockClear();
  vi.stubEnv('MOHASSAN_OFFLINE_KNOWLEDGE_STORE', join(directory, 'missing.sqlite'));
  await ask(goal);
  expect(search.mock.calls.some(([query]) => /belgium/iu.test(query))).toBe(true);
});
