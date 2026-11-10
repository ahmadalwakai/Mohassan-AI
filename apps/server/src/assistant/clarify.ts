import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import {
  ChatDecisionEventSchema, ClarificationQuestionSpecSchema, GoalFrameSchema, SlotIdSchema,
  type ChatDecisionEvent, type ChatDecisionEventType, type ChatDecisionStream, type ChatGoalSummary, type ChatQuestion,
  type ClarificationOutcome, type ClarificationQuestionSpec, type GoalFrame, type SlotId,
} from '@mohassan/contracts';

/**
 * The chat side of the shared clarification core (`@mohassan/cognitive`): the
 * state saved with a run, the decision-event log and the mapping of an engine
 * question onto the existing chat question. All decisions are made by the core.
 */
type Db = Kysely<any>;
const MAX_EVENTS_PER_RUN = 60;
const MAX_READ = 200;

/** Saved inside the run state (chat_runs.state). Only code writes it; the model never sees it as instructions. */
export interface ClarifyState {
  frame: GoalFrame;
  /** Choices retrieved for questions (for example the user's project names), kept so answers resolve the same way after a restart. */
  choices: Partial<Record<SlotId, readonly string[]>>;
  /** The engine question shown now, with its chat question id. Null when nothing is pending. */
  pending: { chatQuestionId: string; spec: ClarificationQuestionSpec } | null;
  /** The frame version last assessed, so a resumed run does not repeat the same evaluation and events. */
  evaluatedVersion: number;
  outcome: ClarificationOutcome;
  summary: ChatGoalSummary | null;
  /**
   * True while the run is paused on an engine question before any browser page,
   * credential or external effect exists. Such a pause holds nothing in memory, so
   * any server instance may resume it, including after a restart.
   */
  portable: boolean;
  /** Questions the model asked in this run (normalised text), to stop repeats. */
  modelQuestions: string[];
  /** Model questions withheld because the answer was known or already asked. */
  withheld: number;
  /** The settled facts were already written into the tool results. */
  noted: number;
  /** A safe subset only: no account write in this task. */
  draftOnly: boolean;
  /** Slots the task had assumed that the user then set differently: evidence that the assumption was wrong. */
  invalidAssumptions: SlotId[];
}

export function parseClarifyState(raw: unknown): ClarifyState | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<ClarifyState>;
  const frame = GoalFrameSchema.safeParse(value.frame);
  if (!frame.success) return null;
  const spec = value.pending ? ClarificationQuestionSpecSchema.safeParse(value.pending.spec) : null;
  const choices = value.choices && typeof value.choices === 'object' ? Object.fromEntries(Object.entries(value.choices).filter(([, list]) => Array.isArray(list)).map(([slot, list]) => [slot, (list as unknown[]).filter((item): item is string => typeof item === 'string').slice(0, 20)])) as ClarifyState['choices'] : {};
  return {
    frame: frame.data, choices,
    pending: value.pending && spec?.success && typeof value.pending.chatQuestionId === 'string' ? { chatQuestionId: value.pending.chatQuestionId, spec: spec.data } : null,
    evaluatedVersion: Number.isInteger(value.evaluatedVersion) ? value.evaluatedVersion! : 0,
    outcome: value.outcome ?? 'PROCEED', summary: value.summary ?? null, portable: value.portable === true,
    modelQuestions: Array.isArray(value.modelQuestions) ? value.modelQuestions.filter(item => typeof item === 'string').slice(-8) : [],
    withheld: Number.isInteger(value.withheld) ? value.withheld! : 0, noted: Number.isInteger(value.noted) ? value.noted! : 0,
    draftOnly: value.draftOnly === true,
    invalidAssumptions: Array.isArray(value.invalidAssumptions) ? value.invalidAssumptions.filter((slot): slot is SlotId => SlotIdSchema.safeParse(slot).success).slice(0, 16) : [],
  };
}

/** The chat question for an engine question. Option values stay on the server. */
export function chatQuestionFor(spec: ClarificationQuestionSpec, frame: GoalFrame, readiness: ChatGoalSummary['status']): ChatQuestion {
  return {
    id: randomUUID(), prompt: spec.prompt, options: spec.options,
    clarification: { reason: spec.reason, recommendedOptionId: spec.recommendedOptionId, allowText: spec.allowText, slots: spec.slots, goalVersion: frame.version, readiness },
  };
}

