"""Freeze a deterministic, v2-filtered slice of the public GSM8K train split."""

import argparse
from collections import Counter
from hashlib import sha256
import json
from pathlib import Path
import re
import sys

SOURCE_COMMIT = "3101c7d5072418e28b9008a6636bde82a006892c"
SOURCE_SHA256 = "17f347dc51477c50d4efb83959dbb7c56297aba886e5544ee2aaed3024813465"
SPLIT_SEED = b"mohassan-word-problem-holdout-v1\0"
FINAL_NUMBER = re.compile(r"####[ \t]+([-+]?[0-9,]+(?:\.[0-9]+)?)")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("benchmark", type=Path)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    benchmark = args.benchmark.resolve()
    sys.path.insert(0, str(benchmark / "scripts/agent-capability-bench/v2"))
    from exclusion import DEFAULT_MANIFEST, Exclusions, text_sha256

    exclusions = Exclusions.load()
    raw = args.source.read_bytes()
    source_digest = sha256(raw).hexdigest()
    if source_digest != SOURCE_SHA256:
        raise SystemExit("Unexpected pinned GSM8K train source checksum")
    counts = Counter(input=0, excluded=0, duplicate=0)
    accepted: dict[str, dict] = {}
    for line_number, line in enumerate(raw.splitlines(), 1):
        counts["input"] += 1
        row = json.loads(line)
        question, answer = row["question"], row["answer"]
        source_id = f"gsm8k:train:{line_number}"
        if exclusions.matches((question, answer, *answer.splitlines()), source_id=source_id):
            counts["excluded"] += 1
            continue
        question_hash = text_sha256(question)
        if question_hash in accepted:
            counts["duplicate"] += 1
            continue
        final_number = FINAL_NUMBER.fullmatch(answer.rstrip().splitlines()[-1])
        if final_number is None:
            raise SystemExit(f"Invalid numeric target for {source_id}")
        accepted[question_hash] = {
            "source_id": source_id,
            "question": question,
            "answer": answer,
            "gold": final_number[1].replace(",", ""),
        }
    order = sorted(accepted, key=lambda key: (sha256(SPLIT_SEED + key.encode("ascii")).hexdigest(), key))
    holdout_count = len(order) // 5
    partitions = {"heldout": order[:holdout_count], "train": order[holdout_count:]}
    args.output.mkdir(mode=0o700, parents=True)
    receipt = {
        **counts,
        "source_commit": SOURCE_COMMIT,
        "source_sha256": source_digest,
        "exclusion_manifest_sha256": sha256(DEFAULT_MANIFEST.read_bytes()).hexdigest(),
        "eligible": len(order),
        "split_seed": SPLIT_SEED[:-1].decode("ascii"),
        "partitions": {},
    }
    for name, keys in partitions.items():
        data = b"".join(
            (json.dumps(accepted[key], ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n")
            .encode("utf-8") for key in keys
        )
        path = args.output / f"{name}.jsonl"
        path.write_bytes(data)
        receipt["partitions"][name] = {"count": len(keys), "sha256": sha256(data).hexdigest()}
    serial = json.dumps(receipt, indent=2, sort_keys=True) + "\n"
    (args.output / "receipt.json").write_text(serial, encoding="utf-8")
    print(serial, end="")


if __name__ == "__main__":
    main()
