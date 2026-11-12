# Cross-phase integration contracts

This document records the producer/consumer obligations for the final integration. The TypeScript interfaces in this package are local adapter contracts, **not claims about existing exports in another phase**. There are no imports into unfinished Phase 1–4 modules. All concrete cross-phase bridges remain **ADAPTER_REQUIRED**, **INTEGRATION_PENDING**, and **VERIFICATION_PENDING** until their owners freeze schemas and an authorized compatibility review checks both types and behavior.

## Status vocabulary and ownership

- **IMPLEMENTED**: the isolated Phase 5 boundary or documentation exists in this directory. It does not mean a production route uses it.
- **ADAPTER_REQUIRED**: a trusted implementation must bind a local interface to a real producer and enforce its security guarantees.
- **INTEGRATION_PENDING**: composition, exported-schema mapping or shared-file work has not happened.
- **VERIFICATION_PENDING**: no build, typecheck, test, benchmark, training, inference or readiness probe established compatibility or safety on this host.

Ownership remains exclusive: Phase 1 owns `packages/cognitive/src/execution-model/`; Phase 2 owns `packages/execution-model/`; Phase 3 owns `packages/execution-training/`; Phase 4 owns `packages/execution-evaluation/`; Phase 5 owns `packages/execution-integration/`. Existing production package owners retain authority over Runtime, Tool Gateway, sandbox, permissions, memory, contracts, application composition and UI.

## Source snapshot of concurrently developed phases

On the initial 2026-11-12 read-only inspection, `packages/cognitive/src/execution-model/` was not present. Therefore no Phase 1 export name, accepted contract schema or router behavior was assumed.

Phase 2 files observed included:

| Actual file | Actual symbols / version facts | Compatibility caveat |
| --- | --- | --- |
| `execution_model/tokenizer.py` | `ByteBPETokenizer`; `identity`, `encode`, `decode`, `save`, `load`, `from_dict`, `train`, `train_files`; `VOCABULARY_TARGETS` | Tokenizer identity is an artifact-derived identity. No inference capability follows from vocabulary size. |
| `execution_model/metadata.py` | `ModelMetadata`; `ARCHITECTURE_ID = "dense-decoder-v1"`; fields include `weight_origin`, `training_status`, `config_identity`, `tokenizer_identity`, `initialization_seed`, `checkpoint_identity`, `independently_verified` | A model metadata boolean is not independent evaluation evidence. Phase 5 must obtain evaluation from the trusted Phase 4 adapter. |
| `execution_model/checkpoint.py` | `LoadedCheckpoint`, `load_checkpoint`; `CHECKPOINT_FORMAT = "mohassan-execution-checkpoint"`, `CHECKPOINT_VERSION = 1` | Checkpoint identity, format and tokenizer/config compatibility must be verified before inference. |
| `execution_model/generation.py` | `GenerationConfig`, `GenerationResult`, `GenerationEvent`, `generate`, `stream_generate` | Generation returns token counts and stop information, not authorization or task success. |

Phase 3 files observed included `execution_training/schemas.py` with `TrainingExample`, `VerificationReference`, `DataSource`, `Provenance`, `UsageAuthorization`, `RepairEvidence`, and `DATASET_SCHEMA_VERSION = "execution-example-v1"`; and `execution_training/checkpoints.py` with `CheckpointReference`, `CheckpointManager`, `CHECKPOINT_SCHEMA_VERSION = "execution-checkpoint-v1"`. This training checkpoint includes optimizer/scheduler/scaler/RNG/sampler/training state. It is **not established to be the Phase 2 inference checkpoint format**. A reviewed export/conversion step and identity binding are required. `execution_training/activation.py` exports `configure_activation_checkpointing`, which is a training memory optimization helper; its name does not mean it activates a production model.

At the initial Phase 4 inspection, `docs/verification-and-safety.md` and `docs/data-and-baselines.md` existed; no stable runtime export was assumed. The documents describe independent checks, controlled sandbox evidence and hidden-test separation. Documentation alone cannot supply an evaluation receipt or prove promotion eligibility. Later files may appear during concurrent development and must be inspected again during integration.

A later source recheck during this same implementation found the following additional producer interfaces. This updates file discovery, **not integration status**:

