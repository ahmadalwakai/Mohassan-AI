# Architecture and forward contract

`ExecutionModel(ModelConfig(...))` builds all neural weights from scratch. It uses
only native PyTorch modules/operations. The architecture version is
`dense-decoder-v1`; configuration identity hashes this version together with the
complete canonical configuration. `ModelConfig.from_dict` requires every known
field and rejects extra fields. Configuration is immutable after construction.

## Computation

```text
tokens -> embedding -> dropout
  repeated L times:
    h = h + dropout(causal_attention(RMSNorm(h)))
    h = h + dropout(SwiGLU(RMSNorm(h)))
    zero padded positions
  -> final RMSNorm -> F.linear(h, token_embedding.weight) -> logits
```

Attention is ordinary dense multihead self-attention, with bias-free combined
QKV and output projections. RoPE rotates adjacent pairs in each head; positions
count nonpadding tokens from zero. RoPE frequencies and trigonometry are derived
in float32 per call, so converting model dtype cannot round a persistent frequency
buffer. `hidden_size / num_heads` must be an even integer.

SwiGLU is `down(silu(gate(h)) * up(h))`, with three bias-free projections.
RMSNorm computes variance in float32 and adds `rms_norm_eps` before reciprocal
square root. Logits and training loss are checked for nonfinite values; loss and
sampling probabilities use float32. SDPA receives dropout only in training mode.
Low-precision arithmetic can still overflow; a failure is reported rather than
replacing invalid values with invented logits.

For unpadded input, native scaled-dot-product attention uses `is_causal=True`.
For padded input the explicit boolean mask allows exactly valid queries/keys
where key index is at most query index. Padded queries attend only to their own
diagonal to avoid an all-masked softmax row, then their output is zeroed. No valid
query can attend to future or padded keys. Left and right padding are supported;
each row must have at least one real token. Mask value one/True means real token.
These boolean semantics follow [PyTorch SDPA](https://docs.pytorch.org/docs/stable/generated/torch.nn.functional.scaled_dot_product_attention.html).

Padding masks do not isolate multiple packed examples within one row. Phase 3
must use separate rows for independent examples unless intentionally permitting
cross-example causal context. The API does not implement segment/document masks.

## Random initialization and reproducibility

Embeddings and linear weights are initialized from a zero-mean normal distribution
with configurable `init_std` (default 0.02). Attention output and SwiGLU down
projections use `init_std / sqrt(2 * num_layers)`. RMSNorm scales initialize to one.
Input and output use the same embedding parameter; no output-head copy exists.

Construction uses float32 on CPU; CUDA placement is a separate operation. A meta
device context is supported exclusively for allocation-free checkpoint structure
preflight. CPU RNG state is saved/restored with `fork_rng(devices=[])`, and only
the CPU generator is seeded. No checkpoint or external artifact is read during
random construction. Model attributes report `weight_origin=random_initialized`
and `initialization_seed`; the inference facade additionally records tokenizer
and configuration identities and `training_status=random_initialized`.

Initialization must not race other threads using the global CPU RNG. Same seed,
configuration, and supported software/platform conditions provide reproducible
initialization; cross-version/device bitwise equality is not promised. PyTorch
also documents [limits to reproducibility](https://docs.pytorch.org/docs/stable/notes/randomness.html).

## Forward API

```python
output = model(
    input_ids,                 # torch.long [B, T], valid ids at every position
    attention_mask=mask,        # optional bool/integer 0/1 [B, T]
    labels=labels,              # optional torch.long [B, T], UNSHIFTED
    last_token_only=False,
)
logits = output.logits         # [B, T, V], model execution dtype
loss = output.loss             # float32 scalar, or None without labels
```

Inputs/masks/labels and model weights must be on the same CPU or CUDA device.
Shapes, token ranges, dtypes, batch bound (1..64), and architecture context length
are validated. Context must be 1..8,192; architectures are capped at 500M parameters.
These are defensive ceilings, not promises of feasible training workloads.

Labels are shifted internally: logits at position `t` predict `labels[t+1]`.
Provide unshifted labels once. Default ignore index is -100 and must remain a
negative signed integer. Both predicting query and target must be nonpadding for
a loss contribution. Set prompt label positions to ignore index for response-only
training; the first response token remains predicted from the final prompt token.
A one-token or all-ignored example returns exact differentiable zero loss.
Phase 3 can call `model.train()` and backpropagate the returned loss normally.

For inference, `last_token_only=True` projects only each row's last valid hidden
position and returns `[B, 1, V]`. It cannot be combined with labels. Forward itself
does not disable autograd; the generation engine uses `torch.inference_mode()`
only during tensor work, with `model.eval()` required. It does not retain hidden
states, attention matrices, or fake cache outputs in `ModelOutput`.
