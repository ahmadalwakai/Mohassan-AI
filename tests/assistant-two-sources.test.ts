import { describe, expect, it } from 'vitest';
import type { AgentAction, AgentPage } from '@mohassan/browser';
import { entityWords, firstFigure, isOwnArticle, namesEntity, runHands, sameFigure, webQuestion, type HandsIO } from '../apps/server/src/assistant/hands.js';

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
type Hit = { title: string; url: string };
function io(pages: Record<string, AgentPage>, hits: Hit[] | ((query: string) => Hit[]), searched: string[] = []): HandsIO {
  return {
    page: async () => null,
    search: async (query: string) => { searched.push(query); return (Array.isArray(hits) ? hits : hits(query)).map(hit => ({ ...hit, snippet: hit.title })); },
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
  it('reads the first figure of a sentence in either digit system', () => {
    expect(firstFigure('يبلغ عدد سكان مصر نحو 105 ملايين نسمة بحسب تقديرات 2024.')).toBe('105');
    expect(firstFigure('عدد السكان ١٠٥ ملايين')).toBe('105');
    expect(firstFigure('The speed of light is 299,792,458 metres per second.')).toBe('299792458');
    expect(firstFigure('Cataract surgery takes 20 to 45 minutes.')).toBe('20');
    expect(firstFigure('لا رقم هنا')).toBeNull();
    expect(sameFigure('سكانها 105 ملايين', 'نحو 105 مليون نسمة')).toBe(true);
    expect(sameFigure('سكانها 105 ملايين', 'نحو 104 ملايين')).toBe(false);
    // A year is a date, not the figure asked for, unless it is the only number.
    expect(firstFigure('في عام 2024 بلغ عدد السكان 105 ملايين نسمة')).toBe('105');
    expect(firstFigure('تأسست الجامعة عام 1952.')).toBe('1952');
  });

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

  it('answers a subject-attribute question from the subject’s own article, found by a lookup of its name', async () => {
    // What the shared engine returned on 2026-11-22 for «كم عدد سكان مصر»: a town's page and a people's page, not «مصر».
    const town = pageOf('https://ar.wikipedia.org/wiki/القصير_(مصر)', 'القصير (مصر) - ويكيبيديا', 'القصير مدينة مصرية على البحر الأحمر. انخفض عدد سكان المدينة بصورة ملحوظة إلى نحو 1500 نسمة بعد مرحلة الازدهار.');
    const arabs = pageOf('https://ar.wikipedia.org/wiki/عرب', 'عرب - ويكيبيديا', 'العرب مجموعة عرقية. يصل عدد هذه الدول إلى 22 دولة، مصر أكثرها سكانًا، والبحرين أقلها.');
    const egypt = pageOf('https://ar.wikipedia.org/wiki/مصر', 'مصر - ويكيبيديا', 'مصر دولة عربية. يبلغ عدد سكانها نحو 105 ملايين نسمة بحسب تقديرات 2024. وعاصمتها القاهرة.');
    const searched: string[] = [];
    const engine = (query: string): Hit[] => query === 'مصر' ? [{ title: egypt.title, url: egypt.url }] : [{ title: town.title, url: town.url }, { title: arabs.title, url: arabs.url }];
    const outcome = await runHands({ steps: webQuestion('كم عدد سكان مصر؟')!, next: 0, lang: 'ar' }, io(by(town, arabs, egypt), engine, searched));
    expect(searched).toEqual(['كم عدد سكان مصر', 'مصر']);
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

  it('quotes the second page when its figure differs, and names it when it agrees', async () => {
    const first = pageOf('https://ar.wikipedia.org/wiki/مصر', 'مصر - ويكيبيديا', 'مصر دولة عربية. يبلغ عدد سكان مصر نحو 105 ملايين نسمة بحسب تقديرات 2024. وعاصمتها القاهرة.');
    const differing = pageOf('https://stats.example/egypt', 'عدد سكان مصر 2024 - stats.example', 'عدد سكان مصر 104.5 ملايين نسمة في منتصف 2024 بحسب الجهاز المركزي للإحصاء.');
    // A title made only of the question's words would be read first as the subject's own article; this one is not.
    const agreeing = pageOf('https://facts.example/egypt', 'إحصاءات سكان مصر - facts.example', 'يبلغ عدد سكان مصر 105 ملايين نسمة تقريبًا.');
    const differs = await runHands({ steps: webQuestion('كم عدد سكان مصر؟')!, next: 0, lang: 'ar' },
      io(by(first, differing), [{ title: first.title, url: first.url }, { title: differing.title, url: differing.url }]));
    expect(differs).toMatchObject({ kind: 'done', status: 'completed' });
    expect(text(differs).split('\n')[0]).toContain('105 ملايين');
    expect(text(differs)).toContain(`**مصدر ثانٍ يختلف:** «عدد سكان مصر 104.5 ملايين نسمة في منتصف 2024 بحسب الجهاز المركزي للإحصاء.» — [stats.example — ${differing.title}](${differing.url})`);
    const agrees = await runHands({ steps: webQuestion('كم عدد سكان مصر؟')!, next: 0, lang: 'ar' },
      io(by(first, agreeing), [{ title: first.title, url: first.url }, { title: agreeing.title, url: agreeing.url }]));
    expect(agrees).toMatchObject({ kind: 'done', status: 'completed' });
    expect(text(agrees)).toContain(`**مصدر ثانٍ يؤكد:** [facts.example — ${agreeing.title}](${agreeing.url})`);
    expect(text(agrees)).not.toContain('يختلف');
  });

  it('writes the second source in English for an English question', async () => {
    const first = pageOf('https://en.wikipedia.org/wiki/Egypt', 'Egypt - Wikipedia', 'Egypt is a country in North Africa. The population of Egypt is about 105 million people as of 2024. Its capital is Cairo.');
    // A second source must be about the same subject: its title carries the question's words («How many people live in Egypt?»).
    const differing = pageOf('https://stats.example/egypt', 'How many people live in Egypt? - stats.example', 'The population of Egypt reached 104.5 million people in mid-2024 according to the statistics agency.');
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
