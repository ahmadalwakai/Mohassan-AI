"""Independent acceptance-decision audit, separate from candidate generation."""
from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Protocol

from .common import digest
from .schemas import TaskResult


@dataclass(frozen=True)
class AcceptanceAuditReceipt:
    evaluation_id: str
    task_result_digest: str
    independent_issuer: str
    receipt_id: str
    false_acceptance: bool


class AcceptanceAuditAuthority(Protocol):
    def authenticate(self, receipt: AcceptanceAuditReceipt, result: TaskResult) -> bool: ...


def apply_acceptance_audit(result: TaskResult, receipt: AcceptanceAuditReceipt,
                           authority: AcceptanceAuditAuthority) -> TaskResult:
    original_digest = digest(result)
    if (receipt.evaluation_id != result.provenance.get("evaluation_id") or receipt.task_result_digest != original_digest
            or not receipt.independent_issuer or not receipt.receipt_id or type(receipt.false_acceptance) is not bool
            or authority.authenticate(receipt, result) is not True or digest(result) != original_digest):
        raise ValueError("No authentic independent acceptance audit for this exact observation")
    return replace(result, false_acceptance=receipt.false_acceptance,
        provenance={**result.provenance, "acceptance_audit_receipt": receipt.receipt_id,
                    "acceptance_audit_issuer": receipt.independent_issuer},
        missing_measurements=tuple(item for item in result.missing_measurements if item not in {"false_acceptance_independent_audit", "false_acceptance"}))
