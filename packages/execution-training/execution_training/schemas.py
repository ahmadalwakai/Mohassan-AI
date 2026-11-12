"""Strict, versioned data contracts. No source is trusted merely because it parses."""
from __future__ import annotations

from dataclasses import asdict, dataclass, fields
from datetime import datetime
import hashlib
import math
import re
from typing import Any

from .common import digest
from .errors import TrainingError

DATASET_SCHEMA_VERSION = "execution-example-v1"
TASK_FAMILIES = frozenset({"identifier_copy", "value_preservation", "structured_operations",
    "missing_context", "unsupported_task", "typescript_function", "input_validation",
    "boundary_conditions", "type_transform", "repair", "skill_composition", "future_specialization"})
STAGE_FAMILIES = {
    "A": frozenset({"identifier_copy", "value_preservation", "structured_operations", "missing_context", "unsupported_task"}),
    "B": frozenset({"typescript_function", "input_validation", "boundary_conditions", "type_transform"}),
    "C": frozenset({"repair"}), "D": frozenset({"skill_composition"}), "E": frozenset({"future_specialization"}),
}


def fail(code: str, message: str) -> None:
    raise TrainingError(code, message)


def strict_keys(value: Any, required: set[str], optional: set[str] = frozenset()) -> dict[str, Any]:
    if type(value) is not dict or not all(type(key) is str for key in value):
        fail("INVALID_SCHEMA", "Expected an object with string keys.")
    if set(value) - required - optional or required - set(value):
        fail("INVALID_SCHEMA", "Unexpected or missing schema fields.")
    return value


def text(value: Any, name: str, maximum: int = 1_000_000) -> str:
    if type(value) is not str or not value.strip() or len(value) > maximum or "\x00" in value:
        fail("INVALID_SCHEMA", f"Invalid text field: {name}.")
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        fail("INVALID_SCHEMA", f"Invalid Unicode field: {name}.")
    return value


def identity(value: Any, name: str) -> str:
    value = text(value, name, 200)
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,199}", value):
        fail("INVALID_SCHEMA", f"Invalid identity field: {name}.")
    return value


def sha256(value: Any, name: str) -> str:
    if type(value) is not str or re.fullmatch(r"[a-f0-9]{64}", value) is None:
        fail("INVALID_SCHEMA", f"Invalid SHA-256 field: {name}.")
    return value


def boolean(value: Any, name: str) -> bool:
    if type(value) is not bool:
        fail("INVALID_SCHEMA", f"Invalid boolean field: {name}.")
    return value


def enumeration(value: Any, choices: Any, name: str) -> str:
    if type(value) is not str or value not in choices:
        fail("INVALID_SCHEMA", f"Invalid enumeration field: {name}.")
    return value


def strings(value: Any, name: str, *, nonempty: bool = False) -> tuple[str, ...]:
    if type(value) not in (list, tuple) or len(value) > 1024 or (nonempty and not value):
        fail("INVALID_SCHEMA", f"Invalid list field: {name}.")
    result = tuple(text(item, name, 65536) for item in value)
    if len(set(result)) != len(result):
        fail("INVALID_SCHEMA", f"Repeated values in: {name}.")
    return result


def timestamp(value: Any, name: str) -> str:
    value = text(value, name, 64)
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        fail("INVALID_SCHEMA", f"Invalid timestamp: {name}.")
    if parsed.tzinfo is None:
        fail("INVALID_SCHEMA", f"Timestamp needs timezone: {name}.")
    return value


def json_value(value: Any, depth: int = 0) -> None:
    if depth > 32:
        fail("INVALID_SCHEMA", "JSON exceeds nesting limit.")
    if type(value) is str:
        try:
            value.encode("utf-8")
        except UnicodeEncodeError:
            fail("INVALID_SCHEMA", "JSON contains invalid Unicode.")
        if "\x00" in value or len(value) > 1_000_000:
            fail("INVALID_SCHEMA", "JSON text exceeds limits or contains null bytes.")
        return
    if type(value) is int:
        if value.bit_length() > 1024:
            fail("INVALID_SCHEMA", "JSON integer exceeds the bounded numeric representation.")
        return
    if value is None or type(value) is bool:
        return
    if type(value) is float and math.isfinite(value):
        return
    if type(value) is list:
        if len(value) > 100_000:
            fail("INVALID_SCHEMA", "JSON list exceeds size limit.")
        for child in value:
            json_value(child, depth + 1)
        return
    if type(value) is dict and all(type(key) is str for key in value):
        if len(value) > 100_000:
            fail("INVALID_SCHEMA", "JSON object exceeds size limit.")
        for key, child in value.items():
            json_value(key, depth + 1)
            json_value(child, depth + 1)
        return
    fail("INVALID_SCHEMA", "Value is not finite JSON.")


