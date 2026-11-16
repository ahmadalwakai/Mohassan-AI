"""Remove known contradictory missing-detail training rows; copy validation byte-for-byte.

python scripts/filter-goal-tagger-missing.py --data artifacts/ads-training/tagger-v2-clean \
  --out artifacts/ads-training/tagger-v2b-clean
This deliberately preserves the existing development comparison, including its imperfections.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def contradiction(row: dict[str, Any]) -> str | None:
    text = " ".join(re.sub("[أإآ]", "ا", row["input"]["message"].casefold()).replace("ً", "").split())
    output = row.get("expected", row.get("output"))
    if "i will provide the service and website later" in text and (output["service"] is not None or output["url"] is not None):
        return "service_url_claimed_missing_but_present"
    if ("i will send the website and budget later" in text or "سارسل رابط الموقع والميزانية لاحقا" in text) and (
            output["url"] is not None or output["budget"] is not None):
        return "url_budget_claimed_missing_but_present"
    return None


def filter_dataset(data: Path, out: Path) -> dict[str, Any]:
    if out.exists():
        raise ValueError(f"Refusing to overwrite existing dataset: {out}")
    source_train = (data / "train.jsonl").read_bytes()
    source_validation = (data / "validation.jsonl").read_bytes()
    kept: list[bytes] = []
    removed: Counter[str] = Counter()
    removed_by_language: Counter[str] = Counter()
    languages: Counter[str] = Counter()
    families: Counter[str] = Counter()
    for line in source_train.splitlines(keepends=True):
        if not line.strip():
            continue
        row = json.loads(line)
        reason = contradiction(row)
        if reason:
            removed[reason] += 1
            removed_by_language[row["language"]] += 1
            continue
        kept.append(line)
        languages[row["language"]] += 1
        families[row["family"]] += 1
    training = b"".join(kept)
    source_manifest = (data / "manifest.json").read_bytes()
    previous = json.loads(source_manifest)
    manifest = {"version": "goal-grammar-v2b-clean", "createdAt": datetime.now(timezone.utc).isoformat(),
                "sourceDirectory": str(data).replace("\\", "/"), "sourceManifestSha256": sha(source_manifest),
                "files": {
                    "train": {"rows": len(kept), "sha256": sha(training), "sourceSha256": sha(source_train),
                              "sourceRows": len(kept) + sum(removed.values()), "languages": dict(languages), "families": dict(families),
                              "removed": dict(removed), "removedByLanguage": dict(removed_by_language)},
                    "validation": {**previous["files"]["validation"], "sha256": sha(source_validation), "sourceSha256": sha(source_validation),
                                   "sourceRows": previous["files"]["validation"]["rows"], "removed": {}, "byteIdenticalToSource": True}},
                "exclusions": previous.get("exclusions", []), "canonicalization": previous.get("canonicalization"),
                "retainedLinesUnmodified": True, "validationChanged": False, "trainingUsesFinalAssessment": False,
                "independentFilesRead": False,
                "change": "Only training rows contradicting one of three explicit combined-missing statements were removed."}
    out.mkdir(parents=True)
    (out / "train.jsonl").write_bytes(training)
    (out / "validation.jsonl").write_bytes(source_validation)
    (out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    manifest = filter_dataset(args.data, args.out)
    print(json.dumps({"out": str(args.out), "files": {name: {key: value for key, value in info.items() if key != "families"}
                                                     for name, info in manifest["files"].items()}}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
