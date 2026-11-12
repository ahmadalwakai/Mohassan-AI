# Mohassan AI — Phase 2 execution model

An isolated Python implementation of a randomly initialized dense decoder-only
Transformer, a project-trained byte BPE tokenizer, and local candidate generation.
It is subordinate to the Cognitive Runtime. It does not plan, grant permissions,
execute tools, verify its own output, or change the existing application.

**Implementation status:** source complete and manually reviewed. No Python code
was executed, model instantiated, corpus trained, checkpoint loaded, CUDA probed,
dependency installed, or build/test/benchmark/deployment run during delivery.
Runtime correctness, hardware compatibility, and learned ability remain unverified.
There are no bundled model weights, trained vocabulary artifacts, or pretrained assets.

## Layout and dependencies

The import package is `execution_model`, located directly in this directory.
Use this directory as the Python working/import root in the later host process.
No npm workspace entries, package manifests, lockfiles, environment variables, or
server routes were added. Import modules explicitly; the package initializer is
lightweight and does not import PyTorch or access the filesystem.

Required later: Python 3.10+ and a maintained, patched PyTorch build at least 2.6.0
compatible with the selected Windows CPU/CUDA environment. The installed versions
have not been checked. The tokenizer, configuration, and error modules use only
the standard library. There is no tokenizer library, Hugging Face dependency,
external inference API, custom CUDA kernel, or download mechanism.

| Module | Responsibility |
| --- | --- |
| `config.py` | Validated presets, configuration identity, analytic parameter counts |
| `tokenizer.py` | Actual local byte BPE vocabulary training, encoding, decoding, JSON persistence |
| `normalization.py`, `positional.py` | RMSNorm and rotary positions |
| `attention.py`, `feed_forward.py` | Causal multihead SDPA and SwiGLU |
| `initialization.py`, `model.py` | Seeded random weights, blocks, tied logits, shifted causal loss |
| `generation.py`, `constraints.py` | Bounded autoregression, sampling, streaming, finite constraints |
| `resources.py`, `metadata.py` | Explicit device/dtype limits and weight provenance |
| `checkpoint.py` | Strict local tensor-only checkpoint admission |
| `inference.py`, `errors.py` | Python candidate interface and structured failures |

Read [architecture](docs/architecture.md), [tokenizer](docs/tokenizer.md),
[inference](docs/inference.md), [checkpoint format](docs/checkpoints.md), and
[integration boundaries](docs/integration.md) before connecting a later phase.

## Presets and counts

All presets default to vocabulary 16,384, context 1,024, dropout 0, and seed 0.
Every head has 64 channels. Vocabulary and other architecture settings can be
overridden within validated limits; a model must use the tokenizer's **actual**
vocabulary size, which may be below its training target.

| Preset | Layers | Hidden | Intermediate | Heads | Formula-derived parameters at V=16,384 |
| --- | ---: | ---: | ---: | ---: | ---: |
| A | 6 | 384 | 1,024 | 6 | 16,913,280 |
| B | 8 | 512 | 1,408 | 8 | 34,087,424 |
| C | 12 | 640 | 1,728 | 10 | 69,975,680 |
| D | 16 | 768 | 2,048 | 12 | 125,854,464 |

The totals above were calculated programmatically by arithmetic, without importing
the implementation or constructing a model. `ModelConfig.parameter_count()`
implements the same exact formula for the defined architecture:

```text
P = V*d + L*(4*d*d + 3*d*m + 2*d) + d
```

`V*d` is the tied embedding/output matrix; `4*d*d` is QKV plus output attention;
`3*d*m` is SwiGLU; `2*d` is the two per-block RMSNorm scales; the final `d` is the
last RMSNorm. There are no linear biases or learned position embeddings.
`ExecutionModel.parameter_count()` independently sums actual parameter `numel()`
values when a model is later instantiated. No count is hardcoded into model logic.

## Intended hardware and limitations

Target: Windows, i7-11800H, RTX 3050 Ti with 4 GB VRAM, 32 GB system RAM. CPU float32
is the default. CUDA is opt-in and availability is checked only on explicit model
loading/initialization. Unavailable CUDA fails unless explicit CPU fallback is
configured; OOM never triggers a retry on another device.

Generation is single-sequence and recomputes the full prefix each step. There is
no KV cache, batch generation, quantization, speculative decoding, training loop,
optimizer, checkpoint writer, HTTP endpoint, or runtime adapter. Padded attention
may allocate a quadratic boolean mask; native SDPA can also require quadratic
intermediates depending on its backend. Training stores additional activations,
gradients and optimizer states. Reduced dtype and smaller context can reduce some
allocations but do not establish workload fit. No model size is claimed suitable
for production; the 126M configuration is not a guarantee of training fit in 4 GB.

Tokenizer vocabulary training is implemented separately from neural training,
but neither was run. Random weights have no demonstrated execution ability.
Generated output is untrusted data, including syntactically constrained output.
Independent evaluation and runtime verification are mandatory later integrations.
