import { describe, expect, it } from 'vitest';
import { decideRecovery, MAX_SKILL_RETRY_DELAY_MS, type SkillFailureProof } from './fallback.ts';

const finishedAt = new Date('2026-11-05T12:00:00.000Z');
const proof: SkillFailureProof = { source: 'provider_rejection', effect: 'none', retryable: true, errorCode: 'RATE_LIMITED', httpStatus: 429, usage: { inputTokens: 0, outputTokens: 0 } };
const input = (patch: Partial<SkillFailureProof> = {}) => ({ contract: { idempotent: true, retry: { maxAttempts: 3 } }, step: { kind: 'model' as const }, attempt: 1,
  receipt: { status: 'failed', finishedAt, details: [{ kind: 'gateway.failure', data: { ...proof, ...patch } }] } });

describe('durable skill recovery policy', () => {
  it('requires only verification for a confirmed receipt, including non-idempotent operations', () => {
    expect(decideRecovery({ ...input(), contract: { idempotent: false, retry: { maxAttempts: 1 } }, receipt: { ...input().receipt, status: 'succeeded' } })).toEqual({ action: 'verify_only', reason: 'confirmed_receipt' });
  });
  it.each(['started', 'unknown'])('never replays a %s effect even with an otherwise safe-looking receipt', status => {
    expect(decideRecovery({ ...input(), receipt: { ...input().receipt, status } })).toMatchObject({ action: 'stop', status: 'unknown' });
  });
  it('preserves a long provider delay rather than applying the synchronous fallback cap', () => {
    expect(decideRecovery(input({ retryAfterMs: 600000 }))).toEqual({ action: 'retry', attempt: 2, notBefore: new Date('2026-11-05T12:10:00.000Z'), reason: 'confirmed_no_effect' });
  });
  it.each([429, 503])('accepts only aligned zero-usage provider rejection %s', httpStatus => {
    expect(decideRecovery(input({ httpStatus, errorCode: httpStatus === 429 ? 'RATE_LIMITED' : 'UPSTREAM_ERROR' }))).toMatchObject({ action: 'retry', attempt: 2 });
  });
  it.each([
    { usage: undefined }, { usage: { inputTokens: 1, outputTokens: 0 } }, { httpStatus: 503 }, { retryable: false },
    { retryAfterMs: -1 }, { retryAfterMs: NaN }, { retryAfterMs: Number.MAX_SAFE_INTEGER + 1 }, { retryAfterInvalid: true },
    { retryAfterMs: MAX_SKILL_RETRY_DELAY_MS + 1 }, { source: 'pre_dispatch' as const },
  ])('stops an unsafe or invalid retry proof %j', patch => { expect(decideRecovery(input(patch))).toMatchObject({ action: 'stop' }); });
  it('does not infer no effects for coding or browser tasks from zero model usage', () => {
    for (const tool of ['coding.change', 'browser.open', 'file.write'] as const) expect(decideRecovery({ ...input(), step: { kind: 'tool', tool } })).toMatchObject({ action: 'stop' });
    expect(decideRecovery({ ...input(), step: { kind: 'tool', tool: 'vision.inspect' } })).toMatchObject({ action: 'retry' });
  });
  it('allows only the trusted local file reader transient classification', () => {
    for (const errorCode of ['EBUSY', 'EAGAIN', 'ETIMEDOUT']) expect(decideRecovery({ ...input({ source: 'adapter', tool: 'file.read', errorCode }), step: { kind: 'tool', tool: 'file.read' } })).toMatchObject({ action: 'retry' });
    expect(decideRecovery({ ...input({ source: 'adapter', tool: 'file.read', errorCode: 'EACCES' }), step: { kind: 'tool', tool: 'file.read' } })).toMatchObject({ action: 'stop' });
  });
  it('requires idempotency, a remaining bounded attempt, and unambiguous evidence', () => {
    expect(decideRecovery({ ...input(), contract: { idempotent: false, retry: { maxAttempts: 3 } } })).toMatchObject({ action: 'stop', reason: 'not_idempotent' });
    expect(decideRecovery({ ...input(), attempt: 3 })).toMatchObject({ action: 'stop', reason: 'attempt_limit' });
    expect(decideRecovery({ ...input(), receipt: { ...input().receipt, details: [...input().receipt.details, ...input().receipt.details] } })).toMatchObject({ action: 'stop', reason: 'proof_ambiguous' });
    expect(decideRecovery({ ...input(), receipt: null })).toMatchObject({ action: 'stop', status: 'unknown' });
  });
});
