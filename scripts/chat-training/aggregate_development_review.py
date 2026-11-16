"""Validate and summarize a pinned semantic review of the v3 development set."""
from __future__ import annotations

import argparse
import hashlib
import json
from collections import defaultdict
from pathlib import Path


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def rows(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def aggregate(cases_path: Path, predictions_path: Path, review_path: Path) -> dict:
    cases, predictions = rows(cases_path), rows(predictions_path)
    manifest = json.loads(predictions_path.with_suffix(".manifest.json").read_text(encoding="utf-8"))
    review = json.loads(review_path.read_text(encoding="utf-8"))
    case_hash, prediction_hash = digest(cases_path), digest(predictions_path)
    if (manifest.get("input_sha256") != case_hash or manifest.get("predictions_sha256") != prediction_hash
            or review.get("input_sha256") != case_hash or review.get("predictions_sha256") != prediction_hash
            or review.get("checkpoint_sha256") != manifest.get("checkpoint_sha256")):
        raise ValueError("Review, inputs, predictions and checkpoint must match their pinned evidence.")
    if len({case["id"] for case in cases}) != len(cases) or len({row["id"] for row in predictions}) != len(predictions):
        raise ValueError("Duplicate development IDs.")
    by_id = {row["id"]: row for row in predictions}
    judgments = review.get("reviews", {})
    if set(by_id) != {case["id"] for case in cases} or set(judgments) != set(by_id):
        raise ValueError("Each development case needs exactly one prediction and one judgment.")
    counts = defaultdict(lambda: {"passed": 0, "total": 0, "finished": 0})
    for case in cases:
        if case.get("development_group") not in {"prior_v1_validation", "v3_validation"}:
            raise ValueError("Only explicitly labeled development cases are accepted.")
        prediction, judgment = by_id[case["id"]], judgments[case["id"]]
        if (type(judgment.get("passed")) is not bool or not isinstance(judgment.get("reason"), str)
                or not judgment["reason"].strip()):
            raise ValueError("Each semantic judgment needs a boolean and a concrete reason.")
        if (prediction.get("checkpoint_sha256") not in {None, manifest["checkpoint_sha256"]}
                or (not prediction.get("error") and prediction.get("checkpoint_sha256") is None)):
            raise ValueError("A prediction belongs to a different checkpoint.")
        if judgment["passed"] and (prediction.get("finished") is not True
                                    or not prediction.get("text", "").strip()
                                    or "\ufffd" in prediction["text"] or prediction.get("error")):
            raise ValueError("An unfinished, empty, malformed or failed generation cannot pass.")
        for key in ["overall", "language:" + case["language"], "group:" + case["development_group"],
                    "group_language:" + case["development_group"] + ":" + case["language"],
                    "category:" + case.get("category", "unspecified")]:
            counts[key]["total"] += 1
            counts[key]["passed"] += int(judgment["passed"])
            counts[key]["finished"] += int(prediction.get("finished") is True)
    return {"schemaVersion": 1, "checkpoint_sha256": manifest["checkpoint_sha256"],
            "input_sha256": case_hash, "predictions_sha256": prediction_hash,
            "review_sha256": digest(review_path), "reviewer": review.get("reviewer"),
            "counts": dict(sorted(counts.items())), "development_only": True,
            "independent_final_holdout_used": False, "ready_for_chat": False,
            "note": "These validation judgments measure development performance and never authorize phone activation."}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cases", type=Path, required=True)
    parser.add_argument("--predictions", type=Path, required=True)
    parser.add_argument("--review", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = aggregate(args.cases, args.predictions, args.review)
    with args.output.open("x", encoding="utf-8") as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
