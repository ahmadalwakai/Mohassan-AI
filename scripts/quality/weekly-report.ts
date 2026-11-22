/**
 * One page of numbers from the logs (docs/MOHASSAN-DEVELOPMENT-PLAN-2026-11-22.md §10, item 5), instead of many reports.
 *
 * Usage: npx tsx scripts/quality/weekly-report.ts [--source .data/local-lab/postgres] [--days 7] [--latency <route-latency folder>] [--out artifacts/quality-reports]
 *
 * Reads a COPY of the lab database (never the original; refuses while the lab server holds port 4000) and, when given,
 * the summary of the latest route-latency run. Writes <out>/<date>/weekly.md and weekly.json. Counts only: no request
 * text, no reply text, no titles.
 *   - requests by browser level (chat_events kind=visibility, Phase 1)
 *   - how many runs started the browser (step events), and how many conversations had a page
 *   - the owner's verdicts (chat_events kind=feedback, Phase 3)
 *   - runs that asked a question, runs that failed
 *   - latency per path from the route-latency summary, when given
 */
import { cp, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const argument = (name: string, fallback: string) => { const at = process.argv.indexOf(`--${name}`); return at >= 0 && process.argv[at + 1] ? process.argv[at + 1]! : fallback; };
const source = path.resolve(argument('source', path.join('.data', 'local-lab', 'postgres')));
const days = Number(argument('days', '7'));
const latencyFolder = argument('latency', '');
const stamp = new Date().toISOString().slice(0, 10);
const out = path.resolve(argument('out', path.join('artifacts', 'quality-reports')), stamp);
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
const since = new Date(Date.now() - days * 86_400_000);
const one = async <T = Record<string, unknown>>(query: string, params: unknown[] = []) => (await db.query<T>(query, params)).rows;
try {
  const conversations = (await one<{ total: number; with_page: number }>('SELECT count(*)::int AS total, count(*) FILTER (WHERE browser_state IS NOT NULL OR browser_checkpoint IS NOT NULL)::int AS with_page FROM chat_conversations WHERE created_at >= $1', [since]))[0]!;
  const runs = (await one<{ total: number; failed: number; asked: number; browser: number }>(`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE status IN ('failed','interrupted'))::int AS failed,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(state->'trail','[]'::jsonb)) t WHERE t->>'action' = 'asked the user'))::int AS asked,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM chat_events e WHERE e.run_id = chat_runs.id AND e.kind = 'step' AND (e.message LIKE 'فتح %' OR e.message LIKE 'قراءة %' OR e.message LIKE 'البحث في %')))::int AS browser
    FROM chat_runs WHERE created_at >= $1`, [since]))[0]!;
  const levels = await one<{ level: number; requests: number }>("SELECT (data->>'level')::int AS level, count(*)::int AS requests FROM chat_events WHERE kind = 'visibility' AND created_at >= $1 GROUP BY 1 ORDER BY 1", [since]);
  const verdicts = await one<{ verdict: string; ratings: number }>("SELECT message AS verdict, count(*)::int AS ratings FROM chat_events WHERE kind = 'feedback' AND created_at >= $1 GROUP BY 1 ORDER BY 2 DESC", [since]);
  const replies = (await one<{ replies: number }>("SELECT count(*)::int AS replies FROM chat_messages WHERE role = 'assistant' AND created_at >= $1", [since]))[0]!;
  let latency: Record<string, unknown> | null = null;
  if (latencyFolder) {
    try {
      const summary = JSON.parse(await readFile(path.join(latencyFolder, 'summary.json'), 'utf8'));
      latency = Object.fromEntries(Object.entries(summary.byCategory as Record<string, { runs: number; serverMs: { p50: number | null; p95: number | null }; browserUsed: number }>)
        .map(([category, value]) => [category, { runs: value.runs, p50: value.serverMs.p50 === null ? null : Math.round(value.serverMs.p50), p95: value.serverMs.p95 === null ? null : Math.round(value.serverMs.p95), browser: value.browserUsed }]));
    } catch { latency = { error: 'summary.json not readable' }; }
  }
  const totalRuns = runs.total || 1;
  const report = { at: new Date().toISOString(), days, since: since.toISOString(), source: path.relative(process.cwd(), source), conversations, runs,
    shares: { browserRuns: Number((runs.browser / totalRuns).toFixed(3)), askedRuns: Number((runs.asked / totalRuns).toFixed(3)), failedRuns: Number((runs.failed / totalRuns).toFixed(3)) },
    browserLevels: levels, feedback: { replies: replies.replies, verdicts, ratedShare: replies.replies ? Number((verdicts.reduce((sum, row) => sum + row.ratings, 0) / replies.replies).toFixed(3)) : null }, latency };
  const ms = (value: number | null) => value === null ? '—' : value >= 1000 ? `${(value / 1000).toFixed(1)} ث` : `${value} ms`;
  const md = [
    `# تقرير الجودة الأسبوعي — ${stamp}`, '',
    `المصدر: نسخة من \`${report.source}\`، آخر ${days} أيام (منذ ${since.toISOString().slice(0, 10)}). أرقام فقط، بلا نصوص.`, '',
    '| المقياس | القيمة |', '|---|---|',
    `| محادثات | ${conversations.total}، منها بصفحة متصفح ${conversations.with_page} |`,
    `| مهام | ${runs.total}، شغّلت المتصفح ${runs.browser} (${Math.round(report.shares.browserRuns * 100)}%)، سألت ${runs.asked} (${Math.round(report.shares.askedRuns * 100)}%)، فشلت ${runs.failed} (${Math.round(report.shares.failedRuns * 100)}%) |`,
    `| درجات المتصفح المسجلة | ${levels.length ? levels.map(row => `الدرجة ${row.level}: ${row.requests}`).join('، ') : 'لا أحداث بعد (تُسجَّل منذ المرحلة 1)'} |`,
    `| تقييمات المالك | ${verdicts.length ? verdicts.map(row => `${row.verdict}: ${row.ratings}`).join('، ') : 'لا تقييمات بعد'} من ${replies.replies} ردًا |`,
    ...(latency && !('error' in latency) ? ['', '## الزمن لكل مسار (آخر قياس)', '', '| المسار | التشغيلات | p50 | p95 | المتصفح |', '|---|---|---|---|---|',
      ...Object.entries(latency as Record<string, { runs: number; p50: number | null; p95: number | null; browser: number }>).map(([category, value]) => `| ${category} | ${value.runs} | ${ms(value.p50)} | ${ms(value.p95)} | ${value.browser} |`)] : []),
    '',
  ].join('\n');
  await writeFile(path.join(out, 'weekly.json'), JSON.stringify(report, null, 2));
  await writeFile(path.join(out, 'weekly.md'), md);
  console.log(md);
} finally {
  await db.close();
  await rm(copy, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
