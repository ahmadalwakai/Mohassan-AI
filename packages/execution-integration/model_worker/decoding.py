"""Batched streaming of the model's standard next-token function."""
from __future__ import annotations

from dataclasses import dataclass, field

import torch
from torch import Tensor
from torch.nn import functional as F

from execution_model.cached_generation import _Cache, _forward
from execution_model.generation import GenerationConfig, _choose
from execution_model.model import ExecutionModel

# Tiny generations reuse the normal forward. Longer ones retain attention keys and values.
CACHE_AFTER_TOKENS = 4


@dataclass(frozen=True)
class GenerateInput:
    input_ids: tuple[int, ...]
    config: GenerationConfig


@dataclass(frozen=True)
class TokenStep:
    token_id: int
    stop_reason: str | None
    logits: Tensor = field(repr=False, compare=False)


class BatchCache:
    """Rotated keys and values of each live request, indexed by original batch row."""

    def __init__(self, trunk: ExecutionModel, batch: int, capacity: int) -> None:
        embedding = trunk.token_embedding.weight
        shape = (batch, trunk.config.num_heads, capacity, trunk.config.head_dim)
        self.layers = [
            (embedding.new_empty(shape), embedding.new_empty(shape)) for _ in trunk.blocks
        ]
        self.filled = 0

    def forward(self, trunk: ExecutionModel, ids: Tensor, rows: list[int]) -> Tensor:
        positions = torch.arange(self.filled, self.filled + ids.shape[1], device=ids.device).expand_as(ids)
        rows_index = torch.tensor(rows, device=ids.device) if len(rows) < self.layers[0][0].shape[0] else None
        hidden = trunk.token_embedding(ids)
        for block, (keys, values) in zip(trunk.blocks, self.layers):
            attention = block.attention
            batch, length, width = hidden.shape
            projected = attention.qkv_proj(block.attention_norm(hidden)).view(
                batch, length, 3, attention.num_heads, attention.head_dim
            )
            query, key, value = (part.transpose(1, 2) for part in projected.unbind(dim=2))
            query, key = attention.rope(query, key, positions)
            end = self.filled + length
            if rows_index is None:
                keys[:, :, self.filled:end] = key
                values[:, :, self.filled:end] = value
                visible_keys, visible_values = keys[:, :, :end], values[:, :, :end]
            else:
                keys[rows_index, :, self.filled:end] = key
                values[rows_index, :, self.filled:end] = value
                visible_keys, visible_values = keys[:, :, :end][rows_index], values[:, :, :end][rows_index]
            # The first pass is causal. Each incremental query can see every cached key.
            attended = F.scaled_dot_product_attention(query, visible_keys, visible_values, is_causal=length > 1)
            attended = attended.transpose(1, 2).contiguous().view(batch, length, width)
            hidden = hidden + attention.output_proj(attended)
            hidden = hidden + block.feed_forward(block.ffn_norm(hidden))
        self.filled += ids.shape[1]
        return F.linear(trunk.final_norm(hidden[:, -1]), trunk.token_embedding.weight)


class GenerationBatch:
    def __init__(self, trunk: ExecutionModel, values: list[GenerateInput], eos: int | None,
                 *, use_cache: bool | None = None) -> None:
        self.trunk = trunk
        self.values = values
        self.eos = eos
        self.rng = [torch.Generator(device="cpu").manual_seed(value.config.seed) for value in values]
        self.generated: list[list[int]] = [[] for _ in values]
        self.finished: set[int] = set()
        budget = max(value.config.max_new_tokens for value in values)
        self.cache_enabled = budget > CACHE_AFTER_TOKENS if use_cache is None else use_cache
        self.capacity = len(values[0].input_ids) + budget
        self.cache: BatchCache | _Cache | None = None

    @torch.inference_mode()
    def step(self, active: list[int]) -> dict[int, TokenStep]:
        active = sorted(set(active) - self.finished)
        if not active:
            return {}
        device = self.trunk.token_embedding.weight.device
        if self.cache_enabled:
            pending = [
                self.generated[index][-1:] or self.values[index].input_ids for index in active
            ]
            if len(self.values) == 1:
                if self.cache is None:
                    self.cache = _Cache(self.trunk, self.capacity, device, self.trunk.token_embedding.weight.dtype)
                logits = _forward(self.trunk, list(pending[0]), self.cache, device).unsqueeze(0)
            else:
                if self.cache is None:
                    self.cache = BatchCache(self.trunk, len(self.values), self.capacity)
                ids = torch.tensor(pending, dtype=torch.long, device=device)
                logits = self.cache.forward(self.trunk, ids, active)
        else:
            ids = torch.tensor([
                (*self.values[index].input_ids, *self.generated[index]) for index in active
            ], dtype=torch.long, device=device)
            logits = self.trunk(ids, last_token_only=True).logits[:, -1]

        steps = {}
        for row, index in enumerate(active):
            config = self.values[index].config
            scores = logits[row]
            token = _choose(scores, config, self.rng[index], None, set())
            self.generated[index].append(token)
            reason = None
            if token == self.eos:
                reason = "eos"
            elif len(self.generated[index]) == config.max_new_tokens:
                reason = "length"
            if reason:
                self.finished.add(index)
            steps[index] = TokenStep(token, reason, scores)
        return steps
