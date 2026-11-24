import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentBrowser, SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createJudgeShadow } from '../apps/server/src/assistant/judge-shadow.js';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';

describe('the live web request repairs through the chat controller', () => {
  const owner = 'live-defects-test-owner';
  const url = 'https://en.wikipedia.org/wiki/Rain';
  const cause = 'Because water droplets grow too heavy to stay suspended, rain falls from clouds.';
  const queries: string[] = [];
  let directory: string;
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let control: Awaited<ReturnType<typeof createCommandChatControl>>;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mohassan-live-defects-'));
    database = await createDatabase();
    await migrate(database.db);
    const browser = {
      setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; }, async close() {},
      async act() { throw new Error('The fixture should be read through the HTTP page reader.'); },
    } as unknown as AgentBrowser;
    const searchProvider: SearchProvider = {
      name: 'live-defects-test-search',
      async search(query) {
        queries.push(query);
        return [{ title: 'Rain', url, snippet: 'Rain is liquid precipitation from the atmosphere.' }];
      },
    };
    control = await createCommandChatControl(database.db, {
      browser, searchProvider, models: { fast: [], deep: [], vision: '' }, recordExperiences: false,
      judgeShadow: createJudgeShadow({ logFile: join(directory, 'judge.jsonl') }),
      judgeFixForOwner: true, judgeWithholdForOwner: true,
      readPage: async address => address === url ? {
        url, title: 'Rain - Wikipedia', status: 200,
        text: `Rain is liquid precipitation from the atmosphere.\nRain in the tropics falls because of monsoon circulation.\n${cause}`,
      } : null,
    });
  });
  afterAll(async () => { await control?.shutdown(); await database?.close(); await rm(directory, { recursive: true, force: true }); });
  beforeEach(() => { queries.length = 0; });

  async function ask(goal: string) {
    const { id } = await control.create(owner, { goal });
    await control.settled(id);
    const detail = await control.detail(owner, id);
    expect(detail.error).toBeNull();
    return detail.messages.filter(message => message.role === 'assistant').at(-1)?.text;
  }

  it('answers an English Explain why request from an explicitly causal source sentence', async () => {
    const reply = await ask('Explain why rain falls.');
    expect(queries[0]).toBe('why rain falls');
    expect(reply).toMatch(/^Because water droplets grow too heavy to stay suspended, rain falls from clouds\./u);
    expect(reply).not.toContain('monsoon');
  });

  it('searches only the subject and returns only the requested source link', async () => {
    const reply = await ask('Search the web for rain. Return only the source link.');
    expect(queries).toEqual(['rain']);
    expect(reply).toBe(`**Source link:** ${url}`);
  });

  it('quotes the first sentence the selected source actually opens with', async () => {
    const reply = await ask('Search the web for rain. Return its first sentence.');
    expect(queries, reply).toEqual(['rain']);
    expect(reply).toContain('**First sentence on the page:** Rain is liquid precipitation from the atmosphere.');
  });
});
