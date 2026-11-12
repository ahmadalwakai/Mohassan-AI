# Repository inspection and phase handoffs

This is a read-only inspection snapshot taken at the start of Phase 2 on
2026-11-12. Other conversations are developing other phases concurrently. The
boundaries below describe files actually inspected, not a promise that another
phase's in-progress contracts have remained unchanged.

## Existing boundaries

| Inspected source | Observed behavior and boundary |
| --- | --- |
| `packages/cognitive/src/index.ts` | `GoalCompiler`, `ModelRouter`, `StrategyPlanner`, uncertainty handling and plan verification; uses `ModelProvider` and Zod contracts. Global planning stays here. |
| `packages/runtime/src/index.ts` | Task leases, grants/approval checks, cancellation, capability dispatch, and distinct execution/verification callbacks in `RuntimeOptions`. An execution-model candidate is not a verified runtime result. |
| `packages/providers/src/index.ts` | `ModelRequest` has goal/system/maxTokens/signal/structured/image; `ModelResult` has text/model/usage; `ModelProvider.generate` is asynchronous TypeScript. This Python package does not implement or change that interface. |
| `packages/providers/src/inference-router.ts` | Bounded provider routing/retry policy, capability advertisement, cancellation, optional external text validation, usage receipts. No automatic addition of this model to routing. |
| `packages/providers/src/ollama.ts` | Existing loopback HTTP model provider. It wraps a separate local model server; it is not a custom neural architecture/tokenizer. This package neither calls nor replaces it. |
| `packages/learning/src/training.ts` | Owner-scoped readiness audit and in-memory verified category-routing dataset preparation. It explicitly does not launch training, and tool argument/final-answer targets are absent. It is not neural model training. |
| `packages/learning/src/evaluation.ts`, `cognitive-lab.ts`, `memory-training.ts`, `read-training.ts` | Existing application-level evaluation/training fixtures and holdout separation. These are not evidence of trained execution-model weights. |
| `packages/contracts/src/index.ts`, `ai-providers.ts`, `command-chat.ts` | Zod task/plan/result/provider/chat schemas. Permission and verification schemas remain authoritative; generated strings are not receipts or grants. |
| Root `package.json` and repository filename search | npm workspace monorepo. No Python source, requirements file, pyproject, custom neural architecture or tokenizer was found in the initial inspection. No Python environment was assumed or probed. |

The initial inspected sources did not expose a finalized custom execution-model
request/result contract. This package defines only Python-local interfaces and
documents assumptions for subsequent reconciliation. It does not duplicate
planning, provider policy, experience collection, permission checks, independent
verification, or dataset readiness logic. No existing TypeScript file, shared
contract, server bootstrap, database schema, manifest or environment was changed.

## Phase 1 — execution contracts and routing

Phase 1 should own the authoritative bounded task representation, routing choice,
task kind, supported feature negotiation, and response/error envelope. The Python
handoff needs an already compiled task as text, a pinned model/tokenizer identity,
chosen framing, an explicit token/context budget, generation settings, optional
supported constraint specification, and cancellation. Runtime task ids and
correlation fields can remain in the future adapter rather than model tokens.

Map candidate text/bytes, sampled ids, exact token usage, finish status, provenance,
and structured errors back into the finalized Phase 1 result. No task success,
tool execution, permission, or verification flag may be inferred from successful
decoding. No TypeScript schemas are invented or exported here.

Existing provider `structured` requests carry arbitrary JSON Schema; Phase 2 does
not support that feature. A later adapter must reject unsupported requests or
explicitly compile a supported finite choice constraint. Advertising the existing
router's broad structured capability as unconditional support would be incorrect.
Images, native tool invocation, batch generation, and remote fallback are absent.

## Phase 3 — tokenizer corpus and neural training

Phase 3 supplies approved local corpora, prevents holdout leakage, and chooses
record/chunk boundaries. It calls `ByteBPETokenizer.train`/`train_files` separately
from model training, persists the tokenizer, and pins its identity. Target
vocabulary is a ceiling; use `tokenizer.vocab_size` in the model configuration.

Instantiate `ExecutionModel(config)` directly, use unshifted `torch.long` labels,
0/1 padding masks and ignore-index prompt labels, then optimize returned causal
loss. The package has no optimizer, scheduler, dataset loader, trainer, training
checkpoint writer, or production-data access. Phase 3 owns all of those choices.
Use the agreed input/output framing consistently. Independent examples need
separate rows unless cross-example attention is deliberate.

Phase 3 publishes inference artifacts in the strict
[checkpoint format](checkpoints.md), separated from optimizer/resume artifacts.
Write `ModelConfig.to_dict()`, the exact tokenizer document, a plain tensor-only
state dictionary, and the manifest with canonical identities and raw weights
digest. Configuration identity includes numerical settings and initialization
seed as well as tensor dimensions. Artifacts must be complete and immutable
before the loader sees them. Training status is provenance supplied by Phase 3,
not an evaluation result.

## Phase 4 — independent evaluation

Use `get_model_info`, `generate_candidate`/`stream_candidate`, and direct forward
loss to evaluate independently held-out tasks. Record configuration/tokenizer/
checkpoint identities, seed, dtype/device, budgets, stop reasons, raw bytes and
constraint completion alongside evaluation results. Preserve invalid UTF-8 as an
explicit failure category. Random initialization is a baseline with no asserted
task competence. Syntactic validity and semantic correctness are separate metrics.

Later verification should cover byte/Unicode round trips, deterministic BPE ties,
causal leakage, left/right padding, ignored labels, analytic versus instantiated
parameter counts, random-seed repeatability, sampling/stop rules, stream closure,
constraint failures, context overflow, cancellation, checkpoint rejection, and
CPU/CUDA/OOM paths. These are a handoff checklist, not tests executed in Phase 2.
No latency, throughput, accuracy, loss curve, VRAM use or model sufficiency result
is supplied by this implementation.

## Phase 5 — runtime integration and safety

Phase 5 owns process lifecycle and the Python-to-TypeScript adapter, model
admission, mapping of `AbortSignal` to the Python cancellation callable, capability
negotiation, bounded queues, global resource/concurrency limits, timeouts, and
candidate validation. There is no public HTTP endpoint or server route here and
no Chat Loop hook. Select a process boundary and transport later rather than
assuming one in this phase.

Keep secrets out of model input and artifacts. Provide only approved local
checkpoints; restricted tensor loading is not a hostile-file sandbox. Hostile
files need external isolation before admission. Keep generated text/bytes as
untrusted data. Do not evaluate it as Python/TypeScript, use it as a path to write,
or treat it as an authority to call tools. Tool execution and filesystem/network
effects belong to existing permission-controlled runtime paths; verification
belongs to their independent callbacks. Model output cannot grant itself those
capabilities. The Cognitive Runtime and all existing production behavior remain
unchanged by this package's creation.
