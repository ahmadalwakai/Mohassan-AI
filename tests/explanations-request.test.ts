import { describe, expect, it } from 'vitest';
import { parseExtractiveWriting } from '../apps/server/src/assistant/writing/request.js';

describe('explanation requests', () => {
  it('keeps direction and Unicode wording in public search questions', () => {
    expect(parseExtractiveWriting('Why does a metal bridge expand in summer?')).toMatchObject({
      kind: 'explanation', intent: 'why', topic: 'a metal bridge expand in summer',
      source: { kind: 'search', query: 'Why does a metal bridge expand in summer' },
    });
    expect(parseExtractiveWriting('لماذا تتمدّد المعادن عند التسخين؟')).toMatchObject({
      kind: 'explanation', language: 'ar', intent: 'why',
      source: { kind: 'search', query: 'لماذا تتمدّد المعادن عند التسخين' },
    });
    expect(parseExtractiveWriting('How do clouds form?')).toMatchObject({
      kind: 'explanation', intent: 'how', topic: 'clouds form',
      source: { kind: 'search', query: 'How do clouds form' },
    });
  });

  it('keeps the exact public address as the source of a read-and-answer request', () => {
    const url = 'https://example.org/Handbook?edition=Summer';
    expect(parseExtractiveWriting(`Read ${url} and tell me how a seed germinates.`))
      .toMatchObject({ kind: 'explanation', intent: 'how', opensSource: true, source: { kind: 'urls', urls: [url] } });
    expect(parseExtractiveWriting(`اقرأ ${url} وقولي إزاي يحدث الإنبات؟`))
      .toMatchObject({ kind: 'explanation', intent: 'how', language: 'ar', opensSource: true, source: { kind: 'urls', urls: [url] } });
    expect(parseExtractiveWriting(`Open ${url}. Compare the leaf shapes of ash and elm.`))
      .toMatchObject({ kind: 'comparison', opensSource: true, subjects: ['ash', 'elm'], source: { kind: 'urls', urls: [url] } });
    expect(parseExtractiveWriting(`Open ${url} and tell me which sensor runs longer.`))
      .toMatchObject({ kind: 'comparison', opensSource: true });
  });

  it('permits prepositional sequences in a mechanism question and rejects subsequent actions', () => {
    const prompt = 'كيف ينتقل الماء من الخزان إلى المرشّح ثم إلى الأنابيب';
    expect(parseExtractiveWriting(`${prompt}؟`)).toMatchObject({
      kind: 'explanation', intent: 'how', source: { kind: 'search', query: prompt },
    });
    expect(parseExtractiveWriting(`${prompt} ثم أرسل الجواب.`)).toBeNull();
    expect(parseExtractiveWriting('How does water move from the tank into a filter, then into pipes?'))
      .toMatchObject({ kind: 'explanation', intent: 'how' });
  });

  it('leaves private, numeric, conversational, and mixed effect requests in their existing paths', () => {
    const url = 'https://example.org/Handbook';
    for (const prompt of [
      'Why did my account get locked?', 'How many leaves does the plant have?', 'How high is the bridge?',
      'How are you?', 'Why does it change?', 'How do I work with Markdown?', 'How about ferns?',
      'How does our payroll system work?', 'Explain why we missed the deadline.',
      `Open ${url} and tell me who wrote this book.`,
      `Open ${url} and explain why roots grow down, then save the answer.`,
      `Open ${url} and explain how leaves develop and click Subscribe.`,
      `Read ${url} and explain how leaves develop using https://example.net/reference.`,
      'Explain why my project failed and publish the result.',
      'How does an engine work and then email the explanation?',
    ]) expect(parseExtractiveWriting(prompt), prompt).toBeNull();
  });
});
