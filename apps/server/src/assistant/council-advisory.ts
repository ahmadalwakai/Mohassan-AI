import { performance } from 'node:perf_hooks';
import type { ModelCouncil } from '@mohassan/contracts';
import type { Kysely } from 'kysely';
import type { CommandChatConfig } from '../command-chat.js';
import type { CouncilTurn } from './model-council.js';

type AdvisoryConfig = Pick<CommandChatConfig, 'modelCouncil' | 'fullAccess' | 'accountFullAccess'>;
type AdvisoryInput = Pick<CouncilTurn, 'question' | 'baseline' | 'signal'>
  & Partial<Pick<CouncilTurn, 'previous' | 'evidence'>>
  & { ownerId: string; reply: string }
  & ({ route: 'image'; images: () => readonly Uint8Array[] } | { route: 'ads' });

// Cap optional work at the recorded upper end of a warm council turn.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/docs/MODEL-COUNCIL.md#measurement (retrieved 2026-11-27)
export const ADVISORY_BUDGET_MS = 500;

/** Bound the wait even when advisory work never settles after cancellation. */
export async function withAdvisoryBudget<T>(signal: AbortSignal | undefined,
    work: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
  if (signal?.aborted) return;
  const deadline = performance.now() + ADVISORY_BUDGET_MS;
  const clock = new AbortController();
  const active = signal ? AbortSignal.any([signal, clock.signal]) : clock.signal;
  let onAbort!: () => void;
  const expired = new Promise<undefined>(resolve => {
    onAbort = () => resolve(undefined);
    active.addEventListener('abort', onAbort, { once: true });
  });
  const timer = setTimeout(() => clock.abort(), ADVISORY_BUDGET_MS);
  try {
    const result = await Promise.race([work(active), expired]);
    if (!active.aborted && performance.now() < deadline) return result;
  } catch {
    // Advice is optional when work fails.
  } finally {
    clearTimeout(timer);
    active.removeEventListener('abort', onAbort);
  }
}

/** Consult local models before specialized replies while leaving the pipeline's text and actions authoritative. */
export async function deliberateAdvisory(config: AdvisoryConfig, input: AdvisoryInput): Promise<ModelCouncil | undefined> {
  const { modelCouncil, fullAccess, accountFullAccess } = config;
  if (!modelCouncil || !fullAccess || !accountFullAccess) return;
  return withAdvisoryBudget(input.signal, async signal => {
    if (!await fullAccess(input.ownerId) || signal.aborted) return;
    const result = await modelCouncil.deliberate({
      question: input.question,
      previous: input.previous ?? null,
      pipeline: { text: input.reply, status: input.route === 'image' ? 'completed' : 'partial' },
      evidence: input.evidence ?? [],
      history: [],
      baseline: { ...input.baseline, route: input.route },
      signal,
      advisory: true,
      ...(input.route === 'image' && { images: input.images() }),
    });
    if (result.chosen === 'pipeline' && !result.changed) return result.council;
  });
}

export async function fenceAdvisoryRecord(config: AdvisoryConfig, tx: Kysely<any>, ownerId: string | undefined,
    record: ModelCouncil | undefined): Promise<ModelCouncil | undefined> {
  if (record && ownerId && await config.accountFullAccess?.(ownerId, tx)) return record;
}
