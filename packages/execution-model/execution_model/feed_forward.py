"""Bias-free SwiGLU feed-forward sublayer."""

from __future__ import annotations

import torch
from torch import Tensor, nn
from torch.nn import functional as F

from .config import ModelConfig


class SwiGLU(nn.Module):
    def __init__(self, config: ModelConfig) -> None:
        super().__init__()
        self.gate_proj = nn.Linear(config.hidden_size, config.intermediate_size, bias=False, dtype=torch.float32)
        self.up_proj = nn.Linear(config.hidden_size, config.intermediate_size, bias=False, dtype=torch.float32)
        self.down_proj = nn.Linear(config.intermediate_size, config.hidden_size, bias=False, dtype=torch.float32)

    def forward(self, hidden: Tensor) -> Tensor:
        return self.down_proj(F.silu(self.gate_proj(hidden)) * self.up_proj(hidden))
