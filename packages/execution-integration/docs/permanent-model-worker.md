# Permanent model worker

The server starts one inference process before listening when `MOHASSAN_MODEL_WORKER=1`. It loads a pinned trunk once and keeps it resident across requests. `MOHASSAN_MODEL_WORKER_CONFIG` overrides the default `.data/model-worker.json` relative to the repository root. `EXECUTOR_PYTHON` selects the local Python interpreter. The default is `.venv-execution/Scripts/python.exe` on Windows or `.venv-execution/bin/python` on Linux.

`GET /health` includes `modelWorker.state` while enabled. `ready` includes the launch-to-ready time in milliseconds. The server logs launch-to-ready and Python startup times. After a crash, requests in flight fail and the supervisor starts a new process with exponential backoff. An invalid host configuration leaves the API available with the worker degraded. Server shutdown closes the worker.

Internal consumers can obtain the worker through `getServerModelWorker(app)` and call `request()` with an operation, head, and input. `timeoutMs` and an `AbortSignal` are optional. Generation can supply an `onToken` callback. The worker uses a long-lived NDJSON stream over child stdin and stdout. `experimental-worker-transport.ts` exports the persistent client and its existing single-request demo client. The persistent wire version is `mohassan.execution.worker.v1`. Existing executor, Ads lab and chat routes keep their current configuration and lifecycle gates.

## Configuration

Place the configuration and pinned checkpoint on local storage. The checkpoint path is relative to the configuration file unless absolute. Replace the example digest and identifiers with the approved local values before enabling the worker.

```json
{
  "identity": {
    "modelId": "foundation-85m",
    "tokenizerId": "approved-tokenizer-id",
    "checkpointId": "sha256:REPLACE_WITH_CHECKPOINT_DIGEST"
  },
  "model": {
    "checkpoint": {
      "path": "checkpoints/best.pt",
      "sha256": "REPLACE_WITH_CHECKPOINT_DIGEST"
    },
    "device": "cpu",
    "eosTokenId": 258
  },
  "limits": {
    "cpuThreads": 1,
    "maxBatchSize": 8,
    "maxBatchWaitMs": 4,
    "maxPending": 64,
    "maxInputBytes": 262144,
    "maxOutputBytes": 1048576,
    "maxOutputTokens": 256,
    "maxTimeoutMs": 120000
  }
}
```

- `checkpoint.format` defaults to `training` for a tensor checkpoint with `config` and `model_state`, such as the pipeline's `best.pt`. Set `model.eosTokenId` to the approved tokenizer's EOS ID when using token IDs without a configured tokenizer.
- `inference` loads a repository export directory. Pin the raw `weights.pt` digest in `sha256`, the raw `manifest.json` digest in `manifestSha256`, and the canonical tokenizer digest in `checkpoint.tokenizerId`. Set `identity.tokenizerId` to that same digest with the `sha256:` prefix. The worker validates the export and gets its EOS ID from the tokenizer.
- `goal-tagger` loads the pipeline GoalTagger checkpoint. It serves the `goal-tagger` pointer head and exposes its named classification outputs.
- A dense trunk defaults to the `lm` generation head. To add heads, supply a `model.heads` map with entries such as `{"lm":{"kind":"generate"},"options":{"kind":"score-options"}}`. Both heads use the resident trunk's language-model logits. A `classify` or `pointer` entry includes a `sidecar` object with the sidecar directory `path`, its `weights.pt` SHA-256 in `sha256`, and its `sidecar.json` SHA-256 in `manifestSha256`. A pointer sidecar projects one score per token. The sidecar manifest binds its weights to the trunk digest.
- For chat text inputs, add `model.tokenizer` with `path` and `sha256` for the local `tokenizer.json`. Set `identity.tokenizerId` to `sha256:` followed by the tokenizer's canonical identity. Include `reportPath` and `reportSha256` for the run's `tokenizer-report.json` when the model was trained with `words-v1` pre-tokenization. Both paths resolve relative to the worker configuration. The worker checks the pinned bytes and model vocabulary and takes the EOS ID from this tokenizer.
- CPU is the default. Setting `model.device` to `cuda` reserves the repository's `.data/gpu.lock` before checking CUDA availability. The worker refuses an existing lock and releases its own lock on clean shutdown. A hard termination can leave the lock file behind. Confirm the recorded job has ended and the GPU is idle before removing that file.

