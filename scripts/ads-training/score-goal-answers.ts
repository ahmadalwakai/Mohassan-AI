/** Score goal answers the way the readiness assessment does (assess-bilingual.ts goalMetrics). Read-only.
 * npx tsx scripts/ads-training/score-goal-answers.ts --answers <answers.jsonl> [--output <report.json>] [--failures]
 * Raw exact: the model's own answer decodes to the expected Goal. Accepted: the repaired answer passes checkGoal.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { checkGoal, compareGoal, type Goal } from './goal.js';
import { pointerToGoal, repairGoalPointer } from './pointer.js';

const args = process.argv.slice(2);
const option = (key: string) => { const at = args.indexOf(key); return at < 0 ? null : args[at + 1] ?? null; };
const path = option('--answers');
if (!path) throw new Error('--answers is required');
const text = readFileSync(path, 'utf8');
interface Row { id: string; language: string; category?: string; input: { message: string }; expected: Goal; answer_text: string; finished: boolean }
const rows = text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Row);

function metrics(list: Row[]) {
  let rawExact = 0, repairedExact = 0, accepted = 0, acceptedCorrect = 0, malformed = 0;
  const refusalReasons: Record<string, number> = {}, failures: { category: string; message: string; expected: Goal; answer: string }[] = [];
  for (const row of list) {
    const message = row.input.message;
    const raw = row.finished ? pointerToGoal(message, row.answer_text) : null;
    const repaired = row.finished ? pointerToGoal(message, repairGoalPointer(message, row.answer_text)) : null;
    const exact = (value: Goal | null) => value !== null && compareGoal(row.expected, value).exact;
    if (exact(raw)) rawExact++; else failures.push({ category: row.category ?? '', message, expected: row.expected, answer: row.answer_text });
    if (exact(repaired)) repairedExact++;
    const issues = repaired === null ? ['BAD_POINTER_OR_JSON'] : checkGoal(message, repaired);
    if (repaired === null) malformed++;
    if (!issues.length) { accepted++; if (exact(repaired)) acceptedCorrect++; }
    else for (const issue of issues) refusalReasons[issue] = (refusalReasons[issue] ?? 0) + 1;
  }
  const ratio = (count: number, total: number) => total ? Number((count / total).toFixed(4)) : null;
  return { summary: { rows: list.length, rawExact, rawExactAccuracy: ratio(rawExact, list.length), repairedExact, repairedExactAccuracy: ratio(repairedExact, list.length),
    accepted, acceptedCorrect, acceptedWrong: accepted - acceptedCorrect, acceptedCoverage: ratio(accepted, list.length), acceptedPrecision: ratio(acceptedCorrect, accepted),
    malformed, refusalReasons }, failures };
}

const languages = [...new Set(rows.map(row => row.language))].sort();
const byLanguage = Object.fromEntries(languages.map(language => [language, metrics(rows.filter(row => row.language === language))]));
const report = { answers: path.replace(/\\/g, '/'), answersSha256: createHash('sha256').update(text).digest('hex'), rows: rows.length,
  byLanguage: Object.fromEntries(languages.map(language => [language, byLanguage[language]!.summary])) };
console.log(JSON.stringify(report, null, 2));
if (args.includes('--failures')) for (const language of languages) for (const failure of byLanguage[language]!.failures) {
  console.log(`XX ${language} ${failure.category} | ${failure.message}\n    exp: ${JSON.stringify(failure.expected)}\n    got: ${failure.answer}`);
}
const output = option('--output');
if (output) writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