def contract(value: Any, name: str) -> dict[str, Any]:
    value = strict_keys(value, {"format", "language"}, {"schema"})
    enumeration(value["format"], {"text", "json", "typescript"}, name + ".format")
    text(value["language"], name + ".language", 64)
    if value["format"] == "json":
        if "schema" not in value or type(value["schema"]) is not dict:
            fail("INVALID_SCHEMA", "JSON contracts require a schema.")
    elif "schema" in value:
        fail("INVALID_SCHEMA", "Only JSON contracts can carry a JSON schema.")
    json_value(value)
    return dict(value)


@dataclass(frozen=True)
class VerificationReference:
    reference: str
    method: str
    verifier_id: str
    subject_sha256: str
    expected_output_sha256: str

    @classmethod
    def from_dict(cls, raw: Any) -> "VerificationReference":
        data = strict_keys(raw, {f.name for f in fields(cls)})
        return cls(text(data["reference"], "verification.reference", 2048),
            identity(data["method"], "verification.method"), identity(data["verifier_id"], "verifier_id"),
            sha256(data["subject_sha256"], "subject_sha256"), sha256(data["expected_output_sha256"], "expected_output_sha256"))


@dataclass(frozen=True)
class DataSource:
    kind: str
    source_id: str
    review_status: str
    reviewer_id: str | None
    review_reference: str | None
    generator_id: str | None
    teacher_model: str | None
    contains_customer_data: bool

    @classmethod
    def from_dict(cls, raw: Any) -> "DataSource":
        data = strict_keys(raw, {f.name for f in fields(cls)})
        enumeration(data["kind"], {"synthetic", "human_reviewed", "teacher_generated"}, "source.kind")
        enumeration(data["review_status"], {"not_applicable", "pending", "approved", "rejected"}, "source.review_status")
        for key in ("reviewer_id", "generator_id", "teacher_model"):
            if data[key] is not None:
                identity(data[key], key)
        if data["review_reference"] is not None:
            text(data["review_reference"], "review_reference", 2048)
        identity(data["source_id"], "source_id")
        boolean(data["contains_customer_data"], "contains_customer_data")
        return cls(**data)


@dataclass(frozen=True)
class Provenance:
    origin: str
    source_sha256: str
    collected_at: str
    transformation_history: tuple[str, ...]
    parent_sample_ids: tuple[str, ...]
    project_revision: str | None
    evaluation_origin: bool

    @classmethod
    def from_dict(cls, raw: Any) -> "Provenance":
        data = strict_keys(raw, {f.name for f in fields(cls)})
        text(data["origin"], "origin", 2048)
        sha256(data["source_sha256"], "source_sha256")
        timestamp(data["collected_at"], "collected_at")
        if data["project_revision"] is not None:
            text(data["project_revision"], "project_revision", 200)
        boolean(data["evaluation_origin"], "evaluation_origin")
        return cls(**{**data, "transformation_history": strings(data["transformation_history"], "transformation_history"),
            "parent_sample_ids": strings(data["parent_sample_ids"], "parent_sample_ids")})


@dataclass(frozen=True)
class UsageAuthorization:
    license_id: str
    authorization_reference: str
    authorized_by: str
    permitted_uses: tuple[str, ...]
    rights_verified: bool
    privacy_classification: str
    privacy_approval_reference: str | None
    expires_at: str | None

    @classmethod
    def from_dict(cls, raw: Any) -> "UsageAuthorization":
        data = strict_keys(raw, {f.name for f in fields(cls)})
        identity(data["license_id"], "license_id")
        text(data["authorization_reference"], "authorization_reference", 2048)
        identity(data["authorized_by"], "authorized_by")
        uses = strings(data["permitted_uses"], "permitted_uses", nonempty=True)
        if set(uses) - {"training", "validation", "evaluation"}:
            fail("INVALID_SCHEMA", "Unsupported usage authorization.")
        boolean(data["rights_verified"], "rights_verified")
        enumeration(data["privacy_classification"], {"synthetic", "public", "approved_non_customer", "uncertain", "private_customer"}, "privacy_classification")
        if data["privacy_approval_reference"] is not None:
            text(data["privacy_approval_reference"], "privacy_approval_reference", 2048)
        if data["expires_at"] is not None:
            timestamp(data["expires_at"], "expires_at")
        return cls(**{**data, "permitted_uses": uses})


