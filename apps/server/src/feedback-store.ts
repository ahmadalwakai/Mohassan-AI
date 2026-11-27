import { createHash } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { FeedbackDecision, FeedbackItem, FeedbackReviewInput } from '@mohassan/contracts';
import { isFollowUp } from './assistant/hands.js';
import { feedbackPageKey, safeFeedbackText } from './feedback-page-key.js';
import type { WorkspaceRole } from './members.js';

type Actor = { id: string; role: WorkspaceRole };
type Publication = {
  messageId: string;
  question: string;
  previousQuestion?: string | null;
  evidenceUrls: readonly string[];
};

function requireOwner(actor: Actor) {
  if (actor.role !== 'owner') {
    throw Object.assign(new Error('هذه الخدمة متاحة للمالك فقط.'), { statusCode: 403, code: 'FEEDBACK_OWNER_REQUIRED' });
  }
}

export const safeFeedbackNote = safeFeedbackText;

function normalizedQuestion(value: string | null | undefined) {
  if (!value || /\[(?:محجوب|redacted)\]/iu.test(value) || safeFeedbackText(value) === null) return null;
  return value.normalize('NFC').replace(/\s+/gu, ' ').trim() || null;
}

export function feedbackQuestionKey(question: string, previousQuestion?: string | null) {
  const current = normalizedQuestion(question);
  if (!current) return null;
  const followUp = isFollowUp(current);
  const previous = followUp ? normalizedQuestion(previousQuestion) : null;
  if (followUp && !previous) return null;
  return createHash('sha256').update(JSON.stringify([current, previous])).digest('hex');
}

export async function recordFeedbackAnswer(tx: Kysely<any>, { messageId, question, previousQuestion, evidenceUrls }: Publication) {
  const questionKey = feedbackQuestionKey(question, previousQuestion);
  if (!questionKey) return;
  const urls = [...new Set(evidenceUrls.flatMap(url => feedbackPageKey(url) ?? []))];
  if (!urls.length) return;
  await tx.insertInto('chat_feedback_evidence').values({
    message_id: messageId, question_key: questionKey, question, evidence_urls: urls,
  }).onConflict(conflict => conflict.column('message_id').doNothing()).execute();
}

export async function feedbackEvidencePolicy(db: Kysely<any>, actor: Actor, question: string, previousQuestion?: string | null) {
  const blocked = new Set<string>();
  const pinned = new Set<string>();
  const key = actor.role === 'owner' ? feedbackQuestionKey(question, previousQuestion) : null;
  if (!key) return { blocked, pinned };

  const rows = await db.selectFrom('chat_feedback_evidence as s')
    .innerJoin('chat_feedback_reviews as r', 'r.message_id', 's.message_id')
    .innerJoin('chat_messages as m', 'm.id', 's.message_id')
    .innerJoin('chat_conversations as c', 'c.id', 'm.conversation_id')
    .select(['r.source_url', 'r.decision']).where('s.question_key', '=', key).where('c.owner_id', '=', actor.id)
    .where('r.decision', 'in', ['pin', 'block']).execute() as { source_url: string; decision: 'pin' | 'block' }[];
  for (const row of rows) (row.decision === 'pin' ? pinned : blocked).add(row.source_url);
  for (const url of blocked) pinned.delete(url);
  return { blocked, pinned };
}

interface FeedbackRow {
  id: string;
  conversation_id: string;
  message_id: string;
  question: string | null;
  previous_user_message: string | null;
  reply: string;
  evidence_urls: string[] | null;
  verdict: FeedbackItem['verdict'];
  note: string | null;
  decision: FeedbackDecision | null;
  source_url: string | null;
  created_at: Date;
  reviewed_at: Date | null;
}

function feedbackTargets(db: Kysely<any>, actorId: string) {
  return db.selectFrom('chat_events as e')
    .innerJoin('chat_conversations as c', 'c.id', 'e.conversation_id')
    .innerJoin('chat_messages as m', join => join.onRef('m.conversation_id', '=', 'c.id')
      .on('m.id', '=', sql<string>`e.data->>'messageId'`).on('m.role', '=', 'assistant'))
    .where('e.kind', '=', 'feedback').where('c.owner_id', '=', actorId)
    .where('e.message', 'in', ['useful', 'wrong', 'incomplete']);
}

