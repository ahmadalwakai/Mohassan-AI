"""Full-system evaluation protocol and harness; the actual Runtime bridge is pending."""
from __future__ import annotations

from dataclasses import dataclass, replace
import secrets
import time
from typing import Any, Protocol

from .attribution import attribute
from .common import digest, json_copy, to_jsonable
from .costs import total_attempt_cost
from .executor import ContextFactory, EvaluationPlan, TelemetryObserver, _base, fixture_digest, result_provenance, validate_plan
from .resources import AttemptTelemetry
from .schemas import CandidateOutput, ExecutionBudget, TaskResult
from .verification import VerifiedSandboxAdapter, verify_candidate

RUNTIME_INTEGRATION_STATUS = "pending_actual_runtime_adapter"
RUNTIME_STAGES = ("goal_interpretation", "planning", "context_assembly", "strategy_selection", "execution",
                  "verification", "bounded_repair", "escalation", "final_completion")


@dataclass(frozen=True)
class RuntimeEvaluationRequest:
    evaluation_id: str
    task: dict[str, Any]
    executor_kind: str
    budget: ExecutionBudget
    seed: int
    conditions_digest: str
    nonce: str
    environment: str = "isolated_fixture"


@dataclass(frozen=True)
class RuntimeStageObservation:
    stage: str
    status: str  # passed | failed | unavailable | not_needed
    receipt_reference: str


@dataclass(frozen=True)
class RuntimeObservation:
    request_digest: str
    final_candidate: CandidateOutput
    stages: tuple[RuntimeStageObservation, ...]
    attempts: int
    completion_claim: bool
    termination_confirmed: bool
    telemetry: AttemptTelemetry
    receipt_reference: str
    actual_conditions_digest: str
    fixture_snapshot_digest: str
    # Separate trusted independent audit of an acceptance decision, not self-evaluation.
    first_attempt_success: bool | None = None
    false_acceptance: bool | None = None


class CognitiveRuntimeAdapter(Protocol):
    @property
    def identity(self) -> dict[str, Any]: ...
    def run_workflow(self, request: RuntimeEvaluationRequest) -> RuntimeObservation: ...


class RuntimeEvidenceAuthority(Protocol):
    """Trusted, independent integration controller, not a model-supplied callback.

    Before dispatch, prove fixture-only execution, reset snapshot, bounded tools,
    permissions and all external-call observation. Observation authentication binds
    actual runtime records (leases/receipts/termination), not a passed JSON assertion.
    """
    def authorize_fixture(self, request: RuntimeEvaluationRequest, adapter_identity: dict[str, Any]) -> bool: ...
    def authenticate_observation(self, request: RuntimeEvaluationRequest, observation: RuntimeObservation) -> bool: ...


