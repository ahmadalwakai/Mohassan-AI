/**
 * Builds the ads.goal.v1 dataset (chat sentence -> campaign goal).
 *   npx tsx scripts/ads-training/generate-goal.ts [--seed 1729] [--train 20000] [--v2]
 * --v2 adds 2-4 word training services and writes goal-dataset-v2; held-out splits are identical to v1.
 * --v3 also draws half the training services from artifacts/ads-training/service-vocab.json and writes goal-dataset-v3.
 * --v4 is --v3 plus extra train-only phrasings (WIDE in goal.ts) and writes goal-dataset-v4; held-out splits equal v3.
 * Writes only under artifacts/ads-training/goal-dataset (git-ignored). Downloads nothing, calls no model.
 * The handwritten gold set is evaluation only and never enters training.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GOAL_DATASET_VERSION, GOAL_DATASET_VERSION_V2, GOAL_DATASET_VERSION_V3, GOAL_DATASET_VERSION_V4, checkGoal, generateGoals, goldGoalExamples, renderGoalPrompt, renderGoalTarget, type GoalExample, type GoalSplit } from './goal.js';

const args = process.argv.slice(2);
const v4 = args.includes('--v4'), v3 = v4 || args.includes('--v3'), v2 = v3 || args.includes('--v2');
const OUT = v4 ? 'artifacts/ads-training/goal-dataset-v4' : v3 ? 'artifacts/ads-training/goal-dataset-v3' : v2 ? 'artifacts/ads-training/goal-dataset-v2' : 'artifacts/ads-training/goal-dataset';
const serviceVocabulary: string[] | undefined = v3 ? JSON.parse(readFileSync('artifacts/ads-training/service-vocab.json', 'utf8')).words : undefined;
const option = (name: string, fallback: number) => { const index = args.indexOf(`--${name}`); const value = index >= 0 ? Number(args[index + 1]) : fallback; if (!Number.isInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer`); return value; };
const seed = option('seed', 1729), train = option('train', 20000);

const examples = generateGoals({ seed, counts: { train, validation: 1000, test: 1000, test_unseen_phrasing: 1000 }, composedServices: v2, serviceVocabulary, widePhrasing: v4 });
const gold = goldGoalExamples();
const goldIssues = gold.map(item => ({ message: item.input.message, issues: checkGoal(item.input.message, item.output) })).filter(item => item.issues.length);
if (goldIssues.length) throw new Error(`Gold examples fail the checker: ${JSON.stringify(goldIssues)}`);

mkdirSync(OUT, { recursive: true });
const write = (split: GoalSplit, rows: GoalExample[]) => writeFileSync(join(OUT, `${split}.jsonl`), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
for (const split of ['train', 'validation', 'test', 'test_unseen_phrasing'] as const) write(split, examples.filter(item => item.split === split));
write('gold', gold);

const trainIds = new Set(examples.filter(item => item.split === 'train').map(item => item.id));
const lengths = examples.map(item => renderGoalPrompt(item).length + renderGoalTarget(item).length);
const summary = {
  version: v4 ? GOAL_DATASET_VERSION_V4 : v3 ? GOAL_DATASET_VERSION_V3 : v2 ? GOAL_DATASET_VERSION_V2 : GOAL_DATASET_VERSION, seed,
  counts: Object.fromEntries(['train', 'validation', 'test', 'test_unseen_phrasing'].map(split => [split, examples.filter(item => item.split === split).length])),
  gold: gold.length,
  otherIntentShare: +(examples.filter(item => item.output.intent === 'other').length / examples.length).toFixed(3),
  overlap: { heldOutInTrain: examples.filter(item => item.split !== 'train' && trainIds.has(item.id)).length, goldInTrain: gold.filter(item => trainIds.has(item.id)).length },
  characters: { max: Math.max(...lengths), mean: Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length) },
};
writeFileSync(join(OUT, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
