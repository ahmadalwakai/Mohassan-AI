import { AsyncLocalStorage } from 'node:async_hooks';
import type { ArbiterInput } from '../../../../packages/model-relations/src/arbiter.js';
import { ModelRelationsManager, type ArbiterDecisionLog, type ArbiterDecisionType } from '../../../../packages/model-relations/src/manager.js';
import type { ModelRuntime } from '../../../../packages/model-relations/src/runtime.js';

let runtime: Promise<ModelRuntime> | undefined;
export const modelRelationsManager = new ModelRelationsManager({
  async run(id, input) {
    runtime ??= import('../../../../packages/model-relations/src/runtime.js').then(({ createModelRuntime }) => createModelRuntime({
      heavyAvailable: () => process.env.MOHASSAN_MODEL_WORKER !== '1' && process.env.EXECUTOR_EXPERIMENT !== 'uncontained-local',
    })).catch(error => { runtime = undefined; throw error; });
    return (await runtime).run(id, input);
  },
});

export interface ArbiterReplayRule {
  turnId: number;
  type: ArbiterDecisionType;
  occurrence?: number;
  component: string;
}

export interface ArbiterReplayDecision extends ArbiterDecisionLog {
  turnId: number;
  occurrence: number;
}

interface ReplayTrace {
  decisions: ArbiterReplayDecision[];
  overrides: readonly ArbiterReplayRule[];
  turn: number;
}

const replay = new AsyncLocalStorage<ReplayTrace>();
const execution = new AsyncLocalStorage<{ runId: string; replayTurn?: number }>();
const pending = new Map<string, ArbiterDecisionLog[]>();

/** In-process development runner only. The server has no request field for overrides. */
export function withArbiterReplay<T>(options: { overrides: readonly ArbiterReplayRule[] }, run: (trace: ReplayTrace) => T): T {
  if (process.env.NODE_ENV === 'production') throw new Error('Arbiter replay is disabled in production');
  const trace: ReplayTrace = { decisions: [], overrides: options.overrides, turn: 0 };
  return replay.run(trace, () => run(trace));
}

export function beginArbiterReplayTurn(): void {
  const trace = replay.getStore();
  if (trace) trace.turn++;
}

export function withArbiterExecution<T>(runId: string, run: () => T): T {
  return execution.run({ runId, replayTurn: replay.getStore()?.turn }, run);
}

export function takeArbiterDecisions(runId: string): ArbiterDecisionLog[] | undefined {
  const decisions = pending.get(runId);
  pending.delete(runId);
  return decisions;
}

export function arbiterEnabled(): boolean {
  return replay.getStore() !== undefined || process.env.MOHASSAN_MODEL_RELATIONS !== 'off';
}

export function hasArbiterExecution(): boolean {
  return execution.getStore() !== undefined;
}

type Claim<T> = ArbiterInput['claimants'][number] & { result: T };

export function arbitrateComponent<T>(type: ArbiterDecisionType, context: {
  text: string;
  conversationState: string;
  runId?: string;
  protected?: boolean;
  started?: number;
  modelStates?: ArbiterInput['modelStates'];
}, precedence: Claim<T>, alternatives: readonly Claim<T>[]): T {
  const started = context.started ?? performance.now();
  if (!arbiterEnabled() || !alternatives.length) return precedence.result;
  const active = execution.getStore();
  const runId = context.runId ?? active?.runId;
  const trace = replay.getStore();
  if (!runId && !trace) return precedence.result;
  const candidates = [precedence, ...alternatives];
  const input: ArbiterInput = {
    type, precedence: precedence.component,
    claimants: candidates.map(({ result: _result, ...candidate }) => candidate),
    language: /\p{Script=Arabic}/u.test(context.text) ? 'ar' : 'en',
    length: context.text.length,
    conversationState: context.conversationState,
    ...(context.modelStates ? { modelStates: context.modelStates } : {}),
  };
  const turnId = active?.replayTurn ?? trace?.turn ?? 0;
  const occurrence = trace ? 1 + trace.decisions.filter(decision => decision.turnId === turnId && decision.type === type).length : 1;
  const forced = trace?.overrides.find(rule => rule.turnId === turnId && rule.type === type && (rule.occurrence ?? 1) === occurrence)?.component;
  const decision = modelRelationsManager.arbitrate(input, { forced, protected: context.protected });
  decision.elapsedMs = performance.now() - started;
  if (trace) trace.decisions.push({ ...decision, turnId, occurrence });
  if (runId && process.env.MOHASSAN_MODEL_RELATIONS !== 'off') {
    if (pending.size >= 2048 && !pending.has(runId)) pending.delete(pending.keys().next().value!);
    const decisions = pending.get(runId) ?? [];
    if (decisions.length < 16) decisions.push(decision);
    pending.set(runId, decisions);
  }
  return candidates.find(candidate => candidate.component === decision.selected)?.result ?? precedence.result;
}
