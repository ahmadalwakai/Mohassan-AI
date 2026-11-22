import { describe, expect, it } from 'vitest';
import type { AgentAction, AgentPage } from '@mohassan/browser';
import { articleUrl, entityWords, projectedFigure, relevantLines, runHands, webQuestion, type HandsIO } from '../apps/server/src/assistant/hands.js';

// Date questions («متى سقط جدار برلين؟») and English population questions, measured live on 2026-11-22: the frozen set in
// scripts/quality/date-questions.ts answered 0 of 12 correctly at 13:44 (artifacts/plan-2026-11-22/date-questions-2026-11-22T13-44-22.json).
// The sentences below are cut from the articles as read on 2026-11-22; the Berlin Wall lead is shortened.

const pageOf = (url: string, title: string, text: string): AgentPage => ({
  id: url, url, title, text, elements: [],
  signals: { captcha: false, password: false, otp: false, card: false },
  scroll: { top: 0, height: 1000, viewport: 800 }, hash: url, observedAt: '2026-11-22T14:00:00Z',
});
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
const answerOf = async (question: string, reads: Record<string, AgentPage>, hits: Hit[]) => {
  const { io, log } = fakeIO(reads, hits);
  const outcome = await runHands({ steps: webQuestion(question)!, next: 0 }, io);
  return { outcome, first: outcome.kind === 'done' ? outcome.text.split('\n')[0]! : '', log };
};

describe('the subject of a date question', () => {
  it('is the name without the event word', () => {
    expect(entityWords('متى سقط جدار برلين؟')).toEqual(['جدار', 'برلين']);
    expect(entityWords('متى تأسست جامعة الدول العربية؟')).toEqual(['جامعه', 'دول', 'عربيه']);
    expect(entityWords('متى ولد نجيب محفوظ؟')).toEqual(['نجيب', 'محفوظ']);
    expect(entityWords('When did the Berlin Wall fall?')).toEqual(['berlin', 'wall']);
    // «was» is a question word, as «is» already was: the subject is «United Nations», not «was United Nations».
    expect(entityWords('When was the United Nations founded?')).toEqual(['united', 'nations']);
  });

  it('keeps the event word when the question is not about a date', () => {
    expect(entityWords('من اخترع الهاتف؟')).toEqual([]);
    expect(entityWords('كم عدد سكان مصر؟')).toEqual(['مصر']);
  });

  it('is opened by its name, so «متى سقط جدار برلين» quotes the wall’s article, not a film about that night', async () => {
    const wallUrl = articleUrl('جدار برلين', 'ar');
    const filmUrl = new URL('https://ar.wikipedia.org/wiki/مجتمع_الميم_في_ألمانيا').href;
    const wall = pageOf(wallUrl, 'جدار برلين - ويكيبيديا', [
      'جدار برلين (الألمانية: Berliner Mauer) كان جدارا خرسانيا محميًا ومحروسًا يفصل برلين الغربية عن برلين الشرقية، للفترة من عام 1961 إلى عام 1989.',
      'افتتحت بوابة براندنبورغ في جدار برلين في 22 ديسمبر عام 1989.',
      'أعلن ناشر لعبة بلاي واي في أبريل عام 2018 عن عمل استوديو اللعبة البولندي كيه 202 على لعبة فيديو جدار برلين، والتي من المتوقع صدورها في نوفمبر عام 2019.',
    ].join(' '));
    const film = pageOf(filmUrl, 'مجتمع الميم في ألمانيا - ويكيبيديا', 'صدر فيلم ألماني حمل عنوان «الطلوع للخارج» عام 1989 من إخراج هاينر كارو، تدور أحداثه حول رجل ألماني شرقي يقبل هويته كشخص مثلي خلال الليلة التي سقط فيها جدار برلين.');
    const { outcome, first, log } = await answerOf('متى سقط جدار برلين؟', { [wallUrl]: wall, [filmUrl]: film },
      [{ title: 'مجتمع الميم في ألمانيا', url: filmUrl, snippet: 'خلال الليلة التي سقط فيها جدار برلين' }]);
    expect(outcome).toMatchObject({ kind: 'done', status: 'completed' });
    expect(log).toContain(`read:${wallUrl}`);
    expect(first).toContain('للفترة من عام 1961 إلى عام 1989');
    expect(first).not.toContain('فيلم');
  });
});

