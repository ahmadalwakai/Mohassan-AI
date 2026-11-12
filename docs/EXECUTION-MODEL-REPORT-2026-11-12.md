# Custom execution model: integration, training and verification report (2026-11-12)

**Final classification: `TRAINED_EXPERIMENTAL`.** See §15 for why it is not `LOCALLY_VERIFIED`.

Every number below was measured in this session on this machine; nothing is estimated unless it says so.
Evidence lives under `artifacts/execution-model-runs/` (git-ignored) and is referenced by path.

## 1. Five-phase audit

Pre-integration state was archived first: `artifacts/execution-integration/checkpoint-2026-11-12/`
(`phases-baseline.tar.gz` sha256 `25e5ec60…dfda12`, tracked diff, HEAD `08ea427`). All five phases were untracked
files on `feat/skill-engine`; none lived in another worktree or branch (the three worktrees are
goal-clarification, local-model and wasla-bridge and contain none of them).

| Phase | Location | Found | Status after this session |
| --- | --- | --- | --- |
| 1 Contracts/routing | `packages/cognitive/src/execution-model/` (`ExecutionTaskContractSchema`, `ExecutionContractValidator`, `DeterministicExecutionCompiler`, `ExecutionStrategyRouter`, `submitExecutionModelTask`, `ExecutionResultValidator`) | Implemented, untested, no consumer; `ExecutionModelAdapter` had no implementation | **Verified** by 9 vitest cases + live demo; deterministic registry has exactly `structured.replace-file.v1` |
| 2 Model/tokenizer | `packages/execution-model/execution_model/` (`ByteBPETokenizer`, `ExecutionModel`, `CausalSelfAttention`, `RotaryPositionEmbedding`, `RMSNorm`, `SwiGLU`, `load_checkpoint`, `InferenceEngine`) | Implemented, never run; **no checkpoint writer**; loader **unusable on PyTorch 2.10** (defect D1) | **Verified** (tokenizer/model tests, real training, strict load of exported checkpoints) |
| 3 Data/training | `packages/execution-training/execution_training/` (`generate_synthetic`, `prepare_dataset`, `train`, `CheckpointManager`, `ModelVersionRegistry`) | Implemented, never run; tokenizer and model factory **only as protocols** (no implementation); **no repair generator** for its own Stage C | **Verified** by 4 real GPU runs incl. checkpoint save/load/resume path; defects D2–D4 fixed |
| 4 Evaluation | `packages/execution-evaluation/execution_evaluation/` | Implemented, zero tasks shipped; `evaluate_executor` requires cryptographic fixture/sandbox/receipt authorities that do not exist | **Partially used**: `EvaluationTask`, `TaskResult`, `summarize_results`, `audit_splits`, lexical retrieval primitives run for real; authenticated-receipt harness **not** used (no authority implementation) |
| 5 Orchestration | `packages/execution-integration/src/` (`LocalProcessModelTransport`, `LifecycleBoundModelAdapter`, `ModelLifecycleCoordinator`, orchestrator/state/recovery) | Interfaces + logic, no package manifest, no implementation of containment/approval/state store; 1 type error | **Partially integrated**: wire protocol implemented end-to-end; containment adapter **missing** (see §12); orchestrator/state store/lifecycle approval **not exercised** |

Duplicated/incompatible contracts found: Phase 1 `ExecutionModelIdentity` vs Phase 5 `ModelIdentity` vs Phase 4
`ModelIdentity` (three shapes). Resolved at the boundary by `TransportBackedExecutionModelAdapter` (Phase 1 ↔ Phase 5)
without deleting either; Phase 4's shape is used only inside evaluation. Phase 1 `outputTokens` (serialized
envelope budget) vs Phase 5 `maxOutputTokens` (generated tokens) were conflated by my first adapter draft (caught by
tests, §3 D7).

## 2. Integration changes (exact)

New: `packages/execution-pipeline/` (`bridge.py`, `repair.py`, `tasks.py`, `worker.py`, `experiment.py`,
`evaluate.py`, `register.py`, `scripts/pipeline.py`, `tests/`, `requirements.txt`, `README.md`);
`packages/execution-integration/src/{phase1-model-adapter.ts, experimental-worker-transport.ts, phase1-contract-fixtures.ts}`;
`scripts/execution-sandbox-verify.ts`, `scripts/execution-demo.ts`, `tests/execution-model-integration.test.ts`.

