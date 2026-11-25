"""Prepare the PR #16 classifier registration for an independent evaluator."""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from hashlib import file_digest
from pathlib import Path

from .splits import SealedReference, valid_sha


def _artifact_pin(path: Path, expected: str) -> dict[str, str]:
    if not valid_sha(expected):
        raise ValueError(f"invalid artifact SHA-256 for {path}")
    with path.open("rb") as source:
        digest = file_digest(source, "sha256").hexdigest()
    if digest != expected:
        raise ValueError(f"artifact SHA-256 mismatch for {path}")
    return {"path": str(path.resolve()), "sha256": expected}


def _gate_rule(
    extra_rule: Mapping[str, object] | None, ece_bins: int, max_ece: float | None, *, router: bool,
) -> dict[str, object]:
    if type(ece_bins) is not int or ece_bins < 1:
        raise ValueError("ece_bins must be a positive integer")
    classifier: dict[str, object] = {"ece_bins": ece_bins}
    if max_ece is not None:
        if type(max_ece) not in {int, float} or not 0 <= max_ece <= 1:
            raise ValueError("max_ece must be between zero and one")
        classifier["max_ece"] = max_ece
    rule: dict[str, object] = {"test": {"name": "mcnemar_exact", "alpha": 0.05}, "classifier": classifier}
    if router:
        classifier.update(router=True, max_wrong_confidence=0.8)
        rule["minimum_counts"] = {"overall": 150}

    permitted = {
        "minimum_counts", "minimum_passes", "minimum_pass_rate", "minimum_wilson_lower", "no_zero_pass_categories",
    }
    for key, value in (extra_rule or {}).items():
        if key not in permitted:
            raise ValueError(f"unsupported additional gate rule: {key}")
        if key == "no_zero_pass_categories":
            if type(value) is not bool:
                raise ValueError(f"{key} requires a boolean")
            rule[key] = value
            continue
        if not isinstance(value, dict) or not value or value.keys() - {"overall", "languages", "categories"}:
            raise ValueError(f"invalid gate threshold scopes for {key}")
        groups: list[object] = []
        if "overall" in value:
            groups.append(value["overall"])
        for scope in ("languages", "categories"):
            if scope in value:
                scoped = value[scope]
                if (
                    not isinstance(scoped, dict) or not scoped
                    or not all(isinstance(name, str) and name.strip() for name in scoped)
                ):
                    raise ValueError(f"{key}.{scope} requires named groups")
                groups.extend(scoped.values())
        for threshold in groups:
            if key == "minimum_counts":
                valid = type(threshold) is int and threshold > 0
            elif key == "minimum_passes":
                valid = type(threshold) is int and threshold >= 0
            else:
                valid = (type(threshold) is int or type(threshold) is float) and 0 <= threshold <= 1
            if not valid:
                raise ValueError(f"invalid gate threshold for {key}")
        defaults = rule.get(key, {})
        if isinstance(defaults, dict) and "overall" in defaults and value.get("overall", defaults["overall"]) < (
            defaults["overall"]
        ):
            raise ValueError(f"cannot weaken router {key}.overall")
        rule[key] = {**defaults, **value} if isinstance(defaults, dict) else value
    return rule


def write_gate_packet(
    output: Path, *, head: str, sealed: SealedReference, candidate: Path, candidate_sha256: str,
    baseline: Path, baseline_sha256: str, extra_rule: Mapping[str, object] | None = None,
    command: Sequence[str] = (), ece_bins: int = 15, max_ece: float | None = None,
    evaluation: Mapping[str, object] | None = None, router: bool | None = None,
) -> Path:
    """Pin artifacts and the provided case digest without reading or running the sealed set."""
    if not head.strip() or not valid_sha(sealed.sha256):
        raise ValueError("gate packet requires a head and sealed case SHA-256")
    if candidate_sha256 == baseline_sha256:
        raise ValueError("candidate and rules baseline must have distinct fingerprints")
    if sealed.path in {candidate.absolute(), candidate.resolve(), baseline.absolute(), baseline.resolve()}:
        raise ValueError("sealed case and model artifact paths must be separate")
    if router is None:
        router = head.casefold() in {"h1", "router"}
    rule = _gate_rule(extra_rule, ece_bins, max_ece, router=router)
    candidate_pin = _artifact_pin(candidate, candidate_sha256)
    baseline_pin = _artifact_pin(baseline, baseline_sha256)
    registration = {
        "schema_version": 1,
        "gate_id": f"head-{head}-{candidate_sha256[:12]}",
        "question": f"Does the {head} candidate meet the registered criteria against the rules?",
        "adapter": "classifier",
        "cases": {"path": str(sealed.path), "sha256": sealed.sha256, "sealed": True, "allow_reuse": False},
        "candidate": candidate_pin,
        "baseline": baseline_pin,
        "generation": None,
        "judging": {"judges": 0, "aggregation": "automatic", "shuffle_seed": 21, "identity_terms": []},
        "rule": rule,
    }
    handoff = {
        "schema_version": 1,
        "head": head,
        "created_at": datetime.now(UTC).isoformat(),
        "command": list(command),
        "evaluation": dict(evaluation or {}),
        "sealed_review": {
            "reviewer": sealed.reviewer,
            "review_kind": sealed.review_kind,
            "reviewed_at": sealed.reviewed_at,
            "receipt_sha256": sealed.receipt_sha256,
        },
        "evaluator_contract": {
            "gate_runner_pull_request": 16,
            "case_fields": ["id", "language", "category", "label"],
            "candidate_prediction_path": "predictions.jsonl",
            "candidate_prediction_fields": ["id", "label", "confidence"],
            "baseline_prediction_path": "baseline.jsonl",
            "baseline_prediction_fields": ["id", "label"],
            "producer_provenance_fields": ["command", "settings"],
            "producer_provenance_settings": None,
        },
    }
    output.mkdir(mode=0o700)
    registration_path = output / "registration.json"
    for path, document in ((output / "handoff.json", handoff), (registration_path, registration)):
        with path.open("x", encoding="utf-8", newline="\n") as destination:
            json.dump(document, destination, indent=2, ensure_ascii=False, allow_nan=False)
            destination.write("\n")
    return registration_path
