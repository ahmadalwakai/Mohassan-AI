"""Explicit hardware and precision negotiation. Never fall back to CPU implicitly."""

from __future__ import annotations

from contextlib import nullcontext
from dataclasses import dataclass
from typing import Any

from .configuration import TrainingConfig
from .errors import TrainingError


@dataclass
class PrecisionContext:
    device: Any
    mode: str
    scaler: Any

    def autocast(self) -> Any:
        import torch
        if self.mode == "fp32":
            return nullcontext()
        return torch.autocast(device_type=self.device.type,
                              dtype=torch.float16 if self.mode == "fp16" else torch.bfloat16)

    def identity(self) -> dict[str, str]:
        return {"device_type": self.device.type, "mode": self.mode}


def resolve_precision(config: TrainingConfig) -> PrecisionContext:
    import torch
    config.validate()
    device_type = config.device
    if device_type == "cuda" and not torch.cuda.is_available():
        if not config.allow_cpu_fallback:
            raise TrainingError("CUDA_UNAVAILABLE", "CUDA is unavailable and CPU fallback is disabled")
        device_type = "cpu"
    mode = config.precision
    if device_type == "cpu":
        # Portable CPU path only: CPU BF16 kernels/support differ by machine and are not inferred.
        if mode not in {"auto", "fp32"}:
            raise TrainingError("PRECISION_UNSUPPORTED", "CPU execution supports explicit FP32 or auto only")
        mode = "fp32"
    else:
        major, _minor = torch.cuda.get_device_capability()
        # Avoid selecting BF16 merely because tensor allocation/emulation works.
        # This local CUDA path requires Ampere-or-newer capability plus Torch support.
        bf16_supported = major >= 8 and bool(torch.cuda.is_bf16_supported())
        if mode == "auto":
            mode = "bf16" if bf16_supported else ("fp16" if major >= 5 else "fp32")
        if mode == "bf16" and not bf16_supported:
            raise TrainingError("PRECISION_UNSUPPORTED", "The selected CUDA device does not support BF16")
        if mode == "fp16" and major < 5:
            raise TrainingError("PRECISION_UNSUPPORTED", "The selected CUDA device does not support this FP16 path")
    scaler = torch.amp.GradScaler("cuda", enabled=device_type == "cuda" and mode == "fp16")
    return PrecisionContext(torch.device(device_type), mode, scaler)
