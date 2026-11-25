import { describe, expect, it } from 'vitest';
import { feedbackCaseSha256, type FeedbackRegressionCase } from '../apps/server/src/feedback-store.js';
import { replayFeedbackRegression } from '../scripts/quality/replay-feedback.js';

const page = 'https://example.org/forest';
const wrong: FeedbackRegressionCase = {
  question: 'ما عاصمة كندا؟',
  previousQuestion: null,
  reply: `تمتد الغابات على مساحات واسعة من البلاد.\n\n**المصدر:** [غابة](${page})`,
  evidenceUrls: [page],
  route: 'research',
  judgeDecision: 'send',
  status: 'completed',
  feedbackVerdict: 'wrong',
  feedbackNote: 'لا يجيب الرد عن العاصمة.',
  decision: 'wrong',
};

const envelope = (...cases: FeedbackRegressionCase[]) => ({
  version: 1,
  purpose: 'regression',
  cases: cases.map(sample => ({ sha256: feedbackCaseSha256(sample), case: sample })),
});

describe('feedback regression replay', () => {
  it('judges the frozen reply and checks that the evidence selector preserves fallback order', () => {
    const right: FeedbackRegressionCase = {
      ...wrong,
      reply: 'أوتاوا هي عاصمة كندا.',
      feedbackVerdict: 'useful',
      decision: 'correct',
    };
    const unsure: FeedbackRegressionCase = { ...wrong, decision: 'unsure' };
    const noEvidence: FeedbackRegressionCase = { ...unsure, evidenceUrls: [] };
    const serialized = JSON.stringify(envelope(wrong, right, unsure, noEvidence));
    const report = replayFeedbackRegression(serialized);

    expect(report).toEqual(replayFeedbackRegression(serialized));
    expect(report.cases.map(row => row.selection.result)).toEqual(['pass', 'pass', 'pass', 'no_evidence']);
    expect(report.cases[0]?.judge).toMatchObject({
      recordedDecision: 'send',
      replayDecision: 'withhold',
      codes: expect.arrayContaining(['lead_off_topic']),
      supportMeasured: false,
    });
    expect(JSON.stringify(report)).not.toContain(wrong.feedbackNote);
  });

  it('rejects changed cases, repeated hashes and the training export', () => {
    const exportFile = envelope(wrong);
    expect(() => replayFeedbackRegression(JSON.stringify({
      ...exportFile,
      cases: [{ ...exportFile.cases[0], case: { ...wrong, reply: 'Edited reply' } }],
    }))).toThrow('invalid case hash');
    expect(() => replayFeedbackRegression(JSON.stringify(envelope(wrong, wrong)))).toThrow('duplicate');
    expect(() => replayFeedbackRegression(JSON.stringify({ ...exportFile, purpose: 'training' }))).toThrow();
  });
});
