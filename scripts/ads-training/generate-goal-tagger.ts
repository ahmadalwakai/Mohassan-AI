/** Build the goal-grammar dataset for the goal tagger. Never overwrites a dataset. Local data only.
 * npx tsx scripts/ads-training/generate-goal-tagger.ts --out artifacts/ads-training/tagger-v2 [--train 80000] [--validation 2000]
 * Counts are per language. --sample N prints N sentences per language instead of writing files.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { makeGrammarGoals, type GrammarRow } from './goal-grammar.js';
import { loadCorpusServices } from './goal-grammar-corpus.js';

const args = process.argv.slice(2);
const option = (key: string, fallback: string) => { const at = args.indexOf(key); return at < 0 ? fallback : args[at + 1] ?? fallback; };
const seed = Number(option('--seed', '2026111502'));
const sample = Number(option('--sample', '0'));
const corpusPath = option('--service-phrases', '');
const corpus = corpusPath ? loadCorpusServices(corpusPath) : undefined;
const corpusShare = Number(option('--corpus-share', '0.25'));
const corpusOptions = { corpusServices: corpus?.services, corpusShare };
if (sample > 0) {
  for (const language of ['en', 'ar'] as const) {
    const { rows, rejected } = makeGrammarGoals({ count: sample, split: option('--split', 'train') as 'train' | 'validation', seed, language, ...corpusOptions });
    for (const row of rows) console.log(`[${row.family}] ${row.input.message}\n    ${row.target}`);
    console.log('rejected', JSON.stringify(rejected));
  }
  process.exit(0);
}
const out = resolve(option('--out', 'artifacts/ads-training/tagger-v2'));
if (existsSync(out)) throw new Error(`Refusing to overwrite existing dataset: ${out}`);
const trainCount = Number(option('--train', '80000')), validationCount = Number(option('--validation', '2000'));
if (![trainCount, validationCount].every(n => Number.isInteger(n) && n > 1 && n <= 400000)) throw new Error('Invalid example count');
const files: Record<string, unknown> = {}, rejected: Record<string, unknown> = {};
mkdirSync(out, { recursive: true });
const trainMessages = new Set<string>();
const messageKey = (row: GrammarRow) => row.input.message.toLowerCase().trim().replace(/\s+/g, ' ');
for (const [split, count, offset] of [['train', trainCount, 0], ['validation', validationCount, 1000]] as const) {
  const rows: GrammarRow[] = [];
  const seen = new Set<string>();
  for (const [index, language] of (['en', 'ar'] as const).entries()) {
    const made = makeGrammarGoals({ count, split, seed: seed + offset + index, language, ...corpusOptions });
    rejected[`${split}-${language}`] = made.rejected;
    // A validation sentence that training also made is dropped, so validation stays unseen.
    rows.push(...made.rows.filter(row => {
      const key = messageKey(row);
      if (seen.has(key) || split === 'validation' && trainMessages.has(key)) return false;
      seen.add(key);
      return true;
    }));
  }
  if (split === 'train') for (const row of rows) trainMessages.add(messageKey(row));
  const text = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
  writeFileSync(join(out, `${split}.jsonl`), text);
  const families: Record<string, number> = {};
  for (const row of rows) families[row.family] = (families[row.family] ?? 0) + 1;
  files[split] = { rows: rows.length, sha256: createHash('sha256').update(text).digest('hex'), families };
}
writeFileSync(join(out, 'manifest.json'), JSON.stringify({ version: 'goal-grammar-v6', seed, createdAt: new Date().toISOString(), files, rejected,
  localServicePhrases: corpus ? { path: corpus.path, sha256: corpus.sha256, share: corpusShare,
    counts: { ar: corpus.services.ar.length, en: corpus.services.en.length } } : null,
  labels: 'From construction; every row passes checkGoal, round-trips the pointer format and names each value once.',
  distribution: { otherRequestShare: 0.22, naturalShareOfCreateRequests: 0.70,
    validation: 'Whole-sentence natural templates are held out by stable hash; composed phrases and vocabulary also include held-out values.' },
  guide: 'docs/ADS-GOAL-LABELING-GUIDE.md', trainingUsesFinalAssessment: false,
  lineage: 'Locally generated supervised data. No external model or pretrained weights.' }, null, 2) + '\n');
console.log(JSON.stringify({ out, files: Object.fromEntries(Object.entries(files).map(([name, value]) => [name, (value as { rows: number }).rows])) }));
