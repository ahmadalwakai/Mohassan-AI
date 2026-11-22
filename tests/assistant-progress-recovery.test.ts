import { describe, expect, it } from 'vitest';
import {
  armProgressPause, createProgressRecovery, restoreProgressRecovery, resumeProgressAfterRetry, reviewProgressRecovery,
  type ProgressRecoveryContext, type ProgressRecoveryState,
} from '../apps/server/src/assistant/progress-recovery.js';
import { compileTaskSupervisor, observeTaskStep, taskEvidenceHash, type TaskSupervisorState } from '../apps/server/src/assistant/task-supervisor.js';

const started = 1_000;
function fixture() {
  const ledger = compileTaskSupervisor({ id: 'run-1', objective: 'Read the requested page', now: started, operation: { kind: 'conversation' } });
  const identity = { runId: 'run-1', contractHash: ledger.contract.hash };
  const state = createProgressRecovery(identity);
  const context = (totalSteps = ledger.steps.length, extra: Partial<ProgressRecoveryContext> = {}): ProgressRecoveryContext => ({
    ...identity, totalSteps, failures: 0, unchanged: 0, supervision: ledger, effectStatus: 'clear', ...extra,
  });
  return { ledger, identity, state, context };
}
function read(ledger: TaskSupervisorState, content = 'showing page text from 3600', result: 'succeeded' | 'failed' | 'unknown' = 'succeeded') {
  const sequence = ledger.lastSequence + 1;
  return observeTaskStep(ledger, { stepId: `read-${sequence}`, sequence, tool: 'read_more',
    startedAt: started + sequence * 10, finishedAt: started + sequence * 10 + 5,
    result, resultHash: taskEvidenceHash(content), changed: true });
}
function pauseAndRetry(state: ProgressRecoveryState, context: ProgressRecoveryContext, questionId = 'progress-question-1') {
  const pause = armProgressPause(state, questionId, context);
  expect(pause.armed).toBe(true);
  const retry = resumeProgressAfterRetry(pause.state, { questionId, optionId: 'retry' }, context);
  expect(retry.resumed).toBe(true);
  return retry;
}

describe('progress recommendations from host receipts', () => {
  it('keeps ordinary chat without a ledger within its budget', () => {
    const { state, context } = fixture();
    expect(reviewProgressRecovery(state, context(0, { supervision: undefined }))).toMatchObject({
      action: 'continue', reason: 'within_budget', remainingDecisions: 60, remainingRetries: 2, mayReplayEffects: false,
    });
  });

  it('warns and then pauses repeated end-of-page reads despite changed:true', () => {
    const { state, context, ledger } = fixture();
    read(ledger);
    for (let index = 0; index < 3; index++) read(ledger);
    expect(reviewProgressRecovery(state, context())).toMatchObject({ action: 'change_strategy', reason: 'stagnation', stagnantSteps: 3 });
    read(ledger); read(ledger);
    expect(reviewProgressRecovery(state, context())).toMatchObject({ action: 'pause_for_retry', reason: 'stagnation', stagnantSteps: 5 });
  });

  it('lets genuinely advancing page offsets reset the read stagnation streak', () => {
    const { state, context, ledger } = fixture();
    read(ledger); read(ledger); read(ledger); read(ledger);
    read(ledger, 'showing page text from 5400');
    expect(reviewProgressRecovery(state, context())).toMatchObject({ action: 'continue', stagnantSteps: 0 });
    // A new result can be progress toward investigation; it is never proof that
    // the requested objective was achieved or an instruction to dispatch tools.
    expect(reviewProgressRecovery(state, context()).mayReplayEffects).toBe(false);
  });

  it('counts duplicate decisions suppressed before tool dispatch through unchanged', () => {
    const { state, context } = fixture();
    expect(reviewProgressRecovery(state, context(3, { unchanged: 3 }))).toMatchObject({ action: 'change_strategy', stagnantSteps: 3 });
    expect(reviewProgressRecovery(state, context(5, { unchanged: 5 }))).toMatchObject({ action: 'pause_for_retry', reason: 'stagnation' });
  });

  it('does not treat new failed content as progress', () => {
    const { state, context, ledger } = fixture();
    for (let index = 0; index < 5; index++) read(ledger, `distinct message ${index}`, 'failed');
    expect(reviewProgressRecovery(state, context())).toMatchObject({ action: 'pause_for_retry', reason: 'stagnation' });
  });

  it('distinguishes new but inconclusive read evidence from an unknown external effect', () => {
    const { state, context, ledger } = fixture();
    read(ledger, 'new partial source evidence', 'unknown');
    expect(reviewProgressRecovery(state, context())).toMatchObject({ action: 'continue', reason: 'within_budget' });
    for (let index = 0; index < 5; index++) read(ledger, 'new partial source evidence', 'unknown');
    expect(reviewProgressRecovery(state, context())).toMatchObject({ action: 'pause_for_retry', reason: 'stagnation' });
  });

  it('preserves the six consecutive failure threshold', () => {
    const { state, context } = fixture();
    expect(reviewProgressRecovery(state, context(6, { failures: 6 }))).toMatchObject({ action: 'pause_for_retry', reason: 'failures' });
    expect(reviewProgressRecovery(state, context(5, { failures: 5 }))).toMatchObject({ action: 'continue' });
  });

  it('does not add a new receipt for a replayed tool result', () => {
    const { state, context, ledger } = fixture();
    read(ledger);
    const receipt = ledger.steps[0];
    const { contractHash: _contract, inputHash: _input, progressed: _progressed, ...input } = receipt;
    expect(observeTaskStep(ledger, input).accepted).toBe(false);
    expect(ledger.steps).toHaveLength(1);
    expect(reviewProgressRecovery(state, context(6, { unchanged: 5 }))).toMatchObject({ action: 'pause_for_retry', stagnantSteps: 5 });
  });
});

