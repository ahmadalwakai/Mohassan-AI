import { describe, expect, it } from 'vitest';
import type { AgentPage } from '@mohassan/browser';
import { selectOpenPageLines, withAnswerSelectionMode } from '../apps/server/src/assistant/selection/hands-selection.js';
import { selectPageFact } from '../apps/server/src/assistant/selection/page-facts.js';

const page = (text: string, documentStatus = 200): AgentPage => ({
  id: 'page', url: 'https://notices.example/visitor', title: 'Visitor notices', text, elements: [], hash: 'page',
  observedAt: '2025-07-09T00:00:00Z', documentStatus,
  signals: { captcha: false, password: false, otp: false, card: false }, scroll: { top: 0, height: 800, viewport: 800 },
});

describe('factual quotations from an explicitly opened page', () => {
  it.each([
    ['the distance of the river path', 'The river path measures 7 miles.', 'The ridge path measures 3 miles.'],
    ['the year the west wing was restored', 'The west wing was restored in 2008.', 'The east wing was restored in 2011.'],
    ['which day the library closes', 'The library closes on Tuesday.', 'The library opens on Wednesday.'],
    ['أي يوم تفتح قاعة المطالعة', 'تفتح قاعة المطالعة يوم الثلاثاء.', 'تفتح قاعة المحاضرات يوم الاثنين.'],
    ['closing time on الثلاثاء', 'تبقى المكتبة مفتوحة يوم الثلاثاء إلى الساعة 18 ثم تغلق.', 'تفتح المكتبة يوم الثلاثاء الساعة 9.'],
    ['who designed the marble fountain', 'The marble fountain was designed by Elisa Martins.', 'The marble fountain was painted by Sam Wilson.'],
    ['سعر الاشتراك السنوي', 'تبلغ تكلفة الاشتراك السنوي ٢٥٠ ريال.', 'تبلغ تكلفة الاشتراك الشهري ٣٠ ريال.'],
  ])('selects the original sentence for %s', (question, answer, distractor) => {
    expect(selectPageFact(page(`${distractor}\n${answer}`), question)).toEqual([answer]);
  });

  it('quotes only an observed identifier when requested', () => {
    expect(selectPageFact(page('Pick up supplies at locker number 815.'), 'locker number, value only')).toEqual(['815']);
  });

  it('abstains on competing identifiers and numbers embedded in other identifiers', () => {
    expect(selectPageFact(page('Locker number 815 or locker number 819 is available.'), 'locker number')).toEqual([]);
    expect(selectPageFact(page('Locker number 815-B is available.'), 'locker number')).toEqual([]);
  });

  it('requires the value to describe the requested subject', () => {
    expect(selectPageFact(page('The river path reaches a ridge path 3 miles long.'), 'the length of the river path')).toEqual([]);
    expect(selectPageFact(page('The west wing was intact when the east wing was restored in 2011.'), 'the year the west wing was restored')).toEqual([]);
    expect(selectPageFact(page('The library is not closed on Saturday.'), 'which day the library is closed')).toEqual([]);
  });

  it('abstains on inconsistent or tentative evidence', () => {
    const conflicts = page('The annual membership costs $22. The annual membership costs $25.');
    expect(selectPageFact(conflicts, 'the cost of the annual membership')).toEqual([]);
    expect(selectPageFact(page('The library might close on Tuesday.'), 'which day the library closes')).toEqual([]);
  });

  it('keeps unsupported and current-state requests on their existing paths', () => {
    const notice = page('The annual membership costs $22.');
    expect(selectPageFact(notice, 'the current cost of the annual membership')).toBeUndefined();
    expect(selectPageFact(notice, 'read the entire brochure')).toBeUndefined();
  });

  it('withholds legacy suggestions for newly planned requests that need freshness', () => {
    const text = 'The annual membership costs $22.';
    const notice = page(text);
    expect(withAnswerSelectionMode('combined', () => selectOpenPageLines(
      notice, 'the current cost of the annual membership', [text], false, true, true,
    ))).toEqual([]);
  });

  it('uses observed static fields in combined mode and rejects error pages', () => {
    const text = 'The annual membership costs $22.';
    const ask = (source: AgentPage) => selectOpenPageLines(source, 'the cost of the annual membership', [], false, true);
    expect(withAnswerSelectionMode('legacy', () => ask(page(text)))).toEqual([]);
    expect(withAnswerSelectionMode('combined', () => ask(page(text)))).toEqual([text]);
    expect(withAnswerSelectionMode('combined', () => ask(page(text, 404)))).toEqual([]);
  });
});
