import type { Kysely } from 'kysely';
import type { BrainState } from '../../assistant/brain.js';
import { decideResponsePolicy } from '../../assistant/response-policy.js';
import { chatResponsePolicyInput } from '../../assistant/response-policy-runtime.js';
import { conversationReminderContext } from '../../reminders/chat-context.js';
import { monitorContextEnabled, monitorContextShadowEnabled } from '../flag.js';
import type { createMonitorStore } from '../store.js';
import type { detectMonitorAnswerOffer } from '../v2-chat-intents.js';
import { buildMonitorContextFrame, MONITOR_CONTEXT_HISTORY_LIMIT } from './frame.js';
import { reasonMonitorContext } from './reasoner.js';
import { monitorDecisionFeatures, monitorProposalDecisionSnapshot } from './features.js';
import { readPriorMonitorDecisions } from './records.js';
import { monitorDecisionShadowEnabled, reviewMonitorDecision } from './shadow.js';

// The legacy monitor history query also reads 13 rows, including the current turn.
const HISTORY_WITH_CURRENT = MONITOR_CONTEXT_HISTORY_LIMIT + 1;

export interface MonitorContextTurn {
  ownerId: string;
  conversationId: string;
  runId: string;
  text: string;
  state?: BrainState;
}

export type VerifiedAnswerOffer = NonNullable<ReturnType<typeof detectMonitorAnswerOffer>>;
interface ContextAssessment {
  frame: ReturnType<typeof buildMonitorContextFrame>;
  guardTexts: readonly string[];
  reason: ReturnType<typeof reasonMonitorContext>;
  action: ReturnType<typeof reasonMonitorContext>['decision'];
}

export function createMonitorDecisionContext(db: Kysely<any>, store: ReturnType<typeof createMonitorStore>, initialize: () => Promise<void>) {
  const active = monitorContextEnabled();
  const shadow = monitorContextShadowEnabled() && monitorDecisionShadowEnabled();
  const assessed = new WeakMap<BrainState, { runId: string; promise: Promise<ContextAssessment> }>();

  async function readFrame(turn: MonitorContextTurn, connection: Kysely<any>, verified?: VerifiedAnswerOffer, answer?: string) {
    const { ownerId, conversationId, text, state } = turn;
    const policy = state ? chatResponsePolicyInput(text, state) : { text };
    const includeHistory = decideResponsePolicy(policy).includeEarlierTurns;
    const history = includeHistory ? await connection.selectFrom('chat_messages as m')
      .innerJoin('chat_conversations as c', 'c.id', 'm.conversation_id')
      .select(['m.id', 'm.role', 'm.text']).where('c.id', '=', conversationId).where('c.owner_id', '=', ownerId)
      .orderBy('m.created_at', 'desc').orderBy('m.id', 'desc').limit(HISTORY_WITH_CURRENT).execute() : [];
    const current = history.findIndex(message => message.role === 'user'
      && (message.text === text || message.text === state?.requestResolution?.original));
    if (current >= 0) history.splice(current, 1);
    history.reverse();
    const monitors = includeHistory ? await store.list(ownerId, conversationId, connection) : [];
    const reminders = includeHistory ? await conversationReminderContext(db, connection, ownerId, conversationId, HISTORY_WITH_CURRENT - 1) : [];
    const priorDecisions = includeHistory ? await readPriorMonitorDecisions(connection, ownerId, conversationId) : [];
    return {
      frame: buildMonitorContextFrame({ text, history, policy, monitors, reminders, priorDecisions, answerOffer: verified, assistantAnswer: answer }),
      guardTexts: [text, ...history.map(message => message.text), ...(answer ? [answer] : [])],
    };
  }

  async function review(turn: MonitorContextTurn, input: Awaited<ReturnType<typeof readFrame>>, allowInfluence: boolean) {
    const { frame } = input;
    const reason = reasonMonitorContext(frame);
    const action = shadow ? await reviewMonitorDecision({ runId: turn.runId,
      baseline: { label: reason.decision, score: reason.score }, features: monitorDecisionFeatures(frame), protected: !allowInfluence }) : reason.decision;
    return { ...input, reason, action };
  }

  async function assessTurn(turn: MonitorContextTurn) {
    await initialize();
    return review(turn, await readFrame(turn, db), active);
  }

  return {
    active,
    observing: active || shadow,
    async assess(turn: MonitorContextTurn) {
      if (!active && !shadow) return undefined;
      if (!turn.state) return assessTurn(turn);
      const cached = assessed.get(turn.state);
      if (cached?.runId === turn.runId) return cached.promise;
      const promise = assessTurn(turn);
      assessed.set(turn.state, { runId: turn.runId, promise });
      return promise;
    },
    async answer(turn: MonitorContextTurn, connection: Kysely<any>, verified: VerifiedAnswerOffer, answer: string) {
      return review(turn, await readFrame(turn, connection, verified, answer), active);
    },
    async snapshot(turn: MonitorContextTurn, connection: Kysely<any>, decision: 'propose' | 'offer',
        assessment?: ContextAssessment, verified?: VerifiedAnswerOffer, answer?: string) {
      const input = assessment ?? await readFrame(turn, connection, verified, answer);
      const reason = assessment?.reason ?? reasonMonitorContext(input.frame);
      return monitorProposalDecisionSnapshot(input.frame, reason, decision, input.guardTexts);
    },
  };
}
