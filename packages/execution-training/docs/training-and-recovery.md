# Training, recovery and resource limits

## Curriculum

| Stage | Implemented routing and prerequisites |
| --- | --- |
| A — structure and precision | Exact identifiers and values, structured operations, required fields, missing-context requests and unsupported-task responses. |
| B — local TypeScript execution | Small functions, explicit contracts/import inventories, null/undefined handling, boundaries and preserved types. Built-in TS fixtures have restricted static verification only. |
| C — repair | Failed candidate and concrete evidence as input; verified correction as target; reproduced failure, regressions, tests and typecheck protection required. |
| D — composition | Contracts accept independently verified combinations of two or three operations, ordering constraints, multistep transformations and limited multi-file tasks. These datasets are not generated here. |
| E — future specializations | Modular React, Next.js, full-stack, Google Ads, iOS and Android registrations. Disabled without explicit dataset/evaluation/authorization references; no proficiency or promotion claim. |

`CurriculumPlan` provides ordered, nonrepeating `StageBudget` allocations, optional earlier-stage replay, strict sample classification and dataset-version checks. Each enabled stage needs its own examples; replay alone cannot satisfy coverage. The default convenience plan distributes an explicitly supplied budget over A and B. C, D and E require separately supplied verified datasets. Stage E references record prerequisites, not a training verdict or proof of model competence.

Training requires stage allocations to equal the configured processed-token budget. A sampler selects whole examples in deterministic epoch order. A residual shorter than the next example is left unused and the next stage begins; targets are never truncated to hit a budget exactly. The report records actual tokens and unused allocation. Sample ordering uses SHA-256 sort keys, not version-dependent shuffle state.

## Configuration

| Preset | Approximate Phase 2 size | Microbatch | Initial context | Accumulation | Activation checkpoint request |
| --- | --- | --- | --- | --- | --- |
| `17m` | 17 million | 1 | 256 | 16 | Off |
| `34m` | 34 million | 1 | 256 | 16 | Off |
| `70m` | 70 million | 1 | 512 | 32 | On |
| `126m` | 126 million | 1 | 512 | 32 | On |

These are initial experiments, not verified optimal settings or exact parameter counts. `preset_config(name, architecture_id=..., **overrides)` requires Phase 2's architecture identity and never defines layer dimensions. Actual parameter count is obtained from the injected model when training is explicitly run.

`TrainingConfig` supports microbatch, accumulation, context length, learning rate, weight decay, AdamW/SGD, Adam betas/epsilon, `foreach` optimizer behavior, cosine/linear/constant scheduling, token-based warmup, minimum LR ratio, gradient clipping, precision, device, explicit CPU fallback, activation checkpointing, seed, processed-token limit, validation/checkpoint intervals, bounded validation batches, deterministic kernels, objective, profiling and resume path.

Resource limits cover elapsed time, CUDA reserved memory, checkpoint size and free disk reserve. Initial defaults reserve 2 GiB free disk and cap a checkpoint at 8 GiB. These are configurable guards, not statements about available hardware. Model setup can still fail with OOM; it is classified without retrying another device automatically.

Contexts can be explicitly expanded to 1024+ when supported by the Phase 2 model. Full JSON contracts can make even small tasks exceed a 256-token byte-tokenizer context. Context overflow fails before training; adjust the experiment or explicitly curate a new sample and regenerate verification.

## Real training behavior

Only calling `train(...)` starts training. It revalidates dataset content, evidence, usage, privacy policy, splits and curriculum before model construction. Only enabled-stage training and validation samples are encoded; test samples never enter the training tokenizer or samplers.

The trusted factory receives `initialization='random'` and `allow_pretrained=False`; its `ModelBundle` must confirm initialization seed, architecture, complete configuration hash, vocabulary, context and factory identity. No pretrained loader or download path exists. The model is moved to FP32 parameter storage and the selected device. The Phase 2 factory remains responsible for honoring its random-initialization attestation and causal-attention contract; later integration must independently verify this.

