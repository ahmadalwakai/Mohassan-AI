import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentBrowser, SearchHit, SearchOutcome, SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import { answerSubject, isFollowUp, lacksSubject, parseHands, refersBack, returnedTo, webQuestion, workQuestion } from '../apps/server/src/assistant/hands.js';
import { shorterAnswer, shorterRequest } from '../apps/server/src/assistant/answer-reshape.js';
import { fullerName } from '../apps/server/src/assistant/return-to.js';

/**
 * A conversation that goes on (2026-11-23): follow-ups with no subject, a return to an earlier subject, the subject a list
 * page answered with, «اشرح أكثر», and «اختصر جوابك». The failures they fix were measured in one 19-turn conversation on
 * 8fb5737 (artifacts/conversation-quality-2026-11-23/long-before). Pages and wordings below are this test's own.
 */
describe('follow-ups with no subject of their own', () => {
  it('a question word and an event verb lean on the conversation', () => {
    for (const text of ['متى توفي؟', 'أين ولد؟', 'ومتى نشرت؟', 'من اخترع؟', 'هل تزوج؟']) {
      expect(lacksSubject(text), text).toBe(true);
      expect(isFollowUp(text), text).toBe(true);
      expect(refersBack(text), text).toBe(true);
    }
    for (const text of ['متى توفي أينشتاين؟', 'ما هو أطول نهر في العالم؟', 'متى', 'كم عدد سكان مصر؟']) expect(lacksSubject(text), text).toBe(false);
  });

  it('take the subject named before them', () => {
    expect(webQuestion('متى توفي؟', ['ألبرت أينشتاين'])?.[0]).toMatchObject({ kind: 'search', query: expect.stringContaining('ألبرت أينشتاين') });
    expect(webQuestion('ومتى نشرت؟', ['البؤساء'])?.[0]).toMatchObject({ query: expect.stringContaining('البؤساء') });
  });

  it('a return to an earlier subject asks the question about it', () => {
    expect(returnedTo('ارجع إلى أينشتاين: أين ولد؟')).toBe('أين ولد أينشتاين');
    expect(returnedTo('بالعودة إلى النيل، كم طوله؟')).toBe('كم طوله النيل');
    expect(returnedTo('back to Einstein: where was he born?')).toBe('where was he born Einstein');
    expect(returnedTo('ما عاصمة مصر؟')).toBeNull();
    // A browser command after the comma is not a question about an earlier subject.
    expect(returnedTo('ارجع إلى الصفحة الرئيسية، ثم اضغط على الأخبار')).toBeNull();
    expect(webQuestion('ارجع إلى أينشتاين: أين ولد؟')?.[0]).toMatchObject({ query: 'أين ولد أينشتاين' });
    expect(fullerName('أينشتاين', ['احسب', 'ألبرت أينشتاين', 'هرمان أينشتاين'])).toBe('ألبرت أينشتاين');
    expect(fullerName('النيل', ['نهر'])).toBeNull();
  });

  it('«من كتب رواية البؤساء؟» is asked as what the work is, whose article names its author', () => {
    expect(workQuestion('من كتب رواية البؤساء؟')).toBe('البؤساء');
    expect(workQuestion('من هو مؤلف كتاب الأيام؟')).toBe('الأيام');
    expect(workQuestion('من ألّف مسرحية هاملت')).toBe('هاملت');
    expect(workQuestion('من كتب؟')).toBeNull();
    expect(workQuestion('من هو ألبرت أينشتاين؟')).toBeNull();
    expect(webQuestion('من كتب رواية البؤساء؟')?.[0]).toMatchObject({ query: 'البؤساء' });
  });

  it('the subject of an answer read from a list page is the item it named', () => {
    expect(answerSubject({ title: 'نهر', lines: ['نهر النيل: أطول أنهار العالم.'] })).toBe('نهر النيل');
    expect(answerSubject({ title: 'ألبرت أينشتاين - ويكيبيديا', lines: ['ألبرت أينشتاين عالم فيزياء.'] })).toBe('ألبرت أينشتاين');
    // A label that is not about the page's subject is not taken.
    expect(answerSubject({ title: 'نهر', lines: ['ملاحظة: هذه الصفحة عن الأنهار.'] })).toBe('نهر');
  });
});

