"""Fixed-condition executor evaluation. All integrations are explicitly injected."""
from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, replace
import time
from typing import Any, Protocol

from .adapters import ExecutorAdapter
from .attribution import ExternalCall, ReasoningTrace, attribute
from .common import digest, json_copy, to_jsonable
from .costs import total_attempt_cost
from .dataset import DatasetManifest, ManifestVerification, evaluation_identity, verify_manifest
from .resources import AttemptTelemetry
from .schemas import CandidateOutput, EvaluationTask, ExecutionRequest, TaskResult
from .splits import SplitAudit, evaluation_inventory_hash
from .verification import VerificationContext, VerificationResult, VerifiedSandboxAdapter, verify_candidate


@dataclass(frozen=True)
class EvaluationPlan:
    evaluation_id: str
    evaluation_version: str
    manifest: DatasetManifest
    manifest_verification: ManifestVerification
    split_audit: SplitAudit
    tasks: tuple[EvaluationTask, ...]
    configuration: dict[str, Any]
    config_digest: str
    task_inventory_digest: str
    seed: int


def prepare_evaluation(manifest: DatasetManifest, tasks: Sequence[EvaluationTask], split_audit: SplitAudit, *,
                       pinned_manifest_hash: str, identity_registry: Mapping[str, str] | None,
                       identity_registry_reference: str | None, configuration: Mapping[str, Any],
                       seed: int, evaluation_version: str = "phase4-v1") -> EvaluationPlan:
    """Read-only admission. Caller must authenticate manifest/inventory pins separately.

    Partial research datasets may be admitted; completion is a separate promotion gate.
    A proposed empty suite, changed identity, contaminated or partial inventory is rejected.
    """
    if type(seed) is not int or seed < 0:
        raise ValueError("Nonnegative seed required")
    snapshots = tuple(EvaluationTask.from_dict(to_jsonable(task)) for task in tasks)
    checked = verify_manifest(manifest, snapshots, pinned_manifest_hash=pinned_manifest_hash,
                              identity_registry=identity_registry, identity_registry_reference=identity_registry_reference)
    if not checked.verified:
        raise ValueError("Dataset admission rejected: " + ",".join(checked.issues))
    inventory = evaluation_inventory_hash(snapshots)
    if (not split_audit.clean or not split_audit.inventory_complete or not split_audit.near_detection_complete
            or not split_audit.project_isolation or not split_audit.template_isolation
            or split_audit.evaluation_manifest_hash != checked.manifest_hash
            or split_audit.evaluation_inventory_hash != inventory):
        raise ValueError("A clean, complete split audit bound to this dataset is required")
    config = json_copy(configuration)
    if "seed" in config and config["seed"] != seed:
        raise ValueError("Conflicting configuration seed")
    config["seed"] = seed
    config["task_inventory_digest"] = inventory
    config["split_audit_digest"] = digest(split_audit)
    return EvaluationPlan(evaluation_identity(checked.manifest_hash, config, evaluation_version=evaluation_version),
                          evaluation_version, manifest, checked, split_audit, snapshots, config, digest(config), inventory, seed)


def validate_plan(plan: EvaluationPlan) -> None:
    if (digest(plan.configuration) != plan.config_digest or evaluation_inventory_hash(plan.tasks) != plan.task_inventory_digest
            or plan.manifest.manifest_hash != plan.manifest_verification.manifest_hash
            or plan.split_audit.evaluation_inventory_hash != plan.task_inventory_digest
            or digest(plan.split_audit) != plan.configuration.get("split_audit_digest")):
        raise ValueError("Evaluation plan changed after admission")
    entries = {entry.task_id: entry.task_hash for entry in plan.manifest.entries}
    if any(entries.get(task.task_id) != task.content_hash for task in plan.tasks):
        raise ValueError("Task changed after admission")


TelemetryObserver = Callable[[str, int, str, VerificationResult], AttemptTelemetry]
ContextFactory = Callable[[EvaluationTask, str, str, int], VerificationContext]


def fixture_digest(context: VerificationContext) -> str:
    return digest({"workspace_version": context.workspace_version,
        "capabilities": sorted(context.available_capabilities), "tools": sorted(context.tool_argument_validators),
        "tool_policy_digest": context.tool_policy_digest, "trusted_tests": context.trusted_tests,
        "tool_effects": context.tool_effects,
        "completed_action_ids": sorted(context.completed_action_ids),
        "completed_idempotency_keys": sorted(context.completed_idempotency_keys)})


