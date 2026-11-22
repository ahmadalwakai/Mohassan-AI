import { createHash } from 'node:crypto';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { MemoryItem } from './contracts.ts';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const MemoryExactOwnerSchema = z.string().min(1).max(160).refine(value => value.trim() === value);
export const MemoryExactPayloadSchema = z.string().min(1).max(4000).refine(value =>
  value.trim() === value && !value.includes('\0') && Buffer.from(value, 'utf8').toString('utf8') === value,
{ message: 'Exact memory content must already be canonical, well-formed UTF-8 text.' });
/** No trimming or Unicode normalization: these are the bytes the host approved. */
export const exactMemoryPayloadHash = (payload: string): string => createHash('sha256').update(payload, 'utf8').digest('hex');
export const MemoryExactWriteInputSchema = z.object({ operationKey: digest, payload: MemoryExactPayloadSchema, payloadHash: digest }).strict();
export const MemoryExactReconcileInputSchema = z.object({ operationKey: digest, payloadHash: digest }).strict();
export type MemoryExactWriteInput = z.infer<typeof MemoryExactWriteInputSchema>;
export type MemoryExactReconcileInput = z.infer<typeof MemoryExactReconcileInputSchema>;

/** Commit identity only. It does not assert present availability or factual truth. */
export const MemoryExactWriteReceiptSchema = z.object({
  version: z.literal(1), ownerId: MemoryExactOwnerSchema, operationKey: digest,
  payloadHash: digest, payloadBytes: z.number().int().min(1).max(16000),
  itemId: z.uuid(), rootId: z.uuid(), itemVersion: z.number().int().positive(),
  evidenceId: z.uuid(), layer: z.literal('semantic'), createdAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
}).strict();
export type MemoryExactWriteReceipt = z.infer<typeof MemoryExactWriteReceiptSchema>;
export interface MemoryExactWriteOptions {
  signal?: AbortSignal;
  /**
   * Trusted host closure, run inside the SAME transaction before mutation and
   * immediately before commit. Query/lock the current lease using tx. Never call
   * an outer assertActive/db.transaction here: that can deadlock embedded storage.
   * A throw/abort rolls the transaction back; do not perform external effects.
   */
  fence?: (tx: Kysely<any>) => Promise<void>;
}
export interface MemoryExactWriteResult { created: boolean; receipt: MemoryExactWriteReceipt }
export type MemoryExactUnavailableReason = 'item_missing' | 'item_inactive' | 'item_expired'
  | 'identity_mismatch' | 'payload_mismatch' | 'provenance_unavailable';
export type MemoryExactReconciliation = { status: 'missing' }
  | { status: 'unavailable'; reason: MemoryExactUnavailableReason; receipt: MemoryExactWriteReceipt }
  | { status: 'verified'; scope: 'memory_persistence_only'; receipt: MemoryExactWriteReceipt; item: MemoryItem; observedAt: string };
