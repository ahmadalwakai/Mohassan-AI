# Local execution model transport

## Status

- **IMPLEMENTED:** `src/transport.ts` provides `LocalProcessModelTransport`, the
  `ModelTransport` boundary, strict versioned NDJSON parsing, pinned identities,
  bounded messages and output, cancellation, timeouts, replay refusal, bounded
  cleanup, and fail-closed containment admission.
- **ADAPTER_REQUIRED:** a trusted `LocalModelContainmentAdapter` that creates OS
  isolation before launching a configured local executable. A plain `spawn`
  wrapper is insufficient. No default launcher is supplied.
- **INTEGRATION_PENDING:** a Phase 2 Python worker that speaks the protocol below,
  and a reviewed mapping from Phase 1 local tasks to the worker input/candidate.
- **VERIFICATION_PENDING:** compile checks, contract tests, process crash tests,
  cancellation races, byte limits, and OS containment checks. None were run in
  this phase; no Python/model process was launched.

This transport never imports a Python package, binds a socket, starts an HTTP
server, downloads a model, falls back to an external API, or executes a tool. A
generated proposal is untrusted JSON data. It is never verification evidence.

## Observed Phase 2 interface

Read-only inspection found these symbols, which were still being developed:

| File | Observed symbols and semantics |
| --- | --- |
| `packages/execution-model/execution_model/inference.py` | `InferenceEngine`, `get_supported_capabilities`, `get_model_info`, `load_local_model`, `encode_task_input`, `stream_candidate`, `CandidateOutput`, `InferenceResponse` |
| `packages/execution-model/execution_model/generation.py` | `GenerationConfig`, `GenerationResult`, `GenerationEvent`, `stream_generate`, `generate`; explicit output-token bounds and a cancellation callable |
| `packages/execution-model/execution_model/metadata.py` | `ModelMetadata`; `config_identity`, `tokenizer_identity`, nullable `checkpoint_identity`, `independently_verified=False` |
| `packages/execution-model/execution_model/resources.py` | `ResourceConfig`, `ResolvedResources`; Python request/device limits, which do not establish OS containment |
| `packages/execution-model/execution_model/checkpoint.py` | `load_checkpoint`; expected configuration and tokenizer identity are caller supplied |
| `packages/execution-model/execution_model/tokenizer.py` | `ByteBPETokenizer` |
| `packages/execution-model/execution_model/__init__.py` | `__version__ = "0.1.0"`; explicit submodule imports, no worker startup |

The observed facade returns Python-native `bytes` in `CandidateOutput`; its
`InferenceResponse.status="completed"` means decoding ended. These are not the
Phase 5 wire response or a verified task result. No compatible stdio entrypoint
was verified. The future adapter must explicitly validate UTF-8, parse the
candidate as bounded JSON, reject invalid/unstructured output, and map failure
codes. It must not reinterpret arbitrary model text as a tool call. If a future
wire version needs raw bytes, define an explicit bounded encoding in that new
version; this version accepts JSON proposals only.

Phase 2 capability flags describe decoding features such as `text_generation`,
not an assertion that a model can perform an application task. Task capability
admission additionally depends on independent evaluation and Phase 1 routing.

## TypeScript boundary

`ModelIdentity` contains exactly `modelId`, `tokenizerId`, and `checkpointId`.
All are required opaque identifiers. The approved registry, rather than the
worker, supplies the expected tuple. An identity mismatch fails. The adapter
must resolve the model ID to a registered version and independently pin the
checkpoint/tokenizer digests before launch. Phase 2 currently defines tokenizer
identity as a canonical SHA-256 digest and checkpoint identity as SHA-256 of its
canonical manifest; this transport compares exact configured IDs and does not
infer or recalculate their meaning.

`ModelTransport` exposes:

```ts
discover(signal: AbortSignal): Promise<ModelCapabilities>;
submit(request: ModelTaskSubmission, signal: AbortSignal): Promise<ModelCandidateResponse>;
```

`ModelTaskSubmission` contains `requestId`, `taskId`, `capability`, `contract`,
`context`, and `maxOutputTokens`. `contract` and `context` use `TransportJson`.
The caller must send only supervisor-approved, permission-compatible context.
Identity and protocol are added by the transport. A submission grants no tool,
file, network, approval, or lifecycle authority to the worker.

`ModelCandidateResponse` is a discriminated union:

- `status: "candidate"`, `proposal: TransportJson`, `outputTokens: number`;
- `status: "missing_context"`, `missingContextKeys: readonly string[]`;
- `status: "unsupported"`, `capability: string`.

Every branch includes the pinned identity and matching request/task IDs. Token
usage reported by the model is telemetry, not independent verification of a
resource limit; OS enforcement and Python inference limits remain mandatory.

## Protocol: `mohassan.execution.local.v1`

The channel is standard input/output of one local child. Each message is one
UTF-8 JSON object followed by LF; no banners, progress lines, or logging are
allowed on stdout. Unknown envelope fields fail. Stderr is drained and bounded
but never retained or logged. The protocol has no URL, port, HTTP endpoint,
download command, activation operation, or tool execution operation.

The worker emits exactly one startup message:

```json
{
  "protocol": "mohassan.execution.local.v1",
  "kind": "ready",
  "identity": {"modelId": "registered-version", "tokenizerId": "pinned-tokenizer-digest", "checkpointId": "pinned-checkpoint-digest"},
  "capabilities": ["text_generation"],
  "limits": {"maxInputBytes": 262144, "maxOutputTokens": 256}
}
```

The example identities are descriptive placeholders. Actual values come from
the approved registry, never from model output or an unreviewed checkpoint.
Discovery returns the handshake and then terminates the child. Submission
requires a fresh child, validates its handshake, and writes exactly one message:

