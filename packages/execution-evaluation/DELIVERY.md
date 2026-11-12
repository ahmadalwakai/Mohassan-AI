# Phase 4 delivery record

## 1. Exact files created

All 36 files below are newly created within `packages/execution-evaluation/`. No file outside this directory was modified by this work. Other concurrent phases' changes and the preexisting unrelated worktree changes were left untouched.

- [packages/execution-evaluation/README.md](README.md)
- [packages/execution-evaluation/DELIVERY.md](DELIVERY.md)
- [packages/execution-evaluation/bridges/phase1-compiler.ts](bridges/phase1-compiler.ts)
- [packages/execution-evaluation/datasets/proposed-suite.manifest.json](datasets/proposed-suite.manifest.json)
- [packages/execution-evaluation/docs/data-and-baselines.md](docs/data-and-baselines.md)
- [packages/execution-evaluation/docs/integration-and-reporting.md](docs/integration-and-reporting.md)
- [packages/execution-evaluation/docs/metrics-and-acceptance.md](docs/metrics-and-acceptance.md)
- [packages/execution-evaluation/docs/repository-inspection.md](docs/repository-inspection.md)
- [packages/execution-evaluation/docs/source-review.md](docs/source-review.md)
- [packages/execution-evaluation/docs/verification-and-safety.md](docs/verification-and-safety.md)
- [packages/execution-evaluation/execution_evaluation/__init__.py](execution_evaluation/__init__.py)
- [packages/execution-evaluation/execution_evaluation/acceptance.py](execution_evaluation/acceptance.py)
- [packages/execution-evaluation/execution_evaluation/adapters.py](execution_evaluation/adapters.py)
- [packages/execution-evaluation/execution_evaluation/attribution.py](execution_evaluation/attribution.py)
- [packages/execution-evaluation/execution_evaluation/audit.py](execution_evaluation/audit.py)
- [packages/execution-evaluation/execution_evaluation/baselines.py](execution_evaluation/baselines.py)
- [packages/execution-evaluation/execution_evaluation/common.py](execution_evaluation/common.py)
- [packages/execution-evaluation/execution_evaluation/costs.py](execution_evaluation/costs.py)
- [packages/execution-evaluation/execution_evaluation/dataset.py](execution_evaluation/dataset.py)
- [packages/execution-evaluation/execution_evaluation/executor.py](execution_evaluation/executor.py)
- [packages/execution-evaluation/execution_evaluation/full_system.py](execution_evaluation/full_system.py)
- [packages/execution-evaluation/execution_evaluation/metrics.py](execution_evaluation/metrics.py)
- [packages/execution-evaluation/execution_evaluation/promotion.py](execution_evaluation/promotion.py)
- [packages/execution-evaluation/execution_evaluation/regression.py](execution_evaluation/regression.py)
- [packages/execution-evaluation/execution_evaluation/reports.py](execution_evaluation/reports.py)
- [packages/execution-evaluation/execution_evaluation/resources.py](execution_evaluation/resources.py)
- [packages/execution-evaluation/execution_evaluation/safety.py](execution_evaluation/safety.py)
- [packages/execution-evaluation/execution_evaluation/schemas.py](execution_evaluation/schemas.py)
- [packages/execution-evaluation/execution_evaluation/splits.py](execution_evaluation/splits.py)
- [packages/execution-evaluation/execution_evaluation/statistics.py](execution_evaluation/statistics.py)
- [packages/execution-evaluation/execution_evaluation/verification.py](execution_evaluation/verification.py)
- [packages/execution-evaluation/schemas/candidate.schema.json](schemas/candidate.schema.json)
- [packages/execution-evaluation/schemas/manifest.schema.json](schemas/manifest.schema.json)
- [packages/execution-evaluation/schemas/report.schema.json](schemas/report.schema.json)
- [packages/execution-evaluation/schemas/result.schema.json](schemas/result.schema.json)
- [packages/execution-evaluation/schemas/task.schema.json](schemas/task.schema.json)

## 2. Dataset schemas

Python contracts and five JSON schemas cover private tasks, public task projection, budgets, inert candidates, pinned dataset manifests, task observations and reports. Tasks include every requested identity, family, specification, context, symbols, expected behavior, acceptance criterion, hidden-test reference, capability, budget, language, safety and version field. Families A–F and all three tiers are supported. The shipped proposal has targets 200/60/20 and **zero actual tasks**; no complete dataset or benchmark result is claimed.

## 3. Baselines

The deterministic baseline requires a reviewed pure compiler bridge and emits explicit unsupported/unavailable responses. A source-only TypeScript adapter delegates to the actual Phase 1 compiler without duplicating transformation logic. Retrieval uses authorized audited training/reference records, deterministic local lexical cosine ranking, stable ID ties, recorded scores/IDs, copied/adapted/unsupported labels and independently validated scalar JSON substitutions. It has no neural/embedding service or arbitrary execution path.

