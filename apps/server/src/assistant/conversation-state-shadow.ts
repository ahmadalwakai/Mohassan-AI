import { appendFile, mkdir, open } from 'node:fs/promises';
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
 * v2 state lives in memory per conversation. A conversation the process forgot (a server restart, an evicted entry, or a
 * second lab process on the same log) is rebuilt from the user turns this log already holds, user text only, never replies
 * or page text: the same boundary as bootstrapRequestContext. `seed` does the same from turns the host passes in.
 * In the live shadow log of 2026-11-22, two of seven conversations lost their thread this way before the rebuild existed.
 *
 * `observeLater` runs the same work after the caller's request has gone on (setImmediate), in call order, so the shadow
 * adds nothing to the request; the live log measured 36 ms median per turn on a machine at full load.
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
  against?: string;
  v1: { kind: string; intent: string; scope: string; query: string | null };
  /** How many earlier user turns were replayed from this log to rebuild a conversation the process had forgotten. */
  seeded?: number;
  ms: number;
}
export interface ConversationShadow {
  readonly logFile: string;
  /** Understands one user turn in shadow and logs it. Returns null when understanding itself failed. */
  observe(input: ConversationShadowInput): TurnUnderstanding | null;
  /** The same as observe, after the caller's request has gone on, in call order; returns at once and never throws. */
  observeLater(input: ConversationShadowInput): void;
  /** Rebuilds a forgotten conversation from its stored user turns, oldest first. */
  seed(conversationId: string, turns: readonly { id: string; text: string }[]): void;
  state(conversationId: string): ConversationStateV2 | undefined;
  /** Resolves once the earlier turns already in the log are indexed. */
  ready(): Promise<void>;
  /** Resolves once every deferred turn has run and every line queued so far is on disk (for tests and shutdown). */
  flush(): Promise<void>;
}

const MAX_TEXT = 2000;
const SEED_TURNS = 8;
/** Only the tail of a long log is read back; older conversations simply start empty. */
const LOG_TAIL_BYTES = 2 * 1024 * 1024;

type Turn = { id: string; text: string };

