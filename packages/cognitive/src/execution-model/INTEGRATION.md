# Phase 1 execution-model integration specification

## Status and ownership

This directory implements an isolated candidate-generation boundary. It is not wired into production. The existing Cognitive Runtime remains the supervisor; this module cannot approve actions, dispatch tools, read or write project files, call external providers, change task state, or certify behavioral correctness.

All Phase 1 files live in `packages/cognitive/src/execution-model/`. The local `index.ts` is the export surface: it re-exports `schemas.ts`, `contract-validator.ts`, `compiler.ts`, `router.ts`, `adapter.ts` and `result-validator.ts`, plus the `ExecutionOutputTokenCounter` type from `boundaries.ts`. Internal boundary helper functions are not part of that entrypoint. `packages/cognitive/src/index.ts`, the package manifest, shared contracts, server composition, chat orchestration, workers, database schemas, and other packages remain unchanged. `@mohassan/cognitive` currently exports only `./src/index.ts`; the new local module therefore is not available through that package's public entrypoint yet. Local imports follow the repository's TypeScript ESM source-module convention.

No build, typecheck, lint, test, training, migration, installation, deployment, commit, or merge is part of this delivery. Source inspection is not evidence that those checks pass; later integration must run them under its own authorization.

## Local API and schemas

The local export surface groups the following responsibilities:

| Source | Responsibility |
| --- | --- |
| `schemas.ts` | Strict Zod task, context, constraints, budget, workspace, capability, candidate and result schemas, with corresponding inferred TypeScript types. |
| `boundaries.ts` | Bounded JSON inspection, content hashing, workspace identity comparison, structured failure helpers and the host-owned output token counter contract. |
| `contract-validator.ts` | `ExecutionContractValidator`: schema, input, reference, context-completeness and operation validation. |
| `compiler.ts` | `DeterministicExecutionCompiler`: explicit registry of supported pure transformations. |
| `router.ts` | `ExecutionStrategyRouter`: deterministic strategy selection and structured non-executable outcomes. |
| `adapter.ts` | Transport-independent `ExecutionModelAdapter` and bounded submission/discovery handling. |
| `result-validator.ts` | `ExecutionResultValidator`: structural validation and a separate execution-eligibility check; semantic verifier interface only. |
| `index.ts` | Directory-local exports; no production registration or side effects. |

Core schema/type pairs are `ExecutionTaskContractSchema`/`ExecutionTaskContract`, `ExecutionContextSchema`/`ExecutionContext`, `ExecutionConstraintsSchema`/`ExecutionConstraints`, `ExecutionAcceptanceCriteriaSchema`/`ExecutionAcceptanceCriteria`, `ExecutionBudgetSchema`/`ExecutionBudget`, `WorkspaceVersionReferenceSchema`/`WorkspaceVersionReference`, `ExecutionCandidateSchema`/`ExecutionCandidate`, `MissingContextRequestSchema`/`MissingContextRequest`, `UnsupportedExecutionResultSchema`/`UnsupportedExecutionResult`, and `ExecutionResultSchema`/`ExecutionResult`.

Additional exported schema families cover execution identities and paths, file replacements, operation categories, task families, model identity/capabilities, issues and failures. The source exports are authoritative for the complete function/type inventory.

The exact directory-entrypoint export inventory is:

- Classes/functions: `ExecutionContractValidator`, `DeterministicExecutionCompiler`, `ExecutionStrategyRouter`, `ExecutionResultValidator`, `submitExecutionModelTask`.
- Registries: `SUPPORTED_EXECUTION_OPERATIONS`, `DETERMINISTIC_EXECUTION_REGISTRY`.
- Schemas: `ExecutionIdSchema`, `ExecutionHashSchema`, `ExecutionPathSchema`, `ExecutionTargetPathSchema`, `WorkspaceVersionReferenceSchema`, `ExecutionBudgetSchema`, `ExecutionContextSchema`, `ExecutionConstraintsSchema`, `ExecutionAcceptanceCriteriaSchema`, `ExecutionOperationCategorySchema`, `ExecutionFamilySchema`, `ExecutionOutputCategorySchema`, `FileReplacementSchema`, `ExecutionCodeEditsSchema`, `ExecutionTaskContractSchema`, `ExecutionIssueSchema`, `ExecutionFailureCodeSchema`, `ExecutionFailureSchema`, `MissingContextItemSchema`, `MissingContextRequestSchema`, `UnsupportedExecutionResultSchema`, `ExecutionModelIdentitySchema`, `ExecutionProducerSchema`, `ExecutionCandidateSchema`, `ExecutionResultSchema`, `ExecutionModelCapabilitiesSchema`, `ExecutionRoutingContextSchema`, `ExecutionPermissionSnapshotSchema`, `ExecutionEligibilitySnapshotSchema`.
- Contract/result types: `WorkspaceVersionReference`, `ExecutionBudget`, `ExecutionContext`, `ExecutionConstraints`, `ExecutionAcceptanceCriteria`, `ExecutionOperationCategory`, `ExecutionFamily`, `FileReplacement`, `ExecutionTaskContract`, `ExecutionIssue`, `ExecutionFailureCode`, `ExecutionFailure`, `MissingContextItem`, `MissingContextRequest`, `UnsupportedExecutionResult`, `ExecutionModelIdentity`, `ExecutionCandidate`, `ExecutionResult`, `ExecutionModelCapabilities`.
- Routing/validation types: `ExecutionContractValidation`, `DeterministicCompilationOptions`, `ExecutionRoutingContext`, `ExecutionRoutingDecision`, `ExecutionStructuralValidation`, `ExecutionPermissionSnapshot`, `ExecutionEligibilitySnapshot`, `ExecutionEligibilityResult`, `ExecutionResultValidatorOptions`.
- Adapter/verification interfaces and types: `ExecutionModelAdapter`, `ExecutionModelCallOptions`, `ExecutionModelSubmissionOptions`, `ExecutionModelInvocationOptions`, `ExecutionOutputTokenCounter`, `ExecutionVerificationEvidenceReference`, `ExecutionSemanticVerificationResult`, `ExecutionSemanticVerifier`.

The callable preparation/validation API is:

- `ExecutionContractValidator.validate(raw)` returns `ExecutionContractValidation`, either a parsed task or a structured failure/context/unsupported result. `SUPPORTED_EXECUTION_OPERATIONS` fixes the initial operation vocabulary.
- `DeterministicExecutionCompiler.supports(task)` checks its explicit registry; `compile(raw, { attemptsUsed, countOutputTokens, signal? })` returns `ExecutionResult`. `DETERMINISTIC_EXECUTION_REGISTRY` is immutable and exported.
- `ExecutionStrategyRouter.route(rawTask, rawContext, countOutputTokens)` returns `ExecutionRoutingDecision`. `ExecutionRoutingContextSchema`/`ExecutionRoutingContext` require the trusted capability/tool inventory and consumed-attempt count, with optional learned capabilities. A deterministic selection includes the validated candidate; a learned selection identifies the selected artifact and does not submit a request.
- `submitExecutionModelTask(adapter, rawTask, rawRoutingContext, { signal?, countOutputTokens })` returns `Promise<ExecutionResult>`. Its exported option types are `ExecutionModelCallOptions`, `ExecutionModelSubmissionOptions` and `ExecutionModelInvocationOptions`. The exact adapter methods and bounded helper behavior are described below.
- `new ExecutionResultValidator({ now? })` accepts an optional trusted clock. `validateStructure(raw, taskRaw, countOutputTokens)` returns `ExecutionStructuralValidation`. `checkEligibility(rawCandidate, rawTask, rawSnapshot, countOutputTokens)` returns `ExecutionEligibilityResult`; even success retains `executionAllowed: false` and requires semantic verification.
- `ExecutionPermissionSnapshotSchema`/`ExecutionPermissionSnapshot` and `ExecutionEligibilitySnapshotSchema`/`ExecutionEligibilitySnapshot` describe host observations. The latter includes current task state, cancellation, available capabilities/tools, permission state and `attemptsUsed` measured **before the current generation began**. A granted permission observation binds task/workspace, scopes, tools, exact files, check time and expiry. It is not a transferable approval.
- `ExecutionSemanticVerifier.verify({ candidate, task, signal, assertActive })` is interface-only. `ExecutionSemanticVerificationResult` carries a `passed`, `failed` or `inconclusive` outcome, task/workspace binding, criterion-linked evidence and unmet criterion IDs. It cannot mutate the original candidate into a verified result.
- Internal `boundedJsonBytes`, `sameWorkspace`, `contentHash`, `executionFailure`, `unsupportedExecution` and `schemaIssues` helpers support those boundaries without tool dispatch. Only the `ExecutionOutputTokenCounter` type is re-exported from the boundary-helper module by the local entrypoint.

