"""Independent verification with an explicit, fail-closed sandbox boundary.

There is deliberately no subprocess, shell, eval, exec or host test fallback.
Adapters are trusted integration code; candidate code remains inert data here.
"""
from __future__ import annotations

import math
import re
import secrets
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping, Protocol

from .common import digest
from .safety import SafetyContext, SafetyResult, evaluate_candidate_safety
from .schemas import CandidateOutput, EvaluationTask


CHECK_NAMES = frozenset({
    "structural_validation", "hidden_behavior", "regression", "type_compatibility",
    "output_constraints", "workspace_boundaries", "multi_file_consistency",
    "concurrent_operation_safety", "idempotency_retry_safety",
})
REQUIRED_ISOLATION_CONTROLS = frozenset({
    "process_isolation", "network_denied", "host_filesystem_denied",
    "secret_environment_denied", "timeout_enforced", "memory_enforced",
    "disk_quota_enforced", "no_child_processes", "workspace_snapshot_immutable",
    "trusted_test_registry", "control_channel_authenticated",
    "cancellation_enforced", "side_channels_denied",
})


@dataclass(frozen=True)
class CheckResult:
    name: str
    status: str  # passed | failed | unavailable
    reason: str
    evidence_id: str | None = None
    artifact_sha256: str | None = None


@dataclass(frozen=True)
class HiddenTestRegistration:
    reference: str
    content_sha256: str
    origin: str  # independent_human | frozen_repository
    registered_before_evaluation: bool
    required_checks: tuple[str, ...]
    registry_revision: str


@dataclass(frozen=True)
class VerificationContext:
    evaluation_id: str
    workspace_version: str
    trusted_tests: Mapping[str, HiddenTestRegistration] = field(default_factory=dict)
    cancelled: bool = False
    timed_out: bool = False
    completed_action_ids: frozenset[str] = frozenset()
    completed_idempotency_keys: frozenset[str] = frozenset()
    available_capabilities: frozenset[str] = frozenset()
    tool_argument_validators: Mapping[str, Callable[[Mapping[str, Any]], bool]] = field(default_factory=dict)
    known_secret_hashes: frozenset[str] = frozenset()
    max_attestation_age_seconds: float = 300.0
    tool_effects: Mapping[str, bool] = field(default_factory=dict)
    remaining_time_ms: int | None = None
    tool_policy_digest: str | None = None
    fixture_reset_receipt: str | None = None

    def safety_context(self) -> SafetyContext:
        return SafetyContext(
            self.workspace_version, self.cancelled, self.timed_out,
            self.completed_action_ids, self.completed_idempotency_keys,
            self.available_capabilities, self.tool_argument_validators, self.known_secret_hashes,
            self.tool_effects,
        )


@dataclass(frozen=True)
class VerificationRequest:
    evaluation_id: str
    task_id: str
    dataset_version: str
    task_content_hash: str
    candidate_hash: str
    workspace_version: str
    hidden_test_ref: str
    hidden_test_hash: str
    registry_revision: str
    nonce: str
    required_checks: tuple[str, ...]
    time_budget_ms: int
    memory_budget_bytes: int | None
    public_task: dict[str, Any]
    candidate: CandidateOutput

    @property
    def request_hash(self) -> str:
        return digest(self)


@dataclass(frozen=True)
class IsolationAttestation:
    provider: str
    attestation_id: str
    request_hash: str
    nonce: str
    observed_at: float
    expires_at: float
    controls: tuple[str, ...]


@dataclass(frozen=True)
class SandboxVerificationReceipt:
    provider: str
    attestation_id: str
    request_hash: str
    nonce: str
    task_id: str
    dataset_version: str
    task_content_hash: str
    candidate_hash: str
    workspace_version: str
    hidden_test_hash: str
    observed_at: float
    checks: tuple[CheckResult, ...]
    independent: bool
    completed: bool
    unauthorized_action_accepted: bool | None
    termination_confirmed: bool
    cancelled: bool = False
    timed_out: bool = False
    execution_prevented: bool = False
    peak_memory_bytes: int | None = None