- Phase 2 `execution_model/inference.py` now defines `InferenceEngine.get_supported_capabilities`, `get_model_info`, `initialize_random`, `load_local_model`, `encode_task_input`, `generate_candidate`, and `stream_candidate`, plus `CandidateOutput`, `InferenceResponse`, and `InferenceEvent`. `CandidateOutput.output_bytes` contains Python bytes, and `InferenceResponse.to_dict()` intentionally does not convert them into a JSON wire representation. A reversible encoding and transport shim remain necessary. Its capability map explicitly reports `json_schema`, `tools`, `permissions`, `planning`, `verification`, and `network` as false. No stdio protocol server was identified in this snapshot.
- Phase 3 `execution_training/registry.py` now defines `ModelVersionManifest`, `EvaluationAttestation`, and `ModelVersionRegistry.register`, `record_evaluation`, and `inspect`, with `REGISTRY_SCHEMA_VERSION = "execution-model-version-v1"`. The manifest carries model/architecture/tokenizer/dataset/training/checkpoint/provenance/rollback references and starts with `evaluation_status = "not_evaluated"`, `promotion_status = "unpromoted"`. The registry exposes no promotion API. Its evaluation attestation binds model version, checkpoint hash, dataset manifest, evaluator, suite, completion time, independence and pass disposition; this still needs a trusted resolver rather than accepting a caller-supplied boolean.
- Phase 4 `execution_evaluation/schemas.py` now defines `EvaluationTask`, `ExecutionBudget`, `CandidateOutput`, `ExecutionRequest`, and `TaskResult`, reexported by `execution_evaluation/__init__.py`. `TASK_SCHEMA_VERSION = "execution-evaluation-task-v1"` and `REPORT_SCHEMA_VERSION = "execution-evaluation-report-v1"`. `EvaluationTask.public_view` provides a candidate-facing projection; `execution_evaluation/safety.py` defines `SafetyContext`, `SafetyResult`, `SafetyScenario`, `safe_relative_path`, `evaluate_candidate_safety`, and `safety_coverage`. These Python types are not directly assignable to Phase 5 TypeScript interfaces. No test or import execution verified them.

A final read-only check found Phase 1's directory and additional Phase 4 modules. The Phase 1 local `index.ts` reexports `schemas.ts`, `contract-validator.ts`, `compiler.ts`, `router.ts`, `adapter.ts`, and `result-validator.ts`; the production Cognitive entrypoint remains separate. The actual interfaces now include:

| Producer file | Observed symbol | Mapping still required |
| --- | --- | --- |
| Phase 1 `contract-validator.ts` | `ExecutionContractValidator.validate`, `SUPPORTED_EXECUTION_OPERATIONS` | Adapt its `{ok, task/result}` result to the Phase 5 `BoundaryResult` without reproducing its validation logic. |
| Phase 1 `router.ts` | `ExecutionStrategyRouter.route`, `ExecutionRoutingContextSchema`, `ExecutionRoutingDecision` | Supply actual capabilities/tools, consumed attempt count, learned capabilities and output token counter. A route can already include a deterministic candidate; preserve that result and avoid accidental duplicate compilation/attempt accounting. |
| Phase 1 `compiler.ts` | `DeterministicExecutionCompiler.supports`, `.compile`, `DeterministicCompilationOptions`, `DETERMINISTIC_EXECUTION_REGISTRY` | `compile` needs supervisor-owned `attemptsUsed`, a real output token counter and optional signal. The only observed deterministic operation is `structured.replace-file.v1`. |
| Phase 1 `adapter.ts` | `ExecutionModelAdapter.discoverCapabilities`, `.generateCandidate`, `ExecutionModelCallOptions`, `ExecutionModelSubmissionOptions`, `submitExecutionModelTask` | Invocation includes explicit timeout/deadline and reserved attempt. This candidate-only adapter differs from the Phase 5 transport/strategy seams; wire it deliberately and avoid nested retry loops. |
| Phase 1 `result-validator.ts` | `ExecutionResultValidator.validateStructure`, `ExecutionPermissionSnapshotSchema`, `ExecutionEligibilitySnapshotSchema`, `ExecutionSemanticVerifier` | Preserve structural checking and token accounting, then separately obtain actual current authority and independent semantic evidence. |
| Phase 4 `verification.py` | `verify_candidate`, `VerifiedSandboxAdapter`, `VerificationContext`, `VerificationRequest`, `IsolationAttestation`, `SandboxVerificationReceipt`, `VerificationResult` | Explicit Python-to-TypeScript mapping and authentic sandbox/evidence resolution remain required. |
| Phase 4 `acceptance.py` | `assess_promotion`, `AcceptanceEvidence`, `AcceptancePolicy`, `FamilyGate`, `EvidenceAuthority` | Preserve policy/suite/evidence authentication and complete gate semantics before mapping to Phase 5 eligibility. |

