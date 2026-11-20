"""Validate and summarize a pinned semantic review of chat development cases."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from collections import Counter, defaultdict
from pathlib import Path


V3_GROUPS = {"prior_v1_validation", "v3_validation"}
V4_GROUP = "development-v4"
V4_CASES_SHA256 = "b21d0d62cca5ca7006485271023515262c243aecdb4ef7d37ec23667c44b8471"
V4_LANGUAGES = ("ar", "en")
V4_CATEGORIES = (
    "clarification", "copy", "correction", "explanation", "greeting", "identity",
    "limits_uncertainty", "memory", "short_writing", "summary",
)


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def rows(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def validate_v4(cases: list[dict], case_hash: str, manifest: dict, review: dict) -> None:
    if case_hash != V4_CASES_SHA256:
        raise ValueError("Development-v4 case digest does not match the frozen set.")
    expected = {(language, category): 10 for language in V4_LANGUAGES for category in V4_CATEGORIES}
    if Counter((case["language"], case["category"]) for case in cases) != expected:
        raise ValueError("Development-v4 requires ten cases per language and category.")
    checkpoint = manifest.get("checkpoint_sha256")
    reviewer = review.get("reviewer")
    if not isinstance(checkpoint, str) or not re.fullmatch(r"[0-9a-f]{64}", checkpoint):
        raise ValueError("Development-v4 requires a valid checkpoint digest.")
    maximum = manifest.get("max_tokens")
    if (manifest.get("decoding") != "greedy" or manifest.get("cases") != len(cases)
            or type(maximum) is not int or not 16 <= maximum <= 192):
        raise ValueError("Development-v4 needs one greedy generation per case with a recorded token limit.")
    if not isinstance(reviewer, str) or not reviewer.strip():
        raise ValueError("Development-v4 needs an identified reviewer.")


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
    groups = {case.get("development_group") for case in cases}
    is_v4 = groups == {V4_GROUP}
    if is_v4:
        validate_v4(cases, case_hash, manifest, review)
    elif not groups <= V3_GROUPS:
        raise ValueError("Only explicitly labeled development cases are accepted. Keep v4 separate from older cases.")
    by_id = {row["id"]: row for row in predictions}
    judgments = review.get("reviews", {})
    if set(by_id) != {case["id"] for case in cases} or set(judgments) != set(by_id):
        raise ValueError("Each development case needs exactly one prediction and one judgment.")
    counts = defaultdict(lambda: {"passed": 0, "total": 0, "finished": 0})
    for case in cases:
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
        keys = ["overall", "language:" + case["language"], "group:" + case["development_group"],
                "group_language:" + case["development_group"] + ":" + case["language"],
                "category:" + case.get("category", "unspecified")]
        if is_v4:
            keys.append("language_category:" + case["language"] + ":" + case["category"])
        for key in keys:
            counts[key]["total"] += 1
            counts[key]["passed"] += int(judgment["passed"])
            counts[key]["finished"] += int(prediction.get("finished") is True)
    report = {"schemaVersion": 1, "checkpoint_sha256": manifest["checkpoint_sha256"],
              "input_sha256": case_hash, "predictions_sha256": prediction_hash,
              "review_sha256": digest(review_path), "reviewer": review.get("reviewer"),
              "counts": dict(sorted(counts.items())), "development_only": True,
              "independent_final_holdout_used": False, "ready_for_chat": False,
              "note": "These validation judgments measure development performance and never authorize phone activation."}
    if is_v4:
        overall_passed = counts["overall"]["passed"] >= 120
        languages_below_minimum = [language for language in V4_LANGUAGES if counts["language:" + language]["passed"] < 55]
        categories_at_zero = [category for category in V4_CATEGORIES if counts["category:" + category]["passed"] == 0]
        report["gate5"] = {
            "passed": overall_passed and not languages_below_minimum and not categories_at_zero,
            "thresholds": {"overall": 120, "per_language": 55, "per_category": 1},
            "overall_passed": overall_passed,
            "languages_below_minimum": languages_below_minimum,
            "categories_at_zero": categories_at_zero,
        }
    return report


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
