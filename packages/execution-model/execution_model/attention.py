"""Native PyTorch causal multi-head attention; deliberately no KV cache."""

from __future__ import annotations

import torch
from torch import Tensor, nn
from torch.nn import functional as F

from .config import ModelConfig
from .positional import RotaryPositionEmbedding


class CausalSelfAttention(nn.Module):
    def __init__(self, config: ModelConfig) -> None:
        super().__init__()
        self.num_heads = config.num_heads
        self.head_dim = config.head_dim
        self.dropout = config.dropout
        self.qkv_proj = nn.Linear(config.hidden_size, 3 * config.hidden_size, bias=False, dtype=torch.float32)
        self.output_proj = nn.Linear(config.hidden_size, config.hidden_size, bias=False, dtype=torch.float32)
        self.rope = RotaryPositionEmbedding(config.head_dim, config.rope_theta)

    def forward(self, hidden: Tensor, valid_tokens: Tensor, position_ids: Tensor) -> Tensor:
        batch, length, width = hidden.shape
        projected = self.qkv_proj(hidden).view(batch, length, 3, self.num_heads, self.head_dim)
        query, key, value = (part.transpose(1, 2) for part in projected.unbind(dim=2))
        query, key = self.rope(query, key, position_ids)
        dropout = self.dropout if self.training else 0.0
        if bool(valid_tokens.all()):
            attended = F.scaled_dot_product_attention(query, key, value, dropout_p=dropout, is_causal=True)
        else:
            causal = torch.ones((length, length), device=hidden.device, dtype=torch.bool).tril()
            query_valid = valid_tokens[:, None, :, None]
            key_valid = valid_tokens[:, None, None, :]
            allowed = causal[None, None, :, :] & query_valid & key_valid
            # Each padding query gets only its own diagonal, avoiding fully masked
            # softmax rows on all native backends. Its result is then discarded.
            diagonal = torch.eye(length, device=hidden.device, dtype=torch.bool)[None, None, :, :]
            allowed = allowed | (~query_valid & diagonal)
            attended = F.scaled_dot_product_attention(query, key, value, attn_mask=allowed, dropout_p=dropout)
        attended = attended.transpose(1, 2).contiguous().view(batch, length, width)
        attended = self.output_proj(attended)
        return attended.masked_fill(~valid_tokens.unsqueeze(-1), 0.0)
