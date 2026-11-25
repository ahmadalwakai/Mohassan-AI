export type QuestionRewriteOrder = 'rules-first' | 'model-first';

/** A rewrite path abstains when it returns the unchanged question or no proposal. */
export function combineQuestionRewrites(question: string, order: QuestionRewriteOrder,
  rules: () => string, model: () => string | null): string {
  const original = question.trim();
  const [first, second] = order === 'rules-first' ? [rules, model] : [model, rules];
  const proposal = first();
  return proposal && proposal !== original ? proposal : second() || original;
}
