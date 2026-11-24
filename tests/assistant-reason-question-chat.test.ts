import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AgentBrowser, type AgentAction, type SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import { createJudgeShadow } from '../apps/server/src/assistant/judge-shadow.js';

/**
 * Why-questions through the real chat controller, with no model. An Arabic why-question was refused before any search
 * («لم أبحث في الويب عن … يبدو الطلب متعلقًا بمعلومات خاصة»). It is now searched, answered only from a sentence that states the
 * cause of what was asked, and otherwise told plainly that no page answers it, with the pages found.
 */
const owner = 'isolated-reason-question-owner';
const wiki = (title: string) => `https://ar.wikipedia.org/wiki/${encodeURIComponent(title)}`;
const sky = wiki('السماء'), film = wiki('السماء الزرقاء (فيلم)'), sea = wiki('البحر');
const englishSky = 'https://en.wikipedia.org/wiki/Sky';
const pages: Record<string, { title: string; text: string }> = {
  [englishSky]: { title: 'Sky - Wikipedia', text: 'The sky often looks blue during the daytime.\nThe sky looks blue because molecules in the atmosphere scatter blue light.\nAt night, stars are visible in the sky.\n' },
  [sky]: { title: 'سماء - ويكيبيديا', text: 'السماء هي ما يُرى فوق سطح الأرض من غلاف جوي وفضاء خارجي.\nتبدو السماء زرقاء بسبب تبعثر ضوء الشمس في جزيئات الغلاف الجوي.\nتظهر في السماء ليلًا النجوم والكواكب والقمر عند صفاء الجو.\n' },
  [film]: { title: 'السماء الزرقاء (فيلم) - ويكيبيديا', text: 'السماء الزرقاء (الإنجليزية: Blue Sky) هو فيلم دراما تم إنتاجه في الولايات المتحدة وصدر في سنة 1994.\n' },
  // A page about the subject that never says why: nothing in it may be quoted as the reason.
  [sea]: { title: 'بحر - ويكيبيديا', text: 'البحر مسطح مائي مالح متصل بالمحيط أو بحيرة مالحة كبيرة ليس لها منفذ.\nتغطي البحار والمحيطات معظم سطح الأرض وتؤثر في مناخها.\nيعيش في البحر عدد كبير من الكائنات الحية المالحة.\n' },
};

describe('a why-question through the real chat controller', () => {
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let control: Awaited<ReturnType<typeof createCommandChatControl>>;
  let directory: string;
  const queries: string[] = [], reads: string[] = [], actions: AgentAction[] = [];

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mohassan-reason-question-'));
    database = await createDatabase();
    await migrate(database.db);
    const browser = {
      setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; },
      async observe() { throw new Error('No browser page should be observed'); },
      async act(_owner: string, _conversation: string, action: AgentAction) { actions.push(action); throw new Error(`Unexpected browser action: ${action.kind}`); },
      async close() {},
    } as unknown as AgentBrowser;
    const searchProvider: SearchProvider = {
      name: 'isolated-reason-question-search',
      async search(query) {
        queries.push(query);
        if (/\bsky\b/iu.test(query)) return [{ title: 'Sky', url: englishSky, snippet: 'The sky often looks blue during the daytime.' }];
        if (/البحر/u.test(query)) return [{ title: 'بحر', url: sea, snippet: 'البحر مسطح مائي مالح' }];
        // The film comes first, as the live search listed it on 2026-11-23.
        return [{ title: 'السماء الزرقاء (فيلم)', url: film, snippet: 'السماء الزرقاء فيلم دراما' }, { title: 'سماء', url: sky, snippet: 'السماء هي ما يرى فوق سطح الأرض' }];
      },
    };
    control = await createCommandChatControl(database.db, {
      models: { fast: [], deep: [], vision: '' }, browser, searchProvider,
      judgeShadow: createJudgeShadow({ logFile: join(directory, 'judge.jsonl') }), judgeFixForOwner: true, judgeWithholdForOwner: true,
      readPage: async url => { reads.push(url); const found = pages[url]; return found ? { url: found === pages[sky] ? sky : url, title: found.title, text: found.text, status: 200 } : null; },
    });
  });
  afterAll(async () => { await control?.shutdown(); await database?.close(); await rm(directory, { recursive: true, force: true }); });
  beforeEach(() => { queries.length = 0; reads.length = 0; actions.length = 0; });

  async function ask(goal: string) {
    const { id } = await control.create(owner, { goal });
    await control.settled(id);
    const detail = await control.detail(owner, id);
    const run = await database.db.selectFrom('chat_runs').select('status').where('conversation_id', '=', id).executeTakeFirstOrThrow();
    return { detail, reply: detail.messages.filter(message => message.role === 'assistant').at(-1)?.text ?? '', status: run.status };
  }

  it('searches for it and quotes the sentence that states the cause, from the page about the subject', async () => {
    const { detail, reply, status } = await ask('لماذا السماء زرقاء؟');
    expect(detail.error).toBeNull();
    expect(queries[0]).toBe('لماذا السماء زرقاء');
    expect(actions).toEqual([]);
    expect(reply).toMatch(/^تبدو السماء زرقاء بسبب تبعثر ضوء الشمس/u);
    expect(reply).toContain('**المصدر:**');
    expect(reply).not.toContain('فيلم دراما');
    expect(reply).not.toContain('لم أبحث في الويب');
    expect(status).toBe('completed');
  });

  it('says no page answers it when the page about the subject states no cause, and quotes nothing from it', async () => {
    const { detail, reply, status } = await ask('لماذا البحر مالح؟');
    expect(detail.error).toBeNull();
    expect(queries[0]).toBe('لماذا البحر مالح');
    expect(reply).toContain('لم أجد صفحة تجيب مباشرة عن «لماذا البحر مالح»');
    expect(reply).not.toContain('مسطح مائي');
    expect(reply).not.toContain('لم أبحث في الويب');
    expect(status).toBe('partial');
  });

  it.each([
    'Explain why the sky is blue.',
    'Explain why the sky is blue. Explain it in one sentence.',
  ])('quotes a reason for %s', async goal => {
    const { detail, reply, status } = await ask(goal);
    expect(detail.error).toBeNull();
    expect(queries).toEqual(['why the sky is blue']);
    expect(reply.split('\n')[0]).toBe('The sky looks blue because molecules in the atmosphere scatter blue light.');
    expect(reply).toContain(englishSky);
    expect(status).toBe('completed');
  });

  it.each([
    ['لماذا فعلت ذلك', 'ما الشيء الذي تقصده؟'],
    ['Explain why it happened. Explain it in one sentence.', 'What are you referring to?'],
  ])('asks what the reference in %s means without searching', async (goal, clarification) => {
    const { detail, reply } = await ask(goal);
    expect(detail.error).toBeNull();
    expect(queries).toEqual([]);
    expect(reply).toContain(clarification);
  });
});
