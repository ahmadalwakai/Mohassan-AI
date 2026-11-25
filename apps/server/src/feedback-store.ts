import { createHash, randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { FeedbackDecision, FeedbackItem, FeedbackMetrics, FeedbackPolicy } from '@mohassan/contracts';
import { isFollowUp } from './assistant/hands.js';
import { matchText, normalizeRequest, stripCourtesyTail } from './assistant/mind/normalize.js';
import { feedbackPageKey, feedbackSourceUrls, redactFeedbackUrls } from './feedback-page-key.js';

export { feedbackPageKey } from './feedback-page-key.js';

type Actor = { id: string; role: 'owner' | 'member' };
type Snapshot = Pick<FeedbackItem, 'question' | 'reply' | 'evidenceUrls' | 'route' | 'judgeDecision'> & {
  previousQuestion: string | null;
  status: string | null;
};
type Submission = Pick<FeedbackItem, 'userId' | 'conversationId' | 'messageId' | 'verdict' | 'note'>;
type Publication = Omit<Snapshot, 'previousQuestion' | 'status'> &
  Partial<Pick<Snapshot, 'previousQuestion' | 'status'>> & Pick<Submission, 'userId' | 'conversationId' | 'messageId'>;

export type FeedbackRegressionCase = Snapshot & {
  feedbackVerdict: FeedbackItem['verdict'];
  feedbackNote: string | null;
  decision: FeedbackDecision;
};
export interface FeedbackRegressionExport {
  version: 1;
  purpose: 'regression' | 'training';
  cases: { sha256: string; case: FeedbackRegressionCase }[];
}

interface CaseRow {
  id: string;
  user_id: string;
  conversation_id: string;
  message_id: string;
  question_key: string;
  snapshot: Snapshot;
  verdict: FeedbackItem['verdict'];
  note: string | null;
  wrong_reported_at: Date | null;
  created_at: Date;
  decision: FeedbackDecision | null;
  reviewed_at: Date | null;
  case_sha256: string | null;
  training_allowed: boolean;
}

interface PolicyRow {
  id: string;
  case_id: string;
  question_key: string;
  page_url: string;
  kind: FeedbackPolicy['kind'];
  reporter_id: string | null;
  expires_at: Date;
  cleared_at: Date | null;
}

const POLICY_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const iso = (date: Date) => new Date(date).toISOString();
const missing = () => Object.assign(new Error('تعذر العثور على عنصر التغذية الراجعة.'), { statusCode: 404, code: 'FEEDBACK_NOT_FOUND' });
const conflict = (message: string) => Object.assign(new Error(message), { statusCode: 409, code: 'FEEDBACK_CONFLICT' });

function requireOwner(actor: Actor) {
  if (actor.role !== 'owner') {
    throw Object.assign(new Error('هذا الإجراء متاح للمالك فقط.'), { statusCode: 403, code: 'FEEDBACK_OWNER_REQUIRED' });
  }
}

function normalizedQuestion(question: string) {
  const text = normalizeRequest(stripCourtesyTail(redactFeedbackUrls(question))).text;
  // Keep the identity of explicit URLs, whose paths and query parameters may be case-sensitive.
  return text.split(/(https?:\/\/[^\s<>«»"'\x60]+)/giu)
    .map((part, index, parts) => index % 2 ? part : matchText(index === parts.length - 1 ? part.replace(/[.!?؟]+$/u, '') : part)).join('')
    .replace(/\s+/gu, ' ').trim();
}

export function feedbackQuestionKey(question: string, previousQuestion?: string | null): string | null {
  const normalized = normalizedQuestion(question);
  if (!normalized) return null;
  const previous = previousQuestion && isFollowUp(normalized) ? normalizedQuestion(previousQuestion) : '';
  // A redacted request cannot safely share a source rule with another ambiguous request.
  if ([normalized, previous].some(text => /\[(?:محجوب|redacted)\]/u.test(text))) return null;
  return sha256(JSON.stringify([normalized, previous]));
}

async function lockQuestionKey(db: Kysely<any>, key: string) {
  if (key) {
    const lockId = BigInt.asIntN(64, BigInt('0x' + key.slice(0, 16))).toString();
    await sql`SELECT pg_advisory_xact_lock(${lockId}::bigint)`.execute(db);
  }
}

/** Policy changes and final answer publication serialize by question class. */
export async function lockFeedbackQuestion(db: Kysely<any>, question: string, previousQuestion?: string | null) {
  await lockQuestionKey(db, feedbackQuestionKey(question, previousQuestion) ?? '');
}

const mindReadTime = /(?:Read at|وقت القراءة) \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/u.source;

/** Ignore the source read time and whitespace changes while comparing shown replies. */
function answerFingerprint(reply: string) {
  return sha256(redactFeedbackUrls(reply).normalize('NFC')
    .replace(/ · (?:read|قُرئت) \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC(?=\s*(?:\n|$))/gu, '')
    .replace(new RegExp(` · ${mindReadTime}(?=\\s*(?:\\n|$))| \\(${mindReadTime}\\)`, 'gu'), '')
    .replace(new RegExp(`\\(${mindReadTime} · (?=(?:Source date|تاريخ المصدر) )`, 'gu'), '(')
    .replace(/\s+/gu, ' ').trim());
}

function freezeCase(data: FeedbackRegressionCase): FeedbackRegressionCase {
  // Define the JSON property order here. PostgreSQL JSONB stores object keys in its own order.
  return {
    question: data.question,
    previousQuestion: data.previousQuestion,
    reply: data.reply,
    evidenceUrls: [...data.evidenceUrls].sort(),
    route: data.route,
    judgeDecision: data.judgeDecision,
    status: data.status,
    feedbackVerdict: data.feedbackVerdict,
    feedbackNote: data.feedbackNote,
    decision: data.decision,
  };
}

export function feedbackCaseSha256(data: FeedbackRegressionCase): string {
  return sha256(JSON.stringify(freezeCase(data)));
}

async function databaseNow(db: Kysely<any>): Promise<Date> {
  const { rows } = await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(db);
  return new Date(rows[0].now);
}

function normalizedUrls(urls: readonly string[]) {
  return [...new Set(urls.map(feedbackPageKey).filter((url): url is string => url !== null))];
}

export async function recordFeedbackAnswer(tx: Kysely<any>, publication: Publication) {
  const { userId, conversationId, messageId, question, reply } = publication;
  const { status = null, previousQuestion = null, judgeDecision, route } = publication;
  const metadata = {
    question: redactFeedbackUrls(question), previousQuestion: previousQuestion ? redactFeedbackUrls(previousQuestion) : null,
    status, judgeDecision, route, evidenceUrls: normalizedUrls(publication.evidenceUrls),
  };
  const inserted = await tx.insertInto('chat_events').values({
    id: messageId, conversation_id: conversationId, kind: 'feedback_answer',
    message: 'Answer feedback metadata', data: JSON.stringify(metadata),
  }).onConflict(conflict => conflict.column('id').doNothing()).returning('id').executeTakeFirst();

  const questionKey = feedbackQuestionKey(question, previousQuestion);
  if (!inserted || !questionKey) return;
  await lockQuestionKey(tx, questionKey);
  const replySha256 = answerFingerprint(reply);
  // Count this answer only if the question class was already reported wrong by this account
  // or confirmed wrong by the owner. Later decisions cannot rewrite prior observations.
  await sql`INSERT INTO chat_feedback_answer_metrics (message_id, repeated_wrong)
    SELECT ${messageId}, bool_or(reply_sha256 = ${replySha256})
    FROM chat_feedback_cases
    WHERE question_key = ${questionKey} AND (
      decision = 'wrong' OR (user_id = ${userId} AND decision IS NULL AND wrong_reported_at IS NOT NULL)
    )
    HAVING count(*) > 0
    ON CONFLICT (message_id) DO NOTHING`.execute(tx);
}

async function loadSnapshot(tx: Transaction<any>, input: Submission): Promise<Snapshot> {
  const conversation = await tx.selectFrom('chat_conversations').select('id')
    .where('id', '=', input.conversationId).where('owner_id', '=', input.userId).forKeyShare().executeTakeFirst();
  if (!conversation) throw missing();

  const message = await tx.selectFrom('chat_messages').select(['text', 'created_at']).where('id', '=', input.messageId)
    .where('conversation_id', '=', input.conversationId).where('role', '=', 'assistant').forUpdate().executeTakeFirst();
  if (!message) throw missing();

  const event = await tx.selectFrom('chat_events').select('data').where('id', '=', input.messageId)
    .where('conversation_id', '=', input.conversationId).where('kind', '=', 'feedback_answer').executeTakeFirst();
  const reply = redactFeedbackUrls(message.text);
  if (event) return { ...event.data, reply };

  // An older reply has no captured judge outcome. Use only historical request, route and declared sources.
  const [questions, run] = await Promise.all([
    tx.selectFrom('chat_messages').select('text').where('conversation_id', '=', input.conversationId)
      .where('role', '=', 'user').where('created_at', '<=', message.created_at)
      .orderBy('created_at', 'desc').orderBy('id', 'desc').limit(2).execute(),
    tx.selectFrom('chat_runs').select(['state', 'status']).where('conversation_id', '=', input.conversationId)
      .where('created_at', '<=', message.created_at).orderBy('created_at', 'desc').orderBy('id', 'desc').executeTakeFirst(),
  ]);
  return {
    question: redactFeedbackUrls(questions[0]?.text ?? ''), previousQuestion: questions[1] ? redactFeedbackUrls(questions[1].text) : null,
    reply, evidenceUrls: feedbackSourceUrls(message.text),
    route: run?.state?.routing?.route ?? null, judgeDecision: null, status: run?.status ?? null,
  };
}

type AuditAction = 'submitted' | 'reviewed' | 'policy_created' | 'policy_cleared' | 'training_allowed' | 'training_revoked';

async function audit(tx: Transaction<any>, caseId: string, actorId: string, action: AuditAction,
  at: Date, details: Record<string, unknown>, policyId?: string) {
  await tx.insertInto('chat_feedback_audit').values({
    id: randomUUID(), case_id: caseId, actor_id: actorId, action, at,
    policy_id: policyId ?? null, details: JSON.stringify(details),
  }).execute();
}

async function addPolicies(tx: Transaction<any>, row: CaseRow, actorId: string, kind: FeedbackPolicy['kind'],
  reporterId: string | null, now: Date) {
  if (!row.question_key) return;
  const expiry = new Date(now.getTime() + POLICY_DURATION_MS);
  for (const page of row.snapshot.evidenceUrls) {
    const id = randomUUID();
    await tx.insertInto('chat_feedback_policies').values({
      id, case_id: row.id, question_key: row.question_key, reporter_id: reporterId,
      page_url: page, kind, created_at: now, expires_at: expiry,
    }).execute();
    await audit(tx, row.id, actorId, 'policy_created', now, {
      kind, scope: reporterId === null ? 'workspace' : 'reporter', expiresAt: iso(expiry),
    }, id);
  }
}

export async function captureFeedback(tx: Transaction<any>, input: Submission) {
  const snapshot = await loadSnapshot(tx, input);
  const existing = await tx.selectFrom('chat_feedback_cases').selectAll()
    .where('message_id', '=', input.messageId).forNoKeyUpdate().executeTakeFirst() as CaseRow | undefined;
  const note = input.note ? redactFeedbackUrls(input.note) : null;
  // Re-sending a rating cannot reverse an owner's decision or extend an active block.
  if (existing?.decision || (existing?.verdict === input.verdict && existing.note === note)) return;
  const questionKey = existing?.question_key ?? feedbackQuestionKey(snapshot.question, snapshot.previousQuestion) ?? '';
  await lockQuestionKey(tx, questionKey);
  const now = await databaseNow(tx);
  const newBlock = input.verdict === 'wrong' && !existing?.wrong_reported_at;
  const wrongReportedAt = newBlock ? now : existing?.wrong_reported_at ?? null;
  const id = existing?.id ?? randomUUID();

  if (existing) {
    await tx.updateTable('chat_feedback_cases')
      .set({ verdict: input.verdict, note, wrong_reported_at: wrongReportedAt }).where('id', '=', id).execute();
  } else {
    await tx.insertInto('chat_feedback_cases').values({
      id, user_id: input.userId, conversation_id: input.conversationId, message_id: input.messageId,
      question_key: questionKey,
      reply_sha256: answerFingerprint(snapshot.reply), snapshot: JSON.stringify(snapshot),
      verdict: input.verdict, note, wrong_reported_at: wrongReportedAt, created_at: now,
    }).execute();
  }
  await audit(tx, id, input.userId, 'submitted', now, { verdict: input.verdict });
  if (newBlock) {
    const row = await tx.selectFrom('chat_feedback_cases').selectAll().where('id', '=', id).executeTakeFirstOrThrow() as CaseRow;
    await addPolicies(tx, row, input.userId, 'block', input.userId, now);
  }
}

export async function feedbackEvidencePolicy(db: Kysely<any>, userId: string, question: string, previousQuestion?: string | null) {
  const blocked = new Set<string>();
  const pinned = new Set<string>();
  const key = feedbackQuestionKey(question, previousQuestion);
  if (key) {
    const rows = await db.selectFrom('chat_feedback_policies').select(['page_url', 'kind'])
      .where('question_key', '=', key).where('cleared_at', 'is', null).where('expires_at', '>', sql`clock_timestamp()`)
      .where(eb => eb.or([eb('reporter_id', 'is', null), eb('reporter_id', '=', userId)])).execute() as Pick<PolicyRow, 'page_url' | 'kind'>[];
    for (const row of rows) (row.kind === 'block' ? blocked : pinned).add(row.page_url);
    for (const url of blocked) pinned.delete(url);
  }
  return { blocked, pinned };
}

function showPolicy(row: PolicyRow, now: Date): FeedbackPolicy {
  return {
    id: row.id, url: row.page_url, kind: row.kind, scope: row.reporter_id === null ? 'workspace' : 'reporter',
    expiresAt: iso(row.expires_at), active: row.cleared_at === null && new Date(row.expires_at) > now,
    clearedAt: row.cleared_at ? iso(row.cleared_at) : null,
  };
}

async function showItems(db: Kysely<any>, rows: CaseRow[]): Promise<FeedbackItem[]> {
  if (!rows.length) return [];
  const now = await databaseNow(db);
  const policies = await db.selectFrom('chat_feedback_policies').selectAll()
    .where('case_id', 'in', rows.map(row => row.id)).orderBy('created_at').orderBy('page_url').orderBy('id').execute() as PolicyRow[];
  const perItem = new Map<string, FeedbackPolicy[]>();
  for (const policy of policies) {
    const items = perItem.get(policy.case_id) ?? [];
    items.push(showPolicy(policy, now));
    perItem.set(policy.case_id, items);
  }
  return rows.map(row => ({
    id: row.id, userId: row.user_id, conversationId: row.conversation_id, messageId: row.message_id,
    question: row.snapshot.question, reply: row.snapshot.reply, evidenceUrls: row.snapshot.evidenceUrls,
    route: row.snapshot.route, judgeDecision: row.snapshot.judgeDecision, verdict: row.verdict, note: row.note,
    decision: row.decision, createdAt: iso(row.created_at), reviewedAt: row.reviewed_at ? iso(row.reviewed_at) : null,
    caseSha256: row.case_sha256, trainingAllowed: row.training_allowed, policies: perItem.get(row.id) ?? [],
  }));
}

export async function listFeedback(db: Kysely<any>, actor: Actor, options: { pendingOnly?: boolean; limit?: number; offset?: number } = {}) {
  let query = db.selectFrom('chat_feedback_cases').selectAll();
  if (actor.role !== 'owner') query = query.where('user_id', '=', actor.id);
  if (options.pendingOnly) query = query.where('decision', 'is', null);
  const rows = await query.orderBy('created_at', 'desc').orderBy('id').limit(options.limit ?? 30).offset(options.offset ?? 0).execute();
  return showItems(db, rows as CaseRow[]);
}

async function lockCase(tx: Transaction<any>, id: string) {
  // Audit rows reference this case, so allow their foreign-key locks while serializing case mutations.
  const row = await tx.selectFrom('chat_feedback_cases').selectAll().where('id', '=', id).forNoKeyUpdate().executeTakeFirst() as CaseRow | undefined;
  if (!row) throw missing();
  return row;
}

async function clearPolicy(tx: Transaction<any>, actorId: string, row: PolicyRow, now: Date, reason: 'owner_clear' | 'review') {
  if (row.cleared_at !== null) return row;
  const updated = await tx.updateTable('chat_feedback_policies').set({ cleared_at: now }).where('id', '=', row.id)
    .returningAll().executeTakeFirstOrThrow() as PolicyRow;
  await audit(tx, row.case_id, actorId, 'policy_cleared', now, { reason }, row.id);
  return updated;
}

export async function reviewFeedback(db: Kysely<any>, actor: Actor, id: string, decision: FeedbackDecision) {
  requireOwner(actor);
  return db.transaction().execute(async tx => {
    const row = await lockCase(tx, id);
    if (row.decision) {
      if (row.decision !== decision) throw conflict('سُجّلت مراجعة نهائية لهذا العنصر بالفعل.');
      return (await showItems(tx, [row]))[0];
    }

    await lockQuestionKey(tx, row.question_key);
    const now = await databaseNow(tx);
    const frozen = freezeCase({ ...row.snapshot, feedbackVerdict: row.verdict, feedbackNote: row.note, decision });
    const hash = feedbackCaseSha256(frozen);
    await tx.insertInto('chat_feedback_regression').values({ sha256: hash, frozen_case: JSON.stringify(frozen) })
      .onConflict(conflict => conflict.column('sha256').doNothing()).execute();
    const updated = await tx.updateTable('chat_feedback_cases').set({ decision, reviewed_at: now, case_sha256: hash })
      .where('id', '=', id).returningAll().executeTakeFirstOrThrow() as CaseRow;
    await audit(tx, id, actor.id, 'reviewed', now, { decision, sha256: hash });

    if (decision !== 'unsure') {
      const provisional = await tx.selectFrom('chat_feedback_policies').selectAll().where('case_id', '=', id)
        .where('reporter_id', 'is not', null).where('cleared_at', 'is', null).forUpdate().execute() as PolicyRow[];
      for (const policy of provisional) await clearPolicy(tx, actor.id, policy, now, 'review');
      await addPolicies(tx, updated, actor.id, decision === 'correct' ? 'pin' : 'block', null, now);
    }
    return (await showItems(tx, [updated]))[0];
  });
}

export async function clearFeedbackPolicy(db: Kysely<any>, actor: Actor, id: string) {
  requireOwner(actor);
  return db.transaction().execute(async tx => {
    const policy = await tx.selectFrom('chat_feedback_policies').select('question_key').where('id', '=', id).executeTakeFirst();
    if (!policy) throw missing();
    await lockQuestionKey(tx, policy.question_key);
    const row = await tx.selectFrom('chat_feedback_policies').selectAll().where('id', '=', id).forUpdate()
      .executeTakeFirstOrThrow() as PolicyRow;
    const now = await databaseNow(tx);
    return showPolicy(await clearPolicy(tx, actor.id, row, now, 'owner_clear'), now);
  });
}

export async function setFeedbackTraining(db: Kysely<any>, actor: Actor, id: string, allowed: boolean) {
  requireOwner(actor);
  return db.transaction().execute(async tx => {
    const row = await lockCase(tx, id);
    if (!row.case_sha256) throw conflict('راجع العنصر أولًا قبل تحديد استخدامه في التدريب.');
    if (row.training_allowed === allowed) return (await showItems(tx, [row]))[0];
    const updated = await tx.updateTable('chat_feedback_cases').set({ training_allowed: allowed })
      .where('id', '=', id).returningAll().executeTakeFirstOrThrow() as CaseRow;
    await audit(tx, id, actor.id, allowed ? 'training_allowed' : 'training_revoked', await databaseNow(tx), { sha256: row.case_sha256 });
    return (await showItems(tx, [updated]))[0];
  });
}

export async function exportFeedbackRegression(db: Kysely<any>, actor: Actor, purpose: FeedbackRegressionExport['purpose'] = 'regression') {
  requireOwner(actor);
  let query = db.selectFrom('chat_feedback_regression').select(['sha256', 'frozen_case']);
  if (purpose === 'training') {
    query = query.where(eb => eb.exists(eb.selectFrom('chat_feedback_cases').select('id')
      .whereRef('case_sha256', '=', 'chat_feedback_regression.sha256').where('training_allowed', '=', true)));
  }
  const rows = await query.orderBy('sha256').execute() as { sha256: string; frozen_case: FeedbackRegressionCase }[];
  const cases = rows.map(row => ({ sha256: row.sha256, case: freezeCase(row.frozen_case) }));
  const data: FeedbackRegressionExport = { version: 1, purpose, cases };
  return JSON.stringify(data, null, 2) + '\n';
}

export async function feedbackMetrics(db: Kysely<any>, actor: Actor): Promise<FeedbackMetrics> {
  requireOwner(actor);
  const { rows: [result] } = await sql<{
    opportunities: number | string; repeated: number | string; regression: number | string;
  }>`SELECT count(*) AS opportunities, count(*) FILTER (WHERE repeated_wrong) AS repeated,
    (SELECT count(*) FROM chat_feedback_regression) AS regression
    FROM chat_feedback_answer_metrics`.execute(db);
  const answerOpportunities = Number(result.opportunities);
  const repeatedWrongAnswers = Number(result.repeated);
  return { answerOpportunities, repeatedWrongAnswers, repeatErrorRate: answerOpportunities ? repeatedWrongAnswers / answerOpportunities : null,
    regressionSize: Number(result.regression) };
}
