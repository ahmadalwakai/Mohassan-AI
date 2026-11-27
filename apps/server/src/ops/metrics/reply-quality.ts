import { ModelCouncilSchema, type CouncilMetrics, type MetricWindow, type ReplyFeedbackMetrics, type ReplyFeedbackSource, type TrafficRole } from '@mohassan/contracts';
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { z } from 'zod';
import { modelRegistry } from '../../../../../packages/model-relations/src/registry.js';
import { PIPELINE, WEB_SEARCH } from '../../assistant/model-council.js';

type ReplyWindow = Pick<MetricWindow, 'startMs' | 'endMs'>;
type Count = string | number | bigint;

// Match the persisted chat metrics' role lookup for the conversation owner.
const replyRole = sql`CASE WHEN o.owner_id = c.owner_id THEN 'owner' ELSE member.role END`;
const replyAccounts = sql`
  JOIN chat_conversations c ON c.id = m.conversation_id
  LEFT JOIN workspace_owner o ON o.id = 1
  LEFT JOIN workspace_members member ON member.user_id = c.owner_id AND member.disabled_at IS NULL`;

const councilVersion = sql`m.council->'version' = ${ModelCouncilSchema.shape.version.value}::text::jsonb`;
const councilModels = sql.join([PIPELINE, WEB_SEARCH, ...modelRegistry.map(model => model.id)].map(model => sql`${model}`));
const maxCouncilMembers = z.toJSONSchema(ModelCouncilSchema.shape.members).maxItems;
const maxCouncilElapsed = ModelCouncilSchema.shape.elapsedMs.maxValue;

type CouncilRow = {
  turns: Count;
  changed_replies: Count;
  chosen_by_model: CouncilMetrics['chosenByModel'] | null;
  member_outcomes: CouncilMetrics['memberOutcomes'] | null;
  elapsed_samples: Count;
  p50: Count | null;
  p90: Count | null;
  p99: Count | null;
  v5_attempted: Count | null;
  v5_answered: Count | null;
  v5_unused_answers: Count | null;
};