describe('explicit bounded retries', () => {
  it('allows a legacy step40 retry without immediate repause and stops at lifetime60', () => {
    const { state, context } = fixture();
    expect(reviewProgressRecovery(state, context(40))).toMatchObject({ action: 'pause_for_retry', reason: 'window_limit' });
    const retry = pauseAndRetry(state, context(40));
    expect(retry.resetCounters).toEqual({ failures: 0, unchanged: 0 });
    expect(retry.state.checkpoint).toEqual({ totalSteps: 40, supervisionSequence: 0 });
    expect(reviewProgressRecovery(retry.state, context(40))).toMatchObject({ action: 'continue', windowSteps: 0, remainingDecisions: 20 });
    expect(reviewProgressRecovery(retry.state, context(59))).toMatchObject({ action: 'continue', windowSteps: 19 });
    expect(reviewProgressRecovery(retry.state, context(60))).toMatchObject({ action: 'stop_and_report', reason: 'lifetime_limit', remainingDecisions: 0 });
  });

  it('ignores pre-retry stagnant receipts while counting new repeated receipts', () => {
    const { state, context, ledger } = fixture();
    for (let index = 0; index < 6; index++) read(ledger);
    const ledgerBefore = JSON.stringify(ledger);
    const retry = pauseAndRetry(state, context());
    expect(JSON.stringify(ledger)).toBe(ledgerBefore);
    expect(ledger.stagnantSteps).toBe(5);
    expect(reviewProgressRecovery(retry.state, context())).toMatchObject({ action: 'continue', stagnantSteps: 0 });
    read(ledger);
    expect(reviewProgressRecovery(retry.state, context())).toMatchObject({ action: 'continue', stagnantSteps: 1 });
    for (let index = 0; index < 4; index++) read(ledger);
    expect(reviewProgressRecovery(retry.state, context())).toMatchObject({ action: 'pause_for_retry', stagnantSteps: 5 });
  });

  it('permits at most two consumed retry authorizations without resetting lifetime steps', () => {
    const { state, context } = fixture();
    const first = pauseAndRetry(state, context(5, { unchanged: 5 }), 'q-1');
    const second = pauseAndRetry(first.state, context(10, { failures: 6 }), 'q-2');
    expect(second.state.retries).toBe(2);
    expect(second.state.consumedQuestions).toEqual(['q-1', 'q-2']);
    expect(reviewProgressRecovery(second.state, context(10))).toMatchObject({ action: 'continue', remainingRetries: 0, remainingDecisions: 50 });
    expect(reviewProgressRecovery(second.state, context(15, { unchanged: 5 }))).toMatchObject({ action: 'stop_and_report', reason: 'retry_limit' });
    expect(armProgressPause(second.state, 'q-3', context(15, { unchanged: 5 })).armed).toBe(false);
  });

  it('cannot manufacture a checkpoint by answering an ordinary question or approval', () => {
    const { state, context } = fixture();
    for (const optionId of ['continue', 'yes', 'approved', 'thanks', '1', 'stop']) {
      expect(resumeProgressAfterRetry(state, { questionId: 'ordinary-card', optionId }, context(40))).toMatchObject({ resumed: false, reason: 'not_retry', state });
    }
    expect(resumeProgressAfterRetry(state, { questionId: 'ordinary-card', optionId: 'retry' }, context(40))).toMatchObject({ resumed: false, reason: 'question_mismatch' });
    expect(reviewProgressRecovery(state, context(40)).action).toBe('pause_for_retry');
  });

  it('rejects a fabricated, stale, or already consumed question ID', () => {
    const { state, context } = fixture();
    const pause = armProgressPause(state, 'active-card', context(40));
    const before = JSON.stringify(pause.state);
    expect(resumeProgressAfterRetry(pause.state, { questionId: 'fabricated', optionId: 'retry' }, context(40))).toMatchObject({ resumed: false, reason: 'question_mismatch' });
    expect(resumeProgressAfterRetry(pause.state, { questionId: 'active-card', optionId: 'retry' }, context(41))).toMatchObject({ resumed: false, reason: 'invalid_state' });
    expect(JSON.stringify(pause.state)).toBe(before);
    const retry = resumeProgressAfterRetry(pause.state, { questionId: 'active-card', optionId: 'retry' }, context(40));
    expect(resumeProgressAfterRetry(retry.state, { questionId: 'active-card', optionId: 'retry' }, context(40))).toMatchObject({ resumed: false, reason: 'question_mismatch' });
    expect(armProgressPause(retry.state, 'active-card', context(45, { unchanged: 5 }))).toMatchObject({ armed: false, reason: 'question_conflict' });
  });

  it('requires exact pause counters and ledger sequence before resetting anything', () => {
    const { state, context, ledger } = fixture();
    read(ledger);
    const pausedContext = context(6, { failures: 6, unchanged: 6 });
    const pause = armProgressPause(state, 'q', pausedContext);
    for (const extra of [{ failures: 0 }, { unchanged: 0 }, { totalSteps: 7 }]) {
      expect(resumeProgressAfterRetry(pause.state, { questionId: 'q', optionId: 'retry' }, { ...pausedContext, ...extra }).resumed).toBe(false);
    }
    read(ledger, 'newly observed while supposedly paused');
    expect(resumeProgressAfterRetry(pause.state, { questionId: 'q', optionId: 'retry' }, pausedContext).resumed).toBe(false);
  });

  it('arms only a real progress pause and preserves an existing active card', () => {
    const { state, context } = fixture();
    expect(armProgressPause(state, 'q', context(1))).toMatchObject({ armed: false, reason: 'not_paused' });
    const pause = armProgressPause(state, 'q', context(40));
    expect(armProgressPause(pause.state, 'q', context(40))).toMatchObject({ armed: true, reason: 'already_armed' });
    expect(armProgressPause(pause.state, 'other-q', context(40))).toMatchObject({ armed: false, reason: 'question_conflict' });
    expect(reviewProgressRecovery(pause.state, context(40))).toMatchObject({ action: 'pause_for_retry', reason: 'awaiting_retry' });
  });
});

