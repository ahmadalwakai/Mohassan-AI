import { describe, expect, it } from 'vitest';
import type { AgentPage } from '@mohassan/browser';
import { describe as describeReply, isWholeDetail, leadSentence, relevantLines, webQuestion, type HandsPlan } from '../apps/server/src/assistant/hands.js';
import { withoutFigures } from '../apps/server/src/assistant/readable-page.js';

/**
 * The layout of a sourced answer (2026-11-23): the article's opening sentence whole instead of cut at 40 words, details that
 * are whole sentences, and «للمزيد» links about the question's topic. Sentences below are written for this test after the
 * shapes measured on the 107 real requests (Einstein 73 words, LASIK and cataract 55–56).
 */
const pageOf = (url: string, title: string, text: string): AgentPage => ({
  id: url, url, title, text, elements: [],
  signals: { captcha: false, password: false, otp: false, card: false },
  scroll: { top: 0, height: 1000, viewport: 800 }, hash: url, observedAt: '2026-11-23T00:00:00Z',
});
const words = (count: number, word = 'كلمة') => Array.from({ length: count }, () => word);

describe('leadSentence', () => {
  it('keeps an opening sentence of up to 80 words whole', () => {
    const parts = [...words(70), 'النهاية.'];
    expect(leadSentence(parts)).toBe(parts.join(' '));
  });

  it('cuts a longer one at its last clause break from the 25th word on', () => {
    const parts = [...words(30), 'الأولى،', ...words(30), 'الثانية،', ...words(40)];
    expect(leadSentence(parts)).toBe(`${[...words(30), 'الأولى،', ...words(30), 'الثانية'].join(' ')} …`);
  });

  it('falls back to 40 words when a long sentence has no clause break', () => {
    expect(leadSentence(words(120))).toBe(`${words(40).join(' ')} …`);
  });
});

describe('isWholeDetail', () => {
  it('drops a run cut at both ends and a heading, keeps sentences, sentence ends and short lines with a number', () => {
    expect(isWholeDetail('… أستراليا إلى ست ولايات ومقاطعتين أساسيتين: نيو ساوث ويلز وعاصمتها سيدني …')).toBe(false);
    expect(isWholeDetail('… ثم أعقبه الإخشيديون، حتى انتزعها منهم الفاطميون وجعلوا عاصمتهم القاهرة التي أسسها المعز لدين الله.')).toBe(true);
    expect(isWholeDetail('الذكاء الاصطناعي القائم على المعرفة.')).toBe(false);
    expect(isWholeDetail('نهر المسيسيبي: أطول نهر في أمريكا الشمالية.')).toBe(true);
    expect(isWholeDetail('بلغ عدد السكان 120 مليون نسمة.')).toBe(true);
  });
});

describe('the opening sentence of an article as the answer', () => {
  it('is quoted whole, not cut at 40 words', () => {
    const lead = 'ألبرت أينشتاين عالم فيزياء ألماني المولد سويسري وأمريكي الجنسية، من أبوين يهوديين، يشتهر بأبي النسبية كواضع لنظريتي'
      + ' النسبية الخاصة والنسبية العامة الشهيرتين اللتين كانتا اللبنة الأولى للفيزياء النظرية الحديثة، حاز على جائزة نوبل في الفيزياء'
      + ' لعام 1921 عن ورقة بحثية حول التأثير الكهروضوئي من ضمن ثلاثمائة ورقة علمية أخرى له في تكافؤ المادة والطاقة وميكانيكا الكم'
      + ' وغيرها، وأدت استنتاجاته المبرهنة إلى تفسير العديد من الظواهر العلمية التي فشلت الفيزياء الكلاسيكية في إثباتها.';
    expect(lead.split(' ').length).toBeGreaterThan(40);
    const page = pageOf('https://ar.wikipedia.org/wiki/x', 'ألبرت أينشتاين - ويكيبيديا', `${lead}\nووقع على بيان مع الفيلسوف برتراند راسل الذي سلط الضوء على خطر الأسلحة النووية.\n`);
    const [first] = relevantLines(page, 'من هو ألبرت أينشتاين؟', 3, true);
    expect(first).toBe(lead);
    expect(first!.endsWith('…')).toBe(false);
  });
});

