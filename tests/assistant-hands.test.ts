import { describe, expect, it } from 'vitest';
import type { AgentAction, AgentElement, AgentPage } from '@mohassan/browser';
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

function fakeIO(pages: Record<string, AgentPage>, start: AgentPage | null, permits: Record<string, { url: string; method: 'GET' | 'POST' }> = {}) {
  let current = start;
  const log: string[] = [];
  const io: HandsIO = {
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
  it('searches, opens the top result and quotes the sentences that answer, with the source', async () => {
    const query = 'كم سعر الذهب اليوم';
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const results = pageOf(searchUrl, [
      el('r1', 'link', 'سعر الذهب اليوم في السعودية لحظة بلحظة', { href: 'https://gold.example/sa' }),
      el('r2', 'link', 'أسعار الذهب اليوم مباشر', { href: 'https://prices.example/gold' }),
    ]);
    const article = pageOf('https://gold.example/sa', [], 'القائمة الرئيسية\nسعر غرام الذهب عيار 21 اليوم 312 ريال سعودي للبيع.\nتابعنا على وسائل التواصل الاجتماعي الخاصة بنا دائما.\n');
    const { io, log } = fakeIO({ [searchUrl]: results, 'https://gold.example/sa': article }, null);
    const plan: HandsPlan = { steps: webQuestion('كم سعر الذهب اليوم؟')!, next: 0 };
    const outcome = await runHands(plan, io);
    expect(log.filter(line => line.startsWith('open:'))).toEqual([`open:${searchUrl}`, 'open:https://gold.example/sa']);
    expect(outcome).toMatchObject({ kind: 'done', status: 'completed' });
    const text = outcome.kind === 'done' ? outcome.text : '';
    expect(text).toContain('> سعر غرام الذهب عيار 21 اليوم 312 ريال سعودي للبيع.');
    expect(text).toContain('المصدر: https://gold.example/sa');
    expect(text).toContain('[أسعار الذهب اليوم مباشر](https://prices.example/gold)');
    expect(text).not.toContain('تابعنا');
  });

  it('moves to the next result when the first page does not answer, and lists results when none does', async () => {
    const query = 'weather in London today';
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const results = pageOf(searchUrl, [
      el('r1', 'link', 'London weather forecast - Met Office', { href: 'https://a.example/london' }),
      el('r2', 'link', 'London weather today hourly', { href: 'https://b.example/london' }),
    ]);
    const empty = pageOf('https://a.example/london', [], 'Accept cookies to continue.');
    const answer = pageOf('https://b.example/london', [], 'Today in London the weather is cloudy with a high of 9C and light rain later.');
    const ok = fakeIO({ [searchUrl]: results, 'https://a.example/london': empty, 'https://b.example/london': answer }, null);
    const found = await runHands({ steps: webQuestion(query)!, next: 0 }, ok.io);
    expect(found.kind === 'done' && found.text).toContain('high of 9C');
    const none = fakeIO({ [searchUrl]: results, 'https://a.example/london': empty, 'https://b.example/london': empty }, null);
    const listed = await runHands({ steps: webQuestion(query)!, next: 0 }, none.io);
    expect(listed).toMatchObject({ kind: 'done', status: 'partial' });
    expect(listed.kind === 'done' && listed.text).toContain('2. [London weather today hourly](https://b.example/london)');
  });

  it('falls back to Wikipedia when the search engine shows a human check, without pausing', async () => {
    const steps = webQuestion('ما عاصمة اليابان؟')!;
    const query = steps.find(step => step.kind === 'search')!.kind === 'search' ? (steps[0] as { query: string }).query : '';
    const duck = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const check = pageOf(duck, [], 'Unfortunately, bots use DuckDuckGo too. Please complete the following challenge.');
    const wiki = WIKI_SEARCH(query);
    expect(wiki).toBe(`https://ar.wikipedia.org/w/index.php?search=${encodeURIComponent('عاصمة اليابان')}&fulltext=1&ns0=1`);
    const results = pageOf(wiki, [
      el('m', 'link', 'الصفحة الرئيسية', { href: 'https://ar.wikipedia.org/wiki/%D8%A7%D9%84%D8%B5%D9%81%D8%AD%D8%A9_%D8%A7%D9%84%D8%B1%D8%A6%D9%8A%D8%B3%D9%8A%D8%A9' }),
      el('h', 'link', 'مساعدة', { href: 'https://ar.wikipedia.org/wiki/%D9%85%D8%B3%D8%A7%D8%B9%D8%AF%D8%A9:Search' }),
      el('r1', 'link', 'اليابان', { href: 'https://ar.wikipedia.org/wiki/%D8%A7%D9%84%D9%8A%D8%A7%D8%A8%D8%A7%D9%86' }),
    ]);
    const article = pageOf('https://ar.wikipedia.org/wiki/%D8%A7%D9%84%D9%8A%D8%A7%D8%A8%D8%A7%D9%86', [], 'اليابان دولة جزرية في شرق آسيا وعاصمتها طوكيو وهي أكبر مدنها.\nتعديل المصدر\n');
    const settled: string[] = [];
    const { io, log } = fakeIO({ [duck]: check, [wiki]: results, [article.url]: article }, null);
    io.settle = async page => { settled.push(page.url); return page; };
    const outcome = await runHands({ steps, next: 0 }, io);
    expect(settled).not.toContain(duck);
    expect(log.filter(line => line.startsWith('open:'))).toEqual([`open:${duck}`, `open:${wiki}`, `open:${article.url}`]);
    expect(outcome).toMatchObject({ kind: 'done', status: 'completed' });
    expect(outcome.kind === 'done' && outcome.text).toContain('وعاصمتها طوكيو');

    // DuckDuckGo's other refusal: an error page with no results also moves to Wikipedia.
    const error = pageOf(duck, [el('m', 'link', 'email us', { href: 'mailto:error-lite@duckduckgo.com' })], 'If this persists, please email us.');
    const second = fakeIO({ [duck]: error, [wiki]: results, [article.url]: article }, null);
    const after = await runHands({ steps: webQuestion('ما عاصمة اليابان؟')!, next: 0 }, second.io);
    expect(second.log.filter(line => line.startsWith('open:'))).toEqual([`open:${duck}`, `open:${wiki}`, `open:${article.url}`]);
    expect(after.kind === 'done' && after.text).toContain('وعاصمتها طوكيو');
  });

  it('does not answer a live question from Wikipedia when the engine refuses: it says so instead', async () => {
    for (const question of ['كم سعر الذهب اليوم؟', 'what is the weather in London today']) {
      const steps = webQuestion(question)!;
      const query = (steps.find(step => step.kind === 'search') as { query: string }).query;
      const duck = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const { io, log } = fakeIO({ [duck]: pageOf(duck, [], 'If this persists, please email us.') }, null);
      const outcome = await runHands({ steps, next: 0 }, io);
      expect(log.filter(line => line.startsWith('open:'))).toEqual([`open:${duck}`]);
      expect(outcome).toMatchObject({ kind: 'done', status: 'blocked' });
      expect(outcome.kind === 'done' && outcome.text).toMatch(/لن أعطيك رقمًا قديمًا|won't give you an old number/);
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
});