describe('effect fences and bounded restoration', () => {
  it.each(['pending', 'unknown'] as const)('reconciles %s effects even at a budget limit without granting replay', effectStatus => {
    const { state, context } = fixture();
    const paused = armProgressPause(state, 'q', context(40)).state;
    const before = JSON.stringify(paused);
    expect(reviewProgressRecovery(paused, context(60, { effectStatus }))).toMatchObject({ action: 'reconcile', reason: `effect_${effectStatus}`, mayReplayEffects: false });
    expect(resumeProgressAfterRetry(paused, { questionId: 'q', optionId: 'retry' }, context(40, { effectStatus }))).toMatchObject({ resumed: false, reason: 'effect_unresolved' });
    expect(JSON.stringify(paused)).toBe(before);
    expect(armProgressPause(state, 'q', context(40, { effectStatus })).armed).toBe(false);
  });

  it('round-trips a checkpoint while keeping the ledger and signatures outside recovery state', () => {
    const { state, context, ledger } = fixture();
    read(ledger);
    const signatures = { 'type|account|send': 1 };
    const original = JSON.stringify({ state, ledger, signatures });
    const retry = pauseAndRetry(state, context(40));
    const restored = restoreProgressRecovery(JSON.parse(JSON.stringify(retry.state)), context(40));
    expect(restored).toEqual(retry.state);
    expect(reviewProgressRecovery(restored!, context(40)).action).toBe('continue');
    expect(JSON.stringify({ state, ledger, signatures })).toBe(original);
    expect(JSON.stringify(restored)).not.toContain('type|account|send');
  });

  it('rejects cross-run, changed-objective, and rolled-back restoration', () => {
    const { state, context } = fixture();
    const retry = pauseAndRetry(state, context(40));
    expect(restoreProgressRecovery(retry.state, context(40, { runId: 'another-run' }))).toBeNull();
    expect(restoreProgressRecovery(retry.state, context(40, { contractHash: 'a'.repeat(64) }))).toBeNull();
    expect(restoreProgressRecovery(retry.state, context(39))).toBeNull();
    expect(reviewProgressRecovery(retry.state, context(39))).toMatchObject({ action: 'stop_and_report', reason: 'invalid_state' });
  });

  it('rejects a missing or tampered ledger after its sequence was checkpointed', () => {
    const { state, context, ledger } = fixture();
    for (let index = 0; index < 6; index++) read(ledger);
    const retry = pauseAndRetry(state, context());
    expect(restoreProgressRecovery(retry.state, context(6, { supervision: undefined }))).toBeNull();
    const forged = structuredClone(ledger);
    forged.steps[1].progressed = true;
    expect(restoreProgressRecovery(retry.state, context(6, { supervision: forged }))).toBeNull();
    expect(ledger.steps[1].progressed).toBe(false);
  });

  it('fails closed on oversized, malformed, or internally inconsistent stored states', () => {
    const { state, context } = fixture();
    const variants = [null, { ...state, extra: true }, { ...state, runId: 'x'.repeat(9000) },
      { ...state, policy: { ...state.policy, lifetimeDecisions: 61 } },
      { ...state, policy: { ...state.policy, maxRetries: 3 } },
      { ...state, policy: { ...state.policy, warnAfter: 5, pauseAfter: 5 } },
      { ...state, retries: 1, consumedQuestions: [] },
      { ...state, checkpoint: { totalSteps: 20, supervisionSequence: 0 } },
    ];
    for (const value of variants) expect(restoreProgressRecovery(value, context(40))).toBeNull();
    for (const totalSteps of [-1, NaN, Infinity, 1.5]) {
      expect(reviewProgressRecovery(state, context(totalSteps))).toMatchObject({ action: 'stop_and_report', reason: 'invalid_state' });
    }
  });

  it('does not offer a retry at lifetime60 or after the bounded evidence ledger is full', () => {
    const { state, context, ledger } = fixture();
    expect(armProgressPause(state, 'q', context(60))).toMatchObject({ armed: false, reason: 'not_paused' });
    for (let index = 0; index < 64; index++) read(ledger, `content ${index}`);
    expect(reviewProgressRecovery(state, context(20))).toMatchObject({ action: 'stop_and_report', reason: 'ledger_capacity' });
  });

  it('does not allow policy options to enlarge the hard ceilings', () => {
    const { identity } = fixture();
    expect(() => createProgressRecovery({ ...identity, policy: { lifetimeDecisions: 61 } })).toThrow();
    expect(() => createProgressRecovery({ ...identity, policy: { windowDecisions: 41 } })).toThrow();
    expect(() => createProgressRecovery({ ...identity, policy: { maxRetries: 3 } })).toThrow();
  });
});