Modified (phase code): `execution_model/checkpoint.py` (D1), `execution_model/tokenizer.py` (opt-in
`max_token_bytes`, `isolate_digits`), `execution_training/training.py` (D2), `execution_training/tokenization.py`
(`render_prompt_payload`, shared with inference), `execution_training/dataset.py` (explicit dedup budget),
`execution_training/synthetic.py` (`family_variant`, `index_start`), `execution-integration/src/transport.ts`
(exported `validateConfig`/`parseReady`/`parseResponse`), `execution-integration/src/coordination.ts` (D5),
`.gitignore`. Not modified: runtime, server, worker, providers, memory, skills, coding, Google Ads, database.

## 3. Defects found and fixed

| # | Defect | Evidence | Fix |
| --- | --- | --- | --- |
| D1 | Phase 2 loader refuses **every** checkpoint on PyTorch 2.10: it required an empty safe-globals list, but torch registers 3 internal types at import | `get_safe_globals()` → `_rebuild_njt`, `_MeshLayout`, `NestedTensor` | Tolerate only `torch.*` entries; application-added globals still refused (regression test) |
| D2 | Phase 3 aborts fp16 training on the first gradient overflow, defeating loss scaling | smoke run failed `NONFINITE_GRADIENT` at step 161 | Skip window, lower scale, replay; >25 consecutive still fails; counted in report |
| D3 | No checkpoint retention: interval 2 wrote 48 GB in ~10 min and nearly filled the disk | `du` 48G, free fell to 44 GB | Not changed in code (Phase 3 deliberately keeps all checkpoints); runs use large intervals; smoke checkpoints deleted. **Open** |
| D4 | Low-cardinality synthetic domains make "held-out" items exact copies of training items | 10/10 `value_preservation` validation items duplicated training | Exact repeats are dropped from later splits and counted in `dataset-summary.json` |
| D5 | `coordination.ts` TS7006 broke `npm run typecheck` | `tsc` exit 2 | Typed callback |
| D6 | Template-merging tokenizer: 256-byte tokens swallow values; model cannot copy unseen values | run A: names emitted as `repairDelta200` for `repairDelta90013` | `isolate_digits` + `max_token_bytes=16` (runs B, C) |
| D7 | Phase 1 serialized-candidate token budget conflated with worker generation cap → every learned task `budget_exhausted` | vitest | Separate limits in adapter |
| D8 | Worker requested 96 new tokens even when the prompt left less context → `model_process_failure` | demo case C on run B | Cap to remaining context (worker and evaluator) |
| D9 | AppContainer denies Node's package-scope lookup above the work root, so `.ts` modules never load | `ERR_INVALID_PACKAGE_CONFIG` | Verifier ships its own `package.json` |

## 4. Tests

| Suite | Result |
| --- | --- |
| `pytest packages/execution-pipeline/tests` (tokenizer round-trips: Arabic, English, TypeScript, JSON, whitespace, escaping, unfamiliar identifiers, emoji/combining, arbitrary bytes; identity tamper; param count; seeded random init; causal masking; init loss ≈ ln V; overfit; context limit; CPU/CUDA agreement; greedy determinism; factory; export→strict load; tamper refusal; tokenizer mismatch; repair oracle; prompt parity; out-of-domain refusal; safe-globals) | **30 passed** |
| `vitest tests/execution-model-integration.test.ts` (routing, typed fields only, eligibility, repair evidence passthrough, deterministic isolation, missing context, unsupported, scope escape, timeout/cancel, no retry, uncontained transport refusal) | **9 passed** |
| `tsc --noEmit -p tsconfig.json` | **pass** (was failing before D5) |
| Full repository `vitest run` | **150 files / 1983 tests passed** (1450 s) |
| `npm run sandbox:check` | baseline isolation verified; G5 (LPAC public-resource) **BLOCKED** — pre-existing, unchanged |

Not run: Playwright e2e, `npm run build` of the web app (no web code changed), Phase 5 orchestrator/state-store
tests (none exist; no store implementation exists).

## 5. Hardware (measured)

