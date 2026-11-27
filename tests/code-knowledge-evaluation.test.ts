import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { questionTypes, type Corpus } from '../packages/code-knowledge/src/index.js';
import { excludeEvaluationThreads, scoreQuestion, type EvaluationCase } from '../scripts/code-knowledge/evaluate.js';

const question = { id: 42, type: 'api-usage', expected: [['Path.exists', 'os.path.exists'], ['file exists']] } as const;
const citation = { url: 'https://example.com/api/Path.exists' };
const answer = (sentences: string[], code: string[] = []) => ({
  status: 'answered',
  intent: 'api-usage',
  excerpts: [{ sentences, code: code.map(text => ({ text })), citation }],
}) as const;

describe('public programming question score', () => {
  it('requires every evidence group and checks selected prose and code', () => {
    expect(scoreQuestion(question, answer(['Check whether the file exists.'], ['os.path.exists(path)'])).outcome)
      .toBe('correct');
    expect(scoreQuestion(question, answer(['Check whether the file exists.'], ['os.path.existsLater(path)'])))
      .toMatchObject({ outcome: 'wrong', missing: [['Path.exists', 'os.path.exists']] });
    expect(scoreQuestion(question, answer(['Check the path.'], ['Path.exists(path)'])))
      .toMatchObject({ outcome: 'wrong', missing: [['file exists']] });
  });

  it('ignores citation text, distinguishes abstention, and retains the predicted type', () => {
    expect(scoreQuestion(question, answer(['The file exists.']))).toMatchObject({
      outcome: 'wrong',
      citations: [citation.url],
    });
    expect(scoreQuestion(question, { status: 'abstained', intent: 'error' })).toMatchObject({
      type: 'api-usage',
      predictedType: 'error',
      outcome: 'abstained',
      citations: [],
    });
  });

  it('excludes answers from evaluation threads by parent question, including slug and short URLs', () => {
    const corpus: Corpus = {
      sources: [],
      passages: [
        { id: 'answer-1', url: 'https://stackoverflow.com/a/25', questionUrl: 'https://stackoverflow.com/q/42?ref=x' },
        { id: 'answer-2', url: 'https://stackoverflow.com/questions/43/wording#28' },
        { id: 'answer-3', url: 'https://stackoverflow.com/questions/44/other' },
        { id: 'doc-1', url: 'https://example.com/questions/42/independent' },
      ].map(passage => ({ sourceId: 'source', text: '', title: 'Title', tags: [], code: [], ...passage })),
    };
    expect(excludeEvaluationThreads(corpus, [{ id: 42 }, { id: 43 }]).passages.map(({ id }) => id))
      .toEqual(['answer-3', 'doc-1']);
  });

  it('keeps the licensed, pre-ChatGPT snapshots balanced and disjoint', async () => {
    const seen = new Set<number>();
    for (const split of ['development', 'held-out']) {
      const path = new URL(`../scripts/code-knowledge/questions/${split}.json`, import.meta.url);
      const cases = JSON.parse(await readFile(path, 'utf8')) as EvaluationCase[];
      for (const type of questionTypes) expect(cases.filter(question => question.type === type)).toHaveLength(3);
      expect(cases).toHaveLength(15);
      for (const { id, source, expected } of cases) {
        expect(seen.has(id)).toBe(false);
        seen.add(id);
        expect(source.url).toMatch(new RegExp(`^https://stackoverflow.com/questions/${id}/`));
        expect(source.revision.url).toMatch(new RegExp(`^https://stackoverflow.com/revisions/${id}/\\d+$`));
        expect(source.lastEdit < '2022-11-30').toBe(true);
        expect(source.revision.date <= source.lastEdit).toBe(true);
        for (const entry of [source, source.revision]) {
          const version = /^CC BY-SA (2\.5|3\.0|4\.0)$/.exec(entry.license)?.[1];
          expect(version).toBeDefined();
          expect(entry.licenseUrl).toBe(`https://creativecommons.org/licenses/by-sa/${version}/`);
          expect(entry.author.name).not.toBe('');
          expect(entry.author.url).toMatch(/^https:\/\/stackoverflow\.com\/users\/\d+\//);
        }
        expect(expected.length).toBeGreaterThan(0);
        expect(expected.every(group => group.length > 0 && group.every(literal => literal.trim()))).toBe(true);
      }
    }
  });
});
