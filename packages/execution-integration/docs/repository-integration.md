# Repository integration map

Status: **IMPLEMENTED** source-inspection documentation; **ADAPTER_REQUIRED** for every production bridge described here; **INTEGRATION_PENDING** for composition and shared DTOs; **VERIFICATION_PENDING** for type and behavior compatibility. Inspection occurred on 2026-11-12 while the other four phases were being developed. File presence is an observation, not evidence of a stable exported API or working integration. No existing source was changed and no executable readiness probe was called.

## Existing authority and planning

| Actual path | Actual symbols | Integration consequence |
| --- | --- | --- |
| `packages/cognitive/src/index.ts` | `GoalCompiler.compileInput`, `GoalCompiler.verifyDefinition`, `ModelRouter.route`, `StrategyPlanner.normalize`, `UncertaintyEngine.assess`, `PlanningEngine.generate`, `verifyPlanningResult`, `PlanningError` | The Cognitive package remains the planning and reasoning authority. Its normalized plan is not an execution approval. The new supervisor boundary receives an already approved local assignment; it must escalate any requirement for new reasoning to this owner. |
| `apps/server/src/ai.ts` | `createAIControl`; returned `engine`, `status`, `verify`, `plan`, `generateSkill` | Existing server composition builds `PlanningEngine` with configured Groq providers. `plan` forwards the signal, progress and memory/skill context. `generateSkill` is an existing bounded provider call, not a custom model transport. |
| `packages/contracts/src/index.ts` | `RawCognitivePlanSchema`, `CognitivePlanSchema`, `PlanningResultSchema`, `PlanStepSchema`, `CapabilitySchema` | A plan has acceptance criteria and capability availability. An unavailable capability must remain unavailable rather than becoming an implied learned-executor capability. |
| `apps/server/src/app.ts` | `createApplication`, `runtimeOptions`, `new Runtime(...)` | The server currently supplies `plan`, `code`, `verifyCode`, `studioChange`, `verifyStudioChange`, `openBrowser`, `verifyBrowser` and `onTaskSettled`. No Phase 5 hook was added. |
| `apps/worker/src/index.ts` | module-level `runtime = new Runtime(...)`, `runtime.start()` and shutdown through `runtime.stop()` | The separate worker has its own explicit composition using the same controls. A future change must update both compositions consistently; updating only the server would be incomplete. |

`PlanningEngine.generate` accepts a raw goal and optional signal, progress callback, memory context and skill context. It returns a `PlanningResult`; it does not expose a public API that already matches the Phase 5 supervisor assignment. A bridge must map the actual plan, owner authority, immutable decisions and local context. This package does not create another planner, call an existing external provider, or infer approvals from a plan.

The concurrent Phase 1 directory appeared during a later source recheck. `packages/cognitive/src/execution-model/index.ts` now exposes local contract, router, compiler, model-adapter and result-validator modules. Their exact symbols and concrete schema differences are recorded in `cross-phase-contracts.md`; appearance of these files did not establish a completed bridge or authorize changing that phase.

## Runtime lifecycle, approvals, cancellation and recovery

The actual lifecycle owner is `Runtime` in `packages/runtime/src/index.ts`. Public entrypoints include `getCapabilities`, `snapshot`, `detail`, `createTask`, `approve`, `cancel`, `start`, `stop` and `tick`. `RuntimeOptions`, `SkillRuntimeOptions`, `SkillExecutionContext`, `SkillNodeExecutionContext`, `VerificationRecoveryContext` and `SkillRecovery` are actual interfaces. `hasActiveSkillWorkflowApproval` and `verifyRecoveryAuthority` are exported helpers.

The following methods are private implementation details, useful for mapping but **not importable adapters**:

| Private method | Existing behavior relevant to integration |
| --- | --- |
| `createTaskRecord` | Records the existing task and approval requirements. `createTask` uses an idempotency key. |
| `claim`, `lockedLease` | Claim and fence work by the current task lease. |
| `validApproval` | Rechecks owner, task, capability/version, input hash, exact scope, expiry and revocation. Continuing attempts match the consumed lease token; skill workflows and verification recovery have their own token binding. |
| `skillExecutionContext` | Supplies a signal and an `assertActive` boundary for the exact Runtime authority. |
| `runPlanning`, `runCoding`, `runStudioChange`, `runBrowser`, `runSkill`, `runSkillNode` | Dispatch configured capability-specific controls. These are not a public arbitrary-tool runner. |
| `transitionToVerification`, `verify`, `finish` | Separate execution from acceptance. `finish` rechecks the exact approval under the task lock after asynchronous verification before committing completion. |
| `recoverExpired`, `recoverVerifiedTask` | Recover expired work and, where a trusted receipt is confirmed, perform verification-only recovery. Uncertain execution is not automatically replayed as a successful result. |
| `executionFailed` | Bounds attempts and uses delay. Paid/planning/coding/browser uncertainty requires renewed authorization; specified coding conflict codes are terminal. |
| `recordTerminalTask` | Constructs experience evidence from authoritative task results. |