class ExecutorFixtureAuthority(Protocol):
    """Authenticate pristine disposable snapshot and current permissions before inference."""
    def authenticate_fixture(self, context: VerificationContext, task_digest: str,
                             adapter_identity: Mapping[str, Any]) -> bool: ...


def result_provenance(plan: EvaluationPlan, task: EvaluationTask, identity: Mapping[str, Any], mode: str) -> dict[str, Any]:
    # Comparison conditions intentionally exclude arm identity; they include every fixed task input and budget.
    return {"evaluation_id": plan.evaluation_id, "config_digest": plan.config_digest,
            "task_digest": task.content_hash, "dataset_manifest_digest": plan.manifest.manifest_hash,
            "conditions_digest": digest({"task": task.content_hash, "seed": plan.seed, "mode": mode,
                                          "budget": replace(task.allowed_execution_budget, external_calls=0, external_tokens=0) if mode == "executor_only" else task.allowed_execution_budget,
                                          "comparison_conditions": plan.configuration.get("comparison_conditions", {}),
                                          "verification_fixture": plan.configuration.get("verification_fixtures", {}).get(task.task_id)}),
            "adapter_identity": json_copy(identity), "adapter_identity_digest": digest(identity),
            "split_audit_digest": digest(plan.split_audit), "independent_verification": None,
            "risk_classes": json_copy(task.safety_constraints.get("risk_classes", [])),
            "verification_fixture_digest": plan.configuration.get("verification_fixtures", {}).get(task.task_id),
            "runtime_adapter_available": False}


def _base(task: EvaluationTask, arm_id: str, mode: str) -> dict[str, Any]:
    return {name: getattr(task, name) for name in ("task_id", "task_family", "project_family", "template_family", "tier", "dataset_version")} | {
        "arm_id": arm_id, "mode": mode, "expected_response": task.expected_response}


