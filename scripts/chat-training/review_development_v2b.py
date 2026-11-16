"""Record the read-only Codex semantic review of v2b validation generations.

Judgments apply only to the pinned outputs below. No model or independent
holdout is read. This records development evidence, never a final benchmark.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / "artifacts/chat-training"
CHECKPOINT = "706e469dfda2ad3be2e02e79d1dd03bf75b6303fc06548af7dc0aaee09e00e4b"
PREDICTIONS = "e2b4848d2f62483595798fc45617f0077e4610266b9987f31c55427762d8cb27"
CASES = "d91e017a55dd7c679e11403f6244b44300aba54fdcd5b9ddc0adeb86d3770c7c"

AR_REASONS = [
    "Malformed greeting degenerates into unfinished repetition rather than a usable conversational reply.",
    "Unfinished repetition does not acknowledge the user's thanks coherently.",
    "Malformed unrelated phrase does not introduce the assistant or identify its name.",
    "Repeats a camera phrase without answering what can be seen or explaining absent image access.",
    "Begins with no but continues with malformed repeated fragments; the whole reply is not coherent.",
    "The unrelated year 1961 neither provides current headlines nor explains the lack of a live news tool.",
    "Unfinished repetitive fragments do not explain software testing.",
    "Unfinished repetition of unrelated words does not explain passwords.",
    "Repeats downloading fragments without defining the transfer of data; unfinished.",
    "Malformed unrelated phrase does not define a draft.",
    "Unfinished repeated unrelated words do not explain a checklist's purpose.",
    "Unfinished repeated unrelated words do not explain training memorization or assessment on new examples.",
    "Unfinished repetitive fragments do not form a usable request for a friend to call.",
    "Unfinished repetition of unrelated words does not thank a teacher for clear lessons.",
    "Unfinished repetition does not ask a teammate to review the table before tomorrow.",
    "Unfinished repetition of unrelated words is not a workshop audience greeting.",
    "Unfinished malformed repetition does not rewrite the criticism gently.",
    "Unfinished repetition loses the save-before-close instruction and is not a concise rewrite.",
    "Mentions the library and maintenance but is malformed and omits the Monday closure and Tuesday reopening.",
    "Changes the ordered item to a chair and then repeats unfinished fragments, losing the delivery error.",
    "Malformed sentence provides neither of the two requested presentation-preparation steps.",
    "Unfinished unrelated repetition provides no first step for organizing the folder.",
    "Rearranges prompt fragments incoherently instead of clarifying what should be improved.",
    "Unrelated phrase does not ask what the other person said or what the response should communicate.",
    "Unfinished repetition does not clarify the recommendation's subject or constraints.",
    "Begins with no but adds an unrelated honorific; fails to give a coherent answer about the missing evidence.",
    "Repeats year/future wording without acknowledging uncertainty about future activities.",
    "Malformed Arabic repetition fails the requested English translation and is unfinished.",
    "Malformed Arabic output fails the explicit English-language translation instruction.",
    "Unfinished repetition of the user's distress word does not acknowledge or address the difficulty.",
]
EN_REASONS = [
    "Coherent English greeting and a relevant invitation to explain what help is wanted.",
    "Reverses the thanks back to the user and becomes semantically incoherent instead of acknowledging the thanks.",
    "Gives an inaccurate generic definition of AI rather than introducing the assistant in one sentence.",
    "Tautological camera statement does not explain the absence of a supplied camera image or access.",
    "Contradictory statements about having or using a computer do not clearly answer whether any action occurred.",
    "Unrelated discussion of the word tablet neither gives grounded headlines nor explains unavailable live news.",
    "Incorrect vague statement about processing software/data does not explain verification of expected behavior.",
    "Misdefines a password as a data structure for deploying values; misses secrecy and account access.",
    "An assertion about a file being open to all users does not define downloading.",
    "Incorrect vague definition does not explain an early revisable version of work.",
    "Tautological checklist statement becomes an unfinished repetition and does not explain its purpose.",
    "Restates that a model should be assessed only on training examples, missing and effectively reversing the requested distinction.",
    "Defines a message with an unrelated planet claim rather than drafting a request for a friend to call.",
    "Introduces a note but repeats an unrelated answer/question sentence; no thanks or clear-lessons message.",
    "Misinterprets table and repeats tomorrow until truncation instead of requesting a teammate's review.",
    "Says it will provide a greeting but never actually supplies the requested greeting.",
    "Malformed repetition about being good does not provide a gentler rewrite.",
    "Unrelated contradictory file wording loses the save-before-close instruction and does not shorten it.",
    "Promises a closed schedule but omits the closure and reopening facts, so it is not a summary.",
    "Preserves that a lamp was ordered but invents a customer being sent and loses the chair-delivery mistake.",
    "Introduces a presentation and an unrelated question instead of giving two preparation methods.",
    "Incorrect definition of a messy folder gives no actionable starting step.",
    "Invents a sentence and grammatical correction despite no text being supplied, rather than requesting the missing material.",
    "Promises a reply to a name without asking for the missing message or the intended response.",
    "Repeats the need for a recommendation instead of clarifying what is being chosen.",
    "The contradictory yes/cannot statement about a friend being in the past does not coherently express the relevant uncertainty.",
    "An unrelated future-generations statement does not answer or acknowledge the unknown future activity.",
    "Unfinished malformed Arabic repetition does not translate open the door.",
    "Unfinished malformed Arabic repetition does not convey have a nice day.",
    "Malformed repetitive response neither acknowledges the user's frustration nor offers relevant support.",
]


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> dict:
    candidate_dir = BASE / "conversation-v2b"
    cases_path = BASE / "conversation-v1/development-cases.jsonl"
    predictions_path = candidate_dir / "development-predictions.jsonl"
    manifest = json.loads((candidate_dir / "development-predictions.manifest.json").read_text(encoding="utf-8"))
    assert digest(cases_path) == CASES and digest(predictions_path) == PREDICTIONS
    assert manifest["checkpoint_sha256"] == CHECKPOINT and manifest["cases"] == 84
    assert manifest["input_sha256"] == CASES and manifest["predictions_sha256"] == PREDICTIONS
    cases = [json.loads(line) for line in cases_path.read_text(encoding="utf-8").splitlines() if line.strip()]
    predictions = [json.loads(line) for line in predictions_path.read_text(encoding="utf-8").splitlines() if line.strip()]
    by_id = {row["id"]: row for row in predictions}
    assert len(cases) == len(predictions) == len(by_id) == 84
    reviews = {}
    for case in cases:
        identifier, language, category = case["id"], case["language"], case["category"]
        prediction = by_id[identifier]
        if identifier.startswith("development-"):
            index = int(identifier.split("-")[1]) - 1
            reason = (AR_REASONS if language == "ar" else EN_REASONS)[index]
            passed = language == "en" and index == 0
            group = "authored_validation"
        else:
            group = "systematic_validation"
            passed = language == "en" and category in ("memory", "copy")
            if category == "memory":
                reason = ("Correctly returns only the reference from the earlier conversation." if passed
                          else "Unfinished unrelated Arabic repetition fails to recall the supplied reference.")
            elif category == "copy":
                if passed:
                    reason = "Correctly copies the complete label exactly without extra text."
                elif identifier == "validation-systematic-002-5":
                    reason = "Unfinished unrelated repetition does not copy the label."
                else:
                    reason = "Inserts a space inside the identifier despite the explicit every-character preservation instruction."
            elif category == "correction":
                if language == "en":
                    reason = "Returns the old reference as the new value, failing the explicit correction; also adds text beyond the requested value."
                elif identifier == "validation-systematic-000-3":
                    reason = "Malformed fragments do not supply the corrected reference."
                else:
                    reason = "Returns a malformed version of the old reference, failing the explicitly corrected value."
            elif category == "structured_text":
                if identifier == "validation-systematic-001-6":
                    reason = "Preserves the supplied values but repeats the instruction in one line rather than producing the requested two labeled lines."
                elif language == "en":
                    reason = "Produces one line with the reference treated as the name, omitting the actual name and second line."
                elif identifier == "validation-systematic-000-7":
                    reason = "Unfinished repetition fails the requested two-line structure and reference preservation."
                else:
                    reason = "Unrelated or malformed Arabic does not preserve the name/reference in two labeled lines."
            else:
                raise AssertionError(category)
        if passed:
            assert prediction.get("finished") is True and not prediction.get("error")
        reviews[identifier] = {"passed": passed, "reason": reason, "language": language, "category": category,
                               "group": group, "finished": prediction.get("finished") is True}

    def aggregate(rows):
        rows = list(rows)
        passed = sum(row["passed"] for row in rows)
        return {"passed": passed, "total": len(rows), "fraction": passed / len(rows) if rows else None,
                "completed": sum(row["finished"] for row in rows)}

    values = list(reviews.values())
    old_path = BASE / "conversation-v1/development-review.json"
    old = json.loads(old_path.read_text(encoding="utf-8"))
    assert old["input_sha256"] == CASES and set(old["reviews"]) == set(reviews)
    old_pass = {identifier for identifier, row in old["reviews"].items() if row["passed"]}
    current_pass = {identifier for identifier, row in reviews.items() if row["passed"]}
    current_by_language = {lang: aggregate(row for row in values if row["language"] == lang) for lang in ("ar", "en")}
    result = {
        "schema_version": 1, "reviewer": "codex", "review_type": "qualitative_semantic_development_review",
        "scope": "validation-only; same reused validation-derived 84 cases as v1, not an independent final assessment",
        "checkpoint_sha256": CHECKPOINT, "predictions_sha256": PREDICTIONS, "input_sha256": CASES,
        "independent_final_holdout_used": False, "readiness_claim": False,
        "ready_for_chat": False, "experimentalReady": False, "model_ready": False, "production_ready": False,
        "judgment_policy": "Same semantic policy as v1: coherent relevant replies can pass without target-wording equality; explicit copying, values, formatting and requested translation language must be respected. Unfinished or incoherent replies fail.",
        "aggregate": aggregate(values), "by_language": current_by_language,
        "by_category": {category: aggregate(row for row in values if row["category"] == category) for category in sorted({row["category"] for row in values})},
        "by_group": {group: aggregate(row for row in values if row["group"] == group) for group in ("authored_validation", "systematic_validation")},
        "observations": {
            "exact_hello_outputs": sum(row.get("text", "").strip().casefold() == "hello" for row in predictions),
            "unfinished_outputs": sum(row.get("finished") is not True for row in predictions),
            "generation_errors": sum(bool(row.get("error")) for row in predictions),
            "successful_memory": sum(row["passed"] for row in values if row["category"] == "memory"),
            "successful_corrections": sum(row["passed"] for row in values if row["category"] == "correction"),
            "successful_exact_copy": sum(row["passed"] for row in values if row["category"] == "copy"),
        },
        "comparison_v1": {
            "previous_checkpoint_sha256": old["checkpoint_sha256"], "previous_review_sha256": digest(old_path),
            "previous_passed": old["aggregate"]["passed"], "current_passed": len(current_pass),
            "passed_delta": len(current_pass) - len(old_pass), "newly_passed": sorted(current_pass - old_pass),
            "regressed": sorted(old_pass - current_pass), "still_passed": sorted(old_pass & current_pass),
            "by_language": {lang: {"previous_passed": old["by_language"][lang]["passed"],
                                    "current_passed": current_by_language[lang]["passed"],
                                    "delta": current_by_language[lang]["passed"] - old["by_language"][lang]["passed"]} for lang in ("ar", "en")},
            "interpretation": "English memory and copying improve, but Arabic loses its prior three exact-copy successes and authored conversation remains almost entirely unsuccessful. The one-case aggregate increase does not establish useful chat readiness.",
        },
        "diagnosis": [
            "The previous exact hello collapse is gone, but longer and more varied sentences often contain incorrect definitions, irrelevant content, or repetition.",
            "English recalls three unchanged references, yet all sampled corrections still return old values.",
            "Arabic has no successful reviewed case and often degenerates into repeated unrelated words or fails requested English translations.",
            "Only one of 60 authored natural-dialogue development prompts succeeds; six additional passes are systematic English memory/copy cases.",
            "These observations show poor usable generation; they do not isolate data, optimization, architecture, tokenizer, or decoding as the sole cause.",
        ],
        "recommendations": [
            "Keep v2b unpromoted; no phone activation and no consumption of the frozen independent holdout.",
            "Use these results for development diagnosis only. Check coherent generation on train and validation examples, prompt/target alignment, and Arabic tokenization/coverage before further broad runs.",
            "Require a substantial improvement in coherent bilingual dialogue and correction handling rather than relying on reduced validation loss or increased response length.",
        ],
        "reviews": reviews,
    }
    with (candidate_dir / "development-review.json").open("x", encoding="utf-8") as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    return {key: result[key] for key in ("checkpoint_sha256", "aggregate", "by_language", "by_group", "observations", "ready_for_chat")}


if __name__ == "__main__":
    print(json.dumps(main(), ensure_ascii=False, indent=2))