`Runtime.cancel` sets cancellation state and aborts a tracked controller. `runTick` propagates `AbortSignal`, applies task timeouts and rechecks authorization during browser/skill execution. `stop` aborts outstanding execution and stops the loop. Phase 5 cancellation must be wired into this authority as well as its own transport and sandbox signal; merely changing a UI label is insufficient.

Actual shared task status values in `TaskStatusSchema` are `queued`, `running`, `waiting_approval`, `verifying`, `completed`, `failed`, `cancelled`, `paused`. They are not the Phase 5 orchestration state enum. `TaskSchema`, `TaskDetailSchema`, `TaskEventSchema`, `PlannedStepRecordSchema`, and `ModelRunSchema` describe the current API, while `WorkspaceSnapshotSchema` is the application dashboard snapshot, **not a filesystem version snapshot**.

`packages/database/src/records.ts` exposes `TaskRecord`, `TaskEventRecord`, `ApprovalRecord`, `RuntimeDatabase`, `TaskPlanStepRecord`, `TaskPlanDependencyRecord`, and `ModelRunRecord`. `packages/database/src/index.ts` exposes `createDatabase` and `migrate`. These do not establish a compatible Phase 5 persistence model. Phase 5 therefore injects storage and audit interfaces; it adds no database columns or tables and never invokes migration.

## Existing Tool Gateway and grants

`packages/skills/src/gateway.ts` exports `createToolGateway`, `SkillToolAdapter`, `SkillToolContext`, `SkillGatewayContext`, `SkillGatewayResult`, `SkillModelAdapter`, and `skillOutputSchema`. Its returned control includes `executeNode`, `verifyNode`, `beforeMappedExecute`, `recordChildResult`, `recordChildFailure`, `verifyRecoveredMapped`, `circuit`, and `tools`.

The gateway requires a `SkillNodeBinding` and scheduler claim tied to owner, task and lease. `SkillToolContext` includes `idempotencyKey`, `grantRoots`, `declaredPaths`, `assertActive`, `acquireResource`, `savePreimage`, `recordUsage`, and cancellation signal. `SkillToolAdapter.input` and `.output` are validated schemas; `.verify` must reread the real resource or an independently persisted receipt. A raw model tool name, JSON shape, or candidate permission statement is not authority to call `.execute`.

`packages/skills/src/execution-authority.ts` exports `readSkillExecutionAuthority`. It rechecks the active version and content hash, stored file integrity, current inspection, declared tools/scopes, current unrevoked unexpired grants, tool-specific roots, and script readiness. `packages/skills/src/grants.ts` exports `createSkillGrants` and `grantDto`; returned `create`, `revoke`, and `effective` preserve owner and content binding. `buildPermissionSnapshot` in `packages/skills/src/permissions.ts` expresses availability, not authorization.

`apps/server/src/skill-runtime.ts` is the existing composition point: `createSkillRuntime` builds the scheduler, file and application tool adapters, script executor and gateway, and returns `runtimeOptions`, `scheduler`, and `gateway`. `skillGatewayTools` describes installed wiring only. `runtimeOptions.mapChild` uses `skillChildTaskInput` from `apps/server/src/skill-tools.ts` to keep mapped operations in their existing Runtime capabilities. A future Phase 5 gateway adapter must retain this exact authority chain or return `capability_unavailable`. There is no compatible generic gateway adapter installed by this phase.

Approval-sensitive actions include file writes/deletion, database/API mutation, browser submission, publication, financial actions and computer control. The integration cannot broaden existing grants or make a read-only capability imply mutation. Missing permission wiring yields `permission_unavailable`, never implicit permission.

## Coding, workspace versions and isolation

