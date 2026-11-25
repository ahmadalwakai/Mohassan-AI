import { describe, expect, it } from 'vitest';
import type { KnowledgeAnswer, KnowledgeFact, KnowledgeValue } from '../packages/knowledge-base/src/qa-types.ts';
import { scoreAnswer } from '../scripts/knowledge-base/qa/score.ts';

const dumpDate = '2026-11-25';
const fact: KnowledgeFact = {
  entityId: 'Q31', property: 'P36',
  statement: { id: 'Q31$statement', rank: 'normal', property: 'P36',
    snak: { property: 'P36', snaktype: 'value' }, qualifiers: {}, references: [] },
  references: [], dates: { snapshot: dumpDate, qualifiers: [], references: [] },
  source: { dataset: 'wikidata', dumpSource: 'https://example.org', dumpDate, fingerprint: 'test',
    license: 'CC0-1.0', revision: 10, url: 'https://www.wikidata.org/wiki/Special:PermanentLink/10' },
};

function answered(values: KnowledgeValue[], facts = [fact]): KnowledgeAnswer {
  const property = { id: 'P36', label: { en: 'capital', ar: 'عاصمة' }, answerType: 'entity' } as const;
  return { status: 'answered', language: 'en', text: '', searched: [], facts, values,
    question: { kind: 'lookup', language: 'en', entity: { text: 'Belgium' }, expected: 'entity', property } };
}

describe('public knowledge QA scoring', () => {
  it('uses exact sets of Wikidata IDs and ignores presentation labels', () => {
    const a = { kind: 'entity', id: 'Q31', label: 'بلجيكا' } as const;
    const b = { kind: 'entity', id: 'Q55', label: 'Netherlands' } as const;
    expect(scoreAnswer({ kind: 'entity', values: ['Q55', 'Q31'] }, answered([a, b]))).toBe('correct');
    expect(scoreAnswer({ kind: 'entity', values: ['Q31'] }, answered([a, b]))).toBe('incorrect');
    expect(scoreAnswer({ kind: 'entity', values: ['Q31'] }, answered([a], []))).toBe('missing-evidence');
  });

  it('scores exact decimal values and honors gold date precision', () => {
    const quantity = { kind: 'quantity', amount: '+123456789012345678901.20', unit: '1' } as const;
    expect(scoreAnswer({ kind: 'quantity', values: ['123456789012345678901.2'] }, answered([quantity]))).toBe('correct');
    const date = { kind: 'date', year: 2020, month: 2, day: 29, calendar: 'Q1985727',
      raw: '+2020-02-29T00:00:00Z', precision: 11 } as const;
    expect(scoreAnswer({ kind: 'date', values: ['2020'] }, answered([date]))).toBe('correct');
    expect(scoreAnswer({ kind: 'date', values: ['2020-02-28'] }, answered([date]))).toBe('incorrect');
  });

  it('preserves unresolved status for abstention and choice metrics', () => {
    const result = answered([]);
    expect(scoreAnswer({ kind: 'boolean', values: [true] }, { ...result, status: 'abstained', reason: 'unsupported-question' }))
      .toBe('abstained');
    expect(result.status).toBe('answered');
    if (result.status === 'answered') {
      expect(scoreAnswer({ kind: 'entity', values: ['Q31'] }, { ...result, status: 'choice', mention: 'Belgium', candidates: [] }))
        .toBe('choice');
    }
  });
});
