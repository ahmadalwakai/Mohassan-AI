import { describe, expect, it } from 'vitest';
import { shorterAnswer, shorterRequest } from '../apps/server/src/assistant/answer-reshape.js';

function shorten(previous: string, prompt: string) {
  const request = shorterRequest(prompt);
  if (!request) throw new Error(`Unrecognized shortening request: ${prompt}`);
  return shorterAnswer(previous, request);
}

describe('shortening lists', () => {
  it.each([
    {
      prompt: 'اختصر الجواب السابق',
      items: ['* افتح المسودة.', '* راجع العنوان.', '* احفظ التعديل.'],
      source: '**المصدر:** [ملاحظات المسودة](https://example.test/ar)',
    },
    {
      prompt: 'make it shorter',
      items: ['- Open the draft.', '- Review the title.', '- Save the edit.'],
      source: '**Source:** [Draft notes](https://example.test/en)',
    },
  ])('keeps the first bullet and the answer source for "$prompt"', ({ prompt, items, source }) => {
    const previous = `${items.join('\n\n')}\n${source}`;
    expect(shorten(previous, prompt)).toBe(`${items[0]}\n\n${source}`);
  });

  it.each([
    {
      prompt: 'اختصر الجواب السابق',
      items: ['1. [المسودة الأولى](https://example.test/ar/a)', '2. [المسودة الثانية](https://example.test/ar/b)'],
    },
    {
      prompt: 'make it shorter',
      items: ['1. [First draft](https://example.test/en/a)', '2. [Second draft](https://example.test/en/b)'],
    },
  ])('keeps the first numbered item and its link for "$prompt"', ({ prompt, items }) => {
    expect(shorten(items.join('\n'), prompt)).toBe(items[0]);
  });

  it('quotes the first sentence of each long item and keeps its source', () => {
    const first = '- Open [the draft](https://example.test/draft).';
    const second = '- Review the title.';
    const source = '**Source:** [Title notes](https://example.test/title)';
    const previous = `${first} Use the editing view.\n${second} Compare it with the outline.\n  ${source}`;
    expect(shorten(previous, 'make it shorter')).toBe(`${first}\n${second}\n  ${source}`);
  });

  it('keeps the citation after omitted detail on the item it belongs to', () => {
    const fact = '١. راجع المسودة.';
    const citation = '([ملاحظات المسودة](https://example.test/ar/draft))';
    const second = '٢. احفظ التعديل.';
    expect(shorten(`${fact} افتح صفحة التحرير. ${citation}\n${second}`, 'اختصر الجواب السابق'))
      .toBe(`${fact}\n   ${citation}\n${second}`);
  });

  it('keeps the requested number of list lines in list form', () => {
    const items = ['- افتح المسودة.', '- راجع العنوان.', '- احفظ التعديل.'];
    expect(shorten(items.join('\n'), 'في سطرين')).toBe(items.slice(0, 2).join('\n'));
  });

  it.each([
    {
      prompt: 'اختصر الجواب السابق',
      lead: 'المسودة جاهزة للمراجعة.',
      detail: 'أُضيفت الملاحظات أيضًا.',
      items: ['- راجع العنوان.', '- احفظ التعديل.'],
    },
    {
      prompt: 'make it shorter',
      lead: 'The draft is ready for review.',
      detail: 'Notes were added as well.',
      items: ['1. Review the title.', '2. Save the edit.'],
    },
  ])('keeps the lead and a shortened list for "$prompt"', ({ prompt, lead, detail, items }) => {
    expect(shorten(`${lead} ${detail}\n\n${items.join('\n')}`, prompt)).toBe(`${lead}\n\n${items[0]}`);
  });

  it.each([
    {
      prompt: 'اختصر الجواب السابق في جملتين',
      items: ['1. راجع [المسودة](https://example.test/ar/draft)', '2. احفظ التعديل', '3. أرسل النسخة'],
      sentences: 'راجع [المسودة](https://example.test/ar/draft). احفظ التعديل.',
      source: '**المصدر:** [ملاحظات](https://example.test/ar/notes)',
    },
    {
      prompt: 'summarize that in two sentences',
      items: ['- Review [the draft](https://example.test/en/draft)', '- Save the edit', '- Send the copy'],
      sentences: 'Review [the draft](https://example.test/en/draft). Save the edit.',
      source: '**Source:** [Notes](https://example.test/en/notes)',
    },
  ])('turns the first two item facts into two sentences for "$prompt"', ({ prompt, items, sentences, source }) => {
    expect(shorten(`${items.join('\n')}\n\n${source}`, prompt)).toBe(`${sentences}\n\n${source}`);
  });

  it('draws two sentences from a single item when it has enough text', () => {
    const previous = '- افتح المسودة. راجع العنوان. احفظ التعديل.';
    expect(shorten(previous, 'في جملتين')).toBe('افتح المسودة. راجع العنوان.');
  });

  it('keeps the lead and first item within an explicit two-sentence limit', () => {
    const lead = 'The draft is ready.';
    const first = 'Open the draft.';
    expect(shorten(`${lead}\n\n- ${first}\n- Review the title.`, 'in two sentences')).toBe(`${lead} ${first}`);
  });

  it('fills an explicit sentence limit from supplemental details when the lead has only one sentence', () => {
    const lead = 'The draft is ready.';
    const firstDetail = 'Open the draft.';
    const previous = `${lead}\n\n**More from the same source:**\n- ${firstDetail}\n- Review the title.`;
    expect(shorten(previous, 'in two sentences')).toBe(`${lead} ${firstDetail}`);
  });

  it('keeps list items eligible when the list has a heading and no lead', () => {
    const first = '- Open the draft.';
    expect(shorten(`**Steps:**\n${first}\n- Review the title.`, 'make it shorter')).toBe(first);
  });

  it.each([
    ['اختصر الجواب السابق', 'المسودة جاهزة.\n\n**المصدر:** [الملاحظات](https://example.test/ar)'],
    ['make it shorter', 'The draft is ready.'],
    ['make it shorter', '- Open the draft.'],
    ['في جملتين', '- افتح المسودة.'],
  ])('finds no shorter excerpt for "%s" when the answer is already short', (prompt, previous) => {
    expect(shorten(previous, prompt)).toBeNull();
  });
});

