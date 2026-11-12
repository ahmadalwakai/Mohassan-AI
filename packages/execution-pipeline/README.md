# execution-pipeline

The cross-phase join for Mohassan's custom execution model. Phases 2–5 were delivered as isolated packages with
injected seams and no code connecting them; this package and three small TypeScript files are that connection.

| Seam | Implemented in |
| --- | --- |
| Phase 2 tokenizer → Phase 3 `Phase2Tokenizer` protocol | `execution_pipeline/bridge.py` `Phase2TokenizerBridge` |
| Phase 2 model → Phase 3 `ModelFactory` (random init only) | `bridge.py` `execution_model_factory` |
| Phase 3 training checkpoint → Phase 2 inference checkpoint | `bridge.py` `export_inference_checkpoint` |
| Phase 3 Stage C (repair) data, which Phase 3 had no generator for | `repair.py` |
| Phase 3 prompt format shared with inference (no drift) | `execution_training/tokenization.py` `render_prompt_payload`, `tasks.py` |
| Phase 5 `mohassan.execution.local.v1` worker | `worker.py` |
| Phase 1 `ExecutionModelAdapter` ↔ Phase 5 `ModelTransport` | `packages/execution-integration/src/phase1-model-adapter.ts` |
| Independent evaluation (Phase 4 types, metrics, retrieval primitives) | `evaluate.py`, `scripts/execution-sandbox-verify.ts` |
| Model registration and evaluation binding (Phase 3 registry) | `register.py` |

Nothing here downloads a model, a tokenizer or a dataset. All weights start from random initialization.

## Reproduce

```bash
python -m venv .venv-execution
.venv-execution/Scripts/python -m pip install torch==2.10.0 --index-url https://download.pytorch.org/whl/cu126
.venv-execution/Scripts/python -m pip install numpy==2.4.2 pytest==7.4.3
```

```bash
P=".venv-execution/Scripts/python packages/execution-pipeline/scripts/pipeline.py"
R=artifacts/execution-model-runs/my-run
$P data --run $R                                  # deterministic, oracle-verified synthetic data
$P tokenizer --run $R --max-token-bytes 16 --isolate-digits   # scratch BPE, training split only
$P lengths --run $R
$P train --run $R --tokens 6000000 --context 256 --microbatch 16 --accumulation 1 --lr 6e-4 --checkpoint-interval 5000 --output train
$P export --run $R --context 256 --output train --checkpoint <path to final .pt>
$P evaluate --run $R --checkpoint $R/inference-train
```

`artifacts/` is git-ignored. Data generation, splits, tokenizer training and model initialization are seeded; GPU
training uses `deterministic_algorithms=False` for speed, so loss curves are reproducible only approximately.

## Inference

The worker loads one pinned checkpoint through Phase 2's strict loader and refuses to start on any identity mismatch:

```bash
.venv-execution/Scripts/python -m execution_pipeline.worker --checkpoint <dir> --model-id <id> --tokenizer-id sha256:<hex> --checkpoint-id sha256:<hex> --device cpu
```

It reads one JSON request line and writes one JSON response line. It accepts only typed fields for advertised
capabilities (`tasks.py`), never a free-form prompt. It has no tools, network client or file writes.

## Tests

```bash
cd packages/execution-pipeline && ../../.venv-execution/Scripts/python -m pytest tests -q
npx vitest run tests/execution-model-integration.test.ts
```

## Safety boundaries

* Model output is untrusted data. Phase 1 validates structure, scope and workspace binding; the supervisor checks
  permission; generated code runs only in the Windows AppContainer sandbox.
* `ExperimentalUncontainedWorkerTransport` runs the worker as an ordinary child process. No OS containment evidence
  exists for it, so it is deliberately not exported from `execution-integration`'s index and must not be wired into
  runtime routing. Production use needs a `LocalModelContainmentAdapter` that can attest the worker process.
