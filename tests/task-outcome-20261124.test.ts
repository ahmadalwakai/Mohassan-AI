import { describe, expect, it } from 'vitest';
import { ChatRunViewSchema } from '@mohassan/contracts';
import {
  beginRepair, createRunLedger, decideVerdict, enterPhase, planStep, projectRunView, restoreRunLedger,
  setPlan, settleOpenSteps, settleStep, startStep,
} from '../apps/server/src/assistant/agent-run.js';
import type { TaskCompletionReview } from '../apps/server/src/assistant/task-supervisor.js';
import { beginHandsStep, completeHandsStep, handsStepId, recordHandsPlan, rejectHandsReadResult, reopenHandsReadStep } from '../apps/server/src/assistant/run-plans.js';
import type { HandsPlan } from '../apps/server/src/assistant/hands.js';

const RUN = 'e232654a-8417-4a95-8dd4-218b0d8fb07c';
const AT = Date.parse('2026-11-24T03:35:00Z');
const makeStep = (id: string, required = true, dependsOn: string[] = [], outcome = id) => planStep({
  id, required, dependsOn, outcome, capability: 'web.read', input: null, acceptance: ['Host observed the requested result'],
});
function run(steps: ReturnType<typeof makeStep>[]) {
  const ledger = createRunLedger({ runId: RUN, at: AT, path: 'action' });
  enterPhase(ledger, 'understanding', AT);
  setPlan(ledger, { version: 1, steps }, AT);
  enterPhase(ledger, 'executing', AT);
  return ledger;
}
function verified(ledger: ReturnType<typeof run>, id: string) {
  startStep(ledger, id, AT); settleStep(ledger, id, 'verified', AT + 1);
}