export async function decisionEventsMigration(tx: Db) {
  if (await tx.selectFrom('schema_migrations').select('version').where('version', '=', '030_chat_decision_events').executeTakeFirst()) return;
  await sql`CREATE TABLE chat_decision_events(id text PRIMARY KEY,conversation_id text NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,run_id text NOT NULL,seq integer NOT NULL,type text NOT NULL,summary text NOT NULL,data jsonb NOT NULL DEFAULT '{}',dedup_key text,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(conversation_id,seq),UNIQUE(run_id,dedup_key))`.execute(tx);
  await tx.insertInto('schema_migrations').values({ version: '030_chat_decision_events' }).execute();
}

export async function clarificationLessonsMigration(tx: Db) {
  if (await tx.selectFrom('schema_migrations').select('version').where('version', '=', '031_chat_clarification_lessons').executeTakeFirst()) return;
  await sql`CREATE TABLE chat_clarification_lessons(run_id text PRIMARY KEY,owner_id text NOT NULL,domains jsonb NOT NULL,asked jsonb NOT NULL,answered jsonb NOT NULL,declined jsonb NOT NULL,withheld integer NOT NULL,invalid_assumptions jsonb NOT NULL,outcome text NOT NULL CHECK(outcome IN ('verified_success','verified_failure')),created_at timestamptz NOT NULL DEFAULT now())`.execute(tx);
  await sql`CREATE INDEX chat_clarification_lessons_owner_idx ON chat_clarification_lessons(owner_id,created_at DESC)`.execute(tx);
  await tx.insertInto('schema_migrations').values({ version: '031_chat_clarification_lessons' }).execute();
}

const MAX_LESSONS_PER_OWNER = 200;

/**
 * One lesson per run, written only when the run ended with independent verification
 * evidence. It holds slot names and counts, never answers, reasoning or page text.
 * Lessons are read for evaluation; nothing here changes a policy, gate or threshold.
 */
export async function recordClarificationLesson(tx: Db, input: { ownerId: string; runId: string; clarify: ClarifyState; outcome: 'verified_success' | 'verified_failure' | 'unverified' }): Promise<boolean> {
  if (input.outcome === 'unverified') return false;
  const { frame } = input.clarify;
  const asked = [...new Set(frame.asked.flatMap(entry => entry.slots))];
  const answered = [...new Set(frame.answers.filter(answer => answer.kind === 'answer').flatMap(answer => answer.filled))];
  const declined = [...new Set(frame.answers.filter(answer => answer.kind === 'decline').flatMap(answer => answer.slots))];
  if (!asked.length && !input.clarify.withheld && !input.clarify.invalidAssumptions.length) return false;
  await tx.insertInto('chat_clarification_lessons').values({
    run_id: input.runId, owner_id: input.ownerId, domains: JSON.stringify(frame.domains), asked: JSON.stringify(asked), answered: JSON.stringify(answered),
    declined: JSON.stringify(declined), withheld: input.clarify.withheld, invalid_assumptions: JSON.stringify(input.clarify.invalidAssumptions), outcome: input.outcome,
  }).onConflict(conflict => conflict.column('run_id').doNothing()).execute();
  const keep = tx.selectFrom('chat_clarification_lessons').select('run_id').where('owner_id', '=', input.ownerId).orderBy('created_at', 'desc').orderBy('run_id', 'desc').limit(MAX_LESSONS_PER_OWNER);
  await tx.deleteFrom('chat_clarification_lessons').where('owner_id', '=', input.ownerId).where('run_id', 'not in', keep).execute();
  return true;
}

export interface ClarificationLessonStats {
  runs: number;
  /** Per slot: how often it was asked, and in how many of those runs the verified outcome was a success. */
  slots: Record<string, { asked: number; answered: number; declined: number; verifiedSuccess: number }>;
  withheldModelQuestions: number;
  invalidAssumptions: Record<string, number>;
}

export async function readClarificationLessons(db: Db, ownerId: string): Promise<ClarificationLessonStats> {
  const rows = await db.selectFrom('chat_clarification_lessons').selectAll().where('owner_id', '=', ownerId).orderBy('created_at', 'desc').limit(MAX_LESSONS_PER_OWNER).execute();
  const json = (value: unknown): string[] => (typeof value === 'string' ? JSON.parse(value) : value) as string[];
  const stats: ClarificationLessonStats = { runs: rows.length, slots: {}, withheldModelQuestions: 0, invalidAssumptions: {} };
  for (const row of rows) {
    const answered = new Set(json(row.answered)), declined = new Set(json(row.declined));
    for (const slot of json(row.asked)) {
      const entry = stats.slots[slot] ??= { asked: 0, answered: 0, declined: 0, verifiedSuccess: 0 };
      entry.asked += 1;
      if (answered.has(slot)) entry.answered += 1;
      if (declined.has(slot)) entry.declined += 1;
      if (row.outcome === 'verified_success') entry.verifiedSuccess += 1;
    }
    stats.withheldModelQuestions += Number(row.withheld) || 0;
    for (const slot of json(row.invalid_assumptions)) stats.invalidAssumptions[slot] = (stats.invalidAssumptions[slot] ?? 0) + 1;
  }
  return stats;
}

