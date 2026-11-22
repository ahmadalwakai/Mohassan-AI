import { describe, expect, it } from 'vitest';
import type { AgentPage } from '@mohassan/browser';
import { relevantLines } from '../apps/server/src/assistant/hands.js';

/**
 * A page read over HTTP is one line of words joined by spaces. In the full run of 2026-11-22 07:06
 * (artifacts/plan-2026-11-22/real-answers-2026-11-22T07-06-58.jsonl) first lines began with a stray «]», carried
 * Wikipedia's «[لغات أخرى]» or a leading «ويكي بيانات», and had a space before every «.» and «،». The texts below
 * reproduce those lines.
 */
const pageOf = (title: string, text: string): AgentPage => ({
  id: title, url: `https://ar.wikipedia.org/wiki/${encodeURIComponent(title)}`, title: `${title} - ويكيبيديا`, text, elements: [],
  signals: { captcha: false, password: false, otp: false, card: false }, scroll: { top: 0, height: 1000, viewport: 800 }, hash: title, observedAt: '2026-11-22T07:10:00.000Z',
});

describe('sentences read over HTTP are cleaned before they become an answer', () => {
  it('drops a stray closing bracket and the space before punctuation (rq008)', () => {
    const page = pageOf('نهر', 'الأنهار مجاري مياه عذبة ( انظر القائمة . ] نهر النيل : أطول أنهار العالم ، ويجري في أفريقيا .');
    expect(relevantLines(page, 'ما هو أطول نهر في العالم', 1, true)[0]).toBe('نهر النيل: أطول أنهار العالم، ويجري في أفريقيا.');
  });

  it('removes Wikipedia’s interface marks and direction marks (rq017)', () => {
    const page = pageOf('المياه البيضاء', 'وصفه ل جراحة المياه البيضاء بالعين كان يشبه استخراج العدسات خارج كبسولة العين [لغات أخرى] ‏ .');
    expect(relevantLines(page, 'ما أعراض المياه البيضاء في العين', 1, true)[0]).toBe('وصفه ل جراحة المياه البيضاء بالعين كان يشبه استخراج العدسات خارج كبسولة العين.');
  });

  it('drops a leading «ويكي بيانات» link label (rq037)', () => {
    const page = pageOf('أيقظ قدراتك واصنع مستقبلك', 'ويكي بيانات أيقظ قدراتك واصنع مستقبلك هو كتاب من تأليف الدكتور إبراهيم الفقي .');
    expect(relevantLines(page, 'ما هي قدراتك', 1, true)[0]).toBe('أيقظ قدراتك واصنع مستقبلك هو كتاب من تأليف الدكتور إبراهيم الفقي.');
  });

  it('keeps an opening parenthesis and a decimal number intact', () => {
    const page = pageOf('ذكاء اصطناعي', 'الذكاء الاصطناعي ( Artificial Intelligence ) هو فرع من علم الحاسوب يبلغ عمره 70.5 عامًا تقريبًا .');
    expect(relevantLines(page, 'ما هو الذكاء الاصطناعي', 1, true)[0]).toBe('الذكاء الاصطناعي (Artificial Intelligence) هو فرع من علم الحاسوب يبلغ عمره 70.5 عامًا تقريبًا.');
  });
});