| Actual path | Actual symbols and discovered guarantees | Remaining bridge work |
| --- | --- | --- |
| `packages/coding/src/index.ts` | Exports `CodingEngine`, `CodingEngineOptions`, `CodingRequest`, `CodingContext`, `SandboxRunner`, `inspectProject`, `createDemoProject`, `CodingError`, `editablePath`, `safeRelative`, `snapshotHash`. | Translate only a validated candidate into an authorized coding operation. The current engine itself calls injected `generateEdits`; it is not already a generic prevalidated-candidate executor. |
| `packages/coding/src/project.ts` | `inspectProject`, `ProjectInspection`, `ProjectFile`; inspection obtains a base commit and snapshot/file hashes. | Bind Phase 5 workspace identity, expected file versions and affected consumers to a fresh authoritative snapshot. |
| `packages/coding/src/engine.ts` | `CodingEngine.execute` uses a project lock, source/base checks, bounded expected-hash edits, isolated worktree, baseline/changed-snapshot sandbox receipts, diff checks and reviewed checkpoint. `CodingEngine.verify` rereads manifest, source/worktree snapshots, tree, checkpoint and diff. | Preserve conflict rejection, no blind overwrite, and independent receipt verification. A worktree alone is not an isolation guarantee. |
| `packages/coding/src/security.ts` | `safeRelative`, `editablePath`, `sensitivePath`, `credentialLike`, `assertNoLinks`, `canonicalDirectory`, `boundedText`, `sourcePaths`, `snapshotHash`. | Adapter must use canonical paths and reject traversal, links, unauthorized roots and stale preimages. |
| `packages/coding/src/git.ts` | `git`, `inspectGitMetadata`, `GitResult`; bounded argument-array subprocess, restricted environment and disabled hooks/config behavior. | Do not use a new unrestricted shell executor. |
| `packages/sandbox/src/index.ts` | `SandboxRunner`, `SandboxRunInput`, `SandboxTestResult`, `WindowsAppContainerSandbox`, `SandboxUnavailableError`, `snapshotHash`; runner methods `available`, `run`, `executableReadiness`, `runScript`. | `available()` can launch trusted probes and was not called. Source inspection cannot establish host readiness. |
| `packages/sandbox/src/gates.ts` | `verifyExecutableGates`, `ExecutableReadiness`, `ExecutableGate`, `ExecutableGateId`, `ExecutableGateEvidence`. Baseline plus all G1–G8 are necessary for executable readiness. | Require current trusted attestations; no caller or model assertion substitutes for verified gates. |
| `packages/sandbox/src/script.ts` | `SandboxScriptInput`, `SandboxScriptResult`, `SandboxOutputFile`, `validateSandboxScript`, `safeSandboxPath`, `collectSandboxOutputs`, `SandboxOutputError`, `sandboxScriptLimits`. | Maintain fixed entrypoint, bounded inputs/outputs, file restrictions and post-exit output integrity. |
| `packages/skills/src/executor.ts` | `createScriptExecutor`, `SkillScriptExecutor`, `SkillScriptSandbox`, `SkillScriptReceipt`, `SkillScriptRequest`, `SkillScriptError`, `SKILL_SCRIPT_RESULT_FILE`. | Use existing gated script path, never host `eval`, dynamic import or direct generated-code execution. |

The existing sandbox implementation is Windows AppContainer/LPAC based with native helper files `packages/sandbox/native/Runner.cs` and `packages/sandbox/native/run.ps1`. The executable gates cover a fixed native host, hard disk quota, Windows UI restrictions, Node permissions/native addon restrictions, LPAC/public resources, fixed script entry, bounded output collection, and UDP/named-pipe isolation. Process identity, filesystem/network restrictions, memory/process limits, timeout, snapshot binding and output evidence must be independently established. These are discovered implementation mechanisms, **not a claim that this machine passes the gates**.

The Node script/test sandbox is not automatically a suitable containment adapter for the Phase 2 Python process. Python process-tree ownership, memory/CPU/disk restrictions and network denial need a separately reviewed bridge. Without those guarantees the local transport must remain unavailable. No Python path or new environment variable is assumed.

Shared API changes require the supervisor to enumerate all affected consumers, required versions and regression/acceptance evidence. Neither a matching file hash for one application nor one successful isolated task establishes consistency of every consumer. Stale context and incomplete consumer coverage require replan/escalation.

## Chat and Runtime remain distinct

