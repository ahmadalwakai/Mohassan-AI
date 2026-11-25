"""Project pinned Natural Questions train annotations to an offline policy evaluation input."""

from __future__ import annotations

import argparse
from hashlib import file_digest, sha256
import json
from pathlib import Path
import re
import sys

import pyarrow.parquet as parquet

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent-capability-bench/v2"))
from exclusion import Exclusions, normalize_text

NQ_REVISION = "5645e0450e5db543a84d868a9c3230f2f424a9d2"
NQ_SHARD = "default/partial-train/0000.parquet"
NQ_SHA256 = "3f2031d095bcb63fd71a180d3a2ee6285f8dae7bc6165e5db32bbcc433f4da8c"
V1_DEV_SHA256 = "712a170d3d60c6aec41f9fe44e7d5cc222bbafbe28d9ca763b5f396db2d2410b"
V2_EXCLUSION_SHA256 = "de192bdc7203e1aa24fa06b216d3976f4ea77ec103e085a4019af7a60c2f3054"


def verify_file(path: Path, expected: str) -> None:
    with path.open("rb") as file:
        if file_digest(file, "sha256").hexdigest() != expected:
            raise ValueError(f"Unexpected SHA-256 for {path}")


def label(annotations: dict) -> str | None:
    # The official train split has exactly one human annotation per example.
    spans = annotations["short_answers"]
    yes_no = annotations["yes_no_answer"]
    long_spans = annotations["long_answer"]
    if len(spans) != 1 or len(yes_no) != 1 or len(long_spans) != 1 or yes_no[0] not in {-1, 0, 1}:
        raise ValueError("Unexpected Natural Questions train annotation")
    if spans[0]["start_token"] or yes_no[0] in {0, 1}:
        return "short"
    return "longer" if long_spans[0]["start_token"] >= 0 else None


def question_key(text: str) -> str:
    return re.sub(r"[.!?؟]+$", "", normalize_text(text)).strip()


def prepare(source: Path, v1_development: Path, v2_manifest: Path) -> dict:
    verify_file(source, NQ_SHA256)
    verify_file(v1_development, V1_DEV_SHA256)
    verify_file(v2_manifest, V2_EXCLUSION_SHA256)
    v1_keys = {
        question_key(turn["text"])
        for case in json.loads(v1_development.read_bytes())["cases"]
        for turn in case["turns"]
    }
    # Verify both hash partitions using the release's exclusion reader.
    # The registry contains source IDs and hashes, with no benchmark prompts.
    v2 = Exclusions.load(v2_manifest)
    v2_datasets = sorted({source_id.partition(":")[0] for source_id in v2.source_ids})
    if {"natural_questions", "natural-questions", "nq"} & set(v2_datasets):
        raise ValueError("Natural Questions supplies items to the capability benchmark")

    table = parquet.ParquetFile(source).read(columns=["id", "question.text", "annotations"])
    rejected = {"benchmark_overlap": 0, "no_answer": 0}
    cases = []
    for row in table.to_pylist():
        example_id = row["id"]
        text = row["question"]["text"]
        key = question_key(text)
        if key in v1_keys or v2.matches([text, key, f"{key}?"], source_ids=[
            f"{dataset}:{example_id}" for dataset in ("natural_questions", "natural-questions", "nq")
        ]):
            rejected["benchmark_overlap"] += 1
            continue
        expected = label(row["annotations"])
        if expected is None:
            rejected["no_answer"] += 1
            continue
        cases.append({"id": example_id, "text": text, "expected": expected})

    case_bytes = json.dumps(cases, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return {
        "source": {
            "name": "Natural Questions", "license": "CC BY-SA 3.0",
            "dataset": "google-research-datasets/natural_questions", "split": "train",
            "revision": NQ_REVISION, "shard": NQ_SHARD, "shardSha256": NQ_SHA256,
            "sourceRows": table.num_rows, "excluded": rejected, "casesSha256": sha256(case_bytes).hexdigest(),
        },
        "exclusions": {
            "v1DevelopmentSha256": V1_DEV_SHA256,
            "v2ExclusionManifestSha256": V2_EXCLUSION_SHA256,
            "v2SourceDatasets": v2_datasets,
        },
        "cases": cases,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--parquet", type=Path, required=True)
    parser.add_argument("--v1-development", type=Path, required=True)
    parser.add_argument("--v2-exclusion-manifest", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    projection = prepare(arguments.parquet, arguments.v1_development, arguments.v2_exclusion_manifest)
    with arguments.output.open("x", encoding="utf-8") as output:
        json.dump(projection, output, ensure_ascii=False, separators=(",", ":"))
        output.write("\n")
    print(json.dumps(projection["source"], indent=2))


if __name__ == "__main__":
    main()
