"""Fail-closed validation of contracts, privacy, provenance and trusted evidence."""
from __future__ import annotations

from dataclasses import dataclass
import json
import math
import re
from typing import Any

from .errors import TrainingError
from .privacy import PrivacyPolicy, inspect_privacy
from .provenance import EvidenceRecord, EvidenceResolver, authorization_issues
from .schemas import STAGE_FAMILIES, TrainingExample


@dataclass(frozen=True)
class ValidationResult:
    status: str
    codes: tuple[str, ...]
    sample_id: str
    subject_sha256: str
    evidence_sha256: str | None = None
    privacy_policy_sha256: str | None = None

    @property
    def accepted(self) -> bool:
        return self.status == "accepted"

    def require_accepted(self) -> None:
        if not self.accepted:
            raise TrainingError(self.codes[0] if self.codes else "INVALID_DATASET", "Sample is " + self.status + "; see sanitized validation codes.")


def parse_json(text: str) -> Any:
    def pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
        value: dict[str, Any] = {}
        for key, child in items:
            if key in value:
                raise ValueError("Duplicate JSON object key")
            value[key] = child
        return value

    def invalid_constant(_: str) -> None:
        raise ValueError("Nonfinite JSON constant")

    try:
        return json.loads(text, object_pairs_hook=pairs, parse_constant=invalid_constant)
    except RecursionError as error:
        raise ValueError("Excessive JSON nesting") from error


_SCHEMA_KEYS = {"type", "properties", "required", "additionalProperties", "items", "enum", "const", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "description"}
_JSON_TYPES = {"object": dict, "array": list, "string": str, "integer": int, "number": (int, float), "boolean": bool, "null": type(None)}


def validate_json_schema(schema: Any, depth: int = 0) -> None:
    """Supported JSON Schema subset is explicit; unknown keywords never pass silently."""
    if depth > 32 or type(schema) is not dict or set(schema) - _SCHEMA_KEYS:
        raise TrainingError("INVALID_CONTRACT", "Unsupported or malformed JSON schema.")
    kind = schema.get("type")
    if type(kind) is not str or kind not in _JSON_TYPES:
        raise TrainingError("INVALID_CONTRACT", "Every JSON schema node requires a supported type.")
    for name in ("minLength", "maxLength", "minItems", "maxItems"):
        if name in schema and (type(schema[name]) is not int or schema[name] < 0):
            raise TrainingError("INVALID_CONTRACT", "Invalid schema size constraint.")
    for name in ("minimum", "maximum"):
        if name in schema and (type(schema[name]) not in (int, float) or (type(schema[name]) is float and not math.isfinite(schema[name]))):
            raise TrainingError("INVALID_CONTRACT", "Invalid numeric constraint.")
    if "description" in schema and type(schema["description"]) is not str:
        raise TrainingError("INVALID_CONTRACT", "Invalid schema description.")
    if "enum" in schema and (type(schema["enum"]) is not list or not schema["enum"]):
        raise TrainingError("INVALID_CONTRACT", "Schema enum must be a nonempty list.")
    if kind == "object":
        props = schema.get("properties", {})
        required = schema.get("required", [])
        if type(props) is not dict or type(required) is not list or not all(type(key) is str for key in required):
            raise TrainingError("INVALID_CONTRACT", "Invalid object schema.")
        if len(required) != len(set(required)) or set(required) - set(props):
            raise TrainingError("INVALID_CONTRACT", "Required properties must be declared exactly once.")
        if "additionalProperties" not in schema or type(schema["additionalProperties"]) is not bool:
            raise TrainingError("INVALID_CONTRACT", "Object schemas require an explicit additionalProperties boolean.")
        for child in props.values():
            validate_json_schema(child, depth + 1)
    elif any(key in schema for key in ("properties", "required", "additionalProperties")):
        raise TrainingError("INVALID_CONTRACT", "Object constraints on a nonobject schema.")
    if kind == "array":
        if "items" not in schema:
            raise TrainingError("INVALID_CONTRACT", "Array schemas require an items contract.")
        validate_json_schema(schema["items"], depth + 1)
    elif "items" in schema:
        raise TrainingError("INVALID_CONTRACT", "Items contract on a nonarray schema.")
    for minimum, maximum in (("minLength", "maxLength"), ("minItems", "maxItems"), ("minimum", "maximum")):
        if minimum in schema and maximum in schema and schema[minimum] > schema[maximum]:
            raise TrainingError("INVALID_CONTRACT", "Inconsistent schema bounds.")
    if kind != "string" and any(key in schema for key in ("minLength", "maxLength")):
        raise TrainingError("INVALID_CONTRACT", "String constraints on a nonstring schema.")
    if kind != "array" and any(key in schema for key in ("minItems", "maxItems")):
        raise TrainingError("INVALID_CONTRACT", "Array constraints on a nonarray schema.")
    if kind not in {"integer", "number"} and any(key in schema for key in ("minimum", "maximum")):
        raise TrainingError("INVALID_CONTRACT", "Numeric constraints on a nonnumeric schema.")


def matches_schema(value: Any, schema: dict[str, Any]) -> bool:
    kind = schema["type"]
    expected = _JSON_TYPES[kind]
    if isinstance(expected, tuple):
        if type(value) not in expected or (type(value) is float and not math.isfinite(value)):
            return False
    elif type(value) is not expected:
        return False
    # Compare canonical JSON to avoid Python's True == 1 equivalence.
    from .common import canonical_json
    if "enum" in schema and canonical_json(value) not in {canonical_json(item) for item in schema["enum"]}:
        return False
    if "const" in schema and canonical_json(value) != canonical_json(schema["const"]):
        return False
    if kind == "object":
        properties = schema.get("properties", {})
        if set(schema.get("required", [])) - set(value):
            return False
        if not schema["additionalProperties"] and set(value) - set(properties):
            return False
        return all(matches_schema(child, properties[key]) for key, child in value.items() if key in properties)
    if kind == "array":
        return schema.get("minItems", 0) <= len(value) <= schema.get("maxItems", len(value)) and all(matches_schema(item, schema["items"]) for item in value)
    if kind == "string":
        return schema.get("minLength", 0) <= len(value) <= schema.get("maxLength", len(value))
    if kind in {"number", "integer"}:
        return schema.get("minimum", value) <= value <= schema.get("maximum", value)
    return True


