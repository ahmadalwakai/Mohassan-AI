import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("review_aggregate", Path(__file__).with_name("aggregate_development_review.py"))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class DevelopmentReviewTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.case = {"id": "one", "language": "ar", "development_group": "v3_validation", "category": "memory"}
        self.prediction = {"id": "one", "text": "test", "finished": True, "checkpoint_sha256": "a" * 64}
        self.judgment = {"passed": True, "reason": "Meets the request."}

    def prepare(self):
        cases, predictions, review = [self.root / name for name in ("cases.jsonl", "predictions.jsonl", "review.json")]
        cases.write_text(json.dumps(self.case) + "\n", encoding="utf-8")
        predictions.write_text(json.dumps(self.prediction) + "\n", encoding="utf-8")
        pins = {"input_sha256": MODULE.digest(cases), "predictions_sha256": MODULE.digest(predictions), "checkpoint_sha256": "a" * 64}
        predictions.with_suffix(".manifest.json").write_text(json.dumps(pins), encoding="utf-8")
        review.write_text(json.dumps({**pins, "reviewer": "test", "reviews": {"one": self.judgment}}), encoding="utf-8")
        return cases, predictions, review

    def test_summary_cannot_approve_phone(self):
        result = MODULE.aggregate(*self.prepare())
        self.assertEqual(result["counts"]["overall"], {"passed": 1, "total": 1, "finished": 1})
        self.assertFalse(result["ready_for_chat"])

    def test_edited_predictions_rejected(self):
        paths = self.prepare()
        paths[1].write_text(paths[1].read_text() + "\n", encoding="utf-8")
        with self.assertRaises(ValueError):
            MODULE.aggregate(*paths)

    def test_unfinished_pass_rejected(self):
        self.prediction["finished"] = False
        with self.assertRaises(ValueError):
            MODULE.aggregate(*self.prepare())

    def test_generation_error_stays_in_denominator(self):
        self.prediction = {"id": "one", "text": "", "finished": False, "error": "context"}
        self.judgment = {"passed": False, "reason": "Generation failed."}
        result = MODULE.aggregate(*self.prepare())
        self.assertEqual(result["counts"]["overall"], {"passed": 0, "total": 1, "finished": 0})

    def test_holdout_cannot_be_mislabeled_development(self):
        self.case.pop("development_group")
        with self.assertRaises(ValueError):
            MODULE.aggregate(*self.prepare())

    def prepare_v4(self, passes):
        cases, predictions, review = [self.root / name for name in ("cases.jsonl", "predictions.jsonl", "review.json")]
        case_rows, prediction_rows, judgments = [], [], {}
        for language in MODULE.V4_LANGUAGES:
            for category in MODULE.V4_CATEGORIES:
                for index in range(10):
                    case_id = f"{language}-{category}-{index}"
                    case_rows.append({"id": case_id, "language": language, "category": category,
                                      "development_group": MODULE.V4_GROUP})
                    prediction_rows.append({**self.prediction, "id": case_id})
                    judgments[case_id] = {**self.judgment, "passed": passes(language, category, index)}
        for path, rows in ((cases, case_rows), (predictions, prediction_rows)):
            path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
        pins = {"input_sha256": MODULE.digest(cases), "predictions_sha256": MODULE.digest(predictions),
                "checkpoint_sha256": self.prediction["checkpoint_sha256"]}
        predictions.with_suffix(".manifest.json").write_text(json.dumps({**pins, "cases": 200,
            "decoding": "greedy", "max_tokens": 192}), encoding="utf-8")
        review.write_text(json.dumps({**pins, "reviewer": "test", "reviews": judgments}), encoding="utf-8")
        return cases, predictions, review

    def test_v4_development_pass_does_not_approve_chat(self):
        paths = self.prepare_v4(lambda language, category, index: index < 6)
        with patch.object(MODULE, "V4_CASES_SHA256", MODULE.digest(paths[0])):
            result = MODULE.aggregate(*paths)
        self.assertTrue(result["gate5"]["passed"])
        self.assertEqual(result["counts"]["overall"], {"passed": 120, "total": 200, "finished": 200})
        self.assertEqual(result["counts"]["language_category:ar:correction"]["passed"], 6)
        self.assertFalse(result["ready_for_chat"])

    def test_v4_total_language_and_category_criteria_each_matter(self):
        scenarios = (
            (lambda language, category, index: index < 5 or category == "copy",
             False, [], []),
            (lambda language, category, index: language == "en" or index < 5,
             True, ["ar"], []),
            (lambda language, category, index: category != "clarification",
             True, [], ["clarification"]),
        )
        for passes, overall, languages, categories in scenarios:
            with self.subTest(overall=overall, languages=languages, categories=categories):
                paths = self.prepare_v4(passes)
                with patch.object(MODULE, "V4_CASES_SHA256", MODULE.digest(paths[0])):
                    gate = MODULE.aggregate(*paths)["gate5"]
                self.assertFalse(gate["passed"])
                self.assertEqual(gate["overall_passed"], overall)
                self.assertEqual(gate["languages_below_minimum"], languages)
                self.assertEqual(gate["categories_at_zero"], categories)

    def test_v4_rejects_a_new_case_file_even_when_predictions_and_review_match_it(self):
        paths = self.prepare_v4(lambda language, category, index: True)
        with self.assertRaisesRegex(ValueError, "does not match the frozen set"):
            MODULE.aggregate(*paths)


if __name__ == "__main__":
    unittest.main()
