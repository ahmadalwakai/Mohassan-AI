"""Record Codex's qualitative review of the already-read v1 development outputs.

These judgments are validation-only diagnostics, not an independent final score.
The known input and prediction hashes prevent applying them to a different run.
This script does not load any model, training data, or independent holdout.
"""
from __future__ import annotations

import hashlib
import json
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DIRECTORY = ROOT / "artifacts/chat-training/conversation-v1"
EXPECTED_CASES = "d91e017a55dd7c679e11403f6244b44300aba54fdcd5b9ddc0adeb86d3770c7c"
EXPECTED_PREDICTIONS = "29ea8587db200eebe6daa30637e33c3b64588ca7d2bfb72c853396dfd331686c"
EXPECTED_CHECKPOINT = "13ace3fe88cd31f7b2410d0d423e1a5012564a02c72deed9a90617d8bb16919f"

# Per-item semantic judgments authored after reading the user/history and output.
# Exact target wording is not required for authored prose.
AR_REASONS = {
    1: "Begins near a greeting but degenerates into a long unfinished repetition; no usable conversational reply.",
    2: "Repeats malformed fragments instead of naturally acknowledging the thanks; generation is unfinished.",
    3: "Malformed repetitive Arabic does not introduce the assistant or state its name.",
    4: "Unfinished repeated fragments do not explain the absence of a camera image or camera access.",
    5: "Repeats a word from the prompt without answering whether an action occurred; unfinished.",
    6: "Malformed repeated news-related fragments neither supply grounded headlines nor explain the missing live tool; unfinished.",
    7: "Malformed repeated word fragments do not explain software testing.",
    8: "Garbled repetition does not define a password or access verification.",
    9: "Garbled repeated fragments do not explain downloading; output is unfinished.",
    10: "Repeats the word draft without giving its meaning; no useful definition.",
    11: "Garbled fragments do not explain the purpose of a checklist.",
    12: "Unfinished repeated fragments do not explain why testing on training examples can measure memorization.",
    13: "Garbled unfinished repetition does not draft a request for a friend to call.",
    14: "Contains a thanks fragment and a lessons fragment, but the Arabic sentence is not coherent or usable.",
    15: "Mentions tomorrow among malformed repetitive text; no coherent request to review the table.",
    16: "The two malformed words are not a recognizable audience greeting.",
    17: "Malformed sentence does not provide a coherent gentler version of the criticism.",
    18: "Garbled text loses the instruction to save before closing and is not a usable shortened sentence.",
    19: "Repeats malformed library fragments; loses the closure/reopening dates and remains unfinished.",
    20: "Unfinished repetition does not preserve the lamp-versus-chair mistake.",
    21: "Unfinished repetitive fragments provide neither of the two requested preparation steps.",
    22: "Repetitive meaningless Arabic does not offer a first step for organizing the folder.",
    23: "Repeats corrupted fragments of the request instead of asking what should be improved.",
    24: "Unfinished repetition does not ask for the other person's message or the intended reply.",
    25: "Repeated phrases about holding someone accountable do not clarify the subject or constraints of a recommendation.",
    26: "English hello ignores both the Arabic request and the uncertainty about the friend's feelings.",
    27: "Repeats future/year words without acknowledging that future activities cannot be known.",
    28: "Arabic malformed output fails the explicit request for an English translation of opening the door.",
    29: "Arabic malformed output fails the explicit request for an English translation of a good-day wish.",
    30: "Unfinished malformed repetition does not acknowledge the difficulty or give a relevant supportive response.",
}
EN_REASONS = {
    1: "Minimal credit: hello is a coherent greeting responding to the opening invitation. It does not demonstrate sustained dialogue.",
    2: "Hello is a greeting, not an appropriate acknowledgment of the user's thanks for a prior explanation.",
    3: "Hello does not introduce the assistant or state its identity.",
    4: "Hello does not answer the camera-access question or explain the lack of an image.",
    5: "Asks about goals and time instead of answering whether anything was changed on the computer.",
    6: "Hello neither gives grounded headlines nor explains that current news cannot be retrieved here.",
    7: "Hello does not explain software testing.",
    8: "Hello does not explain passwords or account access.",
    9: "Hello does not explain downloading a file.",
    10: "Hello does not define a draft.",
    11: "The question about goals and available time does not explain what a checklist does.",
    12: "Hello does not explain the difference between training memorization and handling new inputs.",
    13: "Hello does not draft the requested invitation for a friend to call.",
    14: "Hello does not express thanks for a teacher's clear lessons.",
    15: "Hello does not ask a teammate to review the table before tomorrow.",
    16: "Minimal credit: hello is a simple usable greeting. It lacks workshop-specific tailoring, which was not strictly required.",
    17: "Hello does not rewrite the criticism in a gentler form.",
    18: "Repetitive invented wording loses the instruction to save before closing and fails the shortening request.",
    19: "Invents opening hours and Sunday instead of preserving the Monday closure and Tuesday reopening.",
    20: "Invents opening hours and repeats store wording instead of preserving the lamp/chair delivery error.",
    21: "Hello provides neither of the two requested presentation-preparation ideas.",
    22: "Hello offers no relevant first step for organizing the folder.",
    23: "Hello does not ask what should be improved or what result the user wants.",
    24: "Hello does not ask for the other person's message or the intended reply.",
    25: "Hello does not clarify the subject or constraints of the recommendation.",
    26: "Hello does not acknowledge the lack of evidence about the friend's feelings.",
    27: "Hello does not address the unknowable future or offer relevant planning help.",
    28: "Unfinished malformed Arabic repetition is not the requested translation of open the door.",
    29: "The short Arabic output is malformed and does not convey have a nice day.",
    30: "Hello is unrelated to the user's frustration and provides neither acknowledgment nor relevant support.",
}


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> dict:
    cases_path = DIRECTORY / "development-cases.jsonl"
    predictions_path = DIRECTORY / "development-predictions.jsonl"
    generation = json.loads((DIRECTORY / "development-predictions.manifest.json").read_text(encoding="utf-8"))
    assert digest(cases_path) == EXPECTED_CASES
    assert digest(predictions_path) == EXPECTED_PREDICTIONS
    assert generation["checkpoint_sha256"] == EXPECTED_CHECKPOINT
    assert generation["input_sha256"] == EXPECTED_CASES
    assert generation["predictions_sha256"] == EXPECTED_PREDICTIONS
    cases = [json.loads(line) for line in cases_path.read_text(encoding="utf-8").splitlines() if line.strip()]
    predictions = [json.loads(line) for line in predictions_path.read_text(encoding="utf-8").splitlines() if line.strip()]
    by_id = {row["id"]: row for row in predictions}
    assert len(cases) == len(predictions) == len(by_id) == 84
    reviews = {}
    for case in cases:
        identifier = case["id"]
        output = by_id[identifier]
        category = case["category"]
        language = case["language"]
        if identifier.startswith("development-"):
            number = int(identifier.split("-")[1])
            reason = (AR_REASONS if language == "ar" else EN_REASONS)[number]
            passed = language == "en" and number in (1, 16)
            group = "authored_validation"
        else:
            group = "systematic_validation"
            if category == "copy":
                passed = identifier in {"validation-systematic-000-5", "validation-systematic-001-5",
                                        "validation-systematic-002-5", "validation-systematic-001-4"}
                reason = ("Correctly reproduces the full requested label exactly, without extra text."
                          if passed else "Repeats the VFY prefix, corrupting the identifier and failing to finish; exact character preservation was requested.")
            elif category == "memory":
                passed = False
                reason = "Hello does not recover the reference explicitly present in the earlier conversation; only the reference was requested."
            elif category == "correction":
                passed = False
                reason = ("Hello ignores the explicitly corrected reference and the request to return its new value."
                          if language == "ar" else "The unrelated statement about not guaranteeing something ignores the explicitly corrected reference.")
            elif category == "structured_text":
                passed = False
                if identifier == "validation-systematic-002-6":
                    reason = "Produces two lines but replaces the supplied reference with the wrong REF-A002 value; fails value preservation."
                elif language == "en":
                    reason = "Repeats Name/Reference lines far beyond the requested two lines, omits the correct reference, and fails to finish."
                else:
                    reason = "Malformed or repetitive Arabic fails to produce two labeled lines preserving the supplied name and reference."
            else:
                raise AssertionError(f"Unexpected validation category: {category}")
        if passed:
            assert output["finished"] is True and not output.get("error")
        reviews[identifier] = {"passed": passed, "reason": reason, "language": language,
                               "category": category, "group": group, "finished": output.get("finished") is True}

    def aggregate(selected):
        rows = list(selected)
        passed = sum(row["passed"] for row in rows)
        return {"passed": passed, "total": len(rows), "fraction": passed / len(rows) if rows else None,
                "completed": sum(row["finished"] for row in rows)}

    values = list(reviews.values())
    result = {
        "schema_version": 1, "reviewer": "codex", "review_type": "qualitative_semantic_development_review",
        "scope": "validation-only; these cases are derived from the training validation split and are not an independent final assessment",
        "checkpoint_sha256": EXPECTED_CHECKPOINT, "predictions_sha256": EXPECTED_PREDICTIONS,
        "input_sha256": EXPECTED_CASES, "independent_final_holdout_used": False,
        "readiness_claim": False, "ready_for_chat": False, "experimentalReady": False,
        "model_ready": False, "production_ready": False,
        "judgment_policy": "Coherent semantically relevant replies receive credit without exact target matching; copy/value/format requests require preserving the specified values. Unfinished or incoherent replies fail. Two minimal English greetings receive deliberately lenient credit.",
        "aggregate": aggregate(values),
        "by_language": {lang: aggregate(row for row in values if row["language"] == lang) for lang in ("ar", "en")},
        "by_category": {category: aggregate(row for row in values if row["category"] == category) for category in sorted({row["category"] for row in values})},
        "by_group": {group: aggregate(row for row in values if row["group"] == group) for group in ("authored_validation", "systematic_validation")},
        "observations": {
            "exact_hello_outputs": sum(row.get("text", "").strip().casefold() == "hello" for row in predictions),
            "unfinished_outputs": sum(row.get("finished") is not True for row in predictions),
            "generation_errors": sum(bool(row.get("error")) for row in predictions),
            "successful_context_memory_or_corrections": sum(row["passed"] for row in values if row["category"] in ("memory", "correction")),
            "successful_exact_copy": sum(row["passed"] for row in values if row["category"] == "copy"),
        },
        "diagnosis": [
            "English responses often collapse to the same unrelated short greeting; fluency of that word is not task competence.",
            "Arabic responses are predominantly malformed repetitive fragments, including several unfinished loops.",
            "Both languages fail the sampled multi-turn reference-memory and correction tasks; successful literal copying does not establish conversation memory.",
            "Some outputs invent values from unrelated contexts, including business opening hours and an incorrect reference.",
            "These outputs establish poor free-generation performance for this candidate. They do not by themselves isolate whether data coverage, optimization, tokenization, or inference alignment caused it.",
        ],
        "recommendations": [
            "Keep this candidate unpromoted and do not consume the independent frozen holdout yet.",
            "Before a large follow-up run, check train/inference prompt parity, target shifting and EOS handling; inspect whether a few training examples can be generated coherently under the same decoder.",
            "Broaden high-quality bilingual instruction/dialogue supervision and balance natural conversation against systematic copying templates. Use validation-only evidence for subsequent development.",
            "Require coherent validation generation and multi-turn behavior before spending the fresh independent final assessment.",
        ],
        "reviews": reviews,
    }
    output_path = DIRECTORY / "development-review.json"
    with output_path.open("x", encoding="utf-8") as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    return {key: result[key] for key in ("scope", "checkpoint_sha256", "aggregate", "by_language", "by_group", "observations", "ready_for_chat")}


if __name__ == "__main__":
    print(json.dumps(main(), ensure_ascii=False, indent=2))
