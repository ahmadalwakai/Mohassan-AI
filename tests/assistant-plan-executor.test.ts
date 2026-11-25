// Agent-written development tests. These cases must never be used as training data.
import { describe, expect, it, vi } from 'vitest';
import { createRunLedger, restoreRunLedger } from '../apps/server/src/assistant/agent-run.js';
import { executePlan, type PlanToolResult } from '../apps/server/src/assistant/plan/executor.js';
import type { CompiledPlan, PlanStep } from '../apps/server/src/assistant/plan/types.js';

const first = 'first';
const second = 'second';
const third = 'third';
const makeLedger = () => createRunLedger({ runId: 'plan-run', at: Date.now() });
const calculation = (id: string, dependsOn: string[] = []): PlanStep => ({
  id, text: 'Calculate 2 + 3', tool: 'compute', route: 'compute', output: 'number', success: 'number',
  inputs: { text: 'Calculate 2 + 3', references: [] }, dependsOn, publicInput: false,
});
const plan = (...steps: PlanStep[]): CompiledPlan => ({ lang: 'en', steps });
const five: PlanToolResult = { ok: true, value: { type: 'number', value: 5 } };

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('compiled plan execution fences and ledger receipts', () => {
  it('starts independent tools concurrently and serializes lease checkpoints', async () => {
    const ledger = makeLedger();
    const startedBoth = gate();
    const release = gate();
    let inFlight = 0;
    let writing = false;
    const runTool = vi.fn(async (step: PlanStep) => {
      expect(ledger.plan?.steps.find(item => item.id === step.id)?.state).toBe('running');
      if (step.id !== third) {
        inFlight++;
        if (inFlight === 2) startedBoth.resolve();
        await release.promise;
        inFlight--;
      } else {
        expect(ledger.plan?.steps.slice(0, 2).map(item => item.state)).toEqual(['verified', 'verified']);
      }
      return five;
    });
    const checkpoint = vi.fn(async () => {
      expect(writing).toBe(false);
      writing = true;
      await Promise.resolve();
      writing = false;
    });
    const result = executePlan(plan(calculation(first), calculation(second), calculation(third, [first, second])), { ledger, runTool, checkpoint });

    try {
      await Promise.race([startedBoth.promise, result.then(() => { throw new Error('Independent calls did not overlap'); })]);
      expect(runTool).toHaveBeenCalledTimes(2);
    } finally {
      release.resolve();
    }
    expect((await result).status).toBe('completed');
    expect(runTool.mock.calls.map(([step]) => step.id)).toEqual([first, second, third]);
    expect(ledger.evidence.map(receipt => receipt.stepId).sort()).toEqual([first, second, third]);
    expect(new Set(ledger.evidence.map(receipt => receipt.id)).size).toBe(3);
    expect(new Set(ledger.evidence.map(receipt => receipt.reference)).size).toBe(3);
    for (const receipt of ledger.evidence) expect(receipt.reference).toMatch(/^plan-result:[a-f0-9]{64}$/u);
    expect(restoreRunLedger(ledger, 'plan-run')).toBe(ledger);
  });

  it('propagates the original worker interruption without retrying or claiming a result', async () => {
    const ledger = makeLedger();
    const lostLease = new Error('lease ended');
    const runTool = vi.fn(async () => { throw lostLease; });
    const firstSearch: PlanStep = { ...calculation(first), tool: 'search', route: 'web_search', publicInput: true };

    await expect(executePlan(plan(firstSearch, calculation(second, [first])), {
      ledger, runTool, isInterruption: error => error === lostLease,
    })).rejects.toBe(lostLease);
    expect(runTool).toHaveBeenCalledTimes(1);
    expect(ledger.plan?.steps.map(step => [step.state, step.attempts])).toEqual([['running', 1], ['pending', 0]]);
    expect(ledger.evidence).toEqual([]);
  });

  it('keeps matching adapter evidence for each step with its own receipt ID', async () => {
    const ledger = makeLedger();
    const source = { kind: 'source' as const, label: 'Same source', reference: 'https://example.org/figures' };
    const runTool = async (): Promise<PlanToolResult> => ({ ...five, evidence: source });
    await executePlan(plan(calculation(first), calculation(second)), { ledger, runTool });
    expect(ledger.evidence.map(({ stepId, reference }) => ({ stepId, reference }))).toEqual([
      { stepId: first, reference: source.reference }, { stepId: second, reference: source.reference },
    ]);
    expect(ledger.evidence[0]?.id).not.toBe(ledger.evidence[1]?.id);
  });

  it('does not dispatch when the abort signal changes during a checkpoint', async () => {
    const ledger = makeLedger();
    const controller = new AbortController();
    const stopped = new Error('request stopped');
    const runTool = vi.fn(async () => five);
    const checkpoint = async () => {
      if (ledger.plan?.steps.some(step => step.state === 'running')) controller.abort(stopped);
    };
    await expect(executePlan(plan(calculation(first), calculation(second)), {
      ledger, runTool, signal: controller.signal, checkpoint,
    })).rejects.toBe(stopped);
    expect(runTool).not.toHaveBeenCalled();
  });

  it('rejects a cyclic graph before recording or dispatching either step', async () => {
    const ledger = makeLedger();
    const runTool = vi.fn(async () => five);
    await expect(executePlan(plan(calculation(first, [second]), calculation(second, [first])), { ledger, runTool }))
      .rejects.toMatchObject({ code: 'RUN_PLAN_INVALID' });
    expect(runTool).not.toHaveBeenCalled();
    expect(ledger.plan).toBeNull();
  });

  it('refuses to replay an already-recorded plan', async () => {
    const ledger = makeLedger();
    const runTool = vi.fn(async () => five);
    const compiled = plan(calculation(first), calculation(second));
    await executePlan(compiled, { ledger, runTool });
    await expect(executePlan(compiled, { ledger, runTool })).rejects.toMatchObject({ code: 'RUN_PLAN_INVALID' });
    expect(runTool).toHaveBeenCalledTimes(2);
  });
});
