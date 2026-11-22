import { evaluateLocalRecall, type LocalRecallContext } from './local-recall.js';
import { memoryRecallFormat, verifyMemoryRecall } from './memory-recall.js';
import type { LocalReply } from './mind/limits.js';

export type MemoryRecallEvidenceReason = 'invalid_input' | 'unsupported_format' | 'invalid_answer' | 'unresolved_evidence' | 'answer_mismatch';
export type MemoryRecallEvidenceReview = {
  status: 'verified'; reason: 'matched'; answer: string; reply: LocalReply & { status: 'completed' };
} | {
  status: 'rejected' | 'partial'; reason: MemoryRecallEvidenceReason; reply?: LocalReply;
};
const MAX_EVIDENCE = 30, MAX_EVIDENCE_BYTES = 128 * 1024;
const wellFormed = (text: string) => !text.includes('\0') && Buffer.from(text, 'utf8').toString('utf8') === text;

/**
 * HOST-ONLY verification of one formatted private-recall proposal against the
 * SAME actual read's cached assertions. No new read, model call, memory write or
 * permission is provided. A model's literal substring is insufficient: the local
 * extractor must independently bind the requested fields/subjects and disclose
 * conflicting assertions before its canonical answer can match the proposal.
 *
 * This deliberately retains the local extractor's conservative coverage. Unknown
 * field aliases, unspecified JSON keys it cannot derive, and multiple fields in
 * one unsplittable leading sentence remain unresolved; there is no span-only
 * fallback or additional semantic atomization. Stored assertions are not truth.
 *
 * The host must record successful evidence at the actual memory read's time,
 * not the later model/verification time, and check its current execution fence.
 */
export async function reviewMemoryRecallEvidence(request: unknown, proposed: unknown, evidence: readonly string[],
    signal: AbortSignal, context?: LocalRecallContext): Promise<MemoryRecallEvidenceReview> {
  signal.throwIfAborted();
  const reject = (reason: MemoryRecallEvidenceReason): MemoryRecallEvidenceReview => ({ status: 'rejected', reason });
  if (typeof request !== 'string' || !request.trim() || request.length > 4000 || !wellFormed(request)
      || typeof proposed !== 'string' || proposed.length > 4096 || !wellFormed(proposed)) return reject('invalid_input');
  if (!Array.isArray(evidence) || evidence.length > MAX_EVIDENCE || Object.getPrototypeOf(evidence) !== Array.prototype)
    return reject('invalid_input');
  if (context !== undefined && (!context || context.intent !== 'memory' || typeof context.topic !== 'string'
      || context.topic.length > 600 || !wellFormed(context.topic))) return reject('invalid_input');
  const cached: string[] = [];
  let bytes = 0;
  for (let index = 0; index < evidence.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(evidence, String(index));
    if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'string' || !descriptor.value.trim()
        || descriptor.value.length > 4000 || !wellFormed(descriptor.value)) return reject('invalid_input');
    bytes += Buffer.byteLength(descriptor.value, 'utf8');
    if (bytes > MAX_EVIDENCE_BYTES) return reject('invalid_input');
    cached.push(descriptor.value);
  }
  const format = memoryRecallFormat(request);
  if (!format) return reject('unsupported_format');
  const canonical = verifyMemoryRecall(proposed, format, cached);
  if (canonical === null) return reject('invalid_answer');
  const boundContext = context ? { intent: 'memory' as const, topic: context.topic } : undefined;
  const host = await evaluateLocalRecall(request, { async memory() { signal.throwIfAborted(); return [...cached]; } }, signal, boundContext);
  signal.throwIfAborted();
  if (!host || host.status !== 'completed') return { status: 'partial', reason: 'unresolved_evidence', ...(host ? { reply: structuredClone(host) } : {}) };
  const expected = verifyMemoryRecall(host.text, format, host.evidence.map(item => item.quote));
  // Keep LocalReply text/claims/evidence exactly aligned for the supervision
  // adapter. Do not invent a new claim by reprinting arbitrary provider JSON.
  if (expected === null || expected !== host.text) return { status: 'partial', reason: 'unresolved_evidence' };
  if (canonical !== expected) return reject('answer_mismatch');
  return { status: 'verified', reason: 'matched', answer: expected,
    reply: structuredClone(host) as LocalReply & { status: 'completed' } };
}