### Task envelope

Every task declares a schema version and unique task identity; a local objective; family and versioned operation name; exact input; expected output category, language and maximum size; supplied project context and explicit required references; allowed files and operations; capabilities, tools and scopes required downstream; fixed architectural decisions; acceptance criteria; workspace identity; budgets; and missing-context/unsupported policies. Existing-file proposals must explicitly declare the existing `coding.change` capability/tool and `code:write`; eligibility additionally requires all scopes declared by the live registered capability.

Context records carry explicit file contents and hashes, symbols, imports, type declarations, function signatures, documentation excerpts and concrete failure evidence. Required references resolve against supplied records. Empty lists are explicit declarations, not permission to invent missing project facts. Repair evidence is tied to the task's workspace. The module does not research unresolved references or infer unprovided exports, database fields, imports, or tool capabilities.

`ExecutionAcceptanceCriteriaSchema` reuses `GoalDefinitionSchema.shape.successCriteria`. Criteria retain the existing identifier, description and required-evidence representation. They describe what the supervisor must independently verify; contract validation does not prove them true.

The initial families are:

| Family | Operation/category | Candidate |
| --- | --- | --- |
| `structured_specification` | `structured.replace-file.v1` / `structured` | Validated `replace_file` operation containing the exact supplied replacement. |
| `typescript_implementation` | `typescript.implement.v1` / `typescript` | One proposed TypeScript source-file replacement under supplied signatures and context. |
| `local_code_repair` | `typescript.repair.v1` / `code_repair` | One proposed TypeScript source-file replacement tied to concrete failure evidence. |

Phase 1 permits one **existing** `.ts` source file. It does not create/delete files, modify tests/configuration, support JSX, or implement multi-file edits. `react`, `nextjs`, `full_stack`, `multi_file`, `google_ads`, `ios` and `android` are reserved operation categories for explicit unsupported handling. Their presence in the category schema is not executor support.

Budgets bound timeout, output tokens and total permitted attempts. An attempt allowance never starts an automatic retry loop or authorizes repeat effects. The host owns attempt accounting and decides whether a new candidate-generation attempt is appropriate.

The current hard limits are 1–120,000 ms, 1–16,384 output tokens, 1–3 generation attempts, a 262,144-byte contract envelope, and a 1–64,000-byte **complete result envelope**. JSON escaping and result metadata count toward that output limit. Context files are individually limited to 64,000 UTF-8 bytes, with at most 40 supplied files. More than 128 unresolved references rejects the contract instead of silently dropping requested context. Declarations, documentation and failure evidence must contain nonblank text. These limits are local Phase 1 constraints, not changes to Runtime limits.

### Result envelope

`ExecutionResult` has four discriminated variants: `candidate`, `missing_context`, `unsupported`, and `failure`. Candidates carry the original task/workspace identity, producer identity and exactly one permitted output. Every candidate has `verification: 'not_verified'` and `executionAllowed: false`. Strict schemas reject an executor-supplied verified status, permission grant, lifecycle transition or extra operation.

Missing context returns individual required items and the contract's `request`/`escalate` disposition. Unsupported results identify the operation, reason and `return_unsupported`/`escalate` disposition. Failure codes distinguish invalid contract/output, timeout, cancellation, stale workspace, permission required, capability unavailable, verification failure, escalation required, invalid task state, exhausted budget and executor failure. Failures are not automatically retryable.

## Implemented routing and compilation

