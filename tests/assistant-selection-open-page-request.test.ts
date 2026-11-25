import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseHands } from '../apps/server/src/assistant/hands.js';

const url = 'https://example.org/exhibits?floor=1&wing=north#hours';
const open = { kind: 'open', url, name: 'example.org' };

afterEach(() => vi.unstubAllEnvs());

describe('fact requests after opening a page', () => {
  it.each([
    [`Please visit the page ${url} in the browser, then check which month registration opens.`, 'which month registration opens'],
    [`Open ${url} and tell me the weight of the largest sculpture.`, 'the weight of the largest sculpture'],
    [`Go to ${url} and identify who designed the north entrance.`, 'who designed the north entrance'],
    [`Open ${url} and show what this article says about the restoration.`, 'what this article says about the restoration'],
    [`افتح ${url} واقرأ لي رسوم دخول المعرض.`, 'رسوم دخول المعرض'],
    [`ادخل على ${url} ثم أخبرني في أي شهر تبدأ الجولة.`, 'في أي شهر تبدأ الجولة'],
    [`افتح ${url} واكتب arrival time يوم الثلاثاء.`, 'arrival time يوم الثلاثاء'],
    [`افتح ${url} واعرض ما يقوله الموقع عن افتتاح المبنى.`, 'ما يقوله الموقع عن افتتاح المبنى'],
  ])('adds a read-only question for %s', (request, question) => {
    vi.stubEnv('MOHASSAN_ANSWER_SELECTION', '1');
    expect(parseHands(request)).toEqual([open, { kind: 'ask_page', question, strictFact: true }]);
  });

  it('preserves the existing parser when disabled and the full-page read when enabled', () => {
    vi.stubEnv('MOHASSAN_ANSWER_SELECTION', '0');
    expect(parseHands(`Visit ${url} and check which month registration opens.`)).toBeNull();
    vi.stubEnv('MOHASSAN_ANSWER_SELECTION', '1');
    expect(parseHands(`Open ${url} and read the page.`)).toEqual([open, { kind: 'read', more: false }]);
  });

  it.each([
    `Open ${url} and tell me a joke.`,
    `Open ${url} and tell me the price and then submit the order.`,
    `Open ${url} and tell me the dates. Then publish them.`,
    `افتح ${url} واكتب رقم الجناح في الحقل الأول.`,
    `Open ${url} and tell me the length from https://example.net/other.`,
    'Visit https://guest:pass@example.org/exhibits and tell me the arrival time.',
    'Open example.org and tell me what date the festival begins.',
  ])('does not extend compound or ambiguous requests into page questions', request => {
    vi.stubEnv('MOHASSAN_ANSWER_SELECTION', '1');
    expect(parseHands(request)?.some(step => step.kind === 'ask_page')).not.toBe(true);
  });
});
