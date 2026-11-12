"""Deterministic local-repair examples (Phase 3 curriculum Stage C).

Phase 3 defines the repair schema and its evidence requirements but ships no
repair generator. Each example here has a concrete defective candidate, failure
evidence computed by an independent interpreter, and a verified correction.

The interpreter evaluates only a closed grammar of one-line null-safe arithmetic
functions with JavaScript semantics (``null + k == k``, ``undefined + k`` is NaN).
It never evaluates generated code. Actual execution of model output happens later,
in the AppContainer sandbox, as a separate verification step.
"""
from __future__ import annotations

import math
import random
import re
from dataclasses import asdict, replace
from typing import Any, Iterator

from . import PACKAGES_ROOT  # noqa: F401

from execution_training.common import atomic_json, canonical_json, digest
from execution_training.errors import TrainingError
from execution_training.provenance import EvidenceRecord, LocalEvidenceStore
from execution_training.schemas import DATASET_SCHEMA_VERSION, TrainingExample, UsageAuthorization, timestamp
from execution_training.validation import validate_example

GENERATOR_VERSION = "execution-repair-v1"
VERIFIER_ID = "execution-repair-oracle-v1"
METHOD = "closed-grammar-js-semantics-v1"
REPAIR_SPEC = ("Repair the exported TypeScript function so it satisfies the specification: accept value as "
               "number | null | undefined, return zero for null or undefined, otherwise add increment. "
               "Use the failure evidence. Return the complete corrected function with no imports.")
BUGS = ("missing_null_guard", "wrong_operator", "wrong_default")
PROBES: tuple[Any, ...] = (None, "undefined", -1024, -1, 0, 1, 1024)
REQUIRED_CHECKS = ("failed_candidate_reproduced", "corrected_candidate_verified", "regression_preserved",
                   "tests_preserved", "no_typecheck_bypass")

_SIGNATURE = r"export function ([A-Za-z_$][A-Za-z0-9_$]*)\(value: number \| null \| undefined\): number \{\n  return (.+);\n\}\n"
_GUARDED = re.compile(r"value == null \? (-?[0-9]+) : value ([+-]) (-?[0-9]+)")
_UNGUARDED = re.compile(r"value ([+-]) (-?[0-9]+)")


def source(name: str, expression: str) -> str:
    return f"export function {name}(value: number | null | undefined): number {{\n  return {expression};\n}}\n"


def correct_expression(increment: int) -> str:
    return f"value == null ? 0 : value + {increment}"


def interpret(text: str) -> tuple[str, Any]:
    """Return (function name, evaluator) for the closed grammar, or raise."""
    match = re.fullmatch(_SIGNATURE, text)
    if not match:
        raise TrainingError("REPAIR_ORACLE_REJECTED", "Source is outside the closed repair grammar.")
    name, expression = match[1], match[2]

    def arithmetic(operand: Any, operator: str, constant: int) -> float:
        base = 0 if operand is None else math.nan if operand == "undefined" else operand
        return base + constant if operator == "+" else base - constant

    if guarded := _GUARDED.fullmatch(expression):
        default, operator, constant = int(guarded[1]), guarded[2], int(guarded[3])
        return name, lambda value: default if value in (None, "undefined") else arithmetic(value, operator, constant)
    if unguarded := _UNGUARDED.fullmatch(expression):
        operator, constant = unguarded[1], int(unguarded[2])
        return name, lambda value: arithmetic(value, operator, constant)
    raise TrainingError("REPAIR_ORACLE_REJECTED", "Return expression is outside the closed repair grammar.")


def expected(value: Any, increment: int) -> int:
    return 0 if value in (None, "undefined") else value + increment


def _show(value: Any) -> str:
    return "null" if value is None else "undefined" if value == "undefined" else "NaN" if isinstance(value, float) and math.isnan(value) else str(int(value))


def failures(text: str, function_name: str, increment: int) -> tuple[str, ...]:
    name, evaluate = interpret(text)
    if name != function_name:
        return (f"function name is {name}; expected {function_name}",)
    found = []
    for probe in PROBES:
        observed = evaluate(probe)
        want = expected(probe, increment)
        if not (observed == want):  # NaN never equals
            found.append(f"{function_name}({_show(probe)}) returned {_show(observed)}; expected {want}")
    return tuple(found)


def defective(bug: str, name: str, increment: int) -> str:
    if bug == "missing_null_guard":
        return source(name, f"value + {increment}")
    if bug == "wrong_operator":
        return source(name, f"value == null ? 0 : value - {increment}")
    if bug == "wrong_default":
        return source(name, f"value == null ? 1 : value + {increment}")
    raise TrainingError("INVALID_SYNTHETIC_DOMAIN", "Unknown repair defect.")


