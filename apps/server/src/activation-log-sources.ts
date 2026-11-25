import { createHash, randomUUID } from 'node:crypto';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { open } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import type { Kysely } from 'kysely';
import { readActivationEvent } from './activation-registry.js';
import { activationScopeDatabase, activationScopeOwnerId } from './activation-runtime.js';

export interface ActivationLogFiles {
  judge?: string;
  conversation?: string;
}

export interface ActivationLogEvent {
  id: string;
  name: string;
  observedAt: Date;
  conversationId: string | null;
  runId: string | null;
  replyId: string | null;
  data: unknown;
}

function logObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function logId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 100 ? value : null;
}

async function* readLog(file: string, source: 'judge' | 'conversation', since: Date, until: Date): AsyncGenerator<ActivationLogEvent> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(file, 'r');
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
    throw error;
  }

  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size === 0) return;
    // Read a snapshot so a continuous writer cannot extend an owner request indefinitely.
    const input = handle.createReadStream({ end: stat.size - 1, autoClose: false });
    const reader = createInterface({ input, crlfDelay: Infinity });
    try {
      const seen = new Set<string>();
      for await (const line of reader) {
        if (!line || line.length > 256 * 1024) continue;
        let data: ReturnType<typeof logObject>;
        try { data = logObject(JSON.parse(line)); } catch { continue; }
        if (!data || typeof data.at !== 'string') continue;
        const timestamp = Date.parse(data.at);
        if (!Number.isFinite(timestamp) || timestamp < since.getTime() || timestamp >= until.getTime()) continue;

        const names = source === 'judge'
          ? [logObject(data.truth) ? 'judge.truth' : null, logObject(data.conversationReview) ? 'judge.conversationReview' : null]
          : [logObject(data.agreement) || (data.mode === 'active' && logObject(data.decision)) ? 'conversation.agreement' : null];
        for (const name of names) {
          if (!name) continue;
          const id = 'log:' + createHash('sha256').update(name).update('\0').update(line).digest('hex');
          if (seen.has(id)) continue;
          seen.add(id);
          yield {
            id,
            name,
            observedAt: new Date(timestamp),
            conversationId: logId(data.conversationId),
            runId: logId(source === 'judge' ? data.runId : data.turnId),
            // These producers identify the run, while a run may publish multiple replies.
            replyId: null,
            data,
          };
        }
      }
    } finally {
      reader.close();
      input.destroy();
    }
  } finally {
    await handle.close();
  }
}

export async function* readActivationLogEvents(files: ActivationLogFiles, since: Date, until: Date): AsyncGenerator<ActivationLogEvent> {
  if (files.judge) yield* readLog(files.judge, 'judge', since, until);
  if (files.conversation) yield* readLog(files.conversation, 'conversation', since, until);
}

export function readDeliberationLedger(state: unknown): { index: number; data: unknown }[] {
  const ledger = logObject(logObject(state)?.agentRun);
  if (!ledger) return [];
  const history: unknown[] = Array.isArray(ledger.earlierDeliberation) ? ledger.earlierDeliberation.slice(0, 8) : [];
  const traces = history.flatMap((data, index) => logObject(data)?.version === 1 ? [{ index, data }] : []);
  if (logObject(ledger.deliberation)?.version === 1) traces.push({ index: -1, data: ledger.deliberation });
  return traces;
}

const consoleEvents = new Set([
  'arabic_understanding_shadow_difference', 'arabic_understanding_shadow_error',
  'plan_compiler_shadow', 'answer_selection_shadow', 'conversation_review_unavailable',
  'structured_memory_shadow', 'clarification_shadow', 'extractive_writing_shadow', 'browser_hands_wait_failed',
]);
const consoleChannels = ['console.info', 'console.warn', 'console.error'];
const maxPendingObservations = 1024;
const observationBatchSize = 128;

type ConsoleObservation = {
  id: string;
  capability_id: string;
  created_at: Date;
  changed: boolean | null;
  category: string | null;
  latency_ms: number | null;
  error: boolean;
  owner_id: string | null;
  baseline: string | null;
  shadow: string | null;
};

/** Node 24 publishes console argument arrays. The original output and caller remain untouched. */
export function subscribeActivationConsoleLogs(db: Kysely<any>, now: () => Date): () => Promise<void> {
  const queue: ConsoleObservation[] = [];
  let pending: Promise<void> | undefined;

  const scheduleWrite = () => {
    if (pending) return;
    pending = new Promise<void>(resolve => setImmediate(resolve)).then(async () => {
      while (queue.length) {
        const batch = queue.splice(0, observationBatchSize);
        try {
          await db.insertInto('activation_observations').values(batch).execute();
        } catch {
          // Shadow telemetry must not change the result of a chat operation.
        }
      }
    }).finally(() => {
      pending = undefined;
      if (queue.length) scheduleWrite();
    });
  };

  const observe = (args: unknown) => {
    if (activationScopeDatabase() !== db || queue.length >= maxPendingObservations
      || !Array.isArray(args) || args.length !== 1 || typeof args[0] !== 'string'
      || args[0].length > 64 * 1024 || !args[0].startsWith('{')) return;
    try {
      const data = logObject(JSON.parse(args[0]));
      if (!data || typeof data.event !== 'string' || !consoleEvents.has(data.event)) return;
      const event = readActivationEvent(data.event, data);
      if (!event) return;
      const ownerId = activationScopeOwnerId() ?? null;
      queue.push({ id: randomUUID(), capability_id: event.capabilityId, created_at: now(), changed: event.changed,
        category: event.category, latency_ms: event.latencyMs, error: event.error, owner_id: ownerId,
        baseline: ownerId ? event.baseline : null, shadow: ownerId ? event.shadow : null });
      scheduleWrite();
    } catch {
      // Failed observations never escape the diagnostics subscriber.
    }
  };

  for (const channel of consoleChannels) subscribe(channel, observe);
  return async () => {
    for (const channel of consoleChannels) unsubscribe(channel, observe);
    while (pending) await pending;
  };
}
