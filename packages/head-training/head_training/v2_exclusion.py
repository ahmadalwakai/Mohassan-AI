"""Require the published capability v2 exclusion registry at the loader boundary."""

from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from shutil import copyfile
from tempfile import TemporaryDirectory

from exclusion import PARTITIONS, Exclusions

from . import REPOSITORY_ROOT

MANIFEST_PATH = REPOSITORY_ROOT / "tests/fixtures/agent-capability-bench/v2/exclusion/manifest.json"
# PR #70, a1e1cb020b7ba093885edbf501149e7b8252c0cb. The manifest pins both registries.
MANIFEST_SHA256 = "de192bdc7203e1aa24fa06b216d3976f4ea77ec103e085a4019af7a60c2f3054"


@dataclass(frozen=True)
class ExclusionReceipt:
    manifest_sha256: str
    input_rows: int
    dropped_rows: int


def load_registry() -> Exclusions:
    """Verify the release pin and both partitions before admitting loader rows."""
    path = MANIFEST_PATH
    manifest = path.read_bytes()
    if sha256(manifest).hexdigest() != MANIFEST_SHA256:
        raise ValueError("Capability v2 exclusion manifest SHA-256 mismatch.")
    # The published reader opens its own files. Give it a private copy so it
    # reads the exact manifest bytes checked above, even if a checkout changes.
    with TemporaryDirectory(prefix="mohassan-v2-exclusion-") as directory:
        verified_manifest = Path(directory) / path.name
        verified_manifest.write_bytes(manifest)
        for partition in PARTITIONS:
            name = f"{partition}.jsonl"
            copyfile(path.with_name(name), verified_manifest.with_name(name))
        return Exclusions.load(verified_manifest)
