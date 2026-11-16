"""Evaluate frozen chat cases; manual review and identity bindings gate readiness.

Inputs: JSONL {id,text,finished,error?}; optional generation manifest
{checkpoint_sha256,predictions_sha256,holdout_sha256}; optional review JSON
{checkpoint_sha256,predictions_sha256,reviewer,reviews:{id:{passed:bool,reason:str}}}.
No model is loaded and no case, prediction, or checkpoint is modified.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import unicodedata
from collections import Counter
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_HOLDOUT = ROOT / "artifacts/chat-training/conversation-v1/holdout"
SHA = re.compile(r"[0-9a-fA-F]{64}\Z")
ARABIC = re.compile(r"[\u0621-\u063a\u0641-\u064a\u066e-\u06d3]")
LATIN = re.compile(r"[A-Za-z]")


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).casefold()
    text = "".join(str(unicodedata.decimal(c)) if c.isdecimal() else c for c in text)
    text = "".join(c for c in text if unicodedata.category(c) != "Mn" and c not in "\u200b\u200c\u200d\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069")
    return "\n".join(" ".join(line.split()) for line in text.strip().splitlines())


def language_ok(text: str, language: str) -> bool:
    arabic = len(ARABIC.findall(text))
    latin = len(LATIN.findall(text))
    letters = arabic + latin
    if letters == 0:
        return False
    return arabic / letters >= 0.5 if language == "ar" else latin / letters >= 0.9


def score_case(case: dict, prediction: dict | None, review: dict | None = None) -> dict:
    evaluation = case["evaluation"]
    result = {"id": case["id"], "language": case["language"], "category": case["category"],
              "mode": evaluation["mode"], "passed": False, "complete": False, "language_checked": False,
              "language_passed": None, "reasons": []}
    if prediction is None:
        result["reasons"].append("missing_prediction")
        return result
    if prediction.get("error"):
        result["reasons"].append("generation_error")
        return result
    text = prediction.get("text")
    if not isinstance(text, str) or not text.strip():
        result["reasons"].append("empty_or_invalid_text")
        return result
    if prediction.get("finished") is not True:
        result["reasons"].append("unfinished_generation")
        return result
    result["complete"] = True
    if len(text) > evaluation["max_chars"]:
        result["reasons"].append("response_too_long")
    if evaluation["require_language"]:
        result["language_checked"] = True
        result["language_passed"] = language_ok(text, case["language"])
        if not result["language_passed"]:
            result["reasons"].append("wrong_language")
    canonical = normalize(text)
    if any(normalize(phrase) in canonical for phrase in evaluation.get("forbidden", [])):
        result["reasons"].append("forbidden_claim_or_wrong_entity")
    mode = evaluation["mode"]
    if mode == "exact":
        if canonical not in [normalize(value) for value in evaluation["accepted"]]:
            result["reasons"].append("exact_output_mismatch")
    elif mode == "concepts":
        missing_groups = [i for i, alternatives in enumerate(evaluation["any_groups"])
                          if not any(normalize(value) in canonical for value in alternatives)]
        if missing_groups:
            result["reasons"].append("required_concept_missing")
            result["missing_concept_groups"] = missing_groups
    elif mode == "manual":
        result["review_criteria"] = evaluation["review_criteria"]
        if not isinstance(review, dict) or type(review.get("passed")) is not bool or not isinstance(review.get("reason"), str) or not review["reason"].strip():
            result["passed"] = None
            result["reasons"].append("manual_review_required")
            return result
        result["review"] = review
        if not review["passed"]:
            result["reasons"].append("manual_review_failed")
    else:
        raise ValueError("Unsupported frozen evaluation mode.")
    result["passed"] = not result["reasons"]
    return result


def load_jsonl(path: Path) -> list[dict]:
    rows = [json.loads(line) for line in path.read_text(encoding="utf-8-sig").splitlines() if line.strip()]
    if any(not isinstance(row, dict) for row in rows):
        raise ValueError("JSONL rows must be objects.")
    return rows


def evaluate(predictions_path: Path, *, holdout: Path = DEFAULT_HOLDOUT,
             predictions_manifest: Path | None = None, review_path: Path | None = None) -> dict[str, Any]:
    manifest = json.loads((holdout / "manifest.json").read_text(encoding="utf-8"))
    actual_holdout = digest(holdout / "cases.jsonl")
    actual_criteria = digest(holdout / "criteria.json")
    if manifest["holdout_sha256"] != actual_holdout or manifest["criteria_sha256"] != actual_criteria:
        raise ValueError("Frozen holdout or criteria digest mismatch.")
    criteria = json.loads((holdout / "criteria.json").read_text(encoding="utf-8"))
    cases = load_jsonl(holdout / "cases.jsonl")
    predictions = load_jsonl(predictions_path)
    ids = {case["id"] for case in cases}
    counts = Counter(row.get("id") for row in predictions)
    if len(ids) != len(cases) or any(not isinstance(key, str) for key in counts):
        raise ValueError("Invalid case or prediction identity.")
    duplicates = sorted(key for key, count in counts.items() if count > 1)
    unknown = sorted(set(counts) - ids)
    actual_predictions = digest(predictions_path)
    binding_reasons: list[str] = []
    checkpoint_sha = None
    if predictions_manifest is None:
        binding_reasons.append("generation_manifest_missing")
    else:
        generation = json.loads(predictions_manifest.read_text(encoding="utf-8"))
        candidate_sha = generation.get("checkpoint_sha256")
        if not isinstance(candidate_sha, str) or not SHA.fullmatch(candidate_sha):
            binding_reasons.append("checkpoint_identity_invalid")
        else:
            checkpoint_sha = candidate_sha.lower()
        if generation.get("predictions_sha256") != actual_predictions:
            binding_reasons.append("generation_predictions_digest_mismatch")
        if generation.get("holdout_sha256") != actual_holdout:
            binding_reasons.append("generation_holdout_digest_mismatch")
    reviews: dict = {}
    review_binding_verified = False
    reviewer = None
    if review_path is not None:
        review_document = json.loads(review_path.read_text(encoding="utf-8"))
        if (not checkpoint_sha or review_document.get("checkpoint_sha256", "").lower() != checkpoint_sha
                or review_document.get("predictions_sha256") != actual_predictions):
            binding_reasons.append("review_binding_mismatch")
        elif (not isinstance(review_document.get("reviews"), dict)
              or not isinstance(review_document.get("reviewer"), str) or not review_document["reviewer"].strip()):
            binding_reasons.append("invalid_review_document")
        else:
            reviews = review_document["reviews"]
            review_binding_verified = True
            reviewer = review_document["reviewer"]
    predictions_by_id = {row["id"]: row for row in predictions if row["id"] not in duplicates}
    rows = [score_case(case, predictions_by_id.get(case["id"]), reviews.get(case["id"])) for case in cases]

    def metric(selected: list[dict]) -> dict:
        passed = sum(row["passed"] is True for row in selected)
        return {"passed": passed, "total": len(selected), "accuracy": passed / len(selected) if selected else None}

    objective = [row for row in rows if row["mode"] != "manual"]
    manual = [row for row in rows if row["mode"] == "manual"]
    objective_metric = metric(objective)
    language_metrics = {language: metric([row for row in objective if row["language"] == language]) for language in ("ar", "en")}
    category_metrics = {category: metric([row for row in objective if row["category"] == category]) for category in sorted({row["category"] for row in objective})}
    checked_language = [row for row in rows if row["language_checked"]]
    language_accuracy = sum(row["language_passed"] is True for row in checked_language) / len(checked_language) if checked_language else 0.0
    coverage = sum(row["complete"] for row in rows) / len(rows)
    machine_failures = []
    if duplicates or unknown:
        machine_failures.append("invalid_prediction_ids")
    if coverage < criteria["required_complete_prediction_coverage"]:
        machine_failures.append("incomplete_prediction_coverage")
    if objective_metric["accuracy"] < criteria["minimum_objective_accuracy"]:
        machine_failures.append("objective_accuracy_below_threshold")
    if any(value["accuracy"] < criteria["minimum_objective_accuracy_per_language"] for value in language_metrics.values()):
        machine_failures.append("per_language_objective_accuracy_below_threshold")
    for category, threshold_key in (("context", "minimum_context_accuracy"), ("instruction", "minimum_instruction_accuracy"),
                                    ("tool_honesty", "required_tool_honesty_accuracy")):
        if category_metrics[category]["accuracy"] < criteria[threshold_key]:
            machine_failures.append(f"{category}_accuracy_below_threshold")
    if language_accuracy < criteria["required_language_accuracy"]:
        machine_failures.append("language_accuracy_below_threshold")
    manual_metric = metric(manual)
    manual_complete = all(isinstance(row.get("review"), dict) for row in manual)
    manual_pass = manual_complete and manual_metric["passed"] == manual_metric["total"] and review_binding_verified
    ready = not machine_failures and not binding_reasons and manual_pass
    return {"schema_version": 1, "criteria_id": criteria["id"], "scope": criteria["scope"],
            "checkpoint_sha256": checkpoint_sha, "predictions_sha256": actual_predictions,
            "holdout_sha256": actual_holdout, "criteria_sha256": actual_criteria,
            "automated_gate_passed": not machine_failures, "manual_review_passed": manual_pass,
            "requires_manual_review": not manual_complete or not review_binding_verified,
            "ready_for_chat": ready, "experimentalReady": ready, "model_ready": ready, "production_ready": False,
            "binding_verified": not binding_reasons, "binding_failures": binding_reasons,
            "machine_failures": machine_failures, "duplicates": duplicates, "unknown_prediction_ids": unknown,
            "objective": objective_metric, "objective_by_language": language_metrics, "objective_by_category": category_metrics,
            "manual": manual_metric, "complete_prediction_coverage": coverage, "language_accuracy": language_accuracy,
            "manual_review_sha256": digest(review_path) if review_path else None, "reviewer": reviewer,
            "limitations": criteria["limitations"], "cases": rows}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--predictions", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--holdout", type=Path, default=DEFAULT_HOLDOUT)
    parser.add_argument("--predictions-manifest", type=Path)
    parser.add_argument("--review", type=Path)
    args = parser.parse_args()
    report = evaluate(args.predictions, holdout=args.holdout, predictions_manifest=args.predictions_manifest, review_path=args.review)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x", encoding="utf-8") as stream:
        json.dump(report, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    print(json.dumps({key: report[key] for key in ("checkpoint_sha256", "objective", "objective_by_language", "automated_gate_passed", "requires_manual_review", "ready_for_chat", "machine_failures")}, ensure_ascii=False, indent=2))
