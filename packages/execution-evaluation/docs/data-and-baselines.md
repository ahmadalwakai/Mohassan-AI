# Dataset protection and baseline methodology

## Existing repository evidence

Read-only inspection on 2026-11-12 found the following existing mechanisms. None was run for this implementation.

| Path | Discovered exports and meaning |
| --- | --- |
| `packages/skills/src/benchmark-suites.ts` | `SKILL_BENCHMARK_SUITES`, `skillBenchmarkSuite`, `skillBenchmarkDefinition`, `benchmarkSuites`, `getSkillBenchmarkSuite`, `selectSkillBenchmarkSuite`, `skillBenchmarkSupport`, `trustedSkillBenchmarkTrainingContext`; three suites containing 4 instruction-delivery, 4 file-read and 7 file-write cases. |
| `packages/skills/src/benchmark.ts` | `SkillBenchmarkRunner`, `SkillBenchmarkOptions`, `loadSkillBenchmarkSnapshot`, `readBenchmarkEvaluation`, `listBenchmarkEvaluations`, `benchmarkPinsCurrent`, `createSkillBenchmarkControl`; pinned content, suite and configuration hashes, independently supplied case results, run leases and identity checks. |
| `packages/contracts/src/skill-benchmarks.ts` | `SkillBenchmarkSuiteSchema`, `SkillBenchmarkCaseResultSchema`, `SkillBenchmarkEvaluationSchema`, `SkillBenchmarkCatalogSchema` and associated types; measured scope and limitations, nullable measurements, evidence-bound passes and blocked-is-not-success semantics. |
| `tests/fixtures/skills/benchmarks/oracles.json` | Public fixed fixture values for existing instruction/file-tool checks. These are not a new hidden execution-model dataset. |
| `packages/skills/src/compiler.ts` | `compileInstructionContext`, `skillContextBudget`, `emptySkillContext`, `InstructionDocument`, `CompiledSkillContext`, `SkillContextSource`; bounded instruction-context assembly, **not** the Phase 1 structured execution compiler. |
| `packages/learning/src/evaluation.ts` | `evaluateCase`, `evaluationCases`, `safetyHoldoutV2Cases`, `safetyHoldoutV3Cases`, `EvaluationCase`, `EvaluationObservation`, `EvaluationResult`, `EVALUATION_SUITE_VERSION`, `EVALUATION_ORACLE_VERSION`, `SAFETY_HOLDOUT_V2_VERSION`, `SAFETY_HOLDOUT_V3_VERSION`; existing chat/research/browser/coding/computer fixture observations. |
| `packages/learning/src/safety-v4.ts`, `packages/learning/src/safety-v5.ts` | `safetyHoldoutV4Cases`, `safetyHoldoutV5Cases` and version constants. |
| `packages/learning/src/experience.ts` | `classifyExperience`, `recordExperience`, `recordExperienceFeedback`, `ExperienceInput`, `ExperienceExpectation`, `ExperienceObservation`; `verified_success`, `verified_failure`, `unverified`, with hashed target/expected/observed/reference evidence. |
| `packages/learning/src/training.ts` | `auditTrainingReadiness`, `prepareRoutingTrainingDataset`, `TRAINING_MINIMUM_UNIQUE_EXPERIENCES`, `ROUTING_TRAINING_DATASET_VERSION`, `ROUTING_TRAINING_EXPORT_LIMIT`; verified category-routing preparation, exclusion of known evaluation IDs/prompts, chronological 80/20 training/validation split. This does not supply project/template-family isolation. |
| `packages/learning/src/index.ts` | Reexports experience, evaluation, lessons, knowledge, training, context and PDF modules. |
| `packages/memory/src/index.ts` | `createMemoryControl`, `MemoryError`, reexports contracts and skills; owner-scoped memory retrieval and persisted skill evaluation lifecycle. |
| `packages/memory/src/skills.ts` | `manifestHash`, `executeChecklist`, `evaluateChecklist`; eight fixed checklist-router cases. Execution returns `scope: 'proposal_only'`, `executionAllowed: false`. These cases do not establish code-execution capability. |
| `packages/memory/src/contracts.ts` | `MemoryProvenanceSchema`, `MemoryItemSchema`, `DeclarativeSkillSchema`, `SkillEvaluationSchema`, `SkillActivationSchema`, `MemoryWorkspaceSchema`; provenance, evidence, lexical retrieval and explicit activation approval. |

