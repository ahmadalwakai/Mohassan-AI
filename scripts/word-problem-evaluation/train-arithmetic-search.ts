import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SearchCandidate } from '../../apps/server/src/assistant/arithmetic-search-candidates.js';
import { extractSearchProblem } from '../../apps/server/src/assistant/arithmetic-search-quantities.js';
import {
  arithmeticConfidenceFeatures, boundedFeature, rankArithmeticCandidates, scoreArithmeticFeatures, type SearchFeatures,
} from '../../apps/server/src/assistant/arithmetic-search-ranker.js';
import { evaluateExactArithmeticExpression } from '../../apps/server/src/assistant/calculator.js';
import { readWordProblem, searchCandidatesForWordProblem } from '../../apps/server/src/assistant/word-problem.js';
import { canonicalSearchExpression, goldSearchExpressions } from './annotations.js';

const TRAIN_SHA256 = 'ec38e14d05011f85b5016e2cdecabbbbfc61e3f1379796d40af8307b8aeae94d';
const HOLDOUT_SHA256 = 'ddd39b03baf3e5c6c3c4fa2c970ae8e8996b57b841426a8cd9860931fd7eb985';
const PRECISION_FLOOR = 0.9;

interface Row {
  source_id: string;
  question: string;
  answer: string;
  gold: string;
}

interface CandidateSet {
  candidates: SearchCandidate[];
  gold: string;
  fractions: Set<string>;
}

type Example = { features: SearchFeatures; correct: boolean };
type SupervisedCandidate = { features: SearchFeatures; relevance: number };
type RankProblem = { candidates: SupervisedCandidate[]; weight: number };
type TrainingProblem = { candidates: SearchCandidate[]; gold: string; supervised: RankProblem | null };
type ScoredAnswer = { confidence: number; correct: boolean };
type RankItem = { input: Vector; relevance: number };
type Vector = { indices: number[]; values: number[] };

function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

async function readPartition(path: string, digest: string): Promise<Row[]> {
  const source = await readFile(path);
  if (sha256(source) !== digest) throw new Error(`Prepared partition checksum failed for ${path}`);
  return source.toString('utf8').trimEnd().split('\n').map(row => JSON.parse(row));
}

function lookUpCandidates(row: Row): CandidateSet | null {
  const problem = readWordProblem(row.question);
  const gold = evaluateExactArithmeticExpression(row.gold);
  if (!problem || problem.lang !== 'en' || !gold.ok) return null;
  const extracted = extractSearchProblem(problem.statements, problem.question);
  const candidates = searchCandidatesForWordProblem(row.question);
  if (!candidates.length) return null;
  const fractions = new Set<string>();
  for (const entry of extracted.quantities) {
    if (entry.kind !== 'fraction' && entry.kind !== 'percentage') continue;
    const value = evaluateExactArithmeticExpression(entry.value);
    if (value.ok) fractions.add(value.value);
  }
  return { candidates, gold: gold.value, fractions };
}

function supervisedRanking(row: Row, { candidates, gold, fractions }: CandidateSet): RankProblem | null {
  if (candidates.length < 2) return null;
  const annotations = goldSearchExpressions(row.answer, gold, fractions);
  if (!annotations.size) return null;
  const labeled: SupervisedCandidate[] = [];
  for (const candidate of candidates) {
    const matchingValue = candidate.value === gold;
    const matchingExpression = matchingValue && annotations.has(canonicalSearchExpression(candidate.graph, fractions));
    // Give matching derivations priority. Algebraic variants can still support the annotated value.
    const relevance = matchingExpression ? 1 : matchingValue ? 0.15 : 0;
    labeled.push({ features: candidate.features, relevance });
  }
  if (!labeled.some(item => item.relevance > 0) || !labeled.some(item => item.relevance === 0)) return null;
  return { candidates: labeled, weight: labeled.some(item => item.relevance === 1) ? 1 : 0.35 };
}

function fallbackExample(candidates: readonly SearchCandidate[], gold: string, rankWeights: SearchFeatures): Example | null {
  const ranked = rankArithmeticCandidates(candidates, rankWeights);
  if (!ranked || ranked.margin === 0) return null;
  return { features: arithmeticConfidenceFeatures(ranked), correct: ranked.candidate.value === gold };
}

