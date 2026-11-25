/** Offline, evaluation-only measurements for the deterministic response policy. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { decideResponsePolicy, POLICY_RECENT_TURNS } from '../../apps/server/src/assistant/response-policy.js';

const agentWrittenSha256 = 'e59e2dab99832c61e4216d67e22ac8301cf596ffb8f3afec9fb13668fc925ddc';
const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

const dimensions = ['followUp', 'context', 'work'] as const;
type Dimension = typeof dimensions[number];
type Language = 'ar' | 'en';
interface Labels {
  followUp: 'none' | 'clarify' | 'next_step';
  context: 'recent' | 'full';
  work: 'inline' | 'autonomous';
}
interface AgentCase {
  id: string;
  text: string;
  language: Language;
  turnCount: number;
  clarification?: 'blocking';
  expected: Labels;
}

interface Count { matches: number; total: number }
const emptyCount = (): Count => ({ matches: 0, total: 0 });
const score = (count: Count, match: boolean) => {
  count.total++;
  if (match) count.matches++;
};
const summary = (count: Count) => ({ ...count, agreement: count.matches / count.total });

async function evaluateAgentWritten() {
  const data = await readFile(new URL('./decision-cases.jsonl', import.meta.url));
  if (digest(data) !== agentWrittenSha256) throw new Error('Agent-written case freeze checksum mismatch');
  const cases = data.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line) as AgentCase);
  const languages: Language[] = ['ar', 'en'];

  const results = Object.fromEntries(dimensions.map(dimension => [
    dimension, { all: emptyCount(), ar: emptyCount(), en: emptyCount() },
  ])) as Record<Dimension, Record<Language | 'all', Count>>;
  const byLabel: Record<Dimension, Record<string, Count>> = { followUp: {}, context: {}, work: {} };
  const counts = { ar: 0, en: 0 };
  const mismatches: { id: string; decision: Dimension; expected: string; actual: string }[] = [];
  const followUp = { none: 'none', ask: 'clarify', offer: 'next_step' } as const;
  for (const item of cases) {
    counts[item.language]++;
    // This set independently supplies the observed clarification state and
    // turn count. It has no prior transcript for the router to interpret.
    const choice = decideResponsePolicy({
      text: item.text, language: item.language, channel: 'web',
      previousTurns: item.turnCount, recentTurns: POLICY_RECENT_TURNS,
      clarification: item.clarification === 'blocking' ? 'needed' : undefined,
    });
    const actual: Labels = {
      followUp: followUp[choice.followUp],
      context: choice.contextScope,
      work: choice.workMode === 'long_running' ? 'autonomous' : 'inline',
    };
    for (const decision of dimensions) {
      const expected = item.expected[decision];
      const matches = expected === actual[decision];
      score(results[decision].all, matches);
      score(results[decision][item.language], matches);
      score(byLabel[decision][expected] ??= emptyCount(), matches);
      if (!matches) mismatches.push({ id: item.id, decision, expected, actual: actual[decision] });
    }
  }

  return {
    source: 'agent-written evaluation cases', sha256: agentWrittenSha256, counts,
    decisions: Object.fromEntries(dimensions.map(decision => [decision, Object.fromEntries(
      (['all', ...languages] as const).map(language => [language, summary(results[decision][language])]),
    )])),
    byExpectedLabel: Object.fromEntries(dimensions.map(decision => [decision, Object.fromEntries(
      Object.entries(byLabel[decision]).map(([label, count]) => [label, summary(count)]),
    )])),
    mismatches,
  };
}

interface NaturalQuestionsCase { id: string; text: string; expected: 'short' | 'longer' }
interface NaturalQuestionsInput {
  source: { name: 'Natural Questions'; license: 'CC BY-SA 3.0'; split: 'train'; casesSha256: string };
  exclusions: unknown;
  cases: NaturalQuestionsCase[];
}

async function evaluateNaturalQuestions(path: string) {
  const input = JSON.parse(await readFile(path, 'utf8')) as NaturalQuestionsInput;
  if (input.source.name !== 'Natural Questions' || input.source.license !== 'CC BY-SA 3.0'
    || input.source.split !== 'train' || digest(JSON.stringify(input.cases)) !== input.source.casesSha256) {
    throw new Error('Natural Questions sample metadata or checksum mismatch');
  }

  // Reuse the router's test mode to suppress eager loading of learned heads.
  // Passing null to the router also bypasses learned scoring for every case.
  process.env.VITEST = 'true';
  process.env.MOHASSAN_SCRATCH_CLASSIFIERS = '0';
  const { decideRequestRoute } = await import('../../apps/server/src/assistant/routing-decision.js');
  const all = emptyCount();
  const byLabel = { short: emptyCount(), longer: emptyCount() };
  const matrix = { short: { short: 0, longer: 0 }, longer: { short: 0, longer: 0 } };
  for (const item of input.cases) {
    const { route, intent, handler, resolution } = decideRequestRoute({
      text: item.text, previousTurns: 0, capabilities: { search: true, browser: true },
    }, null);
    const decision = decideResponsePolicy({ text: item.text, route, intent, handler, resolution, language: 'en', channel: 'web' });
    const actual = decision.length === 'short' ? 'short' : 'longer';
    const matches = item.expected === actual;
    score(all, matches);
    score(byLabel[item.expected], matches);
    matrix[item.expected][actual]++;
  }
  return {
    source: input.source, exclusions: input.exclusions, overall: summary(all),
    byExpectedLabel: { short: summary(byLabel.short), longer: summary(byLabel.longer) },
    confusionMatrixExpectedByChosen: matrix,
  };
}

const { values } = parseArgs({ options: { 'natural-questions': { type: 'string' } } });
const agentWritten = await evaluateAgentWritten();
const naturalQuestions = values['natural-questions'] ? await evaluateNaturalQuestions(values['natural-questions']) : undefined;
console.log(JSON.stringify({ agentWritten, naturalQuestions }, null, 2));
