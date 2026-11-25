import type { MonitorCard, ReminderSummary } from '@mohassan/contracts';
import type { ConversationStateV2 } from '../../assistant/conversation-state.js';
import { replayConversationTranscript } from '../../assistant/conversation-state-chat.js';
import { decideResponsePolicy, type ResponsePolicyInput } from '../../assistant/response-policy.js';
import { externalHistory, interactiveOnly } from '../../assistant/response-policy-signals.js';
import { detectMonitorNeed, safeMonitorRequest, type MonitorNeed } from '../detection.js';
import type { detectGithubAnswerOffer } from '../sources/github-intent.js';
import { detectGithubMonitorNeed } from '../sources/github-intent.js';
import { parseMonitorManagement, type detectMonitorAnswerOffer, type MonitorManagement } from '../v2-chat-intents.js';
import { monitorOfferTopic } from './offer-topic.js';
import {
  isMonitorAcknowledgement, isMonitorOfferQuestion, MAX_MONITOR_TURN_CHARS, monitorContextTurn, monitorOfferReply,
  noticeTrigger, type MonitorContextTurn, type PendingStatus, type StatusTopic,
} from './signals.js';

// The existing monitor history read takes 13 rows including the current user turn.
export const MONITOR_CONTEXT_HISTORY_LIMIT = 12;

export interface MonitorPriorDecision {
  decision: 'accepted' | 'declined';
  sourceUrl?: string;
  topic?: string;
}

type ExistingMonitor = Pick<MonitorCard, 'spec' | 'status' | 'offer'>;
type ExistingReminder = Pick<ReminderSummary, 'status' | 'recurrence'>;
type AnswerOffer = ReturnType<typeof detectMonitorAnswerOffer> | ReturnType<typeof detectGithubAnswerOffer>;

export interface MonitorContextFrameInput {
  text: string;
  history?: readonly { id?: string; role: string; text: string }[];
  state?: ConversationStateV2;
  policy?: Partial<Omit<ResponsePolicyInput, 'text'>>;
  monitors?: readonly ExistingMonitor[];
  reminders?: readonly ExistingReminder[];
  priorDecisions?: readonly MonitorPriorDecision[];
  assistantAnswer?: string;
  answerOffer?: AnswerOffer;
  legacyNeed?: MonitorNeed | null;
  github?: boolean;
  management?: MonitorManagement | null;
  now?: Date;
}

interface PendingEvidence {
  topic: PendingStatus;
  turn: MonitorContextTurn;
}

function sameSource(first: string, second: string): boolean {
  return monitorOfferTopic(first) === monitorOfferTopic(second);
}

function compatibleTopic(topic: StatusTopic | null, other: StatusTopic | null): boolean {
  return !topic || !other || topic === 'page' || other === 'page' || topic === other;
}

function turnIsSameSubject(turn: MonitorContextTurn, current: MonitorContextTurn): boolean {
  if (!compatibleTopic(turn.topic, current.topic) || turn.links.length > 1 || current.links.length > 1) return false;
  return !turn.links.length || !current.links.length || sameSource(turn.links[0], current.links[0]);
}

function recentPending(history: readonly MonitorContextTurn[], current: MonitorContextTurn): PendingEvidence | null {
  for (const turn of [...history].reverse()) {
    if (!turnIsSameSubject(turn, current) || turn.resolved) return null;
    if (turn.pending) {
      return turn.role === 'assistant' || safeMonitorRequest(turn.text) ? { topic: turn.pending, turn } : null;
    }
    // An unrelated user turn breaks continuity. Brief replies and topic-related
    // status questions leave the conversation on the previous observation.
    if (turn.role === 'user' && !isMonitorAcknowledgement(turn) && !monitorOfferReply(turn)
      && !turn.statusQuestion && !turn.waiting && (!turn.topic || turn.topic !== current.topic)) return null;
  }
  return null;
}

