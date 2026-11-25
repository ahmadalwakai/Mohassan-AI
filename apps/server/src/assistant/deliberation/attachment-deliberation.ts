import { randomUUID } from 'node:crypto';
import type { ChatRunView } from '@mohassan/contracts';
import type { Kysely } from 'kysely';
import { createRunLedger, decideVerdict, projectRunView, tryEnterPhase } from '../agent-run.js';
import type { ImageReply } from '../image-reading.js';
import type { ShadowRouter } from '../router.js';
import { decideRequestRoute } from '../routing-decision.js';
import { deliberate, sameDecision } from './decision.js';
import { reviewDeliberationResult } from './review.js';
import { recordDeliberation } from './run-ledger.js';
import type { DecisionOutcome } from './types.js';

const attachmentEvent = 'attachment_deliberation';
const imagePath = { action: 'act', route: 'image', handler: 'image_attachment' } as const satisfies DecisionOutcome;

/** Reading an explicitly attached image is the only executable action in this synchronous path. */
export function prepareAttachmentDeliberation(request: string, router?: ShadowRouter) {
  const startedAt = Date.now();
  const routed = decideRequestRoute({ text: request, now: new Date(startedAt), capabilities: { imageModel: true } });
  let b0;
  try { b0 = router?.topCandidates?.(request); } catch { /* Local shadow errors cannot stop image reading. */ }
  const decision = deliberate({ text: request, legacy: imagePath, b0,
    routing: { ...routed, route: 'image', handler: 'image', intent: 'image', availability: 'ready', reason: 'explicit_handler',
      sourceAssessment: { version: 1, source: 'supplied_content', scope: 'private', operation: 'lookup', destination: 'unknown',
        publicQueryEligible: false, reasons: ['non_lookup_operation'] } },
    predicates: [{ route: 'image', handler: 'image_attachment', matched: true },
      ...(routed.route === 'image' ? [] : [{ route: routed.route, handler: 'routing_suggestion', matched: true, strength: 'weak' as const, eligible: false }])],
  });
  const reading = decision.readings.find(reading => reading.route === 'image');
  return { request, startedAt, decision, reading };
}

/** Use the conversation's existing event ledger without fabricating a queued chat run. */
export async function recordAttachmentDeliberation(tx: Kysely<any>, conversationId: string,
    prepared: ReturnType<typeof prepareAttachmentDeliberation>, reply: ImageReply, at: number, enabled: boolean) {
  const { request, startedAt, decision, reading } = prepared;
  const unfulfilled = reply.intent === 'translate' || reply.intent === 'summarize'
    || reply.outcome === 'no_text' && reply.intent !== 'describe'
    || /^(?:لم أجد في نص الصورة ما يجيب عن سؤالك مباشرة|Nothing in the image text answers your question directly)/mu.test(reply.text);
  const review = reviewDeliberationResult({ request, reading, decision: 'act', reply: reply.text,
    status: unfulfilled ? 'partial' : 'completed', protectedReply: true }, enabled);
  const runId = randomUUID();
  const ledger = createRunLedger({ runId, at: startedAt, path: 'direct' });
  const trace = { ...decision.trace, legacy: imagePath, disagrees: !sameDecision(decision.outcome, imagePath, true), review: review.record, enforced: enabled };
  if (!recordDeliberation(ledger, trace, at)) return;
  tryEnterPhase(ledger, 'understanding', startedAt);
  tryEnterPhase(ledger, 'answering', at);
  decideVerdict(ledger, { hostStatus: review.status, at });
  await tx.insertInto('chat_events').values({ id: runId, conversation_id: conversationId, run_id: null,
    kind: attachmentEvent, message: '', data: JSON.stringify({ status: review.status, ledger }), created_at: new Date(at) }).execute();
}

/** The attachment event is a run view only for the owner, and only while it is the latest work. */
export async function latestAttachmentRun(db: Kysely<any>, conversationId: string, owner: boolean, after?: Date | string): Promise<ChatRunView | null> {
  if (!owner) return null;
  const events = db.selectFrom('chat_events').select(['id', 'data', 'created_at'])
    .where('conversation_id', '=', conversationId).where('kind', '=', attachmentEvent).where('run_id', 'is', null);
  const event = await (after ? events.where('created_at', '>', after) : events).orderBy('created_at', 'desc').orderBy('id', 'desc').executeTakeFirst();
  if (!event) return null;
  let data = event.data;
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch { return null; } }
  if (!data || !['completed', 'partial', 'blocked'].includes(data.status)) return null;
  const run = projectRunView({ runId: event.id, status: data.status, ledger: data.ledger,
    createdAt: event.created_at, updatedAt: event.created_at, includeDeliberation: true });
  return run?.deliberation ? run : null;
}
