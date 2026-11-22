/**
 * Per-row comparison of answer folders on the frozen Ads tests, against a reference folder.
 *   npx tsx scripts/heads/paired-score.ts <reference answers dir> <name>=<answers dir> [...more] > out.json
 * Each row is classed the way scripts/ads-training/score-mix.ts classes it: exact, refused (the grounding
 * check rejects it, so the brain asks instead of guessing) or wrong (accepted but not exact).
 * For each arm and split it reports the three shares with Wilson 95% intervals, and McNemar exact
 * (two-sided binomial) tests on the rows where the arm and the reference disagree, for "exact" and for
 * "wrong". Rows are matched by id; a split is skipped unless both folders hold the same ids.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkGoal, compareGoal, type Goal } from '../ads-training/goal.js';
import { GOAL_POINTER_CAPABILITY, pointerToGoal } from '../ads-training/pointer.js';

type Kind = 'exact' | 'refused' | 'wrong';
const SPLITS = ['goal_test', 'goal_test_unseen_phrasing', 'goal_gold'];

const json = (text: string): unknown => { try { return JSON.parse(text); } catch { return null; } };
const parse = (row: any, text: string): unknown => row.capability === GOAL_POINTER_CAPABILITY ? pointerToGoal(row.input.message, text) : json(text);

function classify(dir: string, split: string): Map<string, Kind> | null {
  const file = join(dir, `${split}.jsonl`);
  if (!existsSync(file)) return null;
  const kinds = new Map<string, Kind>();
  for (const line of readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)) {
    const row = JSON.parse(line);
    const message = row.input.message as string;
    const value = parse(row, row.answer_text);
    if (checkGoal(message, value).length) { kinds.set(row.id, 'refused'); continue; }
    kinds.set(row.id, compareGoal(row.expected, value as Goal).exact ? 'exact' : 'wrong');
  }
  return kinds;
}

function wilson(part: number, whole: number): [number, number] {
  if (!whole) return [0, 0];
  const z = 1.959963984540054, p = part / whole, z2 = z * z;
  const centre = (p + z2 / (2 * whole)) / (1 + z2 / whole);
  const half = (z * Math.sqrt((p * (1 - p)) / whole + z2 / (4 * whole * whole))) / (1 + z2 / whole);
  return [round(100 * Math.max(0, centre - half)), round(100 * Math.min(1, centre + half))];
}

/** Two-sided exact binomial test with p = 0.5 on the discordant pairs. */
function mcnemar(onlyArm: number, onlyReference: number): number {
  const n = onlyArm + onlyReference;
  if (!n) return 1;
  const k = Math.min(onlyArm, onlyReference);
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += Math.exp(logChoose(n, i) - n * Math.LN2);
  return Math.min(1, round(2 * tail, 6));
}

function logChoose(n: number, k: number): number {
  let total = 0;
  for (let i = 1; i <= k; i++) total += Math.log(n - k + i) - Math.log(i);
  return total;
}

const round = (value: number, places = 1) => Math.round(value * 10 ** places) / 10 ** places;

const [referenceDir, ...pairs] = process.argv.slice(2);
if (!referenceDir || !pairs.length) throw new Error('usage: paired-score.ts <reference dir> <name>=<dir> [...]');
const report: Record<string, unknown> = { reference: referenceDir, test: 'McNemar exact (two-sided binomial) on discordant rows', arms: {} };
for (const pair of pairs) {
  const at = pair.indexOf('=');
  const name = pair.slice(0, at), dir = pair.slice(at + 1);
  const arm: Record<string, unknown> = { dir };
  for (const split of SPLITS) {
    const reference = classify(referenceDir, split), mine = classify(dir, split);
    if (!reference || !mine) continue;
    const ids = [...reference.keys()];
    if (ids.length !== mine.size || ids.some(id => !mine.has(id))) { arm[split] = { skipped: 'ids differ from the reference' }; continue; }
    const share = (kinds: Map<string, Kind>, kind: Kind) => ids.filter(id => kinds.get(id) === kind).length;
    const shares = (kinds: Map<string, Kind>) => Object.fromEntries((['exact', 'refused', 'wrong'] as Kind[]).map(kind => {
      const count = share(kinds, kind);
      return [kind, { pct: round((100 * count) / ids.length), ci95: wilson(count, ids.length) }];
    }));
    const paired = (kind: Kind) => {
      const onlyArm = ids.filter(id => mine.get(id) === kind && reference.get(id) !== kind).length;
      const onlyReference = ids.filter(id => mine.get(id) !== kind && reference.get(id) === kind).length;
      return { only_arm: onlyArm, only_reference: onlyReference, p: mcnemar(onlyArm, onlyReference) };
    };
    arm[split] = { rows: ids.length, arm: shares(mine), reference: shares(reference), paired_exact: paired('exact'), paired_wrong: paired('wrong') };
  }
  (report.arms as Record<string, unknown>)[name] = arm;
}
console.log(JSON.stringify(report, null, 2));
