import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AgentBrowser, type AgentAction, type SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';

/**
 * An Arabic why-question through the real chat controller, with no model. Until 2026-11-23 it was refused before any search
 * («لم أبحث في الويب عن … يبدو الطلب متعلقًا بمعلومات خاصة»). It is now searched, answered only from a sentence that states the
 * cause of what was asked, and otherwise told plainly that no page answers it, with the pages found.
 */
const owner = 'isolated-reason-question-owner';
const wiki = (title: string) => `https://ar.wikipedia.org/wiki/${encodeURIComponent(title)}`;
const sky = wiki('السماء'), film = wiki('السماء الزرقاء (فيلم)'), sea = wiki('البحر');
// Mock page and question from PR #13, retrieved 2026-11-27.
// https://github.com/ahmadalwakai/Mohassan-AI/pull/13/files
const scattering = wiki('تشتت_الضوء');
const cloudExplanation = 'تبعثر قطرات الماء ألوان الضوء المرئي بالتساوي، ولذلك تظهر الغيوم بيضاء.';
const pages: Record<string, { title: string; text: string }> = {
  [sky]: { title: 'سماء - ويكيبيديا', text: 'السماء هي ما يُرى فوق سطح الأرض من غلاف جوي وفضاء خارجي.\nتبدو السماء زرقاء بسبب تبعثر ضوء الشمس في جزيئات الغلاف الجوي.\nتظهر في السماء ليلًا النجوم والكواكب والقمر عند صفاء الجو.\n' },
  [film]: { title: 'السماء الزرقاء (فيلم) - ويكيبيديا', text: 'السماء الزرقاء (الإنجليزية: Blue Sky) هو فيلم دراما تم إنتاجه في الولايات المتحدة وصدر في سنة 1994.\n' },
  [scattering]: { title: 'تشتت الضوء - ويكيبيديا', text: `تنتشر موجات الضوء في اتجاهات مختلفة عندما تمر بالجسيمات.
${cloudExplanation}
` },
  // A page about the subject that never says why: nothing in it may be quoted as the reason.
  [sea]: { title: 'بحر - ويكيبيديا', text: 'البحر مسطح مائي مالح متصل بالمحيط أو بحيرة مالحة كبيرة ليس لها منفذ.\nتغطي البحار والمحيطات معظم سطح الأرض وتؤثر في مناخها.\nيعيش في البحر عدد كبير من الكائنات الحية المالحة.\n' },
};

describe('a why-question through the real chat controller', () => {
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let control: Awaited<ReturnType<typeof createCommandChatControl>>;
  const queries: string[] = [], reads: string[] = [], actions: AgentAction[] = [];

  beforeAll(async () => {
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
        if (/الغيوم بيضاء/u.test(query)) return [{ title: 'تشتت الضوء', url: scattering, snippet: cloudExplanation }];
        if (/البحر/u.test(query)) return [{ title: 'بحر', url: sea, snippet: 'البحر مسطح مائي مالح' }];
        // The film comes first, as the live search listed it on 2026-11-23.
        return [{ title: 'السماء الزرقاء (فيلم)', url: film, snippet: 'السماء الزرقاء فيلم دراما' }, { title: 'سماء', url: sky, snippet: 'السماء هي ما يرى فوق سطح الأرض' }];
      },
    };
    control = await createCommandChatControl(database.db, {
      models: { fast: [], deep: [], vision: '' }, browser, searchProvider,
      readPage: async url => { reads.push(url); const found = pages[url]; return found ? { url: found === pages[sky] ? sky : url, title: found.title, text: found.text, status: 200 } : null; },
    });
  });
  afterAll(async () => { await control?.shutdown(); await database?.close(); });
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

  it('quotes the cause before the effect from a page about the cause', async () => {
    const { detail, reply, status } = await ask('لماذا تظهر الغيوم بيضاء؟');
    expect(detail.error).toBeNull();
    expect(reads).toContain(scattering);
    expect(reply.startsWith(cloudExplanation)).toBe(true);
    expect(reply).toContain(scattering);
    expect(status).toBe('completed');
  });

  it('still asks what a pointing why refers to, and searches nothing for it', async () => {
    const { detail, reply } = await ask('لماذا فعلت ذلك');
    expect(detail.error).toBeNull();
    expect(queries).toEqual([]);
    expect(reply).toContain('ما الشيء الذي تقصده؟');
  });
});
