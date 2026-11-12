"""Provenance describes weights; it is never a claim of verified task ability."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Literal


ARCHITECTURE_ID = "dense-decoder-v1"


@dataclass(frozen=True)
class ModelMetadata:
    weight_origin: Literal["random_initialized", "local_checkpoint"]
    training_status: Literal["random_initialized", "unverified", "trained"]
    config_identity: str
    tokenizer_identity: str
    initialization_seed: int | None
    checkpoint_identity: str | None = None
    architecture: str = ARCHITECTURE_ID
    independently_verified: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
