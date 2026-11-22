import { describe, expect, it } from 'vitest';
import type { AgentAction, AgentPage } from '@mohassan/browser';
import { aboutSubject, articleUrl, entityWords, isAttributeWord, pastFigure, runHands, topicWords, webQuestion, withoutPronoun, type HandsIO } from '../apps/server/src/assistant/hands.js';

// Two wrong answers measured on 2026-11-22 (artifacts/plan-2026-11-22/1-hands-http.md §5) and the population lines found while
// checking them live at 08:15 (artifacts/plan-2026-11-22/wrong-answers-fix/):
// - «وكم عدد سكانها؟» after «ما عاصمة اليابان؟» showed «ناكادوماري… 10,577 نسمة», a town's population: «سكانها» did not count
//   as the attribute «سكان», so the question had no subject and any page's figure passed;
// - «كم عدد سكان فرنسا» chose «حول 1340… 17 مليون نسمة» over «68.6 مليون نسمة في يناير 2025»;
// - «من هو الخوارزمي؟» was answered from «نظرية التعلم الخوارزمي»: the engine ranked it above the person's article.

const pageOf = (url: string, title: string, text: string): AgentPage => ({
  id: url, url, title, text, elements: [],
  signals: { captcha: false, password: false, otp: false, card: false },
  scroll: { top: 0, height: 1000, viewport: 800 }, hash: url, observedAt: '2026-11-22T08:00:00Z',
});
const wiki = (title: string) => new URL(`https://ar.wikipedia.org/wiki/${title.replaceAll(' ', '_')}`).href;
const townUrl = wiki('ناكادوماري');
const town = pageOf(townUrl, 'ناكادوماري - ويكيبيديا', 'ناكادوماري هي بلدة في اليابان، تقع في محافظة آوموري، بلغ عدد سكانها 10,577 نسمة وذلك حسب إحصائيات سنة 2018، تبلغ مساحتها 216.34 كيلومتر مربع.');
const japanUrl = articleUrl('اليابان', 'ar');
const japan = pageOf(japanUrl, 'اليابان - ويكيبيديا', 'اليابان دولة جزرية في شرق آسيا تقع في المحيط الهادئ. تحتل المناطق الجبلية ما يزيد عن 70% من أرض اليابان، أما المدن التي يزيد عدد سكانها على مليون نسمة فهي سابورو وسنداي. يبلغ عدد سكان اليابان 123 مليون نسمة اعتباراً من 2024، وعاصمتها طوكيو.');

type Hit = { title: string; url: string; snippet: string };
function fakeIO(reads: Record<string, AgentPage>, hits: Hit[]) {
  const log: string[] = [];
  const io: HandsIO = {
    read: async (url: string) => { log.push(`read:${url}`); const found = reads[url]; return found ? { kind: 'page' as const, page: found } : { kind: 'unreadable' as const }; },
    search: async query => { log.push(`search:${query}`); return hits; },
    page: async () => null,
    act: async (action: AgentAction) => { log.push(`${action.kind}:${action.text ?? action.ref}`); return pageOf(action.text ?? '', '', ''); },
    prepare: async () => null,
    settle: async page => page,
    step: async label => { log.push(`step:${label}`); },
    pause: async () => {},
    approve: async () => {},
    hold: async () => {},
  };
  return { io, log };
}
const townHit: Hit = { title: 'ناكادوماري', url: townUrl, snippet: 'ناكادوماري هي بلدة في اليابان، بلغ عدد سكانها 10,577 نسمة' };
const searchQuery = (steps: ReturnType<typeof webQuestion>) => { const step = steps?.find(item => item.kind === 'search'); return step && 'query' in step ? step.query : ''; };

describe('an attribute with an attached pronoun', () => {
  it('counts as the attribute, and folded ta marbuta words do not', () => {
    for (const word of ['سكانها', 'سكانه', 'سكانهم', 'عاصمتها', 'عاصمته', 'مساحتها', 'مساحته', 'لغتها', 'وفاته', 'طوله', 'ميلاده']) expect(isAttributeWord(word), word).toBe(true);
    // «عمرة», «ملكة», «سعرة», «موقعة», «رئيسة», «مؤسسة», «مكة», «سكتة» fold to these: a bare «ه» there is not a pronoun.
    for (const word of ['عمره', 'ملكه', 'سعره', 'موقعه', 'رئيسه', 'مؤسسه', 'مكه', 'سكته', 'اسهم', 'سهم', 'يابان']) expect(isAttributeWord(word), word).toBe(false);
  });

  it('leaves the subject of the question', () => {
    expect(entityWords('كم عدد سكانها اليابان')).toEqual(['يابان']);
    expect(entityWords('كم عدد سكان مصر')).toEqual(['مصر']);
    expect(entityWords('كم عمر الملكة')).toEqual(['ملكه']);
    expect(entityWords('كم تكلفة العمرة')).toEqual([]);
    const topic = topicWords('كم عدد سكانها اليابان'), entity = entityWords('كم عدد سكانها اليابان');
    expect(aboutSubject(town.title, topic, entity)).toBe(false);
    expect(aboutSubject(japan.title, topic, entity)).toBe(true);
  });

  it('drops the pronoun once the follow-up names what it pointed at', () => {
    expect(['سكانها', 'عاصمتها', 'مساحته', 'طوله', 'السكان', 'عمره', 'سعره', 'اليابان'].map(withoutPronoun)).toEqual(['سكان', 'عاصمة', 'مساحة', 'طول', 'السكان', 'عمره', 'سعره', 'اليابان']);
    expect(searchQuery(webQuestion('وكم عدد سكانها؟', ['اليابان']))).toBe('كم عدد سكان اليابان');
    expect(searchQuery(webQuestion('وكم عدد سكانها؟', ['ما عاصمة اليابان؟']))).toBe('كم عدد سكان عاصمة اليابان');
    expect(searchQuery(webQuestion('وما عاصمتها؟', ['فرنسا']))).toBe('ما عاصمة فرنسا');
    expect(searchQuery(webQuestion('وكم سعره في مصر؟', ['كم سعر الذهب اليوم؟']))).toBe('كم سعره في مصر الذهب');
  });
});

