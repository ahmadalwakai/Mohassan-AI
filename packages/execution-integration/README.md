# Phase 5 — isolated custom execution integration

This directory contains complete TypeScript implementations of the local orchestration, transport, lifecycle, memory and safety coordinators. It is **not enabled in the application**. Cognitive remains the planner, researcher, reasoning supervisor, permission controller and independent acceptance authority. The custom model proposes bounded local execution candidates only.

No existing package, application, manifest, lockfile, environment, database schema or runtime entrypoint was changed by this phase. There is deliberately no new package manifest and no workspace registration. The source entrypoint is `src/index.ts`; its exports have not been compiled or imported during this implementation.

## Status vocabulary

| Status | Meaning here |
| --- | --- |
| **IMPLEMENTED** | Source implementation exists inside this directory; this does not imply executed verification. |
| **ADAPTER_REQUIRED** | A trusted host boundary must be supplied; absence rejects the affected operation. |
| **INTEGRATION_PENDING** | Producer/consumer schema translation, composition or shared-file wiring is not installed. |
| **VERIFICATION_PENDING** | Builds, typechecks, tests, runtime probes and end-to-end behavior have not been executed. |

Overall: isolated implementation **IMPLEMENTED**; production integration **INTEGRATION_PENDING**; executable verification **VERIFICATION_PENDING**. Other phases evolved concurrently while this source was written. Discovered exports are documented as observations, never as proof of compatible imports or behavior.

## Files created

All paths below are relative to `packages/execution-integration/`.

| File | Implementation / documentation |
| --- | --- |
| `src/contracts.ts` | Versioned local adapter contracts, states, budgets, workspace/action/evidence schemas, durable claim/cancellation/dispatch requirements. |
| `src/safety.ts` | Bounded plain JSON snapshots, hashes, immutable snapshots, safe classified errors, cancellation and deadline helpers. |
| `src/supervisor.ts` | Supervisor assignment metadata validation and immutable snapshots; no planning or provider calls. |
| `src/state.ts` | Explicit transition graph, transition guards and an isolated in-memory reference store. |
| `src/audit.ts` | Structured correlated events with hashed identifiers and bounded sink calls. |
| `src/strategy.ts` | Delegation to Phase 1 validation/routing/compiler/capability decisions. |
| `src/coordination.ts` | Candidate, approval, workspace, gateway, sandbox and independent verification coordinators. |
| `src/orchestrator.ts` | Task creation, state machine, bounded generation/repair, approval resumption, dispatch, verification and cancellation. |
| `src/recovery.ts` | Failure classification and bounded recovery policy. |
| `src/reconciliation.ts` | Independent external-state reconciliation; no dispatch or automatic retries. |
| `src/transport.ts` | Local, identity-pinned, bounded structured process transport and containment contract. |
| `src/model-adapter.ts` | Explicitly active lifecycle selection, task-scope authorization, transport factory and structured codec bridge. |
| `src/lifecycle.ts` | Independent promotion gates, transaction-bound activation approval, version selection and rollback. |
| `src/memory.ts` | Independently verified, privacy-approved experience storage with live write authority and idempotency. |
| `src/diagnostics.ts` | Passive adapter/readiness diagnostics and safe task projections; no probes or model launch. |
| `src/index.ts` | Local exports only. |
| `README.md` | Delivery inventory, status, limitations and final integration sequence. |
| `docs/architecture.md` | Architecture, complete state graph, safety boundaries and adapter obligations. |
| `docs/repository-integration.md` | Actual repository paths/symbols, Chat/Runtime differences and exact future UI points. |
| `docs/cross-phase-contracts.md` | Per-interface producers, consumers, schemas, versions, errors, cancellation, security, ownership and pending compatibility. |
| `docs/transport.md` | Exact local protocol, message examples, process limits, cleanup and Python mapping gaps. |
| `docs/lifecycle-memory.md` | Lifecycle transaction/expiry requirements, approval, rollback, safe memory and discovered Phase 3/4 APIs. |

## Implemented safety behavior

The orchestrator requires a supervisor assignment, delegates business semantics to Phase 1, snapshots all inputs, selects an allowed strategy and validates every proposed action through a trusted tool or sandbox adapter. Permissions bind owner, task, workspace, plan, operation, exact target versions, required scopes, argument hash, full action hash (including artifact digest) and candidate hash. A missing permission adapter returns `permission_unavailable`; a missing gateway returns `capability_unavailable`. Model assertions cannot create a grant.

Before dispatch, the coordinator requires a current workspace snapshot and an enforceable workspace mutation lease, repeats permission and model eligibility checks, and atomically records the execution manifest. One batch can start per task. Each operation is unique, and overlapping mutation targets within a candidate are rejected. A thrown error, lost response, cancellation or restart never clears this execution ledger. No state-changing batch is automatically replayed.

The learned strategy requires an explicitly active lifecycle version, full model/tokenizer/checkpoint hashes and evaluation/registry revisions. The local transport does not choose a model or Python executable. A trusted factory must verify actual local artifact digests and supply an OS containment adapter before launch. There is no public endpoint, download, external inference fallback or unrestricted native launcher.

Generated code is represented by an artifact reference and SHA-256 digest. Only the injected sandbox boundary may resolve and execute it after checking that digest and attested network/filesystem/CPU/memory/disk/process/output/timeout controls. Plain host `spawn`, an available worktree, or `SandboxRunner.available()` is not sufficient evidence of isolation.

