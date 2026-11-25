import { z } from 'zod';
import { ChatFeedbackSchema, FeedbackReviewSchema } from '@mohassan/contracts';
import { judge } from '../../apps/server/src/assistant/judge.js';
import { feedbackPageKey } from '../../apps/server/src/feedback-page-key.js';
import { selectFeedbackEvidence } from '../../apps/server/src/feedback-selection.js';
import { feedbackCaseSha256 } from '../../apps/server/src/feedback-store.js';

const frozenCase = z.strictObject({
  question: z.string(),
  previousQuestion: z.string().nullable(),
  reply: z.string(),
  evidenceUrls: z.array(z.string()),
  route: z.string().nullable(),
  judgeDecision: z.enum(['send', 'fix', 'withhold']).nullable(),
  status: z.string().nullable(),
  feedbackVerdict: ChatFeedbackSchema.shape.verdict,
  feedbackNote: z.string().nullable(),
  decision: FeedbackReviewSchema.shape.decision,
});

const regressionExport = z.strictObject({
  version: z.literal(1),
  purpose: z.literal('regression'),
  cases: z.array(z.strictObject({
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    case: frozenCase,
  })),
});

export function replayFeedbackRegression(serialized: string) {
  const { cases } = regressionExport.parse(JSON.parse(serialized));
  const seen = new Set<string>();
  for (const { sha256, case: sample } of cases) {
    if (seen.has(sha256) || feedbackCaseSha256(sample) !== sha256) {
      throw new Error('The feedback regression export contains a duplicate or invalid case hash.');
    }
    seen.add(sha256);
  }

  return {
    cases: cases.map(({ sha256, case: sample }) => {
      const verdict = judge({
        question: sample.question,
        previous: sample.previousQuestion,
        reply: sample.reply,
        status: sample.status,
      });
      const evidence = sample.evidenceUrls.flatMap(url => {
        const key = feedbackPageKey(url);
        return key ? [{ key, url }] : [];
      });
      const keys = new Set(evidence.map(item => item.key));
      // This reserved-domain candidate tests that an unrelated fallback survives a block
      // and that reviewed evidence can outrank it. Replay never reads or opens it.
      const fallback = { url: `https://feedback-regression.invalid/${sha256}` };
      const candidates = [fallback, ...evidence];
      const eligible = selectFeedbackEvidence({
        blocked: sample.decision === 'wrong' ? keys : new Set(),
        pinned: sample.decision === 'correct' ? keys : new Set(),
      }, candidates);
      const expected = {
        correct: [...evidence, fallback],
        wrong: [fallback],
        unsure: candidates,
      }[sample.decision];
      const matches = eligible.length === expected.length && eligible.every((item, index) => item.url === expected[index]?.url);
      return {
        sha256,
        ownerDecision: sample.decision,
        judge: {
          recordedDecision: sample.judgeDecision,
          replayDecision: verdict.decision,
          codes: verdict.codes,
          supportMeasured: verdict.support !== null,
        },
        selection: { result: evidence.length ? (matches ? 'pass' : 'fail') : 'no_evidence', checked: evidence.length },
      };
    }),
  };
}
