"""Task payloads the trained model supports, built from the SAME generators it was trained on.

The worker never accepts a free-form prompt. A request names a capability and its
typed fields, and the prompt is rendered by Phase 3's ``render_prompt_payload``.
An unknown capability, an unknown field or a value outside its bounds is unsupported.
"""
from __future__ import annotations

import re
from typing import Any, Mapping

from . import PACKAGES_ROOT  # noqa: F401

from execution_training.synthetic import SPECS
from execution_training.tokenization import render_prompt_payload

from .repair import METHOD as REPAIR_METHOD, REPAIR_SPEC, interpret

ACCEPTANCE = ["Satisfy the fixed task specification exactly.", "Preserve all supplied values and types required by the contract."]
REPAIR_ACCEPTANCE = ["Every recorded failure is fixed.", "No regression on the specification probes."]
IDENTIFIER = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,63}")
CAPABILITIES = {
    "typescript.implement.v1:null-safe-delta": "typescript_function",
    "typescript.repair.v1:null-safe-delta": "repair",
}
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
