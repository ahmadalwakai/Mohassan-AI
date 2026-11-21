/**
 * Gate R0: what today's rules (rules v0) decide for each labelled message, without any model.
 * Usage: npx tsx scripts/router/eval-rules.ts [.data/router/real-labeled.jsonl]
 * `memory_ads_pc` is one rule bucket: it counts as correct for a memory, ads or pc label.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { directRoute } from '../../apps/server/src/assistant/brain.js';
import { notWebReason, parseHands, tidy, webQuestion } from '../../apps/server/src/assistant/hands.js';

export function rulesRoute(text: string, previous: string | null): string {
  const steps = parseHands(text);
  if (steps) return steps.some(step => step.kind === 'news') ? 'news' : 'browser_command';
  if (directRoute(text)) return 'browser_command';
  if (webQuestion(text, previous ? [previous] : [])) return 'web_search';
  const reason = notWebReason(tidy(text));
  return ({ reminder: 'reminder', arithmetic: 'compute', writing: 'writing', chat: 'chat', address: 'browser_command', memory_ads_pc: 'memory_ads_pc', empty: 'none' } as Record<string, string>)[reason ?? ''] ?? 'none';
}

const file = process.argv[2] ?? '.data/router/real-labeled.jsonl';
const rows = (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as { text: string; previous: string | null; route: string });
let right = 0;
const rights: boolean[] = [];
const byRoute = new Map<string, { n: number; ok: number }>();
const misses: string[] = [];
for (const row of rows) {
  const got = rulesRoute(row.text, row.previous);
  const ok = got === row.route || (got === 'memory_ads_pc' && ['memory', 'ads', 'pc'].includes(row.route));
  rights.push(ok);
  const slot = byRoute.get(row.route) ?? { n: 0, ok: 0 };
  slot.n++; if (ok) { slot.ok++; right++; } else misses.push(`${row.route.padEnd(15)} → ${got.padEnd(15)} ${row.text.replace(/\s+/g, ' ').slice(0, 90)}`);
  byRoute.set(row.route, slot);
}
console.log(`rules v0: ${right}/${rows.length} = ${(100 * right / rows.length).toFixed(1)}%`);
for (const [route, { n, ok }] of [...byRoute].sort((a, b) => b[1].n - a[1].n)) console.log(`  ${route.padEnd(16)} ${ok}/${n}`);
console.log('\nmisses (label → rules):');
for (const line of misses) console.log(`  ${line}`);

await mkdir('artifacts/router', { recursive: true });
await writeFile('artifacts/router/rules-sealed.json', JSON.stringify({ accuracy: right / rows.length, right: rights }));