describe('«اشرح أكثر» and «اختصر جوابك»', () => {
  it('«اشرح أكثر» reads more of the last answer’s page', () => {
    for (const text of ['اشرح أكثر', 'وضح بالتفصيل', 'أريد تفاصيل أكثر', 'زدني', 'tell me more', 'Explain more.']) expect(parseHands(text), text).toEqual([{ kind: 'read', more: true }]);
    expect(parseHands('اشرح لي الطاقة الشمسية')).toBeNull();
  });

  it('recognises a request to shorten the previous answer, and only that', () => {
    expect(shorterRequest('اختصر جوابك السابق في جملة واحدة')).toEqual({ sentences: 1, lang: 'ar' });
    expect(shorterRequest('لخّصه في جملتين')).toEqual({ sentences: 2, lang: 'ar' });
    expect(shorterRequest('باختصار')).toEqual({ sentences: 1, lang: 'ar' });
    expect(shorterRequest('make it shorter')).toEqual({ sentences: 1, lang: 'en' });
    expect(shorterRequest('summarize that in two sentences')).toEqual({ sentences: 2, lang: 'en' });
    for (const text of ['لخص لي أهم أخبار اليوم', 'لخص الخبر الثالث', 'اختصر المسافة إلى العمل', 'summarize this article about solar power']) expect(shorterRequest(text), text).toBeNull();
  });

  it('quotes the previous answer’s opening sentence with its source', () => {
    const previous = 'الذكاء الاصطناعي هو فرع من علم الحاسوب. يدرس الآلات التي تحاكي التفكير.\n\n**تفاصيل أخرى من نفس المصدر:**\n- جملة أخرى طويلة بما يكفي لتكون تفصيلًا.\n\n'
      + '**المصدر:** [ويكيبيديا — ذكاء اصطناعي](https://ar.wikipedia.org/wiki/x) · قُرئت 2026-11-23 01:15 UTC';
    expect(shorterAnswer(previous, { sentences: 1, lang: 'ar' })).toBe('الذكاء الاصطناعي هو فرع من علم الحاسوب.\n\n**المصدر:** [ويكيبيديا — ذكاء اصطناعي](https://ar.wikipedia.org/wiki/x) · قُرئت 2026-11-23 01:15 UTC');
    expect(shorterAnswer('37 * 24 = 888', { sentences: 1, lang: 'ar' })).toBe('37 * 24 = 888');
  });
});