export interface DecisionEventInput { type: ChatDecisionEventType; summary: string; data?: ChatDecisionEvent['data']; dedupKey?: string }

/**
 * Appends decision events. The caller holds the conversation row lock (every
 * chat write path does), which keeps `seq` gap-free and fenced to the live run.
 * A repeated `dedupKey` for the same run is stored once, so a resumed run cannot
 * report the same decision twice. Returns how many were stored.
 */
export async function appendDecisionEvents(tx: Db, target: { conversationId: string; runId: string }, inputs: readonly DecisionEventInput[], redact: (text: string) => string = text => text): Promise<number> {
  let stored = 0;
  for (const input of inputs) {
    if (input.dedupKey && await tx.selectFrom('chat_decision_events').select('id').where('run_id', '=', target.runId).where('dedup_key', '=', input.dedupKey).executeTakeFirst()) continue;
    const count = await tx.selectFrom('chat_decision_events').select(sql<number>`count(*)::int`.as('count')).where('run_id', '=', target.runId).executeTakeFirst();
    if ((count?.count ?? 0) >= MAX_EVENTS_PER_RUN) break;
    const last = await tx.selectFrom('chat_decision_events').select('seq').where('conversation_id', '=', target.conversationId).orderBy('seq', 'desc').limit(1).executeTakeFirst();
    const event = ChatDecisionEventSchema.parse({
      seq: (last?.seq ?? 0) + 1, runId: target.runId, type: input.type, summary: redact(input.summary).slice(0, 300) || input.type,
      data: Object.fromEntries(Object.entries(input.data ?? {}).map(([key, value]) => [key, typeof value === 'string' ? redact(value).slice(0, 400) : Array.isArray(value) ? value.map(item => redact(item).slice(0, 80)).slice(0, 16) : value])),
      at: new Date().toISOString(),
    });
    await tx.insertInto('chat_decision_events').values({ id: randomUUID(), conversation_id: target.conversationId, run_id: target.runId, seq: event.seq, type: event.type, summary: event.summary, data: JSON.stringify(event.data), dedup_key: input.dedupKey ?? null }).execute();
    stored += 1;
  }
  return stored;
}

/** Events after `after`, oldest first, for replay or resynchronisation after a reconnect. */
export async function readDecisionEvents(db: Db, conversationId: string, after = 0, limit = MAX_READ): Promise<ChatDecisionStream> {
  const rows = await db.selectFrom('chat_decision_events').selectAll().where('conversation_id', '=', conversationId).where('seq', '>', after).orderBy('seq', 'asc').limit(Math.max(1, Math.min(limit, MAX_READ))).execute();
  const last = await db.selectFrom('chat_decision_events').select('seq').where('conversation_id', '=', conversationId).orderBy('seq', 'desc').limit(1).executeTakeFirst();
  return {
    lastSeq: last?.seq ?? 0,
    events: rows.map(row => ChatDecisionEventSchema.parse({ seq: row.seq, runId: row.run_id, type: row.type, summary: row.summary, data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data, at: new Date(row.created_at).toISOString() })),
  };
}

/** The latest run's events, newest last, for the conversation detail. */
export async function latestRunDecisions(db: Db, conversationId: string, runId: string | null): Promise<ChatDecisionStream> {
  if (!runId) return { lastSeq: 0, events: [] };
  const rows = await db.selectFrom('chat_decision_events').selectAll().where('conversation_id', '=', conversationId).where('run_id', '=', runId).orderBy('seq', 'desc').limit(30).execute();
  const last = await db.selectFrom('chat_decision_events').select('seq').where('conversation_id', '=', conversationId).orderBy('seq', 'desc').limit(1).executeTakeFirst();
  return { lastSeq: last?.seq ?? 0, events: rows.reverse().map(row => ChatDecisionEventSchema.parse({ seq: row.seq, runId: row.run_id, type: row.type, summary: row.summary, data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data, at: new Date(row.created_at).toISOString() })) };
}
