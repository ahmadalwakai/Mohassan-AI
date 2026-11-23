import { describe, expect, it } from 'vitest';
import { ChatRunViewSchema } from '@mohassan/contracts';
import {
  RunLedgerError, addEvidence, appendStep, beginRepair, canEnterPhase, cancelLedger, classifySteering, countModelCall, createRunLedger, decideVerdict, enterPhase,
  planStep, projectRunView, restoreRunLedger, setPlan, settleStep, startStep, validatePlan,
} from '../apps/server/src/assistant/agent-run.js';

/** The run ledger is pure: these tests drive it with fixed clocks and synthetic steps only. */
const RUN = '0b6b2f0e-6d0f-4f7b-9a41-3c9d5f2a1e11';
const T0 = Date.parse('2026-11-23T14:00:00.000Z');

function ledger() { return createRunLedger({ runId: RUN, at: T0, path: 'action' }); }
const step = (id: string, extra: Partial<Parameters<typeof planStep>[0]> = {}) => planStep({ id, outcome: `do ${id}`, capability: 'web.search', input: id, acceptance: [`${id} observed`], ...extra });

describe('run phases', () => {
  it('moves only along allowed transitions and never leaves a terminal phase', () => {
    const run = ledger();
    expect(() => enterPhase(run, 'completed', T0 + 1)).toThrow(RunLedgerError);
    enterPhase(run, 'understanding', T0 + 1);
    enterPhase(run, 'executing', T0 + 2);
    expect(() => enterPhase(run, 'completed', T0 + 3)).toThrow(/cannot move from executing to completed/);
    enterPhase(run, 'verifying', T0 + 3);
    enterPhase(run, 'partial', T0 + 4);
    expect(() => enterPhase(run, 'executing', T0 + 5)).toThrow(/already ended/);
    expect(run.history.map(entry => entry.phase)).toEqual(['received', 'understanding', 'executing', 'verifying', 'partial']);
  });

  it('lets every working phase end blocked or cancelled, and suspended phases resume only through work', () => {
    for (const phase of ['received', 'understanding', 'planning', 'executing', 'awaiting_input', 'awaiting_approval', 'repairing'] as const) {
      expect(canEnterPhase(phase, 'cancelled'), phase).toBe(true);
      expect(canEnterPhase(phase, 'blocked'), phase).toBe(true);
    }
    expect(canEnterPhase('awaiting_approval', 'completed')).toBe(false);
    expect(canEnterPhase('awaiting_input', 'verifying')).toBe(false);
    expect(canEnterPhase('awaiting_approval', 'executing')).toBe(true);
  });

  it('restores a ledger only for its own run', () => {
    const run = ledger();
    expect(restoreRunLedger(JSON.parse(JSON.stringify(run)), RUN)).toEqual(run);
    expect(restoreRunLedger(run, 'another-run')).toBeNull();
    expect(restoreRunLedger({ ...run, phase: 'thinking' }, RUN)).toBeNull();
  });
});

