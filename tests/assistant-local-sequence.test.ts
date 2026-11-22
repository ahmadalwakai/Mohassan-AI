import { describe, expect, it } from 'vitest';
import { evaluateLocalSequence, MAX_SEQUENCE_PARTS } from '../apps/server/src/assistant/local-sequence.js';
import type { SelfFacts } from '../apps/server/src/assistant/self-knowledge.js';

const now = new Date('2026-11-22T17:00:00Z');
const self: SelfFacts = {
  chatModel: false, web: true, browser: true, computation: true, memory: true, knowledge: false, documents: true, sites: true,
  skills: true, ads: true, imageReading: true, pc: true, planner: true, letters: true,
};
const run = (request: string) => evaluateLocalSequence(request, { now, self });

// Several requests in one message, each answered by the host itself, joined in the order asked. The wording is this
// test's own; the real request was rq039 of the frozen set of 2026-11-22.
describe('a message of several local requests', () => {
  it('answers a calculation and then a short question about the tools, in order', () => {
    const result = run('كم ناتج ٨ ضرب ٩؟ ثم قل لي باختصار ما الأدوات التي تستطيع استخدامها');
    expect(result?.status).toBe('completed');
    expect(result?.parts.map(part => part.source)).toEqual(['computation', 'self']);
    const [first, second] = result!.text.split('\n\n');
    expect(first).toBe('8 * 9 = 72');
    expect(second).toMatch(/^الأدوات التي أستطيع استخدامها الآن في هذه المحادثة: /u);
    expect(second.match(/\.(?=\s|$)/gu)).toHaveLength(2);
  });

  it('answers in English after «then»', () => {
    const result = run('What is 15 + 27? Then, what can you do?');
    expect(result?.status).toBe('completed');
    expect(result?.text).toMatch(/^15 \+ 27 = 42\n\nThis is what I can do now in this conversation/u);
  });

  it('takes the parts in the order asked, a question first and a calculation after it', () => {
    const result = run('ما هي قدراتك؟ ثم احسب ٣ × ٣');
    expect(result?.parts.map(part => part.source)).toEqual(['self', 'computation']);
    expect(result?.text.split('\n\n').at(-1)).toBe('3 * 3 = 9');
  });

  it('answers two questions about the assistant, not only the first', () => {
    const result = run('Who made you? Then what are your abilities?');
    expect(result?.parts.map(part => part.source)).toEqual(['self', 'self']);
    expect(result?.text).toContain('Ahmad Alwakai');
    expect(result?.text).toContain('This is what I can do now in this conversation');
  });

  it(`takes up to ${MAX_SEQUENCE_PARTS} parts`, () => {
    const result = run('احسب ١ + ١ ثم ما قدراتك؟ ثم احسب ٢ + ٢ ثم من صنعك؟');
    expect(result?.parts.map(part => part.source)).toEqual(['computation', 'self', 'computation', 'self']);
    expect(result?.text.split('\n\n')[0]).toBe('1 + 1 = 2');
  });

  it('is partial when one part is an understood boundary', () => {
    const result = run('احسب ٧ ÷ ٠ ثم ما هي أدواتك؟');
    expect(result?.status).toBe('partial');
    expect(result?.text).toMatch(/^القسمة على صفر غير معرّفة\./u);
  });

  it.each([
    ['a part that needs the web', 'احسب ٥ + ٣ ثم ابحث عن عاصمة فرنسا'],
    ['a follow-up action', 'احسب ٢٥٠ + ١٧٥ ثم أرسل النتيجة إلى سامي'],
    ['a part that needs a writing model', 'احسب ٢ × ٢ ثم اكتب قصيدة عن البحر'],
    ['a question about the assistant and free writing', 'من صنعك؟ ثم اكتب لي قصة'],
    ['one calculation', 'كم حاصل ١٧ × ٢٣؟'],
    ['one question about the assistant', 'ما قدراتك؟'],
    ['a greeting before a question', 'مرحبا. ما قدراتك؟'],
    ['more parts than the limit', 'احسب ١ + ١ ثم ما قدراتك؟ ثم احسب ٢ + ٢ ثم من صنعك؟ ثم احسب ٣ + ٣'],
  ])('leaves %s to the other routes', (_, request) => {
    expect(run(request)).toBeNull();
  });
});