Python 3.11.9; isolated `.venv-execution` with torch 2.10.0+cu126 (system Python's torch is CPU-only — CUDA was
**unavailable** until the isolated CUDA build was installed). GPU: NVIDIA GeForce RTX 3050 Ti Laptop, compute
capability 8.6, 4,294,508,544 bytes total, 3,458,465,792 free at start. bf16 supported and selected automatically.
RAM 33.3 GB total / 13.2 GB free at start. Disk C: 111 GB free at start (fell to 44 GB during D3, restored to 103 GB).

## 6–8. Training runs

All models: architecture `dense-decoder-v1` preset A (6 layers, d=384, 6 heads, SwiGLU 1024, RoPE, RMSNorm, tied
embeddings), **random initialization, seed 1729**, AdamW lr 6e-4 cosine→10%, wd 0.1, bf16 autocast, microbatch 16,
curriculum A→B→C with replay. Tokenizers trained from scratch on each run's training split only.

| Run | Data (train/val/test) | Tokenizer | Params | Processed tokens | Steps | Tokens/s | Peak VRAM reserved | Wall | Final train loss | Val loss |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | 1,758 / 58 / 145 | 3,545 vocab, unconstrained (`cd47c4dd…`) | 11,983,104 | 2,999,977 | 12,242 | 3,921 (mb 16) | 333 MB | 844 s | 3e-7 | 6.29 |
| B | same as A | 2,182 vocab, digits isolated, ≤16 B (`5b07e444…`) | 11,459,712 | 5,999,898 | 4,076 | 14,420 | 724 MB | 461 s | 0.29 | 5.56 |
| C | 17,070 / 55 / 142 | 6,051 vocab, digits isolated, ≤16 B (`b5ebc023…`) | 12,945,408 | 8,999,747 | 6,124 | 11,055 | 839 MB | 936 s | 0.62 | 4.49 |
| C2 | same as C | same as C | 12,945,408 | 39,999,848 | 27,221 | 9,826 | 839 MB | 3,878 s | ~0.17 (last 5 logged) | 2.45 |

Unique training tokens: A 28,548; C 1,745,713. Throughput with microbatch 1 was 383 tokens/s (0.30 s/step, profiled).
Sanity check: a 113-example smoke run overfit stage A from loss 7.46 to 0.0004 (`artifacts/execution-integration/smoke-sessions-evidence/`).
No fp16 overflow skips occurred (bf16 has no scaler); D2 was exercised only in the fp16 smoke run.

## 9. Checkpoint identities

| Version | Inference checkpoint identity | Weights sha256 | Config identity |
| --- | --- | --- | --- |
| exec-a-2026-11-12 | `fbb531ea9c4643d5771a04f2184c6d58c1f43ab108291af34cc89363183ce989` | `44198d05…073d542c` | `ee56ff22…af503f6` |
| exec-b-2026-11-12 | `2f8496babf0e1a8de926efc00995d7e4e96bf946ae7927bdc8393022b2afa8ba` | `69f55462…0f756cf2` | `aba527f5…96e18` |
| exec-c9m-2026-11-12 | `3f35a7c0e9ee6c474b955ffe964262dda1832fa7c9c8af687012d61ff762a2f6` | `cd9c7ee1…2b12c1f` | `367e5c66…22ba4f` |
| exec-c40m-2026-11-12 | `bfd7f6861e08a1f24fd9b7b59e5e938fafead689bd7a10261e598a97d6f364fb` | `605390b3…834e46f9` | `367e5c66…22ba4f` |

All four are registered in `artifacts/execution-model-runs/registry` with rollback chain c40m → c9m → b → a. Each has
an independent evaluation receipt with `passed: false`, and all remain `unpromoted`.

Each is ~46 MB float32, exportable, and loads only through Phase 2's strict loader with an exact tokenizer and config.

## 10–11. Independent evaluation and baseline comparison

Held-out = Phase 3 `test` split (evidence scope `test`, never tokenized for training, never seen by the tokenizer).
Same prompt text, same 96-token budget, same verifiers for every arm. JSON/text families verified by Phase 3's
domain oracle; TypeScript families **executed in the AppContainer sandbox** (network denied, isolation verified,
receipts in `evaluation/report.json`) against probes computed by an independent oracle.