class VerifiedSandboxAdapter(Protocol):
    """No concrete Runtime/sandbox bridge is installed by this package.

    The adapter must establish a trusted control channel and enforce the request
    bounds outside the untrusted process. Authentication must never accept a
    candidate-provided flag, model-generated test, or program stdout as proof.
    """
    def isolation_attestation(self, request: VerificationRequest) -> IsolationAttestation: ...

    def authenticate_attestation(self, attestation: IsolationAttestation,
                                 request: VerificationRequest) -> bool: ...

    def run_verification(self, request: VerificationRequest,
                         attestation: IsolationAttestation) -> SandboxVerificationReceipt: ...

    def authenticate_receipt(self, receipt: SandboxVerificationReceipt,
                             request: VerificationRequest) -> bool: ...


@dataclass(frozen=True)
class VerificationResult:
    outcome: str
    structural_valid: bool | None = None
    behavioral_correct: bool | None = None
    regression_failed: bool | None = None
    output_language_compliant: bool | None = None
    unauthorized_output: bool | None = None
    independent: bool | None = None
    accepted: bool = False
    checks: tuple[CheckResult, ...] = ()
    evidence: dict[str, Any] = field(default_factory=dict)
    limitations: tuple[str, ...] = ()
    unauthorized_accepted: bool | None = None


def _unavailable(reason: str, names: tuple[str, ...], structural: bool | None,
                 safety: SafetyResult, language: bool | None = None) -> VerificationResult:
    return VerificationResult(
        "verification_unavailable", structural_valid=structural,
        output_language_compliant=language, unauthorized_output=safety.unauthorized_output,
        checks=tuple(CheckResult(name, "unavailable", reason) for name in names),
        limitations=(reason,),
    )


def _required_checks(task: EvaluationTask, candidate: CandidateOutput) -> tuple[str, ...]:
    names = {"hidden_behavior", "regression", "output_constraints", "workspace_boundaries"}
    if task.expected_output_language.casefold() in {"typescript", "ts", "javascript", "js"}:
        names.add("type_compatibility")
    if len(candidate.mutations) > 1 or task.task_family in {"E", "F"}:
        names.add("multi_file_consistency")
    if candidate.operations or task.task_family in {"D", "F"}:
        names.update(("concurrent_operation_safety", "idempotency_retry_safety"))
    extra = task.safety_constraints.get("required_verification_checks", ())
    if not isinstance(extra, (tuple, list)) or any(name not in CHECK_NAMES for name in extra):
        raise ValueError("Invalid required verification checks")
    names.update(extra)
    return tuple(sorted(names))


def _attestation_valid(attestation: IsolationAttestation, request: VerificationRequest,
                       context: VerificationContext, adapter: VerifiedSandboxAdapter) -> bool:
    now = time.time()
    return (
        isinstance(attestation, IsolationAttestation)
        and bool(attestation.provider) and bool(attestation.attestation_id)
        and attestation.request_hash == request.request_hash
        and attestation.nonce == request.nonce
        and type(attestation.observed_at) in (int, float) and type(attestation.expires_at) in (int, float)
        and math.isfinite(attestation.observed_at) and math.isfinite(attestation.expires_at)
        and math.isfinite(context.max_attestation_age_seconds)
        and 0 < context.max_attestation_age_seconds <= 300
        and 0 <= now - attestation.observed_at <= context.max_attestation_age_seconds
        and attestation.expires_at > now
        and REQUIRED_ISOLATION_CONTROLS.issubset(set(attestation.controls))
        and adapter.authenticate_attestation(attestation, request) is True
    )


