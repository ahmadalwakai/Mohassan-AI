# Model lifecycle and verified experience boundary

## Status

- **IMPLEMENTED:** `src/lifecycle.ts` contains metadata validation, complete promotion-gate coordination, explicit activation and rollback coordination, active-selection revalidation, serializable storage/approval contracts, and atomic audit requirements.
- **IMPLEMENTED:** `src/memory.ts` contains independent evidence resolution, task/workspace/subject binding, privacy and permission coordination, minimal allowlisted experience serialization, and idempotent storage contracts.
- **ADAPTER_REQUIRED:** Registry/evaluation translators, transactional lifecycle storage, an existing approval-authority bridge, independent evidence resolution, privacy policy, permission lease and memory store.
- **INTEGRATION_PENDING:** All calls into production Runtime, Chat, model selection, memory and learning. These modules import no other phase and do not modify production settings.
- **VERIFICATION_PENDING:** Compilation, automated tests, concurrency checks, real registry round trips, approval revocation races, privacy-policy checks and integration behavior. None was run in this phase.

## Existing repository evidence

Read-only inspection on 2026-11-12 found these actual symbols. Concurrent phases can still change their contracts.

| Path | Actual symbols and relevant behavior |
| --- | --- |
| `packages/execution-training/execution_training/registry.py` | `REGISTRY_SCHEMA_VERSION = "execution-model-version-v1"`; `ModelVersionManifest`, `EvaluationAttestation`, `ModelVersionRegistry.register`, `.record_evaluation`, `.inspect`. Registration binds architecture, tokenizer, dataset and training configuration to a checkpoint receipt and hash. Random-initialization provenance is required. Evaluation receipts are immutable and leave `promotion_status` as `unpromoted`. `.inspect` returns `eligible_for_promotion_review`, not activation authority. |
| `packages/execution-training/execution_training/checkpoints.py` | `CHECKPOINT_SCHEMA_VERSION = "execution-checkpoint-v1"`; `CheckpointReference`, `CheckpointManager.save`, `.load`. Checkpoints have receipt hashes and compatibility identities; load requires explicit trust, bounded size, exact expected compatibility and restricted `torch.load(weights_only=True)`. Phase 5 does not load a checkpoint. |
| `packages/execution-training/execution_training/activation.py` | `configure_activation_checkpointing` controls training recomputation through an injected model hook. Despite its filename, this is not model-version activation or promotion. |
| `packages/execution-training/execution_training/schemas.py` | `DATASET_SCHEMA_VERSION`, `TrainingExample`, `VerificationReference`, `Provenance`, `UsageAuthorization`, `RepairEvidence`. These Python training schemas are not Phase 5 memory schemas. |
| `packages/execution-evaluation/docs/data-and-baselines.md` | Documents independent dataset provenance, held-out isolation, pinned manifests and adapters. |
| `packages/execution-evaluation/execution_evaluation/schemas.py` | `TASK_SCHEMA_VERSION = "execution-evaluation-task-v1"`, `REPORT_SCHEMA_VERSION = "execution-evaluation-report-v1"`, `ExecutionBudget`, `EvaluationTask`, `CandidateOutput`, `ExecutionRequest`, `TaskResult`. These appeared during concurrent inspection. No completed promotion-gate API was available at this read; Python-to-TypeScript behavior and identity mappings remain unverified. |
| `packages/execution-evaluation/execution_evaluation/safety.py` | `SafetyContext`, `SafetyResult`, `SafetyScenario`, `evaluate_candidate_safety`, `safety_coverage`; these are individual evaluation components, not complete promotion approval. |
| `packages/execution-evaluation/execution_evaluation/metrics.py` | `summarize_results`, `aggregate_results`, `rate`; aggregate evaluation evidence without changing production selection. |
| `packages/memory/src/index.ts` | `createMemoryControl`, `MemoryError`; the returned control has `create`, `correct`, `revoke`, `remove`, `sync`, `search`, `context`, `feedback`, skill lifecycle operations and metrics. Internal `checked`, `evidence`, and `taskEvidence` enforce secret rejection, owner-scoped evidence and task ownership. `activateSkill` requires an explicitly approved benchmarked version and matching independent evaluation. Those are checklist-skill semantics, not execution-model activation. |
| `packages/memory/src/contracts.ts` | `MemoryCreateSchema`, `MemoryCorrectionSchema`, `MemoryMutationSchema`, `MemoryProvenanceSchema`, `MemoryItemSchema`, `SkillActivationSchema`, `SkillEvaluationSchema`. Existing memory uses versioned owner-scoped records and provenance; Phase 5 does not assume its new record shape can be written directly. |
| `packages/learning/src/experience.ts` | `ExperienceInput`, `ExperienceExpectation`, `ExperienceObservation`, `classifyExperience`, `recordExperience`, `recordExperienceFeedback`. `classifyExperience` requires trusted expected and observed evidence; it returns `verified_success`, `verified_failure`, or `unverified`. `recordExperience` redacts text and hashes observations but accepts a different identity and payload format. |
| `packages/learning/src/training.ts` | `auditTrainingReadiness`, `prepareRoutingTrainingDataset`, `ROUTING_TRAINING_DATASET_VERSION = 'verified-category-routing-v1'`, `TRAINING_MINIMUM_UNIQUE_EXPERIENCES`, `ROUTING_TRAINING_EXPORT_LIMIT`. This is a distinct routing-data pipeline, not authorization to train on Phase 5 experience or a mechanism for online weight changes. |
| `packages/learning/src/lessons.ts` | `cleanLearningText`, `LearningContentEvaluator`, `assessLearningComparison`, `evaluateLearningSubject`, `requireLearningEvaluation`, `createLessonControl`. Lesson acceptance has independent evidence; it does not supply a complete execution-model promotion evaluation. |

