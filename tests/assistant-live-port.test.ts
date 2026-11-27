import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AgentBrowser, type SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createJudgeShadow, type JudgeShadowLine } from '../apps/server/src/assistant/judge-shadow.js';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';

const owner = 'live-port-owner';
// IANA, retrieved 2026-11-27: https://www.iana.org/help/example-domains
const iana = 'https://www.iana.org/help/example-domains';
const ianaTitle = 'Example Domains';
const ianaFirst = 'A number of domains such as example.com and example.org are maintained for documentation purposes.';
const ianaSecond = 'These domains may be used as illustrative examples in documents without prior coordination with us.';
// Existing regression fixture, retrieved 2026-11-27:
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/tests/assistant-live-test-repairs-chat.test.ts
const rain = 'https://en.wikipedia.org/wiki/rain';
const rainCause = 'Rain falls because the water droplets in a cloud grow too heavy for the rising air to hold them up.';
// The page's quoted estimate and malformed prose, retrieved 2026-11-27:
// https://ar.wikipedia.org/w/index.php?title=%D8%A3%D8%B3%D8%AA%D8%B1%D8%A7%D9%84%D9%8A%D8%A7&oldid=77628811
const australia = new URL('https://ar.wikipedia.org/wiki/أستراليا').href;
const australiaEstimate = 'توقع ( 2025 ) 27,707,100';
const australiaText = [
  'الأرض والسكان تسمية السكان أستراليون',
  australiaEstimate + ' [ 10 ] نسمة',
  'تعديل مصدري - تعديل',
  'يعدّ التعداد السكاني لأستراليا حوالي 24,899,100 مليون نسمة.',
].join(' ');
const pages = {
  [iana]: { title: ianaTitle, text: [ianaTitle, ianaFirst, ianaSecond].join('\n') },
  [rain]: { title: 'Rain - Wikipedia', text: ['Rain is water droplets that have condensed from atmospheric water vapor.', rainCause, 'Rain is a major component of the water cycle.'].join('\n') },
  [australia]: { title: 'أستراليا - ويكيبيديا', text: australiaText },
};

describe('live request regressions through the chat controller', () => {
  let directory: string;
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let control: Awaited<ReturnType<typeof createCommandChatControl>>;
  let shadow: ReturnType<typeof createJudgeShadow>;
  const queries: string[] = [];
  const reads: string[] = [];

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mohassan-live-port-'));
    shadow = createJudgeShadow({ logFile: join(directory, 'judge.jsonl') });
    database = await createDatabase();
    await migrate(database.db);
    const browser = {
      setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; }, async close() {},
      async act() { throw new Error('The fixture should be read through the HTTP page reader.'); },
    } as unknown as AgentBrowser;
    const searchProvider: SearchProvider = {
      name: 'live-port-fixtures',
      async search(query) {
        queries.push(query);
        const url = /rain/iu.test(query) ? rain : /أستراليا|استراليا|australia/iu.test(query) ? australia : iana;
        const page = pages[url]!;
        return [{ title: page.title, url, snippet: page.text.split('\n').at(-1)! }];
      },
    };
    control = await createCommandChatControl(database.db, {
      browser, searchProvider, models: { fast: [], deep: [], vision: '' }, recordExperiences: false,
      judgeShadow: shadow, judgeFixForOwner: true, judgeWithholdForOwner: true,
      readPage: async url => {
        reads.push(url);
        const page = pages[url];
        return page ? { ...page, url, status: 200 } : null;
      },
    });
  });
  afterAll(async () => {
    await control?.shutdown();
    await shadow?.flush();
    await database?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  beforeEach(() => { queries.length = 0; reads.length = 0; });

  async function ask(goal: string) {
    const { id } = await control.create(owner, { goal });
    await control.settled(id);
    const detail = await control.detail(owner, id);
    expect(detail.error).toBeNull();
    const run = await database.db.selectFrom('chat_runs').select('status').where('conversation_id', '=', id).executeTakeFirstOrThrow();
    return { reply: detail.messages.filter(message => message.role === 'assistant').at(-1)?.text ?? '', status: run.status };
  }

  it.each(['Explain why rain falls.', 'Explain why rain falls. Explain it in one sentence.'])('answers %s with the sourced cause', async goal => {
    const { reply, status } = await ask(goal);
    expect(queries, reply).toEqual(['why rain falls']);
    expect(reply.split('\n')[0]).toBe(rainCause);
    expect(reply).toContain(rain);
    expect(status).toBe('completed');
  });

  it('asks for the missing referent before searching a pointing reason question', async () => {
    const { reply } = await ask('Explain why it happened. Explain it in one sentence.');
    expect(queries, reply).toEqual([]);
    expect(reply).toMatch(/what are you referring to|what (?:exactly )?do you mean|which (?:event|thing)/iu);
  });

  const subject = 'the official IANA documentation about example domains';
  it('keeps a supported reply directive out of the explicit search query and returns the named fields', async () => {
    const { reply, status } = await ask(`Search the web for ${subject}. Return the page title and source link.`);
    expect(queries, reply).toEqual([subject]);
    expect(reads).toContain(iana);
    expect(reply).toBe(`**Page title:** ${ianaTitle}\n**Source link:** ${iana}`);
    expect(status).toBe('completed');
  });

  it('keeps a pronoun in the reply directive out of request scope and returns only its source link', async () => {
    const { reply, status } = await ask(`Search the web for ${subject}. Return only its source link.`);
    expect(queries, reply).toEqual([subject]);
    expect(reads).toContain(iana);
    expect(reply).toBe(`**Source link:** ${iana}`);
    expect(status).toBe('completed');
  });

  it('keeps the final RFC number and returns the opening sentence of the selected page', async () => {
    const numberedSubject = 'IANA example domains RFC 2606';
    const { reply, status } = await ask(`Search the web for ${numberedSubject}. Return the main heading and first sentence.`);
    expect(queries, reply).toEqual([numberedSubject]);
    expect(reply).toBe(`**Main heading:** ${ianaTitle}\n**First sentence:** ${ianaFirst}`);
    expect(status).toBe('completed');
  });

  it.each(['Return the answer in one sentence.', 'Return one sentence.'])('applies the sentence directive %s', async directive => {
    const { reply, status } = await ask(`Search the web for why rain falls. ${directive}`);
    expect(queries, reply).toEqual(['why rain falls']);
    expect(reply.split('\n\n')[0]).toBe(rainCause);
    expect(reply).not.toContain('More from the same source');
    expect(status).toBe('completed');
  });

  it('answers Australia’s population with the dated national estimate from the article', async () => {
    const { reply, status } = await ask('كم عدد سكان أستراليا؟');
    expect(status, reply).toBe('completed');
    expect(reply.split('\n')[0]).toBe(australiaEstimate + ' نسمة');
    expect(reply).toContain(australia);
    expect(reply).not.toContain('24,899,100');
  });

  it('drains queued judge entries and ignores new entries after chat shutdown', async () => {
    const input = { conversationId: 'judge-shutdown', question: 'What is 6 * 7?', reply: `6 * 7 = ${6 * 7}` };
    const runIds = async () => (await readFile(shadow.logFile, 'utf8')).trim().split('\n')
      .map(line => JSON.parse(line) as JudgeShadowLine)
      .filter(line => line.conversationId === input.conversationId)
      .map(line => line.runId);

    shadow.observe({ ...input, runId: 'queued' });
    await control.shutdown();
    expect(await runIds()).toEqual(['queued']);

    shadow.observe({ ...input, runId: 'late' });
    await shadow.flush();
    expect(await runIds()).toEqual(['queued']);
  });
});
