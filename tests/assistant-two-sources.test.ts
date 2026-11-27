import { describe, expect, it } from 'vitest';
import type { AgentAction, AgentPage } from '@mohassan/browser';
import { aspectSubject, entityWords, isOwnArticle, namesEntity, runHands, webQuestion, type HandsIO, type HandsPlan } from '../apps/server/src/assistant/hands.js';

/** Plan §7.4: a figure comes with a second source when one was read; both are shown when they differ. */
// The engine normalizes result URLs (`new URL(...).href`), so pages are keyed by that form.
const pageOf = (address: string, title: string, text: string): AgentPage => {
  const url = new URL(address).href;
  return {
    id: url, url, title, text, elements: [], signals: { captcha: false, password: false, otp: false, card: false },
    scroll: { top: 0, height: 1000, viewport: 800 }, hash: url, observedAt: '2026-11-22T05:00:00.000Z',
  };
};
const by = (...pages: AgentPage[]) => Object.fromEntries(pages.map(page => [page.url, page]));
// Engine hits need a topic word in their title or snippet, as real ones do. `hits` may answer per query.
type Hit = { title: string; url: string; snippet?: string };
function io(pages: Record<string, AgentPage>, hits: Hit[] | ((query: string) => Hit[]), searched: string[] = []): HandsIO {
  return {
    page: async () => null,
    search: async (query: string) => { searched.push(query); return (Array.isArray(hits) ? hits : hits(query)).map(hit => ({ ...hit, snippet: hit.snippet ?? hit.title })); },
    read: async url => pages[url] ? { kind: 'page', page: pages[url] } : { kind: 'unreadable' },
    act: async (action: AgentAction) => pages[action.text ?? ''] ?? pageOf(action.text ?? 'https://none.example/', '', ''),
    prepare: async () => null,
    settle: async page => page,
    step: async () => {},
    pause: async () => {},
    approve: async () => {},
    hold: async () => {},
  };
}
const text = (outcome: Awaited<ReturnType<typeof runHands>>) => outcome.kind === 'done' ? outcome.text : '';