describe('plans', () => {
  it('accepts an ordered plan and rejects cycles, unknown dependencies, unregistered capabilities and unauthorised irreversible steps', () => {
    expect(validatePlan({ version: 1, steps: [step('search'), step('read', { capability: 'web.read', dependsOn: ['search'] })] }).ok).toBe(true);
    const cycle = validatePlan({ version: 1, steps: [step('a', { dependsOn: ['b'] }), step('b', { dependsOn: ['a'] })] });
    expect(cycle.ok).toBe(false);
    expect(!cycle.ok && cycle.errors).toContain('the plan has a dependency cycle');
    const missing = validatePlan({ version: 1, steps: [step('a', { dependsOn: ['ghost'] })] });
    expect(!missing.ok && missing.errors).toContain('step a depends on unknown step ghost');
    const unknownTool = validatePlan({ version: 1, steps: [step('a', { capability: 'shell.rm_rf' })] });
    expect(!unknownTool.ok && unknownTool.errors).toContain('unregistered capability shell.rm_rf in a');
    const unguarded = validatePlan({ version: 1, steps: [step('send', { capability: 'browser.submit', authorization: 'not_needed' })] });
    expect(!unguarded.ok && unguarded.errors).toContain('irreversible step send has no authorization requirement');
    expect(validatePlan({ version: 1, steps: [step('a'), step('a')] }).ok).toBe(false);
    expect(validatePlan({ version: 1, steps: [] }).ok).toBe(false);
  });

  it('refuses to start a step before its dependencies are verified, and settles steps only along their own transitions', () => {
    const run = ledger();
    setPlan(run, { version: 1, steps: [step('search'), step('read', { capability: 'web.read', dependsOn: ['search'] })] }, T0 + 1);
    expect(() => startStep(run, 'read', T0 + 2)).toThrow(/waits for search/);
    startStep(run, 'search', T0 + 2);
    expect(() => settleStep(run, 'read', 'verified', T0 + 3)).toThrow(RunLedgerError);
    settleStep(run, 'search', 'verified', T0 + 3);
    expect(startStep(run, 'read', T0 + 4).attempts).toBe(1);
    expect(() => setPlan(run, { version: 1, steps: [step('other')] }, T0 + 5)).toThrow(/extended, not replaced/);
    expect(() => appendStep(run, step('loop', { dependsOn: ['loop'] }), T0 + 6)).toThrow(RunLedgerError);
  });
});

describe('verdicts', () => {
  it('cannot complete while a required step is unverified, failed or not yet run, even when the path reported success', () => {
    const outstanding = ledger();
    setPlan(outstanding, { version: 1, steps: [step('first'), step('second', { dependsOn: ['first'] })] }, T0);
    enterPhase(outstanding, 'understanding', T0); enterPhase(outstanding, 'executing', T0);
    startStep(outstanding, 'first', T0); settleStep(outstanding, 'first', 'verified', T0 + 1);
    // One verified step of two is not the whole task: «second» never ran.
    expect(decideVerdict(outstanding, { hostStatus: 'completed', at: T0 + 2 })).toMatchObject({ status: 'partial', verdict: { reason: 'steps_outstanding' } });

    const unknown = ledger();
    setPlan(unknown, { version: 1, steps: [step('write', { capability: 'document.create' })] }, T0);
    enterPhase(unknown, 'understanding', T0); enterPhase(unknown, 'executing', T0);
    startStep(unknown, 'write', T0); settleStep(unknown, 'write', 'unknown', T0 + 1);
    expect(decideVerdict(unknown, { hostStatus: 'completed', at: T0 + 2 }).verdict.reason).toBe('step_unverified');

    const failed = ledger();
    setPlan(failed, { version: 1, steps: [step('open', { capability: 'browser.open' })] }, T0);
    enterPhase(failed, 'understanding', T0); enterPhase(failed, 'executing', T0);
    startStep(failed, 'open', T0); settleStep(failed, 'open', 'failed', T0 + 1);
    const decided = decideVerdict(failed, { hostStatus: 'completed', at: T0 + 2 });
    expect(decided.status).toBe('partial');
    expect(decided.verification.criteria).toEqual([{ id: 'step:open', label: 'do open', required: true, status: 'failed' }]);
    expect(failed.phase).toBe('partial');
  });

  it('never raises a lower status and honours an enforced review', () => {
    const run = ledger();
    enterPhase(run, 'understanding', T0);
    expect(decideVerdict(run, { hostStatus: 'blocked', at: T0 + 1 }).status).toBe('blocked');
    const enforced = ledger();
    enterPhase(enforced, 'understanding', T0);
    const review = { status: 'unverified', allowCompletion: false, shouldBlockCompletion: true, missingCriteria: ['memory'], stagnantSteps: 0,
      criteria: [{ id: 'memory', required: true, status: 'missing', reason: 'missing_evidence' }] } as const;
    const decided = decideVerdict(enforced, { hostStatus: 'completed', review: { ...review, criteria: [...review.criteria], missingCriteria: [...review.missingCriteria] }, enforced: true, criterionLabels: { memory: 'Saved note read back' }, at: T0 + 1 });
    expect(decided).toMatchObject({ status: 'partial', verdict: { reason: 'criteria_unmet' }, verification: { status: 'unverified' } });
    expect(decided.verification.criteria[0]).toMatchObject({ label: 'Saved note read back', status: 'missing', required: true });
  });

  it('shows an advisory criterion as guidance, never as a failed requirement of an answer the plan verified', () => {
    const run = ledger();
    setPlan(run, { version: 1, steps: [step('ask')] }, T0);
    enterPhase(run, 'understanding', T0); enterPhase(run, 'executing', T0);
    startStep(run, 'ask', T0); settleStep(run, 'ask', 'verified', T0 + 1);
    const review = { status: 'unverified', allowCompletion: true, shouldBlockCompletion: false, missingCriteria: ['factual-answer'], stagnantSteps: 0,
      criteria: [{ id: 'factual-answer', required: true, status: 'missing', reason: 'missing_evidence' }] } as const;
    const decided = decideVerdict(run, { hostStatus: 'completed', review: { ...review, criteria: [...review.criteria], missingCriteria: [...review.missingCriteria] }, at: T0 + 2 });
    expect(decided).toMatchObject({ status: 'completed', verification: { status: 'verified' } });
    expect(decided.verification.criteria.find(item => item.id === 'factual-answer')).toMatchObject({ required: false, status: 'missing' });
  });

  it('completes a direct answer with no plan, and a run resumed after a card reaches its verdict through understanding', () => {
    const direct = createRunLedger({ runId: RUN, at: T0, path: 'direct' });
    enterPhase(direct, 'understanding', T0);
    enterPhase(direct, 'answering', T0 + 1);
    expect(decideVerdict(direct, { hostStatus: 'completed', at: T0 + 2 })).toMatchObject({ status: 'completed', verdict: { reason: 'answered' }, verification: { status: 'not_applicable' } });
    const resumed = ledger();
    enterPhase(resumed, 'understanding', T0); enterPhase(resumed, 'awaiting_input', T0 + 1);
    expect(decideVerdict(resumed, { hostStatus: 'completed', at: T0 + 2 }).status).toBe('completed');
    expect(resumed.history.map(entry => entry.phase).slice(-3)).toEqual(['understanding', 'verifying', 'completed']);
  });
});