Completion requires independently produced evidence for every verification requirement and execution receipt. Structural, permission-boundary, workspace-consistency and expected-output requirements are mandatory; behavioral and regression requirements are supported and must be required by the supervisor wherever the task needs them. Each affected shared-contract consumer is tied to the exact contract ID/version and workspace-consistency evidence. The generator cannot supply the verifier identity or grant itself a verified status.

Candidate repair is allowed only before dispatch, under generation/recovery limits, with a new supervisor context revision and new evidence. Phase 1 validates the revised context again; a changed route/model requires replan. Unsupported tasks, missing context, stale workspaces and new reasoning remain explicit outcomes. External uncertainty requires real-state reconciliation. Even a confirmed `not_applied` observation only allows the supervisor to consider a newly authorized task; it does not replay the old one.

Activation and rollback require explicit existing approval consumed in the same serializable transaction as version/evaluation revalidation, state CAS and lifecycle audit. Commit must occur before both evaluation and approval expiry. Training loss cannot satisfy promotion gates. No production model setting is written.

Experience memory is a separate explicit coordinator. It reads trusted evidence references, runs privacy/provenance policy, permits only allowlisted verified metadata and writes under a live scoped authorization lease. It does not automatically run after every task, does not store model claims as facts, and records `trainingUse: 'forbidden'`. Weight changes remain a separate training/evaluation cycle.

## Pending shared-file work and integration sequence

No items in this sequence were performed. Their ownership and exact discovered entrypoints are detailed in the two repository/cross-phase documents.

1. Freeze Phase 1–4 public schemas and review explicit lossless translations into the local Phase 5 interfaces. Phase 1's single replacement/edit candidate is not Phase 5's action batch. Phase 2's byte output is not the JSON proposal protocol. Phase 3's training checkpoint is not automatically a Phase 2 inference checkpoint.
2. Implement host adapters for `CognitiveSupervisorAdapter`, `PhaseOneAdapter`, existing approval authority, workspace identity/fencing, existing `createToolGateway`, existing coding/sandbox controls and an independent verifier. Do not expose private Runtime methods or re-create a bypass around task leases.
3. Implement durable `StateStore` operations, cancellation fencing, protected approval-proposal storage, persistent gateway receipts and an audit sink. The reference in-memory store must not be selected for production. Choose schema changes only in a separately authorized shared integration phase.
4. Implement Phase 3 registry / Phase 4 evaluation storage translation and transactional activation approval; review commit constraints and rollback targets. Write the explicit training-to-inference checkpoint export mapping. Keep every new version inactive by default.
5. Add a local Python protocol host, a trusted artifact/hash resolver, a `StructuredModelCodec` and verified process-tree containment. No direct Python executable path or extra environment variable has been assumed.
6. Implement the independent experience-evidence, privacy, permission and memory-store adapters. Map existing memory/learning source kinds without inventing database columns or allowing evaluation answers into training memory.
7. In a later authorized verification phase, compile/typecheck, exercise unit and integration scenarios, review security gates, verify crash/revocation/cancellation/timeout behavior, then test deterministic and learned flows against independent evidence. Verify all required shared API consumers.
8. Only after these gates, review separate package/workspace registration and controlled server/worker composition. Any future UI projection belongs in the exact existing components documented below. No automatic Chat Loop or Runtime replacement is part of this package.
9. Independently approve an eligible registered version through lifecycle activation. Roll out under explicit bounded capability grants. Keep prior references and auditable rollback approval available.

## Known limitations and rollback

- All source remains **VERIFICATION_PENDING**. Source review found and corrected several race/identity boundaries, but cannot establish compilation or runtime behavior.
- Host adapters are trusted security code. TypeScript interfaces do not prove OS isolation, transactional fencing, correct external-state reconciliation or truthful evidence. A dishonest/unimplemented adapter is outside this layer's guarantees and must not be installed.
- An independently verified Python containment implementation and stdio host do not exist in this directory. The process transport intentionally cannot launch without the former.
- `InMemoryStateStore` has no crash durability, automatic abandoned-claim takeover or production concurrency guarantees beyond one process. A production adapter must maintain durable one-time dispatch and protect stored proposal context. Interrupted execution stays unresolved until supervised reconciliation.
- Task-state writes and the generic execution audit sink are separate injected operations. Sink failures are surfaced; already committed states remain readable, and completion events are emitted only after a successful completion CAS. Production integration must add durable audit delivery/reconciliation (for example, a reviewed storage outbox), without assuming new tables here. Lifecycle audit is explicitly atomic with lifecycle storage.
- Effect adapters must enforce cancellation at the actual effect boundary, preserve receipts, terminate/fence late work and acknowledge cleanup. An outer promise timeout alone cannot undo an external mutation. Workspace release must retain isolation/fencing until in-flight work is stopped; cleanup failures must be quarantined by the host. State/lease storage adapters must bound their own I/O.
- Approval waits consume the original total deadline. Exact proposals are retained for resumption and revalidated; any supervisor/plan/context change requires replan. Partial batch failures never replay the remaining operations automatically.
- There is no general generated-code runner, external model fallback, new reasoning engine, model training, automatic activation or automatic memory-to-training bridge.

Today rollback consists of leaving this unreferenced directory unused: production was never changed. A future deployment rollback must stop new claims, cancel/fence active work, reconcile uncertain effects and explicitly approve a still-eligible prior model reference. Model rollback never undoes filesystem, database or external API mutations; those require existing tool-specific recovery authority and evidence.

**Verification performed:** repository reads and manual source review only. **Not performed:** builds, tests, typechecks, linting, training, benchmarks, package installations, migrations, deployments, inference/model launches, commits or merges.
