/**
 * Builds the ads.site.v1 dataset from the Common Crawl sites, then the mixed fine-tuning set
 * (ads.site.v1 + ads.goal.v1).
 *   npx tsx scripts/ads-training/generate-site.ts
 * Reads artifacts/corpora/commoncrawl-2026-43/sites/sites.jsonl and artifacts/ads-training/goal-dataset/.
 * Writes artifacts/ads-training/site-dataset/ and artifacts/ads-training/mix-v1/ (git-ignored). Calls no model.
 * Sites are split by host: buckets 0-4 test, 5-7 validation, the rest train.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SITE_CAPABILITY, SITE_DATASET_VERSION, checkSiteAds, hostBucket, renderSitePrompt, renderSiteTarget, siteAds, siteDigest, siteId } from './site.js';

const SITES = 'artifacts/corpora/commoncrawl-2026-43/sites/sites.jsonl';
const GOALS = 'artifacts/ads-training/goal-dataset';
const SITE_OUT = 'artifacts/ads-training/site-dataset', MIX_OUT = 'artifacts/ads-training/mix-v1';
type Row = Record<string, unknown> & { id: string; capability: string; prompt: string; target: string };

const sites = readFileSync(SITES, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { url: string; host: string; title: string; text: string });
const split = (host: string) => { const bucket = hostBucket(host); return bucket < 5 ? 'test' : bucket < 8 ? 'validation' : 'train'; };
const bySplit: Record<string, Row[]> = { train: [], validation: [], test: [] };
let unlabelled = 0;
for (const site of sites) {
  const input = siteDigest(site.url, site.title, site.text);
  const output = siteAds(input);
  if (!output) { unlabelled++; continue; }
  const issues = checkSiteAds(input, output);
  if (issues.length) throw new Error(`Teacher label fails the gate for ${site.host}: ${issues.join(', ')}`);
  const which = split(input.site);
  bySplit[which]!.push({ id: siteId(input), capability: SITE_CAPABILITY, split: which, vertical: 'site', source: 'commoncrawl', url: site.url,
    input, output, prompt: renderSitePrompt(input), target: renderSiteTarget(output) });
}

const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const files: Record<string, { rows: number; sha256: string }> = {};
const write = (dir: string, name: string, rows: unknown[]) => { const text = jsonl(rows); writeFileSync(join(dir, `${name}.jsonl`), text); files[`${dir}/${name}.jsonl`] = { rows: rows.length, sha256: sha(text) }; };
mkdirSync(SITE_OUT, { recursive: true });
for (const name of ['train', 'validation', 'test']) write(SITE_OUT, name, bySplit[name]!);

// The goal rows get the prompt and target the fine-tuner reads.
const goals = (name: string): Row[] => readFileSync(join(GOALS, `${name}.jsonl`), 'utf8').trim().split('\n').map(line => {
  const row = JSON.parse(line);
  return { ...row, prompt: `Ads task:\n${canonical({ capability: row.capability, input: row.input })}\nOutput:\n`, target: canonical(row.output) };
});
function canonical(value: unknown): string {
  const sort = (item: unknown): unknown => Array.isArray(item) ? item.map(sort)
    : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item as object).sort().map(key => [key, sort((item as Record<string, unknown>)[key])])) : item;
  return JSON.stringify(sort(value));
}

// Site rows are fewer and longer, so they are seen twice per epoch; goal validation is trimmed to keep the two tasks balanced.
mkdirSync(MIX_OUT, { recursive: true });
const siteTrain = bySplit.train!;
write(MIX_OUT, 'train', [...goals('train'), ...siteTrain, ...siteTrain]);
write(MIX_OUT, 'validation', [...goals('validation').slice(0, 300), ...bySplit.validation!]);
write(MIX_OUT, 'site_test', bySplit.test!);
for (const name of ['test', 'test_unseen_phrasing', 'gold']) write(MIX_OUT, `goal_${name}`, goals(name));

const trainHosts = new Set(siteTrain.map(row => (row.input as { site: string }).site));
const summary = {
  version: SITE_DATASET_VERSION, sites: sites.length, labelled: sites.length - unlabelled, unlabelled,
  siteSplits: Object.fromEntries(Object.entries(bySplit).map(([name, rows]) => [name, rows.length])),
  heldOutHostsInTrain: [...bySplit.validation!, ...bySplit.test!].filter(row => trainHosts.has((row.input as { site: string }).site)).length,
  promptChars: { max: Math.max(...siteTrain.map(row => row.prompt.length + row.target.length)) },
  files,
};
writeFileSync(join(MIX_OUT, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ ...summary, files: undefined }, null, 2));