describe('repairs', () => {
  it('allows the configured number of corrections and stops a failure that repeats', () => {
    const run = createRunLedger({ runId: RUN, at: T0, path: 'action', repairLimit: 2 });
    enterPhase(run, 'understanding', T0); enterPhase(run, 'executing', T0);
    expect(beginRepair(run, { stepId: 'read', signature: 'judge:withhold' }, T0 + 1)).toEqual({ allowed: true });
    expect(run.phase).toBe('repairing');
    // The identical failure again: a third attempt would repeat it.
    expect(beginRepair(run, { stepId: 'read', signature: 'judge:withhold' }, T0 + 2)).toEqual({ allowed: false, reason: 'repeated_failure' });
    expect(beginRepair(run, { stepId: 'read', signature: 'http:503' }, T0 + 3)).toEqual({ allowed: true });
    expect(beginRepair(run, { stepId: 'open', signature: 'http:404' }, T0 + 4)).toEqual({ allowed: false, reason: 'repair_limit' });
    expect(run.repairs).toEqual({ used: 2, limit: 2 });
  });
});

describe('evidence and cancellation', () => {
  it('keeps model text, tool reports and user statements from ever counting as independent evidence', () => {
    const run = ledger();
    expect(addEvidence(run, { kind: 'model_output', label: 'The model said it is done', independent: true }, T0)!.independent).toBe(false);
    expect(addEvidence(run, { kind: 'adapter_report', label: 'Moved to the Recycle Bin', independent: true }, T0)!.independent).toBe(false);
    expect(addEvidence(run, { kind: 'user_statement', label: 'My city is Riyadh', independent: true }, T0)!.independent).toBe(false);
    expect(addEvidence(run, { kind: 'computation', label: '37 * 24 = 888', independent: true }, T0)!.independent).toBe(true);
    addEvidence(run, { kind: 'computation', label: '37 * 24 = 888', independent: true }, T0 + 1);
    expect(run.evidence).toHaveLength(4);
  });

  it('invalidates every unfinished step and unused permission when a run is cancelled or superseded', () => {
    const run = ledger();
    setPlan(run, { version: 1, steps: [step('done'), step('next', { dependsOn: ['done'] })] }, T0);
    enterPhase(run, 'understanding', T0); enterPhase(run, 'executing', T0);
    startStep(run, 'done', T0); settleStep(run, 'done', 'verified', T0);
    cancelLedger(run, 'superseded', T0 + 1);
    expect(run.plan!.steps.map(item => item.state)).toEqual(['verified', 'invalidated']);
    expect(run.verdict).toMatchObject({ status: 'cancelled', reason: 'superseded' });
    expect(run.phase).toBe('cancelled');
  });

  it('reads «توقف» and "stop" alone as a stop, and anything else sent during a task as a correction', () => {
    for (const text of ['توقف', 'أوقف العمل', 'stop', 'Cancel it please', 'خلاص', 'الغ المهمة']) expect(classifySteering(text), text).toBe('stop');
    for (const text of ['لا، احذف new.txt بدلًا منه', 'stop at the second page and read it', 'Actually search for Tokyo instead', 'توقف عند الصفحة الثانية']) expect(classifySteering(text), text).toBe('steer');
  });
});

