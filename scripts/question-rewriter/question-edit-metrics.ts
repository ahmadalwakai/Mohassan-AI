export function normalizeQuestionRewrite(text: string): string {
  return text.normalize('NFC').replace(/\s+/gu, ' ').toLowerCase();
}

export function questionRewriteLiteral(text: string): string {
  return normalizeQuestionRewrite(text.trim().replace(/[.!?؟]+$/u, '').trimEnd());
}

export const questionRewriteCounts = () => ({ total: 0, exact: 0, normalizedSubstring: 0 });

export function scoreQuestionRewrite(
  counts: ReturnType<typeof questionRewriteCounts>, output: string, reference: string, literal: string,
): void {
  counts.total++;
  if (output === reference) counts.exact++;
  if (literal && normalizeQuestionRewrite(output).includes(literal)) counts.normalizedSubstring++;
}