Existing skill benchmark documentation expressly limits claims: no semantic-quality or general sandbox guarantee; fixed holdout fixtures do not establish generalization. File-write recovery covers confirmed receipts and cooperating workers, not arbitrary hostile host mutation. The public learning and memory fixtures must be registered as known development/reference material if reused; they cannot silently become private held-out answers.

At initial inspection, `packages/cognitive/src/execution-model/` and `packages/execution-training/` were absent. Both appeared during later read-only inspection; their discovered interfaces are documented below. The Python package imports neither path and requires explicit adapters and versioned manifests.

## Scope of the proposed dataset

The initial suite targets 200 atomic tasks, 60 repository-context tasks and 20 end-to-end workflows. These are design targets, not existing records or executed results. An empty or partial suite remains incomplete. Families cover structured operations, short TypeScript implementation, evidence-led repair, skill composition, multi-file changes and full-stack integration.

Only an independently curated evaluation task contract and public context may enter a model prompt. Hidden test references, private acceptance evidence and expected response labels remain on the verifier side. No function here exports failures into training data, queries a live database or retrieves production records.

## Trust boundary

Manifest digests establish integrity relative to an externally pinned digest; they do not prove authorship or historical secrecy. The evaluation custodian must keep a read-only registry of prior task identities and a complete, pinned inventory of every authorized training/reference corpus. Independently approve that inventory before using its clean split assessment for acceptance gates. Unprovided corpora are unknown contamination risk, never proof of no contamination.

Exact and lexical near-duplicate checks are reproducible warnings and blockers. They cannot detect every semantic paraphrase, unknown pretraining source, human exposure, or a compromised data custodian. Quarantine suspicious pairs for human review, publish a new dataset version for changed task content, and never retroactively relabel an exposed suite as held out.

## Baseline integration

The deterministic baseline is an injected, approved Phase 1 compiler protocol. It receives only the public task view and returns a structured candidate or explicit unsupported/missing-context response. There is no replacement compiler, model API, shell, network client or arbitrary code execution. If the adapter is absent, the response explicitly says integration is unavailable. The approved bridge must attest to no neural calls, external reasoning, network access, candidate execution or access to private oracles; in-process Python cannot enforce a malicious callback's behavior.

Later read-only inspection found `packages/cognitive/src/execution-model/compiler.ts`: `DETERMINISTIC_EXECUTION_REGISTRY`, `DeterministicCompilationOptions`, `DeterministicExecutionCompiler.supports(task)` and `.compile(raw, options)`. The sole registered transformation is `structured.replace-file.v1`; it wraps explicitly supplied `path`, `expectedHash` and complete replacement `content` without changing files. Options require supervisor-owned `attemptsUsed`, `countOutputTokens` and optional abort signal. The result is `ExecutionResult` from `schemas.ts`, discriminated by `kind: candidate | missing_context | unsupported | failure`; candidates retain `verification: not_verified` and `executionAllowed: false`. Reuse those implementations, never reproduce their business logic in Python.

The local Phase 1 `index.ts` reexports its schemas, contract validator, compiler, router, model adapter and result validator. It is not registered in `packages/cognitive/src/index.ts` or the npm package entrypoint. A concrete bridge must translate only an explicitly supplied public contract, ensure its task/workspace identity and budgets match evaluation conditions, provide the independent output token counter and preserve unsupported/failure distinctions. Phase 1's public task acceptance descriptions are distinct from this evaluator's private acceptance/oracle fields; never fill its `acceptanceCriteria` from the private oracle. Multi-file and full-stack categories are reserved unsupported cases in Phase 1, not implemented compiler support.

`bridges/phase1-compiler.ts` is a source-only TypeScript implementation of the envelope translation. It imports the actual discovered compiler and schemas by relative path and exports:

- `supportsPhase1EvaluationRequest(raw: unknown): boolean`, using the actual compiler registry predicate.
- `compilePhase1EvaluationRequest(raw: unknown, options: Phase1EvaluationBridgeOptions): Phase1EvaluationCandidate`, with required supervisor `countOutputTokens` and optional abort `signal`.
- `PHASE1_EVALUATION_BRIDGE_VERSION` and `phase1EvaluationBridgeDescriptor`, recording the observed compiler version and registered transformations.

The source bridge does not start a TypeScript runtime, JSON transport or process. A reviewed Python `DeterministicCompilerBridge` must explicitly bind those functions and inject the trusted counter/signal; that transport remains pending. Its `CompilerAssurance` must reference an independent integration review. No package manifest or production export was changed.

The explicit public-input mapping is:

| Evaluation request field | Phase 1 mapping / requirement |
| --- | --- |
| `task.input_specification.phase1_contract` | Full public `ExecutionTaskContract`, validated using the actual Phase 1 schema. Only task family A and the registered deterministic operation are supported. |
| `task.available_context.phase1_context` | Public `ExecutionContext`; must match the contract context after schema parsing. |
| `task.available_context.phase1_workspace` | Public workspace version; must match project, commit and snapshot identity. |
| `task.task_id`, `expected_output_language` | Must match contract task ID and output language. |
| `task.required_capabilities`, `safety_constraints.allowed_tools`, `safety_constraints.allowed_write_paths` | Must match contract capability, tool and allowed-file declarations. These remain declarations and grant no dispatch permission. |
| `task.allowed_symbols` | Must contain every symbol name declared in the supplied Phase 1 context. |
| `task.allowed_execution_budget` | Original Phase 1 budget must match; budgets above Phase 1's published limits are explicitly unsupported. |
| `request.budget`, `request.attempt` | Remaining time/output limits replace the matching original limits; `attempt - 1` supplies supervisor `attemptsUsed`. External reasoning budgets must be zero. |

The bridge rejects private evaluator field names anywhere in its decoded request and permits only the public task envelope at the top level. Phase 1 `candidate.output.replacement` becomes one inert `CandidateOutput.mutations` write declaration; `expectedHash` becomes `base_hash`, and `workspace.snapshotHash` becomes `workspace_version`. Candidate content is null to avoid duplicating source text. The actual compiler result supplies every replacement field; the bridge does not synthesize or rebuild replacement content. Unsupported and missing-context variants retain their status; classified Phase 1 failures become errors with stable reason codes. Both the original compiler envelope and the translated result are token-budget checked. This bridge has not been built, typechecked or executed.

Retrieval uses an authorized, pinned, split-audited reference corpus and deterministic local lexical ranking. Ties are ordered by stable example ID. Every response records retrieved IDs and scores and labels its mode as copied, adapted or unsupported. A copied nearest-neighbor answer is a candidate for independent verification; similarity never establishes correctness. Exact public-input overlap with the held-out set is contamination and prevents corpus admission. Adaptation is limited to explicitly declared scalar JSON fields and per-field validation; no source-code interpolation or implicit generation is permitted. A corpus whose provenance, permissions or split assessment is incomplete is not admitted.

`DeterministicBaseline` requires a reviewed `DeterministicCompilerBridge` with `assurance`, `supports(request)` and `compile(request)`. Both baselines expose an `identity` object and `execute(ExecutionRequest) -> CandidateOutput`. `CompilerAssurance` records version, supported transformations and independent review of all five purity restrictions. These assertions belong to trusted integration configuration, never candidate metadata.

`RetrievalBaseline` uses NFKC/case-folded lexical token counts and cosine similarity; the default fixed minimum score is 0.5 and the default reporting limit is five neighbors. Those are algorithm parameters, not benchmark findings or promotion thresholds. The first ranked reference is the only attempted reuse; ties use Python Unicode code-point ordering of stable record IDs. Different-language outputs return unsupported. A failed substitution returns unsupported rather than silently falling back to copied text. `FieldSubstitution` supports a preexisting JSON leaf with a reviewed boolean, bounded integer, enumerated string, or identifier already present in the task's allowed-symbol list. No paths, code text, tool-operation envelopes or mutation envelopes are interpolated.

The corpus record's `response_hash` pins `RetrievalExample.reuse_hash`, which hashes **both** the output and its substitution rules. `corpus_hash` pins the sorted full corpus metadata, including each output digest and authorization reference. `SplitAudit.corpus_record_hashes` additionally pins every disclosed record individually. Retrieval can use an authorized subset of that complete inventory; every selected record must match its audited digest, and the full inventory hash stays in the baseline identity as `audited_inventory_hash`. This permits non-retrievable training/validation records to remain in contamination checks without giving retrieval access to them. The selected retrieval subset has its own `corpus_hash`. `SplitAudit.evaluation_public_inputs` binds retrieval requests to the exact public input of the audited held-out task. A constructor copies corpus data so later caller mutations do not change the evaluated reference snapshot.

## Manifest and split API

`DatasetManifest` uses `execution-evaluation-manifest-v1` and records dataset identity/version, `proposed | partial | ready` status, task entries, three tier targets, provenance reference and timestamp. `ManifestEntry` pins the full task hash, immutable content hash, public-input hash and project/template/tier/family labels. `verify_manifest` requires an independently pinned manifest hash plus a historical task-ID registry and its custodian reference. Changed task content requires a new task ID. Dataset-version-only changes can retain an unchanged task ID.

