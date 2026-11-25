"""Apply the pinned capability v2 exclusions before preparing training rows."""

import hashlib
import json
import sys
from collections import Counter
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts/agent-capability-bench/v2"))
from exclusion import DEFAULT_MANIFEST, Exclusions

REGISTRY_SHA256 = "de192bdc7203e1aa24fa06b216d3976f4ea77ec103e085a4019af7a60c2f3054"
RECEIPT_VERSION = 1


class ContaminationGuard:
    def __init__(self, exclusions: Exclusions):
        self.exclusions = exclusions
        self.rejected = Counter()

    @classmethod
    def load(cls, manifest: Path = DEFAULT_MANIFEST):
        if hashlib.sha256(manifest.read_bytes()).hexdigest() != REGISTRY_SHA256:
            raise ValueError("Capability v2 exclusion manifest SHA-256 mismatch.")
        return cls(Exclusions.load(manifest))

    def blocks(self, dataset: str, partition: str, texts: str | tuple[str, ...], source_id: str | None = None) -> bool:
        if not self.exclusions.matches(texts, source_id=source_id):
            return False
        self.rejected[dataset, partition] += 1
        return True

    def receipt(self, data_sha256: str, seed: int) -> dict:
        by_dataset = {}
        for (dataset, partition), count in sorted(self.rejected.items()):
            by_dataset.setdefault(dataset, {})[partition] = count
        return {
            "version": RECEIPT_VERSION,
            "manifestSha256": REGISTRY_SHA256,
            "dataSha256": data_sha256,
            "seed": seed,
            "droppedRows": {"total": self.rejected.total(), "byDatasetAndSourcePartition": by_dataset},
        }


def receipt_path(data: Path) -> Path:
    return data.with_name(f"{data.name}.exclusions.json")


def read_receipt(data: Path, data_sha256: str, seed: int) -> dict:
    ContaminationGuard.load()
    receipt = json.loads(receipt_path(data).read_bytes())
    if (receipt.get("version") != RECEIPT_VERSION or receipt.get("manifestSha256") != REGISTRY_SHA256
            or receipt.get("dataSha256") != data_sha256 or receipt.get("seed") != seed):
        raise ValueError("Prepared data receipt does not match the verified v2 exclusions, data, and seed.")
    return receipt