The router validates the contract before selecting a strategy. It considers the versioned operation and family, supported output, required context, architectural status, explicit policy, registered deterministic support, advertised learned support, required capabilities and budget limits. Its selected strategy is `deterministic` or `learned`; otherwise it produces a structured unsupported/context/failure result. Missing required context never becomes guessed context. `architecture.status: 'requires_supervisor'` returns an escalation requirement.

`deterministic_only` cannot fall through to the model. `learned_only` requires a compatible supplied learned capability advertisement. `prefer_deterministic` selects a registered transformation when applicable and otherwise considers the learned executor. No route calls Groq, Ollama, FreeLLMAPI or a generic inference fallback. A reserved domain or unknown operation remains unsupported.

The compiler's first and only registered operation is `structured.replace-file.v1`. Its input reuses the existing raw coding-edit shape: `path`, `expectedHash`, and complete `content`. It validates the supplied existing file/preimage and declared target, then produces an operation candidate containing that exact replacement. It does not synthesize implementation code or change source contents beyond copying the explicit specification. This is preparation of an operation; it is not a file write or a claim that the replacement is correct TypeScript.

There is no arbitrary script execution, dynamic code loading, filesystem mutation, network request, hidden inference call or fallback transformation in the compiler.

## Learned executor boundary

`ExecutionModelAdapter` is transport-independent and has two methods:

```ts
discoverCapabilities(options: ExecutionModelCallOptions): Promise<ExecutionModelCapabilities>;
generateCandidate(
  task: Readonly<ExecutionTaskContract>,
  options: ExecutionModelSubmissionOptions,
): Promise<ExecutionResult>;
```

`ExecutionModelCallOptions` contains a required `signal`, remaining `timeoutMs` and absolute `deadlineAt`. `ExecutionModelSubmissionOptions` adds a supervisor-reserved, one-based `attempt`. Implementations must honor cancellation/deadlines, perform at most one generation, and classify failures through `ExecutionResult`. A model response can be a structured candidate, missing-context request, unsupported result or classified failure.

Model identity includes ID, version, artifact hash, local execution and random-initialization declarations. Matching declarations bind routing/results to the advertised artifact; they do not independently prove training provenance. The supervisor must validate provenance and artifact trust outside this module.

Capability advertisements name exact family/category/operation/output combinations and supported response languages, plus input-size, output-token and timeout limits. Capability discovery is not authorization to use downstream tools. A transport failure, malformed advertisement, stale identity, invalid output, timeout or cancellation is not success and must not silently invoke another provider.

`submitExecutionModelTask` validates and routes the task using the supplied host inventory. A deterministic selection returns its validated candidate without calling the adapter. A learned selection requires an existing advertised identity in the routing context; the helper does not bootstrap discovery when the host has supplied none. The host must obtain the initial advertisement through the adapter's discovery method using its own bounded call options.

For a learned selection, the helper performs one bounded capability refresh, checks the artifact identity against the selection, and reroutes against the refreshed capability limits. It then submits exactly one cloned task with `attemptsUsed + 1`, so an in-process adapter cannot mutate the validator's authoritative task copy. It validates the complete returned envelope, requires any candidate's producer identity to match the selected learned artifact, and returns the structured result without dispatching it. Unexpected thrown adapter errors become `executor_failure` without copying arbitrary diagnostics into the result.

Discovery, generation and validation share the task deadline. The helper races asynchronous calls against abort/timeout, cleans up its timer/listeners, and aborts its internal signal on exit. A late settlement is observed without becoming a usable result. Attempt reservation/persistence remains an atomic host responsibility; the helper does not increment a database counter or retry generation.

The adapter does not assume an HTTP endpoint, inference server, checkpoint layout, tokenizer implementation or environment variable. It does not implement a model or training pipeline. Cancellation of the caller is bounded; a future transport must also stop its own underlying inference and must not generate external effects. JavaScript cannot forcibly stop an implementation that ignores its signal.

## Validation layers and trust boundary

