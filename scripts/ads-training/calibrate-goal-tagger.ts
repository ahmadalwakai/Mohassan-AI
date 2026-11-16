/** Calibrate abstention on development predictions only, before any final test. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkGoal, compareGoal, type Goal } from './goal.js';
import { pointerToGoal, repairGoalPointer } from './pointer.js';

interface Decision { confidence: number; correct: boolean; valid: boolean }
export function chooseThreshold(rows: Decision[], target = 0.995, coverageFloor = 0.8, minimumCases = 100) {
  const eligible = rows.filter(row => row.valid).sort((a, b) => b.confidence - a.confidence);
  const options: { threshold: number; accepted: number; correct: number; precision: number; coverage: number }[] = [];
  let correct = 0;
  for (let index = 0; index < eligible.length; index++) {
    if (eligible[index]!.correct) correct++;
    if (eligible[index + 1]?.confidence === eligible[index]!.confidence) continue;
    const accepted = index + 1;
    options.push({ threshold: eligible[index]!.confidence, accepted, correct, precision: correct / accepted, coverage: accepted / rows.length });
  }
  const substantial = options.filter(option => option.coverage >= coverageFloor && option.accepted >= minimumCases);
  const qualified = substantial.filter(option => option.precision >= target);
  // If precision is unattainable at useful coverage, record failure and retain the
  // most precise substantial option; never make success by rejecting nearly everything.
  const chosen = qualified.at(-1) ?? substantial.sort((a, b) => b.precision - a.precision || b.coverage - a.coverage)[0]
    ?? options.at(-1) ?? { threshold: 1, accepted: 0, correct: 0, precision: 0, coverage: 0 };
  return { ...chosen, status: qualified.length ? 'passed' : 'failed', rows: rows.length, targetPrecision: target,
    minimumCoverage: coverageFloor, minimumAcceptedCases: minimumCases };
}

const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const read = (path: string) => readFileSync(path);
const jsonl = (bytes: Buffer): Record<string, any>[] => bytes.toString('utf8').split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
export function main(args = process.argv.slice(2)) {
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]?.replace(/^--/, ''), value = args[index + 1];
    if (!name || !['dataset', 'answers', 'checkpoint', 'output'].includes(name) || !value || options[name]) throw new Error('Invalid calibration options');
    options[name] = value;
  }
  for (const key of ['dataset', 'answers', 'checkpoint', 'output']) if (!options[key]) throw new Error(`Missing --${key}`);
  const dataBytes = read(options.dataset!), answerBytes = read(options.answers!), rows = jsonl(dataBytes), answers = jsonl(answerBytes);
  if (!rows.length || rows.some(row => row.split !== 'validation' || row.trainingAllowed === false || /independent/i.test(String(row.source)))) {
    throw new Error('Calibration requires development validation data; independent tests are forbidden');
  }
  const predictions = new Map(answers.map(row => [row.id, row]));
  if (predictions.size !== rows.length || answers.length !== rows.length || new Set(rows.map(row => row.id)).size !== rows.length) throw new Error('Mismatched prediction IDs');
  const groups: Record<string, Decision[]> = { ar: [], en: [] };
  for (const row of rows) {
    const prediction = predictions.get(row.id), expected: Goal = row.expected ?? row.output;
    if (!prediction || !groups[row.language] || JSON.stringify(prediction.input) !== JSON.stringify(row.input)
      || JSON.stringify(prediction.expected) !== JSON.stringify(expected) || prediction.language !== row.language
      || typeof prediction.finished !== 'boolean') throw new Error(`Prediction metadata mismatch: ${row.id}`);
    const confidence = prediction.confidence;
    if (prediction.finished && (prediction.confidenceMethod !== 'minimum_decision_probability_v1' || typeof confidence !== 'number'
      || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)) throw new Error('Invalid confidence');
    const repaired = prediction.finished ? pointerToGoal(row.input.message, repairGoalPointer(row.input.message, prediction.answer_text)) : null;
    groups[row.language]!.push({ confidence: confidence ?? 0, valid: repaired !== null && checkGoal(row.input.message, repaired).length === 0,
      correct: repaired !== null && compareGoal(expected, repaired).exact });
  }
  const byLanguage = Object.fromEntries(Object.entries(groups).map(([language, values]) => [language, chooseThreshold(values)]));
  const sources = ['scripts/ads-training/calibrate-goal-tagger.ts', 'scripts/ads-training/goal.ts', 'scripts/ads-training/pointer.ts',
    'packages/execution-pipeline/execution_pipeline/goal_tagger.py'].map(path => ({ path, sha256: hash(read(path)) }));
  const report = { schemaVersion: 1, method: 'minimum_decision_probability_v1', calibratedAt: new Date().toISOString(),
    dataset: resolve(options.dataset!), datasetSha256: hash(dataBytes), answersSha256: hash(answerBytes),
    checkpointSha256: hash(read(options.checkpoint!)), usesFinalTest: false, byLanguage,
    thresholds: Object.fromEntries(Object.entries(byLanguage).map(([language, metric]) => [language, metric.threshold])), sources };
  writeFileSync(options.output!, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ output: resolve(options.output!), byLanguage }));
  return report;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main();