**Leakage audit (Phase 4 `audit_splits`): not clean** — 0 exact duplicates but 28,638 near-duplicate input pairs.
Held-out items are value-disjoint instances of the *same templates*. These numbers measure generalization to unseen
values, **not** to unseen task types.

| Arm | Run A | Run B | Run C (9M) | Run C2 |
| --- | --- | --- | --- | --- |
| Deterministic compiler | 0.0% (by construction) | 0.0% | 0.0% | 0.0% |
| Lexical retrieval (training split) | 11.0% | 11.0% | 12.0% | 12.0% |
| Trained model, first attempt | 6.2% | 10.3% | 8.5% | **16.9%** (24/142) |
| Trained model, ≤1 bounded repair | 6.2% | 10.3% | 8.5% | 16.9% |
| Model structural validity | 60.0% | 46.9% | 52.1% | 46.5% |
| Model on TypeScript implementation / repair | 0/25, 0/25 | 0/25, 0/25 | 0/25, 0/25 | 0/25, 0/25 |
| Model median / p95 latency (CUDA) | 89 / 178 ms | 114 / 191 ms | 108 / 156 ms | 87 / 159 ms |

Runs A–C: all model successes are `boundary_conditions` boolean outputs (A 9/25, B 15/25, C 11/23) plus 1
`type_transform` (C). These are at or below retrieval and near chance. C2 is the first run above retrieval:
`boundary_conditions` 12/23 (retrieval 17/23) and `type_transform` **12/19 (retrieval 0/19)**. That is real
generalization to unseen values inside a seen template, and nothing more. It scored 0 on structured operations, identifier
copy, TypeScript and repair. Evaluation digest `f3a67597…81294283`. Bounded repair never triggered: the
model's wrong function names left the sandbox no exported function to probe, so no concrete failure evidence
existed (the repair step correctly refused rather than guessing).

Missing-context and unsupported-task accuracy: **not measurable at the model level** (those synthetic domains have
≤3 distinct instances, so none could be held out). At the Phase 1 contract level both are deterministic and pass
(vitest + demo). Unauthorized-action acceptance: 0 in the demo (scope escape, stale, denied all refused).
External reasoning contribution: 0 calls. Cost per successful task: $0 external spend; electricity not measured.

Phase 4's `paired_comparison` refused to pair rows because they lack its provenance pins (task/conditions/manifest/
fixture digests). That refusal is recorded, not bypassed.

## 12. Local demonstration and security findings

`scripts/execution-demo.ts` (supervisor stand-in → Phase 1 router → real Python worker via the Phase 5 protocol →
Phase 1 validation → permission observation → compare-and-swap write in a disposable temp workspace → supervisor-
authored test in AppContainer).

### 12a. Demo results, best checkpoint (exec-c40m, `inference-train-40m`)

Evidence: `artifacts/execution-model-runs/run-2026-11-12-c/demo-evidence.json`. **8/10 passed.**

| Case | Result | Observed |
| --- | --- | --- |
| A structured spec → deterministic operation | PASS | deterministic route, sandbox tests pass |
| B TypeScript implementation (local model) | **FAIL** | learned route, candidate accepted structurally, sandbox tests fail. Output was `export function applyDeltaapplyDelta` (truncated, wrong) |
| C repair from failure evidence (local model) | **FAIL** | failure reproduced first; candidate `export function repairDelta"]}`; tests fail |
| Missing context | PASS | `missing_context` |
| Unsupported operation (react) | PASS | `unsupported` |
| Fields outside trained domain | PASS | `unsupported` |
| Stale workspace at dispatch | PASS | `stale_workspace` |
| Permission denied | PASS | `permission_required` |
| Write outside allowed files (`.env`) | PASS | `rejected` |
| Cancellation before generation | PASS | `cancelled` |

Every boundary held. The two model-dependent cases failed, and the sandbox tests caught both. A wrong candidate
was never accepted. D8 (the case C worker crash) is confirmed fixed: case C now yields a candidate instead of
`model_process_failure`.

D10: the demo hard-coded the model label `run-2026-11-12-a` whatever checkpoint it was given. The label now comes
from the checkpoint path. The first attempt used `/` in the version, and Phase 1's schema rejected it
(`invalid_format`), which is correct behaviour; it now uses `.`.

