import { containsSensitiveCredentialText } from '../sensitive-credential-text.js';
import type { JudgeVerdict } from './judge.js';
import type { JudgeShadowInput } from './judge-shadow.js';

export function keepJudgeShadowText(input: JudgeShadowInput, verdict: JudgeVerdict): boolean {
  if (input.keepText === false) return false;
  // Inspect the full input before clipping or separating excerpts from their labels.
  return ![
    input.question, input.previous, input.reply, verdict.withholdText, verdict.fixedReply,
    verdict.lead?.text, verdict.best?.text,
    ...verdict.findings.flatMap(finding => [finding.excerpt, finding.detail]),
  ].some(containsSensitiveCredentialText);
}
