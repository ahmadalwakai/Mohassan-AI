# Local checkpoint format and resource configuration

Phase 2 implements an inference reader, not a checkpoint writer. Phase 3 owns
training, checkpoint publication, provenance collection, and checkpoint creation.
No checkpoints or model weights were created or loaded while implementing this
phase.

## Directory format, version 1

The caller supplies a local directory containing these four fixed filenames:

| File | Required content |
| --- | --- |
| `manifest.json` | Exactly the fields below; UTF-8 JSON, at most 64 KiB |
| `config.json` | Complete `ModelConfig.to_dict()` output; UTF-8 JSON, at most 64 KiB |
| `tokenizer.json` | `ByteBPETokenizer.to_dict()` output, including its canonical identity |
| `weights.pt` | A plain `dict` or `OrderedDict` of string names to ordinary PyTorch tensors, from the matching model's `state_dict()` |

The manifest's exact fields are:

```json
{
  "format": "mohassan-execution-checkpoint",
  "version": 1,
  "architecture": "dense-decoder-v1",
  "config_identity": "<ModelConfig.identity: 64 lowercase hex characters>",
  "tokenizer_identity": "<ByteBPETokenizer.identity: 64 lowercase hex characters>",
  "weights_sha256": "<SHA-256 of the complete weights.pt file>",
  "training_status": "unverified",
  "initialization_seed": 0
}
```

The angle-bracket values above describe fields and are not valid digest values.
`training_status` must be `random_initialized`, `unverified`, or `trained`.
It is the checkpoint author's declaration, never an independent verification.
`initialization_seed` is either null (unknown) or an integer in `[0, 2**63)` that
agrees with `config.seed`. Metadata always reports `weight_origin=local_checkpoint`
for loaded files, and `independently_verified=False`, even if their author declares
`trained`. A randomly initialized model created locally instead reports
`weight_origin=random_initialized` and `training_status=random_initialized`.

Use the current uncompressed ZIP container produced by PyTorch serialization.
Legacy raw pickle checkpoints, compressed ZIP members, modules, optimizers,
custom tensor subclasses, extra state dictionaries, and bundled training state
are unsupported. Each parameter tensor must be contiguous with zero storage
offset and storage exactly equal to its own element count times element size.
Phase 3 should serialize standalone contiguous parameter tensors, without extra
storage or view aliases. Tied output projection uses the input embedding directly;
there is only one corresponding weight in the state dictionary.

Accepted parameter dtypes are float32, float16, and bfloat16. Names and shapes
must exactly match the architecture; missing and unexpected keys fail. Values
must be finite both before and after conversion to the requested inference dtype.
No partial loading, key rewriting, or architecture guessing occurs.

## Loading interface

```python
loaded = load_checkpoint(
    local_checkpoint_directory,
    expected_config=approved_config,
    expected_tokenizer_identity=approved_tokenizer_identity,
    resources=ResourceConfig(device="cpu", dtype="float32"),
)
model = loaded.model                 # eval mode
tokenizer = loaded.tokenizer
metadata = loaded.metadata.to_dict()
placement = loaded.resolved_resources.to_dict()
```

Both expected identities come from caller-controlled configuration. Reading the
same checkpoint's self-declared identity and immediately trusting it is not an
independent compatibility decision. The complete configuration, including seed,
context, dropout, and numerical settings, must match. The tokenizer's actual
vocabulary size must exactly equal `config.vocab_size`; its requested vocabulary
target is not a substitute when training stops below that target.

`checkpoint_identity` is SHA-256 of the manifest serialized as sorted ASCII JSON
with comma/colon separators and no whitespace. Config and tokenizer identities
are canonical hashes defined by those modules. Raw weights are hashed from the
same open file handle subsequently inspected and loaded.

The reader rejects URLs, UNC paths, Windows mapped network drives, symbolic links,
and Windows reparse points in the source path. On other operating systems, the
host must ensure that a seemingly local mount is not a network filesystem. Keep
the directory immutable for the full load; the reader does not lock external
writers. No remote fallback or network client exists in this implementation.

## Restricted loading and limitations

The dependency is a maintained, patched PyTorch release **at least 2.6.0**. The
version floor is not a claim that every release above it is free of security
issues; use the maintained build approved in the later runtime verification
phase. The loader always passes `weights_only=True`, following the
[restricted torch.load API](https://docs.pytorch.org/docs/stable/generated/torch.load.html), and never retries using
unrestricted pickle. It rejects a process with user-added serialization safe
globals and never modifies that global allowlist. The embedding application
must not change serialization globals concurrently with a checkpoint load.

The loader checks file limits, archive structure and aggregate storage size,
checks identities, preflights tensor shapes and storage on the meta device,
then loads the tensor values onto CPU. Strict assignment materializes the meta
model without allocating another random CPU copy. Final device/dtype placement
is explicit. Missing, incompatible, or rejected files raise `ModelLoadError`;
allocation/device failures raise `ResourceError`. Both carry machine-readable
`details.reason` values.

Restricted tensor loading reduces arbitrary-code execution exposure, but is not
a CPU or memory sandbox. Malicious serialized objects can still cause denial of
service or exploit defects in the installed parser. Size and shape checks do not
establish trust or fully bound parser memory. Hashes detect mismatches, not author
authenticity. Files from a hostile source require external process isolation and
resource limits before admission. Nothing in model loading is a permission or
semantic-verification decision.

## Resources

`ResourceConfig` defaults to CPU, float32, 1,024 context tokens, 256 output tokens,
262,144 input bytes, and a 1 GiB checkpoint-file limit. It has no environment
variable dependencies. Request limits are enforced by the inference facade;
they do not resize the architecture or truncate its input.

Supported devices are `cpu`, `cuda`, and `cuda:<index>`. CUDA is inspected only on
an explicit `resolve()` call while initializing/loading an engine. `cuda` means
device zero. Dtypes are `float32`, `float16`, and `bfloat16`; CPU float16 is
explicitly unsupported. CPU bfloat16 may use slow software paths. CUDA bfloat16
requires a device reporting compute capability major version 8 or greater.

If CUDA is unavailable, `allow_cpu_fallback=True` explicitly permits CPU float32
and reports `CUDA_UNAVAILABLE_EXPLICIT_CPU_FALLBACK` in placement metadata.
The default is to raise `ResourceError`. CUDA out-of-memory and other allocation
failures never silently switch device or retry the request.

Bounds are context/output at most 8,192 tokens, input at most 1 MiB, and checkpoint
at most 2 GiB. These are defensive ceilings, not recommended workloads. An RTX
3050 Ti with 4 GiB VRAM needs conservative context and output budgets; parameters,
activations, attention, conversion temporaries, allocator overhead, and other
applications all consume memory. No latency, throughput, VRAM fit, CUDA support,
or training configuration has been measured or verified in this phase.
