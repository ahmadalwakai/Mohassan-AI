"""Deterministic local fixtures with separate, restricted-domain correctness oracles.

Importing this module does not generate examples or evidence. Explicit invocation
requires a supplied usage authorization and selected trusted local evidence store.
"""
from __future__ import annotations

from dataclasses import asdict, replace
import random
import re
from typing import Any, Iterator, Mapping, Sequence

from .common import canonical_json, digest
from .errors import TrainingError
from .provenance import EvidenceRecord, LocalEvidenceStore
from .schemas import DATASET_SCHEMA_VERSION, TrainingExample, UsageAuthorization, timestamp
from .validation import parse_json, validate_example

GENERATOR_VERSION = "execution-synthetic-v1"
VERIFIER_ID = "execution-synthetic-oracle-v1"
DOMAINS = ("identifier_copy", "value_preservation", "structured_operations", "boundary_conditions",
    "type_transform", "typescript_function", "input_validation", "missing_context", "unsupported_task")
SPECS = {
    "identifier_copy": "Return the identifier exactly, with no added whitespace or explanation.",
    "value_preservation": "Return a JSON object with exactly the key value and preserve the supplied JSON value and type.",
    "structured_operations": "Return a copy operation using the supplied source and destination identifiers, with overwrite false.",
    "boundary_conditions": "Return a JSON object with within set to whether value is in the inclusive interval minimum through maximum.",
    "type_transform": "Convert every supplied integer to its base-ten string representation, preserving order, in a JSON object with key values.",
    "typescript_function": "Write the named exported TypeScript function. Accept value as number | null | undefined, return zero for null or undefined, otherwise add increment. Use no imports.",
    "input_validation": "Return a JSON object with valid true exactly when candidate is a nonnegative integer number; booleans and strings are invalid.",
    "missing_context": "List required fields absent from present in required order. Return status missing_context and the fields list; do not invent values.",
    "unsupported_task": "The requested operation is outside supported. Return status unsupported, reason operation_not_supported, and the requested operation.",
}


def synthetic_family_plan(domains: Sequence[str] = DOMAINS) -> dict[str, dict[str, str]]:
    """Reserve these IDs with splitting.reserve_families BEFORE generating variants.

    All scalar variants of a domain remain in one family. Nine small groups cannot
    guarantee nonempty random splits; explicitly reserve families when necessary.
    """
    if set(domains) - set(DOMAINS) or len(set(domains)) != len(domains):
        raise TrainingError("INVALID_SYNTHETIC_DOMAIN", "Unknown or repeated synthetic domain.")
    return {domain: {"project_family": "synthetic-v1:" + domain, "template_family": "synthetic-v1:" + domain} for domain in domains}


def _object(properties: dict[str, Any], *, required: list[str] | None = None) -> dict[str, Any]:
    return {"type": "object", "properties": properties, "required": list(properties) if required is None else required, "additionalProperties": False}


def _json_contract(schema: dict[str, Any]) -> dict[str, Any]:
    return {"format": "json", "language": "json", "schema": schema}


