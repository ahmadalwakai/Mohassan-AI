/**
 * Scores the model's held-out Ads answers with the same checker that built the data.
 *   npx tsx scripts/ads-training/score.ts <run>/ads-finetune/answers
 * Reads answers only; calls no model and writes score.json next to them.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { checkOutput, type Capability } from './lib.js';
import { VERTICALS } from './verticals.js';

interface Answer { id: string; split: string; source?: string; capability: Capability; vertical?: string; input: Record<string, unknown>; expected: Record<string, string[]>; answer_text: string; finished: boolean }

const directory = process.argv[2];
if (!directory) throw new Error('Usage: score.ts <answers directory>');
const splits = ['test', 'test_unseen_vertical', 'gold'].filter(split => existsSync(join(directory, `${split}.jsonl`)));
const report: Record<string, unknown> = {};
const examples: Record<string, unknown[]> = {};

for (const split of splits) {
  const answers = readFileSync(join(directory, `${split}.jsonl`), 'utf8').trim().split('\n').map(line => JSON.parse(line) as Answer);
  const byCapability: Record<string, { total: number; parsed: number; passed: number; exact: number; codes: Record<string, number> }> = {};
  for (const answer of answers) {
    const bucket = byCapability[answer.capability] ??= { total: 0, parsed: 0, passed: 0, exact: 0, codes: {} };
    bucket.total++;
    let output: Record<string, unknown> | null = null;
    try { const value = JSON.parse(answer.answer_text); if (value && typeof value === 'object' && !Array.isArray(value)) output = value; } catch { /* counted as unparsed */ }
    if (!output) { bucket.codes.UNPARSABLE = (bucket.codes.UNPARSABLE ?? 0) + 1; continue; }
    bucket.parsed++;
    // Gold briefs are judged without a vertical: the owner's real ads may state any of their own facts.
    const vertical = answer.source === 'gold' ? undefined : VERTICALS.find(entry => entry.id === answer.vertical);
    const errors = checkOutput(answer.capability, answer.input, output, vertical).filter(issue => issue.severity === 'error');
    if (!errors.length) bucket.passed++;
    for (const code of new Set(errors.map(issue => issue.code))) bucket.codes[code] = (bucket.codes[code] ?? 0) + 1;
    if (JSON.stringify(output) === JSON.stringify(answer.expected)) bucket.exact++;
    if ((examples[split] ??= []).length < 6 && answer.capability !== 'ads.keywords.v1') examples[split]!.push({ capability: answer.capability, input: { business: answer.input.business, service: answer.input.service, city: answer.input.city }, answer: output, errors: errors.map(issue => `${issue.code}: ${issue.message}`) });
  }
  const totals = Object.values(byCapability).reduce((sum, bucket) => ({ total: sum.total + bucket.total, parsed: sum.parsed + bucket.parsed, passed: sum.passed + bucket.passed, exact: sum.exact + bucket.exact }), { total: 0, parsed: 0, passed: 0, exact: 0 });
  report[split] = { ...totals, passRate: +(totals.passed / totals.total).toFixed(4), byCapability };
}
writeFileSync(join(directory, 'score.json'), JSON.stringify({ report, examples }, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
