import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AgentAction, AgentBrowser, AgentPage, SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';

/**
 * «افتح موقعًا واعرض لي محتواه» through the real chat controller with no model, as production runs. On 2026-11-23 production
 * refused the home screen's own suggestion as private, answered a bare link «The required search or browsing route is not
 * fully available», and opened «افتح X واعرض لي محتواه» only to end «not verified». Only the browser and the search are
 * stand-ins; the pages and wordings are this test's own.
 */
const OWNER = 'isolated-open-read-owner';
const fieldNotes: AgentPage = {
  id: 'https://field-notes.test/', url: 'https://field-notes.test/', title: 'Field Notes', hash: 'field-notes',
  // The browser joins a page's text into one line (agent-browser.ts clean()).
  text: 'Field Notes This site keeps short records of each visit to the field. Each note names the place and the date.',
  elements: [{ ref: 'a1', role: 'link', label: 'All notes', href: 'https://field-notes.test/notes', inViewport: true }],
  signals: { captcha: false, password: false, otp: false, card: false }, scroll: { top: 0, height: 600, viewport: 600 },
  observedAt: '2026-11-23T12:00:00.000Z', documentStatus: 200,
};

describe('open a website and show what it says, through the real chat controller', () => {
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let control: Awaited<ReturnType<typeof createCommandChatControl>>;
  const current = new Map<string, AgentPage>();
  const actions: AgentAction[] = [];
  const queries: string[] = [];

  beforeAll(async () => {
    database = await createDatabase();
    await migrate(database.db);
    const browser = {
      setCheckpointStore() {}, async bindAccount() {},
      async hasPage(_owner: string, id: string) { return current.has(id); },
      async observe(_owner: string, id: string) { return { page: current.get(id)!, changed: false }; },
      async act(_owner: string, id: string, action: AgentAction) {
        actions.push(action);
        // An address without a scheme opens as https, as the real browser opens «افتح bbc.com».
        const address = /^https?:\/\//iu.test(action.text ?? '') ? action.text! : `https://${action.text}`;
        if (action.kind !== 'open' || new URL(address).href !== fieldNotes.url) throw new Error(`Unexpected browser action: ${action.kind} ${action.text ?? ''}`);
        current.set(id, fieldNotes);
        return { page: fieldNotes, changed: true };
      },
      async close() {},
    } as unknown as AgentBrowser;
    const searchProvider: SearchProvider = { name: 'isolated-open-read-search', async search(query) { queries.push(query); return []; } };
    control = await createCommandChatControl(database.db, { browser, models: { fast: [], deep: [], vision: '' }, searchProvider, recordExperiences: false });
  });
  afterAll(async () => { await control?.shutdown(); await database?.close(); });
  beforeEach(() => { actions.length = 0; queries.length = 0; current.clear(); });

  async function result(id: string) {
    await control.settled(id);
    const detail = await control.detail(OWNER, id);
    const run = await database.db.selectFrom('chat_runs').select(['status']).where('conversation_id', '=', id).orderBy('created_at', 'desc').executeTakeFirstOrThrow();
    return { id, detail, status: run.status, reply: detail.messages.filter(message => message.role === 'assistant').at(-1)?.text ?? '' };
  }
  async function ask(goal: string) {
    const { id } = await control.create(OWNER, { goal });
    return result(id);
  }
  const READ_AR = 'من **Field Notes** (field-notes.test):\n\n> Field Notes This site keeps short records of each visit to the field. Each note names the place and the date.';

  it('«افتح X واعرض لي محتواه» opens the page and shows its own text', async () => {
    const { reply, status } = await ask('افتح https://field-notes.test واعرض لي محتواه');
    expect(actions.map(action => `${action.kind} ${action.text}`)).toEqual(['open https://field-notes.test']);
    expect(reply.slice(0, READ_AR.length)).toBe(READ_AR);
    expect(reply).toContain('Each note names the place and the date.');
    expect(status).toBe('completed');
    expect(queries).toEqual([]);
  });

  it('a message that is only a link is opened and read, in Arabic unless the conversation is English', async () => {
    const bare = await ask('https://field-notes.test');
    expect(actions.map(action => action.kind)).toEqual(['open']);
    expect(bare.reply.slice(0, READ_AR.length)).toBe(READ_AR);
    expect(bare.status).toBe('completed');
    // After an English message the same link is read with an English frame; the page's sentences stay as written.
    const english = await ask('Calculate 2 + 2.');
    await control.send(OWNER, english.id, { text: 'https://field-notes.test' });
    const read = await result(english.id);
    expect(read.reply).toMatch(/^From \*\*Field Notes\*\* \(field-notes\.test\):\n\n> Field Notes/u);
    expect(queries).toEqual([]);
  });

  it('the home suggestion asks which website, then finishes the same request with the answer', async () => {
    const asked = await ask('افتح موقعًا واعرض لي محتواه');
    expect(asked.detail.status).toBe('waiting_user');
    expect(asked.detail.question?.prompt).toContain('أي موقع؟');
    expect(asked.detail.question?.fields?.map(field => field.id)).toEqual(['site']);
    expect(actions).toEqual([]);
    expect(queries).toEqual([]);
    await control.send(OWNER, asked.id, { questionId: asked.detail.question!.id, answers: [{ fieldId: 'site', value: 'field-notes.test' }] });
    const done = await result(asked.id);
    expect(actions.map(action => `${action.kind} ${action.text}`)).toEqual(['open field-notes.test']);
    expect(done.reply.slice(0, READ_AR.length)).toBe(READ_AR);
    expect(done.status).toBe('completed');
    expect(queries).toEqual([]);
  });

  it('an answer that names no website is said so, and nothing is opened or searched', async () => {
    const asked = await ask('افتح موقعًا واعرض لي محتواه');
    await control.send(OWNER, asked.id, { text: 'لا أعرف بعد', questionId: asked.detail.question!.id });
    const done = await result(asked.id);
    expect(done.reply).toContain('لم أجد في ردك «لا أعرف بعد» رابطًا أو اسم موقع أفتحه');
    expect(done.status).toBe('blocked');
    expect(actions).toEqual([]);
    expect(queries).toEqual([]);
  });

  it('asks in English for an English request, and reads the page with an English frame', async () => {
    const asked = await ask('Open a website and show me its content');
    expect(asked.detail.question?.prompt).toContain('Which website?');
    await control.send(OWNER, asked.id, { text: 'https://field-notes.test', questionId: asked.detail.question!.id });
    const done = await result(asked.id);
    expect(done.reply).toMatch(/^From \*\*Field Notes\*\* \(field-notes\.test\):\n\n> Field Notes/u);
    expect(done.status).toBe('completed');
  });

  it('asks for the unnamed destination before trying browser actions and resumes from the address', async () => {
    const asked = await ask('Kindly open the web page for us.');
    expect(asked.status).toBe('waiting_user');
    expect(asked.detail.question?.fields?.map(field => field.id)).toEqual(['site']);
    expect(actions).toEqual([]);
    expect(queries).toEqual([]);
    await control.send(OWNER, asked.id, { text: fieldNotes.url, questionId: asked.detail.question!.id });
    const done = await result(asked.id);
    expect(done.detail.run?.id).toBe(asked.detail.run?.id);
    expect(done.status).toBe('completed');
    expect(actions.map(action => [action.kind, action.text])).toEqual([['open', fieldNotes.url]]);
    expect(queries).toEqual([]);
  });

  it('reads an explicitly referenced live page without navigating or asking', async () => {
    const opened = await ask('https://field-notes.test');
    actions.length = 0;
    await control.send(OWNER, opened.id, { text: 'Visit this webpage and display its text.' });
    const read = await result(opened.id);
    expect(read.status).toBe('completed');
    expect(read.detail.question).toBeFalsy();
    expect(read.reply).toContain('Each note names the place and the date.');
    expect(actions).toEqual([]);
    expect(queries).toEqual([]);
  });
});
