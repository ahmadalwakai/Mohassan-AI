import type { AnswerPath, WorkingRunPhase } from '@mohassan/contracts';
import { MAX_HISTORY, type RunLedger } from '../../assistant/agent-run.js';
import type { BrainState } from '../../assistant/brain.js';
import type { LocalSequencePart } from '../../assistant/local-sequence.js';
import type { Evidence } from '../../assistant/mind/contract.js';
import type { WebSequenceAnswer } from '../../assistant/web-sequence.js';
import { workingPhases, type ChatObservation, type MetricsStore } from './store.js';

export type ChatMetricsSink = MetricsStore['recordChat'];
export type ChatAnswerDetails = {
  localParts?: readonly Pick<LocalSequencePart, 'source'>[];
  webParts?: readonly Pick<WebSequenceAnswer, 'source' | 'withheld'>[];
  mindEvidence?: readonly Pick<Evidence, 'source'>[];
  browserRead?: boolean;
  withheld?: boolean;
};

const measuredPhases = new Set<string>(workingPhases);

/** Sum the elapsed time of every retained visit to a phase before the next ledger transition. */
export function chatPhaseDurations(history: RunLedger['history'], receivedAt: number, endedAt?: number): NonNullable<ChatObservation['phases']> {
  const phases: NonNullable<ChatObservation['phases']> = {};
  for (let index = 0; index < history.length; index++) {
    const entry = history[index]!;
    if (!measuredPhases.has(entry.phase)) continue;
    const phase = entry.phase as WorkingRunPhase;
    const start = Date.parse(entry.at);
    const next = history[index + 1];
    const elapsed = (next ? Date.parse(next.at) : endedAt ?? NaN) - start;
    // The ledger retains `received` even when dropping its immediate successor.
    if (entry.phase === 'received' && (history.length === MAX_HISTORY || start !== receivedAt)) continue;
    if (Number.isFinite(elapsed) && elapsed >= 0) phases[phase] = (phases[phase] ?? 0) + elapsed;
  }
  return phases;
}

function answerPaths(state: BrainState, browserObserved: boolean, blocked: boolean, withheld: boolean, details: ChatAnswerDetails): AnswerPath[] {
  const paths = new Set<AnswerPath>();
  for (const item of details.mindEvidence ?? []) {
    if (item.source === 'site' || item.source === 'index' || item.source === 'web') paths.add('web');
    if (item.source === 'computed') paths.add('local_computation');
    if (item.source === 'memory') paths.add('memory');
  }
  if (details.localParts?.some(part => part.source === 'computation') || details.webParts?.some(part => part.source === 'computation')) paths.add('local_computation');
  for (const { action, changed, result } of state.trail) {
    // The controller writes these action prefixes. The suffix can contain user data and stays in the chat ledger.
    if (changed && /^(?:search|read)\s/u.test(action)) paths.add('web');
    if (/^(?:open|click|type|select|press|scroll|back|wait|look|read_more|form)(?:\s|$)/u.test(action)
      && /^(?:now at |opened |clicked |typed into |selected |pressed |scrolled$|went back$|waited$|seen: |showing page text from )/u.test(result)) paths.add('browser');
    if (action === 'calculate' || action === 'calculation_memory') paths.add('local_computation');
    if (action === 'skill_read') paths.add('skill_reader');
    if (/^(?:memory_search|memory_save|calculation_memory|user_fact_memory|memory_verify|user_note_verify)$/u.test(action)
      && !result.startsWith('failed:') && !result.startsWith('already done') && !result.startsWith('rejected by')) paths.add('memory');
  }
  if (details.browserRead || browserObserved && state.agentRun?.plan?.steps.some(step =>
    step.state === 'verified' && (step.capability.startsWith('browser.') || step.capability === 'news.read'))) paths.add('browser');
  if (browserObserved && state.agentRun?.plan?.steps.some(step => step.state === 'verified' && step.capability === 'news.read')) paths.add('web');
  const reason = state.agentRun?.verdict?.reason;
  if (withheld || details.withheld || details.webParts?.some(part => part.withheld) || reason === 'owner_refused'
    || blocked && (reason !== 'step_failed' || state.trail.some(entry => entry.action === 'permission gate'))) paths.add('refusal');
  return [...paths];
}

export function recordChatProgress(sink: ChatMetricsSink | undefined, fullAccess: boolean, receivedAt: Date): void {
  if (!sink) return;
  try {
    const elapsed = Date.now() - receivedAt.getTime();
    sink(fullAccess ? 'owner' : 'member', { started: true, ...(elapsed >= 0 ? { firstProgressMs: elapsed } : {}) });
  } catch {
    // Metrics must never interfere with a committed chat run.
  }
}

export function recordChatAnswer(sink: ChatMetricsSink | undefined,
  execution: { full: boolean; metricsStartedAt?: number; page?: unknown } | undefined, state: BrainState,
  blocked: boolean, details: ChatAnswerDetails = {}, withheld = false): void {
  if (!sink || !execution) return;
  try {
    const history = state.agentRun?.history ?? [];
    const receivedAt = execution.metricsStartedAt ?? NaN;
    const elapsed = Date.now() - receivedAt;
    const paths = answerPaths(state, Boolean(execution.page), blocked, withheld, details);
    sink(execution.full ? 'owner' : 'member', {
      ...(elapsed >= 0 ? { finalAnswerMs: elapsed } : {}), phases: chatPhaseDurations(history, receivedAt), paths,
    });
  } catch {
    // The reply is already committed. Leave the normal response and cleanup alone.
  }
}

/** Record the phase history of a run that settled without publishing a final answer. */
export async function recordChatEnd(sink: ChatMetricsSink | undefined, fullAccess: boolean | (() => Promise<boolean>),
  history: RunLedger['history'] | undefined, endedAt?: Date, receivedAt?: number): Promise<void> {
  if (!sink || !history?.length) return;
  try {
    const phases = chatPhaseDurations(history, receivedAt ?? Date.parse(history[0]!.at), endedAt?.getTime());
    if (!Object.keys(phases).length) return;
    const full = typeof fullAccess === 'boolean' ? fullAccess : await fullAccess();
    sink(full ? 'owner' : 'member', { phases });
  } catch {
    // The terminal state is already committed, so metrics cannot affect it.
  }
}