The tokenizer separately encodes the exact prompt and target and verifies both their individual and concatenated lossless roundtrips. Supervised labels mask the prompt with `-100`; collated padding labels also use `-100`, independent of whether padding and EOS share an ID. The trainer shifts labels exactly once to predict the next token. Causal-LM mode trains the full authorized task/target sequence. **Repair examples reject causal-LM mode:** use supervised mode so the failed candidate remains input-only. Verified correction is the sole repair target.

Loss uses FP32 summed cross entropy. Each microbatch is divided by the total number of loss-bearing tokens in its complete accumulation window, preserving correct weighting for different target lengths and partial final windows. All microbatches share the same scaler state. Gradients are unscaled once, checked for finite values, clipped, then applied. Only a successful optimizer update commits sampler position and token counters; the scheduler advances by committed nonpadding input tokens.

Validation is deterministic, bounded and uses only the validation split in evaluation/no-grad mode. RNG state and model mode are restored afterward. Validation loss is diagnostic, not an independent Phase 4 evaluation, promotion signal or source of automatically generated training examples. There is no automatic test-feedback learning or early-stopping-based model promotion.

SIGINT/SIGTERM handlers can request completion of the current accumulation window followed by a clean save. Hosts may disable handlers and supply `stop_requested`. Unexpected interruption, invalid loss, nonfinite gradients, OOM, resource limits or failed optimizer/I/O operations stop the session and preserve the latest durable checkpoint. Failed in-memory state is never saved as a valid resume point. Setup/data failures raise classified `TrainingError`; failures after training starts produce a failed report where disk remains writable. Disk exhaustion may prevent the final report; previous committed checkpoints remain recoverable.

## Precision and memory

`fp32`, CUDA `fp16` with gradient scaling, and hardware-supported CUDA `bf16` are implemented. `auto` chooses BF16 when supported, otherwise supported FP16, otherwise FP32. CPU execution is FP32 only and requires `device='cpu'` or explicit allowed fallback when CUDA is unavailable. An OOM does not trigger a hidden CPU retry. A requested unavailable precision fails.

Activation checkpoint placement is delegated through a verified Phase 2 hook. The integration should use nonreentrant PyTorch checkpointing with RNG preservation and confirm the actual state. Requested checkpointing without a hook fails; this package does not guess module/block names or duplicate the architecture.

The memory estimator separates parameters, gradients, optimizer state, activations, CUDA runtime overhead and temporary buffers. FP32 AdamW's parameter-state baseline is:

`4 bytes weights + 4 bytes gradients + 8 bytes two moments = 16 bytes per parameter`

This is **not total peak VRAM**. Activations, attention workspaces, buffers, runtime, fragmentation and implementation-specific optimizer/master copies can increase memory. Unknown components remain `null`. `foreach=False` is the conservative default; no 8-bit optimizer, offloading, distributed training or sharded optimizer is implemented.

## Checkpoint transaction and exact-state resume

`CheckpointManager.save` writes a same-directory temporary `.pt`, flushes and fsyncs it, checks disk/size limits, hashes its bytes and atomically renames to a unique final filename. An immutable `.json` receipt is the commit marker and binds compatibility, size, SHA-256 and counters. Prior valid checkpoints are not overwritten or pruned. A crash between artifact rename and receipt publication leaves an orphan artifact, which cannot be loaded as committed. Local run/metadata locks are never broken automatically after a crash.

Each checkpoint contains model, optimizer, token-scheduler and scaler state; Python, CPU/CUDA Torch and optional NumPy RNG state; optimizer step; committed processed and unique dataset token counts; stage index/token counter; every stage's deterministic sampler epoch/position/order identity; full training configuration; and schema version. Accumulation state must explicitly be `{microsteps: 0, pending_tokens: 0}`. Gradients need not be serialized because saving occurs only after a completed update and gradient clearing.

Compatibility includes architecture and complete model configuration identities, factory identity, random initialization lineage, tokenizer identity/version/vocabulary/special IDs, complete dataset identity including the preparation audit, privacy-policy hash, curriculum hash, training config hash, actual training source hash, trainer version, resolved precision and runtime identity. The runtime records Python/Torch/NumPy versions, CUDA/cuDNN/device characteristics, thread settings, TF32 and deterministic flags. Changing any compatibility field rejects resume. The resume path itself is excluded from the training-config hash; changing budget or optimizer settings is not an exact resume.

