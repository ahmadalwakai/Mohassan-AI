import { describe, expect, it } from 'vitest';
import { importGsm8k, importMbpp } from '../scripts/agent-capability-bench/v2/math-code.js';

// All records are parser-only sentinels and are never used to evaluate chat.
const mbppRow = {
  task_id: 11,
  prompt: 'PROMPT_SENTINEL',
  code: 'def sentinel(value):\n    raise AssertionError("reference is never executed")\n',
  test_list: ['assert sentinel(2) == 3', 'assert sentinel(3) == 4'],
  test_imports: [],
};

describe('GSM8K import', () => {
  it('uses only the published question and the number on the final marker line', () => {
    const question = 'QUESTION_SENTINEL';
    const raw = JSON.stringify({ question, answer: 'SOLUTION_SENTINEL 84\n#### -1,234\n' });
    expect(importGsm8k(`${raw}\n`)).toEqual({
      dataset: 'gsm8k',
      seen: 1,
      dropped: {},
      candidates: [{
        dataset: 'gsm8k',
        key: '1',
        family: '1',
        item: {
          area: 'calculation',
          language: 'en',
          variety: 'english',
          turns: [{
            text: question,
            expect: {
              route: ['compute'],
              requiredTools: ['calculate'],
              forbiddenTools: ['search', 'read', 'open', 'unexpected_fetch'],
              questionCount: 0,
              status: ['completed'],
              requiredContent: [{ match: 'number', anyOf: ['-1234'] }],
              forbiddenContent: ['I searched the web', 'بحثت في الويب'],
              maxSteps: 2,
            },
          }],
        },
      }],
    });
  });

  it('counts invalid questions and answers without changing source ordinals', () => {
    const raw = [
      'INVALID_JSONL_ROW',
      JSON.stringify({ question: 'A', answer: '#### 123\nTRAILING_SENTINEL' }),
      JSON.stringify({ question: 'B', answer: '#### 3/4' }),
      JSON.stringify({ question: '  ', answer: '#### 0' }),
      JSON.stringify({ question: 'Q', answer: '#### 0' }),
    ].join('\r\n');
    const result = importGsm8k(raw);
    expect(result.seen).toBe(5);
    expect(result.dropped).toEqual({ 'invalid-row': 1, 'invalid-prompt': 1, 'missing-numeric-answer': 2 });
    expect(result.candidates.map(({ key }) => key)).toEqual(['5']);
  });
});

describe('MBPP import', () => {
  it('adds the published tests to the prompt and checks only the function interface', () => {
    const result = importMbpp(JSON.stringify([mbppRow]));
    expect(result.seen).toBe(1);
    expect(result.dropped).toEqual({});
    expect(result.candidates[0]).toMatchObject({
      dataset: 'mbpp',
      key: '11',
      item: {
        area: 'coding',
        language: 'en',
        turns: [{
          text: 'PROMPT_SENTINEL\n\nYour code should pass these tests:\nassert sentinel(2) == 3\nassert sentinel(3) == 4',
          expect: {
            route: ['coding'],
            status: ['completed'],
            requiredContent: [{ match: 'literal', anyOf: ['def sentinel(', 'def sentinel ('] }],
          },
        }],
      },
    });
  });

  it('counts split, import, entry point and prompt exclusions', () => {
    const result = importMbpp(JSON.stringify([
      { ...mbppRow, task_id: 10 },
      { ...mbppRow, task_id: 511 },
      { ...mbppRow, test_imports: ['import dependency'] },
      { ...mbppRow, test_list: ['assert sentinel(2) == 3', 'assert other(3) == 4'] },
      { ...mbppRow, code: 'def other(value):\n    pass' },
      { ...mbppRow, test_list: ['assert wrapper(sentinel(2))'] },
      { ...mbppRow, prompt: 'PROMPT_SENTINEL def sentinel(' },
      { ...mbppRow, prompt: 'x'.repeat(4000) },
      { ...mbppRow, test_list: [] },
    ]));
    expect(result.candidates).toEqual([]);
    expect(result.seen).toBe(9);
    expect(result.dropped).toEqual({
      'non-test-split': 2,
      'test-needs-imports': 1,
      'no-direct-entry-point': 3,
      'signature-present-in-prompt': 1,
      'invalid-prompt': 1,
      'invalid-row': 1,
    });
  });

  it('rejects a malformed source artifact without echoing its contents', () => {
    expect(() => importMbpp('PRIVATE_SENTINEL')).toThrow(/^Invalid MBPP source artifact\.$/u);
    expect(() => importMbpp('{}')).toThrow(/^Invalid MBPP source artifact\.$/u);
  });
});