function dictionary(groups: readonly (readonly { features: SearchFeatures }[])[], minimum: number): Map<string, number> {
  const frequencies = new Map<string, number>();
  for (const group of groups) {
    const active = new Set(group.flatMap(example => Object.keys(example.features)));
    for (const key of active) frequencies.set(key, (frequencies.get(key) ?? 0) + 1);
  }
  const keys = [...frequencies].filter(([, frequency]) => frequency >= minimum).map(([key]) => key).sort();
  return new Map(keys.map((key, index) => [key, index]));
}

function vector(features: SearchFeatures, index: ReadonlyMap<string, number>): Vector {
  const indices: number[] = [];
  const values: number[] = [];
  for (const [key, raw] of Object.entries(features)) {
    const column = index.get(key);
    if (column !== undefined && raw) {
      indices.push(column);
      values.push(boundedFeature(raw));
    }
  }
  return { indices, values };
}

function dot(input: Vector, weights: Float64Array): number {
  let score = 0;
  for (let offset = 0; offset < input.indices.length; offset++) {
    score += weights[input.indices[offset]] * input.values[offset];
  }
  return score;
}

function addGradient(gradient: Float64Array, input: Vector, scale: number): void {
  for (let offset = 0; offset < input.indices.length; offset++) {
    gradient[input.indices[offset]] += scale * input.values[offset];
  }
}

function exportWeights(index: ReadonlyMap<string, number>, weights: Float64Array): SearchFeatures {
  return Object.fromEntries([...index].filter(([, column]) => Math.abs(weights[column]) >= 1e-7)
    .map(([key, column]) => [key, Number(weights[column].toFixed(8))]));
}

function rankGradient(group: readonly RankItem[], weight: number, weights: Float64Array, gradient: Float64Array): void {
  const logits = group.map(item => dot(item.input, weights));
  const highest = Math.max(...logits);
  const highestCorrect = Math.max(...logits.filter((_, index) => group[index].relevance > 0));
  const all = logits.map(logit => Math.exp(logit - highest));
  const correct = logits.map((logit, index) => group[index].relevance
    ? group[index].relevance * Math.exp(logit - highestCorrect) : 0);
  const sumAll = all.reduce((sum, value) => sum + value, 0);
  const sumCorrect = correct.reduce((sum, value) => sum + value, 0);
  for (const [index, item] of group.entries()) {
    addGradient(gradient, item.input, weight * ((all[index] / sumAll) - (correct[index] / sumCorrect)));
  }
}

function fitRanker(examples: readonly RankProblem[]): SearchFeatures {
  const index = dictionary(examples.map(example => example.candidates), 8);
  const groups = examples.map(group => ({
    weight: group.weight,
    candidates: group.candidates.map(item => ({ input: vector(item.features, index), relevance: item.relevance })),
  }));
  const weights = new Float64Array(index.size);
  const history = new Float64Array(index.size).fill(0.1);
  const gradient = new Float64Array(index.size);
  const batchSize = 24;
  for (let epoch = 0; epoch < 28; epoch++) {
    for (let start = 0; start < groups.length; start += batchSize) {
      gradient.fill(0);
      const length = Math.min(batchSize, groups.length - start);
      for (let offset = 0; offset < length; offset++) {
        const row = (start + offset + 37 * epoch) % groups.length;
        rankGradient(groups[row].candidates, groups[row].weight, weights, gradient);
      }
      for (let column = 0; column < weights.length; column++) {
        const derivative = gradient[column] / length + 0.005 * weights[column];
        history[column] += derivative * derivative;
        weights[column] -= 0.26 * derivative / Math.sqrt(history[column]);
      }
    }
  }
  return exportWeights(index, weights);
}

function fitConfidence(examples: readonly Example[]): SearchFeatures {
  const index = dictionary(examples.map(example => [example]), 8);
  const groups = examples.map(example => ({ input: vector(example.features, index), correct: example.correct }));
  const weights = new Float64Array(index.size);
  const history = new Float64Array(index.size).fill(0.1);
  const gradient = new Float64Array(index.size);
  for (let iteration = 0; iteration < 450; iteration++) {
    gradient.fill(0);
    for (const item of groups) {
      const estimate = 1 / (1 + Math.exp(-dot(item.input, weights)));
      addGradient(gradient, item.input, estimate - Number(item.correct));
    }
    for (let column = 0; column < weights.length; column++) {
      const derivative = gradient[column] / groups.length + 0.016 * weights[column];
      history[column] += derivative * derivative;
      weights[column] -= 0.38 * derivative / Math.sqrt(history[column]);
    }
  }
  return exportWeights(index, weights);
}

