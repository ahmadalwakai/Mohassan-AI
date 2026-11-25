import { readFileSync } from 'node:fs';
import { classifyRefusal } from '../../apps/server/src/assistant/refusal/classifier.js';

interface PublicTestRow {
  dataset: string;
  split: string;
  text: string;
  label: 'allow' | 'out_of_scope' | 'unsafe';
  source: string;
}

interface Counts {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
}

function record(counts: Counts, positive: boolean, refused: boolean): void {
  if (refused && positive) counts.tp++;
  else if (refused) counts.fp++;
  else if (positive) counts.fn++;
  else counts.tn++;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator ? numerator / denominator : null;
}

const file = process.argv[2];
if (!file || process.argv.length !== 3) {
  throw new Error('Provide the public JSONL test rows exported by train.py --test-rows.');
}
const results = new Map<string, Counts>();
for (const line of readFileSync(file, 'utf8').split('\n')) {
  if (line.trim() === '') continue;
  const row = JSON.parse(line) as PublicTestRow;
  if (row.split !== 'test') throw new Error('Expected a public test partition.');
  const refused = classifyRefusal(row.text, { fullAccess: true }) !== null;
  const groups = [row.dataset, 'pooled'];
  if (row.dataset.startsWith('aya-')) groups.push('aya-pooled');
  if (row.dataset === 'clinc150' && (row.source === 'oos' || row.label === 'allow')) {
    groups.push('clinc150-native-oos-vs-allowed');
  }
  for (const group of groups) {
    let counts = results.get(group);
    if (!counts) {
      counts = { tp: 0, fp: 0, fn: 0, tn: 0 };
      results.set(group, counts);
    }
    record(counts, row.label !== 'allow', refused);
  }
}
console.log(JSON.stringify(Object.fromEntries([...results].sort().map(([group, counts]) => [group, {
  ...counts,
  precision: ratio(counts.tp, counts.tp + counts.fp),
  recall: ratio(counts.tp, counts.tp + counts.fn),
  overRefusal: ratio(counts.fp, counts.fp + counts.tn),
}])), null, 2));