### Requests

| Operation | Input | Result |
| --- | --- | --- |
| `classify` | Dense `inputIds` or GoalTagger `text` | Logits and class index |
| `score` | Dense `inputIds` and `candidatePositions`, or GoalTagger `text` | Pointer scores |
| `select` | Same as `score` | Scores and the selected candidate or decoded GoalTagger output |
| `generate` | `inputIds`, `maxNewTokens`, optional `temperature`, `topK`, `topP`, and `seed` | Indexed token events, then token IDs and stop reason |
| `score-options` | Prompt `inputIds` and candidate continuations `options`, as an array of token ID arrays | `scores` in option order |

Dense calls accept token IDs from the caller. Generation stops at the configured EOS, at the token limit, or when cancelled or timed out. The default is greedy generation when no sampling parameters are supplied. KV caching is enabled for requests with more than four new tokens. Compatible calls share a batch up to the configured size and wait window. Queued and running requests count towards the pending limit.

Closed-list scores are sums of causal continuation log probabilities. Supply 2–16 distinct nonempty options, up to 16 tokens per option and 64 continuation tokens total. Each option also fits the remaining context and the configured output token limit. Use equal-length labels for decisions where option length should have no effect. The worker returns the exact configuration file SHA-256 in its readiness frame for gate binding.

When the worker advertises `text: true`, `generate` and `score-options` also accept a single chat turn in `text` in place of `inputIds`. This uses the pipeline's conversation framing and the pinned tokenizer. Text generation adds a UTF-8 chunk in `text` to each token event, and adds the joined text and `inputTokens` to the result. The EOS token emits an empty chunk. `@mohassan/providers/own-model` uses this mode with the `lm` and `options` heads by default. The server applies the [reply gates](../../../docs/OWN-MODEL-PROVIDER.md) before calling the provider.

### Quantization

Set `model.quantization` to a map keyed by head. Each entry supplies `thresholds` with `minTop1Agreement` and `maxAbsoluteLogitDifference`. Generation also requires `minGreedyTokenAgreement`. Supply `probes` as a list of `{operation, payload}` objects covering the head's operations. Use greedy generation probes and representative inputs chosen for the pinned candidate.

The ready payload reports per-head top-1 agreement, maximum absolute logit difference, greedy token agreement when applicable, and the adoption decision. Quantized pointer selection and closed-list choice must also match on every relevant probe. Quantized generation compares cached and uncached greedy tokens and stop reasons. Heads keep FP32 when parity fails, the CPU backend lacks support, or probes are absent. Tied output embeddings and GoalTagger's fused encoder remain FP32. Startup parity adds to the measured load time.

### Process limits

Windows uses a Job Object with a memory ceiling, hard CPU rate, a one-process limit, and kill-on-close. Linux uses address-space and cumulative CPU-time limits, disables core dumps, and links worker lifetime to its supervisor. The defaults are 4 GiB of memory, a 75% Windows CPU rate and an 86,400-second Linux CPU budget. Set `limits.memoryBytes`, `limits.cpuRatePercent` on Windows, and `limits.cpuTimeSeconds` on Linux to tune the OS limits. These controls cover the inference process's resource use. The separate lifecycle transport's filesystem and network isolation requirements still apply to production execution routing.

## CPU benchmark

Run `python -B packages/execution-integration/model_worker/benchmark.py` using a local CPU PyTorch environment. It builds a random checkpoint with the 85M foundation architecture, asks the resident worker for six streamed tokens per 32-token prompt, and reports complete-batch round-trip latency at batch sizes 1 and 8.
