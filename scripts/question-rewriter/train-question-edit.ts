import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { QUESTION_EDIT_DIMENSIONS, questionEditCandidates, type QuestionEditCandidate } from '../../apps/server/src/assistant/question-edit-candidates.ts';
import { rankQuestionEdits } from '../../apps/server/src/assistant/question-edit-model.ts';
import { combineQuestionRewrites } from '../../apps/server/src/assistant/question-rewrite-order.ts';
import { rewriteFollowUpQuestion, type QuestionHistory } from '../../apps/server/src/assistant/question-rewriter.ts';
import { normalizeQuestionRewrite, questionRewriteCounts, questionRewriteLiteral, scoreQuestionRewrite } from './question-edit-metrics.ts';

interface CanardRow {
  History: string[];
  Question: string;
  Question_no: number;
  Rewrite: string;
}

interface Receipt {
  split: 'train' | 'dev';
  sourceSha256: string;
  exclusionManifestSha256: string;
  input: number;
  dropped: number;
  retained: number;
  deduplicated?: number;
  devOverlap?: number;
}

interface Corpus {
  receipt: Receipt;
  rows: CanardRow[];
}

type TrainingRow = { features: Uint16Array; ends: Uint32Array; positive: number };
type EvaluationRow = { candidates: QuestionEditCandidate[]; original: string; reference: string; rules: string; literal: string; dependent: boolean };

const corpusFingerprint = {
  train: '5877563d4258cf40d660cf2ff65935bf1d15573c7cd98e717ca86a0a6d457ed5',
  dev: 'fafd9f53be0684fd33f85f6bf12a63e61b835ecb9e987c9bd2186149366ce2e5',
};

