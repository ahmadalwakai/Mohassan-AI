/**
 * The owner's «مفيد / خطأ / ناقص» verdicts (plan §7.5), read from a COPY of the lab database.
 *
 * Usage: npx tsx scripts/quality/feedback-report.ts [--source .data/local-lab/postgres] [--out artifacts/plan-2026-11-22/feedback]
 *
 * Copies the database first and opens only the copy (refuses while the lab server runs on port 4000). Writes
 * counts per verdict and the rated replies with the request that produced them, so the verdicts can be read
 * beside the frozen real-question set. Verdicts are rating records, never training data.
 */
import { cp, mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const argument = (name: string, fallback: string) => { const at = process.argv.indexOf(`--${name}`); return at >= 0 && process.argv[at + 1] ? process.argv[at + 1]! : fallback; };
const source = path.resolve(argument('source', path.join('.data', 'local-lab', 'postgres')));
const out = path.resolve(argument('out', path.join('artifacts', 'plan-2026-11-22', 'feedback')));
await mkdir(out, { recursive: true });
await stat(path.join(source, 'PG_VERSION'));
await new Promise<void>((resolve, reject) => {
  const probe = createServer();
  probe.once('error', () => reject(new Error('The lab server seems to be running on port 4000; stop it before copying its database.')));
  probe.listen({ port: 4000, host: '127.0.0.1', exclusive: true }, () => probe.close(error => error ? reject(error) : resolve()));
});
const copy = await mkdtemp(path.join(tmpdir(), 'mohassan-lab-copy-'));
await cp(source, copy, { recursive: true, filter: file => !['.mohassan-owner.lock', 'postmaster.pid'].includes(path.basename(file)) });
const db = new PGlite(copy);
await db.waitReady;
try {
  const rows = (await db.query<{ at: string; verdict: string; note: string | null; message_id: string; reply: string; request: string | null; conversation_id: string }>(`
    SELECT e.created_at::text AS at, e.message AS verdict, e.data->>'note' AS note, e.data->>'messageId' AS message_id, m.text AS reply, e.conversation_id,
      (SELECT u.text FROM chat_messages u WHERE u.conversation_id = m.conversation_id AND u.role = 'user' AND u.created_at <= m.created_at ORDER BY u.created_at DESC LIMIT 1) AS request
    FROM chat_events e JOIN chat_messages m ON m.id = e.data->>'messageId'
    WHERE e.kind = 'feedback' ORDER BY e.created_at`)).rows;
  const byVerdict = rows.reduce<Record<string, number>>((all, row) => ({ ...all, [row.verdict]: (all[row.verdict] ?? 0) + 1 }), {});
  const report = { at: new Date().toISOString(), source: path.relative(process.cwd(), source), ratings: rows.length, byVerdict,
    rated: rows.map(row => ({ at: row.at, verdict: row.verdict, note: row.note, request: row.request?.slice(0, 300) ?? null, reply: row.reply.slice(0, 600), conversationId: row.conversation_id })) };
  await writeFile(path.join(out, 'feedback.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ratings: rows.length, byVerdict }, null, 1));
} finally {
  await db.close();
  await rm(copy, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
