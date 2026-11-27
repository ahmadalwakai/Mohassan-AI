import { describe, expect, it } from 'vitest';
import { BrowserError, type AgentAction, type AgentElement, type AgentPage } from '@mohassan/browser';
import { describe as describeReply, excerpt, headlines, findSearchBox, findTarget, ordinalOf, parseHands, realUrl, relevantLines, resultLinks, runHands, readableText, webQuestion, WIKI_SEARCH, type HandsIO, type HandsPlan } from '../apps/server/src/assistant/hands.js';

const el = (ref: string, role: string, label: string, extra: Partial<AgentElement> = {}): AgentElement => ({ ref, role, label, inViewport: true, ...extra });
const pageOf = (url: string, elements: AgentElement[], text = ''): AgentPage => ({
  id: url, url, title: `Title of ${url}`, text, elements,
  signals: { captcha: false, password: false, otp: false, card: false },
  scroll: { top: 0, height: 1000, viewport: 800 }, hash: url, observedAt: '2026-11-20T00:00:00Z',
});

describe('parseHands', () => {
  it('reads open + search chains in Arabic and English', () => {
    expect(parseHands('افتح youtube وابحث عن تعليم الطبخ')).toEqual([
      { kind: 'open', url: 'https://www.youtube.com/', name: 'YouTube' },
      { kind: 'search', query: 'تعليم الطبخ', site: null },
    ]);
    expect(parseHands('ابحث في يوتيوب عن وصفة كبسة')).toEqual([{ kind: 'search', query: 'وصفة كبسة', site: { url: 'https://www.youtube.com/', name: 'YouTube' } }]);
    expect(parseHands('ابحث عن إطارات شتوية في amazon.co.uk')).toEqual([{ kind: 'search', query: 'إطارات شتوية', site: { url: 'amazon.co.uk', name: 'amazon.co.uk' } }]);
    expect(parseHands('search for winter tyres on amazon.co.uk then open the first result')).toEqual([
      { kind: 'search', query: 'winter tyres', site: { url: 'amazon.co.uk', name: 'amazon.co.uk' } },
      { kind: 'click', target: 'first result', ordinal: 1 },
    ]);
  });

  it('keeps a place name inside the query when it is not a site', () => {
    expect(parseHands('ابحث عن مطاعم في لندن')).toEqual([{ kind: 'search', query: 'مطاعم في لندن', site: null }]);
  });

  it('reads clicks, ordinals, typing, reading, scrolling and back', () => {
    expect(parseHands('اضغط على «تسجيل»')).toEqual([{ kind: 'click', target: 'تسجيل', ordinal: null }]);
    expect(parseHands('افتح النتيجة الثانية')).toEqual([{ kind: 'click', target: 'النتيجة الثانية', ordinal: 2 }]);
    expect(parseHands('افتح أول نتيجة ثم اقرأ الصفحة')).toEqual([{ kind: 'click', target: 'أول نتيجة', ordinal: 1 }, { kind: 'read', more: false }]);
    expect(parseHands('اكتب لندن في خانة المدينة')).toEqual([{ kind: 'type', text: 'لندن', field: 'المدينة' }]);
    expect(parseHands('اقرأ المزيد')).toEqual([{ kind: 'read', more: true }]);
    expect(parseHands('لخص الصفحة')).toEqual([{ kind: 'read', more: false }]);
    expect(parseHands('انزل')).toEqual([{ kind: 'scroll', up: false }]);
    expect(parseHands('ارجع')).toEqual([{ kind: 'back' }]);
  });

  it('leaves a lone open to the direct route and unclear requests to the old path', () => {
    expect(parseHands('افتح youtube')).toBeNull();
    expect(parseHands('ما رأيك في الطقس اليوم؟')).toBeNull();
    expect(parseHands('افتح youtube وقل لي نكتة')).toBeNull();
    expect(parseHands('ابحث في موقعي القديم عن شيء')).toBeNull();
    expect(parseHands('ادخل إلى حسابي')).toBeNull();
    expect(parseHands('افتح حسابي واعرض الرصيد')).toBeNull();
    expect(parseHands('افتح رابط الأسعار')).toEqual([{ kind: 'click', target: 'الأسعار', ordinal: null }]);
  });
});

describe('ordinals', () => {
  it('maps ordinal words and digits', () => {
    expect(ordinalOf('النتيجة الثالثة')).toBe(3);
    expect(ordinalOf('رقم 4')).toBe(4);
    expect(ordinalOf('first result')).toBe(1);
    expect(ordinalOf('الإعدادات')).toBeNull();
  });
});

describe('page matching', () => {
  const results = pageOf('https://html.duckduckgo.com/html/?q=x', [
    el('e1', 'link', 'Skip to main content', { href: 'https://html.duckduckgo.com/html/?q=x#main' }),
    el('e2', 'textbox', 'Search', { field: 'text' }),
    el('e3', 'link', 'Sponsored winter tyres deal', { href: 'https://duckduckgo.com/y.js?ad=1' }),
    el('e4', 'link', 'Winter tyres buying guide 2026', { href: 'https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fguide' }),
    el('e5', 'link', 'Best winter tyres tested', { href: 'https://tyres.example.com/best' }),
    el('e6', 'link', 'Winter tyres buying guide 2026', { href: 'https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fguide' }),
    el('e7', 'button', 'Next'),
  ]);

  it('lists real result links without ads, chrome or duplicates', () => {
    expect(resultLinks(results).map(item => item.url)).toEqual(['https://example.org/guide', 'https://tyres.example.com/best']);
    expect(realUrl('https://www.google.com/url?q=https://a.example/')).toBe('https://a.example/');
  });

  it('finds the search box and named or numbered targets', () => {
    expect(findSearchBox(results)?.ref).toBe('e2');
    expect(findTarget(results, { kind: 'click', target: 'second', ordinal: 2 })?.ref).toBe('e5');
    expect(findTarget(results, { kind: 'click', target: 'next', ordinal: null })?.ref).toBe('e7');
    expect(findTarget(results, { kind: 'click', target: 'missing thing', ordinal: null })).toBeUndefined();
  });

  it('quotes readable lines and continues from where it stopped', () => {
    const long = Array.from({ length: 40 }, (_, index) => `Line number ${index} of the article has enough words to read.`).join('\nMenu\n');
    const page = pageOf('https://a.example/', [], long);
    const first = excerpt(page, 0, 300);
    expect(first.lines.every(line => line.startsWith('Line number'))).toBe(true);
    expect(first.more).toBe(true);
    expect(excerpt(page, first.end, 300).lines[0]).not.toBe(first.lines[0]);
  });
});

const hit = (title: string, url: string, snippet = title) => ({ title, url, snippet });