def _fixture(domain: str, rng: random.Random, index: int) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any], str]:
    """Generator implementation deliberately separate from check_synthetic."""
    integer = {"type": "integer"}
    string = {"type": "string"}
    boolean = {"type": "boolean"}
    if domain == "identifier_copy":
        identifier = rng.choice(("MixedCase_ID", "_leading", "item42", "الاسم", "café")) + "_" + str(index)
        return {"identifier": identifier}, _object({"identifier": string}), {"format": "text", "language": "text"}, identifier
    if domain == "value_preservation":
        values = (0, -1, 1, 255, 256, 1024, "0007", "-0.00", "أبجد", False)
        value = values[index % len(values)]
        kind = "boolean" if type(value) is bool else "integer" if type(value) is int else "string"
        schema = _object({"value": {"type": kind}})
        return {"value": value}, schema, _json_contract(schema), canonical_json({"value": value})
    if domain == "structured_operations":
        source, destination = "source_" + str(rng.randrange(10000)), "destination_" + str(index)
        context = {"source": source, "destination": destination}
        schema = _object({"operation": {"type": "string", "const": "copy"}, "source": string, "destination": string, "overwrite": boolean})
        return context, _object({"source": string, "destination": string}), _json_contract(schema), canonical_json({"operation": "copy", **context, "overwrite": False})
    if domain == "boundary_conditions":
        lower = rng.randrange(-100, 100)
        upper = lower + rng.randrange(0, 20)
        value = (lower - 1, lower, upper, upper + 1)[index % 4]
        context = {"value": value, "minimum": lower, "maximum": upper}
        return context, _object({key: integer for key in context}), _json_contract(_object({"within": boolean})), canonical_json({"within": lower <= value <= upper})
    if domain == "type_transform":
        values = [rng.randrange(-1024, 1025) for _ in range(index % 5)]
        return {"values": values}, _object({"values": {"type": "array", "items": integer}}), _json_contract(_object({"values": {"type": "array", "items": string}})), canonical_json({"values": [str(item) for item in values]})
    if domain == "typescript_function":
        name = "applyDelta" + str(index)
        increment = rng.randrange(-9, 10)
        context = {"function_name": name, "increment": increment, "available_imports": [], "language_version": "typescript-5"}
        schema = _object({"function_name": string, "increment": integer, "available_imports": {"type": "array", "items": string, "maxItems": 0}, "language_version": string})
        target = f"export function {name}(value: number | null | undefined): number {{\n  return value == null ? 0 : value + {increment};\n}}\n"
        return context, schema, {"format": "typescript", "language": "typescript"}, target
    if domain == "input_validation":
        values = (-1, 0, 1, "2", True, None)
        value = values[index % len(values)]
        kind = "null" if value is None else "boolean" if type(value) is bool else "integer" if type(value) is int else "string"
        return {"candidate": value}, _object({"candidate": {"type": kind}}), _json_contract(_object({"valid": boolean})), canonical_json({"valid": type(value) is int and value >= 0})
    if domain == "missing_context":
        required = ["source", "destination", "format"]
        present = required[:index % 3]
        context = {"present": present, "required": required}
        schema = _object({key: {"type": "array", "items": string} for key in context})
        output_schema = _object({"status": {"type": "string", "const": "missing_context"}, "fields": {"type": "array", "items": string, "minItems": 1}})
        return context, schema, _json_contract(output_schema), canonical_json({"status": "missing_context", "fields": required[len(present):]})
    if domain == "unsupported_task":
        requested = ("deploy_production", "purchase_item", "read_private_account")[index % 3]
        context = {"requested": requested, "supported": ["copy_identifier", "validate_integer"]}
        output_schema = _object({"status": {"type": "string", "const": "unsupported"}, "reason": {"type": "string", "const": "operation_not_supported"}, "operation": string})
        return context, _object({"requested": string, "supported": {"type": "array", "items": string}}), _json_contract(output_schema), canonical_json({"status": "unsupported", "reason": "operation_not_supported", "operation": requested})
    raise TrainingError("INVALID_SYNTHETIC_DOMAIN", "Unsupported synthetic fixture domain.")