/** Maximize answered calibration examples subject to precision, processing score ties as a group. */
export function fitSelectionThreshold(answers: readonly ScoredAnswer[], precision = PRECISION_FLOOR): number | null {
  const ordered = [...answers].sort((left, right) => right.confidence - left.confidence);
  let correct = 0;
  let threshold: number | null = null;
  for (const [index, entry] of ordered.entries()) {
    correct += Number(entry.correct);
    if (ordered[index + 1]?.confidence === entry.confidence) continue;
    if (correct / (index + 1) >= precision) threshold = entry.confidence;
  }
  return threshold;
}

function report(answers: readonly ScoredAnswer[], threshold: number | null, rows: number) {
  const accepted = threshold === null ? [] : answers.filter(answer => answer.confidence >= threshold);
  return { rows, candidates: answers.length, answered: accepted.length, correct: accepted.filter(answer => answer.correct).length };
}

async function main(): Promise<void> {
  const [prepared, output] = process.argv.slice(2);
  if (!prepared || !output) throw new Error('Expected prepared data directory and output model path');
  const train = await readPartition(resolve(prepared, 'train.jsonl'), TRAIN_SHA256);
  const heldout = await readPartition(resolve(prepared, 'heldout.jsonl'), HOLDOUT_SHA256);
  const folds: TrainingProblem[][] = [[], [], []];
  for (const row of train) {
    const examples = lookUpCandidates(row);
    if (!examples) continue;
    const split = parseInt(sha256(`mohassan-search-crossfit-v1\0${row.source_id}`).slice(0, 8), 16) % folds.length;
    folds[split].push({ candidates: examples.candidates, gold: examples.gold, supervised: supervisedRanking(row, examples) });
  }
  const supervised = (groups: readonly TrainingProblem[][]) => groups.flat().flatMap(row => row.supervised ? [row.supervised] : []);
  const rankExamples = supervised(folds);
  const exactRankProblems = rankExamples.filter(example => example.weight === 1).length;
  if (!exactRankProblems) throw new Error('No candidate matched an exact annotated derivation');
  // Fit the confidence model from predictions on rows unseen by their ranker.
  const confidenceExamples = folds.flatMap((current, index) => {
    const auxiliary = fitRanker(supervised(folds.filter((_, other) => index !== other)));
    return current.map(row => fallbackExample(row.candidates, row.gold, auxiliary)).filter(item => item !== null);
  });
  const rank = fitRanker(rankExamples);
  if (!confidenceExamples.some(example => example.correct)) throw new Error('No correct candidate for confidence fitting');
  const confidence = fitConfidence(confidenceExamples);

  const midpoint = Math.floor(heldout.length / 2);
  const scores = (rows: readonly Row[]) => rows.map(row => {
    const gold = evaluateExactArithmeticExpression(row.gold);
    return gold.ok ? fallbackExample(searchCandidatesForWordProblem(row.question), gold.value, rank) : null;
  }).filter(item => item !== null)
    .map(item => ({ confidence: scoreArithmeticFeatures(item.features, confidence), correct: item.correct }));
  const calibration = scores(heldout.slice(0, midpoint));
  const assessment = scores(heldout.slice(midpoint));
  const minimumConfidence = fitSelectionThreshold(calibration);
  const result = { rank, confidence, minimumConfidence };
  await writeFile(resolve(output), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    rankProblems: rankExamples.length,
    exactRankProblems,
    confidenceProblems: confidenceExamples.length,
    confidenceCorrect: confidenceExamples.filter(example => example.correct).length,
    minimumConfidence,
    calibration: report(calibration, minimumConfidence, midpoint),
    independentAssessment: report(assessment, minimumConfidence, heldout.length - midpoint),
    heldoutCombined: report([...calibration, ...assessment], minimumConfidence, heldout.length),
  }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