Loading requires an explicit path inside the configured checkpoint directory and `trusted_resume=True`. Optional `resume_sha256` pins an externally recorded artifact hash; the receipt and actual bytes are checked regardless. Loading always uses `torch.load(..., weights_only=True)` and never falls back to unrestricted pickle. **Untrusted checkpoints remain unsafe**: restricted loading and size checks do not remove parser vulnerabilities or all memory-exhaustion risks.

Resume restores all boundary state and rejects inconsistent scheduler/token counters or sampler identities. Graceful stop continues from the saved boundary. Abrupt process loss or a mid-window failure replays work after the last valid checkpoint; it is not an exact continuation of an interrupted partial backward/optimizer call. GPU kernels, driver changes, third-party factory behavior and hardware can still prevent bitwise equivalence. No bitwise resume claim has been tested here. The package does not change environment variables; any required deterministic CUDA runtime setup must be explicitly established by the later host.

## Counters, budgets and profiling

Experimental budgets are 10M, 50M and 100M processed training tokens; smaller explicit experiments are permitted. More than 100M requires `allow_extended_budget=True`. `unique_dataset_tokens` counts each active training-split example once after tokenization. `processed_tokens` counts all repeated, committed training input tokens including prompt/framing, excluding padding, validation and test. `loss_tokens` counts only prediction targets. Reports also record successful forward tokens observed this invocation, which can exceed committed tokens after an aborted window. Replay after an abrupt crash can consume additional physical work not recoverable from the previous checkpoint counter.

Profiling is opt-in (`profile_enabled=True`). `ResourceProfiler` records actual device identity, CUDA allocation/reservation and peaks, optimizer-window throughput and latency, microbatch/optimizer timing, accumulation microsteps and checkpoint time. CUDA synchronization adds overhead. At most 1024 recent measurements are kept, plus aggregate counters. A real injected temperature reader can record temperatures alongside throughput variation; absent a sensor thermal data is unavailable, and no causal thermal-throttling claim is made. Comparative accumulation overhead requires separately controlled experiments.

The two scripts are supplied for later use and were not executed:

```text
python scripts/inspect_device.py --execute --output <operator-selected-report.json>
python scripts/profile_training.py --execute --adapter <trusted_module>:<factory> --steps 20
```

The profiling adapter returns explicit `train` keyword arguments with profiling enabled. The second script really performs a bounded training experiment and requires Phase 2 integration; it has no built-in dummy model, tokenizer, dataset, teacher or implicit credentials. The limit is 1–1000 optimizer steps per invocation.

Duration may only be estimated from actual measured throughput:

`hours = processed_tokens / (measured_tokens_per_second * 3600)`

`estimate_duration_hours` rejects missing/nonpositive/nonfinite rates. Window throughput excludes validation and checkpoint time; account for those measured costs when estimating wall-clock duration. There are no fabricated tokens/sec, temperatures, VRAM peaks or training-duration figures.

## Practical limits requiring later verification

The implementation is single-process/single-device and holds prepared examples plus tokenized active splits in host memory. Near deduplication is bounded but not semantic proof. Family splits can leave tiny corpora without usable validation/test coverage. Actual TypeScript execution, human rights/privacy review, Phase 2 initialization/attention/tokenizer correctness, CUDA support, AMP stability, checkpoint reload and deterministic continuation require separately authorized verification. Filesystem atomicity assumes a local filesystem, trusted directories and a single training writer, not hostile writers or distributed/network locking.

API references checked during source implementation: [PyTorch AMP examples](https://docs.pytorch.org/docs/2.15/notes/amp_examples.html), [reproducibility notes](https://docs.pytorch.org/docs/2.15/notes/randomness.html), and [restricted checkpoint loading](https://docs.pytorch.org/docs/2.15/generated/torch.load.html). Reading documentation is not runtime validation of the eventual installed version.

