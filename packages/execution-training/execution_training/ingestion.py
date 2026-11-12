"""Explicit-file ingestion only; no directory crawling, database queries or API calls."""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
from pathlib import Path
from typing import Any, Iterable, Iterator

from .common import atomic_json, digest
from .errors import TrainingError
from .privacy import PrivacyPolicy
from .provenance import EvidenceResolver
from .schemas import TrainingExample
from .validation import ValidationResult, parse_json, validate_example


@dataclass(frozen=True)
class IngestionResult:
    example: TrainingExample | None
    validation: ValidationResult
    audit_reference: str


class IngestionPipeline:
    """Only accepted samples are returned. Rejected/quarantined bodies are not written.

    A quarantine receipt retains digest, rule codes and operator-review status, not
    secrets or personal data. Keep original inputs in an explicitly authorized
    access-controlled source; re-submit a corrected/reviewed sample for fresh checks.
    """
    def __init__(self, evidence_resolver: EvidenceResolver, audit_directory: Path, *,
                 privacy_policy: PrivacyPolicy | None = None, intended_use: str = "training"):
        self.evidence_resolver = evidence_resolver
        self.audit_directory = Path(audit_directory)
        self.privacy_policy = privacy_policy or PrivacyPolicy()
        self.intended_use = intended_use

    def ingest(self, raw: Any, *, expected_kind: str | None = None) -> IngestionResult:
        example = None
        try:
            raw_hash = digest(raw)
        except (TypeError, ValueError, TrainingError, RecursionError, UnicodeError):
            # No untrusted object repr or exception text is logged.
            raw_hash = hashlib.sha256(b"non-json-submission").hexdigest()
        try:
            example = TrainingExample.from_dict(raw)
            if expected_kind is not None and example.source.kind != expected_kind:
                raise TrainingError("SOURCE_KIND_MISMATCH", "Wrong source adapter for submitted sample.")
            result = validate_example(example, self.evidence_resolver, self.privacy_policy, intended_use=self.intended_use)
        except (TrainingError, TypeError, ValueError) as error:
            code = error.code if isinstance(error, TrainingError) else "INVALID_SCHEMA"
            result = ValidationResult("rejected", (code,), "unparsed", raw_hash)
        record = {
            "schema_version": "ingestion-audit-v1", "submission_sha256": raw_hash,
            "status": result.status, "codes": list(result.codes),
            "subject_sha256": result.subject_sha256, "privacy_policy_sha256": self.privacy_policy.identity(),
            "evidence_sha256": result.evidence_sha256, "intended_use": self.intended_use,
            "review_required": result.status == "quarantined", "raw_content_retained": False,
        }
        # Content-addressed receipts make repeats idempotent; timestamps live in a separate event.
        receipt_hash = digest(record)
        receipt_path = self.audit_directory / result.status / (receipt_hash + ".json")
        atomic_json(receipt_path, record, immutable=True)
        return IngestionResult(example if result.accepted else None, result, str(receipt_path))

    def ingest_many(self, rows: Iterable[Any], *, expected_kind: str | None = None) -> Iterator[IngestionResult]:
        for row in rows:
            yield self.ingest(row, expected_kind=expected_kind)

    def load_jsonl(self, path: Path, *, expected_kind: str | None = None, maximum_bytes: int = 64 * 1024 * 1024,
                   maximum_line_bytes: int = 2 * 1024 * 1024) -> Iterator[IngestionResult]:
        """Caller selects one JSONL export; symlinks, hidden env files and dumps rejected."""
        path = Path(path)
        name = path.name.lower()
        if path.is_symlink() or path.suffix.lower() != ".jsonl" or name.startswith(".env") or any(term in name for term in ("production", "customer", "dump")):
            raise TrainingError("UNSAFE_SOURCE_FILE", "Only explicitly prepared JSONL exports are accepted.")
        if not path.is_file() or path.stat().st_size > maximum_bytes:
            raise TrainingError("INVALID_SOURCE_FILE", "Input is absent or exceeds the configured size limit.")
        consumed = 0
        with path.open("rb") as handle:
            while True:
                line = handle.readline(maximum_line_bytes + 1)
                if not line:
                    break
                consumed += len(line)
                if len(line) > maximum_line_bytes or consumed > maximum_bytes:
                    raise TrainingError("SOURCE_SIZE_LIMIT", "Input exceeds the bounded export size.")
                if not line.strip():
                    raise TrainingError("INVALID_DATASET", "Blank JSONL rows are not silently ignored.")
                try:
                    row = parse_json(line.decode("utf-8"))
                except (ValueError, UnicodeError):
                    row_hash = hashlib.sha256(line).hexdigest()
                    record = {"schema_version": "ingestion-audit-v1", "submission_sha256": row_hash,
                        "status": "rejected", "codes": ["MALFORMED_JSON"], "raw_content_retained": False}
                    receipt = self.audit_directory / "rejected" / (digest(record) + ".json")
                    atomic_json(receipt, record, immutable=True)
                    yield IngestionResult(None, ValidationResult("rejected", ("MALFORMED_JSON",), "unparsed", row_hash), str(receipt))
                    continue
                yield self.ingest(row, expected_kind=expected_kind)


class HumanReviewedAdapter:
    def __init__(self, pipeline: IngestionPipeline):
        self.pipeline = pipeline

    def ingest(self, raw: Any) -> IngestionResult:
        return self.pipeline.ingest(raw, expected_kind="human_reviewed")


class TeacherGeneratedAdapter:
    """Consumes supplied exports; never calls a teacher or assumes its answer correct."""
    def __init__(self, pipeline: IngestionPipeline):
        self.pipeline = pipeline

    def ingest(self, raw: Any) -> IngestionResult:
        return self.pipeline.ingest(raw, expected_kind="teacher_generated")


class SyntheticAdapter:
    def __init__(self, pipeline: IngestionPipeline):
        self.pipeline = pipeline

    def ingest(self, raw: Any) -> IngestionResult:
        return self.pipeline.ingest(raw, expected_kind="synthetic")
