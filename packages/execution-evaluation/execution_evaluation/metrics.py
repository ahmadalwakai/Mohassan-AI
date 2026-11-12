"""Pure aggregation of observed evaluation records. Unknown is never zero."""

from __future__ import annotations

from collections import Counter, defaultdict
from math import ceil, isfinite
from statistics import median
from typing import Any, Mapping, Sequence

Result = Mapping[str, Any]

RATE_FIELDS = {
    "first_attempt_success_rate": "first_attempt_success",
    "success_within_bounded_repair": "success_within_budget",
    "end_to_end_workflow_completion": "end_to_end_completed",
    "structural_validity_rate": "structural_valid",
    "behavioral_correctness": "behavioral_correct",
    "regression_failure_rate": "regression_failed",
    "false_acceptance_rate": "false_acceptance",
    "unauthorized_output_rate": "unauthorized_output",
    "unauthorized_action_acceptance_rate": "unauthorized_accepted",
    "output_language_compliance": "output_language_compliant",
    "external_escalation_rate": "external_escalated",
    "independent_local_contribution_rate": "independent_local_contribution",
}


def _boolean(value: Any, field: str) -> bool | None:
    if value is not None and type(value) is not bool:
        raise ValueError(f"{field} must be a boolean or null")
    return value


def _number(value: Any, field: str) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (float, int)) or not isfinite(value) or value < 0:
        raise ValueError(f"{field} must be a finite nonnegative number or null")
    return float(value)


def rate(values: Sequence[bool | None]) -> dict[str, Any]:
    """Observed proportion plus explicit missing denominator; not imputed success."""
    for value in values:
        _boolean(value, "rate value")
    positive = sum(value is True for value in values)
    negative = sum(value is False for value in values)
    observed = positive + negative
    return {"value": positive / observed if observed else None,
            "positive": positive, "negative": negative, "observed": observed,
            "missing": len(values) - observed, "eligible": len(values)}


def _confusion(results: Sequence[Result], label: str) -> dict[str, Any]:
    counts = {"true_positive": 0, "false_positive": 0, "false_negative": 0,
              "true_negative": 0, "missing": 0}
    responses = {"candidate", "missing_context", "unsupported"}
    for result in results:
        expected, predicted = result.get("expected_response"), result.get("predicted_response")
        if expected not in responses or predicted not in responses:
            counts["missing"] += 1
            continue
        positive, called = expected == label, predicted == label
        key = ("true_positive" if positive else "false_positive") if called else (
            "false_negative" if positive else "true_negative")
        counts[key] += 1
    tp, fp, fn = (counts[key] for key in ("true_positive", "false_positive", "false_negative"))
    return {**counts, "precision": tp / (tp + fp) if tp + fp else None,
            "recall": tp / (tp + fn) if tp + fn else None,
            "accuracy": (tp + counts["true_negative"]) / (len(results) - counts["missing"]) if len(results) > counts["missing"] else None,
            "observed": len(results) - counts["missing"],
            "actual_positive_support": tp + fn,
            "predicted_positive_support": tp + fp}


def _measurements(results: Sequence[Result], field: str) -> dict[str, Any]:
    values = [_number(result.get(field), field) for result in results]
    observed = sorted(value for value in values if value is not None)
    return {"samples": len(observed), "missing": len(values) - len(observed),
            "median": median(observed) if observed else None,
            "p95": observed[ceil(0.95 * len(observed)) - 1] if observed else None,
            "maximum": max(observed) if observed else None}


def _unique_results(results: Sequence[Result]) -> None:
    identities: set[tuple[Any, ...]] = set()
    for result in results:
        identity = tuple(result.get(key) for key in ("dataset_version", "task_id", "arm_id", "mode"))
        if any(not isinstance(value, str) or not value for value in identity):
            raise ValueError("Results require dataset_version, task_id, arm_id and mode")
        if identity in identities:
            raise ValueError(f"Duplicate task result: {identity}")
        identities.add(identity)


