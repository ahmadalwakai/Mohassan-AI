"""Measured usage; no guessed hardware inventory or zero-filled missing usage."""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

from .attribution import ReasoningTrace


@dataclass(frozen=True)
class ResourceUsage:
    input_tokens: int | None = None
    output_tokens: int | None = None
    peak_memory_bytes: int | None = None
    cpu_time_ms: float | None = None
    accelerator_time_ms: float | None = None
    energy_wh: float | None = None
    measured_by: str | None = None
    scope: str = "unknown"

    def __post_init__(self) -> None:
        if self.measured_by is not None and (not isinstance(self.measured_by, str) or not self.measured_by):
            raise ValueError("Measurement identity must be a nonempty string")
        for name in ("input_tokens", "output_tokens", "peak_memory_bytes"):
            value = getattr(self, name)
            if value is not None and (type(value) is not int or value < 0):
                raise ValueError(f"Invalid {name}")
        for name in ("cpu_time_ms", "accelerator_time_ms", "energy_wh"):
            value = getattr(self, name)
            if value is not None and (type(value) not in (int, float) or not math.isfinite(value) or value < 0):
                raise ValueError(f"Invalid {name}")
        if self.scope not in ("unknown", "worker", "process_tree", "isolated_job", "full_system"):
            raise ValueError("Invalid resource scope")
        if any(getattr(self, name) is not None for name in ("input_tokens", "output_tokens", "peak_memory_bytes", "cpu_time_ms", "accelerator_time_ms", "energy_wh")) and not self.measured_by:
            raise ValueError("Measurements require provenance")


@dataclass(frozen=True)
class AttemptTelemetry:
    """Injected by host instrumentation. CandidateOutput.metadata is not telemetry."""
    resources: ResourceUsage = field(default_factory=ResourceUsage)
    reasoning: ReasoningTrace = field(default_factory=ReasoningTrace)
    inference_cost_usd: float | None = None
    verification_cost_usd: float | None = None
    other_cost_usd: float | None = None
    cost_observer_id: str | None = None
    hardware: dict[str, Any] | None = None
    budget_enforced: bool = False
    enforcement_receipt: str | None = None

    def __post_init__(self) -> None:
        if type(self.budget_enforced) is not bool or not isinstance(self.resources, ResourceUsage) or not isinstance(self.reasoning, ReasoningTrace):
            raise TypeError("Typed resource/reasoning observations and boolean enforcement required")
        for name in ("cost_observer_id", "enforcement_receipt"):
            value = getattr(self, name)
            if value is not None and (not isinstance(value, str) or not value):
                raise ValueError(f"{name} must be a nonempty string")
        for name in ("inference_cost_usd", "verification_cost_usd", "other_cost_usd"):
            value = getattr(self, name)
            if value is not None and (type(value) not in (int, float) or not math.isfinite(value) or value < 0):
                raise ValueError(f"Invalid {name}")
            if value is not None and not self.cost_observer_id:
                raise ValueError("Known cost requires cost observer identity")
        if self.budget_enforced and not self.enforcement_receipt:
            raise ValueError("Budget enforcement requires receipt")