Observed incompatibilities are concrete: Phase 1's `ExecutionTaskContractSchema` uses `schemaVersion: "1"`, three task families and one existing TypeScript target file; its workspace is `{projectId, baseCommit, snapshotHash}`; its model identity is `{id, version, artifactHash, initialization: "random", locality: "local"}`. Its candidate has `kind: "candidate"`, `output` containing a replacement or TypeScript edit, `verification: "not_verified"`, and `executionAllowed: false`. Phase 5 uses its own supervisor envelope, model/tokenizer/checkpoint identity, versioned action candidate, canonical resource targets and permission/evidence bindings. Neither shape may be cast into the other. Tokenizer identity, checkpoint mapping, tool argument translation, workspace file versions, attempts and failure-code vocabulary need explicit reviewed conversions. The broader Phase 5 operation vocabulary does not make Phase 1 support multifile, React, full-stack, Google Ads, mobile or arbitrary mutations. No compatibility import or behavior check was run.

## 1. Supervisor assignment → local execution

**Producer:** existing Cognitive Runtime/approved plan owner, bridged by Phase 5. **Consumer:** Phase 5 orchestration. **Ownership:** planning remains with Cognitive; Phase 5 owns transport and enforcement of the local boundary.

**Input schema obligation:** schema version, task/correlation/owner identities, user goal, approved plan identity and version, local Phase 1 contract, relevant context and provenance, immutable architectural decisions, allowed operations, required permissions, expected workspace/file versions, verification requirements, execution budget and escalation policy. An approval reference must come from the existing approval authority, never candidate content. Mutable task data must be snapshotted or copied across the boundary so later model data cannot widen it.

**Output schema obligation:** validated assignment or a structured invalid-contract, missing-context, unavailable-authority, unsupported-task or escalation result. New architectural or causal decisions return to the supervisor; this boundary cannot silently reason through a provider.

**Versioning:** the local integration schema and underlying Phase 1 contract version are distinct and both must match. **Errors:** fail closed for unknown versions, missing mandatory context or permission wiring. **Cancellation:** a caller signal and task cancellation fence must stop new work. **Security:** context is untrusted data; approved plan identity is not a self-issued grant. **Status:** local boundary **IMPLEMENTED**; producer bridge **ADAPTER_REQUIRED / INTEGRATION_PENDING / VERIFICATION_PENDING**.

## 2. Phase 1 contracts/router/compiler → Phase 5 coordinator

**Producer:** Phase 1 task-contract validator, execution router and deterministic compiler. **Consumer:** Phase 5 strategy and compiler adapters. **Ownership:** Phase 1 decides contract validity, routing eligibility and deterministic transformation semantics; Phase 5 enforces the result before any execution.

**Input schema obligation:** opaque original local task contract with its exact schema version, supervisor-approved constraints and workspace identity, current executor capability report, available context and budget. The adapter must preserve Phase 1's canonical contract identity rather than reconstructing business rules from model text.

**Output schema obligation:** a structured validation decision; route to a deterministic compiler, learned executor, missing context, unsupported task, stale workspace or escalation; and a structured candidate with typed operations, targets, expected versions and output contract. A deterministic candidate passes the same candidate, permission, workspace and verification gates as a learned candidate.

**Versioning:** explicitly map each accepted Phase 1 version. Reject unknown or silently lossy conversions. **Errors:** preserve unsupported/missing-context/stale/budget outcomes; never convert them to success. **Cancellation:** cancel before route/compile, pass the signal and disregard late results after fencing. **Security:** neither compiler nor router grants permissions or certifies completion. No Phase 1 business logic is duplicated here. **Status:** local typed seams **IMPLEMENTED**; actual export imports and semantic compatibility **INTEGRATION_PENDING / VERIFICATION_PENDING** because the initial producer directory was unavailable.

## 3. Phase 2 tokenizer/Transformer/inference → local process transport

**Producer:** Phase 2 Python inference facade and its approved local executable. **Consumer:** Phase 5 transport and candidate validation. **Ownership:** Phase 2 owns tokenization, architecture, generation and checkpoint loading; Phase 5 owns the TypeScript process/protocol boundary and runtime enforcement.

**Input schema obligation:** explicit protocol version, request identity, discovery or generation method, pinned model/tokenizer/checkpoint identity, structured task payload, output format, maximum input/output tokens and resource/time budgets. Executable, argument array and containment policy are trusted deployment configuration. They never come from model output. The transport protocol is specified in `transport.md`; it is not asserted to match any unfinished Phase 2 server.

**Output schema obligation:** capability discovery tied to exact identities and protocol version; a structured candidate response with request correlation, model attribution, bounded output/usage and explicit completion/unsupported/missing-context/error disposition. Candidate content remains untrusted. No result may self-declare verified or approved status.