1. **Contract validation** checks JSON shape and bounds, operation/family compatibility, workspace references, input/output restrictions, declared context, reference consistency and hashes. It yields structured errors or missing-context requests. It does not reason about behavioral correctness.
2. **Structural result validation** checks the strict result schema, task/strategy/workspace binding, allowed category/language, byte/token limits, target/preimage references and unauthorized operations. Learned adapter validation also binds the producer identity to its discovered artifact. The host must supply a trusted `ExecutionOutputTokenCounter` over the **complete serialized result envelope**, including the entire candidate when present. A model-reported usage count or character heuristic is not an authoritative token count.
3. **Execution eligibility** separately uses trusted current host state to check workspace consistency, active task state, permissions and actual required capabilities/tools. A passing check only permits handoff for existing authorization/verification gates; it does not execute or grant authority.
4. **Semantic verification** is an interface only. The existing supervisor, coding sandbox, tool adapters and persisted verification receipts remain responsible for proving acceptance criteria. A model cannot provide its own trusted verifier implementation or success receipt.

`boundedJsonBytes` intentionally does not reuse `isBoundedSkillJson`: the existing helper caps the complete skill JSON payload at 65,536 bytes, whereas a supplied execution context may be larger. The local guard has a bounded byte/node/depth budget and rejects cycles, accessors, non-JSON values, sparse arrays and dangerous property names before schema traversal. This guard is not a sandbox for arbitrary JavaScript proxies; external transports should decode bounded JSON bytes into plain data before calling the module.

Paths are checked lexically and against declared file references. The module does not resolve filesystem roots, symlinks, junctions or hard links. Existing coding/file adapters must still enforce those restrictions at actual dispatch. Context strings and documentation are data, never authority.

## Existing repository interfaces and proposed connections

The following interfaces were inspected in the repository. Proposed connections below are not implemented.