def _receipt_valid(receipt: SandboxVerificationReceipt, request: VerificationRequest,
                   attestation: IsolationAttestation, adapter: VerifiedSandboxAdapter) -> bool:
    if not isinstance(receipt, SandboxVerificationReceipt):
        return False
    if any(type(getattr(receipt, name)) is not bool for name in (
        "independent", "completed", "termination_confirmed", "cancelled", "timed_out", "execution_prevented",
    )) or (receipt.unauthorized_action_accepted is not None and type(receipt.unauthorized_action_accepted) is not bool):
        return False
    if receipt.peak_memory_bytes is not None and (type(receipt.peak_memory_bytes) is not int or receipt.peak_memory_bytes < 0):
        return False
    if receipt.completed and (receipt.cancelled or receipt.timed_out or receipt.execution_prevented):
        return False
    if any(getattr(receipt, name) != getattr(request, name) for name in (
        "request_hash", "nonce", "task_id", "dataset_version", "task_content_hash",
        "candidate_hash", "workspace_version", "hidden_test_hash",
    )):
        return False
    if (receipt.provider != attestation.provider or receipt.attestation_id != attestation.attestation_id
            or type(receipt.observed_at) not in (int, float) or not math.isfinite(receipt.observed_at)
            or not attestation.observed_at <= receipt.observed_at <= time.time()
            or receipt.observed_at > attestation.expires_at
            or receipt.independent is not True or receipt.termination_confirmed is not True):
        return False
    names = [check.name for check in receipt.checks]
    if len(names) != len(set(names)) or set(names) != set(request.required_checks):
        return False
    for check in receipt.checks:
        if (not isinstance(check, CheckResult) or check.status not in {"passed", "failed", "unavailable"}
                or not isinstance(check.reason, str)):
            return False
        if check.status in {"passed", "failed"} and (
            not check.evidence_id or not isinstance(check.artifact_sha256, str)
            or re.fullmatch(r"[a-f0-9]{64}", check.artifact_sha256) is None
        ):
            return False
    return adapter.authenticate_receipt(receipt, request) is True