Security findings:
* **Model process is not contained.** Phase 5's `LocalProcessModelTransport` correctly demands OS containment evidence
  (network/filesystem/memory/CPU/process limits). No such adapter exists for a Python process on this machine. The demo
  uses `ExperimentalUncontainedWorkerTransport`, which requires an explicit acknowledgement, is not exported from
  `execution-integration`'s index, and is not wired into runtime routing. The worker has no tools, no network client and
  no writes, and generated code never runs outside AppContainer, but this is still a gap.
* Generated code ran only inside AppContainer (`isolationVerified: true`, `network: denied` on every receipt).
* Sandbox gate G5 (LPAC public-resource isolation) remains BLOCKED as before this session.
* The Cognitive Runtime is **not** routing to the custom model. No production route, provider, Google Ads path or
  database was touched.

## 13. Open-source readiness — publication BLOCKED pending owner decision

* Repository has **no LICENSE file**; `package.json` is `"private": true`; single committer identity. Licensing
  authority could not be confirmed, so no license was added.
* Recommendation if the owner approves: **Apache-2.0** for source (patent grant; compatible with all dependencies) and
  the same for weights; a dataset card stating the data is fully synthetic and generator-reproducible.
* Model-path dependencies: torch 2.10.0 BSD-3-Clause (the cu126 wheel bundles NVIDIA runtime libraries under NVIDIA's
  terms — not redistributed with weights), numpy BSD-3-Clause, pytest MIT; transitive: sympy/mpmath/networkx/jinja2/
  markupsafe/fsspec BSD, filelock/pluggy/iniconfig MIT, packaging Apache-2.0 OR BSD-2, typing_extensions PSF-2.0.
* Data provenance: 100% local deterministic generators (`execution-synthetic-v1`, `execution-repair-v1`); no
  external, customer or production data; every example has an independent oracle receipt. Authorization record:
  `repository-owner-local-experiment` (an experiment record, **not** a publication licence).
* Model card, dataset card, configs, reproduction and inference instructions: `packages/execution-pipeline/README.md`
  and this report. Nothing was published.

## 14. Activation and rollback

Versions A, B, C9M, C40M are registered in Phase 3's immutable registry (`artifacts/execution-model-runs/registry/`) with
rollback chain C40M → C9M → B → A, each bound to its evaluation. Pre-declared gate: TypeScript behavioral ≥ 90% and
overall ≥ 80%. **All failed; all `unpromoted`, not eligible for promotion review.** No activation was performed;
Phase 5's `ModelLifecycleCoordinator` would additionally require an approval authority and a state store, neither of
which is implemented.

## 15. Remaining limitations and readiness decision

* The trained models do **not** yet perform the target tasks on held-out values. The root causes observed:
  tokenizer value-merging (fixed), memorization of small data (reduced with 10× data), and underfitting at the token
  budgets used. C2 (40M tokens, ~23 epochs) cut val loss from 4.49 to 2.45 and beat retrieval overall (16.9% vs 12.0%),
  but still 0/50 on TypeScript and repair: the code-generation families need far more capacity, data or tokens than a bounded laptop run provides.
* Held-out evaluation is same-template only (Phase 4 audit not clean). Unseen-template generalization is unmeasured.
* No containment adapter for the model process; no Phase 5 state store/approval authority; Phase 4 authenticated
  harness unused.
* GPU training is non-deterministic (`deterministic_algorithms=False`); data/tokenizer/init are deterministic.
* Only preset A (~12–13M params) was trained. Larger presets were not justified by evidence.

| Requirement | Met? |
| --- | --- |
| Architecture from source, random init, scratch tokenizer, no pretrained anything | Yes (tested) |
| Working training and inference, versioned exportable checkpoints | Yes |
| Integrated, validated execution contracts across TS/Python | Yes (protocol + adapter + tests) |
| Independent evaluation with baselines | Yes (with the stated deviations) |
| Real task independently verified end-to-end | Pipeline: yes (case A, deterministic). By the model: **no**. Cases B and C produced wrong code, and the sandbox rejected it (§12a) |
| Safe local execution | Generated code: yes (AppContainer). Model process: **not contained** |

**Classification: `TRAINED_EXPERIMENTAL`.** `LOCALLY_VERIFIED` would require the model itself to produce
independently verified correct results on held-out TypeScript tasks. `PRODUCTION_READY` is not claimed.
