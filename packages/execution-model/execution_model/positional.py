"""Rotary position embeddings, pairing adjacent head channels."""

from __future__ import annotations

import torch
from torch import Tensor, nn


class RotaryPositionEmbedding(nn.Module):
    """No persistent frequency buffer: dtype conversion cannot round stored frequencies."""

    def __init__(self, head_dim: int, theta: float) -> None:
        super().__init__()
        self.head_dim = head_dim
        self.theta = theta

    def forward(self, query: Tensor, key: Tensor, position_ids: Tensor) -> tuple[Tensor, Tensor]:
        # Disable autocast explicitly: trigonometry and rotation are evaluated in FP32.
        with torch.autocast(device_type=query.device.type, enabled=False):
            exponents = torch.arange(0, self.head_dim, 2, device=query.device, dtype=torch.float32)
            inv_frequency = torch.pow(self.theta, -exponents / self.head_dim)
            angles = position_ids.float().unsqueeze(-1) * inv_frequency
            cosine, sine = angles.cos().unsqueeze(1), angles.sin().unsqueeze(1)

            def rotate(value: Tensor) -> Tensor:
                even, odd = value.float()[..., 0::2], value.float()[..., 1::2]
                rotated = torch.stack((even * cosine - odd * sine, even * sine + odd * cosine), dim=-1)
                return rotated.flatten(-2).to(value.dtype)

            return rotate(query), rotate(key)
