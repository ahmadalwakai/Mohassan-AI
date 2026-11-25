"""Record the PR #15 reviewed corpus pins through its documented verifier."""

from __future__ import annotations

import json
import subprocess
import sys
from hashlib import file_digest, sha256
from pathlib import Path


def _digest(path: Path) -> str:
    with path.open("rb") as source:
        return file_digest(source, "sha256").hexdigest()


def verify_corpus_lineage(checkout: Path, manifest: Path, review: Path) -> dict[str, object]:
    """Verify an optional source-corpus dependency in the owner's PR #15 checkout."""
    package = checkout.resolve() / "packages" / "corpus-pipeline"
    manifest, review = manifest.resolve(), review.resolve()
    raw_manifest = manifest.read_bytes()
    manifest_sha256, review_sha256 = sha256(raw_manifest).hexdigest(), _digest(review)
    command = [
        sys.executable, "-X", "utf8", "-m", "corpus_pipeline", "verify",
        "--manifest", str(manifest), "--review", str(review),
    ]
    result = subprocess.run(command, cwd=package, check=True, capture_output=True, encoding="utf-8")
    train = manifest.parent / "train.jsonl"
    if Path(result.stdout.strip()) != train:
        raise ValueError("corpus verifier did not identify the manifest's train shard")
    if (_digest(manifest), _digest(review)) != (manifest_sha256, review_sha256):
        raise ValueError("corpus manifest or review changed during verification")
    train_sha256 = _digest(train)
    shards = json.loads(raw_manifest)["shards"]
    if not any(entry["path"] == train.name and entry["sha256"] == train_sha256 for entry in shards):
        raise ValueError("corpus train shard changed during verification")
    return {
        "command": command,
        "working_directory": str(package),
        "manifest": {"path": str(manifest), "sha256": manifest_sha256},
        "review": {"path": str(review), "sha256": review_sha256},
        "train_shard": {"path": str(train), "sha256": train_sha256},
    }