```json
{
  "protocol": "mohassan.execution.local.v1",
  "kind": "generate",
  "identity": {"modelId": "registered-version", "tokenizerId": "pinned-tokenizer-digest", "checkpointId": "pinned-checkpoint-digest"},
  "requestId": "request-1",
  "taskId": "task-1",
  "capability": "text_generation",
  "contract": {"contractVersion": "adapter-defined"},
  "context": {},
  "maxOutputTokens": 128
}
```

Stdin is closed after this write. The worker replies once:

```json
{
  "protocol": "mohassan.execution.local.v1",
  "kind": "result",
  "requestId": "request-1",
  "taskId": "task-1",
  "identity": {"modelId": "registered-version", "tokenizerId": "pinned-tokenizer-digest", "checkpointId": "pinned-checkpoint-digest"},
  "status": "candidate",
  "proposal": {"candidateSchemaVersion": "adapter-defined"},
  "outputTokens": 12
}
```

For `missing_context`, replace `proposal` and `outputTokens` with a nonempty
bounded `missingContextKeys` array. For `unsupported`, replace them with the
exact requested `capability`. A structured peer failure uses `kind: "error"`
and a `code`, with the same protocol, identity, request ID, and task ID; it has
no free-text message or status field. Accepted peer codes are `invalid_request`,
`unsupported_capability`, `invalid_model_output`, `model_process_failure`,
`resource_exhaustion`, `timeout`, and `cancelled`.

The candidate schema above is intentionally not claimed to be Phase 1's schema.
Only the envelope is defined here. Phase 1 must validate and normalize its local
task and candidate schema before any operation reaches a permission boundary.

## Configuration and containment

`LocalModelProcessConfig` requires an explicit absolute `executable`, `cwd`,
argument array, environment mapping, pinned identity, read-only path allowlist,
complete resource limits, and a bounded replay-record capacity. UNC paths are
rejected. No executable path or arguments are invented. The adapter must also
resolve symlinks/reparse points, reject network-mounted paths, verify that the
executable and checkpoint are approved and immutable, and enforce the resolved
filesystem allowlist. Absolute path validation alone cannot prove locality.

The environment mapping is explicit and never inherited from `process.env`.
This implementation creates no repository environment variables and never
changes the host environment. A future host adapter may pass only the reviewed
existing runtime variables necessary for the configured executable, excluding
credentials and network proxy escape paths.

`LocalModelLaunchSpec` fixes `shell: false`, `windowsHide: true`,
`network: "deny_all"`, and `filesystemWrites: "deny_all"`. The configured
executable and argument array must be used directly, never shell-interpolated.
All limits participate in the configuration hash bound to the containment
attestation. The trusted adapter must enforce memory, CPU time, process count,
network denial, filesystem read restrictions, and write denial before the child
starts. A Node stream byte limit is not a memory/CPU sandbox.

`prepare` creates and verifies a containment lease without running code. Its
evidence must bind the configuration hash and attest every required guarantee.
Only then may `launch` start the child. `terminateAll` must revoke the lease,
kill and wait for all descendants, and fence a launch that is still pending.
It must work independently of the cancelled task signal. `dispose` releases
resources without ever detaching a surviving process from containment.

Missing containment fails with `isolation_unavailable`. Cleanup failure returns
`process_cleanup_failed` instead of a candidate and quarantines the transport
instance against later launches. A platform implementation must demonstrate
kill-on-owner-death or an equivalent guarantee; this module cannot establish
that guarantee from a process ID. No such platform adapter has been verified.

## Bounds, cancellation, and replay

- Startup deadline covers preparation, launch, and the handshake; request
  deadline starts at the single request write. Cleanup has an independent bound.
- Entire outbound frames, individual inbound lines, cumulative stdout, stderr,
  JSON nesting/node counts, output tokens, and replay-record counts are bounded.
- No message truncation or partial candidate acceptance occurs. Empty/malformed
  stdout lines, invalid UTF-8, mismatched IDs, extra envelope fields, and unexpected
  messages fail closed. Child/pipe errors and early exits become classified errors.
- Cancellation stops waiting and invokes containment termination, even when a
  launch is still pending. No cancelled request is retried.
- Request IDs are reserved before asynchronous submission and never removed.
  A full replay ledger rejects new work; it does not evict old IDs. The instance
  permits at most one live model process. There is no automatic retry or resend.
- Replay protection is in-memory and instance-local. It is not durable task
  deduplication. The orchestrator's injected state/action store owns cross-worker
  execution idempotency. The protocol has no state-changing operation at all.
- An external state-changing tool response lost later in the execution pipeline
  must be reconciled by the orchestrator; this transport cannot authorize replay.

`ModelTransportError` exposes only a fixed `code` and safe fixed message. Prompts,
candidate bytes, executable arguments, environment values, peer error messages,
and stderr never appear in transport errors or audit events.

## Final integration gates

1. Agree Phase 1 task/candidate and Phase 2 stdio mappings, version them, and
   inspect the actual exports after concurrent development is complete.
2. Select the explicitly configured executable and reviewed local checkpoint;
   resolve Phase 3 registered identities and Phase 4 task capability evidence.
3. Implement and independently verify the platform containment adapter,
   including pending-launch cancellation and descendant teardown.
4. Implement the Python stdio bridge under its owning phase in a separately
   authorized integration change. Match this wire schema exactly or negotiate a
   new explicit protocol version; do not silently transform incompatible data.
5. Run later authorized TypeScript checks and process protocol/containment tests.
   Keep production paths disconnected until all gates pass and activation is
   explicitly approved.
