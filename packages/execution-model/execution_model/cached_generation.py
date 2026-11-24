"""Single-sequence decoding with a key/value cache, for serving replies on the CPU.

`generation.generate` deliberately recomputes the whole sequence for every new token. That stays the reference
used by every pinned evaluation. This module computes the same function faster: the prompt runs once through the
model's own layers, each block keeps its rotated keys and values, and every later step feeds only the new token.
All layer math is the model's own modules (norms, projections, rotary embedding, feed-forward, tied output); only
the attention read over cached keys is new. Results match the reference up to float rounding of reordered sums;
tests compare logits and greedy tokens. No truncation, batching, writes or model-mode changes.
"""

from __future__ import annotations

from collections.abc import Sequence

import torch
from torch import Tensor
from torch.nn import functional as F

from .errors import ContextLengthError, InvalidRequestError, NumericalError
from .generation import GenerationConfig, GenerationResult, _choose
from .model import ExecutionModel


class _Cache:
    """Preallocated rotated keys and values per block, filled left to right."""

    def __init__(self, model: ExecutionModel, length: int, device: torch.device, dtype: torch.dtype) -> None:
        heads, width = model.config.num_heads, model.config.head_dim
        shape = (1, heads, length, width)
        self.keys = [torch.empty(shape, device=device, dtype=dtype) for _ in model.blocks]
        self.values = [torch.empty(shape, device=device, dtype=dtype) for _ in model.blocks]
        self.filled = 0


def _attention(block, hidden: Tensor, positions: Tensor, cache: _Cache, index: int, start: int) -> Tensor:
    attention = block.attention
    batch, length, width = hidden.shape
    projected = attention.qkv_proj(hidden).view(batch, length, 3, attention.num_heads, attention.head_dim)
    query, key, value = (part.transpose(1, 2) for part in projected.unbind(dim=2))
    query, key = attention.rope(query, key, positions)
    end = start + length
    cache.keys[index][:, :, start:end] = key
    cache.values[index][:, :, start:end] = value
    keys, values = cache.keys[index][:, :, :end], cache.values[index][:, :, :end]
    # The prompt pass is the model's own causal call; a single new query may read every cached key.
    attended = F.scaled_dot_product_attention(query, keys, values, is_causal=length > 1)
    attended = attended.transpose(1, 2).contiguous().view(batch, length, width)
    return attention.output_proj(attended)


def _forward(model: ExecutionModel, tokens: list[int], cache: _Cache, device: torch.device) -> Tensor:
    """Logits for the last of `tokens`, which continue the cached sequence."""
    start = cache.filled
    ids = torch.tensor([tokens], dtype=torch.long, device=device)
    positions = torch.arange(start, start + len(tokens), device=device).unsqueeze(0)
    hidden = model.token_embedding(ids)
    for index, block in enumerate(model.blocks):
        hidden = hidden + _attention(block, block.attention_norm(hidden), positions, cache, index, start)
        hidden = hidden + block.feed_forward(block.ffn_norm(hidden))
    cache.filled = start + len(tokens)
    hidden = model.final_norm(hidden[:, -1:])
    logits = F.linear(hidden, model.token_embedding.weight)
    if not bool(torch.isfinite(logits).all()):
        raise NumericalError("Model produced non-finite logits.")
    return logits[0, -1]


def generate_cached(model: ExecutionModel, input_ids: Sequence[int], config: GenerationConfig, *,
                    eos_token_id: int | None = None, blocked_token_ids: Sequence[int] = (),
                    max_context_length: int | None = None) -> GenerationResult:
    """The reference `generate` contract for plain decoding (no constraint, no cancellation)."""
    if not isinstance(model, ExecutionModel):
        raise InvalidRequestError("model must be ExecutionModel.")
    if not isinstance(config, GenerationConfig):
        raise InvalidRequestError("config must be GenerationConfig.")
    if model.training:
        raise InvalidRequestError("Generation requires model.eval().")
    if not isinstance(input_ids, (list, tuple)) or not input_ids:
        raise InvalidRequestError("input_ids must be a nonempty list or tuple.")
    vocab_size, limit = model.config.vocab_size, model.config.max_context_length
    if max_context_length is not None:
        if type(max_context_length) is not int or not 1 <= max_context_length <= limit:
            raise InvalidRequestError("Requested context limit exceeds the model configuration.")
        limit = max_context_length
    budget = config.max_new_tokens
    if len(input_ids) + budget > limit:
        raise ContextLengthError("Prompt and requested output budget exceed the context window.",
                                 details={"input_tokens": len(input_ids), "requested_output_tokens": budget,
                                          "max_context_length": limit})
    if any(type(token) is not int or not 0 <= token < vocab_size for token in input_ids):
        raise InvalidRequestError("Input token id is outside the vocabulary.")
    if eos_token_id is not None and (type(eos_token_id) is not int or not 0 <= eos_token_id < vocab_size):
        raise InvalidRequestError("EOS token id is outside the vocabulary.")
    stops = set(config.stop_token_ids) | ({eos_token_id} if eos_token_id is not None else set())
    blocked = set(blocked_token_ids)
    if any(type(token) is not int or not 0 <= token < vocab_size for token in stops | blocked):
        raise InvalidRequestError("Stop or blocked token id is outside the vocabulary.")
    if stops & blocked:
        raise InvalidRequestError("A token cannot be both blocked and a stop token.")
    deterministic = torch.are_deterministic_algorithms_enabled()
    rng = torch.Generator(device="cpu").manual_seed(config.seed)
    device = next(model.parameters()).device
    generated: list[int] = []
    terminal, reason = None, "length"
    with torch.inference_mode():
        cache = _Cache(model, len(input_ids) + budget, device, model.token_embedding.weight.dtype)
        pending = list(input_ids)
        for _ in range(budget):
            logits = _forward(model, pending, cache, device)
            token = _choose(logits, config, rng, None, blocked)
            generated.append(token)
            if token in stops:
                terminal = token
                reason = "eos" if token == eos_token_id else "stop_token"
                break
            pending = [token]
    return GenerationResult(token_ids=tuple(generated), input_tokens=len(input_ids), output_tokens=len(generated),
                            stop_reason=reason, terminal_token_id=terminal, constraint_satisfied=None,
                            seed=config.seed, deterministic_algorithms=deterministic)