**Versioning:** handshake requires an exact supported protocol version and identity match; adapter conversion requires review in both phases. **Errors:** startup failure, process failure, malformed/oversize messages, protocol corruption, timeout, cancellation, unsupported capability and resource exhaustion remain classified errors. **Cancellation:** terminate the owned process tree through verified containment and discard late/duplicate replies. **Security:** local stdin/stdout only, no listener, no model download, no network fallback, no shell interpolation; hard resource/isolation guarantees and bounded output are required. Stdout is protocol-only; stderr is bounded and must not leak raw secrets into audit. **Status:** Phase 5 protocol implementation **IMPLEMENTED**; executable configuration, verified containment, Phase 2 server mapping and compatibility **ADAPTER_REQUIRED / INTEGRATION_PENDING / VERIFICATION_PENDING**. No Python process was launched.

## 4. Phase 3 registry/checkpoints → lifecycle and inference selection

**Producer:** Phase 3 model-version registry/checkpoint owner. **Consumer:** Phase 5 lifecycle storage adapter and approved model resolver; Phase 2 consumes an explicitly exported inference artifact. **Ownership:** Phase 3 stores immutable training/provenance metadata; Phase 5 owns approval-gated active-reference changes.

**Input schema obligation:** lookup by registered version identity; registration provides model, architecture/config, tokenizer, checkpoint hash/identity, training provenance and origin, artifact references and schema version. Only approved local references are allowed; file path presence alone is not authenticity.

**Output schema obligation:** immutable registered version record, checkpoint/tokenizer identities, independent evaluation reference and eligibility disposition, or explicit not-found/incompatible/revoked result. Training-resume checkpoint and inference-export checkpoint identities must both be recorded when different. Preserve ancestry to random initialization; do not assume local checkpoint means pretrained or verified.

**Versioning:** training registry, training checkpoint and inference checkpoint each have their own version; reject ambiguous conversion. **Errors:** mismatched identities/hash, absent export, unknown schema, incomplete provenance or untrusted artifacts block selection. **Cancellation:** reads observe cancellation; atomic lifecycle writes must return a definitive committed/not-committed result or require reconciliation. **Security:** registry metadata cannot approve activation; training loss is not promotion evidence; no weights are changed by integration. **Status:** lifecycle abstraction **IMPLEMENTED**; real registry/export mapping **ADAPTER_REQUIRED / INTEGRATION_PENDING / VERIFICATION_PENDING**.

## 5. Phase 4 evaluation → promotion eligibility and independent acceptance

**Producer:** independent Phase 4 evaluator and trusted evidence registry. **Consumer:** Phase 5 verification/lifecycle coordinators. **Ownership:** evaluator owns held-out cases, baselines and acceptance policy; integration owns refusal to execute/complete/activate without required independent evidence.

**Input schema obligation:** pinned registered model/tokenizer/checkpoint identities; task/contract/candidate/operation identity for runtime checks; approved evaluation suite/policy/version; required structural, behavioral, regression, permission, workspace and expected-output checks; trusted evidence/artifact references. Hidden answers remain with the evaluator and are not sent as execution context or training memory.

**Output schema obligation:** signed/authenticated or otherwise independently resolvable evaluation identity, exact artifact binding, evaluator/suite/policy versions, gate dispositions, required coverage, evidence references and independently decided eligibility. Runtime verification returns `verified`, `rejected`, `inconclusive`, or `unavailable`; only complete required evidence can produce `verified`.

**Versioning:** evaluation identity and gate policy version are pinned, not inferred from the newest report. **Errors:** missing/expired/revoked/mismatched evidence, unavailable isolation or incomplete consumer coverage blocks acceptance. **Cancellation:** propagate the signal; an aborted or partial evaluation cannot become a passing receipt. **Security:** generation and evaluation authorities must remain separate; model `independently_verified` metadata and self-authored tests cannot replace the trusted evaluator. **Status:** Phase 5 verification and eligibility seams **IMPLEMENTED**; Phase 4 export mapping, authentic evidence resolution and actual results **ADAPTER_REQUIRED / INTEGRATION_PENDING / VERIFICATION_PENDING**.

## 6. Phase 5 → existing permissions, workspace, tools and sandbox

**Producer:** validated Phase 5 candidate and trusted supervisor assignment. **Consumer:** existing permission/approval authority, workspace service, Tool Gateway and isolated coding/sandbox adapters. **Ownership:** existing controllers retain resource authorization and actual effects; Phase 5 cannot bypass them.

