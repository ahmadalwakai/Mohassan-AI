"""Exclude ancestral training messages from a new calibration copy; preserve originals."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import shutil


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def message_key(row):
    return hashlib.sha256(" ".join(row["input"]["message"].casefold().split()).encode()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--models", type=Path, nargs="+", required=True)
    args = parser.parse_args()
    if args.out.exists():
        raise ValueError("Refusing to reuse output")
    trained, sources, visited = set(), {}, set()

    def visit(directory):
        directory = directory.resolve()
        if directory in visited:
            return
        visited.add(directory)
        report = json.loads((directory / "report.json").read_text(encoding="utf-8-sig"))
        path = Path(report["dataDirectory"]) / "train.jsonl"
        if sha(path) != report["data"]["train"]["sha256"]:
            raise ValueError("Ancestral training data changed")
        if str(path) not in sources:
            with path.open(encoding="utf-8-sig") as stream:
                trained.update(message_key(json.loads(line)) for line in stream if line.strip())
            sources[str(path)] = sha(path)
        if report.get("initializationSource"):
            visit(Path(report["initializationSource"]["directory"]))

    for model in args.models:
        visit(model)
    kept, removed = [], Counter()
    for line in (args.data / "validation.jsonl").read_bytes().splitlines(keepends=True):
        if not line.strip():
            continue
        row = json.loads(line)
        if message_key(row) in trained:
            removed[row["language"]] += 1
        else:
            kept.append(line)
    args.out.mkdir(parents=True)
    shutil.copyfile(args.data / "train.jsonl", args.out / "train.jsonl")
    (args.out / "validation.jsonl").write_bytes(b"".join(kept))
    report = {"purpose": "Calibration and final development selection only", "source": str(args.data.resolve()),
              "trainingFileUnchanged": True, "originalValidationSha256": sha(args.data / "validation.jsonl"),
              "rows": len(kept), "removedAncestralTrainingOverlaps": dict(removed), "ancestralTraining": sources,
              "files": {split: sha(args.out / f"{split}.jsonl") for split in ("train", "validation")},
              "retainedLinesUnchanged": True, "independentTestAccessed": False, "preparationScriptSha256": sha(Path(__file__))}
    (args.out / "manifest.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report))


if __name__ == "__main__":
    main()
