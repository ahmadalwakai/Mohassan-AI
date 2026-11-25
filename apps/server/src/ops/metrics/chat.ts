import { createHash } from 'node:crypto';
import { runPhases, terminalRunPhases, type AnswerPath, type TrafficRole, type WorkingRunPhase } from '@mohassan/contracts';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import { RunLedgerSchema, type RunLedger } from '../../assistant/agent-run.js';
import type { ChatObservation } from './store.js';

const terminalPhases = new Set<string>(terminalRunPhases);
const workingPhases = new Set<string>(runPhases.filter(phase => !terminalPhases.has(phase)));
const phaseHistory = RunLedgerSchema.shape.history;
const historyLimit = z.toJSONSchema(phaseHistory).maxItems;
const terminalStatuses = ['completed', 'partial', 'blocked', 'cancelled', 'failed', 'interrupted'] as const;
const publishedStatuses = new Set<string>(['completed', 'partial', 'blocked']);
// Limit the materialized page before extracting any JSON from run state.
const batchLimit = 256;

export type ChatMetricsCursor = Readonly<{ at: string; runId: string; kind: 'start' | 'terminal' }>;
export type PersistedChatSample = {
  /** For in-process overlap deduplication only. Event identifiers never enter aggregate storage. */
  key: string;
  atMs: number;
  role: TrafficRole;
  observation: ChatObservation;
};

type ReaderOptions = { fromMs: number; toMs: number; cursor?: ChatMetricsCursor; limit?: number };
type MetricsRow = {
  event_at: Date;
  cursor_at: string;
  run_id: string;
  event_kind: ChatMetricsCursor['kind'];
  received_at: Date;
  first_progress_at: unknown;
  traffic_role: TrafficRole | null;
  status: string;
  history: unknown;
  web_path: boolean | null;
  calculation_path: boolean | null;
  skill_path: boolean | null;
  memory_path: boolean | null;
  browser_path: boolean | null;
  refusal_path: boolean | null;
};

/** Sum the retained visits to each working phase before its next recorded transition. */
export function chatPhaseDurations(history: RunLedger['history'], receivedAt: number, endedAt?: number): NonNullable<ChatObservation['phases']> {
  const phases: NonNullable<ChatObservation['phases']> = {};
  for (let index = 0; index < history.length; index++) {
    const entry = history[index]!;
    if (!workingPhases.has(entry.phase)) continue;
    const phase = entry.phase as WorkingRunPhase;
    const start = Date.parse(entry.at);
    const next = history[index + 1];
    // The ledger keeps `received` even when dropping the transitions that followed it.
    if (phase === 'received' && (history.length === historyLimit || start !== receivedAt)) continue;
    const elapsed = (next ? Date.parse(next.at) : endedAt ?? NaN) - start;
    if (Number.isFinite(elapsed) && elapsed >= 0) phases[phase] = (phases[phase] ?? 0) + elapsed;
  }
  return phases;
}

function terminalObservation(row: MetricsRow, endedAt: number): ChatObservation {
  const receivedAt = new Date(row.received_at).getTime();
  const history = phaseHistory.safeParse(row.history);
  const phases = history.success ? chatPhaseDurations(history.data, receivedAt, endedAt) : undefined;
  const finalAnswerMs = endedAt - receivedAt;
  if (!publishedStatuses.has(row.status)) return { phases };
  const paths: AnswerPath[] = [];
  if (row.web_path) paths.push('web');
  if (row.calculation_path) paths.push('local_computation');
  if (row.skill_path) paths.push('skill_reader');
  if (row.memory_path) paths.push('memory');
  if (row.browser_path) paths.push('browser');
  if (row.refusal_path) paths.push('refusal');
  return { ...(Number.isFinite(finalAnswerMs) && finalAnswerMs >= 0 ? { finalAnswerMs } : {}), phases, paths };
}

