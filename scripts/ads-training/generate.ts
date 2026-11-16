/**
 * Builds the Ads training dataset and the gold evaluation set.
 *   npx tsx scripts/ads-training/generate.ts [--seed 1729] [--train 6000]
 * Writes only under artifacts/ads-training (git-ignored). Downloads nothing, calls no model.
 * The gold set is the owner's real Duke Street Glasgow campaign; it is evaluation only and
 * never enters training.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CAPABILITIES, DATASET_VERSION, checkOutput, exampleId, generate, renderPrompt, renderTarget, type AdsExample, type Capability, type Split } from './lib.js';

const ROOT = 'artifacts/ads-training';
const args = process.argv.slice(2);
const option = (name: string, fallback: number) => { const index = args.indexOf(`--${name}`); const value = index >= 0 ? Number(args[index + 1]) : fallback; if (!Number.isInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer`); return value; };
const seed = option('seed', 1729), trainBriefs = option('train', 6000);

function csv(path: string): Record<string, string>[] {
  const rows = readFileSync(path, 'utf8').trim().split(/\r?\n/).map(line => [...line.matchAll(/"((?:[^"]|"")*)"|([^,]+)/g)].map(match => (match[1] ?? match[2] ?? '').replace(/""/g, '"')));
  const [header, ...body] = rows;
  return body.map(row => Object.fromEntries(header!.map((name, index) => [name, row[index] ?? ''])));
}

/** The owner's real campaign, one brief per ad group. Facts are the owner's own callouts and sitelink lines. */
function goldExamples(): AdsExample[] {
  const source = join(ROOT, 'sources');
  const ads = csv(join(source, 'duke-street__google-ads_glasgow-responsive-search-ads.csv'));
  const keywords = csv(join(source, 'duke-street__google-ads_glasgow-keywords.csv'));
  const negatives = csv(join(source, 'duke-street__google-ads_glasgow-negative-keywords.csv'));
  const assets = csv(join(source, 'duke-street__google-ads_glasgow-assets.csv'));
  const facts = [...new Set(assets.flatMap(asset => asset['Asset Type'] === 'Callout' ? [asset.Text!] : [asset['Description Line 1']!, asset['Description Line 2']!]).filter(Boolean))];
  const match = (row: Record<string, string>, text: string) => row['Match Type'] === 'Exact' ? `[${text}]` : row['Match Type'] === 'Phrase' ? `"${text}"` : text;
  const examples: AdsExample[] = [];
  for (const ad of ads) {
    const group = ad['Ad Group']!;
    const base = { business: 'Duke Street Tyres', service: group.replace(/\s+Glasgow$/, ''), city: 'Glasgow', goal: 'calls', language: 'en' };
    const groupKeywords = keywords.filter(row => row['Ad Group'] === group).map(row => match(row, row.Keyword!));
    const headlines = Array.from({ length: 15 }, (_, index) => ad[`Headline ${index + 1}`] ?? '').filter(Boolean);
    const descriptions = Array.from({ length: 4 }, (_, index) => ad[`Description ${index + 1}`] ?? '').filter(Boolean);
    const add = (capability: Capability, input: Record<string, unknown>, output: Record<string, string[]>) =>
      examples.push({ id: exampleId(capability, input), capability, split: 'test', vertical: 'mobile-tyres', source: 'gold', input, output });
    add('ads.keywords.v1', base, { keywords: groupKeywords });
    add('ads.negatives.v1', { ...base, keywords: groupKeywords }, { negatives: negatives.map(row => match(row, row['Negative Keyword']!)) });
    add('ads.headlines.v1', { ...base, facts }, { headlines });
    add('ads.descriptions.v1', { ...base, facts }, { descriptions });
  }
  return examples;
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
mkdirSync(join(ROOT, 'dataset'), { recursive: true });
const briefs: Record<Split, number> = { train: trainBriefs, validation: Math.max(50, Math.round(trainBriefs / 40)), test: Math.max(100, Math.round(trainBriefs / 20)), test_unseen_vertical: Math.max(50, Math.round(trainBriefs / 40)) };
const { examples, rejected } = generate({ seed, briefs });
const gold = goldExamples();

const files: Record<string, { examples: number; sha256: string }> = {};
const write = (name: string, items: AdsExample[]) => {
  const text = items.map(item => JSON.stringify({ ...item, prompt: renderPrompt(item), target: renderTarget(item) })).join('\n') + '\n';
  writeFileSync(join(ROOT, 'dataset', name), text);
  files[name] = { examples: items.length, sha256: sha(text) };
};
for (const split of ['train', 'validation', 'test', 'test_unseen_vertical'] as Split[]) write(`${split}.jsonl`, examples.filter(item => item.split === split));
write('gold.jsonl', gold);

const lengths = [...examples, ...gold].map(item => renderPrompt(item).length + renderTarget(item).length);
const goldIssues = gold.map(item => ({ capability: item.capability, service: item.input.service, issues: checkOutput(item.capability, item.input, item.output).filter(issue => issue.severity === 'error').map(issue => `${issue.code}: ${issue.message}`) })).filter(item => item.issues.length);
const trainIds = new Set(examples.filter(item => item.split === 'train').map(item => item.id));
const summary = {
  datasetVersion: DATASET_VERSION, seed, generatedAt: new Date().toISOString(), briefs,
  examplesByCapability: Object.fromEntries(CAPABILITIES.map(capability => [capability, examples.filter(item => item.capability === capability).length])),
  files, rejectedDuringGeneration: rejected.length,
  overlap: { heldOutInTrain: examples.filter(item => item.split !== 'train' && trainIds.has(item.id)).length, goldInTrain: gold.filter(item => trainIds.has(item.id)).length },
  characters: { max: Math.max(...lengths), mean: Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length), trainTotal: examples.filter(item => item.split === 'train').reduce((total, item) => total + renderPrompt(item).length + renderTarget(item).length, 0) },
  gold: { examples: gold.length, examplesWithIssues: goldIssues.length, issues: goldIssues },
};
writeFileSync(join(ROOT, 'dataset', 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ ...summary, gold: { examples: gold.length, examplesWithIssues: goldIssues.length } }, null, 2));
if (goldIssues.length) console.log('Gold issues:\n' + goldIssues.map(item => `  ${item.capability} / ${item.service}: ${item.issues.join(' | ')}`).join('\n'));