/** Count persisted v1 council records and use discrete percentiles over observed elapsed times. */
async function readCouncilMetrics(db: Kysely<any>, bounds: RawBuilder<unknown>): Promise<CouncilMetrics[]> {
  // percentile_disc returns the first observed value whose rank meets each percentile.
  // https://www.postgresql.org/docs/18/functions-aggregate.html (retrieved 2026-11-27)
  const { rows } = await sql<CouncilRow>`
    WITH bounds (window_number, start_at, end_at) AS (VALUES ${bounds}),
    councils AS (
      SELECT b.window_number,
        m.council->'changed' = 'true'::jsonb AS changed,
        CASE WHEN m.council->>'chosen' IN (${councilModels}) THEN m.council->>'chosen' END AS chosen,
        CASE WHEN jsonb_typeof(m.council->'elapsedMs') = 'number'
            AND m.council->'elapsedMs' BETWEEN '0'::jsonb AND ${maxCouncilElapsed}::text::jsonb
          THEN (m.council->>'elapsedMs')::numeric END AS elapsed_ms,
        CASE WHEN jsonb_typeof(m.council->'members') = 'array'
          THEN CASE WHEN jsonb_array_length(m.council->'members') <= ${maxCouncilMembers}
            THEN m.council->'members' ELSE '[]'::jsonb END
          ELSE '[]'::jsonb END AS members
      FROM bounds b
      JOIN chat_messages m ON m.created_at >= b.start_at AND m.created_at < b.end_at
      ${replyAccounts}
      WHERE m.role = 'assistant' AND ${replyRole} = 'owner' AND ${councilVersion}
    ),
    chosen_counts AS (
      SELECT window_number, chosen AS model, count(*) AS selected_count
      FROM councils
      WHERE chosen IS NOT NULL
      GROUP BY window_number, chosen
    ),
    member_counts AS (
      SELECT c.window_number, entry->>'model' AS model,
        count(*) FILTER (WHERE entry->>'outcome' = 'ok') AS ok,
        count(*) FILTER (WHERE entry->>'outcome' = 'abstained') AS abstained,
        count(*) FILTER (WHERE entry->>'outcome' = 'timeout') AS timeout,
        count(*) FILTER (WHERE entry->>'outcome' = 'failed') AS failed,
        count(*) FILTER (WHERE entry->>'round' = 'answer') AS attempted,
        count(*) FILTER (WHERE entry->>'round' = 'answer' AND entry->>'outcome' = 'ok') AS answered,
        count(*) FILTER (WHERE entry->>'round' = 'answer' AND entry->>'outcome' = 'ok'
          AND c.chosen <> 'chat-v5') AS unused_answers
      FROM councils c
      CROSS JOIN LATERAL jsonb_array_elements(c.members) entry
      WHERE entry->>'model' IN (${councilModels})
        AND entry->>'outcome' IN ('ok', 'abstained', 'timeout', 'failed')
      GROUP BY c.window_number, entry->>'model'
    ),
    totals AS (
      SELECT b.window_number,
        count(c.window_number) AS turns,
        count(*) FILTER (WHERE c.changed) AS changed_replies,
        count(c.elapsed_ms) AS elapsed_samples,
        percentile_disc(0.50) WITHIN GROUP (ORDER BY c.elapsed_ms) AS p50,
        percentile_disc(0.90) WITHIN GROUP (ORDER BY c.elapsed_ms) AS p90,
        percentile_disc(0.99) WITHIN GROUP (ORDER BY c.elapsed_ms) AS p99
      FROM bounds b LEFT JOIN councils c ON c.window_number = b.window_number
      GROUP BY b.window_number
    )
    SELECT t.*,
      (SELECT jsonb_object_agg(model, selected_count) FROM chosen_counts
        WHERE window_number = t.window_number) AS chosen_by_model,
      (SELECT jsonb_object_agg(model, jsonb_build_object('ok', ok, 'abstained', abstained, 'timeout', timeout, 'failed', failed))
        FROM member_counts WHERE window_number = t.window_number) AS member_outcomes,
      v5.attempted AS v5_attempted, v5.answered AS v5_answered, v5.unused_answers AS v5_unused_answers
    FROM totals t
    LEFT JOIN member_counts v5 ON v5.window_number = t.window_number AND v5.model = 'chat-v5'
    ORDER BY t.window_number`.execute(db);

  const percentile = (value: Count | null) => value === null ? null : Number(value);
  return rows.map(row => ({
    turns: Number(row.turns),
    changedReplies: Number(row.changed_replies),
    chosenByModel: row.chosen_by_model ?? {},
    memberOutcomes: row.member_outcomes ?? {},
    elapsedMs: {
      samples: Number(row.elapsed_samples), p50: percentile(row.p50), p90: percentile(row.p90), p99: percentile(row.p99),
    },
    v5: {
      attempted: Number(row.v5_attempted ?? 0), answered: Number(row.v5_answered ?? 0), unusedAnswers: Number(row.v5_unused_answers ?? 0),
    },
  }));
}

type FeedbackRow = {
  window_number: number;
  traffic_role: TrafficRole;
  source: ReplyFeedbackSource;
  replies: Count;
  useful: Count;
  wrong: Count;
  incomplete: Count;
};

function emptyFeedback(): ReplyFeedbackMetrics {
  const zero = { replies: 0, useful: 0, wrong: 0, incomplete: 0, unrated: 0 };
  return { pipeline: { ...zero }, v5: { ...zero }, councilChanged: { ...zero } };
}

