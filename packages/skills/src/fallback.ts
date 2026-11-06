import { z } from 'zod';
import { SkillToolIdSchema, type SkillContract, type SkillStep } from '@mohassan/contracts';

export const MAX_SKILL_RETRY_DELAY_MS = 24 * 60 * 60 * 1000;
export const SkillFailureProofSchema = z.object({
  source: z.enum(['pre_dispatch', 'provider_rejection', 'adapter']), effect: z.enum(['none', 'unknown']), retryable: z.boolean(), errorCode: z.string().min(1).max(100),
  tool: SkillToolIdSchema.optional(), httpStatus: z.number().int().min(100).max(599).optional(),
  retryAfterMs: z.number().finite().nonnegative().refine(Number.isSafeInteger).optional(), retryAfterInvalid: z.boolean().optional(),
  usage: z.object({ inputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), outputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict().optional(),
}).strict();
export type SkillFailureProof = z.infer<typeof SkillFailureProofSchema>;
export type SkillRecoveryDecision =
  | { action: 'verify_only'; reason: 'confirmed_receipt' }
  | { action: 'retry'; attempt: number; notBefore: Date; reason: 'confirmed_no_effect' }
  | { action: 'stop'; status: 'failed' | 'unknown'; reason: string };

/** Durable retry eligibility only. Runtime still requires a fresh child approval. */
export function decideRecovery(input: {
  contract: Pick<SkillContract, 'idempotent' | 'retry'>; step: Pick<SkillStep, 'kind' | 'tool'>; attempt: number;
  receipt: { status: string; finishedAt: Date | string | null; details: unknown } | null;
}): SkillRecoveryDecision {
  const stop = (reason: string, status: 'failed' | 'unknown' = 'failed'): SkillRecoveryDecision => ({ action: 'stop', status, reason });
  const receipt = input.receipt;
  if (!receipt || ['started', 'unknown'].includes(receipt.status)) return stop('effect_unknown', 'unknown');
  if (receipt.status === 'succeeded') return { action: 'verify_only', reason: 'confirmed_receipt' };
  if (receipt.status !== 'failed') return stop('receipt_invalid', 'unknown');
  if (!input.contract.idempotent) return stop('not_idempotent');
  const maximum = Math.min(3, input.contract.retry.maxAttempts);
  if (!Number.isInteger(input.attempt) || input.attempt < 1 || input.attempt >= maximum) return stop('attempt_limit');
  if (!Array.isArray(receipt.details) || receipt.details.length > 32) return stop('proof_missing');
  const entries = receipt.details.filter(entry => entry && typeof entry === 'object' && entry.kind === 'gateway.failure');
  if (entries.length !== 1) return stop('proof_ambiguous');
  const parsed = SkillFailureProofSchema.safeParse(entries[0].data);
  if (!parsed.success) return stop('proof_invalid');
  const proof = parsed.data;
  if (proof.effect !== 'none') return stop('effect_unknown', 'unknown');
  if (!proof.retryable || proof.retryAfterInvalid) return stop('failure_not_retryable');
  const provider = proof.source === 'provider_rejection' && (input.step.kind === 'model' || input.step.tool === 'vision.inspect')
    && (proof.errorCode === 'RATE_LIMITED' && proof.httpStatus === 429 || proof.errorCode === 'UPSTREAM_ERROR' && proof.httpStatus === 503)
    && proof.usage?.inputTokens === 0 && proof.usage.outputTokens === 0;
  const adapter = proof.source === 'adapter' && input.step.kind === 'tool' && input.step.tool === 'file.read' && proof.tool === 'file.read'
    && ['EBUSY', 'EAGAIN', 'ETIMEDOUT'].includes(proof.errorCode);
  if (!provider && !adapter) return stop('proof_not_safe');
  const delay = Math.max(1000 * 2 ** (input.attempt - 1), proof.retryAfterMs ?? 0);
  if (delay > MAX_SKILL_RETRY_DELAY_MS) return stop('retry_horizon_exceeded');
  const finishedAt = receipt.finishedAt === null ? NaN : new Date(receipt.finishedAt).getTime();
  if (!Number.isSafeInteger(finishedAt) || !Number.isSafeInteger(finishedAt + delay)) return stop('retry_time_invalid');
  const notBefore = new Date(finishedAt + delay);
  if (!Number.isFinite(notBefore.getTime())) return stop('retry_time_invalid');
  return { action: 'retry', attempt: input.attempt + 1, notBefore, reason: 'confirmed_no_effect' };
}
