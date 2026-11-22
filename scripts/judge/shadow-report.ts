/**
 * Summarises the live judge shadow log (`.data/judge/shadow.jsonl`, written by apps/server/src/assistant/judge-shadow.ts
 * once the host wires it). Usage: npx tsx scripts/judge/shadow-report.ts [--log .data/judge/shadow.jsonl] [--last 20]
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { JudgeShadowLine } from '../../apps/server/src/assistant/judge-shadow.js';

const argument = (name: string, fallback: string) => { const at = process.argv.indexOf(`--${name}`); return at >= 0 && process.argv[at + 1] ? process.argv[at + 1]! : fallback; };
const logPath = path.resolve(argument('log', path.join('.data', 'judge', 'shadow.jsonl')));
const last = Number(argument('last', '20'));

let text = '';
try { text = await readFile(logPath, 'utf8'); } catch { console.log(`لا يوجد سجل بعد في ${logPath}. الظل الحي لم يُربط أو لم يسجّل شيئًا.`); process.exit(0); }
const lines = text.split('\n').filter(Boolean).map(line => JSON.parse(line) as JudgeShadowLine);
if (!lines.length) { console.log(`السجل ${logPath} فارغ.`); process.exit(0); }

const tally = <T extends string>(pick: (line: JudgeShadowLine) => readonly T[] | T) => {
  const map = new Map<T, number>();
  for (const line of lines) for (const key of ([] as T[]).concat(pick(line))) map.set(key, (map.get(key) ?? 0) + 1);
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
};
const ms = lines.map(line => line.ms).sort((a, b) => a - b);
const percentile = (p: number) => ms[Math.min(ms.length - 1, Math.ceil((p / 100) * ms.length) - 1)]!;
const withEvidence = lines.filter(line => line.evidence > 0);
const supported = withEvidence.reduce((sum, line) => sum + (line.support?.supported ?? 0), 0);
const sentences = withEvidence.reduce((sum, line) => sum + (line.support?.sentences ?? 0), 0);

console.log(`سجل الحَكَم الحي: ${lines.length} ردًا، من ${lines[0]!.at} إلى ${lines[lines.length - 1]!.at}`);
console.log('\nالقرار:'); for (const [key, n] of tally(line => line.decision)) console.log(`  ${key}: ${n}`);
console.log('\nالنوع:'); for (const [key, n] of tally(line => line.kind)) console.log(`  ${key}: ${n}`);
console.log('\nالرموز (ردود):'); for (const [key, n] of tally(line => line.codes)) console.log(`  ${key}: ${n}`);
console.log(`\nالزمن: p50 ${percentile(50)} ms، p95 ${percentile(95)} ms، max ${ms[ms.length - 1]} ms`);
console.log(`\nالسند: ${withEvidence.length} ردًا مع أدلة؛ ${supported} من ${sentences} جملة وُجدت في الأدلة${withEvidence.length ? '' : ' (لم يمرّر المضيف أدلة بعد)'}`);
console.log(`\nآخر ${Math.min(last, lines.length)}:`);
for (const line of lines.slice(-last)) console.log(`  ${line.at} ${line.decision.padEnd(8)} ${line.kind.padEnd(9)} ${line.codes.filter(code => code !== 'evidence_unavailable').join(',') || '-'} | ${line.question.slice(0, 60).replace(/\s+/gu, ' ')}`);
