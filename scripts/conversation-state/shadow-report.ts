/**
 * Shadow report for conversation state v2: what v2 understood on real turns next to v1's kind, for the owner to label.
 * Usage: npx tsx scripts/conversation-state/shadow-report.ts [.data/conversation/shadow.jsonl]
 * Counts are not accuracy: the owner decides on each follow-up, correction and reference whether v2 read it right.
 */
import { readFile } from 'node:fs/promises';
import type { ConversationShadowLine } from '../../apps/server/src/assistant/conversation-state-shadow.js';

const file = process.argv[2] ?? '.data/conversation/shadow.jsonl';
const rows = (await readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line) as ConversationShadowLine);
if (!rows.length) { console.log(`no shadow lines yet in ${file}`); process.exit(0); }
const count = (pick: (row: ConversationShadowLine) => string) => Object.entries(rows.reduce<Record<string, number>>((all, row) => ({ ...all, [pick(row)]: (all[pick(row)] ?? 0) + 1 }), {})).sort((a, b) => b[1] - a[1]);
const ms = rows.map(row => row.ms).sort((a, b) => a - b);
const leaning = rows.filter(row => ['follow_up_property', 'follow_up_entity', 'correction', 'reference', 'field_edit'].includes(row.type));
const asks = rows.filter(row => row.needs);
console.log(`${rows.length} turns in ${new Set(rows.map(row => row.conversationId)).size} conversations, ${rows[0]!.at.slice(0, 10)} → ${rows.at(-1)!.at.slice(0, 10)}`);
console.log(`v2 ms: median ${ms[Math.floor(ms.length / 2)]}, p95 ${ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.95))]}`);
console.log('v2 types:', Object.fromEntries(count(row => row.type)));
console.log('v1 kinds:', Object.fromEntries(count(row => row.v1.kind)));
console.log(`turns that lean on an earlier one: ${leaning.length}; turns v2 would ask about: ${asks.length}`);
console.log('\nfollow-ups, corrections, references and slot edits (v2 query ← v1 query):');
for (const row of leaning) {
  console.log(`  ${row.type.padEnd(19)} ${row.text.replace(/\s+/g, ' ').slice(0, 60).padEnd(62)} → ${row.query ?? '—'}   ← v1 ${row.v1.kind}: ${row.v1.query ?? '—'}${row.assumption ? `   (${row.assumption})` : ''}`);
}
if (asks.length) {
  console.log('\nturns v2 would ask about instead of guessing:');
  for (const row of asks) console.log(`  ${row.needs!.padEnd(18)} ${row.text.replace(/\s+/g, ' ').slice(0, 90)}`);
}