`apps/server/src/command-chat.ts` exports `createCommandChatControl`, `registerCommandChatRoutes`, `CommandChatConfig`, `ChatSkillContext`, and `commandChatMigration`. The control returns operations including `send`, `respond`, `approve`, `cancel`, `detail`, `screen`, `shutdown`, `restoreBrowser`, and `reviewBrowser`. Its local `think`/`thinkRouted`, `perform`, and `work` implement an interactive decision loop. `lockedExecution`, `runTransaction`, and `assertActive` fence the chat lease; `pauseBrowserAction` and `pauseHeld` save exact approval requests. Expired chat runs are failed without repeating uncertain effects.

`apps/server/src/assistant/brain.ts` exports `DecisionSchema`, `decisionSchema`, `decisionJsonSchema`, `BrainState`, `newBrainState`, `buildPrompt`, `chooseTier`, `ModelPool`, `noteAttempt`, `shouldAskForHelp`, `needsReview`, `sensitiveAction`, and the constrained `TOOLS`/`WORK_TOOLS` lists. This file supplies bounded decision schemas and prompt/state helpers; it is not an independent permission engine and should not become a custom-model authority source.

`apps/server/src/assistant/tools.ts` exports `AssistantTools`, `createAssistantTools`, `guarded`, `PendingWorkTask`, and `TaskOutcome`. Its work adapters create existing Runtime tasks and require `waiting_approval` through `pendingTask`; they later call Runtime approval/cancellation/outcome controls. Computer actions use existing Windows controls. The Google Ads adapters explicitly keep publishing approval in the owner's Google Ads section. The chat model cannot authorize publication merely by returning an action.

Chat approvals are `ChatApproveSchema` requests containing the exact approval ID and an explicit boolean. Runtime approvals are task-bound records with capability/input/lease authority. They are not interchangeable; any future chat presentation must call the established owner approval flow, not synthesize a Phase 5 grant.

## Provider selection remains unchanged

`packages/providers/src/index.ts` exposes `ModelProvider`, `ModelRequest`, `ModelResult`, `ProviderError`, `GroqProvider`, and reexports the FreeLLMAPI/Ollama/router/retry modules. `packages/providers/src/inference-router.ts` provides `InferenceRouter`, `RouteCandidate`, `RouterPolicy`, `RouteRequirements`, `RouteOptions`, `RoutedResult`; it handles eligibility, usage uncertainty and bounded provider retry/fallback. `apps/server/src/inference.ts` supplies `createInferenceControl`, with `candidates` and `routerFor` as local selection helpers. `createApplication` composes the existing chat/provider controls; no selector was changed.

Phase 5 custom execution is a separate local worker boundary. Groq, FreeLLMAPI and Ollama remain as configured. A custom-model timeout, unsupported task or missing context cannot silently route to any of them. New reasoning returns a structured escalation to the existing supervisor.

## Memory and learning boundaries

`packages/memory/src/index.ts` exports `createMemoryControl` and `MemoryError`; the returned operations include `create`, `correct`, `revoke`, `remove`, `sync`, `search`, `context`, `feedback`, and skill lifecycle controls. Memory writes validate ownership and evidence and reject recognized credential content. `sync` derives task-observed memory from settled tasks; it is called by the existing server and worker `onTaskSettled` hooks.

`packages/learning/src/experience.ts` exports `ExperienceInput`, `ExperienceExpectation`, `ExperienceObservation`, `ExperienceOutcome`, `classifyExperience`, and `recordExperience`. `classifyExperience` requires a prior expectation and a trusted observation with a reference; missing evidence produces `unverified`. `recordExperience` accepts existing `chat_run`/`runtime_task` source kinds and uses an owner/source identity with bounded attempt handling. It must not be called with a fabricated source kind or model-generated observation. `packages/learning/src/index.ts` reexports experience, evaluation, lessons, knowledge, training, context and PDF modules.

Phase 5 stores only policy-approved, independently verified outcome/failure/recovery metadata through an injected memory adapter. Existing text redaction is useful defense, not proof that every secret, customer datum or hidden evaluation answer has been excluded. Provenance, disclosure permission and training-use permission remain separate checks. This phase makes no model-weight updates.

## Exact future UI integration points

No UI file was changed. Current contracts do not expose the Phase 5 state, execution strategy, pinned checkpoint/tokenizer identity, activation status or rollback status.