**Input schema obligation:** task/owner/correlation identity; exact operation/tool/capability identity; validated arguments; pinned candidate/contract/workspace identity; explicit target resources and expected versions; grant and approval references; stable idempotency/reservation identity; execution fence; verified sandbox identity, limits, filesystem/network restrictions and cancellation signal.

**Output schema obligation:** fresh permit or `permission_unavailable`/denied/pending; fresh workspace consistency or stale/conflict/replan; verified sandbox capability or unavailable; structured execution receipt, artifact references, output capture and evidence; structured uncertainty where the external result is unknown. A lost external response is not equivalent to failure/no effect.

**Versioning:** record each adapter capability/version and resource version. The current `SkillNodeBinding`/Runtime lease context must be mapped rather than bypassed. **Errors:** unknown tool or missing adapter yields `capability_unavailable`; missing isolation rejects execution; stale versions require explicit replan. **Cancellation:** adapter must check the signal and fence immediately before each effect and terminate isolated work where supported. Lack of strong cancellation for an external API must surface uncertainty and trigger reconciliation. **Security:** deny by default; operation-scoped permissions, canonical targets, current grants, no unrestricted dispatch, no raw model code in server process, and atomic reservation/idempotency semantics. **Status:** Phase 5 coordination **IMPLEMENTED**; concrete authority-preserving adapters **ADAPTER_REQUIRED / INTEGRATION_PENDING / VERIFICATION_PENDING**.

## 7. Verified outcomes → memory and separate learning cycle

**Producer:** independent verifier plus confirmed recovery evidence. **Consumer:** Phase 5 safe memory adapter, then existing memory/learning controls. **Ownership:** current memory owners enforce disclosure/storage permission; a future Phase 3 training cycle owns weight updates.

**Input schema obligation:** verified task/failure/recovery disposition; trusted evidence references and provenance; task/correlation and model-version attribution; allowlisted task context; permission-compatible sanitized metadata; explicit policy decision excluding secrets, unauthorized customer content and hidden evaluation answers.

**Output schema obligation:** idempotent stored reference or explicit skipped/rejected/unavailable result. Nothing stored is represented as a learned model weight change.

**Versioning:** memory envelope/policy and provenance versions are pinned. **Errors:** absent verification, policy, sanitizer, storage permission or trusted source blocks storage; regex redaction alone is insufficient. **Cancellation:** obey the signal before storage; reconcile ambiguous writes by the stable key, never duplicate blindly. **Security:** unverified claims cannot become facts; verified failure evidence does not establish a successful strategy; recovery is stored only after its own evidence confirms it. **Status:** safe boundary **IMPLEMENTED**; mapping to actual `recordExperience`/`createMemoryControl` and independent training/evaluation cycle **ADAPTER_REQUIRED / INTEGRATION_PENDING / VERIFICATION_PENDING**.

## 8. Lifecycle approval → activation/rollback reference

**Producer:** existing trusted owner/administrator approval authority. **Consumer:** Phase 5 lifecycle storage. **Ownership:** Phase 5 coordinates an isolated active reference; production provider settings remain untouched.

**Input schema obligation:** explicit activation or rollback intent, exact target version and identity, expected current revision/reference, scope/expiry and unused approval identity, matching independent evaluation, and prior eligible reference for rollback.

**Output schema obligation:** atomic updated active/previous/rollback references with revision and activation audit record, or stale/denied/unavailable/ineligible result. A new training checkpoint never automatically initiates this operation.

**Versioning:** compare-and-swap revision is mandatory. **Errors:** concurrent activation, consumed/revoked approval, missing eligibility or unknown commit state blocks automatic replay and requires readback. **Cancellation:** cancellation before commit prevents the write; cancellation during uncertain commit requires authoritative readback. **Security:** approval consumption and reference update must be coordinated atomically by the trusted storage adapter. Model content cannot approve itself. Rollback is explicit and audited, not an unreviewed model fallback. **Status:** lifecycle logic **IMPLEMENTED**; real storage/approval binding and production activation **ADAPTER_REQUIRED / INTEGRATION_PENDING / VERIFICATION_PENDING**.

## Shared integration work intentionally deferred

No `package.json`, workspace registration, lockfile, production import, route, database schema, environment variable or UI contract was changed. A coordinated follow-up must freeze all producers, install concrete trusted adapters, reconcile protocol/checkpoint format differences, decide storage with its owner, and verify all required consumers. Any build/test/typecheck/training/benchmark or runtime probe requires a later authorized phase; none was performed here. The final composition and rollback sequence is in `repository-integration.md`.
