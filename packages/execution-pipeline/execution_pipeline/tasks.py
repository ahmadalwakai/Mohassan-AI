"""Task payloads the trained model supports, built from the SAME generators it was trained on.

The worker never accepts a free-form prompt. A request names a capability and its
typed fields, and the prompt is rendered by Phase 3's ``render_prompt_payload``.
An unknown capability, an unknown field or a value outside its bounds is unsupported.
"""
from __future__ import annotations

import re
from typing import Any, Mapping

from . import PACKAGES_ROOT  # noqa: F401

from execution_training.synthetic import SPECS, _json_contract, _object
from execution_training.tokenization import render_prompt_payload

from .repair import METHOD as REPAIR_METHOD, REPAIR_SPEC, interpret

ACCEPTANCE = ["Satisfy the fixed task specification exactly.", "Preserve all supplied values and types required by the contract."]
REPAIR_ACCEPTANCE = ["Every recorded failure is fixed.", "No regression on the specification probes."]
IDENTIFIER = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,63}")
CAPABILITIES = {
    "typescript.implement.v1:null-safe-delta": "typescript_function",
    "typescript.repair.v1:null-safe-delta": "repair",
    # The two JSON families where the held-out evaluation measured any model success
    # (type_transform 12/19, boundary_conditions 12/23 on exec-c40m). Same specification,
    # schemas and value ranges as the synthetic generator, so the rendered prompt is
    # identical to a training prompt for the same values (see the prompt parity test).
    "json.transform.v1:integers-to-strings": "type_transform",
    "json.check.v1:inclusive-interval": "boundary_conditions",
}


def _is_int(value: Any) -> bool:
    return type(value) is int


def _json_payload(family: str, context: dict[str, Any], input_schema: dict[str, Any], output_schema: dict[str, Any]) -> dict[str, Any]:
    return {"task_family": family, "operation_category": family, "task_specification": SPECS[family],
            "required_context": context, "input_contract": _json_contract(input_schema),
            "output_contract": _json_contract(output_schema), "acceptance_criteria": list(ACCEPTANCE), "language": "json"}


def _type_transform(fields: Mapping[str, Any]) -> dict[str, Any]:
    values = fields.get("values")
    # Trained range: 0-4 integers, each from -1024 through 1024.
    if set(fields) != {"values"} or not isinstance(values, list) or len(values) > 4 \
            or any(not _is_int(item) or not -1024 <= item <= 1024 for item in values):
        raise UnsupportedTask("Fields are outside the trained integers-to-strings domain.")
    integer, string = {"type": "integer"}, {"type": "string"}
    return _json_payload("type_transform", {"values": list(values)},
                         _object({"values": {"type": "array", "items": integer}}),
                         _object({"values": {"type": "array", "items": string}}))


def _boundary(fields: Mapping[str, Any]) -> dict[str, Any]:
    if set(fields) != {"value", "minimum", "maximum"} or not all(_is_int(fields[key]) for key in fields):
        raise UnsupportedTask("Unexpected fields for the inclusive interval check.")
    value, minimum, maximum = fields["value"], fields["minimum"], fields["maximum"]
    # Trained range: minimum -100..99, width 0..19, value at most one step outside the interval.
    if not -100 <= minimum <= 99 or not 0 <= maximum - minimum <= 19 or not minimum - 1 <= value <= maximum + 1:
        raise UnsupportedTask("Fields are outside the trained inclusive-interval domain.")
    context = {"value": value, "minimum": minimum, "maximum": maximum}
    return _json_payload("boundary_conditions", context, _object({key: {"type": "integer"} for key in context}),
                         _object({"within": {"type": "boolean"}}))
REPAIR_CATEGORIES = ("missing_null_guard", "wrong_operator", "wrong_default")


class UnsupportedTask(ValueError):
    pass


def _delta_context(fields: Mapping[str, Any]) -> dict[str, Any]:
    name, increment = fields.get("function_name"), fields.get("increment")
    if not isinstance(name, str) or not IDENTIFIER.fullmatch(name) or type(increment) is not int or not -9 <= increment <= 9:
        raise UnsupportedTask("Fields are outside the trained null-safe-delta domain.")
    return {"function_name": name, "increment": increment, "available_imports": [], "language_version": "typescript-5"}


def _delta_schema() -> dict[str, Any]:
    string, integer = {"type": "string"}, {"type": "integer"}
    properties = {"function_name": string, "increment": integer,
                  "available_imports": {"type": "array", "items": string, "maxItems": 0}, "language_version": string}
    return {"type": "object", "properties": properties, "required": list(properties), "additionalProperties": False}


def build_payload(capability: str, fields: Mapping[str, Any]) -> dict[str, Any]:
    family = CAPABILITIES.get(capability)
    if family is None or not isinstance(fields, Mapping):
        raise UnsupportedTask("Capability is not advertised by this model.")
    if family == "type_transform":
        return _type_transform(fields)
    if family == "boundary_conditions":
        return _boundary(fields)
    if family == "typescript_function":
        if set(fields) != {"function_name", "increment"}:
            raise UnsupportedTask("Unexpected fields for typescript implementation.")
        return {"task_family": "typescript_function", "operation_category": "typescript_function",
                "task_specification": SPECS["typescript_function"], "required_context": _delta_context(fields),
                "input_contract": {"format": "json", "language": "json", "schema": _delta_schema()},
                "output_contract": {"format": "typescript", "language": "typescript"},
                "acceptance_criteria": list(ACCEPTANCE), "language": "typescript"}
    if set(fields) != {"function_name", "increment", "failed_candidate", "failure_evidence", "failure_category"}:
        raise UnsupportedTask("Unexpected fields for local repair.")
    failed, evidence, category = fields["failed_candidate"], fields["failure_evidence"], fields["failure_category"]
    if (not isinstance(failed, str) or len(failed) > 2000 or category not in REPAIR_CATEGORIES
            or not isinstance(evidence, list) or not 1 <= len(evidence) <= 2
            or any(not isinstance(item, str) or not 1 <= len(item) <= 300 for item in evidence)):
        raise UnsupportedTask("Repair evidence is outside the trained domain.")
    try:
        interpret(failed)
    except Exception as error:  # closed grammar only; nothing is evaluated
        raise UnsupportedTask("Failed candidate is outside the trained repair grammar.") from error
    return {"task_family": "repair", "operation_category": "repair", "task_specification": REPAIR_SPEC,
            "required_context": _delta_context({"function_name": fields["function_name"], "increment": fields["increment"]}),
            "input_contract": {"format": "json", "language": "json", "schema": _delta_schema()},
            "output_contract": {"format": "typescript", "language": "typescript"},
            "acceptance_criteria": list(REPAIR_ACCEPTANCE), "language": "typescript",
            "repair": {"failed_candidate": failed, "failure_evidence": list(evidence), "failure_category": category,
                       "verification_method": REPAIR_METHOD, "tests_preserved": True, "typecheck_bypassed": False}}


def render(capability: str, fields: Mapping[str, Any]) -> str:
    return render_prompt_payload(build_payload(capability, fields))