describe('shortening web answers with supplemental details', () => {
  const ar = {
    lead: ['المسودة جاهزة للمراجعة.', 'أُضيفت الملاحظات أيضًا.'],
    details: '**تفاصيل أخرى من نفس المصدر:**\n- راجع العنوان. قارنه بالمخطط.\n- احفظ التعديل.\n- أرسل النسخة.',
    source: '**المصدر:** [ملاحظات المسودة](https://example.test/ar/draft)',
    also: '**للمزيد:** [دليل المراجعة](https://example.test/ar/guide)',
  };
  const en = {
    lead: ['The draft is ready for review.', 'Notes were added as well.'],
    details: '**More from the same source:**\n- Review the title. Compare it with the outline.\n- Save the edit.\n- Send the copy.',
    source: '**Source:** [Draft notes](https://example.test/en/draft)',
    also: '**See also:** [Review guide](https://example.test/en/guide)',
  };

  it.each([
    { prompt: 'اختصر جوابك', answer: ar, leadCount: 1 },
    { prompt: 'باختصار', answer: ar, leadCount: 1 },
    { prompt: 'في جملتين', answer: ar, leadCount: 2 },
    { prompt: 'make it shorter', answer: en, leadCount: 1 },
    { prompt: 'in two sentences', answer: en, leadCount: 2 },
  ])('uses the opening sentences and source for "$prompt"', ({ prompt, answer, leadCount }) => {
    const previous = [answer.lead.join(' '), answer.details, answer.source, answer.also].join('\n\n');
    expect(shorten(previous, prompt)).toBe(`${answer.lead.slice(0, leadCount).join(' ')}\n\n${answer.source}`);
  });
});

describe('shortening request wording', () => {
  it.each([
    ['اختصر القائمة', 'ar'],
    ['اختصر القائمة السابقة', 'ar'],
    ['اختصر الاجابه', 'ar'],
    ['shorten the list', 'en'],
    ['make the list shorter', 'en'],
  ])('recognizes "%s" as a request to shorten the previous answer', (prompt, lang) => {
    expect(shorterRequest(prompt)).toEqual({ sentences: 1, lang });
  });
});