describe('the answer line of a date question', () => {
  it('is the article’s opening with its dates, not a later sentence with the question’s verb', () => {
    const url = articleUrl('الحرب العالمية الأولى', 'ar');
    const page = pageOf(url, 'الحرب العالمية الأولى - ويكيبيديا', [
      'اَلْحَرْبُ ٱلْعَالَمِيَّةُ ٱلْأُولَىٰ عُرِفَتْ حينئذٍ بالْحَرِبِ ٱلْعُظْمَىٰ حرب عالمية نشبت بدايةً في أوروبا دامت من 28 يوليو 1914 إلى 11 نوفمبر 1918.',
      'استُخدم اسم الحرب العالمية الأولى لأول مرة في سبتمبر عام 1914 من قبل الفيلسوف الألماني إرنست هيكل.',
      'دامت حملة فارس إلى 1918 انتهت بفشل العثمانيين وحلفائهم، انسحب الروس من الحرب في عام 1917.',
    ].join(' '));
    expect(relevantLines(page, 'متى انتهت الحرب العالمية الأولى؟', 3, true)[0]).toContain('دامت من 28 يوليو 1914 إلى 11 نوفمبر 1918');
  });

  it('keeps page order among equals: a birth date before a prize awarded since 1996', () => {
    const url = articleUrl('نجيب محفوظ', 'ar');
    const page = pageOf(url, 'نجيب محفوظ - ويكيبيديا', [
      'وُلد نجيب محفوظ في 11 ديسمبر 1911 في شارع بيت القاضي بحي الجمالية في القاهرة.',
      'وتوجد جائزة أيضاً باسم جائزة نجيب محفوظ، هي جائزة أدبية وتم إنشائها بواسطة قسم النشر بالجامعة الأمريكية بالقاهرة عام 1996م، وتُمنح في حفل يُقام كل عام في 11 ديسمبر، اليوم الموافق ليوم مولد نجيب محفوظ.',
    ].join(' '));
    expect(relevantLines(page, 'متى ولد نجيب محفوظ؟', 3, true)[0]).toBe('وُلد نجيب محفوظ في 11 ديسمبر 1911 في شارع بيت القاضي بحي الجمالية في القاهرة.');
    // An English opening with its dates outranks the war's end in Europe only when it is the article's own sentence.
    const war = pageOf(articleUrl('World War II', 'en'), 'World War II - Wikipedia', [
      'World War II, or the Second World War (1 September 1939 – 2 September 1945), was a global conflict between two coalitions: the Allies and the Axis powers.',
      'Roosevelt reinforced the Philippines (an American protectorate scheduled for independence in 1946) and warned Japan that the United States would react to Japanese attacks against any "neighboring countries".',
    ].join(' '));
    expect(relevantLines(war, 'When did World War II end?', 3, true)[0]).toContain('(1 September 1939 – 2 September 1945)');
  });

  it('names its subject: a dynasty that «استقل بالحكم» is not Algeria’s independence', () => {
    const url = articleUrl('الجزائر', 'ar');
    const page = pageOf(url, 'الجزائر - ويكيبيديا', [
      'بنى عاصمته القلعة عام 1007 م ثم أعلن الدعوة العباسية سنة 1015 م واستقل بالحكم.',
      'وتم الإعلان عن استقلال الجزائر يوم 3 جويلية 1962 واختير يوم 5 جويلية عيداً للاستقلال.',
    ].join(' '));
    expect(relevantLines(page, 'متى استقلت الجزائر؟', 3, true)).toEqual(['وتم الإعلان عن استقلال الجزائر يوم 3 جويلية 1962 واختير يوم 5 جويلية عيداً للاستقلال.']);
  });

  it('is not chosen for an opening that is a caption or another subject', () => {
    const page = pageOf(articleUrl('Berlin Wall', 'en'), 'Berlin Wall - Wikipedia', [
      'Berlin Wall Berliner Mauer From the West Berlin side, Berlin Wall graffiti art in 1986.',
      'The Berlin Wall (German: Berliner Mauer) was a guarded concrete barrier that encircled West Berlin from 1961 to 1989.',
    ].join(' '));
    expect(relevantLines(page, 'When did the Berlin Wall fall?', 3, true)[0]).toBe('The Berlin Wall (German: Berliner Mauer) was a guarded concrete barrier that encircled West Berlin from 1961 to 1989.');
  });
});

describe('an English population question', () => {
  it('answers "How many people live in Japan?" with the population, not Greater Tokyo nor a projection', async () => {
    const url = articleUrl('Japan', 'en');
    const japan = pageOf(url, 'Japan - Wikipedia', [
      'It is part of the Greater Tokyo Area, the biggest metropolitan area in the world with 37.4 million people (2024).',
      "With a population of almost 123 million as of 2026, it is the world's 11th most populous country.",
      'In 2023, 92% of the Japanese population lived in cities.',
      "As a growing number of younger Japanese are not marrying or remaining childless, Japan's population is expected to drop to around 88 million by 2065.",
    ].join(' '));
    const { outcome, first } = await answerOf('How many people live in Japan?', { [url]: japan }, [{ title: 'Japan', url, snippet: 'Japan is an island country in East Asia' }]);
    expect(outcome).toMatchObject({ kind: 'done', status: 'completed' });
    expect(first).toContain('almost 123 million as of 2026');
  });

  it('passes over a projection even when it ranks first', async () => {
    expect(projectedFigure("Japan's population is expected to drop to around 88 million by 2065.")).toBe(true);
    expect(projectedFigure('With a population of almost 123 million as of 2026, it is the world’s 11th most populous country.')).toBe(false);
    expect(projectedFigure('يبلغ عدد سكان اليابان 123 مليون نسمة اعتباراً من 2024.')).toBe(false);
    // Written for this test: a projection that repeats every question word, so it outranks the current figure.
    const url = articleUrl('Japan', 'en');
    const japan = pageOf(url, 'Japan - Wikipedia', [
      'The number of people who live in Japan is expected to fall to around 88 million by 2065.',
      "With a population of almost 123 million as of 2026, it is the world's 11th most populous country.",
    ].join(' '));
    const { first } = await answerOf('How many people live in Japan?', { [url]: japan }, [{ title: 'Japan', url, snippet: 'Japan is an island country in East Asia' }]);
    expect(first).toContain('almost 123 million as of 2026');
  });

  it('answers "How many people live in Egypt?" with its inhabitants, not a count of people sentenced', async () => {
    const url = articleUrl('Egypt', 'en');
    const egypt = pageOf(url, 'Egypt - Wikipedia', [
      'Egypt has also drawn international condemnation for mass death sentences, including a 2014 ruling sentencing 529 people to death in a single hearing.',
      'With over 107 million inhabitants, Egypt is the most populous country in the Arab world, third-most populous country in Africa, and 15th-most populated in the world.',
    ].join(' '));
    const { first } = await answerOf('How many people live in Egypt?', { [url]: egypt }, [{ title: 'Egypt', url, snippet: 'Egypt is a country in North Africa' }]);
    expect(first).toContain('With over 107 million inhabitants');
  });
});
