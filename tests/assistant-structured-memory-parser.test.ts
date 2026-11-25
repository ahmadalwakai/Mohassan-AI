import { describe, expect, it } from 'vitest';
import { parseStructuredMemoryRequest, structuredMemoryInstruction } from '../apps/server/src/assistant/structured-memory-parser.js';

describe('natural structured memory requests', () => {
  it('normalizes a new owned name to the same target in a declaration, recall, correction and forget request', () => {
    const target = { subject: 'entity:sailing club', property: 'name' };
    expect(parseStructuredMemoryRequest('Please remember our sailing club is named Tide Mill.')).toMatchObject({
      kind: 'statement', target, value: 'Tide Mill', explicit: true,
    });
    expect(parseStructuredMemoryRequest('What is the recorded name of our sailing club?')).toMatchObject({
      kind: 'recall', target,
    });
    expect(parseStructuredMemoryRequest('What is our sailing club’s name?')).toEqual({ kind: 'recall', target });
    expect(parseStructuredMemoryRequest('Correct our sailing club’s name to Star Point.')).toMatchObject({
      kind: 'correction', target, value: 'Star Point',
    });
    expect(parseStructuredMemoryRequest('Erase our sailing club’s name from your memory.')).toEqual({ kind: 'forget', target });
    expect(parseStructuredMemoryRequest('Forget our sailing club name.')).toEqual({ kind: 'forget', target });
  });

  it('accepts dialectal directives and Arabic noun sentences and preserves the original value', () => {
    expect(parseStructuredMemoryRequest('خلي ببالك إن لون دراجتي أَخضَر زيتوني.')).toMatchObject({
      kind: 'statement', target: { subject: 'entity:دراجه', property: 'color' }, value: 'أَخضَر زيتوني', explicit: true,
    });
    expect(parseStructuredMemoryRequest('سجّل أن لغتنا المفضّلة هي الفرنسية.')).toMatchObject({
      kind: 'statement', target: { subject: 'user', property: 'language' }, value: 'الفرنسية', explicit: true,
    });
    expect(parseStructuredMemoryRequest('افتكر إن موعد مراجعة التصميم الخميس.')).toMatchObject({
      kind: 'statement', target: { subject: 'entity:مراجعه تصميم', property: 'deadline' }, value: 'الخميس', explicit: true,
    });
  });

  it('captures open descriptors and routes explicit prior-memory references to read-only semantic lookup', () => {
    expect(parseStructuredMemoryRequest('Store this: our preferred rehearsal location is the annex.')).toMatchObject({
      kind: 'statement', target: { subject: 'user', property: 'descriptor:rehearsal location preference' }, value: 'the annex',
    });
    expect(parseStructuredMemoryRequest('Which holiday destination did I ask you to keep in mind?')).toMatchObject({
      kind: 'recall', query: expect.stringContaining('holiday destination'),
    });
    expect(parseStructuredMemoryRequest('ما لون الدراجة اللي حافظه عندك؟')).toMatchObject({
      kind: 'recall', target: { subject: 'entity:دراجه', property: 'color' },
    });
  });

  it('accepts a repeated save confirmation while keeping extra actions outside fact writes', () => {
    const text = 'Remember that the parcel identifier is XM-68.';
    expect(structuredMemoryInstruction(`${text} احفظه.`)).toBe(text);
    expect(parseStructuredMemoryRequest(`${text} احفظه.`)).toMatchObject({
      kind: 'statement', statement: 'the parcel identifier is XM-68.', value: 'XM-68',
    });
    expect(parseStructuredMemoryRequest(`${text} Send it to my landlord.`).kind).toBe('none');
    expect(parseStructuredMemoryRequest('Remember my workshop’s entry code is TestOnly.').kind).toBe('secret');
  });

  it('leaves questions about retained documents to the document handler', () => {
    expect(parseStructuredMemoryRequest('In the saved inspection report, what was the assessed value?').kind).toBe('none');
    expect(parseStructuredMemoryRequest('كم صفحة في الملف المحفوظ عندي؟').kind).toBe('none');
  });
});
