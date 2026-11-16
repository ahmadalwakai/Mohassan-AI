"""Create a reproducible development mixture without modifying its source datasets."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read(path):
    with path.open(encoding="utf-8-sig") as stream:
        return [json.loads(line) for line in stream if line.strip()]


def key(row):
    return hashlib.sha256(" ".join(row["input"]["message"].casefold().split()).encode()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("base", "supplement", "out"):
        parser.add_argument(f"--{name}", required=True, type=Path)
    parser.add_argument("--base-per-language", type=int, default=60000)
    parser.add_argument("--seed", type=int, default=37)
    args = parser.parse_args()
    if args.out.exists() or args.base_per_language <= 0:
        raise ValueError("Use a new output directory and positive count")
    inputs, selected = {}, {}
    for split in ("train", "validation"):
        base, supplement = read(args.base / f"{split}.jsonl"), read(args.supplement / f"{split}.jsonl")
        if any(row.get("trainingAllowed") is False or row.get("split") != split for row in base + supplement):
            raise ValueError("Only development split rows may be mixed")
        if split == "train":
            base = [row for language in ("ar", "en") for row in sorted(
                (item for item in base if item["language"] == language),
                key=lambda item: hashlib.sha256(f"{args.seed}:{item['id']}".encode()).hexdigest())[:args.base_per_language]]
        selected[split] = base + supplement
        if len({key(row) for row in selected[split]}) != len(selected[split]):
            raise ValueError(f"Duplicate messages within {split}")
        inputs[split] = {"base": str(args.base / f"{split}.jsonl"), "baseSha256": digest(args.base / f"{split}.jsonl"),
                         "supplement": str(args.supplement / f"{split}.jsonl"), "supplementSha256": digest(args.supplement / f"{split}.jsonl")}
    fingerprints = {split: {key(row) for row in values} for split, values in selected.items()}
    if fingerprints["train"] & fingerprints["validation"]:
        raise ValueError("Training/validation overlap")
    separation = {"train_validation": 0}
    root = Path(__file__).resolve().parents[1]
    for path in sorted((root / "artifacts/ads-training").glob("independent-*/goal_independent.jsonl")):
        excluded = {key(row) for row in read(path)}
        for split in selected:
            separation[f"{path.parent.name}_{split}"] = len(excluded & fingerprints[split])
    if any(separation.values()):
        raise ValueError("Independent test overlap")
    args.out.mkdir(parents=True)
    files = {}
    for split, values in selected.items():
        path = args.out / f"{split}.jsonl"
        with path.open("x", encoding="utf-8", newline="\n") as stream:
            for row in values:
                stream.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
        files[split] = {"rows": len(values), "languages": dict(Counter(row["language"] for row in values)), "sha256": digest(path)}
    manifest = {"method": "Deterministic base replay with complete new supplement", "seed": args.seed,
                "basePerLanguage": args.base_per_language, "inputs": inputs, "files": files,
                "separation": separation, "independentUsage": "Message hash exclusion only; no test labels used",
                "preparationScriptSha256": digest(Path(__file__)), "trainingUsesFinalAssessment": False}
    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"out": str(args.out), "files": files, "separation": separation}))


if __name__ == "__main__":
    main()
