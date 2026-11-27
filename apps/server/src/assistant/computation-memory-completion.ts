import { createComputationMemoryReceipt, restoreComputationMemoryReceipt, type ComputationMemoryBinding } from './computation-memory-receipt.js';
import { validateComputationMemoryReadback, type ComputationMemoryFlowResult } from './computation-memory-flow.js';
import { createChatSupervisor } from './chat-supervision.js';
import { replyConstraintsFor } from './reply-turn.js';
import { observeTaskStep, reviewTaskCompletion, taskEvidenceHash, type TaskObservation, type TaskSupervisorState } from './task-supervisor.js';

/** Compose only host-derived math plus fixed persistence wording, never provider prose. */
export function completeComputationMemory(supervision: TaskSupervisorState, input: {
  request: string; binding: ComputationMemoryBinding; result: ComputationMemoryFlowResult; startedAt: number; now?: number;
}): { text: string; status: 'completed' | 'partial' | 'blocked' } {
  const lang = replyConstraintsFor()?.lang;
  const now = input.now ?? Date.now(), ar = lang ? lang === 'ar' : /[\u0600-\u06ff]/u.test(input.request);
  const receipt = createComputationMemoryReceipt(input.request, input.binding);
  if (!receipt) return { status: 'blocked', text: ar ? 'لم أتحقق من حساب مكتمل صالح للحفظ.' : 'I could not verify a complete calculation suitable for saving.' };
  const supplied = restoreComputationMemoryReceipt(input.result.receipt, input.request, input.binding);
  const state = input.result.state;
  const readback = supplied && input.result.scope === 'calculation_memory_persistence_only' && input.result.status === 'verified'
    && input.result.persistence === 'verified' && input.result.answer === receipt.answer && state?.phase === 'verified'
    ? validateComputationMemoryReadback(input.result.readback, receipt, state, input.startedAt, now) : null;
  const verified = readback?.status === 'verified';
  const persistence = verified ? 'verified' : input.result.persistence === 'verified' ? 'unknown' : input.result.persistence;
  const notes = ar ? {
    verified: 'حفظت النتيجة المتحقَّق منها في ذاكرتك.',
    not_attempted: 'ما زال حفظ النتيجة في الذاكرة معلقًا؛ لم أحاول الكتابة.',
    unknown: 'لم أستطع تأكيد حفظ النتيجة في الذاكرة. لم أكرر محاولة الكتابة.',
    missing: 'لم تجد القراءة المستقلة نتيجة محفوظة لهذه العملية. لم أكرر محاولة الكتابة.',
    unavailable: 'لم أتحقق من نتيجة محفوظة فعّالة. لم أعد إنشاء السجل أو أكرر الكتابة.',
  } : {
    verified: 'Saved the verified result in your memory.',
    not_attempted: 'Saving the result in memory is still pending; no write was attempted.',
    unknown: 'I could not confirm that the result was saved in memory. I did not repeat the write.',
    missing: 'Read-only verification found no saved result for this operation. I did not repeat the write.',
    unavailable: 'I could not verify an active saved result. I did not recreate the record or repeat the write.',
  };
  // A requested scalar-only answer stays scalar-only on verified completion.
  // An unresolved effect must remain explicit even when a short answer was asked for.
  const text = verified && receipt.answer === receipt.value ? receipt.answer : `${receipt.answer}\n${notes[persistence]}`;
  const observations: TaskObservation[] = [];
  const expectedContract = createChatSupervisor(input.binding.runId, input.request, undefined, now, input.binding).contract;
  const contractMatches = supervision.contract.id === input.binding.runId && supervision.contract.hash === expectedContract.hash;
  const computed = supervision.contract.criteria.find(item => item.id === 'computed-answer' && item.kind === 'answer_evidence');
  const saved = supervision.contract.criteria.find(item => item.id === 'computed-memory-save' && item.kind === 'effect');
  const startedAt = Math.max(supervision.startedAt, input.startedAt);
  if (contractMatches && computed?.required) observations.push({ criterionId: computed.id, kind: 'answer_evidence', source: 'computation', target: computed.target,
    reference: `computation:${receipt.evidenceHash}`, observedAt: now, answerHash: taskEvidenceHash(text), independentlyVerified: true, outcome: 'confirmed' });
  if (contractMatches && saved?.required && saved.kind === 'effect' && saved.target === `memory:result:${receipt.operationKey}` && saved.expectationHash === receipt.payload.hash) observations.push({
    criterionId: saved.id, kind: 'effect', source: 'authoritative-readback', target: saved.target,
    reference: verified ? `memory:${readback.receipt.itemId}:${readback.receipt.itemVersion}` : `operation:${receipt.operationKey}`,
    actionRef: receipt.operationKey, observedAt: verified ? Date.parse(readback.observedAt) : now,
    expectationHash: receipt.payload.hash, independentlyVerified: verified, outcome: verified ? 'confirmed' : 'unknown',
  });
  observeTaskStep(supervision, { stepId: `${supervision.contract.id}:${supervision.lastSequence + 1}`, sequence: supervision.lastSequence + 1,
    tool: 'calculation_memory_readback', startedAt, finishedAt: now, result: verified ? 'succeeded' : 'unknown',
    resultHash: taskEvidenceHash(JSON.stringify([receipt.evidenceHash, persistence, verified ? readback.receipt : null])), observations,
  });
  const review = reviewTaskCompletion(supervision, { now, answerHash: taskEvidenceHash(text) });
  return { text, status: verified && contractMatches && computed?.required && saved?.required && review.allowCompletion ? 'completed' : 'partial' };
}
