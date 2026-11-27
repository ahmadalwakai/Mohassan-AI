import type { ModelCouncil } from '@mohassan/contracts';
import type { Kysely } from 'kysely';
import type { CommandChatConfig } from '../command-chat.js';
import type { CouncilTurn } from './model-council.js';

type AdvisoryConfig = Pick<CommandChatConfig, 'modelCouncil' | 'fullAccess' | 'accountFullAccess'>;
type AdvisoryInput = Pick<CouncilTurn, 'question' | 'baseline' | 'signal'>
  & Partial<Pick<CouncilTurn, 'previous' | 'evidence'>>
  & { ownerId: string; reply: string }
  & ({ route: 'image'; images: () => readonly Uint8Array[] } | { route: 'ads' });

/** Consult local models before specialized replies while leaving the pipeline's text and actions authoritative. */
export async function deliberateAdvisory(config: AdvisoryConfig, input: AdvisoryInput): Promise<ModelCouncil | undefined> {
  if (!config.modelCouncil || !config.fullAccess || !config.accountFullAccess || input.signal.aborted) return;
  try {
    if (!await config.fullAccess(input.ownerId) || input.signal.aborted) return;
    const result = await config.modelCouncil.deliberate({
      question: input.question,
      previous: input.previous ?? null,
      pipeline: { text: input.reply, status: input.route === 'image' ? 'completed' : 'partial' },
      evidence: input.evidence ?? [],
      history: [],
      baseline: { ...input.baseline, route: input.route },
      signal: input.signal,
      advisory: true,
      ...(input.route === 'image' && { images: input.images() }),
    });
    if (!input.signal.aborted && result.chosen === 'pipeline' && !result.changed) return result.council;
  } catch {
    // The original image or Ads reply can be published if deliberation fails.
  }
}

export async function fenceAdvisoryRecord(config: AdvisoryConfig, tx: Kysely<any>, ownerId: string | undefined,
    record: ModelCouncil | undefined): Promise<ModelCouncil | undefined> {
  if (record && ownerId && await config.accountFullAccess?.(ownerId, tx)) return record;
}