describe('a conversation that goes on, through the real chat controller', () => {
  const OWNER = 'isolated-follow-up-owner';
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let control: Awaited<ReturnType<typeof createCommandChatControl>>;
  const queries: string[] = [];
  const reads: string[] = [];
  const wiki = (title: string) => `https://ar.wikipedia.org/wiki/${encodeURIComponent(title.replaceAll(' ', '_'))}`;
  // Mock pages from PR #13, retrieved 2026-11-27.
  // https://github.com/ahmadalwakai/Mohassan-AI/pull/13/files
  const founderClaim = 'تجدر الإشارة أن بيل غيتس وبول ألين هما المؤسسان والملاك لهذه الشركة قبل أن تصبح من الشركات العامة.';
  const foundingClaim = 'تأسست شركة مايكروسوفت العملاقة من قبل بيل غيتس وبول ألين في 4 أبريل 1975 لتطوير برمجيات الحاسوب.';
  const birthClaim = 'وُلد بيل غيتس في 28 أكتوبر 1955 في سياتل بولاية واشنطن.';
  const pages: Record<string, { title: string; text: string }> = {
    [wiki('ألبرت أينشتاين')]: { title: 'ألبرت أينشتاين - ويكيبيديا', text: 'ألبرت أينشتاين (14 مارس 1879 – 18 أبريل 1955) عالم فيزياء نظرية ألماني المولد اشتهر بنظرية النسبية.\nولد ألبرت أينشتاين في مدينة أولم الألمانية لعائلة يهودية.\nتوفي ألبرت أينشتاين في برينستون في 18 أبريل 1955.\n' },
    // His father's page names him too: searched as «أينشتاين» alone, the live search put it first (long-final turn 11).
    [wiki('هرمان أينشتاين')]: { title: 'هرمان أينشتاين - ويكيبيديا', text: 'هرمان أينشتاين (1847 – 1902) رائد أعمال ألماني ولد في باد بوخاو، وهو والد ألبرت أينشتاين.\n' },
    [wiki('نهر')]: { title: 'نهر - ويكيبيديا', text: 'النهر مجرى مائي عذب يجري على سطح الأرض.\nنهر النيل: أطول أنهار العالم.\nنهر الدانوب: أطول نهر في أوروبا طوله 2860 كم.\n' },
    [wiki('نهر النيل')]: { title: 'نهر النيل - ويكيبيديا', text: 'نهر النيل أطول أنهار العالم ويجري في شمال شرق أفريقيا.\nيبلغ طول نهر النيل نحو 6650 كم من منابعه إلى مصبه في البحر المتوسط.\n' },
    [wiki('مايكروسوفت')]: { title: 'مايكروسوفت - ويكيبيديا', text: `${founderClaim}
${foundingClaim}
` },
    [wiki('بيل غيتس')]: { title: 'بيل غيتس - ويكيبيديا', text: `${birthClaim}
` },
  };
  const hitsFor = (query: string): SearchHit[] => /بيل غيتس/u.test(query)
    ? [{ title: 'بيل غيتس', url: wiki('بيل غيتس'), snippet: birthClaim }]
    : /مايكروسوفت/u.test(query) ? [{ title: 'مايكروسوفت', url: wiki('مايكروسوفت'), snippet: founderClaim }]
    : /البرت|ألبرت/u.test(query)
    ? [{ title: 'ألبرت أينشتاين', url: wiki('ألبرت أينشتاين'), snippet: 'عالم فيزياء' }]
    : /اينشتاين|أينشتاين/u.test(query)
    ? [{ title: 'هرمان أينشتاين', url: wiki('هرمان أينشتاين'), snippet: 'رائد أعمال' }, { title: 'ألبرت أينشتاين', url: wiki('ألبرت أينشتاين'), snippet: 'عالم فيزياء' }]
    : /النيل/u.test(query) ? [{ title: 'نهر النيل', url: wiki('نهر النيل'), snippet: 'أطول أنهار العالم' }]
    : /نهر/u.test(query) ? [{ title: 'نهر', url: wiki('نهر'), snippet: 'مجرى مائي' }] : [];

  beforeAll(async () => {
    database = await createDatabase();
    await migrate(database.db);
    const browser = { setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; }, async close() {} } as unknown as AgentBrowser;
    const searchProvider: SearchProvider & { execute(query: string): Promise<SearchOutcome> } = {
      name: 'isolated-follow-up-search',
      async search(query) { queries.push(query); return hitsFor(query); },
      async execute(query) {
        queries.push(query);
        return { hits: hitsFor(query).map((hit, at) => ({ ...hit, providers: ['isolated'], score: 10 - at, sourceRank: at })), fetchedAt: new Date().toISOString(),
          freshness: 'fresh', coverage: 'specialized_sources', limitations: [], failures: [] } as unknown as SearchOutcome;
      },
    };
    control = await createCommandChatControl(database.db, {
      browser, models: { fast: [], deep: [], vision: '' }, searchProvider, recordExperiences: false,
      readPage: async url => { reads.push(url); const page = pages[url]; return page ? { url, title: page.title, text: page.text, status: 200 } : null; },
    });
  });
  afterAll(async () => { await control?.shutdown(); await database?.close(); });
  beforeEach(() => { queries.length = 0; reads.length = 0; });
  afterEach(() => vi.unstubAllEnvs());

  async function turn(text: string, id?: string) {
    const conversation = id ? (await control.send(OWNER, id, { text }), id) : (await control.create(OWNER, { goal: text })).id;
    await control.settled(conversation);
    const detail = await control.detail(OWNER, conversation);
    return { id: conversation, reply: detail.messages.filter(message => message.role === 'assistant').at(-1)?.text ?? '' };
  }

  it('«متى توفي؟» after Einstein answers about Einstein', async () => {
    const first = await turn('من هو ألبرت أينشتاين؟');
    expect(first.reply).toContain('عالم فيزياء');
    // The second search must wait out the engine's provider spacing in production; the stub has none.
    const next = await turn('متى توفي؟', first.id);
    expect(queries.some(query => query.includes('أينشتاين'))).toBe(true);
    expect(next.reply).toContain('1955');
  });

  it('uses the first founder named in the previous answer for a biographical follow-up', async () => {
    const first = await turn('من هو مؤسس شركة مايكروسوفت؟');
    expect(first.reply).toContain('بيل غيتس');
    expect(first.reply).toContain('بول ألين');
    queries.length = 0;
    const next = await turn('متى ولد؟', first.id);
    expect(queries).toContain('متى ولد بيل غيتس');
    expect(next.reply).toContain(birthClaim);
  });

  it.each(['كم عمره؟', 'كم عمرها؟'])('looks up the founder by name for %s', async (request) => {
    const first = await turn('من هو مؤسس شركة مايكروسوفت؟');
    expect(first.reply).toContain('بيل غيتس');
    queries.length = 0;
    await turn(request, first.id);
    expect(queries).toContain('كم عمر بيل غيتس');
  });

  it('keeps the company as the subject of a founding-date follow-up', async () => {
    const first = await turn('من هو مؤسس شركة مايكروسوفت؟');
    expect(first.reply).toContain('بيل غيتس');
    queries.length = 0;
    const next = await turn('متى تأسست؟', first.id);
    expect(queries).toContain('متى تأسست مايكروسوفت');
    expect(next.reply).toContain(foundingClaim);
  });

  it.each(['off', 'decide'])('looks up the named river for «وكم طوله؟» with conversation shadow %s', async shadow => {
    vi.stubEnv('MOHASSAN_CONVERSATION_SHADOW', shadow);
    const first = await turn('ما هو أطول نهر في العالم؟');
    expect(first.reply).toContain('نهر النيل');
    queries.length = 0;
    reads.length = 0;
    const next = await turn('وكم طوله؟', first.id);
    expect(queries.join(' | ')).toContain('النيل');
    expect(reads).toContain(wiki('نهر النيل'));
    expect(reads).not.toContain(wiki('نهر'));
    expect(next.reply).toContain('6650');
    expect(next.reply).not.toContain('الدانوب');
  });

  it('«ارجع إلى أينشتاين: أين ولد؟» asks about Albert Einstein by the name the conversation read, and is not refused', async () => {
    const first = await turn('من هو ألبرت أينشتاين؟');
    await turn('احسب 2 + 2', first.id);
    queries.length = 0;
    const back = await turn('ارجع إلى أينشتاين: أين ولد؟', first.id);
    expect(queries.some(query => query.includes('ألبرت أينشتاين'))).toBe(true);
    expect(back.reply).toContain('أولم');
    expect(back.reply).not.toContain('هرمان');
    expect(back.reply).not.toContain('لم أبحث في الويب');
  });

  it('«اختصر جوابك السابق في جملة واحدة» quotes the first sentence of the last answer', async () => {
    const first = await turn('احسب 37 * 24');
    const next = await turn('اختصر جوابك السابق في جملة واحدة', first.id);
    expect(next.reply).toBe(first.reply);
    const empty = await turn('اختصر جوابك السابق');
    expect(empty.reply).toContain('لا يوجد في هذه المحادثة جواب سابق');
  });
});
