"""Local evidence resolution and source authorization; never fetches network evidence."""
from __future__ import annotations

from dataclasses import asdict, dataclass, fields
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Protocol

from .common import atomic_json, digest, read_json
from .errors import TrainingError
from .schemas import TrainingExample, boolean, enumeration, identity, sha256, strict_keys, strings, text


@dataclass(frozen=True)
class EvidenceRecord:
    subject_sha256: str
    expected_output_sha256: str
    passed: bool
    independent: bool
    method: str
    verifier_id: str
    artifact_sha256: str
    checks: tuple[str, ...]
    scope: str

    @classmethod
    def from_dict(cls, raw: Any) -> "EvidenceRecord":
        data = strict_keys(raw, {f.name for f in fields(cls)})
        for key in ("subject_sha256", "expected_output_sha256", "artifact_sha256"):
            sha256(data[key], key)
        boolean(data["passed"], "passed")
        boolean(data["independent"], "independent")
        identity(data["method"], "method")
        identity(data["verifier_id"], "verifier_id")
        enumeration(data["scope"], {"training", "validation", "test"}, "evidence.scope")
        return cls(**{**data, "checks": strings(data["checks"], "checks", nonempty=True)})


class EvidenceResolver(Protocol):
    """Trusted host implementation; may resolve only independently collected local evidence.

    Do not implement this by copying verdicts from a submitted example. The resolver,
    verification harness and directory permissions are part of the trust boundary.
    """
    def resolve(self, reference: str) -> EvidenceRecord | None: ...


class LocalEvidenceStore:
    """Content-addressed immutable receipts in an explicitly selected trusted directory.

    A digest establishes integrity, not authenticity. Only the trusted verifier may
    write this directory. Training input must never control the store location.
    """
    def __init__(self, root: Path):
        self.root = Path(root).resolve()

    def put(self, record: EvidenceRecord) -> str:
        record = EvidenceRecord.from_dict(asdict(record))
        if not self._artifact_valid(record.artifact_sha256):
            raise TrainingError("MISSING_VERIFICATION_ARTIFACT", "Receipt requires an existing integrity-checked local artifact.")
        payload = asdict(record)
        receipt_hash = digest(payload)
        atomic_json(self.root / (receipt_hash + ".json"), payload, immutable=True)
        return "local-evidence:" + receipt_hash

    def put_artifact(self, artifact: Any) -> str:
        """Trusted verifier explicitly persists its actual result, never a model verdict."""
        artifact_hash = digest(artifact)
        atomic_json(self.root / "artifacts" / (artifact_hash + ".json"), artifact, immutable=True)
        return artifact_hash

    def _artifact_valid(self, artifact_hash: str) -> bool:
        path = self.root / "artifacts" / (artifact_hash + ".json")
        return path.is_file() and not path.is_symlink() and digest(read_json(path)) == artifact_hash

    def resolve(self, reference: str) -> EvidenceRecord | None:
        if not reference.startswith("local-evidence:"):
            return None
        receipt_hash = reference.removeprefix("local-evidence:")
        sha256(receipt_hash, "evidence_reference")
        path = self.root / (receipt_hash + ".json")
        if not path.is_file() or path.is_symlink():
            return None
        payload = read_json(path)
        if digest(payload) != receipt_hash:
            raise TrainingError("CORRUPT_EVIDENCE", "Local evidence digest does not match its reference.")
        record = EvidenceRecord.from_dict(payload)
        if not self._artifact_valid(record.artifact_sha256):
            raise TrainingError("CORRUPT_EVIDENCE", "Evidence artifact is absent or its digest changed.")
        return record


def authorization_issues(example: TrainingExample, *, intended_use: str = "training", now: datetime | None = None) -> tuple[str, ...]:
    authorization = example.authorization
    issues: list[str] = []
    if intended_use not in authorization.permitted_uses or not authorization.rights_verified:
        issues.append("UNAUTHORIZED_DATA")
    if authorization.expires_at is not None:
        expires = datetime.fromisoformat(authorization.expires_at.replace("Z", "+00:00"))
        if expires <= (now or datetime.now(timezone.utc)):
            issues.append("AUTHORIZATION_EXPIRED")
    if authorization.privacy_classification == "private_customer" or example.source.contains_customer_data:
        issues.append("CUSTOMER_DATA_EXCLUDED")
    if authorization.privacy_classification in {"uncertain", "approved_non_customer"} and not authorization.privacy_approval_reference:
        issues.append("PRIVACY_APPROVAL_REQUIRED")
    if example.provenance.evaluation_origin and intended_use == "training":
        issues.append("EVALUATION_DATA_EXCLUDED")
    source = example.source
    if source.review_status == "rejected":
        issues.append("REVIEW_REJECTED")
    if source.kind == "human_reviewed":
        if source.review_status != "approved" or not source.reviewer_id or not source.review_reference:
            issues.append("HUMAN_REVIEW_REQUIRED")
    elif source.kind == "teacher_generated":
        if not source.teacher_model:
            issues.append("TEACHER_SOURCE_REQUIRED")
        if source.teacher_model == example.verification.verifier_id:
            issues.append("INDEPENDENT_VERIFIER_REQUIRED")
        if authorization.privacy_classification not in {"synthetic", "public", "approved_non_customer"}:
            issues.append("TEACHER_PRIVACY_UNCERTAIN")
    elif source.kind == "synthetic":
        if not source.generator_id or authorization.privacy_classification != "synthetic":
            issues.append("SYNTHETIC_PROVENANCE_REQUIRED")
    return tuple(issues)
