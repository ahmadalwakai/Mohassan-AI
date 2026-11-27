import { formatAnswer, type Citation, type CodeBlock, type QuestionType } from '@mohassan/code-knowledge';

export interface TestDrivenCodingEvidence {
  readonly intent: QuestionType;
  readonly citation: Citation;
  readonly sentences: readonly string[];
  readonly code: Readonly<CodeBlock>;
  readonly locale: 'ar' | 'en';
}

export function formatTestDrivenCodingEvidence(evidence: TestDrivenCodingEvidence): string {
  const { intent, citation, sentences, code, locale } = evidence;
  return formatAnswer({ status: 'answered', intent, excerpts: [{ citation, sentences, code: [code] }] }, locale);
}