function sourceFor(current: MonitorContextTurn, history: readonly MonitorContextTurn[], pending: PendingEvidence | null) {
  if (current.links.length > 1) return undefined;
  if (current.links.length === 1) return current.links[0];
  const topic = pending?.topic ?? current.topic;
  // Only a user turn can contribute a source for a new context-derived spec.
  // The current-answer path gets a separate host-verified page observation.
  const candidates = new Set<string>();
  for (const turn of [...history].reverse()) {
    if (turn.role !== 'user') continue;
    if (!turnIsSameSubject(turn, current) || topic && !compatibleTopic(topic, turn.topic)) break;
    if (turn.links.length === 1 && safeMonitorRequest(turn.text)) candidates.add(turn.links[0]);
    if (!turn.topic && !turn.statusQuestion && !turn.waiting && !isMonitorAcknowledgement(turn) && !monitorOfferReply(turn)) break;
  }
  const [source] = candidates;
  if (!source || [...candidates].some(url => !sameSource(url, source))) return undefined;
  return !pending?.turn.links.length || sameSource(source, pending.turn.links[0]) ? source : undefined;
}

function questionKey(turn: MonitorContextTurn) {
  let text = turn.normalized;
  for (const expression of turn.timeExpressions) text = text.replace(expression, ' ');
  return text.replace(/\b(?:already|still|yet|right now|now|currently|again)\b|(?<!\p{L})(?:بعد|لسه|حاليا|الان|مره اخري)(?!\p{L})/gu, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+(?:at|on|in|في|علي)$/u, '');
}

function repeatedQuestions(history: readonly MonitorContextTurn[], current: MonitorContextTurn, pending: PendingEvidence | null): number {
  if (!current.statusQuestion) return 0;
  const currentKey = questionKey(current);
  let count = 0;
  for (const turn of [...history].reverse()) {
    if (!turnIsSameSubject(turn, current) || turn.resolved) break;
    if (turn.role !== 'user') continue;
    if (turn.statusQuestion && (questionKey(turn) === currentKey
      || current.continuing && !current.topic && pending?.topic === turn.topic)) count++;
    else if (!turn.pending && !turn.waiting && !isMonitorAcknowledgement(turn) && !monitorOfferReply(turn)) break;
  }
  return count;
}

function transcriptOfferDecisions(history: readonly MonitorContextTurn[]): MonitorPriorDecision[] {
  return history.flatMap((turn, index) => {
    const offer = history[index - 1];
    if (turn.role !== 'user' || offer?.role !== 'assistant' || !isMonitorOfferQuestion(offer)) return [];
    const decision = monitorOfferReply(turn);
    if (!decision) return [];
    const prior = history.slice(0, index - 1);
    const pending = recentPending(prior, offer);
    const sourceUrl = sourceFor(offer, prior, pending);
    const topic = pending?.topic ?? offer.topic ?? prior.at(-1)?.topic ?? undefined;
    return [{ decision, sourceUrl, topic }];
  });
}