def check_synthetic(example: TrainingExample) -> tuple[str, ...]:
    """Independent domain predicates, not model verdicts or a call to the generator.

    TypeScript support is a restricted source grammar with symbolic semantics, NOT
    a claim of having executed tsc or a JavaScript runtime. Other TS requires an
    external independent execution/typechecking evidence resolver.
    """
    family, context, target = example.task_family, example.required_context, example.expected_output
    if family not in DOMAINS or example.task_specification != SPECS[family]:
        raise TrainingError("SYNTHETIC_ORACLE_REJECTED", "Task is outside the oracle's fixed specification.")
    valid = False
    checks = ["fixed_specification", "exact_target", "independent_domain_predicate"]
    try:
        if family == "identifier_copy":
            valid = target.encode("utf-8") == context["identifier"].encode("utf-8")
        elif family == "typescript_function":
            # This grammar permits exactly one side-effect-free null-safe arithmetic function.
            pattern = r"export function ([A-Za-z_$][A-Za-z0-9_$]*)\(value: number \| null \| undefined\): number \{\n  return value == null \? 0 : value \+ (-?[0-9]+);\n\}\n"
            match = re.fullmatch(pattern, target)
            valid = bool(match and match[1] == context["function_name"] and int(match[2]) == context["increment"] and context["available_imports"] == [])
            if valid:
                delta = int(match[2])
                # Derived semantics of the accepted grammar: no arbitrary code is evaluated.
                for value in (-1024, -1, 0, 1, 1024):
                    observed = sum((value, delta))
                    required = context["increment"] + value
                    valid = valid and observed == required
            checks.extend(("restricted_typescript_grammar", "symbolic_null_undefined_return_zero", "symbolic_numeric_boundaries", "no_imports", "not_runtime_typechecked"))
        else:
            output = parse_json(target)
            if type(output) is not dict:
                raise ValueError("Expected object")
            if family == "value_preservation":
                valid = set(output) == {"value"} and type(output["value"]) is type(context["value"]) and output["value"] == context["value"]
            elif family == "structured_operations":
                valid = set(output) == {"operation", "source", "destination", "overwrite"} and output["operation"] == "copy" and output["source"] == context["source"] and output["destination"] == context["destination"] and output["overwrite"] is False
            elif family == "boundary_conditions":
                valid = set(output) == {"within"} and output["within"] is (not (context["value"] < context["minimum"] or context["value"] > context["maximum"]))
            elif family == "type_transform":
                values = output.get("values")
                valid = set(output) == {"values"} and type(values) is list and len(values) == len(context["values"])
                if valid:
                    for original, converted in zip(context["values"], values):
                        valid = valid and type(converted) is str and re.fullmatch(r"0|-[1-9][0-9]*|[1-9][0-9]*", converted) is not None and int(converted) == original
            elif family == "input_validation":
                candidate = context["candidate"]
                truth = isinstance(candidate, int) and not isinstance(candidate, bool) and not candidate < 0
                valid = set(output) == {"valid"} and output["valid"] is truth
            elif family == "missing_context":
                missing = [field for field in context["required"] if field not in set(context["present"])]
                valid = bool(missing) and set(output) == {"status", "fields"} and output["status"] == "missing_context" and output["fields"] == missing
            elif family == "unsupported_task":
                valid = context["requested"] not in context["supported"] and set(output) == {"status", "reason", "operation"} and output["status"] == "unsupported" and output["reason"] == "operation_not_supported" and output["operation"] == context["requested"]
    except (KeyError, ValueError, TypeError, OverflowError):
        valid = False
    if not valid:
        raise TrainingError("SYNTHETIC_ORACLE_REJECTED", "Synthetic answer failed the independent domain predicate.")
    return tuple(checks)