## Lifecycle contracts

The local boundary version is `execution-integration-lifecycle/v1`. It deliberately differs from Python registry schemas. The translator must retain exact content hashes and check producer schema versions; a field rename alone cannot establish compatibility. Hash existing bytes using a documented canonicalization rule instead of assuming Python and JavaScript JSON representations are identical.

`RegisteredModelVersion` contains scope/version/revision, model/tokenizer/checkpoint IDs and SHA-256 values, registered/revoked status, capabilities, random-initialization attestation and provenance references. Phase 3 remains the registration owner. Phase 5 only reads this metadata through `ModelLifecycleTransaction.readVersion`.

`IndependentModelEvaluation` contains the same identity tuple, evaluation ID/revision, trusted authority, report hash, time window, revocation status and all required gate results. The required gates are structural, behavioral, regression, permission boundary, workspace consistency, expected output, held-out evaluation, contamination and resource limits. Every gate must pass with evidence references. A Phase 3 `EvaluationAttestation.passed`, lower training loss or a model-written `verified` flag is insufficient.

`ModelLifecycleCoordinator.assessEligibility(scopeId, versionId, evaluationId, signal)` returns eligible/ineligible/unavailable with fixed diagnostic codes, a pinned reference and the evaluation deadline. It does not mutate state. `selectActive(scopeId, signal)` returns `ActiveModelReference` only when the already-active reference still matches live registry/evaluation revisions and all eligibility checks. Both read-only operations check the deadline again after the awaited transaction returns. Missing, revoked, expired or changed evidence blocks selection. The caller must still enforce transport identity pins and capability checks immediately before inference; selection does not grant tool permissions.

`activate(input, signal)` and `rollback(input, signal)` require explicit `approvalId`, expected state revision, correlation ID, exact target version and evaluation. The approval must bind action, scope, current active reference, target and expected revision. Models cannot approve themselves. Rollback additionally requires that the target match the stored rollback reference. Both operations preserve the displaced active reference as `previous` and `rollbackTarget`.

The injected `ModelLifecycleStore.transaction` must provide serializable reads and writes. `ModelActivationApprovalAdapter.authorizeAndConsume` receives the storage-owned transaction context and must consume the existing approval in that same transaction. After the awaited approval call, the coordinator rereads eligibility and requires the same identity, revisions and evaluation deadline. Compare-and-set, approval consumption and the `model_promotion`/`rollback` audit append must commit together. Failure or cancellation rolls everything back. Revocation must be fenced through commit.

`compareAndSetState(expectedRevision, next, constraints)` receives required `LifecycleCommitConstraints`: the exact target and scope, evaluation deadline, approval deadline and approval identity. The adapter must register these constraints and atomically recheck them against its authoritative storage clock at COMMIT, after audit insertion. An earlier check at CAS alone is insufficient. The coordinator also checks both deadlines immediately before CAS, after CAS and after the audit await. Expiry at any stage rolls back state, approval consumption and audit together. A standalone HTTP approval query followed by an unrelated database transaction does not satisfy this interface and must remain unavailable.

