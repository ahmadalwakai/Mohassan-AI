/**
 * Phase 0: how often the lab's conversations started the browser or showed its panel, and how often
 * the assistant asked a question (docs/MOHASSAN-DEVELOPMENT-PLAN-2026-11-22.md §1.6, §6.4, §8.3).
 *
 * Usage: npx tsx scripts/quality/browser-open-rate.ts [--source .data/local-lab/postgres] [--out artifacts/plan-2026-11-22/browser-open-rate]
 *
 * The lab database is copied to a temp folder first and only the copy is opened; the lab folder is
 * never opened or written. Refuses to copy while the lab server holds its database (port 4000 in use).
 * The output holds counts only: no message text, no titles, no URLs.
 *
 * The panel rule comes from the web code: `browserOpen` starts true (apps/web/components/assistant-app.tsx),
 * and the panel renders whenever the conversation detail has `browser`, which the server builds from
 * `browser_state` or `browser_checkpoint` (apps/server/src/command-chat.ts detail()).
 */
import { cp, mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const argument = (name: string, fallback: string) => { const at = process.argv.indexOf(`--${name}`); return at >= 0 && process.argv[at + 1] ? process.argv[at + 1]! : fallback; };
const source = path.resolve(argument('source', path.join('.data', 'local-lab', 'postgres')));
const out = path.resolve(argument('out', path.join('artifacts', 'plan-2026-11-22', 'browser-open-rate')));
await mkdir(out, { recursive: true });
await stat(path.join(source, 'PG_VERSION'));
await new Promise<void>((resolve, reject) => {
  const probe = createServer();
  probe.once('error', () => reject(new Error('The lab server seems to be running on port 4000; stop it before copying its database.')));
  probe.listen({ port: 4000, host: '127.0.0.1', exclusive: true }, () => probe.close(error => error ? reject(error) : resolve()));
});
const copy = await mkdtemp(path.join(tmpdir(), 'mohassan-lab-copy-'));
await cp(source, copy, { recursive: true, filter: file => path.basename(file) !== '.mohassan-owner.lock' });
const db = new PGlite(copy);
await db.waitReady;
const one = async <T = Record<string, unknown>>(query: string) => (await db.query<T>(query)).rows;
try {
  const tables = (await one<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY 1")).map(row => row.table_name);
  const conversations = (await one<{ total: number; first: string; last: string }>('SELECT count(*)::int AS total, min(created_at)::text AS first, max(created_at)::text AS last FROM chat_conversations'))[0]!;
  const panel = (await one<{ with_state: number; with_checkpoint: number; with_either: number }>(`SELECT
      count(*) FILTER (WHERE browser_state IS NOT NULL)::int AS with_state,
      count(*) FILTER (WHERE browser_checkpoint IS NOT NULL)::int AS with_checkpoint,
      count(*) FILTER (WHERE browser_state IS NOT NULL OR browser_checkpoint IS NOT NULL)::int AS with_either FROM chat_conversations`))[0]!;
  const observed = (await one<{ conversations: number; observations: number }>('SELECT count(DISTINCT conversation_id)::int AS conversations, count(*)::int AS observations FROM chat_observations'))[0]!;
  const runs = (await one<{ total: number }>('SELECT count(*)::int AS total FROM chat_runs'))[0]!;
  const runsByStatus = await one('SELECT status, count(*)::int AS runs FROM chat_runs GROUP BY 1 ORDER BY 2 DESC');
  const runsByIntent = await one('SELECT intent, count(*)::int AS runs FROM chat_runs GROUP BY 1 ORDER BY 2 DESC');
  // A run used the browser when it logged a browser step (open, search, read). The model-free hands never write
  // chat_observations, so the earlier observation-based count stayed at zero (0-baseline.md §7.3).
  const browserRuns = (await one<{ runs: number }>(`SELECT count(*)::int AS runs FROM chat_runs r WHERE EXISTS (
      SELECT 1 FROM chat_events e WHERE e.run_id = r.id AND e.kind = 'step' AND (e.message LIKE 'فتح %' OR e.message LIKE 'البحث عن %' OR e.message LIKE 'البحث في %' OR e.message LIKE 'قراءة %'))`))[0]!;
  // Phase 1 logs the browser level each request asked for (chat_events kind=visibility); older rows have none.
  const visibilityLevels = await one<{ level: number; runs: number }>("SELECT (data->>'level')::int AS level, count(*)::int AS runs FROM chat_events WHERE kind = 'visibility' GROUP BY 1 ORDER BY 1");
  const eventKinds = await one("SELECT kind, count(*)::int AS events FROM chat_events GROUP BY 1 ORDER BY 2 DESC");
  // Questions: each «asked the user» entry in a run's trail is one answered question card; a run still
  // waiting holds one more. Counted per run, which is one task.
  const asked = await one<{ asked: number; runs: number }>(`SELECT asked::int, count(*)::int AS runs FROM (
      SELECT r.id, (SELECT count(*) FROM jsonb_array_elements(COALESCE(r.state->'trail','[]'::jsonb)) AS entry WHERE entry->>'action' = 'asked the user')
        + CASE WHEN r.status IN ('waiting_user','waiting_input') THEN 1 ELSE 0 END AS asked
      FROM chat_runs r) counted GROUP BY 1 ORDER BY 1`);
  const owners = tables.includes('user') ? await one('SELECT count(DISTINCT c.owner_id)::int AS owners FROM chat_conversations c') : null;
  const monthly = await one("SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, count(*)::int AS conversations, count(*) FILTER (WHERE browser_state IS NOT NULL OR browser_checkpoint IS NOT NULL)::int AS with_panel FROM chat_conversations GROUP BY 1 ORDER BY 1");
  const totalRuns = runs.total || 1, totalConversations = conversations.total || 1;
  const tasksAsked = asked.filter(row => Number(row.asked) > 0).reduce((sum, row) => sum + Number(row.runs), 0);
  const questions = asked.reduce((sum, row) => sum + Number(row.asked) * Number(row.runs), 0);
  const result = {
    at: new Date().toISOString(), source: path.relative(process.cwd(), source), copiedTo: 'temp folder, deleted after reading',
    caveat: 'The lab database holds the owner\'s lab conversations and also requests written by test agents (Claude Code, Codex); it is not a sample of the owner\'s use alone.',
    conversations: { ...conversations, owners },
    panel: { ...panel, shareOfConversations: Number((panel.with_either / totalConversations).toFixed(3)) },
    browserObservations: observed,
    runs: { total: runs.total, byStatus: runsByStatus, byIntent: runsByIntent, usedBrowser: browserRuns.runs, shareUsedBrowser: Number((browserRuns.runs / totalRuns).toFixed(3)) },
    visibilityLevels: { note: 'requests logged since Phase 1 (chat_events kind=visibility); the panel opens by itself only at level 3', byLevel: visibilityLevels },
    questions: { distributionPerRun: asked, runsThatAsked: tasksAsked, shareOfRunsThatAsked: Number((tasksAsked / totalRuns).toFixed(3)), questionsPerRun: Number((questions / totalRuns).toFixed(3)),
      questionsPerAskingRun: tasksAsked ? Number((questions / tasksAsked).toFixed(3)) : null },
    eventKinds, perDay: monthly, tables,
  };
  await writeFile(path.join(out, 'browser-open-rate.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ conversations: result.conversations, panel: result.panel, runs: { total: result.runs.total, usedBrowser: result.runs.usedBrowser, share: result.runs.shareUsedBrowser }, questions: result.questions }, null, 1));
} finally {
  await db.close();
  await rm(copy, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