describe('task outcome development criteria frozen before batch 2', () => {
  it.each(['إنشاء التقرير', 'Create the report'])('does not count a required skipped result as accomplished: %s', outcome => {
    const ledger = run([makeStep('research'), makeStep('report', true, ['research'], outcome)]);
    verified(ledger, 'research'); settleStep(ledger, 'report', 'skipped', AT + 1);
    const result = decideVerdict(ledger, { hostStatus: 'completed', at: AT + 2 });
    expect(result).toMatchObject({ status: 'partial', verdict: { reason: 'steps_outstanding' }, verification: { status: 'partial' } });
    expect(result.verification.criteria.find(item => item.id === 'step:report')).toMatchObject({ required: true, status: 'missing' });
  });

  it('does not execute a dependent result when its required input was skipped', () => {
    const ledger = run([makeStep('research'), makeStep('report', true, ['research'])]);
    settleStep(ledger, 'research', 'skipped', AT);
    expect(() => startStep(ledger, 'report', AT + 1)).toThrow(/waits for research/);
    expect(ledger.plan!.steps[1]).toMatchObject({ state: 'pending', attempts: 0 });
  });

  it('permits an explicitly optional skipped dependency without calling it verified', () => {
    const ledger = run([makeStep('extra', false), makeStep('report', true, ['extra'])]);
    settleStep(ledger, 'extra', 'skipped', AT); verified(ledger, 'report');
    const result = decideVerdict(ledger, { hostStatus: 'completed', at: AT + 2 });
    expect(result.status).toBe('completed'); expect(result.verification.status).toBe('verified');
    expect(result.verification.criteria[0]).toMatchObject({ required: false, status: 'missing' });
  });

  it('does not replay an unknown effect after saving and restoring the run', () => {
    const ledger = run([planStep({ id: 'publish', outcome: 'Publish the approved report', capability: 'browser.submit',
      input: null, authorization: 'granted', acceptance: ['Publication observed'] })]);
    startStep(ledger, 'publish', AT); settleStep(ledger, 'publish', 'unknown', AT + 1);
    const restored = restoreRunLedger(JSON.parse(JSON.stringify(ledger)), RUN)!;
    expect(() => startStep(restored, 'publish', AT + 2)).toThrow(/unknown/);
    settleOpenSteps(restored, 'completed', AT + 2);
    expect(restored.plan!.steps[0]).toMatchObject({ state: 'unknown', attempts: 1 });
    expect(decideVerdict(restored, { hostStatus: 'completed', at: AT + 3 })).toMatchObject({
      status: 'partial', verdict: { reason: 'step_unverified' }, verification: { status: 'unverified' },
    });
  });

  it.each(['partial', 'blocked'] as const)('never raises the host result %s or treats unstarted work as successful', hostStatus => {
    const ledger = run([makeStep('research'), makeStep('report', true, ['research'])]);
    verified(ledger, 'research'); settleOpenSteps(ledger, hostStatus, AT + 1);
    const result = decideVerdict(ledger, { hostStatus, at: AT + 2 });
    expect(result.status).toBe(hostStatus);
    expect(result.verification.criteria[1].status).toBe('missing');
  });

  it('checks unmet required criteria beyond the bounded display without hiding the failure', () => {
    const ledger = run(Array.from({ length: 16 }, (_, index) => makeStep(`part${index}`)));
    for (const step of ledger.plan!.steps) verified(ledger, step.id);
    const review: TaskCompletionReview = {
      status: 'unverified', allowCompletion: false, shouldBlockCompletion: true, missingCriteria: ['artifact15'], stagnantSteps: 0,
      criteria: Array.from({ length: 16 }, (_, index) => ({ id: `artifact${index}`, required: true,
        status: index === 15 ? 'missing' as const : 'verified' as const, reason: index === 15 ? 'missing_evidence' as const : 'matched' as const })),
    };
    const result = decideVerdict(ledger, { hostStatus: 'completed', review, enforced: true, at: AT + 2 });
    expect(result.status).toBe('partial'); expect(result.verification.status).toBe('partial');
    expect(result.verification.criteria).toHaveLength(24);
    expect(result.verification.criteria).toContainEqual(expect.objectContaining({ id: 'artifact15', required: true, status: 'missing' }));
  });

  it('keeps advisory unmet criteria from changing an otherwise verified outcome', () => {
    const ledger = run([makeStep('report')]); verified(ledger, 'report');
    const review: TaskCompletionReview = { status: 'unverified', allowCompletion: false, shouldBlockCompletion: false,
      missingCriteria: ['extra'], stagnantSteps: 0, criteria: [{ id: 'extra', required: true, status: 'missing', reason: 'missing_evidence' }] };
    expect(decideVerdict(ledger, { hostStatus: 'completed', review, at: AT + 2 })).toMatchObject({ status: 'completed', verification: { status: 'verified' } });
  });

  it.each([0, 1])('does not verify a rejected answer when the repair budget is %s', repairLimit => {
    const ledger = createRunLedger({ runId: RUN, at: AT, path: 'action', repairLimit });
    enterPhase(ledger, 'understanding', AT);
    const task: HandsPlan = { next: 0, lang: 'en', steps: [{ kind: 'read', more: false }] };
    const prefix = recordHandsPlan(ledger, task, AT), stepId = handsStepId(prefix, 0);
    task.next = 1; beginHandsStep(ledger, task, prefix, 0, AT + 1);
    completeHandsStep(ledger, task, prefix, 0, 'completed', AT + 2);
    rejectHandsReadResult(ledger, task, prefix, 0, AT + 3);
    if (beginRepair(ledger, { stepId, signature: 'judge:wrong-subject' }, AT + 4).allowed) {
      reopenHandsReadStep(ledger, task, prefix, 0, AT + 5);
      beginHandsStep(ledger, task, prefix, 0, AT + 6);
      completeHandsStep(ledger, task, prefix, 0, 'completed', AT + 7);
      rejectHandsReadResult(ledger, task, prefix, 0, AT + 8);
    }
    const decided = decideVerdict(ledger, { hostStatus: 'completed', at: AT + 9 });
    expect(decided).toMatchObject({ status: 'partial', verification: { status: 'failed' } });
    expect(ledger.plan!.steps[0]).toMatchObject({ state: 'failed', attempts: repairLimit + 1 });
  });

  it('publishes the same partial verdict through the shared client contract', () => {
    const ledger = run([makeStep('report')]); settleStep(ledger, 'report', 'skipped', AT);
    decideVerdict(ledger, { hostStatus: 'completed', at: AT + 1 });
    const view = projectRunView({ runId: RUN, status: 'partial', ledger, createdAt: new Date(AT), updatedAt: new Date(AT + 2) });
    expect(ChatRunViewSchema.safeParse(view).success).toBe(true);
    expect(view).toMatchObject({ phase: 'partial', verdict: { status: 'partial' }, verification: { status: 'unverified' } });
  });
});
