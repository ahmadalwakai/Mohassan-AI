import { createUserFactMemoryReceipt, restoreUserFactMemoryReceipt, type UserFactMemoryBinding } from './user-fact-memory-receipt.js';
import { restoreUserFactMemoryFlowState, validateUserFactMemoryReadback, type UserFactMemoryFlowResult } from './user-fact-memory-flow.js';
import { createTaskSupervisor, observeTaskStep, reviewTaskCompletion, taskEvidenceHash, type TaskObservation, type TaskSupervisorState } from './task-supervisor.js';

/** Only exact persistence of a current user's statement, never its factual truth. */
export function createUserFactMemorySupervisor(request: string, binding: UserFactMemoryBinding, now = Date.now()): TaskSupervisorState | null {
  const receipt = createUserFactMemoryReceipt(request, binding);
  if (!receipt) return null;
  return createTaskSupervisor({ id: binding.runId, objective: request, kind: 'task', mode: 'advisory', now,
    criteria: [{ id: 'user-fact-memory-save', kind: 'effect', required: true,
      target: `memory:user-assertion:${receipt.operationKey}`, expectationHash: receipt.payload.hash,
      description: 'Fresh owner-scoped readback verifies the exact literal user statement is actively persisted with manual provenance.' }] });
}

/** Fixed host wording; provider prose or a commit acknowledgement cannot confirm a saved note. */
export function completeUserFactMemory(supervision: TaskSupervisorState, input: {
  request: string; binding: UserFactMemoryBinding; result: UserFactMemoryFlowResult; startedAt: number; now?: number;
}): { text: string; status: 'completed' | 'partial' | 'blocked' } {
  const now = input.now ?? Date.now(), ar = /\p{Script=Arabic}/u.test(input.request);
  const expected = createUserFactMemorySupervisor(input.request, input.binding, now);
  const receipt = createUserFactMemoryReceipt(input.request, input.binding);
  if (!expected || !receipt) return { status: 'blocked', text: ar
    ? 'لم أتحقق من نص صريح صالح للحفظ. أعد كتابة الملاحظة التي تريد حفظها.'
    : 'I could not verify an explicit note suitable for saving. Please write the note you want saved.' };
  const supplied = restoreUserFactMemoryReceipt(input.result.receipt, input.request, input.binding);
  const state = restoreUserFactMemoryFlowState(input.result.state, input.request, input.binding, now);
  const readback = supplied && state?.phase === 'verified' && input.result.scope === 'current_user_assertion_persistence_only'
    && input.result.status === 'verified' && input.result.persistence === 'verified' && input.result.reason === 'verified'
    ? validateUserFactMemoryReadback(input.result.readback, receipt, state, input.startedAt, now) : null;
  const verified = readback?.status === 'verified';
  const persistence = verified ? 'verified' : input.result.persistence === 'verified' ? 'unknown' : input.result.persistence;
  const notes = ar ? {
    verified: receipt.statementKind === 'language_preference' ? 'حفظت تفضيل اللغة في ذاكرتك.' : 'حفظت ملاحظتك في ذاكرتك.',
    not_attempted: 'ما زال حفظ الملاحظة معلقًا؛ لم أحاول الكتابة.',
    unknown: 'لم أستطع تأكيد حفظ الملاحظة في الذاكرة. لم أكرر محاولة الكتابة.',
    missing: 'لم تجد القراءة المستقلة ملاحظة محفوظة لهذه العملية. لم أكرر محاولة الكتابة.',
    unavailable: 'لم أتحقق من ملاحظة محفوظة فعّالة. لم أعد إنشاء السجل أو أكرر الكتابة.',
  } : {
    verified: receipt.statementKind === 'language_preference' ? 'Saved your language preference in your memory.' : 'Saved your note in your memory.',
    not_attempted: 'Saving the note is still pending; no write was attempted.',
    unknown: 'I could not confirm that the note was saved in memory. I did not repeat the write.',
    missing: 'Read-only verification found no saved note for this operation. I did not repeat the write.',
    unavailable: 'I could not verify an active saved note. I did not recreate the record or repeat the write.',
  };
  const text = notes[persistence];
  const contractMatches = supervision.contract.id === input.binding.runId && supervision.contract.hash === expected.contract.hash;
  const saved = supervision.contract.criteria.find(item => item.id === 'user-fact-memory-save' && item.kind === 'effect');
  const observations: TaskObservation[] = [];
  if (contractMatches && saved?.required && saved.kind === 'effect' && saved.target === `memory:user-assertion:${receipt.operationKey}`
    && saved.expectationHash === receipt.payload.hash) observations.push({ criterionId: saved.id, kind: 'effect', source: 'authoritative-readback',
    target: saved.target, reference: verified ? `memory:${readback.receipt.itemId}:${readback.receipt.itemVersion}` : `operation:${receipt.operationKey}`,
    actionRef: receipt.operationKey, observedAt: verified ? Date.parse(readback.observedAt) : now,
    expectationHash: receipt.payload.hash, independentlyVerified: verified, outcome: verified ? 'confirmed' : 'unknown' });
  observeTaskStep(supervision, { stepId: `${supervision.contract.id}:${supervision.lastSequence + 1}`, sequence: supervision.lastSequence + 1,
    tool: 'user_fact_memory_readback', startedAt: Math.max(supervision.startedAt, input.startedAt), finishedAt: now,
    result: verified ? 'succeeded' : 'unknown',
    resultHash: taskEvidenceHash(JSON.stringify([receipt.operationKey, persistence, verified ? readback.receipt : null])), observations });
  const review = reviewTaskCompletion(supervision, { now, answerHash: taskEvidenceHash(text) });
  return { text, status: verified && contractMatches && saved?.required && review.allowCompletion ? 'completed' : 'partial' };
}
