import { describe, expect, it, vi } from 'vitest';
import { combineQuestionRewrites } from '../apps/server/src/assistant/question-rewrite-order.js';

const question = 'Which herbs did she grow by the millpond?';
const ruleRewrite = 'Which herbs did Ada grow by the millpond?';
const modelRewrite = 'Which herbs did Ada Redfern grow by the millpond?';

describe('combining question edits', () => {
  it('keeps the first available rewrite in the selected order', () => {
    const rules = vi.fn(() => ruleRewrite);
    const model = vi.fn(() => modelRewrite);
    expect(combineQuestionRewrites(question, 'rules-first', rules, model)).toBe(ruleRewrite);
    expect(model).not.toHaveBeenCalled();
    rules.mockClear();
    expect(combineQuestionRewrites(question, 'model-first', rules, model)).toBe(modelRewrite);
    expect(rules).not.toHaveBeenCalled();
  });

  it('tries the other path when the first one abstains', () => {
    expect(combineQuestionRewrites(question, 'rules-first', () => question, () => modelRewrite)).toBe(modelRewrite);
    expect(combineQuestionRewrites(question, 'model-first', () => ruleRewrite, () => null)).toBe(ruleRewrite);
    expect(combineQuestionRewrites(` ${question} `, 'model-first', () => question, () => null)).toBe(question);
  });
});