describe('two sources for a figure', () => {
  it('tells the subject of an attribute question from the attribute', () => {
    expect(entityWords('كم عدد سكان مصر؟')).toEqual(['مصر']);
    expect(entityWords('ما عاصمة أستراليا')).toEqual(['استراليا']);
    expect(entityWords('What is the population of Egypt?')).toEqual(['egypt']);
    // No attribute word: the whole topic is the subject, and no subject lookup is needed.
    expect(entityWords('كم تستغرق عملية المياه البيضاء؟')).toEqual([]);
    expect(entityWords('ما هي الطاقة الشمسية')).toEqual([]);
    expect(isOwnArticle('مصر - ويكيبيديا', ['مصر'])).toBe(true);
    expect(isOwnArticle('المغرب', ['مغرب'])).toBe(true);
    expect(isOwnArticle('القصير (مصر)', ['مصر'])).toBe(false);
    expect(isOwnArticle('عرب', ['مصر'])).toBe(false);
    // Measured 2026-11-22: the subject lookup for «مصر» also returned «.مصر», the country's internet domain.
    expect(isOwnArticle('.مصر - ويكيبيديا', ['مصر'])).toBe(false);
    expect(isOwnArticle('Guinea-Bissau - Wikipedia', ['guinea-bissau'])).toBe(true);
    expect(namesEntity('انخفض عدد سكان المدينة إلى نحو 1500 نسمة', ['مصر'], false)).toBe(false);
    expect(namesEntity('يبلغ عدد سكان مصر نحو 105 ملايين نسمة', ['مصر'], false)).toBe(true);
    expect(namesEntity('يبلغ عدد سكانها نحو 105 ملايين نسمة', ['مصر'], true)).toBe(true);
  });

  it('answers a subject-attribute question from the subject’s own article, opened by its name', async () => {
    // What the shared engine returned on 2026-11-22 for «كم عدد سكان مصر»: a town's page and a people's page, not «مصر».
    const town = pageOf('https://ar.wikipedia.org/wiki/القصير_(مصر)', 'القصير (مصر) - ويكيبيديا', 'القصير مدينة مصرية على البحر الأحمر. انخفض عدد سكان المدينة بصورة ملحوظة إلى نحو 1500 نسمة بعد مرحلة الازدهار.');
    const arabs = pageOf('https://ar.wikipedia.org/wiki/عرب', 'عرب - ويكيبيديا', 'العرب مجموعة عرقية. يصل عدد هذه الدول إلى 22 دولة، مصر أكثرها سكانًا، والبحرين أقلها.');
    const egypt = pageOf('https://ar.wikipedia.org/wiki/مصر', 'مصر - ويكيبيديا', 'مصر دولة عربية. يبلغ عدد سكانها نحو 105 ملايين نسمة بحسب تقديرات 2024. وعاصمتها القاهرة.');
    const searched: string[] = [];
    const engine = (query: string): Hit[] => query === 'مصر' ? [{ title: egypt.title, url: egypt.url }] : [{ title: town.title, url: town.url }, { title: arabs.title, url: arabs.url }];
    const outcome = await runHands({ steps: webQuestion('كم عدد سكان مصر؟')!, next: 0, lang: 'ar' }, io(by(town, arabs, egypt), engine, searched));
    // The article is opened at ar.wikipedia.org/wiki/مصر while the search runs: no second search.
    expect(searched).toEqual(['كم عدد سكان مصر']);
    expect(outcome).toMatchObject({ kind: 'done', status: 'completed' });
    expect(text(outcome).split('\n')[0]).toBe('يبلغ عدد سكانها نحو 105 ملايين نسمة بحسب تقديرات 2024.');
    // Citation marks with spaces inside the brackets are not part of the answer (measured on «المغرب»).
    const moroccoArticle = pageOf('https://ar.wikipedia.org/wiki/المغرب', 'المغرب - ويكيبيديا', 'المغرب دولة في شمال أفريقيا. [ 5 ] [ 28 ] ويبلغ عدد سكانها نحو 37 مليون نسمة، وعاصمتها الرباط.');
    const marked = await runHands({ steps: webQuestion('كم عدد سكان المغرب؟')!, next: 0, lang: 'ar' }, io(by(moroccoArticle), [{ title: moroccoArticle.title, url: moroccoArticle.url }]));
    expect(text(marked).split('\n')[0]).toBe('ويبلغ عدد سكانها نحو 37 مليون نسمة، وعاصمتها الرباط.');
    expect(text(outcome)).toContain('**المصدر:** [ويكيبيديا — مصر](https://ar.wikipedia.org/wiki/%D9%85%D8%B5%D8%B1)');
    // Neither other page is about Egypt's population, so neither is a second source; the reply says the figure was not checked.
    expect(text(outcome)).not.toMatch(/مصدر ثانٍ (?:يؤكد|يختلف)/u);
    expect(text(outcome)).toContain('لم أتحقق من هذا الرقم في مصدر ثانٍ.');
    // Without the subject's article, a sentence about another place is not passed off as the answer.
    const without = await runHands({ steps: webQuestion('كم عدد سكان مصر؟')!, next: 0, lang: 'ar' }, io(by(town, arabs), [{ title: town.title, url: town.url }, { title: arabs.title, url: arabs.url }]));
    expect(without).toMatchObject({ kind: 'done', status: 'partial' });
    expect(text(without)).not.toContain('1500');
    // A village named after its country («صباح (المغرب)») is not the country, even when its sentence repeats the name.
    const village = pageOf('https://ar.wikipedia.org/wiki/صباح_(المغرب)', 'صباح (المغرب) - ويكيبيديا', 'صباح قرية مغربية. بلغ مجموع عدد سكان صباح (المغرب) حسب إحصاءات 2004 حوالي 12912 نسمة يعيشون في 2229 أسرة.');
    const morocco = await runHands({ steps: webQuestion('كم عدد سكان المغرب؟')!, next: 0, lang: 'ar' }, io(by(village), [{ title: village.title, url: village.url }]));
    expect(morocco).toMatchObject({ kind: 'done', status: 'partial' });
    expect(text(morocco)).not.toContain('12912');
    // A page about the subject's attribute («التركيبة السكانية في مصر») may answer, and its sentence may use a pronoun for Egypt.
    const demography = pageOf('https://ar.wikipedia.org/wiki/التركيبة_السكانية_في_مصر', 'التركيبة السكانية في مصر - ويكيبيديا', 'التركيبة السكانية في مصر. بلغ عدد سكان مصر 105 ملايين نسمة في 2024 بحسب الجهاز المركزي للتعبئة العامة والإحصاء.');
    const fromDemography = await runHands({ steps: webQuestion('كم عدد سكان مصر؟')!, next: 0, lang: 'ar' }, io(by(town, demography), [{ title: town.title, url: town.url }, { title: demography.title, url: demography.url }]));
    expect(fromDemography).toMatchObject({ kind: 'done', status: 'completed' });
    expect(text(fromDemography).split('\n')[0]).toContain('105 ملايين');
  });

  it('looks the person up when the search returned only relatives: «من هو ألبرت أينشتاين» is not his son', async () => {
    // What the shared search returned on 2026-11-22 for the question, and for the bare name.
    const son = pageOf('https://ar.wikipedia.org/wiki/إدوارد_ألبرت_أينشتاين', 'إدوارد ألبرت أينشتاين - ويكيبيديا', 'إدوارد ألبرت أينشتاين (28 يوليو 1910 - 25 أكتوبر 1965) هو الابن الثاني لألبرت أينشتاين وميلفا ماريك.');
    const albert = pageOf('https://ar.wikipedia.org/wiki/ألبرت_أينشتاين', 'ألبرت أينشتاين - ويكيبيديا', 'ألبرت أينشتاين (14 مارس 1879 – 18 أبريل 1955) عالم فيزياء نظرية ألماني المولد، اشتهر بالنظرية النسبية.');
    const searched: string[] = [];
    const engine = (query: string): Hit[] => query === 'ألبرت أينشتاين'
      ? [{ title: albert.title, url: albert.url }, { title: son.title, url: son.url }]
      : [{ title: son.title, url: son.url, snippet: 'هو الابن الثاني لألبرت أينشتاين' }];
    const outcome = await runHands({ steps: webQuestion('من هو ألبرت أينشتاين؟')!, next: 0, lang: 'ar' }, io(by(son, albert), engine, searched));
    expect(searched).toEqual(['من هو ألبرت أينشتاين']);
    expect(text(outcome).split('\n')[0]).toContain('عالم فيزياء نظرية');
    expect(text(outcome)).toContain(`](${albert.url})`);
    // When the search already holds the person's own article, nothing more is looked up.
    const direct: string[] = [];
    await runHands({ steps: webQuestion('من هو ألبرت أينشتاين؟')!, next: 0, lang: 'ar' }, io(by(son, albert), [{ title: albert.title, url: albert.url }, { title: son.title, url: son.url }], direct));
    expect(direct).toEqual(['من هو ألبرت أينشتاين']);
  });

  it('reads an aspect only from a page about its subject: green tea’s benefits are not pomegranate molasses’', async () => {
    expect(aspectSubject('ما فوائد الشاي الأخضر؟')).toEqual(['شاي', 'اخضر']);
    expect(aspectSubject('ما أعراض المياه البيضاء في العين؟')).toEqual(['مياه', 'بيضاء']);
    expect(aspectSubject('What are the benefits of green tea?')).toEqual(['green', 'tea']);
    expect(aspectSubject('ما عاصمة فرنسا؟')).toEqual([]);
    // Measured in the full runs since 04:48 on 2026-11-22 (rq030): the search returned «دبس الرمان», which mentions green tea.
    const molasses = pageOf('https://ar.wikipedia.org/wiki/دبس_الرمان', 'دبس الرمان - ويكيبيديا', 'يحتوي دبس الرمان على تركيز عالٍ من مضادات الأكسدة التي تفوق الموجودة في الشاي الأخضر، وله فوائد متعددة.');
    const tea = pageOf('https://ar.wikipedia.org/wiki/شاي_أخضر', 'شاي أخضر - ويكيبيديا', 'الشاي الأخضر نوع من الشاي. من فوائد الشاي الأخضر أن شاربيه أقل إصابة بأمراض القلب بحسب دراسات عدة.');
    const searched: string[] = [];
    const engine = (query: string): Hit[] => query === 'الشاي الأخضر'
      ? [{ title: tea.title, url: tea.url }]
      : [{ title: molasses.title, url: molasses.url, snippet: 'فوائد الشاي الأخضر' }];
    const outcome = await runHands({ steps: webQuestion('ما فوائد الشاي الأخضر؟')!, next: 0, lang: 'ar' }, io(by(molasses, tea), engine, searched));
    expect(searched).toEqual(['ما فوائد الشاي الأخضر', 'الشاي الأخضر']);
    expect(text(outcome).split('\n')[0]).toBe('من فوائد الشاي الأخضر أن شاربيه أقل إصابة بأمراض القلب بحسب دراسات عدة.');
    // Without a page about green tea, the molasses page is not quoted.
    const alone = await runHands({ steps: webQuestion('ما فوائد الشاي الأخضر؟')!, next: 0, lang: 'ar' }, io(by(molasses), [{ title: molasses.title, url: molasses.url, snippet: 'فوائد الشاي الأخضر' }]));
    expect(alone).toMatchObject({ kind: 'done', status: 'partial' });
    expect(text(alone)).not.toContain('دبس الرمان على تركيز');
  });

  it('opens the subject by its name even when Wikipedia’s title differs, and takes no other page’s line before it', async () => {
    // Measured 2026-11-22: ar.wikipedia.org/wiki/المياه_البيضاء serves the article «الساد» (cataract), not the film «مياه بيضاء».
    const film = pageOf('https://ar.wikipedia.org/wiki/مياه_بيضاء', 'مياه بيضاء - ويكيبيديا', 'مياه بيضاء فيلم دراما نيجيري صدر سنة 2007 عن المياه البيضاء في الأنهار.');
    const cataract = { ...pageOf('https://ar.wikipedia.org/wiki/المياه_البيضاء', 'الساد - ويكيبيديا', 'الساد أو المياه البيضاء عتامة في عدسة العين. من أعراض المياه البيضاء ضبابية الرؤية وصعوبة الرؤية الليلية.') };
    const searched: string[] = [];
    const outcome = await runHands({ steps: webQuestion('ما أعراض المياه البيضاء في العين؟')!, next: 0, lang: 'ar' },
      io(by(film, cataract), [{ title: film.title, url: film.url, snippet: 'المياه البيضاء' }], searched));
    expect(searched).toEqual(['ما أعراض المياه البيضاء في العين']);
    expect(text(outcome).split('\n')[0]).toBe('من أعراض المياه البيضاء ضبابية الرؤية وصعوبة الرؤية الليلية.');
    expect(text(outcome)).toContain('[ويكيبيديا — الساد]');
  });

  it('looks the subject up for any attribute: a capital from an embassy page becomes the country’s own line', async () => {
    // Measured in the full run of 2026-11-22 07:06: «ما عاصمة فرنسا» had been answered from an embassy page.
    const embassy = pageOf('https://ar.wikipedia.org/wiki/سفارة_فرنسا_في_واشنطن', 'سفارة فرنسا في واشنطن العاصمة - ويكيبيديا', 'السفارة الفرنسية القديمة في واشنطن العاصمة سنة 1917.');
    const france = pageOf('https://ar.wikipedia.org/wiki/فرنسا', 'فرنسا - ويكيبيديا', 'فرنسا دولة في غرب أوروبا. عاصمتها وأكبر مدنها هي باريس، ولغتها الرسمية هي الفرنسية.');
    const searched: string[] = [];
    const engine = (query: string): Hit[] => query === 'فرنسا' ? [{ title: france.title, url: france.url }] : [{ title: embassy.title, url: embassy.url }];
    const outcome = await runHands({ steps: webQuestion('ما عاصمة فرنسا؟')!, next: 0, lang: 'ar' }, io(by(embassy, france), engine, searched));
    expect(searched).toEqual(['ما عاصمة فرنسا']);
    expect(text(outcome).split('\n')[0]).toBe('عاصمتها وأكبر مدنها هي باريس، ولغتها الرسمية هي الفرنسية.');
  });

  it('quotes the second page when its figure differs, and names it when it agrees', async () => {
    const first = pageOf('https://ar.wikipedia.org/wiki/مصر', 'مصر - ويكيبيديا', 'مصر دولة عربية. يبلغ عدد سكان مصر نحو 105 ملايين نسمة في 2024. وعاصمتها القاهرة.');
    const differing = pageOf('https://stats.example/egypt', 'عدد سكان مصر 2024 - stats.example', 'عدد سكان مصر 104.5 ملايين نسمة في 2024 بحسب الجهاز المركزي للإحصاء.');
    // A title made only of the question's words would be read first as the subject's own article; this one is not.
    const agreeing = pageOf('https://facts.example/egypt', 'إحصاءات سكان مصر - facts.example', 'يبلغ عدد سكان مصر 105.3 مليون نسمة في 2024 بحسب التقديرات.');
    const differs = await runHands({ steps: webQuestion('كم عدد سكان مصر؟')!, next: 0, lang: 'ar' },
      io(by(first, differing), [{ title: first.title, url: first.url }, { title: differing.title, url: differing.url }]));
    expect(differs).toMatchObject({ kind: 'done', status: 'completed' });
    expect(text(differs).split('\n')[0]).toContain('105 ملايين');
    expect(text(differs)).toContain(`**مصدر ثانٍ يختلف:** «${differing.text}» — [stats.example — ${differing.title}](${differing.url})`);
    const plan: HandsPlan = { steps: webQuestion('كم عدد سكان مصر؟')!, next: 0, lang: 'ar' };
    const agrees = await runHands(plan,
      io(by(first, agreeing), [{ title: first.title, url: first.url }, { title: agreeing.title, url: agreeing.url }]));
    expect(agrees).toMatchObject({ kind: 'done', status: 'completed' });
    expect(text(agrees)).toContain(`**مصدر ثانٍ يؤكد:** [facts.example — ${agreeing.title}](${agreeing.url})`);
    expect(text(agrees)).not.toContain('يختلف');
    expect(plan.found?.second?.agrees).toBe(true);
  });

  it.each([
    ['بلغ عدد سكان مصر 5 آلاف نسمة في 2024 بحسب التقديرات.', 'مصدر ثانٍ يختلف'],
    ['بلغ عدد سكان مصر 5 ملايين نسمة عام 2010 بحسب التقديرات.', 'مصدر ثانٍ يذكر رقماً لعام آخر'],
  ])('quotes %s under the appropriate second-source label', async (line, label) => {
    const first = pageOf('https://ar.wikipedia.org/wiki/مصر', 'مصر - ويكيبيديا', 'بلغ عدد سكان مصر 5 ملايين نسمة في 2024 بحسب التقديرات.');
    const other = pageOf('https://facts.example/egypt', 'إحصاءات سكان مصر - facts.example', line);
    const plan: HandsPlan = { steps: webQuestion('كم عدد سكان مصر؟')!, next: 0, lang: 'ar' };
    const outcome = await runHands(plan, io(by(first, other), [first, other]));
    expect(text(outcome)).toContain(`**${label}:** «${line}» — [facts.example — ${other.title}](${other.url})`);
    expect(text(outcome)).not.toContain('مصدر ثانٍ يؤكد');
    expect(plan.found?.second?.agrees).toBe(false);
  });

  it.each([
    ['بلغ عدد سكان مصر 5 ملايين نسمة في 2024 بحسب التقديرات.', 'بلغ عدد سكان مصر 5 ملايين نسمة بحسب التقديرات.', 'لم يذكر المصدر الثاني الفترة.'],
    ['بلغ عدد سكان مصر 5 ملايين نسمة بحسب التقديرات.', 'بلغ عدد سكان مصر 5 ملايين نسمة في 2024 بحسب التقديرات.', 'لم يذكر المصدر الأول الفترة.'],
  ])('qualifies agreement when one source omits the period (%s)', async (firstLine, otherLine, note) => {
    const first = pageOf('https://ar.wikipedia.org/wiki/مصر', 'مصر - ويكيبيديا', firstLine);
    const other = pageOf('https://facts.example/egypt', 'إحصاءات سكان مصر - facts.example', otherLine);
    const plan: HandsPlan = { steps: webQuestion('كم عدد سكان مصر؟')!, next: 0, lang: 'ar' };
    const outcome = await runHands(plan, io(by(first, other), [first, other]));
    expect(text(outcome)).toContain(`**مصدر ثانٍ يذكر رقماً موافقاً:** [facts.example — ${other.title}](${other.url}) ${note}`);
    expect(text(outcome)).not.toContain('مصدر ثانٍ يؤكد');
    expect(plan.found?.second?.agrees).toBe(false);
  });

  it.each([
    ['بلغ عدد سكان مصر 5 آلاف نسمة.', '**مصدر ثانٍ يختلف:**'],
    ['يشير التقدير إلى عام 2024.', 'لم أتحقق من هذا الرقم في مصدر ثانٍ.'],
  ])('rechecks a saved agreement before displaying %s', async (line, note) => {
    const steps = webQuestion('كم عدد سكان مصر؟')!;
    const plan: HandsPlan = {
      steps, next: steps.length, results: [], lang: 'ar',
      found: {
        url: 'https://first.example/egypt', title: 'سكان مصر', lines: ['بلغ عدد سكان مصر 5 ملايين نسمة.'],
        second: { url: 'https://second.example/egypt', title: 'تقديرات سكان مصر', line, agrees: true },
      },
    };
    const outcome = await runHands(plan, io({}, []));
    expect(text(outcome)).toContain(note);
    expect(text(outcome)).not.toContain('مصدر ثانٍ يؤكد');
  });

  it('compares a lone year as a date for a date question', async () => {
    const steps = webQuestion('متى تأسست الجامعة؟')!;
    const plan: HandsPlan = {
      steps, next: steps.length, results: [], lang: 'ar',
      found: {
        url: 'https://first.example/university', title: 'الجامعة', lines: ['تأسست الجامعة عام 1952.'],
        second: { url: 'https://second.example/university', title: 'تاريخ الجامعة', line: 'تأسست الجامعة في ١٩٥٢.', agrees: false },
      },
    };
    const outcome = await runHands(plan, io({}, []));
    expect(text(outcome)).toContain('**مصدر ثانٍ يؤكد:** [second.example — تاريخ الجامعة]');
  });

  it('writes the second source in English for an English question', async () => {
    const first = pageOf('https://en.wikipedia.org/wiki/Egypt', 'Egypt - Wikipedia', 'Egypt is a country in North Africa. The population of Egypt is about 105 million people as of 2024. Its capital is Cairo.');
    // A second source must be about the same subject: its title carries the question's words («How many people live in Egypt?»).
    const differing = pageOf('https://stats.example/egypt', 'How many people live in Egypt? - stats.example', 'The population of Egypt reached 104.5 million people in 2024.');
    const outcome = await runHands({ steps: webQuestion('How many people live in Egypt?')!, next: 0, lang: 'en' },
      io(by(first, differing), [{ title: first.title, url: first.url }, { title: differing.title, url: differing.url }]));
    expect(outcome).toMatchObject({ kind: 'done', status: 'completed' });
    // The page whose title is the question is read first; whichever page came second is quoted with its differing figure.
    expect(text(outcome)).toMatch(/\*\*A second source differs:\*\* “The population of Egypt (?:is about 105|reached 104\.5) million/u);
    expect(text(outcome)).toContain(`](${first.url})`);
    expect(text(outcome)).toContain(`](${differing.url})`);
  });

  it('adds no second source to a question that does not ask for a figure, and says so when a figure had only one page', async () => {
    const first = pageOf('https://ar.wikipedia.org/wiki/مصر', 'مصر - ويكيبيديا', 'مصر دولة عربية تقع في الركن الشمالي الشرقي من أفريقيا. عاصمة مصر هي القاهرة.');
    const other = pageOf('https://facts.example/egypt', 'عاصمة مصر - facts.example', 'عاصمة مصر هي القاهرة وأكبر مدنها.');
    const outcome = await runHands({ steps: webQuestion('ما عاصمة مصر؟')!, next: 0, lang: 'ar' },
      io(by(first, other), [{ title: first.title, url: first.url }, { title: other.title, url: other.url }]));
    expect(outcome).toMatchObject({ kind: 'done', status: 'completed' });
    expect(text(outcome)).not.toMatch(/مصدر ثانٍ/u);
    // Plan §7.1: a figure from one page is not presented as settled.
    const alone = pageOf(first.url, first.title, 'يبلغ عدد سكان مصر نحو 105 ملايين نسمة.');
    const single = await runHands({ steps: webQuestion('كم عدد سكان مصر؟')!, next: 0, lang: 'ar' }, io(by(alone), [{ title: alone.title, url: alone.url }]));
    expect(single).toMatchObject({ kind: 'done', status: 'completed' });
    expect(text(single)).not.toMatch(/مصدر ثانٍ (?:يؤكد|يختلف)/u);
    expect(text(single)).toContain('\n\nلم أتحقق من هذا الرقم في مصدر ثانٍ.');
  });
});