def generate_synthetic(*, seed: int, count_per_domain: int, authorization: UsageAuthorization,
                       evidence_store: LocalEvidenceStore, collected_at: str,
                       domains: Sequence[str] = DOMAINS,
                       evidence_scope_by_domain: Mapping[str, str] | None = None,
                       family_variant: str | None = None, index_start: int = 0) -> Iterator[TrainingExample]:
    """Explicit generation entry point. Does not run training or call any API.

    Use the same seed, timestamp, authorization, domain order and count to reproduce
    records. Optional pre-reserved test/validation scopes prevent feedback reuse.
    Each emitted example has passed the oracle and general validation.
    """
    if type(seed) is not int or type(count_per_domain) is not int or not 1 <= count_per_domain <= 100_000:
        raise TrainingError("INVALID_GENERATION_CONFIG", "Seed must be integer and count must be within the explicit bound.")
    authorization = UsageAuthorization.from_dict(asdict(authorization))
    if authorization.privacy_classification != "synthetic" or not authorization.rights_verified:
        raise TrainingError("UNAUTHORIZED_DATA", "Synthetic generation requires explicit rights and synthetic authorization.")
    timestamp(collected_at, "collected_at")
    if type(index_start) is not int or not 0 <= index_start <= 10_000_000:
        raise TrainingError("INVALID_GENERATION_CONFIG", "index_start must be a bounded nonnegative integer.")
    plan = synthetic_family_plan(domains)
    if family_variant is not None:
        # Separate split families for value-disjoint instances of one template, so
        # train/validation/held-out sets are distinct groups. Variants share templates:
        # they measure generalization over unseen values, not over unseen task types.
        if type(family_variant) is not str or re.fullmatch(r"[a-z][a-z0-9-]{0,31}", family_variant) is None:
            raise TrainingError("INVALID_GENERATION_CONFIG", "family_variant must be a short lowercase identifier.")
        plan = {domain: {key: value + ":" + family_variant for key, value in families.items()} for domain, families in plan.items()}
    scopes = dict(evidence_scope_by_domain or {})
    if set(scopes) - set(domains) or set(scopes.values()) - {"training", "validation", "test"}:
        raise TrainingError("INVALID_GENERATION_CONFIG", "Invalid pre-generation evidence scope reservation.")
    for domain in domains:
        scope = scopes.get(domain, "training")
        intended_use = {"training": "training", "validation": "validation", "test": "evaluation"}[scope]
        if intended_use not in authorization.permitted_uses:
            raise TrainingError("UNAUTHORIZED_DATA", "Synthetic usage is not authorized.")
        # index_start keeps generated identifiers (e.g. function names) disjoint across sets.
        for index in range(index_start, index_start + count_per_domain):
            recipe = {"generator": GENERATOR_VERSION, "seed": seed, "domain": domain, "index": index}
            if family_variant is not None:
                recipe["family_variant"] = family_variant
            recipe_hash = digest(recipe)
            rng = random.Random(int(recipe_hash, 16))
            context, input_schema, output_contract, target = _fixture(domain, rng, index)
            sample_id = "syn-v1:" + domain + ":" + recipe_hash[:24]
            raw = {
                "sample_id": sample_id, "task_family": domain, "operation_category": domain,
                "task_specification": SPECS[domain], "required_context": context,
                "input_contract": _json_contract(input_schema), "output_contract": output_contract,
                "expected_output": target, "acceptance_criteria": ["Satisfy the fixed task specification exactly.", "Preserve all supplied values and types required by the contract."],
                "verification": {"reference": "pending-local-oracle", "method": "restricted-typescript-static-v1" if domain == "typescript_function" else "deterministic-domain-oracle-v1",
                    "verifier_id": VERIFIER_ID, "subject_sha256": "0" * 64, "expected_output_sha256": "0" * 64},
                "source": {"kind": "synthetic", "source_id": "recipe:" + recipe_hash, "review_status": "not_applicable",
                    "reviewer_id": None, "review_reference": None, "generator_id": GENERATOR_VERSION, "teacher_model": None, "contains_customer_data": False},
                "provenance": {"origin": "local-synthetic:" + GENERATOR_VERSION, "source_sha256": recipe_hash,
                    "collected_at": collected_at, "transformation_history": [canonical_json(recipe)], "parent_sample_ids": [],
                    "project_revision": GENERATOR_VERSION, "evaluation_origin": False},
                "authorization": asdict(authorization), "environment_version": "synthetic-oracles-v1",
                "schema_version": DATASET_SCHEMA_VERSION, **plan[domain], "language": output_contract["language"],
                "difficulty": 1 if domain in {"identifier_copy", "value_preservation"} else 2,
                "curriculum_stage": "A" if domain in {"identifier_copy", "value_preservation", "structured_operations", "missing_context", "unsupported_task"} else "B",
                "repair": None,
            }
            candidate = TrainingExample.from_dict(raw)
            checks = check_synthetic(candidate)
            artifact = {"recipe": recipe, "subject_sha256": candidate.verification_hash, "target_sha256": candidate.target_hash,
                "verifier": VERIFIER_ID, "checks": checks, "scope": scope}
            record = EvidenceRecord(candidate.verification_hash, candidate.target_hash, True, True,
                candidate.verification.method, VERIFIER_ID, digest(artifact), checks, scope)
            # Both the actual checked artifact and receipt are persisted only now.
            from .common import atomic_json
            atomic_json(evidence_store.root / "artifacts" / (record.artifact_sha256 + ".json"), artifact, immutable=True)
            reference = evidence_store.put(record)
            candidate = replace(candidate, verification=replace(candidate.verification, reference=reference,
                subject_sha256=candidate.verification_hash, expected_output_sha256=candidate.target_hash))
            validation = validate_example(candidate, evidence_store, intended_use=intended_use)
            validation.require_accepted()
            yield candidate