def validate_example(example: TrainingExample, evidence_resolver: EvidenceResolver, privacy_policy: PrivacyPolicy | None = None,
                     *, intended_use: str = "training") -> ValidationResult:
    if intended_use not in {"training", "validation", "evaluation"}:
        raise TrainingError("INVALID_USAGE", "Unknown dataset usage.")
    # Reparse to catch forged dataclass instances and nested dictionaries mutated after construction.
    example = TrainingExample.from_dict(example.to_dict())
    policy = privacy_policy or PrivacyPolicy()
    codes: list[str] = list(authorization_issues(example, intended_use=intended_use))
    uncertain: list[str] = []
    for code in ("PRIVACY_APPROVAL_REQUIRED", "HUMAN_REVIEW_REQUIRED", "TEACHER_PRIVACY_UNCERTAIN"):
        if code in codes:
            codes.remove(code)
            uncertain.append(code)
    stage = example.curriculum_stage
    if stage is not None and example.task_family not in STAGE_FAMILIES[stage]:
        codes.append("INVALID_CURRICULUM")
    if example.language != example.output_contract["language"]:
        codes.append("INCONSISTENT_LANGUAGE")
    for data_contract in (example.input_contract, example.output_contract):
        if data_contract["format"] in {"json", "typescript"} and data_contract["format"] != data_contract["language"]:
            codes.append("INCONSISTENT_LANGUAGE")
    try:
        if example.input_contract["format"] != "json":
            codes.append("INVALID_INPUT_CONTRACT")
        else:
            validate_json_schema(example.input_contract["schema"])
            if not matches_schema(example.required_context, example.input_contract["schema"]):
                codes.append("INCOMPLETE_CONTEXT")
        if example.output_contract["format"] == "json":
            validate_json_schema(example.output_contract["schema"])
            if not matches_schema(parse_json(example.expected_output), example.output_contract["schema"]):
                codes.append("INVALID_TARGET_FORMAT")
    except (TrainingError, ValueError, TypeError):
        codes.append("INVALID_CONTRACT_OR_OUTPUT")
    if example.task_family == "repair":
        if example.repair is None:
            codes.append("REPAIR_EVIDENCE_REQUIRED")
        else:
            repair = example.repair
            if repair.verified_correction != example.expected_output or repair.failed_candidate == repair.verified_correction:
                codes.append("INVALID_REPAIR_TARGET")
            if not repair.tests_preserved or repair.typecheck_bypassed or repair.verification_method != example.verification.method:
                codes.append("INVALID_REPAIR_SAFETY")
            if re.search(r"@ts-(?:ignore|nocheck)|\b(?:it|test|describe)\.skip\s*\(", repair.verified_correction):
                codes.append("REPAIR_BYPASS_DETECTED")
    elif example.repair is not None:
        codes.append("UNEXPECTED_REPAIR_EVIDENCE")
    privacy = inspect_privacy(example, policy)
    if privacy.status == "rejected":
        codes.append("PRIVACY_EXCLUDED")
    elif privacy.status == "quarantined":
        uncertain.append("PRIVACY_REVIEW_REQUIRED")
    evidence = None
    try:
        evidence = evidence_resolver.resolve(example.verification.reference)
        if evidence is not None:
            from dataclasses import asdict
            evidence = EvidenceRecord.from_dict(asdict(evidence))
    except (TrainingError, ValueError, TypeError, OSError):
        codes.append("CORRUPT_EVIDENCE")
    if evidence is None:
        codes.append("MISSING_VERIFICATION_EVIDENCE")
    else:
        reference = example.verification
        if not evidence.passed or not evidence.independent:
            codes.append("INDEPENDENT_VERIFICATION_REQUIRED")
        if evidence.subject_sha256 != example.verification_hash or reference.subject_sha256 != example.verification_hash:
            codes.append("EVIDENCE_SUBJECT_MISMATCH")
        if evidence.expected_output_sha256 != example.target_hash or reference.expected_output_sha256 != example.target_hash:
            codes.append("EVIDENCE_TARGET_MISMATCH")
        if (reference.method, reference.verifier_id) != (evidence.method, evidence.verifier_id):
            codes.append("EVIDENCE_VERIFIER_MISMATCH")
        if intended_use == "training" and evidence.scope != "training":
            codes.append("HELD_OUT_EVIDENCE_EXCLUDED")
        if intended_use == "validation" and evidence.scope == "test":
            codes.append("TEST_FEEDBACK_EXCLUDED")
        if example.provenance.evaluation_origin and intended_use != "evaluation":
            codes.append("EVALUATION_FEEDBACK_EXCLUDED")
        if example.task_family == "repair" and not {"failed_candidate_reproduced", "corrected_candidate_verified", "regression_preserved", "tests_preserved", "no_typecheck_bypass"}.issubset(evidence.checks):
            codes.append("REPAIR_REGRESSION_VERIFICATION_REQUIRED")
    status = "rejected" if codes else "quarantined" if uncertain else "accepted"
    return ValidationResult(status, tuple(dict.fromkeys(codes + uncertain)), example.sample_id, example.verification_hash,
        evidence.artifact_sha256 if evidence else None, policy.identity())
