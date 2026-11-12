"""Explicit USD accounting. Unknown cost remains unknown even for local models."""
from __future__ import annotations

import math
from dataclasses import dataclass
from collections.abc import Sequence
from typing import Any

from .resources import AttemptTelemetry


def total_attempt_cost(telemetry: AttemptTelemetry) -> dict[str, Any]:
    components = {"inference": telemetry.inference_cost_usd, "verification": telemetry.verification_cost_usd,
                  "other": telemetry.other_cost_usd}
    calls = telemetry.reasoning.calls
    components["external_reasoning"] = (sum(call.cost_usd for call in calls) if telemetry.reasoning.observation_complete
                                       and all(call.cost_usd is not None for call in calls) else None)
    missing = [key for key, value in components.items() if value is None]
    return {"currency": "USD", "components": components, "total_usd": None if missing else sum(components.values()),
            "known_subtotal_usd": sum(value for value in components.values() if value is not None) if any(value is not None for value in components.values()) else None,
            "missing_measurements": missing, "observer_id": telemetry.cost_observer_id}


@dataclass(frozen=True)
class TrainingCost:
    checkpoint_identity: str
    total_usd: float | None
    source_receipt: str | None
    scope: str = "checkpoint_training"

    def __post_init__(self) -> None:
        if not self.checkpoint_identity:
            raise ValueError("Checkpoint identity required")
        if self.total_usd is not None and (type(self.total_usd) not in (int, float) or not math.isfinite(self.total_usd)
                                          or self.total_usd < 0 or not self.source_receipt):
            raise ValueError("Training cost requires nonnegative finite value and receipt")


def lifecycle_cost(inference_costs: Sequence[float | None], successes: int, training: TrainingCost | None = None,
                   *, amortization_task_count: int | None = None) -> dict[str, Any]:
    if type(successes) is not int or not 0 <= successes <= len(inference_costs):
        raise ValueError("Invalid success count")
    if amortization_task_count is not None and (type(amortization_task_count) is not int or amortization_task_count <= 0):
        raise ValueError("Explicit positive training amortization horizon required")
    for value in inference_costs:
        if value is not None and (type(value) not in (int, float) or not math.isfinite(value) or value < 0):
            raise ValueError("Invalid inference cost")
    inference_total = sum(inference_costs) if inference_costs and all(value is not None for value in inference_costs) else None
    training_total = training.total_usd if training else None
    amortized = (training_total * len(inference_costs) / amortization_task_count
                 if training_total is not None and amortization_task_count is not None else None)
    total = inference_total + amortized if inference_total is not None and amortized is not None else None
    return {"currency": "USD", "inference_total_usd": inference_total, "training_total_usd": training_total,
            "amortization_task_count": amortization_task_count, "amortized_training_usd": amortized,
            "inference_cost_per_success_usd": inference_total / successes if successes and inference_total is not None else None,
            "total_cost_per_success_usd": total / successes if successes and total is not None else None,
            "missing_measurements": [name for name, value in (("inference_total", inference_total), ("training_total", training_total),
                                                             ("training_amortization", amortized)) if value is None]}
