"""Resource-oriented experiments; these presets are not measured optimal settings."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field, replace
import math
from typing import Any

from .common import digest
from .errors import TrainingError

EXPERIMENTAL_TOKEN_BUDGETS = (10_000_000, 50_000_000, 100_000_000)
PRESET_PARAMETER_ESTIMATES = {"17m": 17_000_000, "34m": 34_000_000,
                              "70m": 70_000_000, "126m": 126_000_000}


@dataclass(frozen=True)
class ResourceLimits:
    min_free_disk_bytes: int = 2 * 1024**3
    max_cuda_reserved_bytes: int | None = None
    max_elapsed_seconds: float | None = None
    max_checkpoint_bytes: int = 8 * 1024**3

    def validate(self) -> None:
        for name in ("min_free_disk_bytes", "max_checkpoint_bytes"):
            value = getattr(self, name)
            if type(value) is not int or value < (1 if name == "max_checkpoint_bytes" else 0):
                raise TrainingError("INVALID_CONFIGURATION", f"Invalid resource limit: {name}")
        if self.max_cuda_reserved_bytes is not None and (
            type(self.max_cuda_reserved_bytes) is not int or self.max_cuda_reserved_bytes <= 0
        ):
            raise TrainingError("INVALID_CONFIGURATION", "max_cuda_reserved_bytes must be positive")
        if self.max_elapsed_seconds is not None and (
            type(self.max_elapsed_seconds) not in (int, float)
            or not math.isfinite(self.max_elapsed_seconds) or self.max_elapsed_seconds <= 0
        ):
            raise TrainingError("INVALID_CONFIGURATION", "max_elapsed_seconds must be finite and positive")


@dataclass(frozen=True)
class TrainingConfig:
    # This opaque identity is supplied/confirmed by the Phase 2 factory. No architecture lives here.
    architecture_id: str
    preset: str = "17m"
    microbatch_size: int = 1
    gradient_accumulation_steps: int = 16
    context_length: int = 256
    learning_rate: float = 3e-4
    weight_decay: float = 0.1
    optimizer: str = "adamw"
    adam_betas: tuple[float, float] = (0.9, 0.95)
    adam_eps: float = 1e-8
    optimizer_foreach: bool = False
    scheduler: str = "cosine"
    warmup_tokens: int = 100_000
    min_learning_rate_ratio: float = 0.1
    gradient_clip_norm: float = 1.0
    precision: str = "auto"
    device: str = "cuda"
    allow_cpu_fallback: bool = False
    activation_checkpointing: bool = False
    seed: int = 1729
    max_processed_tokens: int = 10_000_000
    allow_extended_budget: bool = False
    validation_interval_steps: int = 100
    validation_batches: int = 8
    checkpoint_interval_steps: int = 100
    resume_checkpoint: str | None = None
    deterministic_algorithms: bool = True
    objective: str = "supervised"
    profile_enabled: bool = False
    resources: ResourceLimits = field(default_factory=ResourceLimits)

    def validate(self) -> None:
        if not isinstance(self.architecture_id, str) or not self.architecture_id.strip():
            raise TrainingError("INVALID_CONFIGURATION", "Phase 2 architecture identity is required")
        if self.preset not in PRESET_PARAMETER_ESTIMATES:
            raise TrainingError("INVALID_CONFIGURATION", "Unknown Phase 2 size preset")
        if self.optimizer not in {"adamw", "sgd"} or self.scheduler not in {"cosine", "linear", "constant"}:
            raise TrainingError("INVALID_CONFIGURATION", "Unsupported optimizer or scheduler")
        if self.precision not in {"auto", "fp32", "fp16", "bf16"} or self.device not in {"cpu", "cuda"}:
            raise TrainingError("INVALID_CONFIGURATION", "Unsupported precision or device")
        if self.objective not in {"supervised", "causal_lm"}:
            raise TrainingError("INVALID_CONFIGURATION", "Unsupported objective")
        for name in ("microbatch_size", "gradient_accumulation_steps", "context_length", "max_processed_tokens",
                     "validation_interval_steps", "validation_batches", "checkpoint_interval_steps"):
            if type(getattr(self, name)) is not int or getattr(self, name) <= 0:
                raise TrainingError("INVALID_CONFIGURATION", f"{name} must be a positive integer")
        if self.context_length < 2:
            raise TrainingError("INVALID_CONFIGURATION", "Causal prediction needs at least two tokens")
        if type(self.seed) is not int or not 0 <= self.seed < 2**32:
            raise TrainingError("INVALID_CONFIGURATION", "seed must be an integer in [0, 2**32)")
        if type(self.warmup_tokens) is not int or not 0 <= self.warmup_tokens < self.max_processed_tokens:
            raise TrainingError("INVALID_CONFIGURATION", "warmup_tokens must be below the total budget")
        for name in ("learning_rate", "weight_decay", "adam_eps", "gradient_clip_norm", "min_learning_rate_ratio"):
            value = getattr(self, name)
            if type(value) not in (int, float) or not math.isfinite(value):
                raise TrainingError("INVALID_CONFIGURATION", f"{name} must be finite")
        if self.learning_rate <= 0 or self.weight_decay < 0 or self.adam_eps <= 0 or self.gradient_clip_norm <= 0:
            raise TrainingError("INVALID_CONFIGURATION", "Invalid optimizer numeric setting")
        if not 0 <= self.min_learning_rate_ratio <= 1:
            raise TrainingError("INVALID_CONFIGURATION", "Learning-rate ratio must be in [0, 1]")
        if (not isinstance(self.adam_betas, tuple) or len(self.adam_betas) != 2
                or any(type(x) not in (int, float) or not 0 <= x < 1 for x in self.adam_betas)):
            raise TrainingError("INVALID_CONFIGURATION", "Adam beta values must be in [0, 1)")
        for name in ("optimizer_foreach", "allow_cpu_fallback", "activation_checkpointing",
                     "allow_extended_budget", "deterministic_algorithms", "profile_enabled"):
            if type(getattr(self, name)) is not bool:
                raise TrainingError("INVALID_CONFIGURATION", f"{name} must be boolean")
        if self.max_processed_tokens > 100_000_000 and not self.allow_extended_budget:
            raise TrainingError("INVALID_CONFIGURATION", "Longer budgets require allow_extended_budget=True")
        if self.resume_checkpoint is not None and (not isinstance(self.resume_checkpoint, str) or not self.resume_checkpoint.strip()):
            raise TrainingError("INVALID_CONFIGURATION", "Invalid resume checkpoint reference")
        if not isinstance(self.resources, ResourceLimits):
            raise TrainingError("INVALID_CONFIGURATION", "resources must be ResourceLimits")
        self.resources.validate()

    def to_dict(self) -> dict[str, Any]:
        self.validate()
        return asdict(self)

    def resume_identity(self) -> str:
        values = self.to_dict()
        values.pop("resume_checkpoint")
        return digest(values)


def preset_config(name: str, *, architecture_id: str, **overrides: Any) -> TrainingConfig:
    """An architecture identity must come from Phase 2, even for a named size preset."""
    if name not in PRESET_PARAMETER_ESTIMATES:
        raise TrainingError("INVALID_CONFIGURATION", f"Unknown preset: {name}")
    config = TrainingConfig(architecture_id=architecture_id, preset=name,
                            context_length=256 if name in {"17m", "34m"} else 512,
                            gradient_accumulation_steps=16 if name in {"17m", "34m"} else 32,
                            activation_checkpointing=name in {"70m", "126m"})
    config = replace(config, **overrides)
    config.validate()
    return config
