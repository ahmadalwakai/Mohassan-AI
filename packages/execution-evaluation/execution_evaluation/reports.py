"""JSON and Markdown report rendering; no evaluations, writes, uploads or promotion."""
from __future__ import annotations

from collections.abc import Mapping, Sequence
import json
from typing import Any

from .common import digest, json_copy, to_jsonable
from .metrics import aggregate_results
from .schemas import REPORT_SCHEMA_VERSION, TaskResult


def _safe_attempt(record: Mapping[str, Any]) -> dict[str, Any]:
    # Raw candidates, hidden oracle text, exception messages and test stdout are not report fields.
    result = {name: json_copy(record[name]) for name in (
        "attempt", "candidate_hash", "status", "generation_latency_ms", "latency_ms", "success_within_budget",
        "resources", "cost", "external_reasoning", "budget_enforced", "enforcement_receipt", "retrieval", "runtime_stages"
    ) if name in record}
    verification = record.get("verification", {})
    result["verification"] = {name: json_copy(verification[name]) for name in (
        "outcome", "structural_valid", "behavioral_correct", "regression_failed", "output_language_compliant",
        "unauthorized_output", "unauthorized_accepted", "independent", "accepted", "evidence"
    ) if name in verification}
    result["verification"]["checks"] = [{name: check.get(name) for name in (
        "name", "status", "evidence_id", "artifact_sha256")} for check in verification.get("checks", ())]
    return result


def build_report(*, evaluation_id: str, dataset_manifest: Mapping[str, Any], model_identity: Mapping[str, Any] | None,
                 baseline_identities: Sequence[Mapping[str, Any]], configuration: Mapping[str, Any],
                 results: Sequence[TaskResult], reproduction: Mapping[str, Any],
                 acceptance: Mapping[str, Any] | None = None, hardware: Mapping[str, Any] | None = None,
                 comparisons: Mapping[str, Any] | None = None, safety_results: Sequence[Mapping[str, Any]] = (),
                 limitations: Sequence[str] = (), generated_at: str, execution_status: str = "not_run") -> dict[str, Any]:
    """Render supplied observations. `not_run` is the safe default, not a passed run.

    configuration/reproduction are evaluator-authored JSON metadata: never put
    credentials, prompts, source code, hidden tests or expected answers there.
    The report is restricted evaluator material and never a training export.
    """
    if not evaluation_id or not generated_at:
        raise ValueError("Evaluation identity and real generation timestamp required")
    if execution_status not in {"not_run", "partial", "completed"}:
        raise ValueError("Invalid report execution status")
    if execution_status == "not_run" and results:
        raise ValueError("A not-run report cannot contain observations")
    if execution_status == "completed" and not results:
        raise ValueError("Empty evaluations cannot be marked completed")
    if execution_status == "completed":
        expected = configuration.get("expected_result_keys")
        actual = [[result.mode, result.arm_id, result.task_id] for result in results]
        if (not isinstance(expected, list) or not expected
                or any(not isinstance(key, list) or len(key) != 3 or any(not isinstance(item, str) for item in key) for key in expected)
                or len({tuple(key) for key in expected}) != len(expected) or sorted(expected) != sorted(actual)):
            raise ValueError("Completed report requires exact preregistered mode/arm/task coverage")
    rows = []
    for result in results:
        row = result.to_dict()
        if row["provenance"].get("evaluation_id") != evaluation_id:
            raise ValueError("Result evaluation identity differs from report")
        if row["provenance"].get("dataset_manifest_digest") != digest(dataset_manifest) or row["provenance"].get("config_digest") != digest(configuration):
            raise ValueError("Result dataset/configuration differs from report")
        row["attempt_records"] = [_safe_attempt(record) for record in row["attempt_records"]]
        rows.append(row)
    decision = json_copy(acceptance) if acceptance is not None else {
        "decision": "not_evaluated", "promotion_eligible": False, "automatic_promotion": False,
        "deployment_permitted": False, "activation_performed": False, "checks": []}
    if decision.get("promotion_eligible") is True and (execution_status != "completed" or not results
            or decision.get("evaluation_id") != evaluation_id
            or decision.get("dataset_manifest_digest") != digest(dataset_manifest)
            or decision.get("config_digest") != digest(configuration)
            or decision.get("model_identity_digest") != digest(model_identity)
            or not decision.get("checks") or any(check.get("status") != "passed" for check in decision["checks"])):
        raise ValueError("Promotion eligibility requires matching completed evidence")
    if any(decision.get(name) is True for name in ("automatic_promotion", "deployment_permitted", "activation_performed")):
        raise ValueError("Evaluation reports cannot authorize or perform model activation")
    missing = sorted({item for row in rows for item in row["missing_measurements"]} |
                     ({"hardware_information"} if hardware is None else set()) |
                     ({"evaluation_observations"} if not rows else set()))
    report = {"schema_version": REPORT_SCHEMA_VERSION, "evaluation_id": evaluation_id,
        "generated_at": generated_at, "execution_status": execution_status, "confidentiality": "evaluator_only",
        "dataset_manifest": json_copy(dataset_manifest), "dataset_manifest_digest": digest(dataset_manifest),
        "model_identity": json_copy(model_identity), "baseline_identities": json_copy(baseline_identities),
        "configuration": json_copy(configuration), "hardware": json_copy(hardware), "task_results": rows,
        "aggregated_metrics": aggregate_results(rows), "comparisons": json_copy(comparisons),
        "safety_results": json_copy(safety_results),
        "safety_failures": [row for row in json_copy(safety_results) if row.get("status") != "passed"],
        "external_reasoning_attribution": [{"task_id": row["task_id"], "arm_id": row["arm_id"], "mode": row["mode"],
                                            **row["external_reasoning"]} for row in rows],
        "acceptance": decision, "missing_measurements": missing,
        "limitations": list(dict.fromkeys([*limitations, *(item for row in rows for item in row["limitations"]),
            "Reports contain no permission to deploy or activate models.",
            "Missing measurements are null, not zero; reported observations are not automatically authenticated.",
            "Evaluation failures are never automatically exported into training data."])),
        "reproduction": json_copy(reproduction), "automatic_training_export": False}
    report["report_digest"] = digest(report)
    return report