describe('«وكم عدد سكانها؟» after an answer read from the Japan article', () => {
  const steps = () => webQuestion('وكم عدد سكانها؟', ['اليابان'])!;

  it("answers with Japan's population from its article, not the town the search returned nor the share of mountains", async () => {
    const { io, log } = fakeIO({ [japanUrl]: japan, [townUrl]: town }, [townHit]);
    const outcome = await runHands({ steps: steps(), next: 0 }, io);
    expect(log).toContain(`read:${japanUrl}`);
    expect(outcome).toMatchObject({ kind: 'done', status: 'completed' });
    const text = outcome.kind === 'done' ? outcome.text : '';
    expect(text.split('\n')[0]).toContain('123 مليون نسمة');
    expect(text).not.toContain('10,577');
  });

  it('shows no figure when only the town page can be read', async () => {
    const { io } = fakeIO({ [townUrl]: town }, [townHit]);
    const outcome = await runHands({ steps: steps(), next: 0 }, io);
    expect(outcome.kind).toBe('done');
    expect(outcome.kind === 'done' && outcome.text).not.toContain('10,577');
  });
});

describe("a population is today's figure", () => {
  it('tells a past figure by its year or «في ذلك الوقت»', () => {
    expect(pastFigure('حول 1340، كانت فرنسا يبلغ عدد سكانها حوالي 17 مليون نسمة')).toBe(true);
    expect(pastFigure('من عدد سكانها 39600000 فقط في ذلك الوقت')).toBe(true);
    expect(pastFigure('عدد سكانها حوالي 68.6 مليون نسمة في يناير 2025')).toBe(false);
    expect(pastFigure('بلغ عدد السكان 1,340,000 نسمة')).toBe(false);
    expect(pastFigure('تعداد 1999')).toBe(false);
  });

  it('answers «كم عدد سكان فرنسا» with the 2025 figure, not a share of Catholics nor the year 1340', async () => {
    const franceUrl = articleUrl('فرنسا', 'ar');
    const france = pageOf(franceUrl, 'فرنسا - ويكيبيديا', [
      'وبلغ عدد المسيحيين الكاثوليك سنة 2006 حوالي 65% من سكان فرنسا، فيما كان عددهم سنة 1970 80% كما كان عددهم 90% سنة 1905.',
      'حول 1340، كانت فرنسا يبلغ عدد سكانها حوالي 17 مليون نسمة، والتي في نهاية هذا الوباء قد انخفضت بنسبة حوالي النصف.',
      'يبلغ عدد سكان فرنسا حوالي 68.6 مليون نسمة في يناير 2025، وعاصمتها وأكبر مدنها هي باريس.',
    ].join(' '));
    const { io } = fakeIO({ [franceUrl]: france }, [{ title: 'فرنسا', url: franceUrl, snippet: 'فرنسا دولة في أوروبا' }]);
    const outcome = await runHands({ steps: webQuestion('كم عدد سكان فرنسا؟')!, next: 0 }, io);
    expect(outcome).toMatchObject({ kind: 'done', status: 'completed' });
    expect(outcome.kind === 'done' && outcome.text.split('\n')[0]).toContain('68.6 مليون نسمة');
  });
});

describe('«من هو الخوارزمي؟»', () => {
  it("reads the person's article opened by name before the theory the engine ranked first", async () => {
    const personUrl = wiki('محمد بن موسى الخوارزمي'), theoryUrl = wiki('نظرية التعلم الخوارزمي');
    // Wikipedia serves the person's article at /wiki/الخوارزمي (a redirect), measured 2026-11-22.
    const person = pageOf(personUrl, 'محمد بن موسى الخوارزمي - ويكيبيديا', 'أبو عبد الله محمد بن موسى الخوارزمي عالم رياضيات وفلك وجغرافيا مسلم، توفي نحو سنة 850 م، وكتابه في الجبر أول دراسة منهجية له.');
    const theory = pageOf(theoryUrl, 'نظرية التعلم الخوارزمي - ويكيبيديا', 'نظرية التعلم الخوارزمي هي إطار رياضي لتحليل مشاكل تعلم الآلة والخوارزميات، وتختلف عن نظرية التعلم الإحصائي.');
    const { io } = fakeIO({ [articleUrl('الخوارزمي', 'ar')]: person, [personUrl]: person, [theoryUrl]: theory },
      [{ title: 'نظرية التعلم الخوارزمي', url: theoryUrl, snippet: 'نظرية التعلم الخوارزمي هي إطار رياضي' }, { title: 'محمد بن موسى الخوارزمي', url: personUrl, snippet: 'الاسم الكامل للخوارزمي' }]);
    const outcome = await runHands({ steps: webQuestion('من هو الخوارزمي؟')!, next: 0 }, io);
    expect(outcome).toMatchObject({ kind: 'done', status: 'completed' });
    const text = outcome.kind === 'done' ? outcome.text : '';
    expect(text.split('\n')[0]).toContain('عالم رياضيات');
    expect(text).not.toMatch(/^نظرية التعلم/u);
  });
});
