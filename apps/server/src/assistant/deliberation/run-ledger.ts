import { MAX_EARLIER_THOUGHT_RECORDS, ThoughtRecordSchema, type ThoughtRecord } from '@mohassan/contracts';
import { z } from 'zod';
import type { RunLedger } from '../agent-run.js';
import { handlerRoutes } from './cascade-handlers.js';

// A malformed optional trace must not discard the execution and permission ledger.
// Trace records themselves are validated before writing and before projection.
export const thoughtLedgerFields = {
  deliberation: z.unknown().optional(),
  earlierDeliberation: z.array(z.unknown()).max(MAX_EARLIER_THOUGHT_RECORDS).optional(),
  deliberationTurnId: z.uuid().optional(),
};

const suggestionHandlers = new Set(['routing_suggestion', 'router_suggestion']);

function parseThoughtRecord(input: unknown): ThoughtRecord | undefined {
  const parsed = ThoughtRecordSchema.safeParse(input);
  if (!parsed.success) return undefined;
  const { candidates, chosen, legacy } = parsed.data;
  const handlers = candidates.map(candidate => candidate.handler);
  if (chosen.action === 'act' && chosen.handler) handlers.push(chosen.handler);
  if (legacy?.action === 'act' && legacy.handler) handlers.push(legacy.handler);
  // Slug syntax by itself would still permit a password or other untrusted value.
  if (handlers.some(handler => !Object.hasOwn(handlerRoutes, handler) && !suggestionHandlers.has(handler))) return undefined;
  return parsed.data;
}

/** Writes closed codes and offsets to the existing JSON run ledger. */
export function recordDeliberation(ledger: RunLedger, input: unknown, at: number, options: { newTurn?: boolean; turnId?: string } = {}): boolean {
  const record = parseThoughtRecord(input);
  if (!record) return false;
  const turnId = z.uuid().safeParse(options.turnId);
  const newTurn = options.newTurn || (turnId.success && turnId.data !== ledger.deliberationTurnId);
  if (newTurn && ledger.deliberation) {
    const last = parseThoughtRecord(ledger.deliberation);
    if (last) ledger.earlierDeliberation = [...(ledger.earlierDeliberation ?? []), last].slice(-MAX_EARLIER_THOUGHT_RECORDS);
  }
  if (turnId.success) ledger.deliberationTurnId = turnId.data;
  ledger.deliberation = record;
  ledger.sequence = Math.min(1_000_000, ledger.sequence + 1);
  ledger.updatedAt = new Date(at).toISOString();
  return true;
}

export function projectRunDeliberation(ledger: RunLedger | null, owner: boolean): {
  deliberation?: ThoughtRecord; earlierDeliberation?: ThoughtRecord[];
} {
  if (!owner || !ledger) return {};
  const deliberation = parseThoughtRecord(ledger.deliberation);
  const earlierDeliberation = (ledger.earlierDeliberation ?? []).flatMap(value => {
    const record = parseThoughtRecord(value);
    return record ? [record] : [];
  });
  return { ...(deliberation ? { deliberation } : {}), ...(earlierDeliberation.length ? { earlierDeliberation } : {}) };
}

/** A replayed chat request can hold a response from before the current account lost owner access. */
export async function protectCachedDeliberation<T>(response: T, fullAccess: ((ownerId: string) => Promise<boolean>) | undefined, ownerId: string): Promise<T> {
  if (!fullAccess || !response || typeof response !== 'object' || !('run' in response)) return response;
  const run = response.run;
  if (!run || typeof run !== 'object' || !('deliberation' in run || 'earlierDeliberation' in run) || await fullAccess(ownerId)) return response;
  const { deliberation: _trace, earlierDeliberation: _prior, ...publicRun } = run as Record<string, unknown>;
  return { ...response, run: publicRun };
}
