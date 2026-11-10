import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { CampaignEventSchema, isCampaignTerminal, reduceCampaignEvents, type CampaignEvent, type CampaignEventInput, type CampaignEventStream } from '@mohassan/contracts';

/**
 * The campaign event log. Append-only and ordered by a per-task sequence number,
 * so any reader can replay it from the start or resume after the last number it
 * holds. It is both the live progress feed and the audit record of the chat side;
 * what Google was asked and answered stays in google_ads_audit.
 */
type Db = Kysely<any>;
const MAX_EVENTS_PER_TASK = 400;

export async function campaignEventsMigration(tx: Db) {
  if (await tx.selectFrom('schema_migrations').select('version').where('version', '=', '029_chat_campaign_events').executeTakeFirst()) return;
  await sql`CREATE TABLE chat_campaign_events(id text PRIMARY KEY,conversation_id text NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,run_id text NOT NULL,task_id text NOT NULL,seq integer NOT NULL,type text NOT NULL,step_id text,status text NOT NULL,data jsonb NOT NULL,dedup_key text,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(task_id,seq),UNIQUE(task_id,dedup_key))`.execute(tx);
  await sql`CREATE INDEX chat_campaign_events_conversation_idx ON chat_campaign_events(conversation_id,created_at DESC,seq DESC)`.execute(tx);
  await tx.insertInto('schema_migrations').values({ version: '029_chat_campaign_events' }).execute();
}

const toEvent = (row: any): CampaignEvent => CampaignEventSchema.parse({
  id: row.id, taskId: row.task_id, seq: row.seq, type: row.type, stepId: row.step_id, status: row.status,
  data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data, at: new Date(row.created_at).toISOString(),
});

export interface CampaignEventTarget { conversationId: string; runId: string; taskId: string }

/**
 * Appends one event. The caller holds the conversation row lock, which is what
 * makes the sequence number gap-free and the write fenced to the live run.
 * A `dedupKey` makes the append idempotent: the same fact reported twice, for
 * example after a resumed run, is stored once. Returns false when it was a repeat.
 */
export async function appendCampaignEvent(tx: Db, target: CampaignEventTarget, input: CampaignEventInput, options: { dedupKey?: string; redact?: <T>(value: T) => T } = {}): Promise<boolean> {
  const data = options.redact ? options.redact(input.data) : input.data;
  if (options.dedupKey && await tx.selectFrom('chat_campaign_events').select('id').where('task_id', '=', target.taskId).where('dedup_key', '=', options.dedupKey).executeTakeFirst()) return false;
  const last = await tx.selectFrom('chat_campaign_events').select(['seq', 'type']).where('task_id', '=', target.taskId).orderBy('seq', 'desc').limit(1).executeTakeFirst();
  // A finished task stays finished, and a runaway emitter cannot grow the log without bound.
  if (last && (isCampaignTerminal({ type: last.type }) || last.seq >= MAX_EVENTS_PER_TASK - (isCampaignTerminal(input) ? 0 : 1))) return false;
  const id = randomUUID(), seq = (last?.seq ?? 0) + 1;
  // Parsed before it is stored: an event the contract rejects never reaches a client.
  CampaignEventSchema.parse({ id, taskId: target.taskId, seq, type: input.type, stepId: input.stepId, status: input.status, data, at: new Date().toISOString() });
  await tx.insertInto('chat_campaign_events').values({ id, conversation_id: target.conversationId, run_id: target.runId, task_id: target.taskId, seq, type: input.type, step_id: input.stepId, status: input.status, data: JSON.stringify(data), dedup_key: options.dedupKey ?? null }).execute();
  return true;
}

/** The latest campaign task of a conversation, from `after` onward. `after: 0` replays everything. */
export async function readCampaignEvents(db: Db, conversationId: string, after = 0): Promise<CampaignEventStream | null> {
  const latest = await db.selectFrom('chat_campaign_events').select('task_id').where('conversation_id', '=', conversationId).orderBy('created_at', 'desc').orderBy('seq', 'desc').limit(1).executeTakeFirst();
  if (!latest) return null;
  const rows = await db.selectFrom('chat_campaign_events').selectAll().where('task_id', '=', latest.task_id).where('conversation_id', '=', conversationId).orderBy('seq', 'asc').limit(MAX_EVENTS_PER_TASK).execute();
  const events = rows.map(toEvent);
  return { taskId: latest.task_id, lastSeq: events.at(-1)?.seq ?? 0, events: events.filter(item => item.seq > after) };
}

/**
 * Ends every campaign task a run left open, for a run that stopped without
 * finishing its task: cancelled, failed or interrupted. Whether a write was sent
 * and never settled is read from the log itself, so the terminal event cannot
 * understate an unresolved change in the account.
 */
export async function closeOpenCampaignTasks(tx: Db, conversationId: string, runId: string, build: (unresolvedWrite: boolean) => CampaignEventInput): Promise<void> {
  const tasks = await tx.selectFrom('chat_campaign_events').select('task_id').distinct().where('run_id', '=', runId).where('conversation_id', '=', conversationId).execute();
  for (const { task_id: taskId } of tasks) {
    const rows = await tx.selectFrom('chat_campaign_events').selectAll().where('task_id', '=', taskId).orderBy('seq', 'asc').limit(MAX_EVENTS_PER_TASK).execute();
    const progress = reduceCampaignEvents(rows.map(toEvent));
    if (!progress || progress.status !== 'running') continue;
    const unresolvedWrite = progress.operations.some(operation => operation.mutates && operation.state === 'started');
    await appendCampaignEvent(tx, { conversationId, runId, taskId }, build(unresolvedWrite));
  }
}