describe('the client view', () => {
  it('takes the verdict from the run row, which stays the authority even when the ledger missed the last write', () => {
    const run = ledger();
    enterPhase(run, 'understanding', T0);
    const failed = projectRunView({ runId: RUN, status: 'failed', ledger: run, createdAt: new Date(T0), updatedAt: new Date(T0 + 5), modelCalls: 0 })!;
    expect(failed).toMatchObject({ phase: 'blocked', verdict: { status: 'blocked', reason: 'error' }, engine: { kind: 'rules', modelCalls: 0 } });
    expect(ChatRunViewSchema.safeParse(failed).success).toBe(true);
    // The engine is the ledger's own count of model calls that returned a valid result, never a configured model name.
    countModelCall(run, T0 + 1); countModelCall(run, T0 + 2);
    const waiting = projectRunView({ runId: RUN, status: 'waiting_approval', ledger: run, createdAt: new Date(T0), updatedAt: new Date(T0), modelCalls: 0 })!;
    expect(waiting).toMatchObject({ phase: 'awaiting_approval', verdict: null, engine: { kind: 'model', modelCalls: 2 } });
    const legacy = projectRunView({ runId: RUN, status: 'completed', ledger: undefined, createdAt: new Date(T0), updatedAt: new Date(T0), modelCalls: 3 })!;
    expect(legacy).toMatchObject({ phase: 'completed', verdict: { status: 'completed', reason: 'recorded' }, plan: null, sequence: 0, engine: { kind: 'model', modelCalls: 3 } });
    expect(projectRunView({ runId: RUN, status: 'completed', ledger: undefined, createdAt: new Date(T0), updatedAt: new Date(T0) })!.engine).toEqual({ kind: 'rules', modelCalls: 0 });
  });

  it('never shows the private side of a permission record', () => {
    const run = ledger();
    run.permissions.push({ id: '5b8f2a51-27a0-4d55-9a0e-3f0d0e1e2a33', stepId: null, action: 'Delete old.txt', target: 'old.txt', consequence: 'Moved to the Recycle Bin', reversible: true,
      fingerprint: 'a'.repeat(64), decision: 'asked', reason: 'approval_required', decidedAt: new Date(T0).toISOString(), actorId: 'owner-1', conversationId: 'conversation-1',
      runId: RUN, capability: 'desktop.delete', askedAt: new Date(T0).toISOString(), expiresAt: new Date(T0 + 60_000).toISOString() });
    const view = projectRunView({ runId: RUN, status: 'waiting_approval', ledger: run, createdAt: new Date(T0), updatedAt: new Date(T0), modelCalls: 0 })!;
    expect(Object.keys(view.permissions[0]!)).not.toContain('actorId');
    expect(JSON.stringify(view)).not.toContain('owner-1');
  });
});
