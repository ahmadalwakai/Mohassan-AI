/** Offline comparison on the labelled development triples, including a paired source ablation. */
import { truthCases, type TruthCase } from '../../tests/fixtures/truth-checks.js';
import { judgeTruth, TRUTH_POLICY, type TruthPolicy, type TruthVerdict } from '../../apps/server/src/assistant/truth-judge.js';

const PROFILES = ['agreement', 'corroborated', 'require_two'] as const satisfies readonly TruthPolicy[];
const Z95 = 1.959963984540054;
type Run = { item: TruthCase; verdict: TruthVerdict };

function rate(count: number, total: number) {
  if (!total) return { count, total, fraction: null, wilson95: null };
  const p = count / total;
  const zSquared = Z95 ** 2;
  const denominator = 1 + zSquared / total;
  const center = (p + zSquared / (2 * total)) / denominator;
  const half = Z95 * Math.sqrt((p * (1 - p) + zSquared / (4 * total)) / total) / denominator;
  return { count, total, fraction: p, wilson95: [Math.max(0, center - half), Math.min(1, center + half)] };
}

async function evaluate(profile: TruthPolicy, useExtra = true): Promise<Run[]> {
  return Promise.all(truthCases.map(async item => ({
    item, verdict: await judgeTruth({ ...item, lookup: useExtra ? async () => item.secondPage ?? null : undefined }, profile),
  })));
}

function caught({ item, verdict }: Run) {
  const answer = verdict.replacement?.replace(/^(?:According to one source|وفق مصدر واحد):\s*/u, '').split('\n\n', 1)[0];
  return verdict.decision === 'withhold' || Boolean(verdict.repaired && item.expectedSupported
    && answer === item.expectedSupported);
}

function summarize(runs: Run[]) {
  const wrong = runs.filter(run => !run.item.correct);
  const correct = runs.filter(run => run.item.correct);
  const numeric = runs.filter(run => run.verdict.source !== 'not_needed');
  return {
    wrongCaught: rate(wrong.filter(caught).length, wrong.length),
    correctWithheld: rate(correct.filter(run => run.verdict.decision === 'withhold').length, correct.length),
    correctRepaired: rate(correct.filter(run => run.verdict.repaired).length, correct.length),
    correctQualified: rate(correct.filter(run => run.verdict.source === 'single_source' && run.verdict.decision === 'fix').length, correct.length),
    confirmed: rate(numeric.filter(run => run.verdict.source === 'confirmed').length, numeric.length),
    conflicting: rate(numeric.filter(run => run.verdict.source === 'conflict').length, numeric.length),
    singleSource: rate(numeric.filter(run => run.verdict.source === 'single_source').length, numeric.length),
  };
}

const [agreement, withExtra, strict, noExtra] = await Promise.all([
  ...PROFILES.map(profile => evaluate(profile)),
  evaluate('corroborated', false),
]);
const paired = withExtra!.map((run, index) => ({ after: run, before: noExtra![index]! }));
const wrong = paired.filter(({ after }) => !after.item.correct);
const correct = paired.filter(({ after }) => after.item.correct);
const eligible = paired.filter(({ before }) => before.verdict.source === 'single_source');
const withResults = withExtra!;
console.log(JSON.stringify({
  policy: TRUTH_POLICY,
  cases: truthCases.length,
  scenarios: new Set(truthCases.map(item => item.scenario)).size,
  policies: { agreement: summarize(agreement!), noExtra: summarize(noExtra!), corroborated: summarize(withResults), requireTwo: summarize(strict!) },
  language: {
    ar: summarize(withResults.filter(run => run.item.language === 'ar')),
    en: summarize(withResults.filter(run => run.item.language === 'en')),
  },
  secondSource: {
    extraWrongCaught: rate(wrong.filter(({ after, before }) => caught(after) && !caught(before)).length, wrong.length),
    extraCorrectWithheld: rate(correct.filter(({ after, before }) => after.verdict.decision === 'withhold' && before.verdict.decision !== 'withhold').length, correct.length),
    confirmedAfterRead: rate(eligible.filter(({ after }) => after.verdict.source === 'confirmed').length, eligible.length),
    conflictAfterRead: rate(eligible.filter(({ after }) => after.verdict.source === 'conflict').length, eligible.length),
    remainedSingle: rate(eligible.filter(({ after }) => after.verdict.source === 'single_source').length, eligible.length),
  },
  misses: withResults.filter(run => !run.item.correct && !caught(run)).map(run => ({ id: run.item.id, ...run.verdict })),
  correctWithheld: withResults.filter(run => run.item.correct && run.verdict.decision === 'withhold').map(run => ({ id: run.item.id, ...run.verdict })),
}, null, 2));
