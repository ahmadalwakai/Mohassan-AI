import { describe, expect, it, vi } from 'vitest';
import type { CodeAnswer } from '../packages/code-knowledge/src/types.js';
import { replayCodingCases } from '../scripts/code-knowledge/capability.js';

const item = {
  id: 'coding-case', area: 'coding', language: 'en',
  turns: [{
    text: 'When is Array.prototype.flat useful?',
    expect: {
      requiredContent: [{ match: 'literal' as const, anyOf: ['Array.prototype.flat'] }],
      forbiddenContent: ['Array.prototype.reverse'],
    },
  }],
};

const answer: Extract<CodeAnswer, { status: 'answered' }> = {
  status: 'answered', intent: 'api-usage',
  excerpts: [{
    sentences: ['Use Array.prototype.flat for nested arrays.'], code: [],
    citation: { title: 'Array.prototype.flat', url: 'https://example.test/flat', sourceTitle: 'Reference', sourceUrl: 'https://example.test/',
      version: '1', fingerprint: '0'.repeat(64), license: 'CC BY-SA 3.0',
      licenseUrl: 'https://creativecommons.org/licenses/by-sa/3.0/', attribution: [] },
  }],
};

function replayFakes() {
  const observation = { setupMs: 63, turns: [{ answer: 'baseline reply', route: 'coding', steps: 0, status: 'blocked' }] };
  const observe = vi.fn(async () => observation);
  const scorer = {
    scoreCapabilityCase: vi.fn(() => ({ passed: false, failures: [{ turn: 1, stage: 'verification', check: 'run-status' }] })),
    includesLiteral: vi.fn((text: string, value: string) => text.toLowerCase().includes(value.toLowerCase())),
    includesNumber: vi.fn((text: string, value: string) => text.split(/\s+/u).includes(value)),
  };
  return { observation, observe, scorer };
}

describe('code knowledge capability replay', () => {
  it('scores only coding cases and preserves controller observations while replacing reply text', async () => {
    const { observation, observe, scorer } = replayFakes();
    const shadow = { observe: vi.fn(() => answer) };
    const result = await replayCodingCases([{ ...item, area: 'memory' }, item], observe, scorer, shadow);

    expect(observe).toHaveBeenCalledExactlyOnceWith(item);
    expect(shadow.observe).toHaveBeenCalledExactlyOnceWith(item.turns[0]?.text, { caseId: item.id });
    expect(scorer.scoreCapabilityCase.mock.calls).toEqual([
      [item, observation],
      [item, { ...observation, turns: [{ ...observation.turns[0], answer: expect.stringContaining('https://example.test/flat') }] }],
    ]);
    expect(observation.turns[0]?.answer).toBe('baseline reply');
    expect(result.summary).toEqual({ cases: 1, baselinePassed: 0, replayPassed: 0, correct: 1, wrong: 0, abstained: 0 });
  });

  it('reports a citation-only match as wrong and an abstention as an empty replay reply', async () => {
    const { observe, scorer } = replayFakes();
    const shadow = { observe: vi.fn<() => CodeAnswer>()
      .mockReturnValueOnce({ ...answer, excerpts: answer.excerpts.map(excerpt => ({
        ...excerpt, sentences: ['Use Array.prototype.reverse for nested arrays.'],
      })) })
      .mockReturnValueOnce({ status: 'abstained', intent: 'api-usage', reason: 'insufficient-evidence' }) };
    const result = await replayCodingCases([item, { ...item, id: 'abstained-case' }], observe, scorer, shadow);

    expect(result.summary).toMatchObject({ correct: 0, wrong: 1, abstained: 1 });
    expect(result.cases[0]?.turns[0]?.failures).toEqual(['required-content-1', 'forbidden-content-1']);
    expect(scorer.scoreCapabilityCase.mock.calls[3]).toMatchObject([expect.anything(), { turns: [{ answer: '' }] }]);
  });

  it('passes numeric expectations and unchanged source code to the original matchers', async () => {
    const { observe, scorer } = replayFakes();
    const code = 'const value = 2;\n';
    const shadow = { observe: vi.fn(() => ({ ...answer, excerpts: answer.excerpts.map(excerpt => ({
      ...excerpt, code: [{ text: code, language: 'javascript' }],
    })) })) };
    const result = await replayCodingCases([{ ...item, turns: [{ text: item.turns[0]!.text, expect: {
      forbiddenContent: [], requiredContent: [{ match: 'number', anyOf: ['2'] }],
    } }] }], observe, { ...scorer, includesNumber: scorer.includesNumber.mockReturnValue(true) }, shadow);

    expect(scorer.includesNumber).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(code), '2');
    expect(result.summary.correct).toBe(1);
  });

  it('does not send a structured approval or an empty turn to the answer path', async () => {
    const { observe, scorer } = replayFakes();
    const shadow = { observe: vi.fn(() => answer) };
    const result = await replayCodingCases([{ ...item, turns: [
      { ...item.turns[0]!, approve: true }, { ...item.turns[0]!, text: '' },
    ] }], observe, scorer, shadow);

    expect(shadow.observe).not.toHaveBeenCalled();
    expect(result.summary.abstained).toBe(1);
  });
});
