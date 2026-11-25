"""Apply the capability v2 exclusion registry to an official CANARD train or dev split."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import sys


SPLIT_SHA256 = {
    "train": "5877563d4258cf40d660cf2ff65935bf1d15573c7cd98e717ca86a0a6d457ed5",
    "dev": "fafd9f53be0684fd33f85f6bf12a63e61b835ecb9e987c9bd2186149366ce2e5",
}
AUDIT_MODULE = Path("scripts/agent-capability-bench/v2")
AUDIT_MANIFEST = Path("tests/fixtures/agent-capability-bench/v2/exclusion/manifest.json")


def screen_split(path: Path, split: str, exclusions) -> tuple[int, list[dict]]:
    data = path.read_bytes()
    if hashlib.sha256(data).hexdigest() != SPLIT_SHA256[split]:
        raise SystemExit(f"Expected the original CANARD {split}.json member from the official release.")
    rows = json.loads(data)
    retained = []
    for row in rows:
        source_id = f"canard:{row['QuAC_dialog_id']}:{row['Question_no']}"
        reference = row["Rewrite"]
        without_ending_punctuation = re.sub(r"[.!?؟]+$", "", reference.strip()).rstrip()
        texts = (row["Question"], *row["History"], reference, without_ending_punctuation)
        if not exclusions.matches(texts, source_id=source_id):
            retained.append(row)
    return len(rows), retained


def clean_training(train: list[dict], dev: list[dict], normalize_text) -> tuple[list[dict], dict]:
    def input_key(row: dict) -> tuple[str, ...]:
        return tuple(normalize_text(text) for text in (*row["History"], row["Question"]))

    dev_inputs = {input_key(row) for row in dev}
    seen = set()
    kept = []
    duplicates = 0
    dev_overlap = 0
    for row in train:
        key = input_key(row)
        if key in seen:
            duplicates += 1
            continue
        seen.add(key)
        if key in dev_inputs:
            dev_overlap += 1
            continue
        kept.append(row)
    return kept, {"deduplicated": duplicates, "devOverlap": dev_overlap}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--split", choices=SPLIT_SHA256, required=True, help="Original CANARD split")
    parser.add_argument("--input", type=Path, required=True, help="Official CANARD train.json or dev.json")
    parser.add_argument("--dev-input", type=Path, help="Official CANARD dev.json for post-exclusion training cleanup")
    parser.add_argument("--audit-root", type=Path, required=True, help="Local v2 contamination audit checkout")
    parser.add_argument("--output", type=Path, required=True, help="New filtered JSON file outside the feature checkout")
    args = parser.parse_args()
    if args.dev_input and args.split != "train":
        parser.error("--dev-input can only be used with --split train")

    sys.path.insert(0, str(args.audit_root.resolve() / AUDIT_MODULE))
    from exclusion import Exclusions, normalize_text

    manifest = args.audit_root / AUDIT_MANIFEST
    exclusions = Exclusions.load(manifest)
    input_count, retained = screen_split(args.input, args.split, exclusions)
    excluded = input_count - len(retained)
    cleanup = {}
    if args.dev_input:
        _, dev = screen_split(args.dev_input, "dev", exclusions)
        retained, cleanup = clean_training(retained, dev, normalize_text)

    receipt = {
        "split": args.split,
        "sourceSha256": SPLIT_SHA256[args.split],
        "exclusionManifestSha256": hashlib.sha256(manifest.read_bytes()).hexdigest(),
        "input": input_count,
        "dropped": input_count - len(retained),
        "excluded": excluded,
        "retained": len(retained),
        **cleanup,
    }
    with args.output.open("x", encoding="utf-8") as output:
        json.dump({"receipt": receipt, "rows": retained}, output, ensure_ascii=False)
    print(json.dumps(receipt, sort_keys=True))


if __name__ == "__main__":
    main()