| Actual component/symbol | Existing behavior | Future requirement, only after backend contracts are agreed |
| --- | --- | --- |
| `apps/web/components/assistant-app.tsx`: `AssistantApp`, conversation polling effects, `act`, `post`, composer stop button | Polls `/api/chat/conversations/:id`; posts exact `approve` and `cancel` actions. | Show linked execution progress and verified model identity without conflating chat loop status with local execution status. Preserve the exact approval ID and cancellation authority. |
| Same file: `Steps` | Renders `conversation.progress` and recorded `conversation.steps`. | Display safe task progress, routing choice, missing context and unsupported/escalated status from authoritative events. Do not render raw prompts/model permission claims. |
| Same file: approval, question and error rendering inside `AssistantApp` | Displays `conversation.approval`, `conversation.question`, and error state; approval posts `{approvalId, approved}`. | Explain exact pending scope and separate permission denial/unavailable, cancellation, execution failure and independent verification results. Avoid a successful-looking message for inconclusive/unavailable verification. |
| `apps/web/components/workspace.tsx`: `statusText`, `Status`, `TaskList` | Uses the existing `TaskStatus` enum. | Keep a separate execution-detail projection or explicitly version the shared DTO; do not force new states into an unmodified enum. |
| Same file: `TaskDialog`, `action(type: "approve" | "cancel")`, event timeline | Fetches `/api/tasks/:id`, renders `detail.events`, approval scope and `cancellationRequested`, posts task approval/cancellation. | Show execution strategy, selected model/version/checkpoint/tokenizer, candidate and execution stages, verification disposition and safe failure/recovery information. Preserve the existing task-bound controls. |
| Same file: `TaskResult` | Renders known capability result shapes. | Add an explicit reviewed result schema before displaying Phase 5 acceptance evidence. Show evidence references rather than model self-certification. |
| Same file: `CreateDialog`, `CapabilityCard` | Offers installed capabilities and enforces existing availability in the UI. | Never infer learned-executor readiness from model registration; use authoritative eligibility and installed adapters. |

Model activation and rollback require a separately authorized administrative presentation of target identity, independent evaluation, current/previous reference and approval outcome. There is no existing custom-model activation UI identified here; no new route or component name is invented.

## Pending shared-file work and final sequence

All work below is **INTEGRATION_PENDING**, outside the Phase 5 modification boundary:

1. Freeze Phase 1–4 exported schemas and versioning; compare them with the local adapters and document every conversion. Reinspect files that were absent or incomplete during concurrent work.
2. Review Phase 1 compiler/router binding and supervisor authority. Do not duplicate routing/compilation business logic in Phase 5.
3. Implement trusted adapters for existing task authority, atomic execution reservations/fencing, current grants, workspace versions, Tool Gateway and independent verifier. Decide persistence using actual Runtime owners; do not infer database compatibility from similar field names.
4. Establish a verified Python containment launcher and wire the Phase 2 protocol explicitly; pin executable and artifact identities. Approve any transport/schema changes in the owning phase.
5. Map Phase 3 registry and inference checkpoint export, and Phase 4 evaluation evidence with identity and independence verification. Train-loss metadata alone cannot qualify a version.
6. Add necessary package/export/workspace wiring only in a later coordinated change. No manifest or lockfile was created or edited here.
7. Under a separately authorized verification phase, perform type compatibility checks, adversarial adapter tests, cancellation/crash/idempotency checks, sandbox readiness checks and isolated end-to-end acceptance. No such command ran during this implementation.
8. Compose the same reviewed adapters in both `apps/server/src/app.ts` and `apps/worker/src/index.ts`, gated off by default until explicitly approved. Review chat linkage separately in `command-chat.ts` and `assistant/tools.ts`. No production entrypoint is altered in this phase.
9. Version DTOs in `packages/contracts` only if needed and update every required consumer, including both named web components. Confirm no required consumer is left inconsistent before acceptance.
10. Explicitly approve one eligible activation, retain the previous eligible version and atomically record the audit trail. A rollout must have independent acceptance and an explicit rollback target.

Rollback means revoking the new integration's dispatch authority, cancelling/fencing in-flight work, reconciling uncertain external effects, and restoring a previously approved eligible model reference through the lifecycle adapter. It does not undo external mutations automatically, overwrite unrelated files, replace production providers, or replay tasks. File/resource rollback must use the existing approved resource-specific control and matching preimages.