def evaluate_executor(plan: EvaluationPlan, adapter: ExecutorAdapter, *, context_factory: ContextFactory,
                      sandbox: VerifiedSandboxAdapter | None = None,
                      observe: TelemetryObserver | None = None,
                      fixture_authority: ExecutorFixtureAuthority | None = None,
                      cancelled: Callable[[], bool] = lambda: False) -> tuple[TaskResult, ...]:
    """Run only when explicitly called by a future authorized integration.

    A fresh public projection is supplied on each attempt. No oracle, hidden-test
    error, externally repaired output, or verifier feedback is sent to the executor.
    A callback is trusted integration code and must enforce wall/token/resource limits;
    Python cannot safely interrupt an arbitrary blocking callback. No successful bounded
    result is credited without independent enforcement and attribution measurements.
    """
    validate_plan(plan)
    identity = json_copy(adapter.identity)
    arm_id = identity.get("arm_id")
    if not isinstance(arm_id, str) or not arm_id:
        raise ValueError("Adapter requires a stable arm_id")
    if identity not in plan.configuration.get("executor_arms", []):
        raise ValueError("Executor identity must be pinned before standalone evaluation")
    rows = []
    for task in plan.tasks:
        validate_plan(plan)
        if digest(adapter.identity) != digest(identity):
            raise ValueError("Adapter identity changed during evaluation")
        # External reasoning allowance applies only to full-system mode.
        budget = replace(task.allowed_execution_budget, external_calls=0, external_tokens=0)
        start = time.monotonic()
        deadline = start + budget.time_ms / 1000
        records: list[dict[str, Any]] = []
        usages: list[AttemptTelemetry] = []
        calls: list[ExternalCall] = []
        limitations: list[str] = []
        candidate = CandidateOutput("unavailable", reason="not_attempted")
        verification = VerificationResult("verification_unavailable")
        outcome = "unavailable"
        success: bool | None = None
        remaining_tokens = budget.output_tokens
        first: bool | None = None
        for attempt in range(1, budget.max_attempts + 1):
            if cancelled():
                outcome, success = "cancelled", False
                break
            context = context_factory(task, plan.evaluation_id, arm_id, attempt)
            if context.evaluation_id != plan.evaluation_id:
                raise ValueError("Verification context evaluation identity mismatch")
            fixture = fixture_digest(context)
            if (not context.fixture_reset_receipt or not context.tool_policy_digest
                    or plan.configuration.get("verification_fixtures", {}).get(task.task_id) != fixture
                    or fixture_authority is None
                    or fixture_authority.authenticate_fixture(context, task.content_hash, identity) is not True):
                limitations.append("Pinned disposable fixture or independent reset/permission evidence unavailable.")
                outcome, success = "verification_unavailable", None
                break
            remaining_ms = int((deadline - time.monotonic()) * 1000)
            if remaining_ms <= 0 or remaining_tokens <= 0:
                outcome, success = "timeout", False
                break
            public_task = task.public_view()
            public_task["allowed_execution_budget"] = to_jsonable(budget)
            request = ExecutionRequest(public_task, replace(budget, time_ms=remaining_ms, output_tokens=remaining_tokens),
                                       attempt, plan.seed + attempt - 1, candidate if attempt > 1 else None)
            attempt_start = time.monotonic()
            try:
                raw = adapter.execute(request)
                validate_plan(plan)
                if digest(adapter.identity) != digest(identity) or fixture_digest(context) != fixture:
                    raise ValueError("Adapter identity or fixture changed during inference")
                candidate = CandidateOutput(**to_jsonable(raw)) if isinstance(raw, CandidateOutput) else CandidateOutput("error", reason="invalid_adapter_response")
            except Exception:
                candidate = CandidateOutput("error", reason="adapter_failed")
                # Do not serialize exceptions, which can contain hidden data or secrets.
            generation_ms = (time.monotonic() - attempt_start) * 1000
            remaining_ms = int((deadline - time.monotonic()) * 1000)
            context = replace(context, cancelled=context.cancelled or cancelled(), timed_out=context.timed_out or remaining_ms <= 0,
                              remaining_time_ms=max(1, remaining_ms))
            verification = verify_candidate(task, candidate, context, sandbox)
            validate_plan(plan)
            try:
                telemetry = observe(task.task_id, attempt, digest(candidate), verification) if observe else AttemptTelemetry()
                if not isinstance(telemetry, AttemptTelemetry):
                    raise TypeError("Invalid telemetry")
            except Exception:
                telemetry = AttemptTelemetry()
                limitations.append("Trusted telemetry observation unavailable.")
            usages.append(telemetry)
            calls.extend(telemetry.reasoning.calls)
            attribution = attribute(telemetry.reasoning)
            costs = total_attempt_cost(telemetry)
            tokens = telemetry.resources.output_tokens
            in_bounds = telemetry.budget_enforced and tokens is not None and tokens <= remaining_tokens and time.monotonic() <= deadline
            budget_violation = tokens is not None and tokens > remaining_tokens
            if budget.max_memory_bytes is not None:
                memory = telemetry.resources.peak_memory_bytes
                in_bounds = in_bounds and memory is not None and memory <= budget.max_memory_bytes
                budget_violation = budget_violation or memory is not None and memory > budget.max_memory_bytes
            independent = attribution["classification"] == "independent_local_execution" and attribution["complete"]
            outcome = "verified_success" if verification.accepted else verification.outcome
            if outcome == "response_only":
                outcome = candidate.status
            if verification.accepted:
                success = True if in_bounds and independent else None
                if success is None:
                    outcome = "verification_unavailable"
                    limitations.append("Behavior verified but independent bounded execution credit is unavailable.")
            elif outcome in ("verification_unavailable", "unavailable", "error"):
                success = None
            else:
                success = False
            if telemetry.reasoning.calls or attribution["classification"] in ("assisted_local_execution", "externally_completed_execution"):
                success, outcome = None, "verification_failed"
                limitations.append("External reasoning invalidates the executor-only capability comparison.")
            if budget_violation:
                success, outcome = False, "verification_failed"
                limitations.append("Measured output or memory consumption exceeded the fixed budget.")
            if cancelled() or context.cancelled:
                outcome, success = "cancelled", False
            elif time.monotonic() > deadline or context.timed_out:
                outcome, success = "timeout", False
            if attempt == 1:
                first = success
            records.append({"attempt": attempt, "candidate_hash": digest(candidate), "status": candidate.status,
                            "generation_latency_ms": generation_ms, "latency_ms": (time.monotonic() - attempt_start) * 1000,
                            "verification": to_jsonable(verification), "success_within_budget": success,
                            "resources": to_jsonable(telemetry.resources), "cost": costs,
                            "external_reasoning": attribution, "budget_enforced": telemetry.budget_enforced,
                            "enforcement_receipt": telemetry.enforcement_receipt,
                            "retrieval": {key: json_copy(candidate.metadata[key]) for key in (
                                "retrieved", "retrieval_mode", "selected_example_id", "selected_similarity", "corpus_hash", "novel_generation")
                                if identity.get("kind") == "retrieval" and key in candidate.metadata}})
            if success or success is None or budget_violation or outcome in ("cancelled", "timeout", "execution_prevented") or candidate.status != "candidate":
                break
            if tokens is None:
                break
            remaining_tokens -= tokens
        traces = [usage.reasoning for usage in usages]
        def all_observed_false(field: str) -> bool | None:
            values = [getattr(trace, field) for trace in traces]
            return True if any(value is True for value in values) else False if values and all(value is False for value in values) else None
        try:
            combined_trace = ReasoningTrace(tuple(calls), bool(traces) and all(trace.observation_complete for trace in traces),
                "evaluation-observer-aggregation" if traces else None,
                all_observed_false("copied_external_solution"), all_observed_false("transformed_external_solution"),
                all_observed_false("externally_supplied_context"))
            combined = attribute(combined_trace)
        except ValueError:
            combined = attribute(ReasoningTrace())
            success, outcome = None, "verification_unavailable"
            first = None
            limitations.append("External call identifiers were reused; attribution rejected.")
        task_costs = [record["cost"]["total_usd"] for record in records]
        memories = [usage.resources.peak_memory_bytes for usage in usages]
        cost = sum(task_costs) if task_costs and all(value is not None for value in task_costs) else None
        memory = max(memories) if memories and all(value is not None for value in memories) else None
        provenance = result_provenance(plan, task, identity, "executor_only")
        provenance["independent_verification"] = verification.independent
        provenance["verification_receipt"] = verification.evidence
        missing = [name for name, value in (("cost_usd", cost), ("peak_memory_bytes", memory), ("success_within_budget", success),
                                            ("behavioral_correct", verification.behavioral_correct), ("regression_failed", verification.regression_failed)) if value is None]
        missing.extend(combined["missing_measurements"])
        missing.append("false_acceptance_independent_audit")
        unauthorized_values = [record["verification"].get("unauthorized_output") for record in records]
        unauthorized = True if True in unauthorized_values else False if unauthorized_values and all(value is False for value in unauthorized_values) else None
        unauthorized_accepted_values = [record["verification"].get("unauthorized_accepted") for record in records]
        unauthorized_accepted = True if True in unauthorized_accepted_values else False if unauthorized_accepted_values and all(value is False for value in unauthorized_accepted_values) else None
        rows.append(TaskResult(**_base(task, arm_id, "executor_only"), outcome=outcome, attempts=len(records),
            first_attempt_success=first, success_within_budget=success,
            structural_valid=verification.structural_valid, behavioral_correct=verification.behavioral_correct,
            regression_failed=verification.regression_failed, predicted_response=candidate.status,
            unauthorized_output=unauthorized, unauthorized_accepted=unauthorized_accepted,
            output_language_compliant=verification.output_language_compliant,
            external_escalated=combined["external_escalated"], independent_local_contribution=combined["independent_local_contribution"],
            latency_ms=(time.monotonic() - start) * 1000, peak_memory_bytes=memory, cost_usd=cost,
            external_reasoning=combined, attempt_records=tuple(records), limitations=tuple(dict.fromkeys([*limitations, *verification.limitations])),
            missing_measurements=tuple(sorted(set(missing))), provenance=provenance,
            failure_categories=() if success else (outcome,)))
    return tuple(rows)


def compare_executor_arms(plan: EvaluationPlan, adapters: Sequence[ExecutorAdapter], **services: Any) -> tuple[TaskResult, ...]:
    """Same task snapshots, seed and budgets for deterministic/retrieval/custom arms.

    context_factory and sandbox must reset each isolated task/arm workspace. No live
    workspace is mutated here. Arm ordering is pinned in the configuration by caller.
    """
    identities = [adapter.identity for adapter in adapters]
    if {identity.get("kind") for identity in identities} != {"deterministic", "retrieval", "custom_model"} or len(identities) != 3:
        raise ValueError("Exactly deterministic, retrieval and custom_model arms required")
    if len({identity.get("arm_id") for identity in identities}) != 3:
        raise ValueError("Distinct adapter identities required")
    if plan.configuration.get("executor_arms") != to_jsonable(identities):
        raise ValueError("Adapter identities and order must be pinned before evaluation")
    return tuple(row for adapter in adapters for row in evaluate_executor(plan, adapter, **services))
