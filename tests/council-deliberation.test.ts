import { ModelCouncilSchema } from '@mohassan/contracts';
import { describe, expect, it } from 'vitest';
import {
  councilModelReply, decideCouncilDiscussion, proposeCouncilAnswers, uncertainCouncilReply,
  type CouncilCheck, type CouncilProposal, type CouncilVote,
} from '../apps/server/src/assistant/council-deliberation.js';

// Fictional source and measurement fixtures. They are only inputs to the referee tests.
const question = 'When was Marlow Library founded?';
const priorDate = '2000';
const founded = '2083';
const quote = `Marlow Library was founded in ${founded}.`;
const url = 'https://example.org/marlow';
const page = { kind: 'page' as const, title: 'Marlow Library', url, text: `${quote} Marlow Library closed in 2089.` };
const candidates = [
  { member: 'pipeline', answer: `Marlow Library was founded in ${priorDate}.` },
  { member: 'reader-a', answer: founded },
  { member: 'reader-b', answer: founded },
  { member: 'reader-c', answer: 'Unknown' },
];

const measured = (weight: number): CouncilVote => ({ weight, weightSource: 'Fixture date accuracy', measured: true });
const missing: CouncilVote = { weight: 0, weightSource: 'Minimum weight: no matching receipt', measured: false };

function discussion(overrides: {
  proposals?: CouncilProposal[];
  checks?: CouncilCheck[];
  votes?: Record<string, CouncilVote>;
  pipelineStands?: boolean;
  keepPipeline?: boolean;
  allowReplacement?: boolean;
} = {}) {
  return decideCouncilDiscussion({
    question, previous: null, evidence: [page], proposals: overrides.proposals ?? proposeCouncilAnswers(candidates, [page]),
    checks: overrides.checks ?? [], pipelineStands: overrides.pipelineStands ?? true, keepPipeline: overrides.keepPipeline ?? false,
    allowReplacement: overrides.allowReplacement,
    vote: member => overrides.votes?.[member] ?? missing,
  });
}

