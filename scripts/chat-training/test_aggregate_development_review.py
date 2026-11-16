import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

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


if __name__ == "__main__":
    unittest.main()
