import { AgentBrowser, type AgentPage, type SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterEach, expect, it, vi } from 'vitest';
import { decideRequestRoute } from '../apps/server/src/assistant/routing-decision.js';
import { writingTask } from '../apps/server/src/assistant/writer.js';
import { readWritingPdf } from '../apps/server/src/assistant/writing/pdf-source.js';
import { renderExtractiveWriting } from '../apps/server/src/assistant/writing/render.js';
import { createCommandChatControl, type CommandChatConfig } from '../apps/server/src/command-chat.js';
import pages from './fixtures/extractive-writing/public-pages.json';
import userTexts from './fixtures/extractive-writing/user-texts.json';

const owner = 'extractive-writing-test';
const photosynthesis = pages.find(item => item.id === 'page-en-photosynthesis')!;
const eclipse = pages.find(item => item.id === 'page-en-solar-eclipse')!;
const moon = pages.find(item => item.id === 'page-ar-moon')!;
const workChecklist = userTexts.find(item => item.id === 'user-ar-work-checklist')!;
const privateLetter = userTexts.find(item => item.id === 'user-en-austen-8')!;
let database: Awaited<ReturnType<typeof createDatabase>> | undefined;
let control: Awaited<ReturnType<typeof createCommandChatControl>> | undefined;

afterEach(async () => {
  await control?.shutdown();
  await database?.close();
  control = database = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function harness(options: Partial<CommandChatConfig> & { page?: AgentPage } = {}) {
  database = await createDatabase();
  await migrate(database.db);
  const search = vi.fn<SearchProvider['search']>(async () => [{ title: photosynthesis.title, url: photosynthesis.url, snippet: privateLetter.text }]);
  const readPage = vi.fn<NonNullable<CommandChatConfig['readPage']>>(async url => {
    const item = [photosynthesis, eclipse, moon].find(fixture => fixture.url === url);
    return item ? { url, title: item.title, text: item.text, status: 200 } : null;
  });
  const observe = vi.fn(async () => ({ page: options.page }));
  const browser = { setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return Boolean(options.page); },
    observe, act: vi.fn(), async close() {} } as unknown as AgentBrowser;
  const inference = vi.fn(() => { throw new Error('Unexpected inference call'); });
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  control = await createCommandChatControl(database.db, {
    models: { fast: [], deep: [], vision: '' }, fetch: inference, browser,
    searchProvider: { name: 'read-fixtures', search }, readPage, ...options,
  });
  const start = async (goal: string) => {
    const { id } = await control!.create(owner, { goal });
    return { id, text: await answer(id) };
  };
  const answer = async (id: string) => {
    await control!.settled(id);
    const result = await control!.detail(owner, id);
    expect(result.error).toBeNull();
    expect(result.status).toBe('idle');
    return result.messages.at(-1)?.text ?? '';
  };
  const send = async (id: string, text: string) => {
    await control!.send(owner, id, { text });
    return answer(id);
  };
  return { start, send, search, readPage, observe, inference, info };
}

it('leaves routing off by default and records a text-free shadow event', async () => {
  vi.stubEnv('MOHASSAN_EXTRACTIVE_WRITING', undefined);
  const { start, readPage, search, inference, info } = await harness();
  const goal = `Summarize this text in one line: ${privateLetter.text}`;
  expect(decideRequestRoute({ text: goal }).availability).not.toBe('ready');
  const { text } = await start(goal);
  expect(text).toContain('needs a model');
  const candidate = info.mock.calls.map(([line]) => String(line)).find(line => line.includes('extractive_writing_shadow'))!;
  expect(JSON.parse(candidate)).toMatchObject({ enabled: false, sourceKind: 'paste', operation: 'summary', sources: 1, spans: 1 });
  expect(candidate).not.toContain(privateLetter.keyFacts[0]);
  expect(readPage).not.toHaveBeenCalled();
  expect(search).not.toHaveBeenCalled();
  expect(inference).not.toHaveBeenCalled();
});

it('routes an Arabic paste locally and reuses the previous user text with literal evidence', async () => {
  vi.stubEnv('MOHASSAN_EXTRACTIVE_WRITING', '1');
  const { start, send, readPage, search, observe, inference } = await harness();
  const goal = `لخّص النص في نقاط: ${workChecklist.text}`;
  const task = writingTask(goal, 'extractive')!;
  expect(decideRequestRoute({ text: goal })).toMatchObject({ route: 'writing', handler: 'writing', availability: 'ready' });
  const { id, text } = await start(goal);
  expect(task.source.kind).toBe('paste');
  if (task.source.kind !== 'paste') throw new Error('Expected a literal source');
  expect(goal.slice(task.source.offset, task.source.offset + task.source.text.length)).toBe(workChecklist.text);
  const source = { title: 'النص المرسل', text: task.source.text, offset: task.source.offset };
  const rendered = renderExtractiveWriting(task, [source]);
  expect(text).toBe(rendered.text);
  expect(text).toMatch(/^- «.+» 〔النص المرسل \d+–\d+〕/mu);
  expect(rendered.evidence.length).toBeGreaterThan(1);
  for (const span of rendered.evidence) {
    expect(span.text).toBe(source.text.slice(span.start, span.end));
    expect(span.text).toBe(goal.slice(source.offset + span.start, source.offset + span.end));
  }
  const next = await send(id, 'لخّص النص الذي أرسلته في سطر واحد');
  expect(next).toContain('〔النص المرسل');
  expect(next).not.toContain('\n');
  expect(readPage).not.toHaveBeenCalled();
  expect(search).not.toHaveBeenCalled();
  expect(observe).not.toHaveBeenCalled();
  expect(inference).not.toHaveBeenCalled();
});

it('reads several URLs and reuses the read receipts only in the same conversation', async () => {
  vi.stubEnv('MOHASSAN_EXTRACTIVE_WRITING', '1');
  const { start, send, readPage, search, inference } = await harness();
  const { id, text } = await start(`Summarize “${photosynthesis.url}” and ${eclipse.url} in 4 bullets`);
  expect(text).toContain(photosynthesis.url);
  expect(text).toContain(eclipse.url);
  expect(text.match(/^- /gmu)).toHaveLength(4);
  expect(readPage.mock.calls.map(([url]) => url)).toEqual([photosynthesis.url, eclipse.url]);
  const reused = await send(id, 'Summarize the sources you read in one paragraph');
  expect(reused).toContain(photosynthesis.url);
  expect(reused).not.toContain('\n');
  const independent = await start('Summarize the last page you read');
  expect(independent.text).toContain('No readable text found');
  expect(readPage).toHaveBeenCalledTimes(4);
  expect(search).not.toHaveBeenCalled();
  expect(inference).not.toHaveBeenCalled();
});

it('reads the observed page without navigating, and leaves private topics out of public search', async () => {
  vi.stubEnv('MOHASSAN_EXTRACTIVE_WRITING', '1');
  const { start, observe, readPage, search } = await harness({ page: { id: 'fixture', url: moon.url, title: moon.title, text: moon.text,
    elements: [], signals: { captcha: false, password: false, otp: false, card: false }, scroll: { top: 0, height: 0, viewport: 0 }, hash: 'fixture',
    observedAt: '2026-11-25T00:00:00.000Z' } });
  const result = await start('لخّص هذه الصفحة في سطر واحد');
  expect(result.text).toContain(moon.url);
  expect(observe).toHaveBeenCalledOnce();
  expect(readPage).not.toHaveBeenCalled();
  const privateResult = await start('Explain why my account was blocked');
  expect(privateResult.text).toContain('memory tool is unavailable');
  expect(search).not.toHaveBeenCalled();
});

it('uses fully read explanation quotes and compares evidence for both subjects', async () => {
  vi.stubEnv('MOHASSAN_EXTRACTIVE_WRITING', '1');
  const { start, readPage, search, inference } = await harness();
  const { text } = await start('How does photosynthesis work?');
  expect(search).toHaveBeenCalledWith('photosynthesis', expect.any(Number), expect.any(AbortSignal), { ownerId: owner });
  expect(readPage).toHaveBeenCalledOnce();
  expect(text).toContain(photosynthesis.url);
  expect(text).not.toContain(privateLetter.keyFacts[0]);
  const { text: table } = await start(`What is the difference between photosynthesis and solar eclipse using ${photosynthesis.url} and ${eclipse.url}?`);
  expect(table).toMatch(/^\| Aspect \| photosynthesis \| solar eclipse \|/u);
  expect(table).toContain(photosynthesis.url);
  expect(table).toContain(eclipse.url);
  expect(inference).not.toHaveBeenCalled();
});

it('uses independent public reads, cites a direct conflict and logs counts through the writing route', async () => {
  vi.stubEnv('MOHASSAN_EXTRACTIVE_WRITING', '1');
  const evidence = 'Erosion leads to changes in river banks.';
  const contradiction = 'Erosion does not lead to changes in river banks.';
  const sources = [
    { url: 'https://geology.example/erosion', title: 'Geology', text: evidence },
    { url: 'https://rivers.example/banks', title: 'Rivers', text: `${evidence} Rivers carry sediment downstream.` },
    { url: 'https://watershed.example/change', title: 'Watershed', text: contradiction },
  ];
  const search = vi.fn<SearchProvider['search']>(async () => sources.map(source => ({ ...source, snippet: 'Unread claim.' })));
  const readPage = vi.fn<NonNullable<CommandChatConfig['readPage']>>(async url => {
    const page = sources.find(source => source.url === url);
    return page ? { ...page, status: 200 } : null;
  });
  const { start, info, inference } = await harness({ searchProvider: { name: 'independent-fixtures', search }, readPage });
  const goal = 'Why does erosion change river banks?';
  expect(decideRequestRoute({ text: goal })).toMatchObject({ route: 'web_search', handler: 'writing' });
  const { text } = await start(goal);
  expect(search).toHaveBeenCalledOnce();
  expect(readPage.mock.calls.map(([url]) => url)).toEqual(sources.map(source => source.url));
  expect(text).toContain(`«${evidence}»`);
  expect(text).toContain(`«${contradiction}»`);
  for (const { url } of sources) expect(text).toContain(url);
  expect(text).not.toContain('Unread claim');
  expect(inference).not.toHaveBeenCalled();
  const event = info.mock.calls.map(([line]) => String(line)).find(line => line.includes('extractive_writing_shadow'))!;
  expect(JSON.parse(event)).toMatchObject({ enabled: true, intent: 'why', independentSources: 3,
    alignment: { corroborated: 1, conflicts: 1 } });
  expect(event).not.toContain('erosion');
  expect(event).not.toContain('https://');
});

it('changes a pasted agenda into paragraphs and extracts written dates as bullets', async () => {
  vi.stubEnv('MOHASSAN_EXTRACTIVE_WRITING', '1');
  const { start, search, readPage } = await harness();
  const agenda = userTexts.find(item => item.id === 'user-ar-meeting-agenda')!;
  const dates = userTexts.find(item => item.id === 'user-ar-survey-deadlines')!;
  const paragraph = await start(`حوّل النقاط إلى فقرات: ${agenda.text}`);
  const items = agenda.text.split('\n').filter(line => line.startsWith('- ')).map(line => line.slice(2));
  expect(items.length).toBeGreaterThan(1);
  expect(paragraph.text).not.toMatch(/^- /mu);
  for (const item of items) expect(paragraph.text).toContain(item);
  const dateList = await start(`استخرج التواريخ في نقاط: ${dates.text}`);
  const extracted = dateList.text.split('\n').map(line => line.replace(/^- /u, ''));
  expect(extracted.length).toBeGreaterThan(1);
  for (const date of extracted) expect(dates.text).toContain(date);
  expect(readPage).not.toHaveBeenCalled();
  expect(search).not.toHaveBeenCalled();
});

it('does not send URLs or instructions found inside supplied text to any tool', async () => {
  vi.stubEnv('MOHASSAN_EXTRACTIVE_WRITING', '1');
  const { start, readPage, search, inference } = await harness();
  // Corpus prose is human-authored. This case only adds a Markdown-format link to the unchanged excerpt.
  const { text } = await start(`Summarize this in 4 bullets: ${privateLetter.text}\n${photosynthesis.url}`);
  expect(text).toContain('Supplied text');
  expect(readPage).not.toHaveBeenCalled();
  expect(search).not.toHaveBeenCalled();
  expect(inference).not.toHaveBeenCalled();
});

it('reads a PDF through the guarded port and the owner-scoped document API', async () => {
  vi.stubEnv('MOHASSAN_EXTRACTIVE_WRITING', '1');
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const literal = photosynthesis.text.split('. ')[0] + '.';
  pdf.addPage().drawText(literal, { font, size: 9, x: 20, y: 730, maxWidth: 550 });
  const bytes = Buffer.from(await pdf.save());
  const url = new URL('/photosynthesis.pdf', photosynthesis.url).href;
  const document = { id: '00000000-0000-4000-8000-000000000001', name: 'photosynthesis.pdf', source: 'uploaded' as const,
    conversationId: null, size: bytes.length, hash: 'fixture', pages: 1, theme: null, createdAt: '2026-11-25T00:00:00.000Z' };
  const link = (id: string) => `http://localhost:3000/api/documents/${id}/content`;
  const content = vi.fn(async () => ({ document, name: document.name, bytes }));
  const remote = vi.fn<NonNullable<CommandChatConfig['readPage']>>(async (readUrl, signal, options) => {
    if (readUrl !== url || !options?.includePdf) return null;
    return readWritingPdf({ url, status: 200, headers: { 'content-type': 'application/pdf' }, body: bytes }, signal);
  });
  const { start, inference } = await harness({ readPage: remote, documents: { link, control: {
    content, list: async () => [document], readLocal: vi.fn(), create: vi.fn(), edit: vi.fn(), info: vi.fn(),
  } } });
  const web = await start(`Summarize ${url} in one line`);
  expect(web.text).toContain('Photosynthesis');
  expect(web.text).toContain(url);
  const local = await start(`Summarize ${link(document.id)} in one line`);
  expect(local.text).toContain('Photosynthesis');
  expect(local.text).toContain(link(document.id));
  expect(content).toHaveBeenCalledWith(owner, document.id);
  expect(remote).toHaveBeenCalledOnce();
  expect(inference).not.toHaveBeenCalled();
  const invalid = await readWritingPdf({ url, status: 200, headers: { 'content-type': 'application/pdf' }, body: Buffer.from(photosynthesis.text) }, new AbortController().signal);
  expect(invalid).toBeNull();
});

it('keeps translation and free composition on the original writer', () => {
  expect(writingTask('Translate this text', 'extractive')).toBeNull();
  expect(writingTask('Write an article', 'extractive')).toBeNull();
  expect(writingTask('Rewrite this text', 'extractive')).toBeNull();
  expect(writingTask('How do I work with Markdown?', 'extractive')).toBeNull();
  expect(writingTask('كيف أشغل المتصفح؟', 'extractive')).toBeNull();
});
