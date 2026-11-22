import { createHash } from 'node:crypto';
import { z } from 'zod';
import { evaluateLocalComputation, type LocalComputation } from './local-computation.js';
import { assessCompoundMemorySaveAuthorization } from './memory-save-authorization.js';

const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
// In Unicode mode a valid surrogate pair is one astral code point; this range
// therefore matches only lone surrogates, without requiring an ES2024 lib type.
const wellFormed = (value: string) => !/[\ud800-\udfff]/u.test(value);
const identity = z.string().min(1).max(160).refine(value => value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value));
const instant = z.number().int().min(0).max(8_640_000_000_000_000);
const exactText = z.string().min(1).max(4000).refine(value => value.trim() === value && wellFormed(value) && !value.includes('\0'));

const BindingSchema = z.object({
  ownerId: identity, conversationId: identity, runId: identity,
  /** Trusted DB time of the run or the exact host-accepted clarification message, never model/state notes. */
  evaluatedAt: instant,
}).strict();
export type ComputationMemoryBinding = z.infer<typeof BindingSchema>;

const ReceiptSchema = BindingSchema.extend({
  version: z.literal(1), kind: z.literal('computation_memory_payload'), engine: z.literal('local-computation-v1'),
  requestHash: digest,
  primary: z.object({ start: z.number().int().min(0).max(4000), end: z.number().int().min(1).max(4000), hash: digest }).strict(),
  /** Exact independently computed explanatory quote, including operands and units when supplied. */
  payload: z.object({ text: exactText, hash: digest, bytes: z.number().int().min(1).max(16_000) }).strict(),
  answer: exactText, value: exactText, evidenceHash: digest, operationKey: digest,
}).strict();
export type ComputationMemoryReceipt = z.infer<typeof ReceiptSchema>;

/**
 * Pure host derivation: original CURRENT USER request plus trusted run identity/time.
 * No supplied calculation, model output, notes or stored receipt is an input.
 *
 * This does not dispatch or authorize memory by itself. Account/tool availability,
 * exact-write adapter, quota, redaction, cancellation/lease fences and authoritative
 * readback remain mandatory. It certifies only this local calculation's scope;
 * no neural/semantic correctness or general goal-completion claim is implied.
 */
export function createComputationMemoryReceipt(request: unknown, binding: ComputationMemoryBinding): ComputationMemoryReceipt | null {
  const parsed = BindingSchema.safeParse(binding);
  if (!parsed.success || typeof request !== 'string' || !request.trim() || request.length > 4000 || !wellFormed(request)) return null;
  const wording = assessCompoundMemorySaveAuthorization(request);
  if (!wording.allowed || !wording.primary || !wording.clause) return null;
  const { start, end } = wording.primary;
  if (start < 0 || end <= start || end > request.length || request.slice(start, end) !== wording.primary.text) return null;
  const computation = evaluateLocalComputation(wording.primary.text, new Date(parsed.data.evaluatedAt));
  if (!supported(computation)) return null;
  const evidence = computation.evidence[0];
  // Output formatting can be an outer clause after the save instruction. Its
  // display choice must not remove operands/units from the stored payload.
  const outer = evaluateLocalComputation(request, new Date(parsed.data.evaluatedAt));
  const answer = outer?.primaryText;
  if (outer?.status !== 'partial' || !answer || JSON.stringify(outer.evidence) !== JSON.stringify(computation.evidence)
      || outer.claims[0]?.text !== answer || (answer !== evidence.quote && answer !== evidence.value)) return null;
  const payloadText = evidence.quote;
  const requestHash = hash(request);
  const payloadHash = hash(payloadText);
  const evidenceHash = hash(JSON.stringify({ engine: 'local-computation-v1', kind: computation.consumption!.kind,
    answer, value: evidence.value, quote: payloadText }));
  const body = { ...parsed.data, version: 1 as const, kind: 'computation_memory_payload' as const,
    engine: 'local-computation-v1' as const, requestHash, primary: { start, end, hash: hash(wording.primary.text) },
    payload: { text: payloadText, hash: payloadHash, bytes: Buffer.byteLength(payloadText, 'utf8') },
    answer, value: evidence.value!, evidenceHash,
    operationKey: hash(JSON.stringify(['mohassan:calculation-memory:v1', parsed.data.ownerId, parsed.data.conversationId,
      parsed.data.runId, parsed.data.evaluatedAt, requestHash, payloadHash, evidenceHash])) };
  const checked = ReceiptSchema.safeParse(body);
  return checked.success ? checked.data : null;
}

function supported(value: LocalComputation | null): value is LocalComputation {
  if (!value || value.status !== 'completed' || !value.consumption?.complete || value.compound?.pendingActions.length
      || value.claims.length !== 1 || value.evidence.length !== 1) return false;
  const claim = value.claims[0], evidence = value.evidence[0];
  return evidence.source === 'computed' && exactText.safeParse(evidence.quote).success
    && exactText.safeParse(evidence.value).success && exactText.safeParse(value.text).success
    && claim.status === 'confirmed' && claim.text === value.text && claim.support.length === 1 && claim.support[0] === evidence.id
    && (claim.text === evidence.quote || claim.text === evidence.value);
}

/**
 * Restore by recalculating from the original request at the same TRUSTED timestamp.
 * Binding must come from the current owner/conversation/run DB row. A self-consistent
 * edited receipt, including recomputed hashes, cannot change the trusted operands,
 * time, payload or target. Unknown/legacy shapes fail closed and never imply a retry.
 */
export function restoreComputationMemoryReceipt(value: unknown, request: unknown, binding: ComputationMemoryBinding): ComputationMemoryReceipt | null {
  // Parse only bounded schema fields before serializing; never stringify an
  // arbitrary unknown object's potentially enormous or cyclic extra content.
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const parsed = ReceiptSchema.safeParse(value);
    if (!parsed.success) return null;
    const encoded = JSON.stringify(parsed.data);
    if (encoded.length > 20_000) return null;
    const expected = createComputationMemoryReceipt(request, binding);
    return expected && encoded === JSON.stringify(expected) ? expected : null;
  } catch { return null; }
}
