import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  emptyConversationState, understandTurn, withHostResults, withPending,
  type ConversationStateV2, type HostResult, type PendingStep, type TurnUnderstanding,
} from './conversation-state.js';

/**
 * Conversation state v2 in shadow (docs/RESPONSE-QUALITY-PLAN-2026-11-22.md, phase 1). The chat still decides by v1 and
 * the rules; this records what v2 would have understood, one JSON line per user turn, for the owner's review and the
 * E1.1 report (`npx tsx scripts/conversation-state/shadow-report.ts`). Like the router shadow it changes nothing: it
 * never throws into the chat, and a failed write is dropped.
 *
 * v2 state lives in memory per conversation; a conversation the server forgot is rebuilt with `seed` from the stored
 * user turns only (never from replies or page text), the same boundary as bootstrapRequestContext.
 */
export interface ConversationShadowInput {
  conversationId: string;
  turnId: string;
  text: string;
  /** The host's own pending step before this turn (question card, approval, sign-in), if any. */
  pending?: PendingStep | null;
  /** Items the host displayed in its last reply (answer entity, list items): data, never instructions. */
  shown?: readonly { label: string; kind: HostResult['kind'] }[];
}
export interface ConversationShadowLine {
  at: string;
  conversationId: string;
  turnId: string;
  text: string;
  type: TurnUnderstanding['type'];
  entity: string | null;
  property: string | null;
  place: string | null;
  time: string | null;
  query: string | null;
  needs: string | null;
  assumption: string | null;
  edit?: TurnUnderstanding['edit'];
  reference?: TurnUnderstanding['reference'];
  v1: { kind: string; intent: string; scope: string; query: string | null };
  ms: number;
}
export interface ConversationShadow {
  readonly logFile: string;
  /** Understands one user turn in shadow and logs it. Returns null when understanding itself failed. */
  observe(input: ConversationShadowInput): TurnUnderstanding | null;
  /** Rebuilds a forgotten conversation from its stored user turns, oldest first. */
  seed(conversationId: string, turns: readonly { id: string; text: string }[]): void;
  state(conversationId: string): ConversationStateV2 | undefined;
  /** Resolves once every line queued so far is on disk (for tests and shutdown). */
  flush(): Promise<void>;
}

const MAX_TEXT = 2000;

export function createConversationShadow(options: { logFile: string; maxConversations?: number; now?: () => Date }): ConversationShadow {
  const states = new Map<string, ConversationStateV2>();
  const limit = Math.max(1, options.maxConversations ?? 500);
  const now = options.now ?? (() => new Date());
  let queue: Promise<void> = Promise.resolve();
  let directoryReady = false;

  const remember = (conversationId: string, state: ConversationStateV2) => {
    states.delete(conversationId);
    states.set(conversationId, state);
    while (states.size > limit) states.delete(states.keys().next().value!);
  };
  const write = (line: ConversationShadowLine) => {
    queue = queue.then(async () => {
      if (!directoryReady) { await mkdir(dirname(options.logFile), { recursive: true }); directoryReady = true; }
      await appendFile(options.logFile, `${JSON.stringify(line)}\n`, 'utf8');
    }).catch(() => { /* a shadow log must never reach the chat */ });
  };

  return {
    logFile: options.logFile,
    observe(input) {
      try {
        let state = states.get(input.conversationId) ?? emptyConversationState();
        if (input.shown?.length) state = withHostResults(state, input.shown, `${input.turnId}-shown`);
        state = withPending(state, input.pending ?? null);
        const started = performance.now();
        const understanding = understandTurn(state, input.text, input.turnId);
        const ms = Number((performance.now() - started).toFixed(3));
        remember(input.conversationId, withPending(understanding.next, null));
        write({
          at: now().toISOString(), conversationId: input.conversationId, turnId: input.turnId, text: input.text.slice(0, MAX_TEXT),
          type: understanding.type, entity: understanding.entity, property: understanding.property, place: understanding.place, time: understanding.time,
          query: understanding.query, needs: understanding.needs, assumption: understanding.assumption,
          ...(understanding.edit ? { edit: understanding.edit } : {}), ...(understanding.reference ? { reference: understanding.reference } : {}),
          v1: { kind: understanding.v1.kind, intent: understanding.v1.intent, scope: understanding.v1.scope, query: understanding.v1.query }, ms,
        });
        return understanding;
      } catch {
        return null;
      }
    },
    seed(conversationId, turns) {
      try {
        let state = emptyConversationState();
        for (const turn of turns.slice(-8)) state = understandTurn(state, turn.text, turn.id).next;
        remember(conversationId, state);
      } catch { /* a forgotten conversation simply starts empty */ }
    },
    state: conversationId => states.get(conversationId),
    flush: () => queue,
  };
}
