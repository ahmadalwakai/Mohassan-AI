"""Derive a clean goal dataset without modifying originals or inspecting held-out labels.

python scripts/filter-goal-tagger-data.py --data artifacts/ads-training/tagger-v2 \
  --out artifacts/ads-training/tagger-v2-clean --exclude-independent PATH [PATH ...]
The --message-keys protocol is used by the TypeScript generator for identical Unicode folding.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def message_key(message: str) -> str:
    return sha(" ".join(message.casefold().split()).encode("utf-8"))


def independent_keys(paths: list[Path]) -> tuple[set[str], list[dict[str, Any]]]:
    keys: set[str] = set()
    records = []
    for path in paths:
        # A directory explicitly identifies its goal test, never unrelated site labels.
        file = path / "goal_independent.jsonl" if path.is_dir() else path
        raw = file.read_bytes()
        file_keys = set()
        for line in raw.splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            message = row["input"]["message"]
            file_keys.add(message_key(message))
        keys.update(file_keys)
        records.append({"path": str(file).replace("\\", "/"), "sha256": sha(raw), "uniqueMessages": len(file_keys)})
    return keys, records


def canonical_label(value: Any) -> Any:
    if isinstance(value, str):
        return " ".join(value.casefold().split())
    if isinstance(value, list):
        return [canonical_label(item) for item in value]
    if isinstance(value, dict):
        return {name: canonical_label(item) for name, item in value.items()}
    return value


def filter_dataset(data: Path, out: Path, exclusions: list[Path]) -> dict[str, Any]:
    if out.exists():
        raise ValueError(f"Refusing to overwrite existing output: {out}")
    excluded, exclusion_records = independent_keys(exclusions)
    labels: dict[str, Any] = {}
    files: dict[str, Any] = {}
    buffers: dict[str, bytes] = {}
    for split in ("train", "validation"):
        source = data / f"{split}.jsonl"
        raw = source.read_bytes()
        kept = []
        seen: set[str] = set()
        removals: Counter[str] = Counter()
        languages: Counter[str] = Counter()
        families: Counter[str] = Counter()
        original_rows = 0
        for line_number, line in enumerate(raw.splitlines(keepends=True), 1):
            if not line.strip():
                continue
            original_rows += 1
            row = json.loads(line)
            key = message_key(row["input"]["message"])
            if key in excluded:
                removals["priorIndependent"] += 1
                continue
            label = canonical_label(row.get("expected", row.get("output")))
            if key in labels and labels[key] != label:
                raise ValueError(f"Conflicting canonical duplicate labels in {split} row {line_number}")
            if key in seen:
                removals["withinSplitDuplicate"] += 1
                continue
            if split == "validation" and key in labels:
                removals["trainOverlap"] += 1
                continue
            labels[key] = label
            seen.add(key)
            kept.append(line)
            languages[row.get("language", "unknown")] += 1
            families[row.get("family", "unknown")] += 1
        filtered = b"".join(kept)
        buffers[split] = filtered
        files[split] = {"rows": len(kept), "sha256": sha(filtered), "languages": dict(languages), "families": dict(families),
                        "sourceRows": original_rows, "sourceSha256": sha(raw), "removed": dict(removals)}
    source_manifest = data / "manifest.json"
    manifest = {"version": "goal-grammar-v2-clean", "createdAt": datetime.now(timezone.utc).isoformat(),
                "sourceDirectory": str(data).replace("\\", "/"), "sourceManifestSha256": sha(source_manifest.read_bytes()),
                "files": files, "exclusions": exclusion_records,
                "canonicalization": "sha256(UTF8(' '.join(message.casefold().split())))",
                "retainedLinesUnmodified": True, "trainingUsesFinalAssessment": False,
                "independentLabelsRead": False, "exclusionUse": "Input-message hashes only, for exclusion; no held-out row is added to any split."}
    out.mkdir(parents=True)
    for split, content in buffers.items():
        (out / f"{split}.jsonl").write_bytes(content)
    (out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--exclude-independent", type=Path, nargs="*", default=[])
    parser.add_argument("--message-keys", action="store_true")
    args = parser.parse_args()
    if args.message_keys:
        messages = json.loads(sys.stdin.buffer.read())
        excluded, records = independent_keys(args.exclude_independent)
        print(json.dumps({"keys": [message_key(message) for message in messages], "excluded": sorted(excluded), "exclusions": records}))
        return 0
    if args.data is None or args.out is None:
        parser.error("--data and --out are required")
    manifest = filter_dataset(args.data, args.out, args.exclude_independent)
    print(json.dumps({"out": str(args.out), "files": {name: {key: value for key, value in info.items() if key != "families"}
                                                     for name, info in manifest["files"].items()}}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
