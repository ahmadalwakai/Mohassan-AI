import { createHash } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { activationEventNames, readActivationEvent, type ActivationEvent } from './activation-registry.js';
import { readActivationLogEvents, readDeliberationLedger } from './activation-log-sources.js';

export type ActivationLogs = Parameters<typeof readActivationLogEvents>[0];

export interface StoredActivationEvent extends ActivationEvent {
  id: string;
  occurredAt: Date;
  owned: boolean;
  ownerConversationId: string | null;
  replyId: string | null;
  judgeReplyCandidate?: string;
}

function judgeReplyCandidate(name: string, value: unknown): string | undefined {
  if (!name.startsWith('judge.') || !value || typeof value !== 'object') return;
  const row = value as Record<string, unknown>;
  if (row.textKept === false) return;
  const text = row.applied === true && row.decision === 'fix' ? row.fixedReply
    : row.applied === true && row.decision === 'withhold' ? row.withholdText : row.reply;
  return typeof text === 'string' && text.length > 0 && text.length <= 4000 ? text : undefined;
}

export async function* readStoredActivationEvents(
  db: Kysely<any>, logs: ActivationLogs, actorId: string, from: Date, to: Date, sampleId?: string,
): AsyncGenerator<StoredActivationEvent> {
  if (!sampleId || sampleId.startsWith('observation:')) {
    const rows = db.selectFrom('activation_observations').selectAll().where('created_at', '>=', from).where('created_at', '<', to);
    const query = sampleId ? rows.where('id', '=', sampleId.slice('observation:'.length)).where('owner_id', '=', actorId) : rows;
    for (const row of await query.execute()) {
      const owned = row.owner_id === actorId;
      yield { id: `observation:${row.id}`, capabilityId: row.capability_id, occurredAt: new Date(row.created_at), owned,
        changed: row.changed, category: row.category, latencyMs: row.latency_ms, error: row.error,
        baseline: owned ? row.baseline : null, shadow: owned ? row.shadow : null, ownerConversationId: null, replyId: null };
    }
  }
  if (!sampleId || sampleId.startsWith('event:')) {
    const rows = db.selectFrom('chat_events as e').innerJoin('chat_conversations as c', 'c.id', 'e.conversation_id')
      .select(['e.id', 'e.kind', 'e.data', 'e.created_at', 'e.conversation_id', 'c.owner_id'])
      .where('e.kind', 'in', activationEventNames).where('e.created_at', '>=', from).where('e.created_at', '<', to);
    const query = sampleId ? rows.where('e.id', '=', sampleId.slice(6)).where('c.owner_id', '=', actorId) : rows;
    for (const row of await query.execute()) {
      const event = readActivationEvent(row.kind, row.data);
      if (!event) continue;
      const own = row.owner_id === actorId;
      yield { ...event, id: `event:${row.id}`, occurredAt: new Date(row.created_at), owned: own, ownerConversationId: own ? row.conversation_id : null,
        replyId: own && typeof row.data?.replyId === 'string' ? row.data.replyId : null };
    }
  }

  if (!sampleId || sampleId.startsWith('run:')) {
    const rows = db.selectFrom('chat_runs as r').innerJoin('chat_conversations as c', 'c.id', 'r.conversation_id')
      .select(['r.id', sql<unknown>`r.state -> 'agentRun'`.as('ledger'), 'r.updated_at', 'r.conversation_id', 'c.owner_id'])
      .where(sql<boolean>`r.state -> 'agentRun' ?| array['deliberation', 'earlierDeliberation']`)
      .where('r.updated_at', '>=', from).where('r.updated_at', '<', to);
    const query = sampleId ? rows.where('r.id', '=', sampleId.split(':')[1]).where('c.owner_id', '=', actorId) : rows;
    for (const row of await query.execute()) {
      const seen = new Set<string>();
      for (const entry of readDeliberationLedger({ agentRun: row.ledger })) {
        // History entries shift as the run resumes. Their review identity follows the decision, not the slot.
        const { review: _review, ...decision } = entry.data as Record<string, unknown>;
        const digest = createHash('sha256').update(JSON.stringify(decision)).digest('hex');
        const id = `run:${row.id}:${digest}`;
        if (seen.has(id) || (sampleId && sampleId !== id)) continue;
        seen.add(id);
        const occurredAt = new Date(row.updated_at);
        const event = readActivationEvent('run.deliberation', entry.data);
        if (!event) continue;
        const owned = row.owner_id === actorId;
        yield { ...event, id, occurredAt, owned, ownerConversationId: owned ? row.conversation_id : null, replyId: null };
      }
    }
  }

  if (!sampleId || sampleId.startsWith('log:')) {
    const ownedRows = await db.selectFrom('chat_conversations').select('id').where('owner_id', '=', actorId).execute();
    const owned = new Set(ownedRows.map(row => row.id));
    for await (const row of readActivationLogEvents(logs, from, to)) {
      if (sampleId && sampleId !== row.id) continue;
      const event = readActivationEvent(row.name, row.data);
      if (!event) continue;
      const own = owned.has(row.conversationId);
      yield { ...event, id: row.id, occurredAt: row.observedAt, owned: own, ownerConversationId: own ? row.conversationId : null,
        replyId: own ? row.replyId : null, judgeReplyCandidate: own ? judgeReplyCandidate(row.name, row.data) : undefined };
    }
  }
}