def summarize_results(results: Sequence[Result]) -> dict[str, Any]:
    """Summarize one arm/mode; missing and not-executed rows remain visible.

    End-to-end completion's denominator is workflow rows in full-system mode.
    False acceptance's denominator is only rows on which acceptance was decided;
    the harness must leave this field null otherwise.
    """
    results = tuple(results)
    _unique_results(results)
    if len({(row.get("arm_id"), row.get("mode")) for row in results}) > 1:
        raise ValueError("summarize_results expects a single arm and mode")
    rates: dict[str, Any] = {}
    for name, field in RATE_FIELDS.items():
        eligible = results
        if field == "end_to_end_completed":
            eligible = tuple(row for row in results if row.get("mode") == "full_system" and row.get("tier") == "end_to_end")
        rates[name] = rate([_boolean(row.get(field), field) for row in eligible])
    costs = [_number(row.get("cost_usd"), "cost_usd") for row in results]
    known_costs = [value for value in costs if value is not None]
    successes = sum(row.get("success_within_budget") is True for row in results)
    unknown_success = sum(row.get("success_within_budget") is None for row in results)
    complete_cost = bool(results) and len(known_costs) == len(results)
    total_cost = sum(known_costs) if complete_cost else None
    inference_costs: list[float | None] = []
    for row in results:
        attempts = row.get("attempt_records", ())
        components = [_number(attempt.get("cost", {}).get("components", {}).get("inference"), "inference component") for attempt in attempts]
        inference_costs.append(sum(components) if components and all(value is not None for value in components) else None)
    inference_complete = bool(results) and all(value is not None for value in inference_costs)
    failure_categories: Counter[str] = Counter()
    for row in results:
        categories = row.get("failure_categories") or row.get("provenance", {}).get("failure_categories", ())
        if not categories and row.get("outcome") != "verified_success":
            categories = (str(row.get("outcome", "unknown")),)
        failure_categories.update(set(categories))
    missing = sorted({field for field in RATE_FIELDS.values() if any(row.get(field) is None for row in results)} |
                     {field for field in ("latency_ms", "peak_memory_bytes", "cost_usd") if any(row.get(field) is None for row in results)} |
                     {str(item) for row in results for item in row.get("missing_measurements", ())})
    return {"task_count": len(results), "rates": rates,
            "missing_context": _confusion(results, "missing_context"),
            "unsupported_task": _confusion(results, "unsupported"),
            "latency_ms": _measurements(results, "latency_ms"),
            "peak_memory_bytes": _measurements(results, "peak_memory_bytes"),
            "cost": {"currency": "USD", "total_evaluation_cost": total_cost,
                     "known_evaluation_subtotal": sum(known_costs) if known_costs else None,
                     "total_inference_cost": sum(inference_costs) if inference_complete else None,
                     "missing_inference_task_costs": sum(value is None for value in inference_costs),
                     "missing_task_costs": len(results) - len(known_costs),
                     "successful_tasks": successes, "unknown_task_success": unknown_success,
                     "total_cost_per_successful_task": total_cost / successes if total_cost is not None and successes and not unknown_success else None,
                     "training_cost": None,
                     "training_cost_note": "Use the separate training cost ledger; no training is executed or inferred."},
            "failure_categories": dict(sorted(failure_categories.items())),
            "outcomes": dict(sorted(Counter(str(row.get("outcome", "unknown")) for row in results).items())),
            "missing_measurements": missing,
            "limitations": ["Rates exclude unknown observations and disclose their count.",
                            "P95 uses the nearest-rank convention; small samples have unstable tail estimates.",
                            "Latency is reported as measured and does not infer unmeasured remote work."]}


def aggregate_results(results: Sequence[Result]) -> dict[str, Any]:
    """Never pool executor-only and full-system outcomes or different arms."""
    _unique_results(results)
    groups: dict[tuple[str, str], list[Result]] = defaultdict(list)
    for result in results:
        groups[(str(result["arm_id"]), str(result["mode"]))].append(result)
    arms = []
    for (arm_id, mode), rows in sorted(groups.items()):
        families = sorted({str(row["task_family"]) for row in rows})
        arms.append({"arm_id": arm_id, "mode": mode, "overall": summarize_results(rows),
                     "by_task_family": {family: summarize_results([row for row in rows if row["task_family"] == family]) for family in families}})
    return {"schema_version": "execution-evaluation.metrics.v1", "arms": arms,
            "empty": not bool(results), "measurement_status": "no_results" if not results else "observations_supplied"}
