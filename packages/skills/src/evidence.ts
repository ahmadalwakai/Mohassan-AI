import { createHash } from 'node:crypto';
import type { Kysely } from 'kysely';
import { isBoundedSkillJson, type SkillContract, type SkillNodeBinding, type SkillStep } from '@mohassan/contracts';
import { SkillError } from './errors.ts';

/** JSONB key ordering cannot change a pinned request or output hash. */
export function canonicalSkillJson(value: unknown): string {
  if (!isBoundedSkillJson(value)) throw new SkillError('SKILL_DATA_INVALID', 'بيانات المهارة تتجاوز حدود JSON الآمنة.');
  const normalize = (item: any): any => Array.isArray(item) ? item.map(normalize) : item && typeof item === 'object'
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, normalize(item[key])])) : item;
  return JSON.stringify(normalize(value));
}
export const hashSkillData = (value: unknown): string => createHash('sha256').update(canonicalSkillJson(value)).digest('hex');

/** Evidence combines already-bounded input/output and accounting; it is never an execution input. */
export function canonicalSkillEvidenceJson(value: unknown): string {
  let nodes = 0;
  const normalize = (item: unknown, depth: number): unknown => {
    if (++nodes > 32768 || depth > 12) throw new SkillError('SKILL_EVIDENCE_LIMIT', 'تجاوز الدليل حدود البيانات.');
    if (item === null || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item === 'string' && item.length <= 131072) return item;
    if (Array.isArray(item) && item.length <= 4096) return item.map(child => normalize(child, depth + 1));
    if (item && typeof item === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(item))) {
      const keys = Object.keys(item).sort();
      if (keys.length > 4096 || keys.some(key => key.length > 100 || ['__proto__', 'constructor', 'prototype'].includes(key))) throw new SkillError('SKILL_EVIDENCE_INVALID', 'مفاتيح الدليل غير صالحة.');
      return Object.fromEntries(keys.map(key => [key, normalize((item as Record<string, unknown>)[key], depth + 1)]));
    }
    throw new SkillError('SKILL_EVIDENCE_INVALID', 'الدليل ليس JSON صالحًا.');
  };
  const text = JSON.stringify(normalize(value, 0));
  if (Buffer.byteLength(text, 'utf8') > 1048576) throw new SkillError('SKILL_EVIDENCE_LIMIT', 'تجاوز الدليل الحجم المسموح.');
  return text;
}

export interface SkillNodeClaim {
  binding: SkillNodeBinding;
  ownerId: string;
  taskId: string;
  leaseToken: string;
  nodeLeaseToken: string;
  workflowToken: string;
  evidenceId: string;
  idempotencyKey: string;
  contract: SkillContract;
  step: SkillStep;
  inputs: Record<string, unknown>;
  outputSchema: SkillContract['outputs'];
}
export interface SkillNodeResult { evidenceId: string; runId: string; nodeId: string; inputsHash: string; outputHash: string; output: Record<string, unknown> }
export interface SkillNodePreimage { root: string; path: string; before: string | null; beforeHash: string | null; afterHash: string }
export interface SkillNodeOutcome { outcome: 'succeeded' | 'failed' | 'unknown'; outputs?: Record<string, unknown>; errorCode?: string; evidence?: { kind: string; data: unknown }[] }

/** Late accounting can enrich its own receipt, but cannot authorize or repeat an effect. */
export async function appendSkillEvidence(db: Kysely<any>, claim: SkillNodeClaim, entry: { kind: string; data: unknown }): Promise<void> {
  if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(entry.kind)) throw new SkillError('SKILL_EVIDENCE_INVALID', 'نوع الدليل غير صالح.');
  canonicalSkillEvidenceJson(entry.data);
  await db.transaction().execute(async tx => {
    const receipt = await tx.selectFrom('skill_evidence').selectAll().where('id', '=', claim.evidenceId).where('owner_id', '=', claim.ownerId).where('task_id', '=', claim.taskId).where('lease_token', '=', claim.leaseToken).where('node_lease_token', '=', claim.nodeLeaseToken).forUpdate().executeTakeFirst();
    if (!receipt) throw new SkillError('SKILL_FENCE_LOST', 'لم يعد دليل التنفيذ تابعًا لهذه المحاولة.', 409);
    const details = typeof receipt.details === 'string' ? JSON.parse(receipt.details) : receipt.details;
    const next = [...details, entry];
    if (next.length > 32) throw new SkillError('SKILL_EVIDENCE_LIMIT', 'تجاوز عدد الأدلة الحد المسموح.');
    await tx.updateTable('skill_evidence').set({ details: canonicalSkillEvidenceJson(next) }).where('id', '=', claim.evidenceId).execute();
  });
}
