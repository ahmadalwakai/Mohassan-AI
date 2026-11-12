# Mohassan AI — Phase 4 independent execution evaluation

This isolated, standard-library Python source package evaluates evidence about a specialized execution worker. The Cognitive Runtime continues to own reasoning, planning, permission decisions and final verification. Nothing here loads a checkpoint, starts a worker, runs an evaluation on import, changes production behavior, trains a model, or activates one.

**Delivery status:** implementation and read-only source review only. No builds, tests, typechecks, linting, inference, training, benchmarks, installations, migrations or deployments were run. The proposed dataset contains **zero tasks** and **zero results**. The target is 200 atomic tasks, 60 repository-context tasks and 20 end-to-end workflows. It is not a completed benchmark.

No npm, Python or workspace package manifest was created or changed. The source directory is `execution_evaluation/`; an eventual trusted host can add this package's directory to its import path without installing dependencies. No command-line runner is shipped. Cross-language exchange uses versioned UTF-8 JSON and JSON Schema Draft 2020-12.

## Implemented components

| Component | Source | Behavior |
| --- | --- | --- |
| Contracts | `schemas.py`, `schemas/*.schema.json` | Versioned private tasks, public requests, budgets, inert candidates and nullable observations. |
| Manifest admission | `dataset.py` | Pinned digests, exact inventories, stable identity history, explicit partial/completed dataset status. |
| Held-out protection | `splits.py` | Project/template isolation, exact and lexical near duplicates, lineage exclusions, bounded scan completeness, corpus binding. |
| Deterministic baseline | `baselines.py`, `bridges/phase1-compiler.ts` | Reviewed pure compiler bridge; actual Phase 1 compiler forwarding; explicit unsupported/unavailable responses. |
| Retrieval baseline | `baselines.py` | Authorized local lexical cosine ranking, deterministic ties, reference IDs/scores and copied/adapted labels; reviewed scalar JSON substitutions only. |
| Learned model | `adapters.py` | Version/checkpoint/tokenizer/configuration pins and injectable inference/token-counting protocol. No neural architecture or training engine. |
| Executor evaluation | `executor.py` | Fixed task/context/tool/budget/seed comparisons, authenticated disposable fixtures, bounded independent attempts; no hidden feedback or external repair. |
| Full-system evaluation | `full_system.py` | Stage/receipt/attribution protocol and harness; **actual Cognitive Runtime adapter pending**. |
| Behavioral verification | `verification.py` | Independent registered tests, authenticated fresh sandbox attestations and matched receipts; no unsafe execution fallback. |
| Safety and regressions | `safety.py`, `regression.py` | Static rejection, 13 proposed safety categories and 12 regression scopes; independent evidence assessment. |
| Reasoning attribution | `attribution.py` | Independent local, assisted local, externally completed, or unknown. Empty unobserved call logs are not proof of independence. |
| Resource/cost accounting | `resources.py`, `costs.py` | Measured usage with provenance; explicit missing values; separate training/inference/verification/external/other cost. |
| Metrics/statistics | `metrics.py`, `statistics.py` | Separate arms/modes/families, confusion matrices, paired differences and conditional conservative cluster confidence intervals. |
| Acceptance/audit | `acceptance.py`, `audit.py` | Family-specific evidence gates, independent acceptance audits, stronger critical-risk rules; missing authority prevents eligibility. |
| Reporting/handoff | `reports.py`, `promotion.py` | JSON/Markdown rendering and inert eligibility proposal; never deployment or activation. |

The module paths in this table are relative to `execution_evaluation/` unless another directory is shown.

## Dataset and visibility

Every task records a stable ID, family A–F, project and template families, input specification, approved context, allowed symbols, expected behavior, acceptance criteria, hidden test reference, capabilities, budget, output language, safety constraints, dataset version, tier and evaluator-only expected response. Families are:

- A: structured specification to operation.
- B: short TypeScript implementation.
- C: code repair from concrete failure evidence.
- D: skill composition.
- E: multi-file changes.
- F: full-stack workflow integration.

`EvaluationTask.public_view()` uses an allowlist and omits expected behavior, acceptance criteria, hidden-test reference and expected response. Dataset curators must separately review public context for embedded solutions or leaked test content. A schema cannot detect every answer disguised as documentation. Reference corpora and generated test proposals cannot become independent hidden-test proof.

`datasets/proposed-suite.manifest.json` is a proposal with empty entries, not an executable suite. Admission rejects empty datasets. Valid nonempty partial suites can support explicitly limited research; acceptance additionally requires dataset completion and family sampling requirements. Changing task content requires a new stable task ID; version history is checked against a separately retained registry.

## Evidence and execution boundaries

Only future explicitly configured calls to the harness initiate inference or fixture workflow adapters. They receive public task data. Candidate code remains inert in this package: there is no `eval`, `exec`, generated-code import, subprocess launcher, shell command, network client or local test-runner fallback.

Trusted adapters are integration code, not model-controlled plugins. A Python protocol or a boolean assertion is not an OS isolation guarantee. The host must authenticate fixture reset/permission evidence, supervise inference deadlines and cancellation, enforce token and resource bounds, and observe external calls. Python cannot forcibly stop a blocking arbitrary callback safely. Missing enforcement receipts prevent bounded-success credit.

Independent dynamic verification requires current authenticated sandbox evidence and pre-registered evaluator-owned test hashes. No such concrete bridge is installed here. The existing repository sandbox source describes AppContainer controls, but its probes were not run. Structural checks alone cannot establish behavioral correctness, type compatibility, concurrency safety or idempotency.

Executor retries receive only the preceding candidate and a deterministic seed; they do not receive hidden failures, oracle answers, model-generated replacement tests or external repairs. The time and output budgets are shared across attempts. Every executor arm has zero external reasoning budget; full-system arms may use the task's explicit identical reasoning allowance. Unsupported and missing-context responses are scored through classification metrics and never counted as executable task completion.

## Integration status

Phase 1's actual `DeterministicExecutionCompiler` is forwarded by a source-only TypeScript bridge. The Python/TypeScript transport remains pending and must be reviewed and supervised. The bridge does not duplicate compiler business logic.

Phase 2's local inference surface was inspected, but no import or model load was performed. `LocalModelAdapter` accepts injected generation and a tokenizer counter for the entire real prompt, including wrappers and previous candidates. The host translates actual Phase 2 responses into untrusted Phase 4 candidates.

Phase 3 manifests require an explicit translator and authenticated complete data inventory; training split hashes and independent evaluation manifest hashes are different identities. No evaluation failure export is provided. Phase 5 receives an eligibility proposal and must separately authenticate the evidence, authorize activation, retain rollback state and verify rollback behavior.

See [repository discovery](docs/repository-inspection.md), [data and baseline methodology](docs/data-and-baselines.md), [verification/safety](docs/verification-and-safety.md), [metrics/acceptance](docs/metrics-and-acceptance.md), [integration/report formats](docs/integration-and-reporting.md), [source review and remaining qualification](docs/source-review.md), and [exact delivery inventory](DELIVERY.md).
