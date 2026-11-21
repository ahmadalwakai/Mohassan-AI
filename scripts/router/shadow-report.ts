/**
 * Shadow-mode report: how often the own router model agrees with today's rules on the owner's real requests.
 * Usage: npx tsx scripts/router/shadow-report.ts [.data/router/shadow.jsonl]
 * Agreement is not accuracy: the owner (or a later labelling pass) decides who was right on each disagreement.
 */
import { readFile } from 'node:fs/promises';

const file = process.argv[2] ?? '.data/router/shadow.jsonl';
const rows = (await readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line) as
  { at: string; text: string; rules: string; model: string; confidence: number; ms: number; pendingQuestion: boolean });
if (!rows.length) { console.log(`no shadow lines yet in ${file}`); process.exit(0); }
const same = (row: typeof rows[number]) => row.rules === row.model || (row.rules === 'memory_ads_pc' && ['memory', 'ads', 'pc'].includes(row.model));
const agree = rows.filter(same).length;
const count = (pick: (row: typeof rows[number]) => string) => Object.entries(rows.reduce<Record<string, number>>((all, row) => ({ ...all, [pick(row)]: (all[pick(row)] ?? 0) + 1 }), {})).sort((a, b) => b[1] - a[1]);
const ms = rows.map(row => row.ms).sort((a, b) => a - b);
console.log(`${rows.length} requests, ${rows[0].at.slice(0, 10)} → ${rows.at(-1)!.at.slice(0, 10)}`);
console.log(`agreement with rules: ${agree}/${rows.length} = ${(100 * agree / rows.length).toFixed(1)}%`);
console.log(`model ms: median ${ms[Math.floor(ms.length / 2)]}, p95 ${ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.95))]}`);
console.log('model routes:', Object.fromEntries(count(row => row.model)));
console.log('rules routes:', Object.fromEntries(count(row => row.rules)));
console.log('\ndisagreements (rules → model, confidence):');
for (const row of rows.filter(row => !same(row))) console.log(`  ${row.rules.padEnd(15)} → ${row.model.padEnd(15)} ${row.confidence.toFixed(2)}  ${row.text.replace(/\s+/g, ' ').slice(0, 90)}`);