/** `reads` are the pages the HTTP reader returns (or 'disallowed' for robots); a URL outside it is unreadable over HTTP. */
function fakeIO(pages: Record<string, AgentPage>, start: AgentPage | null, permits: Record<string, { url: string; method: 'GET' | 'POST' }> = {}, reads?: Record<string, AgentPage | 'disallowed'>) {
  let current = start;
  const log: string[] = [];
  const io: HandsIO = {
    ...(reads ? { read: async (url: string) => {
      log.push(`read:${url}`);
      const found = reads[url];
      return found === 'disallowed' ? { kind: 'disallowed' as const } : found ? { kind: 'page' as const, page: found } : { kind: 'unreadable' as const };
    } } : {}),
    page: async () => current,
    act: async (action: AgentAction) => {
      log.push(`${action.kind}:${action.text ?? action.ref}`);
      if (action.kind === 'open') current = pages[action.text!] ?? pageOf(action.text!, []);
      return current!;
    },
    prepare: async (action: AgentAction) => {
      const permit = permits[action.ref ?? ''];
      return permit ? { id: 'p', url: permit.url, method: permit.method, bodyHash: '', pageHash: '', actionHash: '', expiresAt: 0 } : null;
    },
    settle: async page => page,
    step: async label => { log.push(`step:${label}`); },
    // No real wait between two searches in tests (the engine's one-second provider spacing is the production reason).
    pause: async () => {},
    approve: async (_action, permit) => { log.push(`approve:${permit.url}`); },
    hold: async () => { log.push('hold'); },
  };
  return { io, log };
}

describe('runHands', () => {
  it('opens a site, submits its GET search form as an address, and lists results', async () => {
    const home = pageOf('https://shop.example/', [el('s', 'searchbox', 'Search the shop')]);
    const found = pageOf('https://shop.example/find?q=tyres', [el('r1', 'link', 'Winter tyre 205/55 R16', { href: 'https://shop.example/p/1' })]);
    const { io, log } = fakeIO({ 'shop.example': home, 'https://shop.example/find?q=tyres': found }, null, { s: { url: 'https://shop.example/find?q=tyres', method: 'GET' } });
    const plan: HandsPlan = { steps: parseHands('ابحث عن tyres في shop.example')!, next: 0 };
    const outcome = await runHands(plan, io);
    expect(log.filter(line => !line.startsWith('step:'))).toEqual(['open:shop.example', 'open:https://shop.example/find?q=tyres']);
    expect(outcome).toMatchObject({ kind: 'done', status: 'completed' });
    expect(outcome.kind === 'done' && outcome.text).toContain('[Winter tyre 205/55 R16](https://shop.example/p/1)');
  });

  it('pauses for approval on a POST form and resumes after it without repeating', async () => {
    const home = pageOf('https://bank.example/', [el('s', 'searchbox', 'Search')]);
    const { io, log } = fakeIO({ 'bank.example': home }, null, { s: { url: 'https://bank.example/search', method: 'POST' } });
    const plan: HandsPlan = { steps: parseHands('ابحث عن فروع في bank.example')!, next: 0 };
    expect(await runHands(plan, io)).toEqual({ kind: 'paused' });
    expect(log).toContain('approve:https://bank.example/search');
    expect(plan.next).toBe(plan.steps.length);
    expect(await runHands(plan, io)).toMatchObject({ kind: 'done' });
    expect(log.filter(line => line.startsWith('open:'))).toEqual(['open:bank.example']);
  });

  it('refuses to press a payment button and asks the owner instead', async () => {
    const shop = pageOf('https://shop.example/cart', [el('b', 'button', 'Buy now')]);
    const { io, log } = fakeIO({}, shop);
    const outcome = await runHands({ steps: parseHands('اضغط على Buy now')!, next: 0 }, io);
    expect(outcome).toMatchObject({ kind: 'done', status: 'partial' });
    expect(log.some(line => line.startsWith('click'))).toBe(false);
  });

  it('says plainly when no page is open', async () => {
    const { io } = fakeIO({}, null);
    expect(await runHands({ steps: parseHands('اقرأ الصفحة')!, next: 0 }, io)).toMatchObject({ kind: 'done', status: 'blocked' });
  });

  it('describes a read with quoted lines only', () => {
    const page = pageOf('https://a.example/', [], 'An article sentence that is long enough to keep.\nok');
    const { text } = describeReply({ steps: [{ kind: 'read', more: false }], next: 1, read: { url: page.url, start: 0, offset: 10 } }, page);
    expect(text).toContain('> An article sentence that is long enough to keep.');
    expect(text).not.toContain('> ok');
  });
});

describe('news', () => {
  it('reads news requests with an optional source and topic', () => {
    expect(parseHands('لخّص لي أهم أخبار اليوم')).toEqual([{ kind: 'news', source: { url: 'https://www.bbc.com/arabic', name: 'BBC News عربي' }, topic: '' }]);
    expect(parseHands('شو آخر الأخبار؟')).toMatchObject([{ kind: 'news', topic: '' }]);
    expect(parseHands('أخبار الجزيرة')).toMatchObject([{ kind: 'news', source: { name: 'الجزيرة نت' }, topic: '' }]);
    expect(parseHands('آخر أخبار الاقتصاد من سكاي نيوز')).toMatchObject([{ kind: 'news', source: { name: 'سكاي نيوز عربية' }, topic: 'الاقتصاد' }]);
    expect(parseHands("what's the news today")).toMatchObject([{ kind: 'news', source: { name: 'BBC News' }, topic: '' }]);
    expect(parseHands('اقرأ الخبر الثالث')).toEqual([{ kind: 'click', target: 'الخبر الثالث', ordinal: 3 }, { kind: 'read', more: false }]);
    expect(parseHands('هل تعتقد أن الأخبار اليوم تؤثر على أسعار الذهب في السوق المحلي')).toBeNull();
  });

  it('numbers front-page stories the same way for the reply and the follow-up', () => {
    const front = pageOf('https://www.bbc.com/arabic', [
      el('n1', 'link', 'BBC News World Service', { href: 'https://www.bbc.com/ws/languages' }),
      el('n0', 'link', 'كلا، أعدني إلى الإعدادات', { href: 'https://www.bbc.com/usingthebbc/cookies/how-can-i-change-my-bbc-cookie-settings/' }),
      el('n2', 'link', 'قوات الأمن تنتشر في المدينة بعد الأزمة', { href: 'https://www.bbc.com/arabic/articles/cwe9k84' }),
      el('n3', 'link', 'اتفاق جديد بين بريطانيا والاتحاد الأوروبي حول التجارة', { href: 'https://www.bbc.com/arabic/articles/c52e8r' }),
      el('n4', 'link', 'ارتفاع أسعار الذهب في الأسواق العالمية اليوم', { href: 'https://www.bbc.com/arabic/articles/cqy7rx' }),
    ]);
    expect(headlines(front).map(item => item.element.ref)).toEqual(['n2', 'n3', 'n4']);
    expect(findTarget(front, { kind: 'click', target: 'الخبر الثاني', ordinal: 2 })?.ref).toBe('n3');
    const all = describeReply({ steps: [{ kind: 'news', source: { url: front.url, name: 'BBC News عربي' }, topic: '' }], next: 1 }, front);
    expect(all.status).toBe('completed');
    expect(all.text).toContain('2. [اتفاق جديد بين بريطانيا والاتحاد الأوروبي حول التجارة](https://www.bbc.com/arabic/articles/c52e8r)');
    const topic = describeReply({ steps: [{ kind: 'news', source: { url: front.url, name: 'BBC News عربي' }, topic: 'الذهب' }], next: 1 }, front);
    expect(topic.text).toContain('3. [ارتفاع أسعار الذهب');
    expect(topic.text).not.toContain('1. [');
  });
});

