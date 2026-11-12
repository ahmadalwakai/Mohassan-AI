"""External reasoning accounting from a trusted transport observer, never model text."""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from .common import to_jsonable


@dataclass(frozen=True)
class ExternalCall:
    call_id: str
    model_identity: str
    purpose: str
    input_tokens: int | None
    output_tokens: int | None
    latency_ms: float | None
    cost_usd: float | None
    produced_final_solution: bool | None
    supplied_executable_solution: bool | None
    usage_estimated: bool = False

    def __post_init__(self) -> None:
        if type(self.usage_estimated) is not bool:
            raise ValueError("usage_estimated must be boolean")
        if any(not isinstance(value, str) or not value for value in (self.call_id, self.model_identity, self.purpose)):
            raise ValueError("External call identity and purpose required")
        for name in ("input_tokens", "output_tokens"):
            value = getattr(self, name)
            if value is not None and (type(value) is not int or value < 0):
                raise ValueError(f"Invalid {name}")
        for name in ("latency_ms", "cost_usd"):
            value = getattr(self, name)
            if value is not None and (type(value) not in (int, float) or not math.isfinite(value) or value < 0):
                raise ValueError(f"Invalid {name}")
        for name in ("produced_final_solution", "supplied_executable_solution"):
            if getattr(self, name) is not None and type(getattr(self, name)) is not bool:
                raise ValueError(f"Invalid {name}")


@dataclass(frozen=True)
class ReasoningTrace:
    calls: tuple[ExternalCall, ...] = ()
    observation_complete: bool = False
    observer_id: str | None = None
    copied_external_solution: bool | None = None
    transformed_external_solution: bool | None = None
    # Includes executable solution supplied before this run, e.g. inside task context.
    externally_supplied_context: bool | None = None

    def __post_init__(self) -> None:
        if type(self.observation_complete) is not bool or any(not isinstance(call, ExternalCall) for call in self.calls):
            raise ValueError("Explicit boolean observation coverage and typed calls required")
        if self.observer_id is not None and (not isinstance(self.observer_id, str) or not self.observer_id):
            raise ValueError("Observer identity must be a nonempty string")
        if len({call.call_id for call in self.calls}) != len(self.calls):
            raise ValueError("Duplicate external call IDs")
        if self.observation_complete and not self.observer_id:
            raise ValueError("Complete observation requires observer identity")
        for name in ("copied_external_solution", "transformed_external_solution", "externally_supplied_context"):
            if getattr(self, name) is not None and type(getattr(self, name)) is not bool:
                raise ValueError(f"Invalid {name}")


def attribute(trace: ReasoningTrace) -> dict[str, Any]:
    missing = []
    if not trace.observation_complete:
        missing.append("complete_external_call_observation")
    for name in ("copied_external_solution", "transformed_external_solution", "externally_supplied_context"):
        if getattr(trace, name) is None:
            missing.append(name)
    if any(call.produced_final_solution is None or call.supplied_executable_solution is None for call in trace.calls):
        missing.append("external_solution_lineage")
    externally_completed = trace.copied_external_solution is True or trace.transformed_external_solution is True or any(
        call.produced_final_solution is True for call in trace.calls)
    if externally_completed:
        classification = "externally_completed_execution"
    elif missing:
        classification = "unknown"
    elif trace.calls or trace.externally_supplied_context:
        classification = "assisted_local_execution"
    else:
        classification = "independent_local_execution"
    return {
        "classification": classification, "complete": not missing,
        "external_escalated": bool(trace.calls) if trace.observation_complete else (True if trace.calls else None),
        "independent_local_contribution": None if classification == "unknown" else classification == "independent_local_execution",
        "calls": to_jsonable(trace.calls), "observer_id": trace.observer_id,
        "copied_external_solution": trace.copied_external_solution,
        "transformed_external_solution": trace.transformed_external_solution,
        "externally_supplied_context": trace.externally_supplied_context,
        "missing_measurements": missing,
    }