function feedbackEvents(db: Kysely<any>, actorId: string) {
  return feedbackTargets(db, actorId)
    .leftJoin('chat_feedback_evidence as s', 's.message_id', 'm.id')
    .leftJoin('chat_feedback_reviews as r', 'r.message_id', 'm.id')
    .select(['e.id', 'e.conversation_id', 'm.id as message_id', 'm.text as reply', 's.question', 's.evidence_urls',
      'e.message as verdict', 'e.created_at', 'r.decision', 'r.source_url', 'r.reviewed_at'])
    .select(sql<string | null>`e.data->>'note'`.as('note'))
    .select(eb => eb.selectFrom('chat_messages as u').select('u.text')
      .whereRef('u.conversation_id', '=', 'm.conversation_id').where('u.role', '=', 'user')
      .whereRef('u.created_at', '<=', 'm.created_at').orderBy('u.created_at', 'desc').orderBy('u.id', 'desc').limit(1)
      .as('previous_user_message'));
}

function showItem(row: FeedbackRow): FeedbackItem {
  return {
    id: row.id, conversationId: row.conversation_id, messageId: row.message_id,
    question: safeFeedbackText(row.question ?? row.previous_user_message), reply: safeFeedbackText(row.reply),
    evidenceUrls: row.evidence_urls ?? [], verdict: row.verdict, note: safeFeedbackNote(row.note),
    decision: row.decision, sourceUrl: row.source_url,
    createdAt: new Date(row.created_at).toISOString(), reviewedAt: row.reviewed_at ? new Date(row.reviewed_at).toISOString() : null,
  };
}

export async function listFeedback(db: Kysely<any>, actor: Actor, options: { pendingOnly?: boolean; limit?: number; offset?: number } = {}) {
  requireOwner(actor);
  let query = feedbackEvents(db, actor.id);
  if (options.pendingOnly) query = query.where('r.message_id', 'is', null);
  return (await query.orderBy('e.created_at', 'desc').orderBy('e.id', 'desc')
    .limit(options.limit ?? 30).offset(options.offset ?? 0).execute() as FeedbackRow[]).map(showItem);
}

export async function reviewFeedback(db: Kysely<any>, actor: Actor, id: string, input: FeedbackReviewInput) {
  requireOwner(actor);
  return db.transaction().execute(async tx => {
    // Serialize decisions for a message, including concurrent first reviews and clears.
    const target = await feedbackTargets(tx, actor.id).select('m.id').where('e.id', '=', id)
      .forNoKeyUpdate('m').executeTakeFirst();
    const row = target && await feedbackEvents(tx, actor.id).where('e.id', '=', id).executeTakeFirst() as FeedbackRow | undefined;
    if (!row) throw Object.assign(new Error('تعذر العثور على عنصر التغذية الراجعة.'), { statusCode: 404, code: 'FEEDBACK_NOT_FOUND' });

    if (input.decision === 'clear') {
      await tx.deleteFrom('chat_feedback_reviews').where('message_id', '=', row.message_id).execute();
      return showItem({ ...row, decision: null, source_url: null, reviewed_at: null });
    }

    const sourceUrl = 'sourceUrl' in input ? feedbackPageKey(input.sourceUrl) : null;
    if (input.decision !== 'dismiss' && (!sourceUrl || !row.evidence_urls?.includes(sourceUrl))) {
      throw Object.assign(new Error('هذا المصدر ليس ضمن الأدلة المسجلة للرد.'), { statusCode: 409, code: 'FEEDBACK_SOURCE_NOT_FOUND' });
    }
    if (row.decision === input.decision && row.source_url === sourceUrl) return showItem(row);

    const review = { decision: input.decision, source_url: sourceUrl, reviewed_at: new Date() };
    await tx.insertInto('chat_feedback_reviews').values({ message_id: row.message_id, ...review })
      .onConflict(conflict => conflict.column('message_id').doUpdateSet(review)).execute();
    return showItem({ ...row, ...review });
  });
}