## 4. Model adapter

`ModelIdentity`, `GenerationInvocation`, `ExecutorAdapter` and `LocalModelAdapter` define injected Phase 2 inference with tokenizer/checkpoint/configuration pins, complete-prompt token counting, context/output limits, deadline/cancellation and untrusted candidate/unsupported/missing-context responses. Resource and cost observations are supplied independently, never trusted from model metadata. No model architecture or training engine was added.

## 5. Independent verification

Static envelope/policy checks are distinct from authenticated dynamic structural, hidden behavior, regression, type/output, workspace, multi-file, concurrent-operation and idempotency/retry checks. Hidden test registrations predate evaluation and have independent origins. Sandbox attestations and receipts bind task, candidate, workspace, tests, nonce and budgets. No verified sandbox bridge is installed: missing evidence returns unavailable. Generated programs have no host-process execution fallback.

## 6. Safety and regression coverage

Thirteen proposed safety categories cover all requested unauthorized paths/writes, secrets, permissions, arguments, stale versions, cancellation, timeout, duplicates, unsupported capabilities, malformed outputs, disabled checks and protected contracts. Twelve regression scopes cover applications, contracts, frontend/backend, conditional customer/driver/admin consumers, database operations, permissions, Tool Gateway, Chat Loop, Runtime and mocked Ads workflows. These are case specifications and evidence interfaces, not executed suites. Rejection, prevention, failure and verified completion remain distinct.

## 7. Metrics and statistics

Separate arm/mode/family summaries include first-attempt/bounded/end-to-end success, structural/behavioral correctness, regression/false/unauthorized acceptance, output language, missing-context/unsupported precision/recall/accuracy, escalation/contribution, median/P95 latency, measured memory and component costs. Missing measurements remain null. Training costs require a separate receipt and explicit amortization horizon.

Comparisons pair exact task/manifest/condition/fixture pins, disclose unmatched/missing observations, compute absolute and meaningful relative differences, join shared project/template clusters and provide conservative weighted Hoeffding confidence intervals only under valid sampling conditions. Tiny/contaminated/incomplete samples cannot establish superiority. Family acceptance adjusts confidence for multiplicity; size and dataset-budget comparisons are descriptive.

## 8. Acceptance gates

Family-specific policies require complete held-out evidence, measurable benefit over configured deterministic/retrieval baselines, generalization, no unacceptable safety regression or unauthorized acceptance, independent external-call attribution, measured hardware compatibility and authenticated full-system verification. Critical permission/financial/database/live-advertising risks require stronger samples and distinct independent safety reviewers. False acceptance needs a separate authenticated audit when acceptance occurred. No authority means no eligibility.

## 9. Report formats

Machine-readable versioned JSON and human-readable Markdown include identities, manifest, configuration, hardware when measured, task observations, aggregates, comparisons, safety, attribution, gates, limitations, missing data and reproduction pins. Empty/unexecuted runs cannot be passed; complete reports require exact preregistered coverage. Raw candidates and hidden-test diagnostics are excluded from rendered attempt details. No fabricated evaluation report is shipped.

## 10. Integration requirements

Phase 1 needs a qualified supervised transport to the supplied source bridge. Phase 2 needs the injected inference/tokenizer mapping and trusted telemetry. Phase 3 needs a complete authorized inventory translator preserving distinct training/evaluation manifest identities and evaluation-origin exclusions. Sandbox use needs current isolation proof and independently authenticated receipts. The actual Cognitive Runtime fixture adapter remains pending. Phase 5 must reauthenticate eligibility, separately authorize activation, retain prior checkpoint/routing, stage rollout, monitor regressions and independently verify rollback.

## 11. Known limitations

This code is source-reviewed only; syntax, tests, runtime behavior and TypeScript bridge compatibility have not been executed or qualified. The 280 tasks, independent hidden test assets, concrete Python/TypeScript transports, fixture stores, telemetry collectors, evidence authentication and actual Runtime adapter are pending. Lexical similarity cannot prove absence of semantic or undisclosed contamination. Statistical power may be insufficient for the proposed suite. A Python callback cannot itself guarantee deadline enforcement or OS isolation. No live workflows, production state or Ads account was touched.

## 12. Execution and ownership confirmation

No builds, tests, typechecks, linting, Python imports/compilation, training, inference, benchmarks, installations, migrations or deployments were executed. No environment variables, package manifests, lockfiles, database schemas, existing applications or other phases' files were changed. No commit, merge, model promotion, activation or automatic training export occurred.

