import { describe, expect, it } from 'vitest';
import { extendConversationEntities } from '../apps/server/src/assistant/conversation-state-entities.js';

// Verbatim dialogue fragments from the 2026-11-23 quality report and existing tests at the pinned base or origin PR #13.
// These unit inputs are not a corpus for evaluation or training.
const MICROSOFT_QUESTION = 'من هو مؤسس شركة مايكروسوفت؟';
const MICROSOFT_ANSWER = 'تجدر الإشارة أن بيل غيتس وبول ألين هما المؤسسان والملاك لهذه الشركة قبل أن تصبح من الشركات العامة.\n'
  + 'تأسست شركة مايكروسوفت العملاقة من قبل بيل غيتس وبول ألين في 4 نيسان من عام 1975م.';

const EGYPT_ANSWER = 'مصر دولة عربية تقع في الركن الشمالي الشرقي من أفريقيا. عاصمة مصر هي القاهرة.';
const JAPAN_ANSWER = 'Tokyo is the capital of Japan and its largest city.';
const BIOGRAPHY = 'ولد ألبرت أينشتاين في مدينة أولم الألمانية لعائلة يهودية.';
const ESTABLISHED_SOURCE = '**المصدر:** [ويكيبيديا — ذكاء اصطناعي](https://ar.wikipedia.org/wiki/x) · قُرئت 2026-11-23 01:15 UTC';

const record = extendConversationEntities;

describe('conversation entity stack', () => {
  it('ranks named founders in answer order and keeps organization mentions with separate provenance', () => {
    const user = record([], { text: MICROSOFT_QUESTION, turnId: 'u1', role: 'user', publicLookup: true });
    const stack = record(user, { text: MICROSOFT_ANSWER, turnId: 'a1', role: 'assistant', publicLookup: true });
    expect(stack.slice(0, 2)).toEqual([
      expect.objectContaining({ text: 'بيل غيتس', kind: 'person', turnId: 'a1', role: 'assistant', publicLookup: true }),
      expect.objectContaining({ text: 'بول ألين', kind: 'person', turnId: 'a1', role: 'assistant', publicLookup: true }),
    ]);
    expect(stack.filter(entity => entity.text === 'مايكروسوفت')).toEqual([
      expect.objectContaining({ kind: 'organization', turnId: 'a1', role: 'assistant' }),
      expect.objectContaining({ kind: 'organization', turnId: 'u1', role: 'user' }),
    ]);
    expect(stack).toContainEqual(expect.objectContaining({ text: '4 نيسان من عام 1975', kind: 'date', turnId: 'a1' }));
  });

  it('ranks an answer city above its country in both languages', () => {
    for (const [text, city, country] of [[EGYPT_ANSWER, 'القاهرة', 'مصر'], [JAPAN_ANSWER, 'Tokyo', 'Japan']] as const) {
      const places = record([], { text, turnId: 'a1', role: 'assistant' }).filter(entity => entity.kind === 'place');
      expect(places.map(entity => entity.text)).toEqual([city, country]);
      expect(places.every(entity => !entity.publicLookup)).toBe(true);
    }
  });

  it('keeps observed gender and numbers and ignores a citation timestamp', () => {
    const biography = record([], { text: BIOGRAPHY, turnId: 'a1', role: 'assistant' });
    expect(biography[0]).toMatchObject({ text: 'ألبرت أينشتاين', kind: 'person', gender: 'masculine' });
    const numbers = record([], { text: `37 * 24 = 888\n\n${ESTABLISHED_SOURCE}`, turnId: 'a2', role: 'assistant' });
    expect(numbers.map(entity => [entity.text, entity.kind])).toEqual([['888', 'number'], ['37', 'number'], ['24', 'number']]);
  });

  it('keeps visible Latin names in mixed text and infers a type only from context', () => {
    const mixed = record([], { role: 'assistant', turnId: 'a1',
      text: 'مياه بيضاء (الإنجليزية: White Waters) هُو فيلم دراما نيجيري صدر سنة 2007 وأخرجه إيزو أوجوكو.' });
    expect(mixed).toContainEqual(expect.objectContaining({ text: 'White Waters', kind: 'other', role: 'assistant', turnId: 'a1' }));
    const place = record([], { text: 'Remember that my home city is New York.', turnId: 'u2', role: 'user' });
    expect(place).toContainEqual(expect.objectContaining({ text: 'New York', kind: 'place', role: 'user', turnId: 'u2' }));
    const interfaceLabel = record([], { role: 'user', turnId: 'u1',
      text: 'افتح https://www.wikipedia.org ثم اكتب الطاقة الشمسية في خانة Search Wikipedia ثم اضغط زر Search ثم مرر للأسفل ثم اقرأ الصفحة' });
    expect(interfaceLabel).toEqual([]);
  });

  it('decays earlier salience and bounds the retained stack without mutating its input', () => {
    const first = record([], { text: EGYPT_ANSWER, turnId: 'a0', role: 'assistant' });
    const later = record(first, { text: JAPAN_ANSWER, turnId: 'a1', role: 'assistant' });
    expect(later[0]).toMatchObject({ text: 'Tokyo', turnId: 'a1' });
    expect(later.find(entity => entity.text === 'القاهرة')?.salience).toBeLessThan(first[0]!.salience);
    let stack = first;
    for (let i = 1; i <= 50; i++) stack = record(stack, { text: EGYPT_ANSWER, turnId: `a${i}`, role: 'assistant' });
    expect(stack.length).toBeLessThan(100);
    expect(stack.some(entity => entity.turnId === 'a0')).toBe(false);
    expect(first[0]).toMatchObject({ text: 'القاهرة', turnId: 'a0', salience: 0.98 });
  });
});