describe('webQuestion', () => {
  const asks = (text: string) => webQuestion(text)?.[0];
  it('turns questions that need the web into a browser search, without the owner naming the browser', () => {
    for (const text of ['كم سعر الذهب اليوم؟', 'متى مباراة الهلال القادمة', 'شو الطقس في الرياض بكرة', 'سعر الدولار مقابل الجنيه المصري',
      'من هو رئيس وزراء بريطانيا الحالي؟', 'what is the weather in London today', 'latest iPhone price in the UK', 'who won the champions league final?']) {
      expect(asks(text), text).toMatchObject({ kind: 'search', site: null, ask: true });
    }
    expect(asks('كم سعر الذهب اليوم؟')).toMatchObject({ query: 'كم سعر الذهب اليوم' });
  });

  it('reads spoken lookups', () => {
    expect(asks('دورلي على أرخص رحلة من لندن لدبي')).toMatchObject({ query: 'أرخص رحلة من لندن لدبي', ask: true });
    expect(asks('شوفلي مواعيد صلاة الجمعة في مانشستر')).toMatchObject({ query: 'مواعيد صلاة الجمعة في مانشستر' });
  });

  it('leaves small talk, memory, Ads, the PC, code and arithmetic to their own paths', () => {
    for (const text of ['مرحبا', 'كيف حالك؟', 'من أنت؟', 'ماذا تستطيع أن تفعل؟', 'هل تتذكر اسم شركتي؟', 'ما هي ملاحظاتي عن العميل',
      'أنشئ حملة إعلانية لمخبزي', 'what campaigns do I have', 'ما النوافذ المفتوحة على جهازي؟', 'كم ملف في مشروع الخادم؟', '25 * 4?', 'hi', 'افتح bbc.com', 'شكرا']) {
      expect(webQuestion(text), text).toBeNull();
    }
  });
});

describe('search is the default', () => {
  const query = (text: string, earlier: string[] = []) => (webQuestion(text, earlier)?.[0] as { query?: string } | undefined)?.query ?? null;
  it('searches anything not on the finite not-the-web list, even one word or no question form', () => {
    expect(query('الطقس؟')).toBe('الطقس');
    expect(query('أفضل لابتوب للبرمجة 2026')).toBe('أفضل لابتوب للبرمجة 2026');
    expect(query('عاصمة أستراليا')).toBe('عاصمة أستراليا');
  });

  it('never searches reminders, arithmetic, writing, acknowledgements or a plain site open', () => {
    for (const text of ['ذكرني بموعد الطبيب بكرة', 'remind me to call Sam tomorrow', 'كم 5 ضرب 3', 'ترجم hello للعربي', 'اكتب لي إيميل لعميل', 'تمام', 'ok', 'افتح يوتيوب', 'افتح bbc.com']) {
      expect(webQuestion(text), text).toBeNull();
    }
  });

  it('carries the previous question topic into a follow-up', () => {
    expect(query('وكم سعره في مصر؟', ['كم سعر الذهب اليوم؟'])).toBe('كم سعره في مصر الذهب');
    expect(query('وفي الأردن؟', ['كم سعر الذهب اليوم', 'وكم سعره في مصر'])).toBe('في الأردن سعره الذهب');
    expect(query('وبكرة؟', ['الطقس في الرياض اليوم'])).toBe('بكرة الطقس الرياض');
    expect(query('what about Paris', ['what is the weather in London today'])).toBe('Paris weather');
    expect(query('كم عمره عندما مات', ['من هو مخترع الهاتف'])).toBe('كم عمره عندما مات مخترع الهاتف');
  });

  it('adds nothing when the previous message was not a web question, or the new one names its own topic', () => {
    expect(query('وكم سعره؟', ['شكرا'])).toBe('كم سعره');
    expect(query('وكم سعره؟', ['افتح bbc.com'])).toBe('كم سعره');
    expect(query('كم سعر الفضة اليوم', ['كم سعر الذهب اليوم'])).toBe('كم سعر الفضة اليوم');
  });
});

