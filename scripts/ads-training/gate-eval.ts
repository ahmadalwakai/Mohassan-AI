/**
 * Measures the checker gate on held-out candidates.
 *   npx tsx scripts/ads-training/gate-eval.ts <run>/ads-finetune/candidates
 * coverage   briefs that get an answer at all;
 * leaks      accepted answers that a stricter oracle (the true business type's facts) still rejects;
 * reference  share of the correct reference answers the gate accepts (its false-refusal check).
 * Writes gate.json next to the candidates; calls no model.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkOutput, type Capability } from './lib.js';
import { VERTICALS } from './verticals.js';
import { gate, gateIssues } from './gate.js';

interface Row { id: string; source?: string; capability: Capability; vertical?: string; input: Record<string, unknown>; expected: Record<string, unknown>; candidates: { text: string; finished: boolean }[] }

const directory = process.argv[2];
if (!directory) throw new Error('Usage: gate-eval.ts <candidates directory>');
const report: Record<string, unknown> = {};
const shown: Record<string, unknown[]> = {};

for (const split of ['test', 'test_unseen_vertical', 'gold']) {
  const path = join(directory, `${split}.jsonl`);
  if (!existsSync(path)) continue;
  const rows = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Row);
  const byCapability: Record<string, { briefs: number; answered: number; greedy: number; rescued: number; leaks: number; exact: number; referenceAccepted: number; refusals: Record<string, number> }> = {};
  for (const row of rows) {
    const bucket = byCapability[row.capability] ??= { briefs: 0, answered: 0, greedy: 0, rescued: 0, leaks: 0, exact: 0, referenceAccepted: 0, refusals: {} };
    bucket.briefs++;
    if (!gateIssues(row.capability, row.input, row.expected).length) bucket.referenceAccepted++;
    const decision = gate(row.capability, row.input, row.candidates.map(candidate => candidate.text));
    if (!decision.accepted) { for (const [code, count] of Object.entries(decision.reasons)) bucket.refusals[code] = (bucket.refusals[code] ?? 0) + count; continue; }
    bucket.answered++;
    if (decision.candidate === 0) bucket.greedy++; else bucket.rescued++;
    if (JSON.stringify(decision.output) === JSON.stringify(row.expected)) bucket.exact++;
    const vertical = row.source === 'gold' ? undefined : VERTICALS.find(item => item.id === row.vertical);
    const oracle = checkOutput(row.capability, row.input, decision.output, vertical).filter(issue => issue.severity === 'error');
    if (oracle.length) bucket.leaks++;
    if (split === 'gold' || (shown[split] ??= []).length < 4) (shown[split] ??= []).push({ capability: row.capability, brief: `${row.input.business} | ${row.input.service} | ${row.input.city}`, answer: decision.output, oracle: oracle.map(issue => issue.code) });
  }
  const sum = (key: 'briefs' | 'answered' | 'leaks' | 'referenceAccepted' | 'rescued') => Object.values(byCapability).reduce((total, bucket) => total + bucket[key], 0);
  report[split] = { briefs: sum('briefs'), answered: sum('answered'), coverage: +(sum('answered') / sum('briefs')).toFixed(3), rescuedBySampling: sum('rescued'), leaks: sum('leaks'), referenceAccepted: +(sum('referenceAccepted') / sum('briefs')).toFixed(3), byCapability };
}
writeFileSync(join(directory, 'gate.json'), JSON.stringify({ report, shown }, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
