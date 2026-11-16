/**
 * Builds pointer-v1: the same goal and site examples as mix-v1, with pointer prompts and answers.
 *   npx tsx scripts/ads-training/generate-pointer.ts [--v2]
 * --v3 is --v2 with goal-dataset-v3 (vocabulary services), written to pointer-v3.
 * --v2 reads goal-dataset-v2 (longer training services), numbers only usable site lines, and writes pointer-v2.
 * Reads artifacts/ads-training/goal-dataset/ and site-dataset/ (so results compare with mix-v1 on the
 * same sentences and sites). Writes artifacts/ads-training/pointer-v1/ (git-ignored). Calls no model.
 * Every answer is decoded back and must equal the original label; an example that cannot be
 * pointed at (a value that is not a whole run of words) is left out and counted.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from './lib.js';
import { checkGoal, type Goal } from './goal.js';
import { checkSiteAds, type SiteAds, type SiteInput } from './site.js';
import {
  GOAL_POINTER_CAPABILITY, POINTER_DATASET_VERSION, POINTER_DATASET_VERSION_V2, SITE_POINTER_CAPABILITY, goalToPointer, pointerToGoal, pointerToSite,
  renderGoalPointerPrompt, renderSitePointerPrompt, samePointerAds, siteToPointer,
} from './pointer.js';

const v3 = process.argv.includes('--v3'), v2 = v3 || process.argv.includes('--v2');
const tag = v3 ? 'v3' : v2 ? 'v2' : 'v1';
const GOALS = v3 ? 'artifacts/ads-training/goal-dataset-v3' : v2 ? 'artifacts/ads-training/goal-dataset-v2' : 'artifacts/ads-training/goal-dataset';
const SITES = 'artifacts/ads-training/site-dataset', OUT = `artifacts/ads-training/pointer-${tag}`;
const readRows = (file: string) => readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
type Row = Record<string, unknown>;
const skipped: Record<string, number> = {};
const skip = (key: string) => { skipped[key] = (skipped[key] ?? 0) + 1; return null; };

function goalRow(row: Row): Row | null {
  const message = (row.input as { message: string }).message, output = row.output as Goal;
  const target = goalToPointer(message, output);
  if (target === null) return skip(`goal_${row.split}`);
  const back = pointerToGoal(message, target);
  if (!back || canonicalJson(back) !== canonicalJson(output) || checkGoal(message, back).length) throw new Error(`Goal pointer does not decode back: ${message}`);
  return { ...row, capability: GOAL_POINTER_CAPABILITY, prompt: renderGoalPointerPrompt(message), target };
}

function siteRow(row: Row): Row | null {
  const input = row.input as SiteInput, output = row.output as SiteAds;
  const target = siteToPointer(input, output);
  if (target === null) return skip(`site_${row.split}`);
  const back = pointerToSite(input, target);
  if (!back || !samePointerAds(back, output) || checkSiteAds(input, back).length) throw new Error(`Site pointer does not decode back: ${input.site}`);
  return { ...row, capability: SITE_POINTER_CAPABILITY, prompt: renderSitePointerPrompt(input, { usableOnly: v2 }), target };
}

const goals = (name: string) => readRows(join(GOALS, `${name}.jsonl`)).map(goalRow).filter(Boolean) as Row[];
const sites = (name: string) => readRows(join(SITES, `${name}.jsonl`)).map(siteRow).filter(Boolean) as Row[];

const files: Record<string, { rows: number; sha256: string }> = {};
mkdirSync(OUT, { recursive: true });
const write = (name: string, rows: Row[]) => {
  const text = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
  writeFileSync(join(OUT, `${name}.jsonl`), text);
  files[name] = { rows: rows.length, sha256: createHash('sha256').update(text).digest('hex') };
};
// Same mixture as mix-v1: site rows twice per epoch, goal validation trimmed to 300.
const siteTrain = sites('train');
write('train', [...goals('train'), ...siteTrain, ...siteTrain]);
write('validation', [...goals('validation').slice(0, 300), ...sites('validation')]);
write('site_test', sites('test'));
for (const name of ['test', 'test_unseen_phrasing', 'gold']) write(`goal_${name}`, goals(name));

const lengths = (rows: Row[]) => rows.map(row => (row.prompt as string).length + (row.target as string).length);
const siteLengths = lengths(siteTrain), targetChars = siteTrain.map(row => (row.target as string).length);
const summary = {
  version: v3 ? 'ads-pointer-v3' : v2 ? POINTER_DATASET_VERSION_V2 : POINTER_DATASET_VERSION, files, leftOut: skipped,
  siteChars: { maxPromptPlusTarget: Math.max(...siteLengths), meanTarget: Math.round(targetChars.reduce((a, b) => a + b, 0) / targetChars.length) },
};
writeFileSync(join(OUT, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
