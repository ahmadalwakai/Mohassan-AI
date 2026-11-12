"""RMS normalization with FP32 variance accumulation."""

from __future__ import annotations

import torch
from torch import Tensor, nn


class RMSNorm(nn.Module):
    def __init__(self, hidden_size: int, eps: float) -> None:
        super().__init__()
        self.weight = nn.Parameter(torch.ones(hidden_size, dtype=torch.float32))
        self.eps = eps

    def forward(self, hidden: Tensor) -> Tensor:
        work = hidden.float()
        normalized = work * torch.rsqrt(work.square().mean(dim=-1, keepdim=True) + self.eps)
        return (normalized * self.weight.float()).to(hidden.dtype)