/** Reads one bounded page of start/terminal events. Both endpoints are based on durable app timestamps. */
export async function readPersistedChatMetrics(db: Kysely<any>, { fromMs, toMs, cursor, limit = batchLimit }: ReaderOptions)
: Promise<{ samples: PersistedChatSample[]; nextCursor?: ChatMetricsCursor }> {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) return { samples: [] };
  const batch = Number.isFinite(limit) ? Math.max(1, Math.min(batchLimit, Math.trunc(limit))) : batchLimit;
  const from = new Date(fromMs);
  const to = new Date(toMs);
  const after = cursor ? sql`WHERE (event_at, run_id, event_kind) > (${cursor.at}::timestamptz, ${cursor.runId}, ${cursor.kind})` : sql``;
  const query = await sql<MetricsRow>`
    WITH events AS (
      SELECT id AS run_id, created_at AS event_at, 'start'::text AS event_kind
      FROM chat_runs WHERE created_at >= ${from} AND created_at < ${to}
      UNION ALL
      SELECT id, updated_at, 'terminal'::text
      FROM chat_runs WHERE updated_at >= ${from} AND updated_at < ${to}
        AND status IN (${sql.join(terminalStatuses.map(status => sql`${status}`))})
    ), page AS MATERIALIZED (
      SELECT * FROM events ${after} ORDER BY event_at, run_id, event_kind LIMIT ${batch + 1}
    )
    SELECT p.event_at, p.event_at::text AS cursor_at, p.run_id, p.event_kind,
      r.created_at AS received_at, r.status,
      CASE WHEN o.owner_id = r.owner_id THEN 'owner' ELSE m.role END AS traffic_role,
      CASE WHEN p.event_kind = 'start' THEN (
        SELECT e.data->'firstProgressAtMs' FROM chat_events e
        WHERE e.conversation_id = r.conversation_id AND e.run_id = r.id AND e.kind = 'visibility'
          AND jsonb_typeof(e.data->'firstProgressAtMs') = 'number'
        ORDER BY e.created_at, e.id LIMIT 1
      ) END AS first_progress_at,
      CASE WHEN p.event_kind = 'terminal' AND jsonb_typeof(r.state #> '{agentRun,history}') = 'array' THEN
        CASE WHEN jsonb_array_length(r.state #> '{agentRun,history}') <= ${historyLimit} THEN r.state #> '{agentRun,history}' END
      END AS history,
      trail.web OR plan.news AS web_path,
      trail.calculation OR evidence.calculation AS calculation_path,
      trail.skill AS skill_path, trail.memory AS memory_path,
      trail.browser OR plan.browser OR r.intent = 'restore_browser' AND r.status = 'partial' AS browser_path,
      COALESCE(r.state #>> '{agentRun,verdict,reason}' = 'owner_refused', false)
        OR r.status = 'blocked' AND (r.state #>> '{agentRun,verdict,reason}' IS DISTINCT FROM 'step_failed' OR trail.permission_gate) AS refusal_path
    FROM page p
    JOIN chat_runs r ON r.id = p.run_id
    LEFT JOIN workspace_owner o ON o.id = 1
    LEFT JOIN workspace_members m ON m.user_id = r.owner_id AND m.disabled_at IS NULL
    LEFT JOIN LATERAL (
      SELECT
        bool_or(entry->>'action' ~ '^search[[:space:]]' AND entry->>'result' LIKE 'results:%' AND entry->'changed' = 'true'::jsonb
          OR entry->>'action' ~ '^read[[:space:]]' AND entry->>'result' ~ '^HTTP [0-9]{3} ' AND entry->'changed' = 'true'::jsonb) AS web,
        bool_or(entry->>'action' IN ('calculate', 'calculation_memory')) AS calculation,
        bool_or(entry->>'action' = 'skill_read') AS skill,
        bool_or(entry->>'action' IN ('memory_search', 'memory_save', 'calculation_memory', 'user_fact_memory', 'memory_verify', 'user_note_verify')
          AND entry->>'result' !~ '^(failed:|already done|rejected by)') AS memory,
        bool_or(entry->>'action' ~ '^(open|click|type|select|press|scroll|back|wait|look|read_more|form)([[:space:]]|$)'
          AND entry->>'result' ~ '^(now at |opened |clicked |typed into |selected |pressed |scrolled$|went back$|waited$|seen: |showing page text from )') AS browser,
        bool_or(entry->>'action' = 'permission gate') AS permission_gate
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.state->'trail') = 'array' THEN r.state->'trail' ELSE '[]'::jsonb END) entry
      WHERE p.event_kind = 'terminal' AND r.status IN ('completed', 'partial', 'blocked')
    ) trail ON true
    LEFT JOIN LATERAL (
      SELECT bool_or(entry->>'kind' = 'computation' AND entry->'independent' = 'true'::jsonb) AS calculation
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.state #> '{agentRun,evidence}') = 'array'
        THEN r.state #> '{agentRun,evidence}' ELSE '[]'::jsonb END) entry
      WHERE p.event_kind = 'terminal' AND r.status IN ('completed', 'partial', 'blocked')
    ) evidence ON true
    LEFT JOIN LATERAL (
      SELECT bool_or(entry->>'state' = 'verified' AND entry->>'capability' = 'news.read') AS news,
        bool_or(entry->>'state' = 'verified' AND (entry->>'capability' LIKE 'browser.%' OR entry->>'capability' = 'news.read')) AS browser
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.state #> '{agentRun,plan,steps}') = 'array'
        THEN r.state #> '{agentRun,plan,steps}' ELSE '[]'::jsonb END) entry
      WHERE p.event_kind = 'terminal' AND r.status IN ('completed', 'partial', 'blocked')
    ) plan ON true
    ORDER BY p.event_at, p.run_id, p.event_kind`.execute(db);

  const page = query.rows.slice(0, batch);
  const samples: PersistedChatSample[] = [];
  for (const row of page) {
    if (row.traffic_role !== 'owner' && row.traffic_role !== 'member') continue;
    const atMs = new Date(row.event_at).getTime();
    if (!Number.isFinite(atMs)) continue;
    // The visibility event's created_at is transaction start. Its explicit marker times the initial progress write.
    const firstProgressMs = typeof row.first_progress_at === 'number' ? row.first_progress_at - atMs : NaN;
    const observation: ChatObservation = row.event_kind === 'start'
      ? { started: true, ...(Number.isFinite(firstProgressMs) && firstProgressMs >= 0 ? { firstProgressMs } : {}) }
      : terminalObservation(row, atMs);
    const key = createHash('sha256').update(row.event_kind).update('\0').update(row.run_id).digest('hex');
    samples.push({ key, atMs, role: row.traffic_role, observation });
  }
  const last = page.at(-1);
  const nextCursor = query.rows.length > batch && last ? { at: last.cursor_at, runId: last.run_id, kind: last.event_kind } : undefined;
  return { samples, ...(nextCursor ? { nextCursor } : {}) };
}