export function createConversationShadow(options: { logFile: string; maxConversations?: number; now?: () => Date; replayLog?: boolean }): ConversationShadow {
  const states = new Map<string, ConversationStateV2>();
  const limit = Math.max(1, options.maxConversations ?? 500);
  const now = options.now ?? (() => new Date());
  let queue: Promise<void> = Promise.resolve();
  let later: Promise<void> = Promise.resolve();
  let directoryReady = false;
  /** The last user turns of each conversation, from the log and from this process: what a forgotten conversation is rebuilt from. */
  const earlier = new Map<string, Turn[]>();

  const remember = (conversationId: string, state: ConversationStateV2) => {
    states.delete(conversationId);
    states.set(conversationId, state);
    while (states.size > limit) states.delete(states.keys().next().value!);
  };
  const keep = (conversationId: string, turns: readonly Turn[]) => {
    earlier.delete(conversationId);
    earlier.set(conversationId, turns.slice(-SEED_TURNS));
    while (earlier.size > limit * 4) earlier.delete(earlier.keys().next().value!);
  };
  const write = (line: ConversationShadowLine) => {
    queue = queue.then(async () => {
      if (!directoryReady) { await mkdir(dirname(options.logFile), { recursive: true }); directoryReady = true; }
      await appendFile(options.logFile, `${JSON.stringify(line)}\n`, 'utf8');
    }).catch(() => { /* a shadow log must never reach the chat */ });
  };
  const rebuild = (turns: readonly Turn[]) => {
    let state = emptyConversationState();
    for (const turn of turns.slice(-SEED_TURNS)) state = understandTurn(state, turn.text, turn.id).next;
    return state;
  };

  const indexed: Promise<void> = options.replayLog === false ? Promise.resolve() : (async () => {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(options.logFile, 'r');
      const { size } = await handle.stat();
      const start = Math.max(0, size - LOG_TAIL_BYTES);
      const buffer = Buffer.alloc(size - start);
      await handle.read(buffer, 0, buffer.length, start);
      const lines = buffer.toString('utf8').split('\n');
      if (start > 0) lines.shift(); // the first line of a tail may be cut
      const found = new Map<string, Turn[]>();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line) as Partial<ConversationShadowLine>;
          if (typeof row.conversationId !== 'string' || typeof row.turnId !== 'string' || typeof row.text !== 'string') continue;
          const turns = found.get(row.conversationId) ?? [];
          turns.push({ id: row.turnId, text: row.text });
          found.set(row.conversationId, turns.slice(-SEED_TURNS));
        } catch { /* a torn line */ }
      }
      // Turns this process kept while the log was being read come after the logged ones; a line read back twice is kept once.
      for (const [conversationId, old] of found) {
        const current = earlier.get(conversationId) ?? [];
        const ids = new Set(current.map(turn => turn.id));
        keep(conversationId, [...old.filter(turn => !ids.has(turn.id)), ...current]);
      }
    } catch { /* no log yet */ } finally {
      await handle?.close().catch(() => undefined);
    }
  })();

  const observe = (input: ConversationShadowInput): TurnUnderstanding | null => {
    try {
      let state = states.get(input.conversationId);
      let seeded = 0;
      if (!state) {
        const turns = earlier.get(input.conversationId) ?? [];
        state = turns.length ? rebuild(turns) : emptyConversationState();
        seeded = Math.min(turns.length, SEED_TURNS);
      }
      if (input.shown?.length) state = withHostResults(state, input.shown, `${input.turnId}-shown`);
      state = withPending(state, input.pending ?? null);
      const started = performance.now();
      const understanding = understandTurn(state, input.text, input.turnId);
      const ms = Number((performance.now() - started).toFixed(3));
      const text = input.text.slice(0, MAX_TEXT);
      remember(input.conversationId, withPending(understanding.next, null));
      keep(input.conversationId, [...(earlier.get(input.conversationId) ?? []), { id: input.turnId, text }]);
      write({
        at: now().toISOString(), conversationId: input.conversationId, turnId: input.turnId, text,
        type: understanding.type, entity: understanding.entity, property: understanding.property, place: understanding.place, time: understanding.time,
        query: understanding.query, needs: understanding.needs, assumption: understanding.assumption,
        ...(understanding.edit ? { edit: understanding.edit } : {}), ...(understanding.reference ? { reference: understanding.reference } : {}),
        ...(understanding.against ? { against: understanding.against } : {}),
        v1: { kind: understanding.v1.kind, intent: understanding.v1.intent, scope: understanding.v1.scope, query: understanding.v1.query },
        ...(seeded ? { seeded } : {}), ms,
      });
      return understanding;
    } catch {
      return null;
    }
  };

  return {
    logFile: options.logFile,
    observe,
    observeLater(input) {
      try {
        // A copy taken now: the caller may change its own objects after the request goes on.
        const copy: ConversationShadowInput = {
          conversationId: input.conversationId, turnId: input.turnId, text: input.text,
          ...(input.pending !== undefined ? { pending: input.pending ? { ...input.pending, ...(input.pending.fields ? { fields: [...input.pending.fields] } : {}) } : null } : {}),
          ...(input.shown ? { shown: input.shown.map(item => ({ label: item.label, kind: item.kind })) } : {}),
        };
        later = later.then(() => indexed).then(() => new Promise<void>(resolve => setImmediate(() => { observe(copy); resolve(); })))
          .catch(() => { /* never reaches the chat */ });
      } catch { /* never reaches the chat */ }
    },
    seed(conversationId, turns) {
      try {
        remember(conversationId, rebuild(turns));
        keep(conversationId, turns.map(turn => ({ id: turn.id, text: turn.text.slice(0, MAX_TEXT) })));
      } catch { /* a forgotten conversation simply starts empty */ }
    },
    state: conversationId => states.get(conversationId),
    ready: () => indexed,
    flush: () => later.then(() => queue),
  };
}
