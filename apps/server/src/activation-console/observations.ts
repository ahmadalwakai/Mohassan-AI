import type { Kysely } from 'kysely';
import type { ActivationObservation } from '@mohassan/contracts';
import type { ActivationEvent } from './events.js';
import { readActivationLogEvents } from './log-sources.js';

export const observationWindowDays = 7;
const dayMs = 86_400_000;
const storedLimit = 1024;
// These keys match the corresponding production readers and the available PR #43 projections.
const observedCapabilities: Readonly<Record<string, string>> = {
  'plan-compiler': 'MOHASSAN_PLAN_COMPILER',
  'conversation-reviewer': 'MOHASSAN_CONVERSATION_REVIEW_APPLY',
  'structured-memory': 'MOHASSAN_STRUCTURED_MEMORY',
  'clarify-choices': 'MOHASSAN_CLARIFY_CHOICES',
  'extractive-writing': 'MOHASSAN_EXTRACTIVE_WRITING',
  'conversation-state': 'MOHASSAN_CONVERSATION_SHADOW',
};

type Options = {
  db: Kysely<any>;
  actorId: string;
  judgeLogFile: string;
  conversationLogFile: string;
  consoleEvents: readonly ActivationEvent[];
  to: Date;
};

export async function readActivationObservations({ db, actorId, judgeLogFile, conversationLogFile, consoleEvents, to }: Options) {
  const from = new Date(to.getTime() - observationWindowDays * dayMs);
  const [judge, conversation, stored] = await Promise.all([
    readActivationLogEvents(judgeLogFile, 'judge', from, to),
    readActivationLogEvents(conversationLogFile, 'conversation', from, to),
    db.selectFrom('activation_observations').select(['capability_id', 'created_at', 'changed', 'error'])
      .where('owner_id', '=', actorId).where('created_at', '>=', from).where('created_at', '<', to)
      .orderBy('created_at', 'desc').limit(storedLimit).execute(),
  ]);
  const files = [...judge, ...conversation];
  const conversationIds = [...new Set(files.map(row => row.conversationId))];
  const owned = new Set(conversationIds.length ? (await db.selectFrom('chat_conversations').select('id')
    .where('id', 'in', conversationIds).where('owner_id', '=', actorId).execute()).map(row => row.id) : []);
  const observations = new Map<string, ActivationObservation>();
  const add = ({ name, at, changed, error }: ActivationEvent) => {
    if (!Number.isFinite(at.getTime())) return;
    const time = at.toISOString();
    const summary = observations.get(name) ?? { eventCount: 0, comparedCount: 0, disagreements: 0, errors: 0, lastObservedAt: time };
    summary.eventCount++;
    if (changed !== null) summary.comparedCount++;
    if (changed === true) summary.disagreements++;
    if (error) summary.errors++;
    if (time > summary.lastObservedAt) summary.lastObservedAt = time;
    observations.set(name, summary);
  };
  for (const event of consoleEvents) if (event.at >= from && event.at < to) add(event);
  for (const row of files) if (owned.has(row.conversationId)) row.events.forEach(add);
  for (const row of stored) {
    if (!Object.hasOwn(observedCapabilities, row.capability_id)) continue;
    add({ name: observedCapabilities[row.capability_id]!, at: new Date(row.created_at), changed: row.changed, error: row.error });
  }
  return observations;
}
