"""Acceptance and adversarial tests for the evaluator, using only synthetic fixtures."""
from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from build_holdout import build_cases, freeze
from evaluate_chat import evaluate, score_case


class ChatEvaluatorTest(unittest.TestCase):
    def setUp(self):
        self.cases = build_cases()

    def case(self, language: str, category: str, index: int = 0):
        return [row for row in self.cases if row["language"] == language and row["category"] == category][index]

    def prediction(self, text: str, finished=True):
        return {"text": text, "finished": finished}

    def test_frozen_inventory_balanced_and_prompts_are_histories(self):
        self.assertEqual(len(self.cases), 60)
        self.assertEqual(sum(row["language"] == "ar" for row in self.cases), 30)
        self.assertEqual(sum(row["evaluation"]["mode"] == "manual" for row in self.cases), 12)
        self.assertTrue(all(row["trainingAllowed"] is False for row in self.cases))
        for row in self.cases:
            self.assertTrue(row["prompt"].endswith("\nAssistant:\n"))
            self.assertEqual(row["messages"][-1]["role"], "user")

    def test_copying_requires_exact_identifier_not_explanation(self):
        case = self.case("en", "instruction")
        self.assertTrue(score_case(case, self.prediction("Q8-V3"))["passed"])
        self.assertFalse(score_case(case, self.prediction("The identifier is Q8-V3."))["passed"])
        self.assertFalse(score_case(case, self.prediction("Q8-V4"))["passed"])

    def test_context_uses_corrected_destination_not_earlier_one(self):
        case = self.case("ar", "context", 1)
        self.assertTrue(score_case(case, self.prediction("صلالة"))["passed"])
        self.assertFalse(score_case(case, self.prediction("إربد"))["passed"])

    def test_digits_accept_arabic_numerals_but_not_wrong_number(self):
        case = self.case("ar", "stable_fact", 1)
        self.assertTrue(score_case(case, self.prediction("١٢٠"))["passed"])
        self.assertFalse(score_case(case, self.prediction("٦٠"))["passed"])

    def test_tool_denial_must_not_be_followed_by_claim_of_execution(self):
        case = self.case("en", "tool_honesty", 1)
        self.assertTrue(score_case(case, self.prediction("I cannot run commands on your computer."))["passed"])
        self.assertFalse(score_case(case, self.prediction("I cannot run commands, but I executed this one."))["passed"])
        self.assertFalse(score_case(case, self.prediction("maple"))["passed"])

    def test_unfinished_answer_fails_even_when_exact_text_matches(self):
        case = self.case("en", "instruction")
        result = score_case(case, self.prediction("Q8-V3", False))
        self.assertFalse(result["passed"])
        self.assertIn("unfinished_generation", result["reasons"])

    def test_manual_case_never_passes_without_explicit_review(self):
        case = self.case("en", "clarification")
        result = score_case(case, self.prediction("Please send the text you'd like shortened."))
        self.assertIsNone(result["passed"])
        self.assertIn("manual_review_required", result["reasons"])

    def test_wrong_language_rejected_even_if_reviewer_accepts(self):
        case = self.case("ar", "clarification")
        result = score_case(case, self.prediction("Please send the text."), {"passed": True, "reason": "Fixture review."})
        self.assertFalse(result["passed"])
        self.assertIn("wrong_language", result["reasons"])

    def fixture_files(self, root: Path):
        holdout = root / "holdout"
        manifest = freeze(holdout)
        predictions = []
        reviews = {}
        for case in self.cases:
            evaluation = case["evaluation"]
            if evaluation["mode"] == "exact":
                text = evaluation["accepted"][0]
            elif evaluation["mode"] == "concepts":
                # Fabricated acceptance fixtures, never model outputs or quality evidence.
                text = " ".join(group[0] for group in evaluation["any_groups"])
            else:
                text = "مرحبًا، يسعدني مساعدتك." if case["language"] == "ar" else "Hello, I am happy to help."
                reviews[case["id"]] = {"passed": True, "reason": "Synthetic fixture for binding tests, not a model review."}
            predictions.append({"id": case["id"], "text": text, "finished": True})
        prediction_path = root / "predictions.jsonl"
        prediction_path.write_text("\n".join(json.dumps(row, ensure_ascii=False) for row in predictions) + "\n", encoding="utf-8")
        sha = hashlib.sha256(prediction_path.read_bytes()).hexdigest()
        generation = {"checkpoint_sha256": "a" * 64, "predictions_sha256": sha, "holdout_sha256": manifest["holdout_sha256"]}
        generation_path = root / "generation.json"
        generation_path.write_text(json.dumps(generation), encoding="utf-8")
        review = {"checkpoint_sha256": "a" * 64, "predictions_sha256": sha, "reviewer": "unit-test-fixture", "reviews": reviews}
        review_path = root / "review.json"
        review_path.write_text(json.dumps(review), encoding="utf-8")
        return holdout, prediction_path, generation_path, review_path

    def test_readiness_requires_bound_review_and_generation_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            holdout, predictions, generation, review = self.fixture_files(Path(directory))
            report = evaluate(predictions, holdout=holdout)
            self.assertTrue(report["automated_gate_passed"])
            self.assertFalse(report["ready_for_chat"])
            self.assertTrue(report["requires_manual_review"])
            bound = evaluate(predictions, holdout=holdout, predictions_manifest=generation, review_path=review)
            self.assertTrue(bound["ready_for_chat"])
            self.assertEqual(bound["reviewer"], "unit-test-fixture")
            self.assertFalse(bound["production_ready"])
            document = json.loads(review.read_text())
            document["checkpoint_sha256"] = "b" * 64
            review.write_text(json.dumps(document), encoding="utf-8")
            wrong = evaluate(predictions, holdout=holdout, predictions_manifest=generation, review_path=review)
            self.assertFalse(wrong["ready_for_chat"])
            self.assertIn("review_binding_mismatch", wrong["binding_failures"])

    def test_duplicate_ids_fail_even_if_answer_was_correct(self):
        with tempfile.TemporaryDirectory() as directory:
            holdout, predictions, generation, review = self.fixture_files(Path(directory))
            first = predictions.read_text(encoding="utf-8").splitlines()[0]
            with predictions.open("a", encoding="utf-8") as stream:
                stream.write(first + "\n")
            report = evaluate(predictions, holdout=holdout, predictions_manifest=generation, review_path=review)
            self.assertFalse(report["ready_for_chat"])
            self.assertIn("invalid_prediction_ids", report["machine_failures"])
            self.assertIn("generation_predictions_digest_mismatch", report["binding_failures"])

    def test_changed_frozen_criteria_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            holdout, predictions, generation, review = self.fixture_files(Path(directory))
            (holdout / "criteria.json").write_text("{}", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "digest mismatch"):
                evaluate(predictions, holdout=holdout, predictions_manifest=generation, review_path=review)


if __name__ == "__main__":
    unittest.main()
