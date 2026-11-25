import { describe, expect, it } from 'vitest';
import { checks, corpusProvenance, developmentConversations } from '../scripts/conversation-review/dev-conversations.js';
import { scoreCorpus } from '../scripts/conversation-review/score.js';

describe('conversation review development evaluation', () => {
  it('enumerates distinct labelled multi-turn cases with a matching clean control for every issue', () => {
    const corpus = developmentConversations();
    expect(corpusProvenance).toEqual({ split: 'development-evaluation', method: 'deterministic templates',
      modelCalls: 0, apiCalls: 0, trainingAllowed: false });
    expect(corpus).toHaveLength(288);
    expect(new Set(corpus.map(item => item.id)).size).toBe(corpus.length);
    expect(new Set(corpus.map(item => JSON.stringify([item.messages.map(message => message.content), item.draft]))).size).toBe(corpus.length);
    for (const item of corpus) {
      expect(item.messages.length).toBeGreaterThanOrEqual(3);
      expect(item.messages.at(-1)?.role).toBe('user');
      expect(item.messages.every((message, index) => message.role === (index % 2 ? 'assistant' : 'user'))).toBe(true);
    }
    for (const language of ['ar', 'en']) {
      const rows = corpus.filter(item => item.language === language);
      expect(rows).toHaveLength(144);
      expect(rows.filter(item => item.expected.length === 0)).toHaveLength(72);
      for (const check of checks) {
        expect(rows.filter(item => item.expected.includes(check))).toHaveLength(12);
      }
    }
  });

  it('uses per-check denominators and counts each finding only once per draft', () => {
    const results = scoreCorpus([
      { language: 'en', expected: ['coverage'], found: ['coverage', 'coverage'] },
      { language: 'ar', expected: ['coverage'], found: [] },
      { language: 'ar', expected: ['repetition'], found: ['repetition', 'coverage'] },
    ]);
    const coverage = results.all.find(row => row.check === 'coverage')!;
    expect(coverage.caught).toMatchObject({ count: 1, total: 2 });
    expect(coverage.falseAlarms).toMatchObject({ count: 1, total: 1 });
    expect(coverage.caught.wilson95?.[0]).toBeCloseTo(0.0945, 4);
    expect(coverage.caught.wilson95?.[1]).toBeCloseTo(0.9055, 4);
    expect(coverage.falseAlarms.wilson95?.[0]).toBeCloseTo(0.2065, 4);
    expect(coverage.falseAlarms.wilson95?.[1]).toBeCloseTo(1, 4);
    expect(results.en.find(row => row.check === 'repetition')?.caught).toEqual({ count: 0, total: 0, wilson95: null });
  });
});
