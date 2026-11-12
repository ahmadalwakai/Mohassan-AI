"""Local training/audit reports describe observed execution, never independent proficiency."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .common import atomic_json
from .errors import TrainingError

REPORT_SCHEMA_VERSION = "execution-training-report-v1"


def write_training_report(path: str | Path, report: dict[str, Any]) -> None:
    """Persist caller-observed metrics; no raw sample text or model output belongs in this report."""
    if not isinstance(report, dict):
        raise TrainingError("INVALID_REPORT", "Training report must be a mapping")
    if report.get("status") not in {"completed", "interrupted", "failed", "resource_limited",
                                  "token_budget_reached", "curriculum_complete", "step_limit_reached"}:
        raise TrainingError("INVALID_REPORT", "Report must declare an actual terminal execution status")
    counters = report.get("state", report)
    if not isinstance(counters, dict):
        raise TrainingError("INVALID_REPORT", "Report counters must be a mapping")
    for name in ("step", "processed_tokens", "unique_dataset_tokens"):
        if type(counters.get(name)) is not int or counters[name] < 0:
            raise TrainingError("INVALID_REPORT", f"Invalid report counter: {name}")
    if report.get("independent_evaluation_status", "not_evaluated") != "not_evaluated":
        raise TrainingError("INVALID_REPORT", "Training cannot declare independent evaluation success")
    atomic_json(path, {**report, "schema_version": REPORT_SCHEMA_VERSION,
                       "written_at": datetime.now(timezone.utc).isoformat(),
                       "independent_evaluation_status": "not_evaluated", "promotion_status": "unpromoted"},
                immutable=True)