@dataclass(frozen=True)
class RepairEvidence:
    failed_candidate: str
    failure_evidence: tuple[str, ...]
    verified_correction: str
    failure_category: str
    verification_method: str
    regression_evidence: tuple[str, ...]
    tests_preserved: bool
    typecheck_bypassed: bool

    @classmethod
    def from_dict(cls, raw: Any) -> "RepairEvidence":
        data = strict_keys(raw, {f.name for f in fields(cls)})
        for key in ("failed_candidate", "verified_correction", "failure_category", "verification_method"):
            text(data[key], key)
        boolean(data["tests_preserved"], "tests_preserved")
        boolean(data["typecheck_bypassed"], "typecheck_bypassed")
        return cls(**{**data, "failure_evidence": strings(data["failure_evidence"], "failure_evidence", nonempty=True),
            "regression_evidence": strings(data["regression_evidence"], "regression_evidence", nonempty=True)})


@dataclass(frozen=True)
class TrainingExample:
    sample_id: str
    task_family: str
    operation_category: str
    task_specification: str
    required_context: dict[str, Any]
    input_contract: dict[str, Any]
    output_contract: dict[str, Any]
    expected_output: str
    acceptance_criteria: tuple[str, ...]
    verification: VerificationReference
    source: DataSource
    provenance: Provenance
    authorization: UsageAuthorization
    environment_version: str
    schema_version: str
    template_family: str
    project_family: str
    language: str
    difficulty: int | None = None
    curriculum_stage: str | None = None
    repair: RepairEvidence | None = None

    @classmethod
    def from_dict(cls, raw: Any) -> "TrainingExample":
        optional = {"difficulty", "curriculum_stage", "repair"}
        data = strict_keys(raw, {f.name for f in fields(cls)} - optional, optional)
        if data["schema_version"] != DATASET_SCHEMA_VERSION:
            fail("SCHEMA_VERSION_MISMATCH", "Unknown training-example schema version.")
        enumeration(data["task_family"], TASK_FAMILIES, "task_family")
        for key in ("sample_id", "operation_category", "environment_version", "template_family", "project_family"):
            identity(data[key], key)
        text(data["task_specification"], "task_specification")
        text(data["expected_output"], "expected_output")
        text(data["language"], "language", 64)
        if type(data["required_context"]) is not dict:
            fail("INVALID_SCHEMA", "Context must be an object, including an explicit empty object when appropriate.")
        json_value(data["required_context"])
        difficulty = data.get("difficulty")
        if difficulty is not None and (type(difficulty) is not int or not 1 <= difficulty <= 5):
            fail("INVALID_SCHEMA", "Difficulty must be an integer from one through five.")
        stage = data.get("curriculum_stage")
        if stage is not None:
            enumeration(stage, STAGE_FAMILIES, "curriculum_stage")
        return cls(**{**data, "required_context": dict(data["required_context"]),
            "input_contract": contract(data["input_contract"], "input_contract"),
            "output_contract": contract(data["output_contract"], "output_contract"),
            "acceptance_criteria": strings(data["acceptance_criteria"], "acceptance_criteria", nonempty=True),
            "verification": VerificationReference.from_dict(data["verification"]),
            "source": DataSource.from_dict(data["source"]), "provenance": Provenance.from_dict(data["provenance"]),
            "authorization": UsageAuthorization.from_dict(data["authorization"]),
            "repair": RepairEvidence.from_dict(data["repair"]) if data.get("repair") is not None else None,
            "difficulty": difficulty, "curriculum_stage": stage})

    def to_dict(self) -> dict[str, Any]:
        # asdict creates independent nested copies; never normalize target text.
        return asdict(self)

    def content_payload(self) -> dict[str, Any]:
        data = self.to_dict()
        return {key: data[key] for key in ("task_family", "operation_category", "task_specification", "required_context",
            "input_contract", "output_contract", "expected_output", "acceptance_criteria", "language", "repair")}

    def verification_payload(self) -> dict[str, Any]:
        data = self.to_dict()
        del data["verification"]
        return data

    @property
    def content_hash(self) -> str:
        return digest(self.content_payload())

    @property
    def verification_hash(self) -> str:
        return digest(self.verification_payload())

    @property
    def target_hash(self) -> str:
        return hashlib.sha256(self.expected_output.encode("utf-8")).hexdigest()