def repair_case(seed: int, index: int) -> dict[str, Any]:
    """Pure fixture generation shared with the evaluation set and the TS demo."""
    rng = random.Random(int(digest({"generator": GENERATOR_VERSION, "seed": seed, "index": index}), 16))
    bug = BUGS[index % len(BUGS)]
    increment = rng.choice([value for value in range(-9, 10) if value != 0])
    name = "repairDelta" + str(index)
    failed = defective(bug, name, increment)
    evidence = failures(failed, name, increment)
    if not evidence:
        raise TrainingError("REPAIR_ORACLE_REJECTED", "Defective candidate did not reproduce a failure.")
    correction = source(name, correct_expression(increment))
    if failures(correction, name, increment):
        raise TrainingError("REPAIR_ORACLE_REJECTED", "Correction failed the independent oracle.")
    return {"bug": bug, "function_name": name, "increment": increment, "failed": failed,
            "failure_evidence": evidence[:2], "correction": correction}


def generate_repairs(*, seed: int, count: int, authorization: UsageAuthorization, evidence_store: LocalEvidenceStore,
                     collected_at: str, family_variant: str, scope: str = "training",
                     index_start: int = 0) -> Iterator[TrainingExample]:
    if scope not in ("training", "validation", "test") or type(count) is not int or not 1 <= count <= 100_000:
        raise TrainingError("INVALID_GENERATION_CONFIG", "Invalid repair generation request.")
    authorization = UsageAuthorization.from_dict(asdict(authorization))
    if authorization.privacy_classification != "synthetic" or not authorization.rights_verified:
        raise TrainingError("UNAUTHORIZED_DATA", "Synthetic repair generation requires synthetic authorization.")
    timestamp(collected_at, "collected_at")
    intended = {"training": "training", "validation": "validation", "test": "evaluation"}[scope]
    family = "synthetic-repair-v1:" + family_variant
    for index in range(index_start, index_start + count):
        case = repair_case(seed, index)
        recipe = {"generator": GENERATOR_VERSION, "seed": seed, "index": index, "family_variant": family_variant}
        recipe_hash = digest(recipe)
        context = {"function_name": case["function_name"], "increment": case["increment"], "available_imports": [],
                   "language_version": "typescript-5"}
        schema = {"type": "object", "additionalProperties": False, "required": list(context), "properties": {
            "function_name": {"type": "string"}, "increment": {"type": "integer"},
            "available_imports": {"type": "array", "items": {"type": "string"}, "maxItems": 0},
            "language_version": {"type": "string"}}}
        raw = {
            "sample_id": "rep-v1:" + recipe_hash[:24], "task_family": "repair", "operation_category": "repair",
            "task_specification": REPAIR_SPEC, "required_context": context,
            "input_contract": {"format": "json", "language": "json", "schema": schema},
            "output_contract": {"format": "typescript", "language": "typescript"},
            "expected_output": case["correction"],
            "acceptance_criteria": ["Every recorded failure is fixed.", "No regression on the specification probes."],
            "verification": {"reference": "pending", "method": METHOD, "verifier_id": VERIFIER_ID,
                             "subject_sha256": "0" * 64, "expected_output_sha256": "0" * 64},
            "source": {"kind": "synthetic", "source_id": "recipe:" + recipe_hash, "review_status": "not_applicable",
                       "reviewer_id": None, "review_reference": None, "generator_id": GENERATOR_VERSION,
                       "teacher_model": None, "contains_customer_data": False},
            "provenance": {"origin": "local-synthetic:" + GENERATOR_VERSION, "source_sha256": recipe_hash,
                           "collected_at": collected_at, "transformation_history": [canonical_json(recipe)],
                           "parent_sample_ids": [], "project_revision": GENERATOR_VERSION, "evaluation_origin": False},
            "authorization": asdict(authorization), "environment_version": "synthetic-oracles-v1",
            "schema_version": DATASET_SCHEMA_VERSION, "template_family": family, "project_family": family,
            "language": "typescript", "difficulty": 3, "curriculum_stage": "C",
            "repair": {"failed_candidate": case["failed"], "failure_evidence": list(case["failure_evidence"]),
                       "verified_correction": case["correction"], "failure_category": case["bug"],
                       "verification_method": METHOD,
                       "regression_evidence": [f"{len(PROBES)} specification probes pass"],
                       "tests_preserved": True, "typecheck_bypassed": False},
        }
        example = TrainingExample.from_dict(raw)
        artifact = {"recipe": recipe, "subject_sha256": example.verification_hash, "target_sha256": example.target_hash,
                    "verifier": VERIFIER_ID, "checks": REQUIRED_CHECKS, "scope": scope,
                    "reproduced_failures": list(case["failure_evidence"]), "probes": [_show(p) for p in PROBES]}
        record = EvidenceRecord(example.verification_hash, example.target_hash, True, True, METHOD, VERIFIER_ID,
                                digest(artifact), REQUIRED_CHECKS, scope)
        atomic_json(evidence_store.root / "artifacts" / (record.artifact_sha256 + ".json"), artifact, immutable=True)
        reference = evidence_store.put(record)
        example = replace(example, verification=replace(example.verification, reference=reference,
                          subject_sha256=example.verification_hash, expected_output_sha256=example.target_hash))
        validate_example(example, evidence_store, intended_use=intended).require_accepted()
        yield example