export function buildMonitorContextFrame(input: MonitorContextFrameInput) {
  const history = (input.history ?? []).slice(-MONITOR_CONTEXT_HISTORY_LIMIT).flatMap((turn, index): Pick<MonitorContextTurn, 'id' | 'role' | 'text'>[] =>
    turn.role === 'user' || turn.role === 'assistant'
      ? [{ role: turn.role, text: turn.text.slice(0, MAX_MONITOR_TURN_CHARS), id: turn.id ?? `history-${index}` }] : []);
  const text = input.text.length <= MAX_MONITOR_TURN_CHARS ? input.text : '';
  const current = monitorContextTurn('user', text, 'current');
  const responsePolicy = decideResponsePolicy({ ...input.policy, text,
    previousTurns: input.policy?.previousTurns ?? history.filter(turn => turn.role === 'user').length });
  const mayUseHistory = responsePolicy.includeEarlierTurns && !externalHistory.test(current.normalized);
  const turns = mayUseHistory ? history.map(turn => monitorContextTurn(turn.role, turn.text, turn.id)) : [];
  const state = mayUseHistory ? input.state ?? replayConversationTranscript(history) : replayConversationTranscript([]);
  const assistantAnswer = input.assistantAnswer ? monitorContextTurn('assistant', input.assistantAnswer.slice(0, MAX_MONITOR_TURN_CHARS), 'answer') : null;
  const lastAssistant = turns.findLast(turn => turn.role === 'assistant') ?? null;
  const eligible = Boolean(text && !interactiveOnly.test(current.normalized) && safeMonitorRequest(text)
    && (!/https?:\/\//iu.test(text) || current.links.length));
  const pending = recentPending(turns, current);
  const sourceUrl = sourceFor(current, turns, pending);
  const notices = noticeTrigger(current, input.now ?? new Date());
  const priorDecisions = [ ...(input.priorDecisions ?? []).slice(-MONITOR_CONTEXT_HISTORY_LIMIT), ...transcriptOfferDecisions(turns) ];
  const monitors = (input.monitors ?? []).slice(0, MONITOR_CONTEXT_HISTORY_LIMIT);
  const reminders = (input.reminders ?? []).slice(0, MONITOR_CONTEXT_HISTORY_LIMIT);
  return {
    current, history: turns, previousAssistant: lastAssistant, assistantAnswer, eligible, sourceUrl,
    sources: [...new Set([...turns, current, ...(assistantAnswer ? [assistantAnswer] : [])].flatMap(turn => turn.links))],
    topic: state.topics.at(-1) ?? null, entities: state.entities, workMode: responsePolicy.workMode, language: responsePolicy.language,
    scheduledTime: state.schedule, pending, repeatedStatus: repeatedQuestions(turns, current, pending), waiting: current.waiting,
    monitors, reminders, priorDecisions, ...notices,
    legacyNeed: input.legacyNeed === undefined
      ? (input.github && detectGithubMonitorNeed(text, turns)) || detectMonitorNeed({ text, history: turns }) : input.legacyNeed,
    management: input.management === undefined ? parseMonitorManagement(text) : input.management,
    answerOffer: input.answerOffer ?? null,
  };
}

export type MonitorContextFrame = ReturnType<typeof buildMonitorContextFrame>;

// Versioned together with the learned head. These are counts and booleans
// only. Topic names, URLs, entity values and times stay in the runtime frame.
export const MONITOR_CONTEXT_FEATURES = [
  'currentTextLength', 'historyTurns', 'entityCount', 'knownTopic', 'publicTopic', 'longRunning', 'sourceCount', 'currentTimeCount', 'priorTimeCount',
  'scheduledTime', 'repeatedStatus', 'assistantPending', 'pendingStatus', 'waiting', 'statusQuestion', 'oneOff', 'timeRequest',
  'conditionNotification', 'legacyExplicit', 'legacyImplicit', 'management', 'verifiedAnswerOffer', 'monitorCount',
  'existingActiveMonitors', 'reminderCount', 'scheduledReminders', 'acceptedCount', 'declinedCount',
] as const;

export type MonitorContextFeature = (typeof MONITOR_CONTEXT_FEATURES)[number];

export function monitorContextFeatures(frame: MonitorContextFrame): Record<MonitorContextFeature, number> {
  return {
    currentTextLength: Math.min(800, frame.current.text.length), historyTurns: frame.history.length,
    entityCount: frame.entities.length, knownTopic: Number(Boolean(frame.topic)),
    publicTopic: Number(Boolean(frame.topic?.lookup)), longRunning: Number(frame.workMode === 'long_running'),
    sourceCount: frame.sources.length, currentTimeCount: frame.current.timeExpressions.length,
    priorTimeCount: frame.history.reduce((sum, turn) => sum + turn.timeExpressions.length, 0),
    scheduledTime: Number(Boolean(frame.scheduledTime)), repeatedStatus: frame.repeatedStatus,
    assistantPending: Number(Boolean(frame.previousAssistant?.pending)), pendingStatus: Number(Boolean(frame.pending)),
    waiting: Number(frame.waiting), statusQuestion: Number(frame.current.statusQuestion), oneOff: Number(frame.current.oneOff),
    timeRequest: Number(frame.timeRequest), conditionNotification: Number(frame.conditionNotification),
    legacyExplicit: Number(frame.legacyNeed?.kind === 'explicit'), legacyImplicit: Number(frame.legacyNeed?.kind === 'implicit'),
    management: Number(Boolean(frame.management)), verifiedAnswerOffer: Number(Boolean(frame.answerOffer)),
    monitorCount: frame.monitors.length, existingActiveMonitors: frame.monitors.filter(monitor => monitor.status === 'active' || monitor.status === 'paused').length,
    reminderCount: frame.reminders.length, scheduledReminders: frame.reminders.filter(reminder => reminder.status === 'scheduled').length,
    acceptedCount: frame.priorDecisions.filter(decision => decision.decision === 'accepted').length,
    declinedCount: frame.priorDecisions.filter(decision => decision.decision === 'declined').length,
  };
}