Stored model references are normalized by copying only declared identity and revision fields. Unknown adapter properties are never spread into approval requests, lifecycle audit events or returned state. Identity fields are opaque bounded references; their producers must not encode secrets or customer data in identifiers.

There is no fallback in-memory production registry, no automatic activation, no new database table, no executable inference startup and no update to Groq, FreeLLMAPI or Ollama settings. An adapter is responsible for adapting an integration-only active reference to future model selection after a separate approved integration change.

## Safe experience storage

The local schema is `execution-integration-experience/v1`. `ExperienceMemoryCoordinator.record(request, signal)` accepts only references and subject/task/workspace identity. The independent resolver must retrieve evidence from a trusted verifier-owned store. A caller or model cannot submit raw claims as a stored fact.

Accepted kinds are verified task outcome, independently verified failure, and independently confirmed recovery. Provenance must identify trusted authorities, exact evidence hashes, observation times, authorization references and an allowed classification. Evaluation-origin records, private-customer records, unknown authority, missing evidence and model self-verification are rejected. Recovery requires distinct verified failure and successful recovery evidence, their provenance and a confirmed strategy reference; observation order must be consistent.

The mandatory privacy policy sees both the request and the normalized evidence. It must assess all identifiers, provenance, metadata and hashes for secrets, privacy and evaluation contamination. Pattern checks alone are not a secret detector. The only retained context fields are task family, operation kinds, project language, architectural decision hashes and a context hash. The serializer copies each allowed field and drops unknown properties. It never stores raw goals, prompts, generated code, results, customer content or hidden answers. The policy may redact/replace permitted context and must provide a current privacy authorization reference and expiry.

The mandatory existing-permission bridge obtains a live `memory.write_verified_execution_experience` lease bound to owner scope, task, workspace, record key, stable `contentSha256` and attempt-specific `writeSha256`. The semantic content hash covers the verified task outcome, context and provenance; it excludes privacy policy/approval/expiry and correlation metadata. The full write hash covers that semantic content and the current privacy policy, approval reference, expiry and correlation ID. Thus a retry with refreshed privacy authorization retains the same record key and semantic hash while requiring fresh authority for its exact write payload.

`SafeExperienceStore.appendVerified` must atomically validate the full attempt hash, lease, privacy expiry and cancellation while inserting once. A matching semantic duplicate returns `already_stored` without overwriting the original record, even when the fresh write metadata differs. Different semantic content under an existing key is a conflict. Duplicate attempts still require a live permission lease and current privacy authorization. A missing privacy/evidence/storage adapter returns `memory_unavailable`; a missing permission adapter returns `permission_unavailable`; neither becomes approval.

Records include `trainingUse: 'forbidden'`. Writing experience does not authorize dataset export or modify weights. Any later training use needs separate rights review, evaluation exclusion, dataset versioning, an explicit training run, independent evaluation and approved lifecycle activation. The existing `recordExperience` and `createMemoryControl` APIs need a reviewed translator; their source types and persisted schemas are not assumed equivalent.

## Failure, cancellation and rollback limits

Public errors expose fixed codes without raw adapter exceptions. Callers provide `AbortSignal`; adapters must honor cancellation and prevent commits after it. Since this package does not implement the storage engine, transaction, lock and revocation semantics are mandatory adapter obligations that require later verification. No claim of distributed atomicity is made merely from TypeScript interfaces.

Rollback changes only the injected integration lifecycle reference. It does not undo previously executed tool actions, filesystem writes or external API mutations. Those require separate evidence-based reconciliation. A previous version with revoked or expired evaluation is not a valid rollback target; obtain a fresh independently authorized version rather than bypassing gates. Existing in-flight tasks retain their pinned identity, and any future rollout policy must explicitly handle their cancellation or completion.

## Final adapter sequence

1. Pin the finished Phase 3 and Phase 4 schema versions and agree exact identity/hash mappings, including tokenizer content and the model architecture digest.
2. Implement read-only registry and independent evaluation translators. Preserve missing gates as unavailable; do not derive them from a single pass boolean.
3. Implement a compatible lifecycle storage/approval transaction and its audit sink without changing production model settings.
4. Implement independent evidence resolution, whole-record privacy assessment, live memory permission leases and the existing-memory translator.
5. After the shared integration window is authorized, verify type compatibility, duplicate activation handling, approval consumption rollback, stale evidence, cancellation, revocation races, privacy rejection and memory idempotency.
6. Only after those checks, explicitly approve an eligible model version and separately wire the execution adapter. None of these shared-file integration changes is part of this isolated phase.
