# Exact memory writes and reconciliation

This document covers the memory storage domain. Its receipts establish a committed write identity or a snapshot of persistence. They do not establish user authorization, mathematical correctness, or completion of an entire chat request.

The existing `create`, memory search, correction, deletion, and assistant `save` contracts retain their behavior. No new HTTP route is introduced by this API.

## Additive control API

`createMemoryControl(db)` exposes:

```ts
type MemoryExactWriteInput = {
  operationKey: string; // exactly 64 lowercase hexadecimal characters
  payload: string;
  payloadHash: string; // SHA-256 of the exact UTF-8 payload bytes
};
type MemoryExactReconcileInput = Pick<MemoryExactWriteInput, 'operationKey' | 'payloadHash'>;
interface MemoryExactWriteOptions {
  signal?: AbortSignal;
  fence?: (tx: Kysely<any>) => Promise<void>;
}
interface ExactMemoryControl {
  writeExact(ownerId: string, input: unknown, options?: MemoryExactWriteOptions):
    Promise<{ created: boolean; receipt: MemoryExactWriteReceipt }>;
  reconcileExact(ownerId: string, input: unknown, options?: { signal?: AbortSignal }):
    Promise<MemoryExactReconciliation>;
}
```

The exported schemas and types live in `packages/memory/src/exact-write.ts`. `exactMemoryPayloadHash` computes the byte hash without trimming or Unicode normalization.

Payloads must be nonempty, at most 4,000 UTF-16 code units, already trimmed, free of NUL, and well-formed UTF-8 text. Existing credential rejection applies. Invalid input and a dishonest payload hash are rejected before mutation. Visually equivalent strings with different Unicode bytes remain different payloads.

The new write stores exactly the payload as semantic memory, with the neutral title `Saved result`. It does not append the original request. Existing semantic expiry and the 2,000-item owner limit apply. Provenance remains an explicit manual assertion; persistence does not upgrade the fact's trust classification.

## Atomic write identity

The write transaction:

1. Locks the existing owner row and runs the trusted fence.
2. Looks up `(owner_id, operation_key)`.
3. Returns the original identity for an equal payload, or rejects a conflicting payload.
4. For a new operation, inserts its manual evidence, memory item, provenance link, and operation receipt atomically.
5. Checks cancellation and the fence again immediately before returning to commit.

The fence receives the same transaction as the memory writes. A chat caller must check its current owner/run/lease there; it must not invoke an outer database transaction or an external `assertActive` closure. Those can deadlock embedded storage. Wall-clock lease expiry checks must account for PostgreSQL's transaction-frozen `CURRENT_TIMESTAMP`; the integrating controller owns that policy.

Fence rejection or cancellation before commit rolls all inserts back. The domain performs no compensating deletion after commit. `writeExact` performs no post-commit provenance lookup and makes no present-availability claim.

`memory_exact_operations` is added by migration `memory_exact_writes_v1`, after the existing base migration. It stores the owner/key, payload hash and byte count, item/root/version identity, original evidence ID, and timestamps. It stores no second payload copy. There is deliberately no foreign key to the item or evidence: deleting a note preserves the operation tombstone and cannot make the same key create it again.

## Read-only verification

Reconciliation begins its transaction with:

```sql
SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY
```

This explicit statement is required because the installed Kysely PGlite driver does not apply transaction-builder isolation/access settings.

The readback checks the owner-scoped operation, exact item/root/version/layer/timestamps, active and unexpired item, canonical content bytes and hash, and its original active owner-scoped manual evidence and provenance link. Evidence identity, source key, content hash, relation, and expiry must match. Expiry is checked again at the final observation time after the provenance query.

Results are:

| Status | Meaning |
| --- | --- |
| `missing` | No matching operation exists in this read snapshot. |
| `unavailable` | The operation exists, but its item or evidence cannot satisfy verification. Only reason and receipt metadata are returned; content is omitted. |
| `verified` | The exact item was available in this snapshot, with `scope: 'memory_persistence_only'`, the item, receipt, and `observedAt`. |

A later correction, revocation, deletion, or expiry can invalidate availability. Reconciliation never repairs an item, follows a replacement version, recreates content, or synchronizes other memory.

## Recovery and integration boundary

The host must persist its operation key before dispatch. If a write or subsequent provenance query has an uncertain outcome, reconcile by that key read-only. Do not automatically repeat the create operation or mint a replacement key. A missing snapshot alone does not establish that a concurrent or uncertain commit can never complete.

The calculate-and-remember controller separately verifies the calculation from the same current request, binds the exact saved payload to that result, enforces access/quota/redaction rules, and validates the persistence readback. Its durable attempted checkpoint and same-transaction run/account/lease fence precede the write. A model's note, proposed value, tool success string, or wording-intent assessment supplies none of those proofs. See [the current brain architecture](BRAIN-CURRENT-ARCHITECTURE.md).

The natural-language saved-result status request creates a separate read-only run. It reloads the original calculation receipt and checks the original operation key; it does not copy the earlier write authority or create a replacement operation. Deleted, revoked, expired, missing, or uncertain memory is never recreated by this verification. Its answer reports availability without echoing the old payload.

## Validation

`packages/memory/src/exact-write.test.ts` covers actual isolated PGlite writes, concurrent idempotency, conflicts, ownership, byte boundaries, tombstones, correction/revocation/expiry, damaged provenance, uncertain post-commit readback recovery, same-transaction fences, cancellation, and final-read expiry. A substituted data-modifying CTE is rejected by the database's read-only transaction with SQLSTATE `25006`. The existing memory lifecycle suite also passes. No production database is used by these fixtures.
