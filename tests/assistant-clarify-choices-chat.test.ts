import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentBrowser, SearchProvider } from '@mohassan/browser';
import { ChatQuestionSchema } from '@mohassan/contracts';
import { createDatabase, migrate } from '@mohassan/database';
import { describeDesktopCommand, parseDesktopCommand, type DesktopCommand } from '@mohassan/desktop';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import { clarifyDesktopFile } from '../apps/server/src/assistant/clarify/host.js';

// Development-only assertions. Requests substitute the user's Paris example into human MASSIVE 1.0
// utterances 14283 (English) and 13895 (Arabic). The brief Wikipedia excerpts are CC BY-SA.
// https://en.wikipedia.org/wiki/Paris_(disambiguation) https://ar.wikipedia.org/wiki/باريس_(توضيح)
// No model or API produces the cases, and neither these fixtures nor their runs are used for training.
const cases = {
  en: {
    goal: 'tell me about Paris',
    subject: 'Paris',
    other: 'Paris, France',
    otherPlaceholder: /Other/iu,
    articles: [
      { title: 'Paris, Texas', text: 'Paris is a city in and the county seat of Lamar County, Texas, United States. Located in Northeast Texas at the western edge of the Piney Woods, the population of the city was 24,171 in 2020.' },
      { title: 'Paris (mythology)', text: 'Paris, also known as Alexander, is a figure from Greek mythology who appears in the numerous stories about the Trojan War, including the Iliad. He was prince of Troy, a son of King Priam and Queen Hecuba, and younger brother of Prince Hector.' },
      { title: 'Paris, France', text: 'Paris is the capital and largest city of France. The City of Paris is the centre of the Île-de-France region.' },
    ],
    disambiguation: { title: 'Paris (disambiguation)', text: 'Paris is the capital of France, which may consist of:\nParis (mythology), a prince of Troy in Greek mythology\nParis, Texas, a city' },
  },
  ar: {
    goal: 'هل يمكنك ان تخبرني عن باريس',
    subject: 'باريس',
    other: 'باريس، فرنسا',
    otherPlaceholder: /غير ذلك/u,
    articles: [
      { title: 'باريس (تكساس)', text: 'باريس (الإنجليزية: Paris) هي مدينة أمريكية تقع في ولاية تكساس. تبلغ مساحة هذه المدينة 115 (كم²)، ويبلغ عدد سكانها 25898 نسمة حسب إحصاء سنة 2010 م.' },
      { title: 'باريس (أسطورة)', text: 'باريس هو ابن الملك بريام وشقيق الأمير هيكتور. عرف أيضًا باسم «أليكساندر» ويقال أنه كان رائع الجمال وأجمل أولاد بريام كلهم.' },
      { title: 'باريس، فرنسا', text: 'باريس هي عاصمة فرنسا وأكبر مدنها من حيث عدد السكان. تقع المدينة على ضفاف نهر السين في الجزء الشمالي من البلاد.' },
    ],
    disambiguation: { title: 'باريس (توضيح)', text: 'باريس هي عاصمة فرنسا.\nباريس (أسطورة): شخصية أسطورية إغريقية.\nباريس (تكساس): تكساس.' },
  },
} as const;

const owner = 'isolated-clarification-choice-owner';
const wiki = (lang: keyof typeof cases, title: string) => `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replaceAll(' ', '_'))}`;
const articleTitles = (lang: keyof typeof cases) => cases[lang].articles.slice(0, 2).map(article => article.title);
const lookups: string[] = [];
const memoryLookups: Array<{ ownerId: string; query: string }> = [];
const desktopCalls: DesktopCommand[] = [];
const files = ['AGENTS.md', 'README.md'];
const dates = [7, 14].map(days => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10));
let returnDisambiguation = true;
let returnDefaultArticle = false;
const browser = {
  setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; }, async close() {},
  async act() { throw new Error('This test has no browser action port'); },
  async observe() { throw new Error('This test has no browser page'); },
} as unknown as AgentBrowser;
const searchProvider: SearchProvider = {
  name: 'offline-clarification-choice-fixture',
  async search(query) {
    lookups.push(query);
    const lang = /\p{Script=Arabic}/u.test(query) ? 'ar' : 'en';
    const scenario = cases[lang];
    if (!query.toLowerCase().includes(scenario.subject.toLowerCase())) return [];
    const article = scenario.articles.find(item => query.toLowerCase().includes(item.title.toLowerCase())
      || query.toLowerCase().includes(item.title.replace(/[(),،]/gu, '').toLowerCase()));
    if (!article && !returnDisambiguation) return [];
    const match = article ?? (returnDefaultArticle ? { ...scenario.articles[2], title: scenario.subject } : scenario.disambiguation);
    return [{ title: match.title, url: wiki(lang, match.title), snippet: match.text }];
  },
};

