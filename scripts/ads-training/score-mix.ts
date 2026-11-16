/**
 * Scores the model's answers on the mixed tasks.
 *   npx tsx scripts/ads-training/score-mix.ts <answers dir> [candidates]
 * ads.goal.v1: share of sentences answered exactly, and per field, plus how many answers the
 *   grounding check would refuse (a refused answer makes the brain ask instead of guess).
 * ads.site.v1: share of sites whose answer passes the gate (Google rules + every line on the site),
 *   and how close the accepted copy is to the teacher's.
 * With "candidates", each row holds several answers; the first one that passes the gate is used.
 * Pointer answers (ads.goal.v2, ads.site.v2) are decoded into the same values first; one that
 * does not decode counts as refused (BAD_POINTER).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkGoal, compareGoal, type Goal } from './goal.js';
import { checkSiteAds, type SiteAds, type SiteInput } from './site.js';
import { GOAL_POINTER_CAPABILITY, SITE_POINTER_CAPABILITY, pointerToGoal, pointerToSite } from './pointer.js';

const dir = process.argv[2];
if (!dir) throw new Error('usage: score-mix.ts <answers dir> [candidates]');
const mode = process.argv[3] === 'candidates' ? 'candidates' : 'answers';
const json = (text: string): unknown => { try { return JSON.parse(text); } catch { return null; } };
/** The answer as a value: JSON for v1, decoded pointers for v2. */
const parse = (row: any, text: string): unknown => row.capability === GOAL_POINTER_CAPABILITY ? pointerToGoal(row.input.message, text)
  : row.capability === SITE_POINTER_CAPABILITY ? pointerToSite(row.input, text) : json(text);
const read = (split: string) => { const file = join(dir, `${split}.jsonl`); return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : null; };
const texts = (row: any): string[] => mode === 'candidates' ? row.candidates.map((item: any) => item.text) : [row.answer_text];
const pct = (part: number, whole: number) => whole ? `${Math.round((part / whole) * 1000) / 10}%` : '-';

const report: Record<string, unknown> = {};
for (const split of ['goal_test', 'goal_test_unseen_phrasing', 'goal_gold']) {
  const rows = read(split);
  if (!rows) continue;
  let exact = 0, refused = 0, wrongButAccepted = 0;
  const fields: Record<string, number> = {};
  const misses: string[] = [];
  for (const row of rows) {
    const message = row.input.message as string;
    const answer = texts(row).map(text => parse(row, text)).find(item => !checkGoal(message, item).length) as Goal | undefined;
    if (!answer) { refused++; if (misses.length < 6) misses.push(`REFUSED  ${message}`); continue; }
    const result = compareGoal(row.expected, answer);
    for (const [name, ok] of Object.entries(result.fields)) fields[name] = (fields[name] ?? 0) + (ok ? 1 : 0);
    if (result.exact) exact++;
    else { wrongButAccepted++; if (misses.length < 6) misses.push(`WRONG    ${message}\n           got ${JSON.stringify(answer)}`); }
  }
  report[split] = { rows: rows.length, exact: pct(exact, rows.length), refusedByCheck: pct(refused, rows.length), wrongButAccepted: pct(wrongButAccepted, rows.length),
    fieldsOfAccepted: Object.fromEntries(Object.entries(fields).map(([name, count]) => [name, pct(count, rows.length - refused)])), examples: misses };
}

const siteRows = read('site_test');
if (siteRows) {
  let accepted = 0, headlines = 0, descriptions = 0, keywords = 0, overlap = 0;
  const reasons: Record<string, number> = {};
  const samples: unknown[] = [];
  for (const row of siteRows) {
    const input = row.input as SiteInput, expected = row.expected as SiteAds;
    let chosen: SiteAds | null = null, firstIssues: string[] = [];
    for (const [index, text] of texts(row).entries()) {
      const value = parse(row, text);
      const issues = value === null && row.capability === SITE_POINTER_CAPABILITY ? ['BAD_POINTER'] : checkSiteAds(input, value);
      if (index === 0) firstIssues = issues;
      if (!issues.length) { chosen = value as SiteAds; break; }
    }
    if (!chosen) { for (const code of firstIssues) reasons[code] = (reasons[code] ?? 0) + 1; continue; }
    accepted++;
    headlines += chosen.headlines.length; descriptions += chosen.descriptions.length; keywords += chosen.keywords.length;
    const teacher = new Set(expected.headlines.map(text => text.toLowerCase()));
    overlap += chosen.headlines.filter(text => teacher.has(text.toLowerCase())).length / Math.max(1, chosen.headlines.length);
    if (samples.length < 4) samples.push({ site: input.site, business: chosen.business, headlines: chosen.headlines.slice(0, 6), descriptions: chosen.descriptions.slice(0, 2), keywords: chosen.keywords.slice(0, 5) });
  }
  report.site_test = { sites: siteRows.length, accepted: pct(accepted, siteRows.length),
    perAcceptedAd: accepted ? { headlines: +(headlines / accepted).toFixed(1), descriptions: +(descriptions / accepted).toFixed(1), keywords: +(keywords / accepted).toFixed(1) } : null,
    headlinesSameAsTeacher: accepted ? pct(overlap, accepted) : '-',
    refusalReasonsOfFirstAnswer: Object.fromEntries(Object.entries(reasons).sort((a, b) => b[1] - a[1])), samples };
}
console.log(JSON.stringify(report, null, 2));