def evaluate_full_system(plan: EvaluationPlan, *, executor_kind: str, adapter: CognitiveRuntimeAdapter | None,
                         authority: RuntimeEvidenceAuthority | None, context_factory: ContextFactory,
                         sandbox: VerifiedSandboxAdapter | None = None,
                         observe: TelemetryObserver | None = None) -> tuple[TaskResult, ...]:
    validate_plan(plan)
    if executor_kind not in ("deterministic", "custom_model"):
        raise ValueError("Full-system comparison supports deterministic and custom_model execution")
    identity = json_copy(adapter.identity) if adapter else {
        "arm_id": "runtime-" + executor_kind, "kind": executor_kind, "integration": RUNTIME_INTEGRATION_STATUS}
    if not isinstance(identity.get("arm_id"), str) or not identity["arm_id"]:
        raise ValueError("Runtime adapter requires stable identity")
    rows = []
    for task in plan.tasks:
        validate_plan(plan)
        base = _base(task, identity["arm_id"], "full_system")
        provenance = result_provenance(plan, task, identity, "full_system")
        if adapter is None or authority is None:
            rows.append(TaskResult(**base, outcome="unavailable", provenance=provenance,
                limitations=("Actual Runtime adapter and independent evidence authority are pending.",),
                missing_measurements=("full_system_runtime_evidence",)))
            continue
        if digest(adapter.identity) != digest(identity):
            raise ValueError("Runtime adapter identity changed")
        if plan.configuration.get("runtime_arms", {}).get(executor_kind) != identity:
            raise ValueError("Runtime adapter identity must be pinned before execution")
        request = RuntimeEvaluationRequest(plan.evaluation_id, task.public_view(), executor_kind,
            task.allowed_execution_budget, plan.seed, provenance["conditions_digest"], secrets.token_hex(24))
        request_hash = digest(request)
        if authority.authorize_fixture(request, identity) is not True or digest(request) != request_hash:
            rows.append(TaskResult(**base, outcome="execution_prevented", success_within_budget=False,
                end_to_end_completed=False if task.tier == "end_to_end" else None,
                provenance=provenance, limitations=("Isolated fixture execution was not independently authorized.",)))
            continue
        started = time.monotonic()
        try:
            observed = adapter.run_workflow(request)
            validate_plan(plan)
            valid = (isinstance(observed, RuntimeObservation) and digest(request) == request_hash
                and observed.request_digest == request_hash and observed.actual_conditions_digest == request.conditions_digest
                and bool(observed.receipt_reference) and bool(observed.fixture_snapshot_digest)
                and observed.termination_confirmed is True and type(observed.completion_claim) is bool
                and type(observed.attempts) is int and 1 <= observed.attempts <= request.budget.max_attempts
                and isinstance(observed.telemetry, AttemptTelemetry)
                and isinstance(observed.final_candidate, CandidateOutput)
                and all(isinstance(stage, RuntimeStageObservation) and isinstance(stage.stage, str)
                        and stage.status in {"passed", "failed", "unavailable", "not_needed"}
                        and isinstance(stage.receipt_reference, str) for stage in observed.stages)
                and (observed.first_attempt_success is None or type(observed.first_attempt_success) is bool)
                and (observed.false_acceptance is None or type(observed.false_acceptance) is bool)
                and digest(adapter.identity) == digest(identity)
                and authority.authenticate_observation(request, observed) is True)
        except Exception:
            valid = False
        if not valid:
            rows.append(TaskResult(**base, outcome="verification_unavailable", provenance=provenance,
                latency_ms=(time.monotonic() - started) * 1000,
                limitations=("No authentic, matching Runtime observation; completion not credited.",),
                missing_measurements=("runtime_observation",)))
            continue
        stage_map = {stage.stage: stage for stage in observed.stages}
        stages_valid = len(stage_map) == len(observed.stages) and set(stage_map) == set(RUNTIME_STAGES)
        stages_pass = stages_valid and all(stage.receipt_reference and (
            stage.status == "passed" or stage.status == "not_needed" and stage.stage in {"bounded_repair", "escalation"})
            for stage in observed.stages)
        context = context_factory(task, plan.evaluation_id, identity["arm_id"], observed.attempts)
        if context.evaluation_id != plan.evaluation_id or context.workspace_version != observed.fixture_snapshot_digest:
            raise ValueError("Runtime fixture and verification context must refer to identical snapshot")
        if fixture_digest(context) != plan.configuration.get("verification_fixtures", {}).get(task.task_id):
            raise ValueError("Runtime verification fixture differs from pinned comparison conditions")
        remaining_ms = int(request.budget.time_ms - (time.monotonic() - started) * 1000)
        checked = verify_candidate(task, observed.final_candidate, replace(context,
            timed_out=context.timed_out or remaining_ms <= 0, remaining_time_ms=max(1, remaining_ms)), sandbox)
        # Pre-verification Runtime telemetry cannot account for later independent checks.
        # A post-verification observer supplies the complete run, including original calls.
        try:
            usage = observe(task.task_id, observed.attempts, digest(observed.final_candidate), checked) if observe else AttemptTelemetry(
                reasoning=observed.telemetry.reasoning, inference_cost_usd=observed.telemetry.inference_cost_usd,
                other_cost_usd=observed.telemetry.other_cost_usd, cost_observer_id=observed.telemetry.cost_observer_id)
            if not isinstance(usage, AttemptTelemetry) or usage.reasoning != observed.telemetry.reasoning:
                raise ValueError("Post-verification telemetry must preserve authenticated runtime call trace")
        except Exception:
            usage = AttemptTelemetry()
        reasoning = attribute(usage.reasoning)
        elapsed = (time.monotonic() - started) * 1000
        external_tokens = [call.input_tokens + call.output_tokens if call.input_tokens is not None and call.output_tokens is not None else None
                           for call in usage.reasoning.calls]
        external_budget_valid = (reasoning["complete"] and len(usage.reasoning.calls) <= request.budget.external_calls
            and all(value is not None for value in external_tokens) and sum(external_tokens) <= request.budget.external_tokens)
        memory = usage.resources.peak_memory_bytes
        budget_valid = (usage.budget_enforced and elapsed <= request.budget.time_ms
            and usage.resources.output_tokens is not None and usage.resources.output_tokens <= request.budget.output_tokens
            and external_budget_valid and (request.budget.max_memory_bytes is None or memory is not None and memory <= request.budget.max_memory_bytes))
        completed = (checked.accepted and observed.completion_claim and stages_pass and budget_valid)
        unknown = (checked.outcome == "verification_unavailable" or not reasoning["complete"] or not usage.budget_enforced
            or usage.resources.output_tokens is None or any(value is None for value in external_tokens)
            or request.budget.max_memory_bytes is not None and memory is None)
        success = True if completed else None if unknown else False
        outcome = "verified_success" if completed else "verification_unavailable" if unknown else "verification_failed"
        if checked.outcome in {"candidate_rejected", "execution_prevented"}:
            outcome, success = checked.outcome, False
        first = observed.first_attempt_success
        if first is True and not completed:
            first = None  # An inconsistent or later-unverified completion cannot earn first-attempt credit.
        costs = total_attempt_cost(usage)
        provenance.update({"independent_verification": checked.independent, "verification_receipt": checked.evidence,
                           "runtime_receipt_reference": observed.receipt_reference, "runtime_observation_digest": digest(observed),
                           "runtime_integration": "injected_requires_external_qualification", "runtime_adapter_available": True})
        missing = [name for name, value in (("peak_memory_bytes", memory), ("cost_usd", costs["total_usd"]),
            ("first_attempt_success", first), ("false_acceptance", observed.false_acceptance),
            ("regression_failed", checked.regression_failed)) if value is None]
        missing.extend(reasoning["missing_measurements"])
        rows.append(TaskResult(**base, outcome=outcome, attempts=observed.attempts, first_attempt_success=first,
            success_within_budget=success, end_to_end_completed=success if task.tier == "end_to_end" else None,
            structural_valid=checked.structural_valid, behavioral_correct=checked.behavioral_correct,
            regression_failed=checked.regression_failed, false_acceptance=observed.false_acceptance,
            predicted_response=observed.final_candidate.status, unauthorized_output=checked.unauthorized_output,
            unauthorized_accepted=checked.unauthorized_accepted, output_language_compliant=checked.output_language_compliant,
            external_escalated=reasoning["external_escalated"], independent_local_contribution=reasoning["independent_local_contribution"],
            latency_ms=elapsed, peak_memory_bytes=memory, cost_usd=costs["total_usd"], external_reasoning=reasoning,
            attempt_records=({"runtime_stages": to_jsonable(observed.stages), "verification": to_jsonable(checked),
                              "cost": costs, "resources": to_jsonable(usage.resources)},),
            limitations=checked.limitations, missing_measurements=tuple(sorted(set(missing))), provenance=provenance,
            failure_categories=() if success else (outcome,)))
    return tuple(rows)
