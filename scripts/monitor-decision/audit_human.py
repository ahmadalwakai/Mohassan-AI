#!/usr/bin/env python3
"""Run the offline monitor false-positive audit on guarded native human test splits."""

import argparse
import hashlib
import json
import subprocess
import sys
from dataclasses import asdict
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRATCH = ROOT / "packages/scratch-classifiers"
sys.path.insert(0, str(SCRATCH))
from data_guard import REGISTRY_SHA256, ContaminationGuard
from monitor_corpora import pins, rows


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, required=True, help="Directory of pinned source archives downloaded during setup")
    parser.add_argument("--output", type=Path, required=True, help="Write an aggregate receipt with source IDs for monitor signals")
    args = parser.parse_args()
    guard = ContaminationGuard.load()
    data = "".join(json.dumps(asdict(row), ensure_ascii=False) + "\n" for row in rows(args.cache, guard, {"test"}))
    run = subprocess.run(
        ["node", "--import", "tsx", "scripts/monitor-decision/audit-human.ts"], cwd=ROOT,
        input=data, encoding="utf-8", stdout=subprocess.PIPE, check=True,
    )
    result = json.loads(run.stdout)
    audited_paths = (
        Path(__file__).relative_to(ROOT),
        "scripts/monitor-decision/audit-human.ts",
        "packages/scratch-classifiers/data_guard.py",
        "packages/scratch-classifiers/monitor_corpora.py",
        "apps/server/src/assistant/response-policy.ts",
        "apps/server/src/monitors/detection.ts",
        "apps/server/src/monitors/v2-chat-intents.ts",
        "apps/server/src/monitors/decision/frame.ts",
        "apps/server/src/monitors/decision/reasoner.ts",
        "apps/server/src/monitors/decision/signals.ts",
    )
    receipt = {
        "schemaVersion": 1,
        "partitions": ["test", "oos_test"],
        "sources": pins(),
        "exclusionManifestSha256": REGISTRY_SHA256,
        "rowsExcluded": {f"{dataset}/{partition}": count for (dataset, partition), count in sorted(guard.rejected.items())},
        "codeSha256": {str(path): digest(ROOT / path) for path in audited_paths},
        **result,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x", encoding="utf-8") as stream:
        json.dump(receipt, stream, indent=2, sort_keys=True)
        stream.write("\n")
    for dataset, groups in receipt["datasets"].items():
        counts = groups["total"]
        print(f"{dataset}: n={counts['cases']} detector-monitor={counts['detectorMonitor']} "
              f"reasoner-monitor={counts['reasonerMonitor']} reasoner-reminder={counts['reasonerReminder']}")
    timing = receipt["reasonerPerTurnMs"]
    print(f"reasoner p50={timing['p50']:.6f} ms p95={timing['p95']:.6f} ms n={timing['samples']}")
    print(f"reasoner clock-family monitor violations: {receipt['clockMonitorViolations']}/{receipt['clockCases']}")
    print(f"receipt: {args.output}")
    if receipt["clockMonitorViolations"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