def render_json(report: Mapping[str, Any]) -> str:
    return json.dumps(to_jsonable(report), ensure_ascii=False, allow_nan=False, sort_keys=True, indent=2) + "\n"


def _text(value: Any) -> str:
    return str(value).replace("|", "\\|").replace("\r", " ").replace("\n", " ").replace("<", "&lt;").replace(">", "&gt;")


def render_markdown(report: Mapping[str, Any]) -> str:
    lines = ["# Independent execution evaluation", "", f"Evaluation: `{_text(report['evaluation_id'])}`",
        f"Status: **{_text(report['execution_status'])}**", f"Dataset digest: `{_text(report['dataset_manifest_digest'])}`",
        f"Acceptance: **{_text(report['acceptance']['decision'])}**", "",
        "This report does not deploy or activate a model. Unknown measurements remain unavailable.", "",
        "## Identities and configuration", "", "```json", render_json({"model": report["model_identity"],
        "baselines": report["baseline_identities"], "configuration": report["configuration"], "hardware": report["hardware"]}).rstrip(), "```", "",
        "## Observations", "", "| Arm | Mode | Tasks | Success (observed) | Missing | Median ms | P95 ms |", "|---|---|---:|---:|---:|---:|---:|"]
    for arm in report["aggregated_metrics"]["arms"]:
        summary = arm["overall"]
        rate = summary["rates"]["success_within_bounded_repair"]
        lines.append("| " + " | ".join(_text(value) if value is not None else "unavailable" for value in (
            arm["arm_id"], arm["mode"], summary["task_count"], rate["value"], rate["missing"],
            summary["latency_ms"]["median"], summary["latency_ms"]["p95"])) + " |")
    if not report["task_results"]:
        lines.extend(["", "No evaluation tasks were executed. No benchmark results are claimed."])
    lines.extend(["", "## Task results", "", "| Task | Arm | Mode | Outcome | Attribution |", "|---|---|---|---|---|"])
    for row in report["task_results"]:
        lines.append("| " + " | ".join(_text(value) for value in (row["task_id"], row["arm_id"], row["mode"], row["outcome"],
                     row["external_reasoning"].get("classification", "unknown"))) + " |")
    lines.extend(["", "## Acceptance gates", ""])
    for check in report["acceptance"].get("checks", []):
        lines.append(f"- {_text(check['gate'])}: {_text(check['status'])}")
    for title, field in (("Missing measurements", "missing_measurements"), ("Limitations", "limitations")):
        lines.extend(["", f"## {title}", "", *[f"- {_text(item)}" for item in report[field]]])
    for title, field in (("Dataset manifest", "dataset_manifest"), ("Statistical comparisons", "comparisons"),
                         ("Safety evaluation", "safety_results"), ("External reasoning", "external_reasoning_attribution"),
                         ("Reproduction metadata", "reproduction")):
        lines.extend(["", f"## {title}", "", "```json", render_json(report[field]).rstrip(), "```"])
    return "\n".join(lines) + "\n"