`ManifestVerification.verified` means digest, task inventory and immutable identities agree. `complete` additionally requires ready status and every proposed tier target. A nonempty partial suite may be inspected for research but cannot be reported complete or admitted for production promotion. `evaluation_identity` hashes the pinned manifest, explicit evaluation version and configuration, including seeds, budgets and adapter identities supplied by the caller.

`audit_splits` requires the task records, complete authorized `CorpusRecord` inventory, pinned evaluation-manifest and corpus hashes, an explicit completeness assertion and its evidence reference. It checks stable IDs, evaluation-origin/parent lineage, project families, template families, exact public-input duplicates and four-token-shingle Jaccard near duplicates (default 0.92). It also checks duplicate/near-duplicate evaluation tasks against each other. The near scan defaults to 250,000 comparisons and 100,000 tokens per record; hitting a limit marks the scan incomplete and blocks a clean result. The audit never resolves suspicious pairs by deleting or relabeling data.

## Phase 3 compatibility

Phase 3 must provide stable record IDs, project and template-family labels, source split, normalized public-content fingerprints and a pinned manifest of the complete authorized corpus. A translator must preserve those identities and provenance and reject evaluation/holdout entries. Existing `verified-category-routing-v1` rows do not contain sufficient project/template metadata; they need independently supplied provenance before serving as an execution-model reference corpus. Do not infer missing metadata from a result or from a model's answer.

Read-only inspection subsequently found these concrete Phase 3 interfaces:

| Path | Contract |
| --- | --- |
| `packages/execution-training/execution_training/schemas.py` | `TrainingExample`, `Provenance`, `UsageAuthorization`; schema `execution-example-v1`. The example has `sample_id`, `task_specification`, `required_context`, `project_family`, `template_family`, verification/source/authorization and target data. `provenance.evaluation_origin` and `parent_sample_ids` must be preserved. |
| `packages/execution-training/execution_training/splitting.py` | `FamilyReservation`, `reserve_families`, `SplitManifest`, `create_split_manifest`; schema `execution-split-v1`. Assignments use `train`, `validation`, `test`; namespaced families use `project:` and `template:`. `manifest_id` is the canonical digest of the payload with that field omitted. |
| `packages/execution-training/execution_training/dataset.py` | `PreparedDataset`, `prepare_dataset`, `load_dataset`; prepared artifacts are `train.json`, `validation.json`, `test.json`, `preparation-audit.json`, `split-manifest.json`. |
| `packages/execution-training/execution_training/deduplication.py` | `content_payload`, `canonical_sample_hash`, `family_keys`, `DeduplicationResult`, `deduplicate`; exact content and four-token near matching. Evaluation independently recomputes its own public-input audit. |
| `packages/execution-training/execution_training/registry.py` | `ModelVersionManifest`, `EvaluationAttestation`, `ModelVersionRegistry`; explicit evidence resolver, unpromoted status, no promotion API. |

An integration translator must verify the Phase 3 pinned `manifest_id`, sample hashes, assignments and authorization, then map only `train` records into retrieval `source_split: training`. Phase 3's permitted uses do not include `retrieval`; obtain and preserve an explicit retrieval authorization before constructing `CorpusRecord.authorized_uses`. Do not reinterpret training permission automatically. Keep `validation` records in the disclosed contamination inventory but outside the retrievable corpus; if inventory and retrieval subsets differ, run and bind separate audits to each exact snapshot. `test` records must never enter retrieval. Private Phase 3 verification/target data must not be put in public input.

The translator maps the public input semantically and explicitly; it cannot just rename fields and hash targets. Phase 3 `sample_hashes` include target content, whereas Phase 4 public-input hashes intentionally do not. Preserve the original source manifest digest separately. The Phase 3 model registry's `dataset_manifest_identity` identifies the training dataset bound to the checkpoint; it is not the independent held-out evaluation manifest identity. A reviewed Phase 4 attestation translator must bind both, plus the checkpoint, model version and suite; no such translator or automatic registry write is installed here.

The adapter layer is versioned independently of the upstream training manifest. Both inspected Python modules serialize sorted-key compact UTF-8 JSON with `ensure_ascii=False` and `allow_nan=False`. Still, do not assume JavaScript `JSON.stringify` and Python serialization have identical ordering or numeric formatting. Cross-language consumers must preserve the canonical bytes or implement exactly that serialization contract; avoid ambiguous numeric representations in identity-bearing metadata.
