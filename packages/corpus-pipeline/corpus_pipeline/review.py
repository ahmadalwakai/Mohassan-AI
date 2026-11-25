"""Verify the reviewed corpus and its artifacts before a training handoff."""

from datetime import datetime
from hashlib import sha256
from pathlib import Path

from .inputs import SPLITS, load_object, require_keys, require_pin, require_string
from .pipeline import AUDIT_NAMES, SCHEMA_VERSION


def verify_review(manifest_path: Path, review_path: Path) -> Path:
    manifest_path = manifest_path.resolve()
    data = manifest_path.read_bytes()
    review = load_object(review_path.read_bytes(), str(review_path))
    require_keys(review, {"manifest_sha256", "reviewer", "reviewed_at", "decision"}, "review")
    if review.get("decision") != "approved":
        raise ValueError("review decision must be approved")
    require_string(review.get("reviewer"), "review.reviewer")
    reviewed_at = datetime.fromisoformat(require_string(review.get("reviewed_at"), "review.reviewed_at"))
    if reviewed_at.utcoffset() is None:
        raise ValueError("review.reviewed_at must include a time zone")
    if sha256(data).hexdigest() != require_pin(review.get("manifest_sha256"), "review.manifest_sha256"):
        raise ValueError("review SHA-256 does not match the manifest")

    manifest = load_object(data, str(manifest_path))
    if manifest.get("schema_version") != SCHEMA_VERSION or manifest.get("fixture_mode") is not False:
        raise ValueError("verification requires a supported production manifest; fixture runs are ineligible")
    for field in ("inputs", "filter_versions", "parameters", "code_sha256", "counts"):
        if not isinstance(manifest.get(field), dict) or not manifest[field]:
            raise ValueError(f"manifest is missing policy evidence: {field}")
    shards = manifest.get("shards")
    audits = manifest.get("audits")
    if not isinstance(shards, list) or not isinstance(audits, list):
        raise ValueError("manifest requires shard and audit fingerprints")
    expected = {f"{split}.jsonl": split for split in SPLITS}
    expected.update(dict.fromkeys(AUDIT_NAMES))
    root = manifest_path.parent
    for entry in [*shards, *audits]:
        if not isinstance(entry, dict):
            raise ValueError("invalid manifest artifact")
        name = require_string(entry.get("path"), "artifact path")
        if name not in expected or entry.get("split") != expected[name]:
            raise ValueError(f"unexpected manifest artifact: {name}")
        records = entry.get("records")
        size = entry.get("bytes")
        if type(records) is not int or records < 0 or type(size) is not int or size < 0:
            raise ValueError(f"missing or invalid {name} counts")
        if expected.pop(name) is not None and records == 0:
            raise ValueError(f"cannot approve empty split: {name}")
        artifact = root / name
        if not artifact.is_file() or artifact.is_symlink():
            raise ValueError(f"missing or invalid artifact: {name}")
        digest = sha256()
        actual_size = actual_records = 0
        with artifact.open("rb") as stream:
            for line in stream:
                digest.update(line)
                actual_size += len(line)
                actual_records += bool(line.strip())
        if (digest.hexdigest(), actual_size, actual_records) != (
            require_pin(entry.get("sha256"), name), size, records,
        ):
            raise ValueError(f"artifact fingerprint mismatch: {name}")
    if expected:
        raise ValueError(f"missing manifest artifacts: {', '.join(expected)}")
    return root / "train.jsonl"
