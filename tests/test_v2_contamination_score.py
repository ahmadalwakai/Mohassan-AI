import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from score_contamination import (
    BASELINE,
    COLLECTOR_SHA256,
    MANIFEST_SHA256,
    PAYLOAD_SHA256,
    read_receipt,
    score_exposure,
    score_pair,
)


class ScorePairTest(unittest.TestCase):
    def setUp(self):
        self.baseline = {
            "one": {"area": "refusal", "language": "en", "passed": False},
            "two": {"area": "refusal", "language": "ar", "passed": False},
            "three": {"area": "factual", "language": "en", "passed": True},
            "four": {"area": "factual", "language": "ar", "passed": True},
        }
        self.candidate = {
            key: {**row, "passed": key != "three"} for key, row in self.baseline.items()
        }

    def test_clean_subset_preserves_paired_gains_and_losses(self):
        report = score_pair(self.baseline, self.candidate, ["two"])
        self.assertEqual(report["all"]["net"], 1)
        self.assertEqual(report["excluded"]["net"], 1)
        self.assertEqual(report["clean"], {
            "cases": 3, "baselinePassed": 2, "candidatePassed": 2,
            "gains": 1, "losses": 1, "net": 0, "netPercentagePoints": 0.0,
        })
        self.assertEqual(report["percentOfFullNetRetained"], 0.0)
        self.assertEqual(report["cleanByArea"]["refusal"]["net"], 1)
        self.assertEqual(report["cleanByArea"]["factual"]["net"], -1)

    def test_empty_clean_subset_has_no_rate(self):
        report = score_pair(self.baseline, self.candidate, list(self.baseline))
        self.assertEqual(report["clean"]["cases"], 0)
        self.assertIsNone(report["clean"]["netPercentagePoints"])

    def test_rejects_repeated_unknown_and_non_array_exclusions(self):
        for excluded in (["one", "one"], ["missing"], "one"):
            with self.subTest(excluded=excluded), self.assertRaises(ValueError):
                score_pair(self.baseline, self.candidate, excluded)

    def test_rejects_mismatched_paired_cases(self):
        with self.assertRaisesRegex(ValueError, "different case IDs"):
            score_pair(self.baseline, {}, [])
        self.candidate["one"]["language"] = "ar"
        with self.assertRaisesRegex(ValueError, "disagree on case metadata"):
            score_pair(self.baseline, self.candidate, [])

    def test_reports_fit_only_and_combined_exposure(self):
        report = score_exposure(self.baseline, self.candidate, ["one", "three"], ["one"])
        self.assertEqual(report["clean"]["net"], 1)
        self.assertEqual(report["fitOnly"]["clean"]["net"], 0)
        with self.assertRaisesRegex(ValueError, "Fit exclusions must be included"):
            score_exposure(self.baseline, self.candidate, ["one"], ["two"])


class ReadReceiptTest(unittest.TestCase):
    def test_checks_seal_provenance_and_receipt_counts(self):
        receipt = {
            "schemaVersion": 1,
            "partition": "v2-sealed",
            "payloadSha256": PAYLOAD_SHA256,
            "manifestSha256": MANIFEST_SHA256,
            "source": {
                "gitCommit": BASELINE,
                "trackedWorktreeClean": True,
                "baselineVerified": True,
                "harnessSha256": {"collect-paired-outcomes.ts": COLLECTOR_SHA256},
            },
            "outcomes": [{"id": str(number), "passed": False} for number in range(1200)],
            "summary": {"overall": {"total": 1200, "passed": 0}},
            "startedAt": "start",
            "finishedAt": "finish",
            "runtime": {},
        }
        with TemporaryDirectory() as directory:
            directory = Path(directory)
            path = directory / "baseline.paired.json"
            path.write_text(json.dumps(receipt), encoding="utf-8")
            self.assertEqual(len(read_receipt(directory, "baseline", BASELINE)[0]), 1200)
            with self.assertRaisesRegex(ValueError, "unexpected evaluation provenance"):
                read_receipt(directory, "baseline", "wrong-commit")

            receipt["outcomes"][1]["id"] = receipt["outcomes"][0]["id"]
            path.write_text(json.dumps(receipt), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "inconsistent outcomes"):
                read_receipt(directory, "baseline", BASELINE)


if __name__ == "__main__":
    unittest.main()
