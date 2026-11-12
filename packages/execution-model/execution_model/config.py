"""Validated, serializable architecture descriptions; no model allocation occurs here."""

from __future__ import annotations

from dataclasses import asdict, dataclass, fields, replace
import hashlib
import json
import math
from typing import Any, Mapping

from .errors import ConfigurationError


ARCHITECTURE_VERSION = "dense-decoder-v1"


@dataclass(frozen=True)
class ModelConfig:
    vocab_size: int = 16384
    hidden_size: int = 384
    intermediate_size: int = 1024
    num_layers: int = 6
    num_heads: int = 6
    max_context_length: int = 1024
    dropout: float = 0.0
    rms_norm_eps: float = 1e-6
    rope_theta: float = 10000.0
    init_std: float = 0.02
    seed: int = 0
    ignore_index: int = -100

    def __post_init__(self) -> None:
        bounds = {
            "vocab_size": (256, 65536),
            "hidden_size": (8, 4096),
            "intermediate_size": (8, 16384),
            "num_layers": (1, 64),
            "num_heads": (1, 64),
            "max_context_length": (1, 8192),
            "seed": (0, 2**63 - 1),
        }
        for name, (lower, upper) in bounds.items():
            value = getattr(self, name)
            if type(value) is not int or not lower <= value <= upper:
                raise ConfigurationError(f"{name} must be an integer in [{lower}, {upper}].")
        if type(self.ignore_index) is not int or not -(2**63) <= self.ignore_index < 0:
            raise ConfigurationError("ignore_index must be a negative signed 64-bit integer.")
        if self.hidden_size % self.num_heads:
            raise ConfigurationError("hidden_size must be divisible by num_heads.")
        if self.head_dim % 2:
            raise ConfigurationError("RoPE requires an even attention head dimension.")
        for name in ("dropout", "rms_norm_eps", "rope_theta", "init_std"):
            value = getattr(self, name)
            if type(value) not in (int, float) or not math.isfinite(value):
                raise ConfigurationError(f"{name} must be finite and numeric.")
            # Canonicalize numeric JSON representations for a stable config identity.
            object.__setattr__(self, name, float(value))
        if not 0.0 <= self.dropout < 1.0:
            raise ConfigurationError("dropout must be in [0, 1).")
        if not 1e-12 <= self.rms_norm_eps <= 1.0:
            raise ConfigurationError("rms_norm_eps must be in [1e-12, 1].")
        if not 1.0 < self.rope_theta <= 1e9:
            raise ConfigurationError("rope_theta must be in (1, 1e9].")
        if not 0.0 < self.init_std <= 1.0:
            raise ConfigurationError("init_std must be in (0, 1].")
        if self.parameter_count() > 500_000_000:
            raise ConfigurationError("This package bounds architectures to 500 million parameters.")

    @property
    def head_dim(self) -> int:
        return self.hidden_size // self.num_heads

    def parameter_count(self) -> int:
        """Exact count for bias-free projections, tied embeddings, and scale-only RMSNorm."""
        d, m, layers = self.hidden_size, self.intermediate_size, self.num_layers
        return self.vocab_size * d + layers * (4 * d * d + 3 * d * m + 2 * d) + d

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "ModelConfig":
        if not isinstance(value, Mapping):
            raise ConfigurationError("Model configuration must be a mapping.")
        expected = {field.name for field in fields(cls)}
        if set(value) != expected:
            raise ConfigurationError(
                "Model configuration must contain exactly the documented fields.",
                details={"missing": sorted(expected - set(value)), "unexpected": sorted(str(k) for k in set(value) - expected)},
            )
        return cls(**dict(value))

    @property
    def identity(self) -> str:
        document = {"architecture": ARCHITECTURE_VERSION, "config": self.to_dict()}
        canonical = json.dumps(document, sort_keys=True, separators=(",", ":"), allow_nan=False)
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


_PRESETS: dict[str, dict[str, int]] = {
    "A": {"num_layers": 6, "hidden_size": 384, "intermediate_size": 1024, "num_heads": 6},
    "B": {"num_layers": 8, "hidden_size": 512, "intermediate_size": 1408, "num_heads": 8},
    "C": {"num_layers": 12, "hidden_size": 640, "intermediate_size": 1728, "num_heads": 10},
    "D": {"num_layers": 16, "hidden_size": 768, "intermediate_size": 2048, "num_heads": 12},
}


def model_preset(name: str, **overrides: Any) -> ModelConfig:
    """Return an architecture preset; vocabulary must match the tokenizer's actual size."""
    if not isinstance(name, str) or name.upper() not in _PRESETS:
        raise ConfigurationError("Unknown model preset; choose A, B, C, or D.")
    known = {field.name for field in fields(ModelConfig)}
    if set(overrides) - known:
        raise ConfigurationError("Unknown model configuration override.")
    return replace(ModelConfig(**_PRESETS[name.upper()]), **overrides)
