import type { ModelCouncil } from '@mohassan/contracts';
import type { TurnObservation } from '../../../../packages/model-relations/src/manager.js';
import type { ModelRunResult } from '../../../../packages/model-relations/src/runtime.js';
import { deliberateCouncilTurn } from './council-turn.js';
import type { CouncilScheduleOptions } from './council-scheduler.js';
import type { councilWeight } from './council-receipts.js';
import type { JudgeEvidence } from './judge.js';

export { rankHits, readerPrompt, selectPassage } from './council-passage.js';

export type CouncilStatus = 'completed' | 'partial' | 'blocked';
export type CouncilHistory = readonly { role: 'user' | 'assistant'; content: string }[];

export interface CouncilRunner {
  run(modelId: string, input: unknown, signal?: AbortSignal): Promise<ModelRunResult>;
}

export interface CouncilTurn {
  question: string;
  previous: string | null;
  pipeline: { text: string; status: CouncilStatus };
  /** Pages read for this turn (judge evidence); empty when the turn read nothing. */
  evidence: readonly JudgeEvidence[];
  /** The conversation for v5, oldest first, ending with the user's turn. */
  history: CouncilHistory;
  /** The rules' own reading of the request, as the shadow organizer observes it. */
  baseline: TurnObservation['baseline'];
  /** Attachments already authorized and integrity-checked by the image turn. */
  images?: readonly Uint8Array[];
  /** The owner's existing typed executor task, when applicable. */
  codeTask?: { capability: string; fields: Record<string, unknown> };
  /** Record advice on a specialized turn without changing its pipeline result. */
  advisory?: boolean;
  /** This turn's public web search (the chat's engine, page reader and public-query guard); overrides `options.search`. */
  search?: (question: string, signal: AbortSignal) => Promise<CouncilSearchResult>;
  signal: AbortSignal;
}

export interface CouncilOutcome {
  text: string;
  status: CouncilStatus;
  chosen: string;
  changed: boolean;
  council: ModelCouncil;
}

export interface CouncilSearchResult {
  pages: readonly JudgeEvidence[];
  /** Why nothing was read (no results, a refused query, unreadable pages), shown to the owner. */
  note?: string;
}

export interface ModelCouncilOptions {
  runner: CouncilRunner;
  registry?: CouncilScheduleOptions['registry'];
  resolve?: CouncilScheduleOptions['resolve'];
  weight?: typeof councilWeight;
  /** The resident v5 worker (v5-chat.ts); absent when v5 is not configured. */
  v5?: (history: CouncilHistory, signal: AbortSignal) => Promise<string | undefined>;
  v5Ready?: () => boolean;
  /**
   * A public web search and page read for this turn (the pipeline's own search engine and page reader, with its
   * public-query guard). Used only when the pipeline read no page, has no answer that stands, and the rules send
   * the request to the web.
   */
  search?: (question: string, signal: AbortSignal) => Promise<CouncilSearchResult>;
  /** Total wall time for one council (default 45 s). Members still running then are recorded as timed out. */
  budgetMs?: number;
  /** Per-member caps in milliseconds. */
  memberMs?: Partial<Record<'understanding' | 'search' | 'v5' | 'reader' | 'v4' | 'arithmetic', number>>;
}

export function createModelCouncil(options: ModelCouncilOptions) {
  return { deliberate: (turn: CouncilTurn) => deliberateCouncilTurn(options, turn) };
}

export type ModelCouncilService = ReturnType<typeof createModelCouncil>;
