"""Versioned task, public request, untrusted candidate and observation contracts."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .common import canonical_json, digest, json_copy, to_jsonable

TASK_SCHEMA_VERSION = "execution-evaluation-task-v1"
REPORT_SCHEMA_VERSION = "execution-evaluation-report-v1"
TASK_FAMILIES = {
    "A": "structured_specification_to_operation", "B": "short_typescript_implementation",
    "C": "repair_from_failure_evidence", "D": "skill_composition",
    "E": "multi_file_changes", "F": "full_stack_workflow_integration",
}
PROPOSED_TARGETS = {"atomic": 200, "repository_context": 60, "end_to_end": 20}


@dataclass(frozen=True)
class ExecutionBudget:
    time_ms: int
    output_tokens: int
    max_attempts: int
    max_memory_bytes: int | None = None
    external_calls: int = 0
    external_tokens: int = 0

    def __post_init__(self) -> None:
        for name in ("time_ms", "output_tokens", "max_attempts"):
            if type(getattr(self, name)) is not int or getattr(self, name) <= 0:
                raise ValueError(f"{name} must be a positive integer")
        for name in ("external_calls", "external_tokens"):
            if type(getattr(self, name)) is not int or getattr(self, name) < 0:
                raise ValueError(f"{name} must be a nonnegative integer")
        if self.max_memory_bytes is not None and (type(self.max_memory_bytes) is not int or self.max_memory_bytes <= 0):
            raise ValueError("max_memory_bytes must be positive or null")


@dataclass(frozen=True)
class EvaluationTask:
    task_id: str
    task_family: str
    project_family: str
    template_family: str
    input_specification: dict[str, Any]
    available_context: dict[str, Any]
    allowed_symbols: tuple[str, ...]
    expected_behavior: dict[str, Any]
    acceptance_criteria: tuple[str, ...]
    hidden_test_ref: str
    required_capabilities: tuple[str, ...]
    allowed_execution_budget: ExecutionBudget
    expected_output_language: str
    safety_constraints: dict[str, Any]
    dataset_version: str
    tier: str
    expected_response: str = "candidate"
    schema_version: str = TASK_SCHEMA_VERSION

    def __post_init__(self) -> None:
        for name in ("task_id", "project_family", "template_family", "hidden_test_ref", "dataset_version", "expected_output_language"):
            if not isinstance(getattr(self, name), str) or not getattr(self, name).strip():
                raise ValueError(f"{name} is required")
        if self.schema_version != TASK_SCHEMA_VERSION or self.task_family not in TASK_FAMILIES or self.tier not in PROPOSED_TARGETS:
            raise ValueError("Unsupported task schema, family or tier")
        if self.expected_response not in ("candidate", "unsupported", "missing_context"):
            raise ValueError("Invalid evaluator-only expected response")
        if not isinstance(self.allowed_execution_budget, ExecutionBudget):
            raise TypeError("Expected ExecutionBudget")
        for name in ("input_specification", "available_context", "expected_behavior", "safety_constraints"):
            if not isinstance(getattr(self, name), dict):
                raise TypeError(f"{name} must be a JSON object")
            object.__setattr__(self, name, json_copy(getattr(self, name)))
        for name in ("allowed_symbols", "acceptance_criteria", "required_capabilities"):
            value = getattr(self, name)
            if not isinstance(value, (tuple, list)) or any(not isinstance(item, str) or not item for item in value):
                raise ValueError(f"{name} must contain strings")
            object.__setattr__(self, name, tuple(value))
        if not self.acceptance_criteria:
            raise ValueError("Independent acceptance criteria required")
        risks = self.safety_constraints.get("risk_classes", [])
        if not isinstance(risks, list) or any(not isinstance(risk, str) or risk not in {
            "standard", "permissions", "financial", "database_mutation", "live_advertising"} for risk in risks):
            raise ValueError("risk_classes must explicitly enumerate known risk classes")
        canonical_json(self)

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> EvaluationTask:
        data = json_copy(raw)
        data["allowed_execution_budget"] = ExecutionBudget(**data["allowed_execution_budget"])
        return cls(**data)

    def public_view(self) -> dict[str, Any]:
        # Explicit allowlist: additions to evaluator metadata never leak by default.
        return json_copy({name: getattr(self, name) for name in (
            "schema_version", "task_id", "task_family", "project_family", "template_family",
            "input_specification", "available_context", "allowed_symbols", "required_capabilities",
            "allowed_execution_budget", "expected_output_language", "safety_constraints", "dataset_version", "tier",
        )})

    @property
    def content_hash(self) -> str:
        return digest(self)


@dataclass(frozen=True)
class CandidateOutput:
    """Data only. Metadata and model claims never authorize execution or acceptance."""
    status: str
    content: dict[str, Any] | str | None = None
    output_language: str | None = None
    mutations: tuple[dict[str, Any], ...] = ()
    operations: tuple[dict[str, Any], ...] = ()
    workspace_version: str | None = None
    reason: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.status not in ("candidate", "unsupported", "missing_context", "unavailable", "error"):
            raise ValueError("Invalid candidate status")
        if self.content is not None and not isinstance(self.content, (dict, str)):
            raise TypeError("Candidate content must be a string, object or null")
        for name in ("mutations", "operations"):
            values = getattr(self, name)
            if not isinstance(values, (tuple, list)) or any(not isinstance(item, dict) for item in values):
                raise TypeError(f"{name} must be an array of objects")
            object.__setattr__(self, name, tuple(json_copy(values)))
        if self.status != "candidate" and (self.content is not None or self.mutations or self.operations):
            raise ValueError("Non-candidate responses cannot carry executable payloads")
        if not isinstance(self.metadata, dict):
            raise TypeError("Metadata must be an object")
        canonical_json(self)


@dataclass(frozen=True)
class ExecutionRequest:
    task: dict[str, Any]
    budget: ExecutionBudget
    attempt: int
    seed: int
    prior_candidate: CandidateOutput | None = None

    def __post_init__(self) -> None:
        forbidden = {"hidden_test_ref", "expected_behavior", "acceptance_criteria", "expected_response"}
        if forbidden.intersection(self.task):
            raise ValueError("Private evaluation material cannot enter an executor request")
        if type(self.attempt) is not int or self.attempt <= 0 or type(self.seed) is not int or self.seed < 0:
            raise ValueError("Invalid attempt or seed")
        object.__setattr__(self, "task", json_copy(self.task))


@dataclass(frozen=True)
class TaskResult:
    task_id: str
    task_family: str
    project_family: str
    template_family: str
    tier: str
    dataset_version: str
    arm_id: str
    mode: str
    outcome: str
    attempts: int = 0
    first_attempt_success: bool | None = None
    success_within_budget: bool | None = None
    end_to_end_completed: bool | None = None
    structural_valid: bool | None = None
    behavioral_correct: bool | None = None
    regression_failed: bool | None = None
    false_acceptance: bool | None = None
    expected_response: str = "candidate"
    predicted_response: str = "unavailable"
    unauthorized_output: bool | None = None
    unauthorized_accepted: bool | None = None
    output_language_compliant: bool | None = None
    external_escalated: bool | None = None
    independent_local_contribution: bool | None = None
    latency_ms: float | None = None
    peak_memory_bytes: int | None = None
    cost_usd: float | None = None
    external_reasoning: dict[str, Any] = field(default_factory=dict)
    attempt_records: tuple[dict[str, Any], ...] = ()
    limitations: tuple[str, ...] = ()
    missing_measurements: tuple[str, ...] = ()
    provenance: dict[str, Any] = field(default_factory=dict)
    failure_categories: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return to_jsonable(self)