function readCorpus(path: string, split: 'train' | 'dev') {
  const bytes = readFileSync(path);
  const { receipt, rows } = JSON.parse(bytes.toString('utf8')) as Corpus;
  if (receipt?.split !== split || receipt.sourceSha256 !== corpusFingerprint[split]
    || !/^[a-f\d]{64}$/u.test(receipt.exclusionManifestSha256)
    || receipt.retained !== rows.length || receipt.retained + receipt.dropped !== receipt.input
    || (split === 'train' && (receipt.deduplicated === undefined || receipt.devOverlap === undefined))) {
    throw new Error(`Expected the exclusion-screened CANARD ${split} receipt from prepare-canard.py.`);
  }
  return { receipt, rows, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function historyOf(row: CanardRow): QuestionHistory {
  const [articleTitle, sectionTitle, ...dialogue] = row.History;
  const turns = [];
  for (let index = 0; index < dialogue.length; index += 2) {
    turns.push({ question: dialogue[index]!, answer: dialogue[index + 1] });
  }
  return { articleTitle, sectionTitle, turns };
}

function fitRows(rows: readonly CanardRow[]) {
  const accepted: TrainingRow[] = [];
  let oracle = 0;
  for (const row of rows) {
    const candidates = questionEditCandidates(row.Question, historyOf(row));
    const literal = questionRewriteLiteral(row.Rewrite);
    let positive = candidates.findIndex(candidate => candidate.text === row.Rewrite);
    if (positive < 0 && literal) {
      positive = candidates.findIndex(candidate => questionRewriteLiteral(candidate.text) === literal);
    }
    if (positive < 0) continue;
    oracle++;
    if (candidates.length < 2) continue;
    const ends = new Uint32Array(candidates.length + 1);
    for (const [index, candidate] of candidates.entries()) ends[index + 1] = ends[index] + candidate.features.length;
    const features = new Uint16Array(ends.at(-1)!);
    for (const [index, candidate] of candidates.entries()) features.set(candidate.features, ends[index]);
    accepted.push({ features, ends, positive });
  }
  return { accepted, oracle };
}

function evaluationRows(rows: readonly CanardRow[]): EvaluationRow[] {
  return rows.map(row => {
    const history = historyOf(row);
    const literal = questionRewriteLiteral(row.Rewrite);
    return {
      candidates: questionEditCandidates(row.Question, history),
      original: row.Question,
      reference: row.Rewrite,
      rules: rewriteFollowUpQuestion(row.Question, history),
      literal,
      dependent: row.Question_no > 1 && !!literal && !normalizeQuestionRewrite(row.Question).includes(literal),
    };
  });
}

function metrics(dev: readonly EvaluationRow[], weights: Float64Array) {
  const margins = [0, 0.25, 0.5, 0.75, 1, 1.5, 2, 3];
  const results = margins.map(margin => {
    const counts = questionRewriteCounts;
    const create = () => ({ rules: counts(), model: counts(), rulesFirst: counts(), modelFirst: counts() });
    return { margin, all: create(), dependent: create() };
  });
  const oracle = { exact: 0, literal: 0, dependentExact: 0, dependentLiteral: 0 };
  for (const row of dev) {
    const candidates = row.candidates;
    if (candidates.some(candidate => candidate.text === row.reference)) {
      oracle.exact++;
      if (row.dependent) oracle.dependentExact++;
    }
    if (row.literal && candidates.some(candidate => normalizeQuestionRewrite(candidate.text).includes(row.literal))) {
      oracle.literal++;
      if (row.dependent) oracle.dependentLiteral++;
    }
    const best = rankQuestionEdits(candidates, weights);
    for (const result of results) {
      const model = best && best.text !== row.original.trim() && best.margin >= result.margin ? best.text : null;
      const rulesFirst = combineQuestionRewrites(row.original, 'rules-first', () => row.rules, () => model);
      const modelFirst = combineQuestionRewrites(row.original, 'model-first', () => row.rules, () => model);
      for (const scores of row.dependent ? [result.all, result.dependent] : [result.all]) {
        scoreQuestionRewrite(scores.rules, row.rules, row.reference, row.literal);
        scoreQuestionRewrite(scores.model, model ?? row.original, row.reference, row.literal);
        scoreQuestionRewrite(scores.rulesFirst, rulesFirst, row.reference, row.literal);
        scoreQuestionRewrite(scores.modelFirst, modelFirst, row.reference, row.literal);
      }
    }
  }
  return { results, oracle };
}

function fitEpoch(training: readonly TrainingRow[], weights: Float64Array, squaredGradient: Float64Array, order: Uint32Array,
  scores: Float64Array, learningRate: number) {
  const gradient = new Float64Array(weights.length);
  const touched = new Uint16Array(weights.length);
  const pending = new Uint8Array(weights.length);
  for (const index of order) {
    const row = training[index];
    const { features, ends, positive } = row;
    const count = ends.length - 1;
    let best = -Infinity;
    for (let candidate = 0; candidate < count; candidate++) {
      let score = 0;
      for (let feature = ends[candidate]; feature < ends[candidate + 1]; feature++) score += weights[features[feature]];
      scores[candidate] = score;
      if (score > best) best = score;
    }
    let sum = 0;
    for (let candidate = 0; candidate < count; candidate++) {
      scores[candidate] = Math.exp(scores[candidate] - best);
      sum += scores[candidate];
    }
    let touchedCount = 0;
    for (let candidate = 0; candidate < count; candidate++) {
      const difference = Number(candidate === positive) - scores[candidate] / sum;
      for (let feature = ends[candidate]; feature < ends[candidate + 1]; feature++) {
        const id = features[feature];
        if (!pending[id]) {
          pending[id] = 1;
          touched[touchedCount++] = id;
        }
        gradient[id] += difference;
      }
    }
    for (let feature = 0; feature < touchedCount; feature++) {
      const id = touched[feature];
      const difference = gradient[id];
      squaredGradient[id] += difference * difference;
      weights[id] += learningRate * difference / Math.sqrt(squaredGradient[id]);
      gradient[id] = 0;
      pending[id] = 0;
    }
  }
}

function shuffle(order: Uint32Array, seed: number) {
  let state = seed >>> 0;
  for (let index = order.length - 1; index > 0; index--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const other = state % (index + 1);
    [order[index], order[other]] = [order[other], order[index]];
  }
}

function quantize(weights: Float64Array, scale: number) {
  const bytes = Buffer.alloc(weights.length * 2);
  for (let index = 0; index < weights.length; index++) {
    bytes.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(weights[index] / scale))), index * 2);
  }
  return bytes;
}