async function readPage(address: string) {
  const url = new URL(address);
  if (url.hostname !== 'en.wikipedia.org' && url.hostname !== 'ar.wikipedia.org') return null;
  const lang = url.hostname === 'ar.wikipedia.org' ? 'ar' : 'en';
  const scenario = cases[lang];
  const title = decodeURIComponent(url.pathname.split('/').at(-1) ?? '').replaceAll('_', ' ');
  if (returnDefaultArticle && title === scenario.subject) return { url: url.href, ...scenario.articles[2], title, status: 200 };
  if (title === scenario.disambiguation.title) return { url: url.href, ...scenario.disambiguation, status: 200,
    links: articleTitles(lang).map(value => wiki(lang, value)) };
  const article = scenario.articles.find(item => item.title.toLowerCase() === title.toLowerCase());
  return article ? { url: url.href, ...article, status: 200 } : null;
}

describe('choice clarification through the command chat controller', () => {
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let active: Awaited<ReturnType<typeof createCommandChatControl>>;
  let inactive: typeof active;

  beforeAll(async () => {
    database = await createDatabase({});
    expect(database.mode).toBe('embedded');
    await migrate(database.db);
    const config = { models: { fast: [], deep: [], vision: '' }, browser, searchProvider, readPage, recordExperiences: false as const,
      desktop: { parse: parseDesktopCommand, describe: describeDesktopCommand, async execute(command: DesktopCommand) {
        desktopCalls.push(command);
        if (command.kind !== 'file_read' || command.folder) throw new Error('Unexpected desktop dispatch');
        return { status: 'completed' as const, text: command.path };
      } },
      tools: { memory: {
        async search(ownerId: string, query: string) {
          memoryLookups.push({ ownerId, query });
          return { text: '', evidence: query === 'date' ? dates : query === 'file' ? files.map(file => 'file ' + file) : [] };
        },
        async save() { throw new Error('Clarification does not write memory'); },
      } } };
    const activeConfig = { ...config, clarifyChoices: true,
      desktop: { ...config.desktop, parse: (text: string) => clarifyDesktopFile(text, parseDesktopCommand, true) } };
    const inactiveConfig = { ...config, clarifyChoices: false };
    active = await createCommandChatControl(database.db, activeConfig);
    inactive = await createCommandChatControl(database.db, inactiveConfig);
  });

  afterAll(async () => {
    await active?.shutdown();
    await inactive?.shutdown();
    await database?.close();
  });

  beforeEach(() => { lookups.length = 0; memoryLookups.length = 0; desktopCalls.length = 0; returnDisambiguation = true; returnDefaultArticle = false; });

  async function ask(goal: string, control = active) {
    const { id } = await control.create(owner, { goal });
    await control.settled(id);
    return control.detail(owner, id);
  }

  async function run(id: string) {
    return database.db.selectFrom('chat_runs').select(['id', 'goal', 'status', 'state'])
      .where('conversation_id', '=', id).executeTakeFirstOrThrow();
  }

  async function choice(lang: keyof typeof cases, goal: string = cases[lang].goal) {
    const detail = await ask(goal);
    expect(detail.status).toBe('waiting_user');
    expect(detail.error).toBeNull();
    const question = ChatQuestionSchema.parse(detail.question);
    expect(question.fields).toHaveLength(1);
    const field = question.fields![0]!;
    expect(field.id).toBe('choice');
    expect(field.placeholder).toMatch(cases[lang].otherPlaceholder);
    expect(field.prompt.match(/[?؟]/gu)).toHaveLength(1);
    expect(field.suggestions.map(suggestion => suggestion.label).sort()).toEqual(articleTitles(lang).sort());
    expect(question.options.map(option => option.label).sort()).toEqual(articleTitles(lang).sort());
    return { detail, question, field };
  }

  async function finished(id: string, originalRun: string, lang: keyof typeof cases, label: string, goal: string = cases[lang].goal) {
    await active.settled(id);
    const detail = await active.detail(owner, id);
    expect(detail.question).toBeNull();
    expect(detail.error).toBeNull();
    expect(detail.messages.filter(message => message.role === 'user').map(message => message.text)).toEqual([goal, label]);
    const current = await run(id);
    expect(current).toMatchObject({ id: originalRun, goal, status: 'completed' });
    expect(current.state.clarifiedRequest).toBe(goal.replace(cases[lang].subject, label));
    expect(detail.messages.filter(message => message.role === 'assistant').at(-1)?.text).toContain(label.replace(/ \(.+\)$/u, ''));
  }

  it('takes one web card answer transactionally, keeps the original task and rejects duplicate replies', async () => {
    const { detail, question, field } = await choice('en');
    const before = await run(detail.id);
    const label = cases.en.articles[0].title;
    const answer = { questionId: question.id, answers: [{ fieldId: field.id, value: label }], text: 'What about it?' };
    const attempts = await Promise.allSettled([active.send(owner, detail.id, answer), active.send(owner, detail.id, answer)]);
    expect(attempts.filter(attempt => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.find(attempt => attempt.status === 'rejected')).toMatchObject({ reason: { statusCode: 409 } });
    await finished(detail.id, before.id, 'en', label);
  });

  it('resumes the Arabic request from the existing option response', async () => {
    const { detail, question } = await choice('ar');
    const before = await run(detail.id);
    const label = cases.ar.articles[0].title;
    await active.respond(owner, detail.id, { questionId: question.id, optionId: question.options.find(option => option.label === label)!.id });
    await finished(detail.id, before.id, 'ar', label);
  });

  it('resumes an indirect knowledge question through the public lookup path', async () => {
    // Existing utterance from assistant-self-knowledge.test.ts.
    const goal = 'what can you tell me about Paris';
    const { detail, question } = await choice('en', goal);
    const before = await run(detail.id);
    const label = cases.en.articles[0].title;
    await active.respond(owner, detail.id, { questionId: question.id, optionId: question.options.find(option => option.label === label)!.id });
    await finished(detail.id, before.id, 'en', label, goal);
  });

  it('uses a typed alternative as the subject of the original request', async () => {
    const { detail, question, field } = await choice('en');
    const before = await run(detail.id);
    await active.send(owner, detail.id, { questionId: question.id, answers: [{ fieldId: field.id, value: cases.en.other }] });
    await finished(detail.id, before.id, 'en', cases.en.other);
  });

  it('keeps the ordinary search wording when the evidence finds a clear subject', async () => {
    returnDefaultArticle = true;
    const detail = await ask('What is Paris?');
    expect(detail.question).toBeNull();
    expect(detail.messages.at(-1)?.text).toContain('capital and largest city of France');
    expect((await run(detail.id)).status).toBe('completed');
    expect(lookups).toEqual(['What is Paris', 'What is Paris']);
  });

  it('recovers both matching subjects from earlier owner turns when search provides none', async () => {
    returnDisambiguation = false;
    const scenario = cases.en;
    const [first, second] = articleTitles('en').map(title => scenario.goal.replace(scenario.subject, title));
    const opened = await ask(first!);
    expect(opened.question).toBeNull();
    await active.send(owner, opened.id, { text: second });
    await active.settled(opened.id);
    expect((await active.detail(owner, opened.id)).question).toBeNull();
    await active.send(owner, opened.id, { text: scenario.goal });
    await active.settled(opened.id);
    const detail = await active.detail(owner, opened.id);
    expect(detail.status).toBe('waiting_user');
    expect(detail.question?.options.map(option => option.label).sort()).toEqual(articleTitles('en').sort());
    expect(memoryLookups).toEqual([]);
  });

  it('dispatches the selected route and does not run the other alternative', async () => {
    // Both branches are unchanged utterances from assistant-routing-decision.test.ts.
    const branches = ['Write an apology letter to a customer.', 'Calculate 8 * 9.'];
    const goal = branches.join(' or ');
    const detail = await ask(goal);
    const question = ChatQuestionSchema.parse(detail.question);
    expect(detail.status).toBe('waiting_user');
    expect(question.prompt).toBe('Which action should I take?');
    expect(question.options.map(option => option.label)).toEqual(branches);
    const before = await run(detail.id);
    await active.respond(owner, detail.id, { questionId: question.id, optionId: question.options[1]!.id });
    await active.settled(detail.id);
    const after = await active.detail(owner, detail.id);
    expect(after.question).toBeNull();
    expect(after.messages.at(-1)?.text).toContain('72');
    expect(await run(detail.id)).toMatchObject({ id: before.id, goal, status: 'completed', state: { routing: { route: 'compute' } } });
    expect(lookups).toEqual([]);
  });

  it('offers the owner’s dates for a missing slot and continues to the reminder capability check', async () => {
    // Remove the time field from the existing router fixture to exercise slot filling.
    const goal = 'Remind me to call the supplier tomorrow.'.replace(' tomorrow', '');
    const detail = await ask(goal);
    const question = ChatQuestionSchema.parse(detail.question);
    expect(detail.status).toBe('waiting_user');
    expect(question.prompt).toBe('Which date should I use?');
    expect(question.options.map(option => option.label).sort()).toEqual([...dates].sort());
    expect(memoryLookups).toEqual([{ ownerId: owner, query: 'date' }]);
    const before = await run(detail.id);
    const selected = question.options[0]!;
    await active.respond(owner, detail.id, { questionId: question.id, optionId: selected.id });
    await active.settled(detail.id);
    const after = await active.detail(owner, detail.id);
    expect(after.question).toBeNull();
    expect(after.error).toBeNull();
    // This configuration has no reminder scheduler. A resumed request reports that capability limit once.
    expect(after.messages.at(-1)?.text).toMatch(/reminder.*scheduling/iu);
    expect(await run(detail.id)).toMatchObject({ id: before.id, goal, status: 'blocked',
      state: { clarifiedRequest: `Remind me to call the supplier on ${selected.label}.`, routing: { route: 'reminder' } } });
    expect(lookups).toEqual([]);
  });

  it('reads the selected file once through the existing desktop parser', async () => {
    // The computer-request-scope fixture declares the local target without a file name.
    const goal = 'Open the file on my computer.'.replace('Open', 'Read');
    const detail = await ask(goal);
    const question = ChatQuestionSchema.parse(detail.question);
    expect(detail.status).toBe('waiting_user');
    expect(question.prompt).toBe('Which file should I use?');
    expect(question.options.map(option => option.label).sort()).toEqual([...files].sort());
    expect(memoryLookups).toEqual([{ ownerId: owner, query: 'file' }]);
    expect(desktopCalls).toEqual([]);
    const before = await run(detail.id);
    const selected = question.options[0]!;
    await active.respond(owner, detail.id, { questionId: question.id, optionId: selected.id });
    await active.settled(detail.id);
    const after = await active.detail(owner, detail.id);
    expect(after.question).toBeNull();
    expect(after.error).toBeNull();
    expect(await run(detail.id)).toMatchObject({ id: before.id, goal, status: 'completed' });
    expect(desktopCalls).toEqual([{ kind: 'file_read', path: selected.label, folder: null }]);
    expect(lookups).toEqual([]);
  });

  it.each(['en', 'ar'] as const)('does not ask when the %s request already names the entity precisely', async lang => {
    const scenario = cases[lang];
    const detail = await ask(scenario.goal.replace(scenario.subject, scenario.articles[0].title));
    expect(detail.question).toBeNull();
    expect(detail.error).toBeNull();
    expect((await run(detail.id)).status).toBe('completed');
  });

  it('preserves the old card with the flag off and logs a text-free shadow comparison', async () => {
    const info = vi.spyOn(console, 'info');
    try {
      // Existing fixture from assistant-clarification-time-audit.test.ts.
      const goal = 'What about it?';
      const detail = await ask(goal, inactive);
      expect(detail.status).toBe('waiting_user');
      expect(detail.question).toMatchObject({ options: [] });
      expect(detail.question?.fields).toBeUndefined();
      const shadow = info.mock.calls.flat().filter(entry => typeof entry === 'string' && entry.includes('clarification_shadow'));
      expect(shadow).toHaveLength(1);
      expect(JSON.stringify(shadow)).not.toContain(goal);
      expect(lookups).toEqual([]);
    } finally { info.mockRestore(); }
  });

  it('continues the same run after a complete reply to an open card', async () => {
    const goal = 'What about it?';
    const waiting = await ask(goal);
    expect(waiting.status).toBe('waiting_user');
    const question = ChatQuestionSchema.parse(waiting.question);
    expect(question.options).toEqual([]);
    const before = await run(waiting.id);
    await expect(active.send(owner, waiting.id, { text: 'Other', questionId: question.id }))
      .rejects.toMatchObject({ code: 'CHAT_CLARIFICATION_ANSWER_INVALID' });
    expect((await active.detail(owner, waiting.id)).question?.id).toBe(question.id);
    const text = 'Calculate 27 plus 18.';
    await active.send(owner, waiting.id, { text, questionId: question.id });
    await active.settled(waiting.id);

    const detail = await active.detail(owner, waiting.id);
    expect(detail.question).toBeNull();
    expect(detail.messages.filter(message => message.role === 'user').map(message => message.text)).toEqual([goal, text]);
    expect(detail.messages.filter(message => message.role === 'assistant').at(-1)?.text).toMatch(/\b45\b/u);
    expect(await run(waiting.id)).toMatchObject({ id: before.id, goal, status: 'completed', state: { routing: { route: 'compute' } } });
    expect(lookups).toEqual([]);
  });

  it('uses a short numeric answer to finish the original referenced calculation', async () => {
    const goal = 'Would you double that number?';
    const waiting = await ask(goal);
    expect(waiting.status).toBe('waiting_user');
    const question = ChatQuestionSchema.parse(waiting.question);
    expect(question.prompt).toContain('that number');
    const before = await run(waiting.id);
    await active.send(owner, waiting.id, { text: '12.5', questionId: question.id });
    await active.settled(waiting.id);

    const detail = await active.detail(owner, waiting.id);
    expect(detail.question).toBeNull();
    expect(detail.messages.filter(message => message.role === 'assistant').at(-1)?.text).toContain('12.5 * 2 = 25');
    expect(await run(waiting.id)).toMatchObject({ id: before.id, goal, status: 'completed' });
    expect(lookups).toEqual([]);
  });

  it('converts the original quantity after the owner supplies both units', async () => {
    const goal = 'Convert 37.';
    const waiting = await ask(goal);
    expect(waiting.status).toBe('waiting_user');
    const question = ChatQuestionSchema.parse(waiting.question);
    const before = await run(waiting.id);
    await active.send(owner, waiting.id, { text: 'kilometres to metres', questionId: question.id });
    await active.settled(waiting.id);

    const detail = await active.detail(owner, waiting.id);
    expect(detail.question).toBeNull();
    expect(detail.messages.filter(message => message.role === 'assistant').at(-1)?.text).toContain('37000 metres');
    expect(await run(waiting.id)).toMatchObject({ id: before.id, goal, status: 'completed', state: { routing: { route: 'compute' } } });
    expect(lookups).toEqual([]);
  });

  it('keeps structured-memory filtering on the clarification-aware send path', async () => {
    vi.stubEnv('MOHASSAN_STRUCTURED_MEMORY', '1');
    try {
      const { detail: waiting } = await choice('en');
      const before = await run(waiting.id);
      const label = cases.en.articles[0].title;
      await active.send(owner, waiting.id, { text: label });
      await finished(waiting.id, before.id, 'en', label);

      const secret = 'fixture-password-violet-starling';
      await active.send(owner, waiting.id, { text: 'Remember that my password is ' + secret });
      await active.settled(waiting.id);
      const detail = await active.detail(owner, waiting.id);
      expect(detail.status).toBe('blocked');
      expect(JSON.stringify(detail)).not.toContain(secret);
      const messages = await database.db.selectFrom('chat_messages').select('text')
        .where('conversation_id', '=', waiting.id).where('role', '=', 'user').execute();
      expect(JSON.stringify(messages)).not.toContain(secret);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('does not send private account text to public search', async () => {
    // Existing fixture from assistant-request-context.test.ts.
    const detail = await ask('ما كلمة المرور في حسابي؟');
    expect(detail.error).toBeNull();
    expect(lookups).toEqual([]);
  });
});