describe('question answers from the web', () => {
  it('uses shared web search and reads a topic-specific site before an encyclopedia result', async () => {
    const article = pageOf('https://www.nhs.uk/conditions/cataract-surgery/', [], 'Cataract surgery usually takes 20 to 45 minutes and is performed under local anaesthetic.');
    const previous = pageOf('https://en.wikipedia.org/wiki/Japan', [el('wiki-search', 'searchbox', 'Search Wikipedia')]);
    const { io, log } = fakeIO({ [article.url]: article }, previous);
    const queries: string[] = [];
    io.search = async query => {
      queries.push(query);
      return [
        { title: 'Cataract surgery', url: 'https://en.wikipedia.org/wiki/Cataract_surgery', snippet: 'Cataract surgery' },
        { title: 'Cataract surgery - NHS', url: article.url, snippet: 'How long cataract surgery takes' },
      ];
    };
    const outcome = await runHands({ steps: webQuestion('How long does cataract surgery take?')!, next: 0 }, io);
    expect(queries).toEqual(['How long does cataract surgery take']);
    expect(log.filter(line => !line.startsWith('step:'))).toEqual([`open:${article.url}`]);
    expect(outcome).toMatchObject({ kind: 'done', status: 'completed' });
    expect(outcome.kind === 'done' && outcome.text).toContain('20 to 45 minutes');
  });

  it('opens the requested shared-search result within a command chain', async () => {
    const first = 'https://tyres.example/guide', second = 'https://motoring.example/tyres';
    const { io, log } = fakeIO({ [first]: pageOf(first, []), [second]: pageOf(second, [], 'Winter tyres improve grip in colder weather and on snow.') }, null);
    io.search = async () => [
      { title: 'Winter tyres buying guide', url: first, snippet: 'Winter tyres' },
      { title: 'Winter tyres for cold weather', url: second, snippet: 'Winter tyres' },
    ];
    expect(await runHands({ steps: parseHands('search for winter tyres then open the second result')!, next: 0 }, io)).toMatchObject({ kind: 'done', status: 'completed' });
    // The search is a list over HTTP; only the chosen result opens in the browser.
    expect(log.filter(line => line.startsWith('open:'))).toEqual([`open:${second}`]);
  });

  it('lists the results and opens nothing when the search is a command, not a question', async () => {
    const { io, log } = fakeIO({}, null);
    io.search = async () => [hit('Winter tyres buying guide', 'https://tyres.example/guide'), hit('Winter tyres tested', 'https://motoring.example/tyres')];
    const outcome = await runHands({ steps: parseHands('ابحث عن winter tyres')!, next: 0 }, io);
    expect(log.filter(line => line.startsWith('open:'))).toEqual([]);
    expect(outcome).toMatchObject({ kind: 'done', status: 'completed' });
    expect(outcome.kind === 'done' && outcome.text).toContain('2. [Winter tyres tested](https://motoring.example/tyres)');
  });

  it('answers from an encyclopedia result over HTTP when it is the only relevant source', async () => {
    const article = pageOf('https://en.wikipedia.org/wiki/British_passport', [], 'UK passport renewal fees depend on whether you apply online or by post, and the fee is listed before you pay.');
    const { io, log } = fakeIO({}, null, {}, { [article.url]: article });
    io.search = async () => [hit('British passport', article.url, 'Passport fees')];
    const outcome = await runHands({ steps: webQuestion('UK passport renewal fees')!, next: 0 }, io);
    expect(log.filter(line => line.startsWith('open:'))).toEqual([]);
    expect(log).toContain(`read:${article.url}`);
    expect(outcome).toMatchObject({ kind: 'done', status: 'completed' });
    expect(outcome.kind === 'done' && outcome.text).toContain('depend on whether you apply online');
  });

  it("tries the subject's words alone when the question's own words find nothing", async () => {
    const steps = webQuestion('من هو ألبرت أينشتاين؟')!;
    // Served under another spelling («آينشتاين»), so opening the article by the question's own name finds nothing and the
    // search falls back to the subject's words alone, which is what this test is about.
    const main = new URL('https://ar.wikipedia.org/wiki/ألبرت_آينشتاين').href;
    const article = pageOf(main, [], 'ألبرت أينشتاين عالم فيزياء نظرية ألماني المولد، اشتهر بوضع النظرية النسبية التي غيرت فهم الزمان والمكان والجاذبية في القرن العشرين كله.');
    const queries: string[] = [];
    const { io, log } = fakeIO({}, null, {}, { [main]: article });
    io.search = async query => {
      queries.push(query);
      if (queries.length === 1) throw new BrowserError('RESEARCH_SEARCH_UNAVAILABLE', 'nothing', 502);
      return [hit('ألبرت أينشتاين', main)];
    };
    const outcome = await runHands({ steps, next: 0 }, io);
    expect(queries).toEqual(['من هو ألبرت أينشتاين', 'ألبرت أينشتاين']);
    expect(log.filter(line => line.startsWith('open:'))).toEqual([]);
    expect(outcome).toMatchObject({ kind: 'done', status: 'completed' });
    expect(outcome.kind === 'done' && outcome.text).toContain('النظرية النسبية');
  });

  it('never answers a changing fact from the encyclopedia', async () => {
    const steps = webQuestion('كم سعر الذهب اليوم؟')!;
    const gold = pageOf('https://ar.wikipedia.org/wiki/ذهب', [], 'سعر الذهب اليوم 300 ريال للغرام حسب هذه المقالة القديمة التي لا تتحدث مع السوق في أي وقت من الأوقات.');
    const { io, log } = fakeIO({}, null, {}, { [gold.url]: gold });
    io.search = async () => [hit('ذهب', gold.url, 'سعر الذهب')];
    const outcome = await runHands({ steps, next: 0 }, io);
    expect(log.some(line => line.includes('wikipedia.org'))).toBe(false);
    expect(outcome).toMatchObject({ kind: 'done', status: 'blocked' });
    expect(outcome.kind === 'done' && outcome.text).toContain('لم أتمكن من الوصول إلى مصدر حديث');
  });

  it('honors a Wikipedia exclusion before reading a subject and identifies the provider searched', async () => {
    const { io, log } = fakeIO({}, null, {}, {});
    const progress: string[] = [];
    io.progress = async label => { progress.push(label); };
    io.search = async (_query, _limit, plan, report) => {
      expect(plan.excludedSites).toContain('wikipedia.org');
      report({ searchedProviders: ['Fixture'], unavailableSites: [], unavailableDomains: [] });
      return [hit('France capital', 'https://en.wikipedia.org/wiki/France')];
    };
    const outcome = await runHands({ steps: webQuestion('What is the capital of France, not from Wikipedia?')!, next: 0 }, io);
    expect(outcome).toMatchObject({ kind: 'done', status: 'blocked' });
    expect(log.some(line => /^(read|open):.*wikipedia\.org/u.test(line))).toBe(false);
    expect(progress[0]).toContain('I searched Fixture because you excluded wikipedia.org');
  });

  it('keeps an explicit Wikipedia request on Wikipedia', async () => {
    const wiki = WIKI_SEARCH('اليابان');
    const { io, log } = fakeIO({ [wiki]: pageOf(wiki, [el('japan', 'link', 'اليابان', { href: 'https://ar.wikipedia.org/wiki/اليابان' })]) }, null);
    io.search = async () => { throw new Error('Explicit site search must not use general web search'); };
    expect(await runHands({ steps: parseHands('ابحث في ويكيبيديا عن اليابان')!, next: 0 }, io)).toMatchObject({ kind: 'done', status: 'completed' });
    expect(log.filter(line => line.startsWith('open:'))).toEqual([`open:${wiki}`]);
  });

  it('does not leak rejected or encoded secret queries to browser fallback', async () => {
    for (const query of ['Node API password=private-value', 'Node API password%3Dprivate-value 50%']) {
      const { io, log } = fakeIO({}, null);
      await expect(runHands({ steps: [{ kind: 'search', query, site: null }], next: 0 }, io)).rejects.toMatchObject({ code: 'RESEARCH_QUERY_SECRET' });
      expect(log.some(line => line.startsWith('open:'))).toBe(false);
    }
    const { io, log } = fakeIO({}, null);
    io.search = async () => { throw new BrowserError('RESEARCH_QUERY_INVALID', 'rejected query', 400); };
    await expect(runHands({ steps: webQuestion('UK passport fees')!, next: 0 }, io)).rejects.toMatchObject({ code: 'RESEARCH_QUERY_INVALID' });
    expect(log.some(line => line.startsWith('open:'))).toBe(false);
  });

  it('preserves cancellation instead of opening another engine', async () => {
    const { io, log } = fakeIO({}, null);
    const cancelled = new Error('RUN_TIME_LIMIT');
    io.search = async () => { throw cancelled; };
    await expect(runHands({ steps: webQuestion('UK passport fees')!, next: 0 }, io)).rejects.toBe(cancelled);
    expect(log.some(line => line.startsWith('open:'))).toBe(false);
  });

  it('searches over HTTP, reads the top result and quotes the sentences that answer, with the source', async () => {
    const article = pageOf('https://gold.example/sa', [], 'القائمة الرئيسية\nسعر غرام الذهب عيار 21 اليوم 312 ريال سعودي للبيع.\nتابعنا على وسائل التواصل الاجتماعي الخاصة بنا دائما.\nأسعار الذهب تتغير خلال اليوم بحسب حركة البورصة العالمية وسعر صرف الدولار أمام العملات المحلية في كل سوق.\n');
    const { io, log } = fakeIO({}, null, {}, { [article.url]: article });
    io.search = async () => [hit('سعر الذهب اليوم في السعودية لحظة بلحظة', article.url), hit('أسعار الذهب اليوم مباشر', 'https://prices.example/gold')];
    const plan: HandsPlan = { steps: webQuestion('كم سعر الذهب اليوم؟')!, next: 0 };
    const outcome = await runHands(plan, io);
    expect(log.filter(line => line.startsWith('open:'))).toEqual([]);
    expect(outcome).toMatchObject({ kind: 'done', status: 'completed' });
    const text = outcome.kind === 'done' ? outcome.text : '';
    expect(text.startsWith('سعر غرام الذهب عيار 21 اليوم 312 ريال سعودي للبيع.')).toBe(true);
    expect(text).toContain('**المصدر:** [gold.example — Title of https://gold.example/sa](https://gold.example/sa)');
    expect(text).toContain('[أسعار الذهب اليوم مباشر](https://prices.example/gold)');
    expect(text).not.toContain('%D8');
    expect(text).not.toContain('اقرأ الصفحة');
    expect(text).not.toContain('تابعنا');
  });

  it('moves to the next result when the first page does not answer, and lists results when none does', async () => {
    const query = 'weather in London today';
    const notice = 'We use cookies and similar technologies on this website to improve your experience and to show you relevant advertising; by continuing you agree to our use of them as described in our policy.';
    const empty = pageOf('https://a.example/london', [], notice);
    const answer = pageOf('https://b.example/london', [], 'Today in London the weather is cloudy with a high of 9C and light rain later.');
    const search = async () => [hit('London weather forecast - Met Office', empty.url), hit('London weather today hourly', answer.url)];
    const ok = fakeIO({}, null, {}, { [empty.url]: empty, [answer.url]: answer });
    ok.io.search = search;
    const found = await runHands({ steps: webQuestion(query)!, next: 0 }, ok.io);
    expect(found.kind === 'done' && found.text).toContain('high of 9C');
    expect(ok.log.filter(line => line.startsWith('open:'))).toEqual([]);
    const none = fakeIO({}, null, {}, { [empty.url]: empty, [answer.url]: pageOf(answer.url, [], notice) });
    none.io.search = search;
    const listed = await runHands({ steps: webQuestion(query)!, next: 0 }, none.io);
    expect(listed).toMatchObject({ kind: 'done', status: 'partial' });
    expect(listed.kind === 'done' && listed.text).toContain('2. [London weather today hourly](https://b.example/london)');
    expect(none.log.filter(line => line.startsWith('open:'))).toEqual([]);
  });

  it('opens a result in the hidden browser only when HTTP gives no readable text', async () => {
    const steps = webQuestion('ما عاصمة اليابان؟')!;
    const article = pageOf('https://japan.example/tokyo', [], 'اليابان دولة جزرية في شرق آسيا وعاصمتها طوكيو وهي أكبر مدنها.');
    // The site draws its text with JavaScript: the HTTP read comes back empty, so the browser opens that page.
    const { io, log } = fakeIO({ [article.url]: article }, null, {}, { [article.url]: pageOf(article.url, [], '') });
    io.search = async () => [hit('طوكيو عاصمة اليابان — دليل اليابان', article.url)];
    const outcome = await runHands({ steps, next: 0 }, io);
    expect(log).toContain(`read:${article.url}`);
    expect(log.filter(line => line.startsWith('open:'))).toEqual([`open:${article.url}`]);
    expect(outcome).toMatchObject({ kind: 'done', status: 'completed' });
    expect(outcome.kind === 'done' && outcome.text).toContain('وعاصمتها طوكيو');
  });

  it('skips a result that robots.txt disallows and reads the next one, without the browser', async () => {
    const steps = webQuestion('ما عاصمة اليابان؟')!;
    const closed = 'https://closed.example/japan', open = 'https://japan.example/tokyo';
    const article = pageOf(open, [], 'اليابان دولة جزرية في شرق آسيا وعاصمتها طوكيو وهي أكبر مدنها وأكثرها سكانًا بفارق كبير عن بقية مدن البلاد.');
    const { io, log } = fakeIO({}, null, {}, { [closed]: 'disallowed', [open]: article });
    io.search = async () => [hit('عاصمة اليابان', closed), hit('طوكيو عاصمة اليابان', open)];
    const outcome = await runHands({ steps, next: 0 }, io);
    expect(log.filter(line => line.startsWith('open:'))).toEqual([]);
    expect(outcome.kind === 'done' && outcome.text).toContain('وعاصمتها طوكيو');
    // The answer and its source come from the readable page; the closed one is at most a link for the owner to open.
    expect(outcome.kind === 'done' && outcome.text).toContain(`**المصدر:** [japan.example — Title of ${open}](${open})`);
    expect(log).not.toContain(`open:${closed}`);
  });

  it('answers from the result whose title names the topic, and adds a doctor note to a health question', async () => {
    const steps = webQuestion('كم تستغرق عملية المياه البيضاء؟')!;
    const water = 'https://water.example/supply', cataract = 'https://hospital.example/cataract';
    const waterPage = pageOf(water, [], 'تستغرق عملية تنقية المياه في المحطة 6 ساعات قبل وصولها إلى البيوت البيضاء.\n');
    const cataractPage = pageOf(cataract, [], 'تستغرق عملية إزالة المياه البيضاء عادة بين 15 و30 دقيقة تحت تخدير موضعي.\n');
    const { io, log } = fakeIO({}, null, {}, { [water]: waterPage, [cataract]: cataractPage });
    // The engine lists the water-supply page first; the title that names the subject is read first.
    io.search = async () => [hit('إمداد المياه', water), hit('المياه البيضاء', cataract)];
    const outcome = await runHands({ steps, next: 0 }, io);
    expect(log.filter(line => line.startsWith('open:'))).toEqual([]);
    const text = outcome.kind === 'done' ? outcome.text : '';
    expect(text.startsWith('تستغرق عملية إزالة المياه البيضاء عادة بين 15 و30 دقيقة')).toBe(true);
    expect(text).toContain('راجع طبيبًا مختصًا');
  });

  it('says so plainly when no result names the topic', async () => {
    const steps = webQuestion('ما أعراض المياه البيضاء في العين؟')!;
    const queries: string[] = [];
    const { io, log } = fakeIO({}, null, {}, {});
    // Nothing in the titles or snippets shares a topic word («مياه», «بيضاء», «عين»).
    io.search = async query => { queries.push(query); return [hit('إمداد الكهرباء في المدينة', 'https://power.example/city'), hit('السفر إلى الغردقة', 'https://travel.example/hurghada')]; };
    const outcome = await runHands({ steps, next: 0 }, io);
    // The question's words, then the subject's words alone; nothing names the topic, so the reply says so plainly.
    expect(queries).toEqual(['ما أعراض المياه البيضاء في العين', 'المياه البيضاء']);
    expect(log.filter(line => line.startsWith('open:'))).toEqual([]);
    expect(outcome).toMatchObject({ kind: 'done', status: 'blocked' });
    expect(outcome.kind === 'done' && outcome.text).toContain('لم أجد في المصادر المتاحة لي');
  });

  it('«اقرأ المزيد» opens the page the last answer was read from when no page is open', async () => {
    const url = 'https://japan.example/tokyo';
    const page = pageOf(url, [], Array.from({ length: 12 }, (_, index) => `الجملة رقم ${index} من المقال تحمل كلمات كافية لتكون نصًا مقروءًا في الصفحة.`).join('\n'));
    const { io, log } = fakeIO({ [url]: page }, null);
    const plan: HandsPlan = { steps: [{ kind: 'read', more: true }], next: 0, found: { url, title: 'طوكيو', lines: ['اليابان دولة جزرية.'] } };
    const outcome = await runHands(plan, io);
    expect(log.filter(line => line.startsWith('open:'))).toEqual([`open:${url}`]);
    expect(outcome).toMatchObject({ kind: 'done', status: 'completed' });
    expect(outcome.kind === 'done' && outcome.text).toContain('> الجملة رقم 0');
  });

  it('keeps the start of a long lead sentence when only its start names the subject', () => {
    // An encyclopedia's first sentence often runs past 40 words, with the subject's name only at its start.
    const lead = 'ألْبِرْت أينْشتاين (الألمانية: Albert Einstein) (1879 – 1955) عالم فيزياء نظرية ألماني المولد'
      + ' عرف بوضع نظريتين في النسبية غيرتا فهم الزمان والمكان والجاذبية في القرن العشرين، ونال جائزة نوبل في الفيزياء عن تفسير'
      + ' التأثير الكهروضوئي، وكتب مئات الأوراق في الميكانيكا الإحصائية والكم والكون، وعاش سنواته الأخيرة في الولايات المتحدة'
      + ' حيث عمل في معهد للدراسات المتقدمة وواصل البحث عن نظرية موحدة للمجالات حتى وفاته.\n'
      + 'ووقع على بيان مع الفيلسوف برتراند راسل الذي سلط الضوء على خطر الأسلحة النووية.\n'
      // A photo caption later in the article names the subject in full too.
      + 'ألبرت أينشتاين عام 1893 (14 عامًا).\n';
    const lines = relevantLines(pageOf('https://ar.wikipedia.org/wiki/x', [], lead), 'من هو ألبرت أينشتاين؟', 3, true);
    expect(lines[0]).toContain('عالم فيزياء نظرية');
    expect(lines[0].startsWith('ألبرت') || lines[0].startsWith('ألْبِرْت')).toBe(true);
  });

  it('answers a what-is question with the definition sentence, not a menu or heading question', () => {
    // A site's menu glued to its headings, a table of contents of questions, then the definition.
    const text = 'الذكاء الاصطناعي نظرة عامة المنتجات قصتنا العملاء الموارد مفاهيم الحوسبة السحابية الذكاء الاصطناعي ما المقصود بالذكاء الاصطناعي؟ '
      + 'ما تاريخ الذكاء الاصطناعي؟ما الفرق بين تعلم الآلة والذكاء الاصطناعي؟كيف يعمل الذكاء الاصطناعي اليوم؟ '
      + 'تتيح الشركة لعملائها دمج الذكاء الاصطناعي بسهولة لتعزيز الابتكار وتحسين تجربة العملاء. '
      + 'الذكاء الاصطناعي (AI) هو تقنية تمكن الآلات من أداء مهام حل المشكلات بطريقة تشبه البشر. '
      + 'يعمل الذكاء الاصطناعي على تمكين الشركات من اتخاذ قرارات أكثر ذكاء على نطاق واسع.';
    const lines = relevantLines(pageOf('https://example.com/ai', [], text), 'ما هو الذكاء الاصطناعي؟', 3, true);
    expect(lines[0]).toMatch(/^الذكاء الاصطناعي \(AI\) هو تقنية/u);
    expect(lines.some(line => /[؟?]$/u.test(line))).toBe(false);
    // The same in English.
    const en = 'Overview Products Learn Customers What is artificial intelligence? '
      + 'Companies can integrate artificial intelligence easily to improve their customer experience. '
      + 'Artificial intelligence (AI) is a technology that lets machines solve problems in a human-like way.';
    expect(relevantLines(pageOf('https://example.com/ai', [], en), 'What is artificial intelligence?', 3, true)[0]).toMatch(/^Artificial intelligence \(AI\) is a technology/u);
    // «X is really important» is a claim about X, not what X is.
    const leaf = 'Photosynthesis is really important for animals because it feeds the food chain. '
      + 'Photosynthesis is the process plants use to turn light, water and carbon dioxide into glucose and oxygen.';
    expect(relevantLines(pageOf('https://example.com/leaf', [], leaf), 'What is photosynthesis?', 3, true)[0]).toMatch(/^Photosynthesis is the process/u);
    // Without a definition, a sentence about the subject beats one that only mentions it in passing.
    const plain = 'This traps the light energy needed to make photosynthesis happen. '
      + 'Photosynthesis is really important for animals because it feeds the food chain.';
    expect(relevantLines(pageOf('https://example.com/leaf', [], plain), 'What is photosynthesis?', 3, true)[0]).toMatch(/^Photosynthesis is really/u);
  });

  it.each([
    'ما معنى الذكاء الاصطناعي؟',
    'ما المقصود بالذكاء الاصطناعي؟',
    'ما المقصود ب الذكاء الاصطناعي؟',
    'ماذا يعني الذكاء الاصطناعي؟',
  ])('ranks the definition first for the Arabic definition form %s', question => {
    const mention = 'تتيح الشركة لعملائها دمج الذكاء الاصطناعي بسهولة في منتجات متعددة.';
    const definition = 'الذكاء الاصطناعي هو تقنية تمكن الآلات من أداء مهام تشبه البشر.';
    const page = pageOf('https://example.com/ai', [], `${mention} ${definition}`);
    expect(relevantLines(page, question, 3, true)[0]).toBe(definition);
  });

  it.each([
    ['Green plants use light to make sugar!', 'This process is called photosynthesis.', 'photosynthesis'],
    ['Green plants use light to make sugar!', 'This process called photosynthesis.', 'photosynthesis'],
    ['Liquid water can turn into water vapour.', 'This process is known as evaporation.', 'evaporation'],
  ])('quotes an adjacent explanation and its naming sentence: %s %s', (explanation, naming, subject) => {
    const importance = `${subject[0].toUpperCase()}${subject.slice(1)} is really important for our planet.`;
    const page = pageOf('https://example.com/science', [], `${explanation} ${naming} ${importance}`);
    expect(relevantLines(page, `What is ${subject}?`, 3, true)[0]).toBe(`${explanation} ${naming}`);
  });

  it.each([
    ['How do green plants make their food?', 'This process is called photosynthesis.', []],
    ['Contents Products Resources Learn More Information.', 'This process is called photosynthesis.', []],
    ['How green plants use light to make sugar.', 'This process is called photosynthesis.', [el('toc', 'link', 'How green plants use light to make sugar')]],
    ['Green plants use light to make sugar!', 'This process is called respiration.', []],
  ])('does not form a definition pair from a question, contents or a different subject: %s', (previous, naming, elements) => {
    const importance = 'Photosynthesis is really important for our planet.';
    const page = pageOf('https://example.com/science', elements, `${previous} ${naming} ${importance}`);
    const lines = relevantLines(page, 'What is photosynthesis?', 3, true);
    expect(lines[0]).toBe(importance);
    expect(lines).not.toContain(`${previous} ${naming}`);
  });

  it("reads the subject's own article before a title that only repeats both question words", async () => {
    const steps = webQuestion('ما عاصمة أستراليا؟')!;
    const country = new URL('https://ar.wikipedia.org/wiki/أستراليا').href;
    const embassy = new URL('https://ar.wikipedia.org/wiki/سفارة_أستراليا_في_واشنطن_العاصمة').href;
    const article = { ...pageOf(country, [], 'أستراليا دولة ذات سيادة تضم البر الرئيسي للقارة وجزر كثيرة.\nتقع في نصف الكرة الجنوبي غرب المحيط الهادي، عاصمتها كانبرا.\nيبلغ عدد سكانها نحو ستة وعشرين مليون نسمة يعيش معظمهم على السواحل الشرقية والجنوبية الشرقية للقارة.\n'), title: 'أستراليا - ويكيبيديا' };
    const building = pageOf(embassy, [], 'سفارة أستراليا في واشنطن العاصمة مبنى دبلوماسي يقع على جادة ماساتشوستس ويضم مكاتب البعثة الأسترالية في الولايات المتحدة الأمريكية.');
    const { io, log } = fakeIO({}, null, {}, { [country]: article, [embassy]: building });
    // The engine lists the embassy first; the article whose title is the subject itself answers.
    io.search = async () => [hit('سفارة أستراليا في واشنطن العاصمة', embassy), hit('أستراليا', country)];
    const outcome = await runHands({ steps, next: 0 }, io);
    expect(log.filter(line => line.startsWith('open:'))).toEqual([]);
    expect(outcome.kind === 'done' && outcome.text).toContain('عاصمتها كانبرا');
    expect(outcome.kind === 'done' && outcome.text).toContain(`**المصدر:** [ويكيبيديا — أستراليا](${country})`);
  });

  it('reads the article for the whole subject before an article for part of it', async () => {
    const steps = webQuestion('ما هي الطاقة الشمسية؟')!;
    const energy = new URL('https://ar.wikipedia.org/wiki/طاقة').href;
    const solar = new URL('https://ar.wikipedia.org/wiki/طاقة_شمسية').href;
    const article = { ...pageOf(solar, [], 'الطاقة الشمسية هي الضوء والحرارة المنبعثان من الشمس اللذان يسخرهما الإنسان منذ القدم.\nتستعمل اليوم في توليد الكهرباء وتسخين المياه وتحلية مياه البحر في مناطق كثيرة من العالم.\n'), title: 'طاقة شمسية - ويكيبيديا' };
    const general = pageOf(energy, [], 'الطاقة كمية فيزيائية تقاس بالجول وتظهر في صور كثيرة منها الحركية والحرارية والكهربائية والكيميائية والشمسية أيضًا.');
    const { io, log } = fakeIO({}, null, {}, { [solar]: article, [energy]: general });
    io.search = async () => [hit('طاقة', energy), hit('طاقة شمسية', solar)];
    const outcome = await runHands({ steps, next: 0 }, io);
    expect(log.filter(line => line.startsWith('open:'))).toEqual([]);
    expect(outcome.kind === 'done' && outcome.text).toContain('الضوء والحرارة المنبعثان من الشمس');
  });

  it('reads the page title as the implied subject of its sentences', () => {
    // «عاصمتها كانبرا» never repeats «أستراليا»: the article itself is the subject.
    const text = 'أستراليا دولة ذات سيادة تضم البر الرئيسي للقارة وجزيرة تسمانية والعديد من الجزر الأصغر.\n'
      + '[ا] تقع في نصف الكرة الجنوبي غرب المحيط الهادي، عاصمتها كانبرا.\n'
      + 'نيو ساوث ويلز ولاية في الشرق وعاصمتها سيدني.\n';
    const page = { ...pageOf('https://ar.wikipedia.org/wiki/x', [], text), title: 'أستراليا - ويكيبيديا' };
    // A lettered footnote mark («[ا]») is not part of the quoted answer.
    expect(relevantLines(page, 'ما عاصمة أستراليا؟', 3, true)[0]).toMatch(/^تقع .*عاصمتها كانبرا/u);
    // A place named after the phrase («إقليم عاصمة أستراليا») does not outrank «عاصمتها كانبرا».
    const named = { ...page, text: 'يضم البرلمان ممثلين عن الولايات وعن إقليم عاصمة أستراليا والإقليم الشمالي.\n' + text };
    expect(relevantLines(named, 'ما عاصمة أستراليا؟', 3, true)[0]).toContain('عاصمتها كانبرا');
    // A title word alone never makes every sentence an answer.
    expect(relevantLines(page, 'أستراليا', 3, true).join(' ')).not.toContain('سيدني');
  });

  it('separates the lead sentence from the infobox that ends right before it', () => {
    // The browser folds a Wikipedia page onto one line: the infobox's closing edit links touch the first sentence.
    const text = 'من ويكيبيديا، الموسوعة الحرة ألبرت أينشتاين (بالألمانية: Albert Einstein) ألبرت أينشتاين في سنة 1921. ألبرت أينشتاين معلومات شخصية الميلاد 14 مارس 1879 أولم سبب الشهرة نظرية النسبية'
      + ' الموقع الرسمي تعديل مصدري - تعديل ألْبِرْت أينْشتاين (1879 – 1955) عالم فيزياء نظرية ألماني المولد اشتهر بنظريتي النسبية.'
      + ' ووقع على بيان مع الفيلسوف برتراند راسل عن خطر الأسلحة النووية.';
    const lines = relevantLines(pageOf('https://ar.wikipedia.org/wiki/x', [], text), 'من هو ألبرت أينشتاين؟', 3, true);
    expect(lines[0]).toMatch(/^ألْبِرْت أينْشتاين .*عالم فيزياء نظرية/u);
    expect(lines.join(' ')).not.toContain('معلومات شخصية');
    // The infobox photo caption names the subject too, but it is not an answer.
    expect(lines.join(' ')).not.toContain('في سنة 1921');
  });

  it('gives no answer to a how-long question from a page with no number', () => {
    const text = 'عملية المياه البيضاء تزيل العدسة المعتمة وتضع عدسة صناعية مكانها.\n';
    expect(relevantLines(pageOf('https://ar.wikipedia.org/wiki/x', [], text), 'كم تستغرق عملية المياه البيضاء؟', 3, true)).toEqual([]);
    expect(relevantLines(pageOf('https://ar.wikipedia.org/wiki/x', [], text), 'ما هي عملية المياه البيضاء؟', 3, true)).toHaveLength(1);
  });

  it('searches the topic without its place part and skips reference lines', () => {
    expect(WIKI_SEARCH('ما أعراض المياه البيضاء في العين؟')).toBe(`https://ar.wikipedia.org/w/index.php?search=${encodeURIComponent('المياه البيضاء')}&fulltext=1&ns0=1`);
    const text = 'المياه البيضاء في العين قديمة جدا نسخة محفوظة 8 أبريل 2009 على موقع واي باك مشين.\nمن أعراض المياه البيضاء في العين تشوش الرؤية وصعوبة القراءة.\n';
    expect(relevantLines(pageOf('https://ar.wikipedia.org/wiki/x', [], text), 'ما أعراض المياه البيضاء في العين؟', 3, true)).toEqual(['من أعراض المياه البيضاء في العين تشوش الرؤية وصعوبة القراءة.']);
  });

  it('drops the Wikipedia toolbar, redirect note and review banner when the tagline is missing', () => {
    const text = 'الساد 92 لغة مقالة نقاش اقرأ عدّل تاريخ حفظ أدوات المظهر أخف النص صغير قياسي كبير اللون تلقائي فاتح داكن (بالتحويل من المياه البيضاء) هذه المقالة بحاجة لمراجعة خبير مختص في مجالها. يؤدي الساد إلى تعتم عدسة العين.';
    expect(readableText(text).trim()).toBe('يؤدي الساد إلى تعتم عدسة العين.');
  });

  it('does not lead with an infobox run or with dates for a question that wants no number', () => {
    const text = 'تلقائي فاتح داكن ليزك عملية جراحة ليزك باستعمال ليزر إكسيمر في مركز طبي معلومات عامة الاختصاص طب العيون وتصحيح البصر من أنواع التخثير بالليزر وإجراء طبي تعديل مصدري تعديل المدة دقائق و 11 ثواني وكلمات أخرى كثيرة من الجدول الجانبي للصفحة حتى يطول السطر جدا ويتجاوز الحد\n'
      + 'الليزك هو عملية جراحية لتصحيح النظر تعيد تشكيل قرنية العين بالليزر.\n';
    const lines = relevantLines(pageOf('https://ar.wikipedia.org/wiki/lasik', [], text), 'ما هي عملية الليزك؟', 3, true);
    expect(lines[0]).toBe('الليزك هو عملية جراحية لتصحيح النظر تعيد تشكيل قرنية العين بالليزر.');
  });

  it('does not answer a live question when the engine has no live source: it says so instead, and asks once', async () => {
    for (const question of ['كم سعر الذهب اليوم؟', 'what is the weather in London today']) {
      const steps = webQuestion(question)!;
      const queries: string[] = [];
      const { io, log } = fakeIO({}, null, {}, {});
      io.search = async query => { queries.push(query); throw new BrowserError('RESEARCH_SEARCH_UNAVAILABLE', 'nothing', 502); };
      const outcome = await runHands({ steps, next: 0 }, io);
      // A changing fact is not retried with its subject words alone: an encyclopedia would answer with old figures.
      expect(queries).toHaveLength(1);
      expect(log.filter(line => line.startsWith('open:'))).toEqual([]);
      expect(outcome).toMatchObject({ kind: 'done', status: 'blocked' });
      expect(outcome.kind === 'done' && outcome.text).toMatch(/لم أتمكن من الوصول إلى مصدر حديث|could not reach a current source/);
    }
  });

  it('skips Wikipedia menus, footers, navigation boxes and infobox runs when quoting', () => {
    const text = 'Speed of light 136 languages Article Talk Read View source View history Tools From Wikipedia, the free encyclopedia '
      + 'Exact value metres per second 299792458 Approximate values kilometres per hour 1080000000 miles per second 186000 one light-year 1.0 year one parsec 3.26 years from the nearest star to Sun 4.2 years across the Milky Way 87400 years from the Andromeda Galaxy to Earth 2.5 million years The speed of light is the speed of electromagnetic waves. '
      + 'The speed of light in vacuum is a universal physical constant exactly equal to 299792458 metres per second. '
      + 'Physicsعدلعدل المصدر Light speed matters in physics. show v t e Speed of light portal show Light articles. Categories: Speed of light Fundamental constants';
    const lines = relevantLines(pageOf('https://en.wikipedia.org/wiki/Speed_of_light', [], text), 'What is the speed of light?');
    expect(lines).toContain('The speed of light in vacuum is a universal physical constant exactly equal to 299792458 metres per second.');
    expect(lines.join(' ')).not.toMatch(/languages Article Talk|Categories:|portal|^5 million/);
    expect(readableText('ب من ويكيبيديا، الموسوعة الحرة تعد العاصمة طوكيو. تصنيفات: دول')).toBe(' تعد العاصمة طوكيو. ');
  });

  it('quotes only sentences sharing the question words', () => {
    const page = pageOf('https://x.example/', [], 'Home News Sport\nThe price of gold rose to 2,400 dollars an ounce today.\nSubscribe to our newsletter for more updates now.\n');
    expect(relevantLines(page, 'what is the gold price today?')).toEqual(['The price of gold rose to 2,400 dollars an ounce today.']);
  });

  it('does not answer a documentation overview with traceback fragments matching module filenames', () => {
    const overview = 'Python pathlib documentation describes classes representing filesystem paths for different operating systems.';
    const traceback = 'py\') Traceback (most recent call last): File "<stdin>", line 1, in <module> File "/home/antoine/cpython/default/Lib/pathlib.';
    const page = pageOf('https://docs.python.org/3/library/pathlib.html', [], `${overview}\n${traceback}\nwith_stem(\'\') ${traceback}`);
    expect(relevantLines(page, 'Python pathlib documentation', 3, true)).toEqual([overview]);
    expect(relevantLines(pageOf(page.url, [], traceback), 'Python pathlib documentation')).toEqual([]);
    expect(relevantLines(pageOf(page.url, [], traceback), 'Python pathlib traceback').join(' ')).toContain('Traceback');
  });

  it('matches an Arabic technical release question against literal English version evidence', () => {
    const release = 'Download the latest stable Node version v24.11.1 LTS for your operating system.';
    const page = pageOf('https://nodejs.org/en/download', [], `${release}\nNode is a JavaScript runtime for developing applications.`);
    const english = relevantLines(page, 'Node.js latest stable version', 3, true);
    expect(english).toEqual([release]);
    expect(relevantLines(page, 'ما هو آخر إصدار مستقر من Node.js', 3, true)).toEqual(english);
    expect(relevantLines(page, 'ما هو أحدث إصدار مستقر من Node.js', 3, true)).toEqual(english);
    expect(relevantLines(pageOf(page.url, [], 'Node is the latest stable version available for download.'), 'ما هو آخر إصدار مستقر من Node.js')).toEqual([]);
  });

  it('puts first the sentence with the question phrase and the newest year', () => {
    const text = 'كان عدد اليهود في المغرب يصل إلى 265,000 نسمة عام 1948، إلا أنه انخفض حاليا إلى حوالي 5,500 نسمة من مجموع السكان.\n'
      + 'وحسب إحصاء سنة 2014، يبلغ عدد سكان المغرب 33848242.\n'
      + 'وحسب إحصاء سنة 2024، يبلغ عدد سكان المغرب ما يقارب 37 مليون نسمة بزيادة 8 في المائة مقارنة بنتائج إحصاء عام 2014.\n';
    const lines = relevantLines(pageOf('https://ar.wikipedia.org/wiki/x', [], text), 'كم عدد سكان المغرب؟', 3, true);
    expect(lines[0]).toContain('إحصاء سنة 2024');
    expect(lines[1]).toContain('إحصاء سنة 2014');
  });
});
