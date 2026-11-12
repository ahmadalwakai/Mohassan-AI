"""Explicit device, precision, and request limits; no environment mutation."""

from __future__ import annotations

from dataclasses import asdict, dataclass
import re
from typing import Any, TypeVar

import torch
from torch import nn

from .errors import ConfigurationError, ResourceError


_DTYPES = {
    "float32": torch.float32,
    "float16": torch.float16,
    "bfloat16": torch.bfloat16,
}
_Module = TypeVar("_Module", bound=nn.Module)


@dataclass(frozen=True)
class ResolvedResources:
    device: torch.device
    dtype: torch.dtype
    requested_device: str
    requested_dtype: str
    fallback_reason: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "device": str(self.device),
            "dtype": str(self.dtype).removeprefix("torch."),
            "requested_device": self.requested_device,
            "requested_dtype": self.requested_dtype,
            "fallback_reason": self.fallback_reason,
        }


@dataclass(frozen=True)
class ResourceConfig:
    """Limits are per engine, not a prediction that a workload fits in VRAM.

    CPU fallback is allowed only for an unavailable CUDA device and only when
    explicitly enabled. Such fallback uses float32. Allocation failures never
    trigger a second attempt on another device.
    """

    device: str = "cpu"
    dtype: str = "float32"
    max_context_length: int = 1024
    max_output_tokens: int = 256
    max_input_bytes: int = 262_144
    max_checkpoint_bytes: int = 1_073_741_824
    allow_cpu_fallback: bool = False

    def __post_init__(self) -> None:
        if not isinstance(self.device, str) or not re.fullmatch(r"cpu|cuda(?::[0-9]+)?", self.device):
            raise ConfigurationError("device must be cpu, cuda, or cuda:<index>.")
        if not isinstance(self.dtype, str) or self.dtype not in _DTYPES:
            raise ConfigurationError("dtype must be float32, float16, or bfloat16.")
        if type(self.allow_cpu_fallback) is not bool:
            raise ConfigurationError("allow_cpu_fallback must be boolean.")
        limits = {
            "max_context_length": (1, 8192),
            "max_output_tokens": (1, 8192),
            "max_input_bytes": (1, 1_048_576),
            "max_checkpoint_bytes": (1, 2_147_483_648),
        }
        for name, (minimum, maximum) in limits.items():
            value = getattr(self, name)
            if type(value) is not int or not minimum <= value <= maximum:
                raise ConfigurationError(f"{name} must be an integer from {minimum} to {maximum}.")
        if self.device == "cpu" and self.dtype == "float16":
            raise ConfigurationError("CPU float16 is not supported by this engine; use float32 or bfloat16.")
        if ":" in self.device and len(self.device.split(":", 1)[1]) > 4:
            raise ConfigurationError("CUDA device index must have at most four digits.")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    def resolve(self) -> ResolvedResources:
        """Inspect availability only when explicitly creating/loading an engine."""
        if self.device == "cpu":
            return ResolvedResources(torch.device("cpu"), _DTYPES[self.dtype], self.device, self.dtype)
        index = int(self.device.split(":", 1)[1]) if ":" in self.device else 0
        try:
            available = torch.cuda.is_available() and index < torch.cuda.device_count()
        except (RuntimeError, AssertionError) as error:
            raise ResourceError("CUDA availability could not be determined.", details={"reason": "CUDA_PROBE_FAILED"}) from error
        if not available:
            if self.allow_cpu_fallback:
                return ResolvedResources(
                    torch.device("cpu"), torch.float32, self.device, self.dtype,
                    "CUDA_UNAVAILABLE_EXPLICIT_CPU_FALLBACK",
                )
            raise ResourceError("The explicitly requested CUDA device is unavailable.", details={"reason": "CUDA_UNAVAILABLE", "device": self.device})
        if self.dtype == "bfloat16":
            # Ampere and newer CUDA devices support the BF16 arithmetic used here.
            # Query the selected GPU, not whichever GPU happens to be current.
            try:
                major, _minor = torch.cuda.get_device_capability(index)
            except (RuntimeError, AssertionError) as error:
                raise ResourceError("CUDA device capabilities could not be read.", details={"reason": "CUDA_PROBE_FAILED"}) from error
            if major < 8:
                raise ResourceError("The selected CUDA device does not support native bfloat16.", details={"reason": "DTYPE_UNSUPPORTED"})
        return ResolvedResources(torch.device("cuda", index), _DTYPES[self.dtype], self.device, self.dtype)


def is_out_of_memory(error: BaseException) -> bool:
    """Recognize PyTorch allocation failures without retrying the allocation."""
    return isinstance(error, torch.OutOfMemoryError) or (
        isinstance(error, RuntimeError)
        and ("out of memory" in str(error).lower() or "can't allocate memory" in str(error).lower())
    )


def place_model(model: _Module, resolved: ResolvedResources) -> _Module:
    try:
        return model.to(device=resolved.device, dtype=resolved.dtype)
    except (RuntimeError, MemoryError) as error:
        reason = "OUT_OF_MEMORY" if isinstance(error, MemoryError) or is_out_of_memory(error) else "DEVICE_OR_DTYPE_FAILURE"
        raise ResourceError("Model placement failed; no automatic retry was attempted.", details={"reason": reason, **resolved.to_dict()}) from error
