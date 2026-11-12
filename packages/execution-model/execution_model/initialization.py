"""Explicit random initialization; callers never fetch or load weights here."""

from __future__ import annotations

from contextlib import contextmanager
import math
from typing import Iterator

import torch
from torch import nn

from .normalization import RMSNorm


@contextmanager
def seeded_initialization(seed: int) -> Iterator[None]:
    """Preserve CPU RNG state; avoid initializing or reseeding any CUDA device.

    Model construction must be on CPU (or meta for checkpoint preflight).
    The context changes process-global CPU RNG state temporarily, so construction
    must not race other threads that use the global CPU random generator.
    """
    with torch.random.fork_rng(devices=[]):
        torch.random.default_generator.manual_seed(seed)
        yield


def initialize_model_weights(model: nn.Module, *, std: float, num_layers: int) -> None:
    """Initialize embeddings/projections normally and RMSNorm scales to one.

    Residual output matrices receive depth-scaled standard deviation. There is
    one embedding parameter shared by input lookup and output logits.
    """
    with torch.no_grad():
        for module in model.modules():
            if isinstance(module, (nn.Embedding, nn.Linear)):
                nn.init.normal_(module.weight, mean=0.0, std=std)
                if isinstance(module, nn.Linear) and module.bias is not None:
                    nn.init.zeros_(module.bias)
            elif isinstance(module, RMSNorm):
                nn.init.ones_(module.weight)
        residual_std = std / math.sqrt(2.0 * num_layers)
        for name, parameter in model.named_parameters():
            if name.endswith("attention.output_proj.weight") or name.endswith("feed_forward.down_proj.weight"):
                nn.init.normal_(parameter, mean=0.0, std=residual_std)
