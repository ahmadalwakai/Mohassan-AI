import { describe, expect, it } from 'vitest';
import { assessRecallCoverage, recall } from '../apps/server/src/assistant/mind/recall.js';
import type { Evidence, Frame } from '../apps/server/src/assistant/mind/contract.js';
import { evaluateLocalRecall } from '../apps/server/src/assistant/local-recall.js';

const REQUEST = 'From my memory, return my preferred language only.';
const AR_REQUEST = 'من ذاكرتي، أعد لغتي المفضلة فقط.';
const memory = (quote: string) => ({ quote, source: 'memory' as const });
const frame = (text: string): Frame => ({ text, lang: 'en', intent: 'memory_recall', matched: [], personal: true,
  timeSensitive: false, valueOnly: false, missing: [], focus: [], urls: [], answerType: 'text' });
const signal = () => new AbortController().signal;

describe('preferred-language recall binds a distinct self field to host memory evidence', () => {
  it.each([
    ['I prefer Arabic.', 'Arabic'], ['أنني أفضل العربية', 'العربية'],
    ['My preferred language is English.', 'English'], ['لغتي المفضلة هي الإنجليزية.', 'الإنجليزية'],
  ])('covers and extracts only the exact literal value from %s', async (quote, value) => {
    expect(assessRecallCoverage(REQUEST, [memory(quote)])).toMatchObject({ status: 'complete', requestedProperties: ['preferred_language'],
      subjectTerms: ['self'], matchedEvidenceIndices: [0] });
    const result = await recall(frame(REQUEST), REQUEST, { memory: async () => [quote] }, signal());
    expect(result?.status).toBe('completed'); expect(result?.text).toBe(value);
    expect(result?.evidence[0]?.quote).toBe(quote.replace(/[.!]$/u, ''));
    expect(result?.evidence[0]?.source).toBe('memory');
  });
  it.each([undefined, 'knowledge', 'web'] as const)('does not promote a %s source into the owner self preference', source => {
    expect(assessRecallCoverage(REQUEST, [{ quote: 'My preferred language is Arabic.', ...(source ? { source: source as Evidence['source'] } : {}) }]).status).toBe('missing');
  });
  it.each([
    'My client preferred language is Arabic.', 'My programming language is Arabic.', 'I prefer mangoes.',
    'My preferred colour is Arabic.', 'The note says I prefer Arabic.', '"I prefer Arabic."',
    'My colleague prefers Arabic.', 'The current user prefers Arabic.',
  ])('does not infer the owner language from another field, subject or supplied/report body: %s', quote => {
    expect(assessRecallCoverage(REQUEST, [memory(quote)]).status).toBe('missing');
  });
  it('requires the current self question rather than promoting an inherited context', () => {
    expect(assessRecallCoverage('And the code?', [memory('I prefer Arabic.')], { contextTopic: REQUEST }).status).toBe('missing');
    expect(assessRecallCoverage('The message contains "From my memory, return my preferred language only." Is it clear?', [memory('I prefer Arabic.')]).status).not.toBe('complete');
  });
  it('keeps Arabic and English names for one language equivalent without translating the chosen literal value', async () => {
    const result = await recall(frame(REQUEST), REQUEST, { memory: async () => ['I prefer Arabic.', 'أنني أفضل العربية'] }, signal());
    expect(result?.status).toBe('completed'); expect(result?.text).toBe('Arabic');
    expect(result?.claims.every(claim => claim.status !== 'conflict')).toBe(true);
  });
  it('keeps different language IDs partial instead of choosing one as a verified scalar', async () => {
    const result = await recall(frame(REQUEST), REQUEST, { memory: async () => ['I prefer Arabic.', 'My preferred language is English.'] }, signal());
    expect(result?.status).toBe('partial'); expect(result?.text).not.toBe('Arabic'); expect(result?.text).not.toBe('English');
    expect(result?.claims.some(claim => claim.status === 'conflict')).toBe(true);
  });
  it('keeps an ordinary unformatted request quote-backed', async () => {
    const request = 'From my memory, what is my preferred language?';
    const result = await recall(frame(request), request, { memory: async () => ['I prefer Arabic.'] }, signal());
    expect(result?.status).toBe('completed'); expect(result?.text).toBe('From memory: «I prefer Arabic»');
  });
  it('does not use knowledge-document self text or its title for a private preference question', async () => {
    const result = await recall(frame(REQUEST), REQUEST, { knowledge: async () => [{ title: 'My preferred language', text: 'My preferred language is Arabic.', source: 'synthetic-document' }] }, signal(), { source: 'knowledge' });
    expect(result).toBeNull();
  });
  it('uses the same self evidence for the Arabic closed question', async () => {
    const result = await recall({ ...frame(AR_REQUEST), lang: 'ar' }, AR_REQUEST, { memory: async () => ['أنني أفضل العربية'] }, signal());
    expect(result?.status).toBe('completed'); expect(result?.text).toBe('العربية');
  });
  it.each([[REQUEST, 'I prefer Arabic.', 'Arabic'], [AR_REQUEST, 'أنني أفضل العربية', 'العربية']] as const)
    ('extracts the literal scalar through the real frame builder: %s', async (request, quote, value) => {
      const result = await evaluateLocalRecall(request, { memory: async () => [quote] }, signal());
      expect(result?.status).toBe('completed'); expect(result?.text).toBe(value);
    });
});
