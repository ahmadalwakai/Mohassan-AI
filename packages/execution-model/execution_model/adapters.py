"""Optional LoRA adapters on a frozen ExecutionModel trunk (nested-architecture plan, P3-P5).

`attach_adapter` swaps the targeted nn.Linear modules for LoRA wrappers that hold
the original module untouched; `detach_adapter` puts the originals back, so the
trunk's state_dict and outputs return exactly to the base. One adapter at a
time per model (AT-ISOLATION). B is zero-initialized, so a fresh adapter is a
no-op until trained.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import torch
from torch import Tensor, nn

from .errors import ConfigurationError, InvalidRequestError
from .model import ExecutionModel

DEFAULT_TARGETS = ("attention.qkv_proj", "attention.output_proj",
                   "feed_forward.gate_proj", "feed_forward.up_proj", "feed_forward.down_proj")
_ACTIVE = "_mohassan_active_adapter"


class LoRALinear(nn.Module):
    def __init__(self, base: nn.Linear, rank: int, alpha: float) -> None:
        super().__init__()
        self.base = base
        self.rank = rank
        self.scaling = alpha / rank
        self.lora_a = nn.Parameter(torch.empty(rank, base.in_features, dtype=torch.float32))
        self.lora_b = nn.Parameter(torch.zeros(base.out_features, rank, dtype=torch.float32))
        nn.init.kaiming_uniform_(self.lora_a, a=math.sqrt(5))

    def forward(self, hidden: Tensor) -> Tensor:
        delta = (hidden @ self.lora_a.to(hidden.dtype).t()) @ self.lora_b.to(hidden.dtype).t()
        return self.base(hidden) + delta * self.scaling


@dataclass
class AdapterHandle:
    name: str
    rank: int
    alpha: float
    targets: tuple[str, ...]
    modules: dict[str, LoRALinear]
    originals: dict[str, nn.Linear]

    def parameters(self) -> list[nn.Parameter]:
        return [p for module in self.modules.values() for p in (module.lora_a, module.lora_b)]

    def parameter_count(self) -> int:
        return sum(p.numel() for p in self.parameters())

    def state_module(self) -> nn.Module:
        """A plain container whose state_dict is just the adapter tensors (for sidecar files)."""
        container = nn.Module()
        for path, module in self.modules.items():
            holder = nn.Module()
            holder.lora_a, holder.lora_b = module.lora_a, module.lora_b
            container.add_module(path.replace(".", "__"), holder)
        return container


def expected_parameters(model: ExecutionModel, rank: int, targets: tuple[str, ...] = DEFAULT_TARGETS) -> int:
    total = 0
    for block in model.blocks:
        for target in targets:
            linear = block.get_submodule(target)
            if isinstance(linear, LoRALinear):
                linear = linear.base
            total += rank * (linear.in_features + linear.out_features)
    return total


def active_adapter(model: ExecutionModel) -> AdapterHandle | None:
    return getattr(model, _ACTIVE, None)


def attach_adapter(model: ExecutionModel, name: str, *, rank: int = 8, alpha: float = 16.0,
                   targets: tuple[str, ...] = DEFAULT_TARGETS, seed: int = 0) -> AdapterHandle:
    if not isinstance(model, ExecutionModel):
        raise ConfigurationError("attach_adapter requires an ExecutionModel.")
    if active_adapter(model) is not None:
        raise InvalidRequestError("An adapter is already attached; detach it first (one adapter at a time).")
    if type(rank) is not int or not 1 <= rank <= 256 or not alpha > 0:
        raise ConfigurationError("rank must be 1..256 and alpha positive.")
    device = next(model.parameters()).device
    modules: dict[str, LoRALinear] = {}
    originals: dict[str, nn.Linear] = {}
    generator_state = torch.random.get_rng_state()
    torch.manual_seed(seed)
    try:
        for index, block in enumerate(model.blocks):
            for target in targets:
                parent_path, _, leaf = target.rpartition(".")
                parent = block.get_submodule(parent_path) if parent_path else block
                original = getattr(parent, leaf)
                if not isinstance(original, nn.Linear):
                    raise ConfigurationError(f"Target {target} is not a Linear layer.")
                wrapper = LoRALinear(original, rank, alpha).to(device)
                setattr(parent, leaf, wrapper)
                key = f"blocks.{index}.{target}"
                modules[key], originals[key] = wrapper, original
    finally:
        torch.random.set_rng_state(generator_state)
    handle = AdapterHandle(name, rank, alpha, tuple(targets), modules, originals)
    object.__setattr__(model, _ACTIVE, handle)
    return handle


def detach_adapter(model: ExecutionModel) -> AdapterHandle:
    handle = active_adapter(model)
    if handle is None:
        raise InvalidRequestError("No adapter is attached.")
    for key, original in handle.originals.items():
        parent_path, _, leaf = key.rpartition(".")
        setattr(model.get_submodule(parent_path), leaf, original)
    object.__delattr__(model, _ACTIVE)
    return handle