describe('a question about an event of a life', () => {
  it('matches the event verb as a whole word, not inside another word', () => {
    const page = pageOf('https://ar.wikipedia.org/wiki/x', 'ألبرت أينشتاين - ويكيبيديا',
      'وفي رسالة إلى أبنائه دون انطباعه عن اليابانيين بأنهم متواضعون ولديهم إحساس حقيقي بالفن.\n'
      + 'ولد ألبرت أينشتاين في أولم في مملكة فورتمبيرغ في 14 مارس 1879 لعائلة علمانية.\n');
    expect(relevantLines(page, 'أين ولد ألبرت أينشتاين', 3, true)[0]).toMatch(/^ولد ألبرت أينشتاين في أولم/u);
  });

  it('leaves a hatnote out of the page text, so the sentence after it is read', () => {
    const html = '<p>مقدمة.</p><div role="note" class="hatnote navigation-not-searchable">المقالة الرئيسة: <a href="/wiki/x">عائلة أينشتاين</a></div><p>ولد ألبرت أينشتاين في أولم.</p>';
    expect(withoutFigures(html)).not.toContain('المقالة الرئيسة');
    expect(withoutFigures(html)).toContain('<p>ولد ألبرت أينشتاين في أولم.</p>');
  });
});

describe('describe: a sourced answer', () => {
  function answer(query: string, lines: string[], results: { title: string; url: string }[]) {
    const plan: HandsPlan = { steps: webQuestion(query)!, next: 1, results,
      found: { url: results[0]!.url, title: results[0]!.title, lines, readAt: '2026-11-23T01:15:00Z' } };
    return describeReply(plan, null).text;
  }

  it('lists under «للمزيد» only the results about the question’s topic', () => {
    const text = answer('ما هي عملية الليزك؟', ['تعنى كلمة الليزك تعديل شكل القرنية باستعمال الليزر لإزالة طبقة رقيقة من سطحها.'], [
      { title: 'ليزك', url: 'https://ar.wikipedia.org/wiki/ليزك' },
      { title: 'خطأ انكسار', url: 'https://ar.wikipedia.org/wiki/خطأ_انكسار' },
      { title: 'فيصل محمد الطبيقي', url: 'https://ar.wikipedia.org/wiki/فيصل' },
    ]);
    expect(text).not.toContain('للمزيد');
    expect(text).not.toContain('فيصل');
    const einstein = answer('من هو ألبرت أينشتاين؟', ['ألبرت أينشتاين عالم فيزياء ألماني المولد اشتهر بنظرية النسبية.'], [
      { title: 'ألبرت أينشتاين', url: 'https://ar.wikipedia.org/wiki/أينشتاين' },
      { title: 'هانز ألبرت أينشتاين', url: 'https://ar.wikipedia.org/wiki/هانز' },
      { title: 'نيلز بور', url: 'https://ar.wikipedia.org/wiki/بور' },
    ]);
    expect(einstein).toContain('**للمزيد:** [هانز ألبرت أينشتاين]');
    expect(einstein).not.toContain('نيلز بور');
  });

  it('leaves out details that are cut runs or headings', () => {
    const text = answer('ما هو الذكاء الاصطناعي؟', [
      'الذكاء الاصطناعي هو فرع من علم الحاسوب.',
      'الذكاء الاصطناعي القائم على المعرفة.',
      'وتعرف منظمة التعاون الاقتصادي والتنمية نظام الذكاء الاصطناعي بأنه نظام آلي يتلقى مدخلات ثم يستنتج منها كيف ينتج مخرجات.',
    ], [{ title: 'ذكاء اصطناعي', url: 'https://ar.wikipedia.org/wiki/ذكاء_اصطناعي' }]);
    expect(text.startsWith('الذكاء الاصطناعي هو فرع من علم الحاسوب.')).toBe(true);
    expect(text).not.toContain('القائم على المعرفة');
    expect(text).toContain('- وتعرف منظمة التعاون الاقتصادي');
  });
});