describe('council deliberation rounds', () => {
  it('records exact proposals, the verifier checks, vote receipts, and a valid version 1 decision', () => {
    const learnedCheck = { checker: 'reading-abstain-verifier', member: 'reader-a', verdict: 'supports' } as const;
    const result = discussion({
      checks: [learnedCheck],
      votes: { pipeline: measured(0.9), 'reader-a': measured(0.6), 'reader-b': measured(0.5) },
    });

    expect(result.proposals).toEqual([
      candidates[0],
      { member: 'reader-a', answer: founded, evidenceQuote: quote, evidenceUrl: url },
      { member: 'reader-b', answer: founded, evidenceQuote: quote, evidenceUrl: url },
      { member: 'reader-c', answer: '' },
    ]);
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ checker: 'evidence', member: 'reader-a', verdict: 'supports' }),
      expect.objectContaining({ checker: 'judge', member: 'reader-a', verdict: 'supports' }),
      learnedCheck,
    ]));
    expect(result.votes).toContainEqual({ member: 'reader-a', weight: 0.6, weightSource: 'Fixture date accuracy' });
    expect(result.decision.chosen).toBe('reader-a');
    expect(councilModelReply(result.proposals[1]!, 'en')).toContain(url);

    const oldRecord = { version: 1, chosen: 'pipeline', changed: false, reason: 'Pipeline stands.', elapsedMs: 0, members: [] };
    expect(ModelCouncilSchema.parse(oldRecord)).toEqual(oldRecord);
    const newRecord = { ...oldRecord, chosen: result.decision.chosen, changed: true, discussion: result };
    expect(ModelCouncilSchema.parse(newRecord)).toEqual(newRecord);
  });

  it('keeps the pipeline for equal support, a lone answer, and missing comparable receipts', () => {
    expect(discussion({ votes: { pipeline: measured(0.3), 'reader-a': measured(0.1), 'reader-b': measured(0.2) } }).decision.chosen)
      .toBe('pipeline');
    expect(discussion({
      proposals: proposeCouncilAnswers(candidates.slice(0, 2), [page]),
      votes: { pipeline: measured(0.2), 'reader-a': measured(0.9) },
    }).decision.chosen).toBe('pipeline');
    expect(discussion({ votes: { 'reader-a': measured(0.9), 'reader-b': measured(0.9) } }).decision.chosen).toBe('pipeline');
    const unmeasured = discussion();
    expect(unmeasured.votes).toContainEqual({ member: 'reader-a', weight: 0, weightSource: missing.weightSource });
    expect(unmeasured.decision.chosen).toBe('pipeline');
  });

  it('withholds uncited and contradicted proposals, even with high weights', () => {
    const votes = { 'reader-a': measured(1), 'reader-b': measured(1) };
    const forged = [candidates[1]!, candidates[2]!].map(candidate => ({
      ...candidate, evidenceQuote: quote, evidenceUrl: 'https://example.com/other-page',
    }));
    const unverified = discussion({ proposals: forged, votes, pipelineStands: false });
    expect(unverified.decision.chosen).toBe('uncertain');
    expect(unverified.checks).toContainEqual(expect.objectContaining({
      checker: 'evidence', member: 'reader-a', verdict: 'unsure',
    }));

    expect(discussion({
      checks: [{ checker: 'slot-date-place-tagger', member: 'reader-a', verdict: 'contradicts' }],
      votes, pipelineStands: false,
    }).decision.chosen).toBe('uncertain');
  });

  it('does not take a different event date from the same page as evidence of founding', () => {
    const wrongDate = '2089';
    const proposals = proposeCouncilAnswers([
      { member: 'reader-a', answer: wrongDate }, { member: 'reader-b', answer: wrongDate },
    ], [page]);
    const result = discussion({ proposals, votes: { 'reader-a': measured(1), 'reader-b': measured(1) }, pipelineStands: false });
    expect(result.checks).toContainEqual(expect.objectContaining({ checker: 'judge', member: 'reader-a', verdict: 'contradicts' }));
    expect(result.decision.chosen).toBe('uncertain');
  });

  it('does not treat co-occurrence or an unrelated location as a supported answer', () => {
    function checkPlaces(question: string, text: string, answer: string) {
      const evidence = [{ ...page, text }];
      const proposals = proposeCouncilAnswers([{ member: 'reader-a', answer }, { member: 'reader-b', answer }], evidence);
      return decideCouncilDiscussion({
        question, previous: null, evidence, proposals, checks: [], pipelineStands: false, keepPipeline: false,
        vote: () => measured(1),
      });
    }
    const question = 'What is the capital of Northland?';
    expect(checkPlaces(question, 'Orin is the capital of Northland.', 'Orin').decision.chosen).toBe('reader-a');
    expect(checkPlaces(question, 'Orin is the capital of Northland, and Masan is a city in Northland.', 'Masan').decision.chosen)
      .toBe('uncertain');
    expect(checkPlaces('Where is Marlow Library located?', 'Marlow Library is located in Noran. Its archive is in Masan.', 'Masan').decision.chosen)
      .toBe('uncertain');
  });

  it('rejects an extracted fragment whose original sentence changes its meaning', () => {
    const misleading = { ...page, text: `It is a mistake to claim that ${quote}` };
    const proposals = proposeCouncilAnswers([{ member: 'reader-a', answer: founded, evidence: { quote, url } }], [misleading]);
    expect(proposals).toEqual([{ member: 'reader-a', answer: '' }]);
  });

  it('records advice without replacing the result of a specialized task', () => {
    const result = discussion({
      allowReplacement: false, pipelineStands: false,
      votes: { 'reader-a': measured(1), 'reader-b': measured(1) },
    });
    expect(result.decision).toMatchObject({ chosen: 'pipeline', reasonEn: expect.stringContaining('provided advice') });
    expect(result.checks).toContainEqual(expect.objectContaining({ checker: 'judge', member: 'reader-a', verdict: 'supports' }));
  });

  it('does not cite negated claims, partial numeric spans, or non-page evidence', () => {
    const pages = [
      { kind: 'page' as const, url, text: 'The index recorded 12.5 units. Marlow Library was not founded in 12.' },
      { kind: 'knowledge' as const, url, text: 'The index read 12 units.' },
    ];
    expect(proposeCouncilAnswers([{ member: 'reader-a', answer: '12' }], pages)).toEqual([{ member: 'reader-a', answer: '' }]);
  });

  it('keeps usable pipeline partial replies and includes the pages in uncertainty replies', () => {
    expect(discussion({ pipelineStands: false, keepPipeline: true }).decision.chosen).toBe('pipeline');
    expect(uncertainCouncilReply('en', [page, page])).toBe(
      `I could not verify an answer.\n\n**Source:** [Marlow Library](${url})`,
    );
  });
});
