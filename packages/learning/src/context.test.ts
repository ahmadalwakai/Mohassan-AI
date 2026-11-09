import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { escapedContextLength, knowledgeChunks, selectKnowledgeChunks, knowledgeContextEntry, lessonContextEntry, serializeLearningContext, type KnowledgeContextDocument } from './context.ts';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const document = (text: string): KnowledgeContextDocument => ({ id: 'doc', version: 3, title: 'Handbook', text, contentHash: hash(text), sourceHash: hash(text) });

describe('shared learning context policy', () => {
  it('selects relevant tail content and preserves full document and chunk hashes', () => {
    const doc = document('Irrelevant preface.\n'.repeat(500) + '\nQuantum relay code ZX-418.\n');
    const chunks = knowledgeChunks(doc.text);
    expect(chunks.map(chunk => chunk.text).join('')).toBe(doc.text);
    const selected = selectKnowledgeChunks([doc], 'quantum relay code');
    expect(selected[0].text).toContain('ZX-418');
    expect(selected[0].source).not.toMatch(/#0$/);
    expect(selected[0].documentHash).toBe(doc.contentHash);
    expect(selected[0].hash).toBe(hash(selected[0].text));
    expect(selectKnowledgeChunks([doc], 'unmentioned subject')).toEqual([]);
    expect(() => selectKnowledgeChunks([{ ...doc, contentHash: 'f'.repeat(64) }], 'quantum')).toThrow('LEARNING_DOCUMENT_HASH_MISMATCH');
  });

  it('fits complete entries in the escaped budget without dropping a later fitting entry', () => {
    const tooLarge = lessonContextEntry({ id: 'large', text: '<'.repeat(1000) });
    const small = knowledgeContextEntry(selectKnowledgeChunks([document('The relay code is ZX-418.')], 'relay')[0]);
    const encoded = serializeLearningContext([tooLarge, small]);
    expect(escapedContextLength(encoded)).toBeLessThanOrEqual(3200);
    const parsed = JSON.parse(encoded);
    expect(parsed).toMatchObject({ trust: 'untrusted', permissionsGranted: false, entries: [small] });
    expect(serializeLearningContext([tooLarge])).toBe('');
    expect(serializeLearningContext([small], 10)).toBe('');
  });
});
