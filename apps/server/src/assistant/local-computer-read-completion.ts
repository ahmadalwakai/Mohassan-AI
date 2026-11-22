import { assessLocalComputerRead, planLocalComputerRead, LOCAL_COMPUTER_READ_MAX_ASSESSMENT_AGE_MS,
  type LocalComputerReadHost, type LocalComputerReadProof } from './local-computer-read.js';
import { createTaskSupervisor, observeTaskStep, restoreTaskSupervisor, reviewTaskCompletion,
  type TaskSupervisorState } from './task-supervisor.js';

export interface LocalComputerReadCompletionInput {
  plan: unknown;
  request: unknown;
  /** The actual fresh adapted host result, never a serialized proof or model JSON. */
  screen: unknown;
  host: LocalComputerReadHost;
}
export interface LocalComputerReadCompletion {
  readonly text: string;
  readonly status: 'completed' | 'partial' | 'blocked';
  readonly proof?: Readonly<LocalComputerReadProof>;
}

/** Host declaration must occur before computer.view, using this returned plan's exact objective. */
export function createLocalComputerReadSupervisor(request: string, runId: string, now = Date.now()): TaskSupervisorState | null {
  try {
    const plan = planLocalComputerRead(request);
    if (!plan) return null;
    return createTaskSupervisor({ id: runId, objective: request, kind: 'task', mode: 'enforced', now, criteria: [{
      id: plan.kind === 'title' ? 'computer-title' : 'computer-text-subset', kind: 'answer_evidence', target: plan.target,
      description: plan.kind === 'title'
        ? 'The answer preserves the exact nonempty window title returned by the current host PC read.'
        : 'The returned accessible strings are a partial text subset and cannot verify the complete visible window.',
      required: true, maxAgeMs: LOCAL_COMPUTER_READ_MAX_ASSESSMENT_AGE_MS,
    }] });
  } catch { return null; }
}

/**
 * Pure host derivation: no supplied proof is accepted. Reassess the actual fresh
 * screen, bind the complete current contract, then record only hashes/host receipt
 * timing. The caller retains live account/grant/lease/signal checks around I/O.
 * Mutates supervision only after all binding checks and the new step validate.
 */
export function completeLocalComputerRead(supervision: TaskSupervisorState, input: LocalComputerReadCompletionInput): LocalComputerReadCompletion {
  const assessed = assessLocalComputerRead(input.plan, input.request, input.screen, input.host);
  const blocked = (): LocalComputerReadCompletion => Object.freeze({ status: 'blocked',
    text: planLocalComputerRead(input.request)?.language === 'ar'
      ? 'لم أتحقق من نص نافذة الكمبيوتر في هذا الطلب.' : 'The PC window text was not verified for this request.' });
  if (assessed.status === 'unavailable' || !assessed.proof || typeof input.request !== 'string') return blocked();
  try {
    const expected = createLocalComputerReadSupervisor(input.request, input.host.runId, input.host.declaredAt);
    if (!expected) return blocked();
    const restored = restoreTaskSupervisor(supervision, expected.contract, { now: input.host.assessedAt });
    if (!restored || restored.startedAt !== input.host.declaredAt || restored.contract.id !== assessed.proof.runId) return blocked();
    const criterion = restored.contract.criteria[0];
    if (restored.contract.criteria.length !== 1 || criterion.kind !== 'answer_evidence' || !criterion.required
        || criterion.target !== assessed.proof.target) return blocked();
    const confirmed = assessed.status === 'completed' && assessed.proof.coverage === 'complete_title';
    const update = observeTaskStep(restored, {
      stepId: `${restored.contract.id}:computer-text:${restored.lastSequence + 1}`, sequence: restored.lastSequence + 1,
      tool: 'computer_view', startedAt: input.host.readStartedAt, finishedAt: input.host.readFinishedAt,
      result: confirmed ? 'succeeded' : 'unknown', resultRef: `computer-text:${assessed.proof.contentHash}`,
      resultHash: assessed.proof.contentHash, observations: [{
        criterionId: criterion.id, kind: 'answer_evidence', source: 'computer-observation', target: criterion.target,
        reference: `computer-text:${assessed.proof.contentHash}`, observedAt: assessed.proof.receivedAt,
        outcome: confirmed ? 'confirmed' : 'unknown', independentlyVerified: confirmed, answerHash: assessed.proof.answerHash,
      }],
    });
    if (!update.accepted) return blocked();
    const review = reviewTaskCompletion(restored, { now: input.host.assessedAt, answerHash: assessed.proof.answerHash });
    Object.assign(supervision, restored);
    return Object.freeze({ text: assessed.reply, status: confirmed && review.status === 'verified' && review.allowCompletion ? 'completed' : 'partial',
      proof: assessed.proof });
  } catch { return blocked(); }
}
