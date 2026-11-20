import { describe, expect, it } from 'vitest';
import { composeReply, missingText, researchText, siteQuoteText } from '../apps/server/src/assistant/mind/compose.js';
import type { Evidence, Frame, MindReply } from '../apps/server/src/assistant/mind/contract.js';

const url = 'https://field-journal.test/canals';
const readAt = '2026-09-08T06:24:00.000Z';
const frame: Frame = {
  lang: 'en', intent: 'fact_question', text: 'How deep was the canal?', focus: ['canal', 'depth'],
  urls: [], answerType: 'number', timeSensitive: false, personal: false, valueOnly: false, missing: [], matched: [],
};

function withClaim(text: string, evidence: Evidence[], lang: Frame['lang'] = 'en'): MindReply {
  return { text, evidence, frame: { ...frame, lang }, status: 'completed', timings: {}, claims: [{ text, support: evidence.map(item => item.id), status: 'single_source' }] };
}

describe('قوالب موحسن', () => {
  it('[en] writes each actual quotation, URL, date and receipt in its own source line', () => {
    const item = { id: 'journal', source: 'web', url, quote: 'The canal was seven metres deep.', fetchedAt: readAt, pageDate: '1954-06-20' } satisfies Evidence;
    expect(researchText('en', 'single_source', [item])).toBe(`From a single source\n«${item.quote}» ${url} · Source date 1954-06-20 · Read at ${readAt}`);
  });

  it('[ar] يذكر التعارض والجزئية ويعرض الاقتباسين بترتيبهما', () => {
    const item = { id: 'journal', source: 'web', url, quote: 'عمق القناة سبعة أمتار.', fetchedAt: readAt } satisfies Evidence;
    const other = { ...item, id: 'inspection', url: 'https://survey-notes.test/dock', quote: 'عمق القناة تسعة أمتار.' };
    expect(researchText('ar', 'conflict', [item, other], true).split('\n')).toEqual([
      'نتيجة جزئية · المصادر مختلفة', `«${item.quote}» ${item.url} · وقت القراءة ${readAt}`, `«${other.quote}» ${other.url} · وقت القراءة ${readAt}`,
    ]);
  });

  it('[en] keeps the originally supported value in a shortened verbatim memory quote', () => {
    const quote = 'The installation team measured the clearance against every annotated panel in the owner records and reported the final accepted clearance as 3 centimetres after sealing both joints and tightening the upper retaining bracket.';
    const item = { id: 'memory', source: 'memory', quote, value: '3 centimetres' } satisfies Evidence;
    const short = composeReply(withClaim(`From memory: «${quote}»`, [item]));
    const [evidence] = short.evidence;
    expect(evidence.quote.split(/\s+/u).length).toBeLessThanOrEqual(22);
    expect(quote).toContain(evidence.quote);
    expect(evidence.quote).toContain(item.value);
    expect(short.text).toBe(`From memory: «${evidence.quote}»`);
  });

  it('[ar] يبقي زمن القراءة وتاريخ المصدر في حقليهما', () => {
    const item = { id: 'direct', source: 'site', url, quote: 'كان عرض القناة خمسة أمتار.', fetchedAt: readAt, pageDate: '2011-02-27' } satisfies Evidence;
    const reply = withClaim(siteQuoteText('ar', item), [item], 'ar');
    expect(composeReply(reply).text).toBe(`«${item.quote}» ${url} (وقت القراءة ${readAt} · تاريخ المصدر 2011-02-27)`);
  });

  it('[ar] يعرض عدد ما فُحص بعبارة ثابتة', () => {
    expect(missingText('ar', 2, 3)).toBe('لم أجد جوابًا مسنودًا (الاستعلامات 3، الصفحات 2).');
    expect(missingText('ar', 1)).toBe('لم أجد الجواب في الصفحات التي قرأتها (1).');
  });

  it('[en] leaves unrelated ungrounded material for the critic to remove explicitly', () => {
    const item = { id: 'calc', source: 'computed', value: '42', quote: '21 × 2 = 42' } satisfies Evidence;
    const reply = withClaim(item.quote, [item]);
    reply.text += '\nA fabricated line';
    expect(composeReply(reply)).toMatchObject({ text: reply.text, claims: reply.claims });
  });
});
