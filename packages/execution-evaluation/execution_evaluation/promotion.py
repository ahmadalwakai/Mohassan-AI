"""An inert Phase 5 handoff contract; no activation, deployment or registry writes."""
from __future__ import annotations

from collections.abc import Mapping
import re
from typing import Any

from .common import digest, json_copy


def eligibility_handoff(decision: Mapping[str, Any], *, report_digest: str,
                        checkpoint_identity: str, previous_checkpoint_identity: str | None) -> dict[str, Any]:
    """Eligibility is a proposal. Phase 5 must authenticate original evidence afresh.

    This function cannot turn evaluation into authorization, even for eligible models.
    Failure evidence stays in evaluator storage; no training feedback route exists.
    """
    if not isinstance(report_digest, str) or re.fullmatch(r"[a-f0-9]{64}", report_digest) is None or not checkpoint_identity:
        raise ValueError("Report and checkpoint pins required")
    eligible = decision.get("promotion_eligible") is True and decision.get("decision") == "promotion_eligible"
    if eligible and (not decision.get("checks") or any(check.get("status") != "passed" for check in decision["checks"])
            or decision.get("model_identity", {}).get("checkpoint_identity") != checkpoint_identity
            or decision.get("model_identity_digest") != digest(decision.get("model_identity"))):
        raise ValueError("Eligibility decision does not bind this checkpoint and passed evidence")
    return {"schema_version": "execution-promotion-handoff-v1", "evaluation_id": decision.get("evaluation_id"),
        "checkpoint_identity": checkpoint_identity, "previous_checkpoint_identity": previous_checkpoint_identity,
        "report_digest": report_digest, "acceptance_decision_digest": digest(decision),
        "policy_digest": decision.get("policy_digest"), "promotion_eligible": eligible,
        "status": "eligibility_proposal_requires_phase5_review" if eligible else "not_eligible",
        "activation_authorized": False, "activation_performed": False, "automatic_deployment": False,
        "required_phase5_controls": ["authenticate_and_revalidate_all_evidence", "pin_exact_checkpoint_tokenizer_and_policy",
            "explicit_operator_activation_authorization", "full_system_verification", "bounded_staged_rollout",
            "retain_known_good_checkpoint_and_runtime_routing", "independently_verify_rollback", "monitor_safety_and_regression",
            "permissions_remain_in_cognitive_runtime", "never_export_private_evaluation_failures_to_training"],
        "acceptance": json_copy(decision)}