| Existing path and symbol | Observed behavior and later integration requirement |
| --- | --- |
| `packages/cognitive/src/index.ts`: `GoalCompiler`, `StrategyPlanner`, `ModelRouter`, `UncertaintyEngine`, `PlanningEngine`, `verifyPlanningResult` | Planning normalization recomputes registry-derived scopes/approval requirements, DAG ordering and uncertainty. Planning verification is explicitly structure/policy verification. Keep this supervisor intact; select bounded execution contracts after planning/context collection. `PlanningEngine` currently accepts Groq planning providers only. |
| `packages/contracts/src/index.ts`: `GoalDefinitionSchema`, `TaskStatusSchema`, `CapabilitySchema`, `ProjectSchema`, `RawCodingEditsSchema`, `CodingEditsSchema`, `CodingResultSchema` | Phase 1 reuses compatible criteria, project identity, raw edit shape and existing state/capability vocabulary. A raw candidate is not a `CodingResult`. `WorkspaceSnapshotSchema` in this file describes application/UI state, not a repository file snapshot. |
| `packages/contracts/src/skills.ts`: `SkillToolIdSchema`, `isBoundedSkillJson` | Reuse the existing tool ID vocabulary. Its generic JSON limits are unsuitable for the larger execution-context envelope; see the local bounded-data guard. |
| `packages/runtime/src/index.ts`: `RuntimeOptions.plan`, `.code`, `.verifyCode`; `Runtime` | Existing Runtime owns task creation, approval, lease dispatch, cancellation, transition to `verifying`, and completion. No Phase 1 task capability is registered. Later composition must feed candidates through existing coding execution and verification hooks. |
| `packages/runtime/src/index.ts`: `SkillExecutionContext`, `SkillRuntimeOptions`, `hasActiveSkillWorkflowApproval`, `VerificationRecoveryContext`, `verifyRecoveryAuthority` | Live authority is owner/task/lease-bound and rechecked. Preserve `assertActive`, current approval checks, cancellation, verification-only recovery and persisted receipts. Do not map a candidate directly to a completed task. |
| `packages/coding/src/engine.ts`: `CodingEngineOptions.generateEdits(CodingContext)`, `CodingEngine.execute`, `CodingEngine.verify` | `generateEdits` is a narrow proposal seam. `CodingContext` provides task ID, goal, base commit, source files/hashes/editability and signal. The engine owns isolated worktrees, baseline/result sandbox checks and independent verification. A later adapter may translate a validated candidate into its proposal shape, with truthful provenance/accounting. |
| `packages/coding/src/project.ts`: `inspectProject`, `ProjectInspection` | Supplies `baseCommit`, `snapshotHash`, files with hashes and editability information for the current small clean Git-project workflow. The supervisor must add the trusted project ID and bind declarations/evidence to that inspection. |
| `packages/coding/src/security.ts`: `safeRelative`, `editablePath`, `snapshotHash`; internal path/read guards | Existing code resolves roots, disallows sensitive paths/links and bounds source files. Phase 1 performs narrower lexical checks without invoking filesystem access. Preserve actual dispatch protections. |
| `packages/skills/src/gateway.ts`: `SkillToolContext`, `SkillToolAdapter`, `SkillGatewayContext`, `createToolGateway` | Gateway owns tool-schema checks, execution claims, resource locks, preimages, evidence and independent adapter `verify`. Existing `SkillModelAdapter.execute` returns schema-shaped data; it is not the new custom-model adapter or semantic verifier. |
| `packages/skills/src/execution-authority.ts`: `readSkillExecutionAuthority` | Rechecks pinned content, grants, scopes and roots at dispatch. A Phase 1 eligibility result must not replace it. |
| `packages/skills/src/permissions.ts`: `buildPermissionSnapshot`; `packages/skills/src/fallback.ts`: `decideRecovery` | Availability is distinct from authorization. Existing recovery relies on effect/idempotency evidence and fresh Runtime approval where required; candidate-generation attempt budgets do not supersede it. |
| `apps/server/src/skill-runtime.ts`: `createSkillRuntime`, `SkillRuntimeControls`, `skillGatewayTools` | Current composition builds the scheduler/gateway and forwards Runtime execution/verification hooks. Its optional `modelGenerate` branch is a provider-backed bounded JSON transformation. A future explicit bridge must preserve active authority and usage/evidence recording without changing the legacy branch implicitly. |
| `apps/server/src/assistant/brain.ts`: `DecisionSchema`, `BrainState`, `chooseTier`, `ModelPool` | Chat decisions and their incremental tool loop are separate from cognitive plans and Runtime tasks. Do not repurpose the execution contract as a chat decision or replace the reasoning model. |
| `apps/server/src/command-chat.ts`: `CommandChatConfig`, `createCommandChatControl` | Chat owns separate leases, `AgentAuthority`, receipts, waiting states and cancellation. `createProvider` replaces the chat reasoning boundary; it is not the Phase 1 executor seam. Existing `followTask` reaches Runtime approval/outcome/cancel for user-approved child work. |
| `apps/server/src/assistant/tools.ts`: `AssistantTools`, `createAssistantTools` | Code/studio actions create existing assisted Runtime tasks and preserve their approvals. Computer and Google Ads methods retain their own current controls. No new dispatch path should be added here for candidates. |
| `apps/server/src/assistant/verification.ts`: `assessBrowserVerification` | Independently checks fixed postconditions against trusted fresh browser evidence. This is a domain example of the required verifier boundary, not a generic TypeScript verifier. |
| `apps/server/src/inference.ts`: `createInferenceControl`, `InferenceControl`; `packages/providers/src/index.ts`: `ModelProvider`, `ModelRequest`, `ModelResult`, `ProviderError`; `inference-router.ts`: `InferenceRouter` | Existing free-text/provider routing supports FreeLLMAPI/Groq fallback; Ollama implements the same provider abstraction. Keep it unchanged and separate. None of these interfaces proves custom-model training provenance or provides this execution contract. |

Runtime task states are `queued`, `running`, `waiting_approval`, `verifying`, `completed`, `failed`, `cancelled` and `paused`. Chat also has its own waiting and terminal outcomes. These lifecycles must not be conflated with a candidate result. Existing provider retries concern inference requests; they do not authorize retrying file writes or external effects.

## Supervisor and gateway handoff requirements

The future supervisor must:

1. Select a sufficiently narrow planned subtask and resolve all architectural decisions before generation. Supply verified memory/research only as bounded context with provenance, not permission grants.
2. Capture the approved project identity, current clean base commit and repository snapshot using the existing trusted project inspection flow. Supply exact file contents/hashes, relevant declarations and pinned failure evidence.
3. Choose policy, acceptance criteria and budgets; supply actual available capability/tool information and track attempts independently of the model.
4. Validate the contract, route once, discover/use only the explicitly configured local model when selected, and propagate cancellation/lease expiry. Retain failures for diagnosis and escalation rather than retrying effects.
5. Validate the raw result with a trusted tokenizer. Re-read current workspace and current task/permission/capability state before handoff; reject stale references.
6. Pass eligible candidates to the existing coding/tool boundary under its current approval, lease, root, preimage and resource-lock checks. Keep the authority check and effect dispatch in the existing protected boundary to prevent time-of-check/time-of-use races.
7. Independently verify the resulting artifact and every required acceptance criterion, then let Runtime settle task status. Record verified learning through existing mechanisms only after this trusted outcome.

`WorkspaceVersionReference` is an opaque binding of project ID, base commit and snapshot hash. File hashes are SHA-256 of exact UTF-8 contents. `sameWorkspace` compares the binding; it does not inspect Git or prove that a supplied snapshot hash is authentic. Use the existing `snapshotHash` algorithm and full trusted snapshot when constructing references. A changed base commit, file hash, project identity or snapshot must invalidate the old candidate and require fresh context. The executor cannot refresh these values itself.

## Proposed handoffs to Phases 2–5

The specifications and ownership assignments for Phases 2–5 were not supplied. The following are required future responsibilities, not assertions about those phases' APIs, filenames or allocation:

- Model/data/training work must produce a locally runnable artifact trained from random initialization, versioned identity/provenance and task-family capability evidence.
- Inference/runtime work must implement `ExecutionModelAdapter`, exact tokenizer-based output accounting, bounded decoding, real cancellation/timeouts and artifact identity pinning. No endpoint or environment configuration is prescribed here.
- Supervisor integration must construct complete contracts, reconcile budgets and approvals with existing Runtime, and adapt candidates into the existing coding/Gateway interfaces.
- Evaluation/integration work must independently test schemas, routing, missing/stale context, permissions, invalid output, timeout/cancellation, semantic failure, and unchanged legacy behavior before enabling execution.

Coordinate those responsibilities with their owners before modifying shared files. No dependency on a file currently being developed by another phase is introduced here.

## Later shared changes and unresolved compatibility

Later integration will require an explicitly owned export/composition change, a trusted contract/context builder, local adapter implementation and approved candidate-to-coding bridge. The exact shared changes must be reviewed by their phase owners. Phase 1 does not edit the cognitive entrypoint, contracts, Runtime, providers, coding engine, Tool Gateway, server bootstrap/config/chat, worker, web application, database, manifest, lockfile or secrets.

Known gaps remain:

- `CodingEngineOptions.generateEdits` requires `CodingEdits`, which adds model and token usage to raw edits. A deterministic compiler has no model usage; a learned executor needs trustworthy local accounting. A later bridge must represent this honestly instead of inventing a Groq/model receipt.
- Existing Runtime model-run accounting contains Groq-specific metadata. Local/deterministic provenance must be supported explicitly before recording these candidates there; no schema columns are proposed or changed here.
- The existing project inspector/coding engine supports a small clean Git repository and a `node-test` profile. A single-file Phase 1 candidate does not extend its workspace, dependency, sandbox, framework or test support.
- Lexical symbol/import declarations and source hashes do not prove TypeScript type correctness, import resolution, adherence to all architectural decisions, or absence of dangerous behavior inside source text. Those are semantic/sandbox verification responsibilities.
- `output.language` is structurally fixed to TypeScript. `output.responseLanguage` also gates learned capability selection; actual natural-language summary conformity requires semantic review. Executor failure messages are untrusted diagnostics, not evidence of an action or permission decision.
- Exact token counting, training provenance, inference transport, durable execution-attempt accounting, atomic workspace/authority rechecks and semantic verifier implementations are host dependencies, not fake local success paths.
- The API is intentionally not production-wired. Compilation and behavioral compatibility remain unverified until later authorized checks are run. Concurrent edits may move referenced source line numbers; paths and symbol names are the integration anchors.