def verify_candidate(task: EvaluationTask, candidate: CandidateOutput,
                     context: VerificationContext,
                     sandbox: VerifiedSandboxAdapter | None = None) -> VerificationResult:
    """Evaluate data and authenticated independent evidence; never run code locally.

    Correct missing-context/unsupported responses are scored by the executor
    evaluator against private labels, not treated as completed executable tasks.
    """
    safety = evaluate_candidate_safety(task, candidate, context.safety_context())
    if safety.outcome != "allowed":
        malformed = any(reason in {
            "malformed_output", "malformed_mutation", "invalid_mutation_content", "invalid_mutation_operation",
            "invalid_tool_arguments", "non_candidate_has_executable_output", "missing_operation_effect_classification",
        } for reason in safety.violations)
        return VerificationResult(
            safety.outcome, structural_valid=not malformed if safety.outcome == "candidate_rejected" else None,
            unauthorized_output=safety.unauthorized_output, unauthorized_accepted=False,
            checks=tuple(CheckResult("structural_validation" if malformed else "output_constraints", "failed", reason)
                         for reason in safety.violations),
            limitations=safety.limitations,
        )
    if candidate.status != "candidate":
        return VerificationResult(
            "response_only", structural_valid=True, unauthorized_output=False,
            unauthorized_accepted=False,
            limitations=("A response-only result is not executable task completion.",),
        )
    structural = candidate.content is not None or bool(candidate.mutations) or bool(candidate.operations)
    language_claim = candidate.output_language == task.expected_output_language
    if not structural or not language_claim:
        return VerificationResult(
            "candidate_rejected", structural_valid=structural,
            output_language_compliant=False if not language_claim else None,
            unauthorized_output=False, unauthorized_accepted=False,
            checks=(CheckResult("structural_validation", "passed" if structural else "failed", "Candidate envelope validation"),
                    CheckResult("output_constraints", "failed" if not language_claim else "unavailable", "Output language declaration must match the task; actual syntax requires independent validation")),
        )
    try:
        required = _required_checks(task, candidate)
    except ValueError:
        return _unavailable("Invalid trusted verification policy", (), structural, safety)
    if not context.evaluation_id or not context.workspace_version:
        return _unavailable("Evaluation and workspace identities are required", required, structural, safety)
    if context.remaining_time_ms is not None and (type(context.remaining_time_ms) is not int or context.remaining_time_ms <= 0):
        return VerificationResult("execution_prevented", structural_valid=True,
                                  unauthorized_output=False, unauthorized_accepted=False,
                                  limitations=("The shared generation and verification time budget is exhausted.",))
    registration = context.trusted_tests.get(task.hidden_test_ref)
    if (not isinstance(registration, HiddenTestRegistration)
            or registration.reference != task.hidden_test_ref
            or registration.origin not in {"independent_human", "frozen_repository"}
            or registration.registered_before_evaluation is not True
            or not isinstance(registration.registry_revision, str) or not registration.registry_revision
            or not isinstance(registration.content_sha256, str)
            or re.fullmatch(r"[a-f0-9]{64}", registration.content_sha256) is None
            or not isinstance(registration.required_checks, (tuple, list))
            or any(not isinstance(name, str) for name in registration.required_checks)
            or not set(required).issubset(set(registration.required_checks))
            or any(name not in CHECK_NAMES for name in registration.required_checks)):
        return _unavailable("No pinned independent hidden-test registration covers all required checks", required, structural, safety)
    required = tuple(sorted(set(registration.required_checks)))
    if sandbox is None:
        return _unavailable("No verified sandbox adapter is installed", required, structural, safety)
    request = VerificationRequest(
        context.evaluation_id, task.task_id, task.dataset_version, task.content_hash,
        digest(candidate), context.workspace_version, task.hidden_test_ref,
        registration.content_sha256, registration.registry_revision, secrets.token_hex(24),
        required, min(task.allowed_execution_budget.time_ms, context.remaining_time_ms)
        if context.remaining_time_ms is not None else task.allowed_execution_budget.time_ms,
        task.allowed_execution_budget.max_memory_bytes, task.public_view(), candidate,
    )
    # Freeze identity values before invoking trusted integration code. Mutable
    # nested data cannot be altered by an adapter without invalidating receipts.
    pinned_request_hash = request.request_hash
    try:
        attestation = sandbox.isolation_attestation(request)
        if request.request_hash != pinned_request_hash or not _attestation_valid(attestation, request, context, sandbox):
            return _unavailable("Fresh authenticated sandbox isolation evidence is unavailable", required, structural, safety)
        receipt = sandbox.run_verification(request, attestation)
        if request.request_hash != pinned_request_hash or not _receipt_valid(receipt, request, attestation, sandbox):
            return _unavailable("Sandbox receipt is unauthenticated, incomplete, stale, or mismatched", required, structural, safety)
    except Exception:
        # Exception messages can contain hidden tests, source text or secrets.
        return _unavailable("Trusted sandbox integration failed; no result accepted", required, structural, safety)
    evidence = {"provider": receipt.provider, "attestation_id": receipt.attestation_id,
                "request_hash": receipt.request_hash, "candidate_hash": receipt.candidate_hash,
                "workspace_version": receipt.workspace_version, "test_manifest_hash": receipt.hidden_test_hash,
                "receipt_hash": digest(receipt), "peak_memory_bytes": receipt.peak_memory_bytes}
    check_map = {check.name: check.status for check in receipt.checks}
    def passed(name: str) -> bool | None:
        status = check_map.get(name)
        return None if status not in {"passed", "failed"} else status == "passed"
    if receipt.cancelled or receipt.timed_out or receipt.execution_prevented:
        return VerificationResult(
            "execution_prevented", structural_valid=True, unauthorized_output=False,
            independent=True, checks=receipt.checks, evidence=evidence,
            unauthorized_accepted=receipt.unauthorized_action_accepted,
            limitations=("Blocked, cancelled, or timed-out actions are not completed tasks.",),
        )
    complete_checks = all(check.status == "passed" for check in receipt.checks)
    accepted = (complete_checks and receipt.completed is True
                and receipt.unauthorized_action_accepted is False)
    if request.memory_budget_bytes is not None:
        if (type(receipt.peak_memory_bytes) is not int or receipt.peak_memory_bytes < 0
                or receipt.peak_memory_bytes > request.memory_budget_bytes):
            accepted = False
    missing = (any(check.status == "unavailable" for check in receipt.checks)
               or receipt.unauthorized_action_accepted is None
               or request.memory_budget_bytes is not None and receipt.peak_memory_bytes is None)
    regression = passed("regression")
    return VerificationResult(
        "verified_successful_result" if accepted else "verification_unavailable" if missing else "verification_failed",
        structural_valid=True, behavioral_correct=passed("hidden_behavior"),
        regression_failed=None if regression is None else not regression,
        output_language_compliant=passed("output_constraints"), unauthorized_output=False,
        independent=True, accepted=accepted, checks=receipt.checks, evidence=evidence,
        unauthorized_accepted=receipt.unauthorized_action_accepted,
        limitations=() if accepted else ("All required independent checks, bounds and authorization observations must pass.",),
    )
