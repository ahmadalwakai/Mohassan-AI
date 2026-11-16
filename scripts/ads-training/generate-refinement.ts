/** New, bounded refinement curriculum. Final evaluation files are never read here. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { naturalGoals } from './natural-goals.js';
import { rng } from './lib.js';

const out = 'artifacts/ads-training/bilingual-refinement-v2';
if (existsSync(out)) throw new Error(`Refusing to overwrite ${out}`);
const read = (path: string) => readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const baseDir = 'artifacts/ads-training/bilingual-v1', codeDir = 'artifacts/code-training/diverse-v2';
const original = read(join(baseDir, 'train.jsonl')), priorValidation = read(join(baseDir, 'validation.jsonl'));
const random = rng(202611152), train: any[] = naturalGoals(4000, 'train', 202611152);
for (const language of ['ar', 'en']) train.push(...random.sample(original.filter(row => row.capability === 'ads.goal.v2' && row.language === language), 1000));
const arabicSites = original.filter(row => row.capability === 'ads.site.v2' && row.language === 'ar');
train.push(...random.sample(original.filter(row => row.capability === 'ads.site.v2' && row.language === 'en'), 1000), ...arabicSites, ...arabicSites);
train.push(...read(join(codeDir, 'train.jsonl')));
const validation = [...naturalGoals(400, 'validation', 202611153), ...priorValidation.filter(row => row.capability === 'ads.site.v2'), ...read(join(codeDir, 'validation.jsonl'))];
const prompts = new Set(train.map(row => row.prompt));
if (validation.some(row => prompts.has(row.prompt))) throw new Error('Refinement train/validation overlap');
mkdirSync(out, { recursive: true });
const files: Record<string, unknown> = {};
for (const [name, rows] of [['train', random.sample(train, train.length)], ['validation', validation]] as const) {
  const text = rows.map(row => JSON.stringify(row)).join('\n') + '\n'; writeFileSync(join(out, `${name}.jsonl`), text);
  files[name] = { rows: rows.length, sha256: createHash('sha256').update(text).digest('hex'), languages: Object.fromEntries(['ar', 'en'].map(language => [language, rows.filter(row => row.language === language).length])) };
}
const manifest = { version: 'bilingual-refinement-v2', seed: 202611152, files, reason: 'Development probes found identifier truncation; add diverse function/parameter names and natural Ads sentence families. Reweight Arabic site rehearsal.',
  source: { base: baseDir, code: codeDir }, trainingUsesFinalAssessment: false, uniqueTrainingPrompts: prompts.size, repeatedArabicSiteExamples: arabicSites.length };
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest, null, 2));