function dequantize(bytes: Buffer, scale: number) {
  return Float64Array.from({ length: bytes.length / 2 }, (_, index) => bytes.readInt16LE(index * 2) * scale);
}

const [trainPath, devPath, output, epochArgument = '8', ...rest] = process.argv.slice(2);
const epochCount = Number(epochArgument);
if (!trainPath || !devPath || !output || rest.length || !Number.isInteger(epochCount) || epochCount < 1 || epochCount > 30) {
  throw new Error('Usage: node scripts/question-rewriter/train-question-edit.ts CANARD_TRAIN_CLEAN CANARD_DEV_FILTERED OUTPUT_TS [EPOCHS]');
}

const train = readCorpus(trainPath, 'train');
const dev = readCorpus(devPath, 'dev');
if (train.receipt.exclusionManifestSha256 !== dev.receipt.exclusionManifestSha256) {
  throw new Error('Training and selection receipts must use the same exclusion manifest.');
}
const training = fitRows(train.rows);
const evaluation = evaluationRows(dev.rows);
const weights = new Float64Array(QUESTION_EDIT_DIMENSIONS);
const squaredGradient = new Float64Array(weights.length).fill(1);
const order = Uint32Array.from({ length: training.accepted.length }, (_, index) => index);
const scores = new Float64Array(Math.max(...training.accepted.map(row => row.ends.length - 1)));
const weightScale = 1 / 4096;
let chosen: { epoch: number; order: 'rulesFirst' | 'modelFirst'; result: ReturnType<typeof metrics>['results'][number]; weightBytes: Buffer } | undefined;

console.log(JSON.stringify({ training: train.receipt, selection: dev.receipt, fitGroups: training.accepted.length, trainOracle: training.oracle }));
for (let epoch = 1; epoch <= epochCount; epoch++) {
  shuffle(order, 123457 + epoch);
  fitEpoch(training.accepted, weights, squaredGradient, order, scores, 0.35);
  const bytes = quantize(weights, weightScale);
  const report = metrics(evaluation, dequantize(bytes, weightScale));
  console.log(JSON.stringify({ epoch, ...report }));
  for (const result of report.results) {
    for (const combination of ['rulesFirst', 'modelFirst'] as const) {
      const previous = chosen?.result.all[chosen.order];
      const next = result.all[combination];
      if (!previous || next.normalizedSubstring > previous.normalizedSubstring
        || (next.normalizedSubstring === previous.normalizedSubstring && next.exact > previous.exact)) {
        chosen = { epoch, order: combination, result, weightBytes: bytes };
      }
    }
  }
}
if (!chosen) throw new Error('No development configuration was selected.');

const { epoch, order: selectedOrder, result, weightBytes } = chosen;
const artifact = [
  '// Learned from exclusion-screened CANARD train. Training script: scripts/question-rewriter/train-question-edit.ts.',
  '// CANARD: Ahmed Elgohary, Denis Peskov and Jordan Boyd-Graber (CC BY-SA 4.0). See docs/QUESTION-REWRITER-CANARD.md.',
  `// Training JSON SHA-256: ${train.sha256}`,
  `// Selection JSON SHA-256: ${dev.sha256}`,
  `// Selected epoch ${epoch}; ${selectedOrder}.`,
  `export const questionEditWeightScale = ${weightScale};`,
  `export const questionEditMinMargin = ${result.margin};`,
  `export const questionEditOrder = '${selectedOrder === 'modelFirst' ? 'model-first' : 'rules-first'}';`,
  'export const questionEditWeightsBase64 =',
  weightBytes.toString('base64').match(/.{1,100}/gu)!.map(part => `  '${part}'`).join(' +\n') + ';',
  '',
].join('\n');
writeFileSync(output, artifact);
console.log(JSON.stringify({ chosen: { epoch, order: selectedOrder, ...result }, artifactSha256: createHash('sha256').update(artifact).digest('hex') }));