async function readReplyFeedbackMetrics(
  db: Kysely<any>, bounds: RawBuilder<unknown>, windows: readonly ReplyWindow[], hasCouncil: boolean, hasExperiment: boolean,
): Promise<Record<TrafficRole, ReplyFeedbackMetrics>[]> {
  // A council-changed v5 reply also has experiment = 'v5'. Attribute it once, to the council.
  const changed = hasCouncil ? sql`${councilVersion} AND m.council->'changed' = 'true'::jsonb` : sql`false`;
  const v5 = hasExperiment ? sql`m.experiment = 'v5'` : sql`false`;
  const { rows } = await sql<FeedbackRow>`
    WITH bounds (window_number, start_at, end_at) AS (VALUES ${bounds}),
    replies AS MATERIALIZED (
      SELECT m.id, m.conversation_id, m.created_at, ${replyRole} AS traffic_role,
        CASE WHEN ${changed} THEN 'councilChanged' WHEN ${v5} THEN 'v5' ELSE 'pipeline' END AS source
      FROM chat_messages m
      ${replyAccounts}
      WHERE m.role = 'assistant' AND ${replyRole} IN ('owner', 'member')
        AND m.created_at >= (SELECT min(start_at) FROM bounds)
        AND m.created_at < (SELECT max(end_at) FROM bounds)
        AND NOT EXISTS (
          SELECT 1 FROM chat_notifications n
          WHERE n.task_id = m.id AND n.conversation_id = m.conversation_id AND n.user_id = c.owner_id
            AND n.monitor_id IS NOT NULL
        )
    ),
    ratings AS (
      SELECT DISTINCT ON (r.id) r.id, e.data->>'verdict' AS verdict
      FROM replies r
      JOIN chat_events e ON e.conversation_id = r.conversation_id AND e.data->>'messageId' = r.id AND e.kind = 'feedback'
      ORDER BY r.id, e.created_at DESC, e.id DESC
    )
    SELECT b.window_number, r.traffic_role, r.source, count(*) AS replies,
      count(*) FILTER (WHERE f.verdict = 'useful') AS useful,
      count(*) FILTER (WHERE f.verdict = 'wrong') AS wrong,
      count(*) FILTER (WHERE f.verdict = 'incomplete') AS incomplete
    FROM bounds b
    JOIN replies r ON r.created_at >= b.start_at AND r.created_at < b.end_at
    LEFT JOIN ratings f ON f.id = r.id
    GROUP BY b.window_number, r.traffic_role, r.source`.execute(db);

  const feedback = windows.map(() => ({ owner: emptyFeedback(), member: emptyFeedback() }));
  for (const row of rows) {
    const { replies, useful, wrong, incomplete } = row;
    feedback[row.window_number]![row.traffic_role][row.source] = {
      replies: Number(replies), useful: Number(useful), wrong: Number(wrong), incomplete: Number(incomplete),
      unrated: Number(replies) - Number(useful) - Number(wrong) - Number(incomplete),
    };
  }
  return feedback;
}

type ReplyQualityMetrics = { council?: CouncilMetrics; feedback?: Record<TrafficRole, ReplyFeedbackMetrics> };

/** Read the current aggregates without selecting chat text, model output or feedback notes. */
export async function readReplyQualityMetrics(db: Kysely<any>, windows: readonly ReplyWindow[]): Promise<ReplyQualityMetrics[]> {
  if (!windows.length) return [];
  const bounds = sql.join(windows.map(({ startMs, endMs }, index) =>
    sql`(${index}::integer, ${new Date(startMs)}::timestamptz, ${new Date(endMs)}::timestamptz)`));
  // Both columns are installed only when their respective chat features are enabled.
  const { rows } = await sql<{ attname: 'council' | 'experiment' }>`
    SELECT attname FROM pg_attribute
    WHERE attrelid = to_regclass('chat_messages') AND NOT attisdropped AND attname IN ('council', 'experiment')`.execute(db);
  const columns = new Set(rows.map(row => row.attname));
  const hasCouncil = columns.has('council');
  const [council, feedback] = await Promise.allSettled([
    hasCouncil ? readCouncilMetrics(db, bounds) : undefined,
    readReplyFeedbackMetrics(db, bounds, windows, hasCouncil, columns.has('experiment')),
  ]);
  return windows.map((_, index) => ({
    ...(council.status === 'fulfilled' && council.value ? { council: council.value[index] } : {}),
    ...(feedback.status === 'fulfilled' ? { feedback: feedback.value[index] } : {}),
  }));
}
