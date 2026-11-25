from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from scripts.gates.adapters import prepare, validate_cases
from scripts.gates.common import GateError


FIXTURES = Path(__file__).parent / "fixtures"
DIGEST = "a" * 64
SETTINGS = {"eos_rule": "require_eos", "max_tokens": 10}
ROUTER = {"classifier": {"router": True}}


def fixture(adapter, name):
    return [json.loads(line) for line in (FIXTURES / adapter / name).read_text(encoding="utf-8").splitlines()]


def run(adapter, cases, rows, *, root=FIXTURES, rule=None, settings=SETTINGS, baseline=False):
    rule = {} if rule is None else rule
    validate_cases(adapter, cases, rule)
    return prepare(adapter, cases, rows, root, rule, DIGEST, settings, baseline=baseline)


class GenerationAdapterTests(unittest.TestCase):
    def setUp(self):
        self.cases = fixture("generation", "cases.jsonl")
        self.rows = fixture("generation", "predictions.jsonl")

    def test_accepts_current_prediction_shape_and_removes_system_framing(self):
        self.rows[0]["checkpoint_sha256"] = DIGEST
        result = run("generation", self.cases, self.rows)
        self.assertEqual(result["eligible"], {"gen-ar": True, "gen-en": True})
        self.assertEqual(set(result["items"]["gen-ar"]), {"prompt", "text", "finished"})
        self.assertEqual(result["items"]["gen-en"]["messages"], [
            {"role": "user", "content": "What is 3 + 5? Reply with the numeral alone."},
        ])
        self.assertNotIn("Fixture", str(result["items"]))

    def test_rejects_wrong_checkpoint_budget_and_stop_reason(self):
        for changes in (
            {"checkpoint_sha256": "b" * 64},
            {"output_tokens": 11},
            {"output_tokens": True},
            {"stop_reason": "length"},
            {"stop_reason": None},
            {"finished": 1},
        ):
            with self.subTest(changes=changes), self.assertRaises(GateError):
                run("generation", self.cases, [{**self.rows[0], **changes}, self.rows[1]])

    def test_rejects_duplicate_missing_and_unknown_predictions(self):
        for rows in (self.rows[:1], self.rows + self.rows[:1], [{**self.rows[0], "id": "other"}, self.rows[1]]):
            with self.subTest(rows=rows), self.assertRaises(GateError):
                run("generation", self.cases, rows)

    def test_error_empty_and_invalid_utf8_cannot_pass(self):
        for changes in ({"error": "failed"}, {"text": " "}, {"text": "\ufffd"}, {"utf8_decode_replacement": True}):
            with self.subTest(changes=changes):
                result = run("generation", self.cases, [{**self.rows[0], **changes}, self.rows[1]])
                self.assertFalse(result["eligible"]["gen-ar"])

    def test_accepts_token_limit_only_when_registered_and_observed(self):
        limited = {**self.rows[0], "finished": False, "stop_reason": "length", "output_tokens": 10}
        self.assertFalse(run("generation", self.cases, [limited, self.rows[1]])["eligible"]["gen-ar"])
        allowed = {**SETTINGS, "eos_rule": "allow_token_limit"}
        self.assertTrue(run("generation", self.cases, [limited, self.rows[1]], settings=allowed)["eligible"]["gen-ar"])
        for row in ({**limited, "stop_reason": "stop_token"}, {**limited, "output_tokens": 9},
                    {**self.rows[0], "finished": False}):
            with self.subTest(row=row):
                self.assertFalse(run("generation", self.cases, [row, self.rows[1]], settings=allowed)["eligible"]["gen-ar"])


class AgentAdapterTests(unittest.TestCase):
    def setUp(self):
        self.cases = fixture("agent", "cases.jsonl")
        self.rows = fixture("agent", "predictions.jsonl")
        self.root = FIXTURES / "agent"

    def test_completion_and_refusal_stay_distinct_from_false_claim(self):
        result = run("agent", self.cases, self.rows, root=self.root)
        self.assertEqual(result["eligible"], {"task-ar": True, "task-en-refusal": True, "task-en-missing": False})
        self.assertEqual(result["outcomes"], {
            "task-ar": "completed",
            "task-en-refusal": "refused",
            "task-en-missing": "missing_or_wrong_final_state",
        })
        self.assertTrue(result["items"]["task-ar"]["output_openable"])
        self.assertFalse(result["items"]["task-en-missing"]["output_openable"])
        self.assertEqual(result["items"]["task-ar"]["output_preview"], "عدد السجلات: ١\n")
        self.assertNotIn("final-state.json", str(result["items"]))
        self.assertNotIn("output.txt", str(result["items"]))
        expected = {str(self.root / name): hashlib.sha256((self.root / name).read_bytes()).hexdigest()
                    for name in ("final-state.json", "output.txt")}
        self.assertEqual({item["path"]: item["sha256"] for item in result["evidence"]}, expected)

    def test_matching_state_without_openable_output_fails(self):
        for path in (None, "missing.txt", "../generation/cases.jsonl", str(self.root / "output.txt"), "."):
            with self.subTest(path=path):
                row = {**self.rows[0], "output_file": path}
                result = run("agent", self.cases[:1], [row], root=self.root)
                self.assertFalse(result["eligible"]["task-ar"])
                self.assertEqual(result["outcomes"]["task-ar"], "missing_or_unopenable_output")
                self.assertTrue(result["items"]["task-ar"]["final_state_matches"])

    def test_structured_state_must_match_exactly(self):
        case, row = self.cases[0], self.rows[0]
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            (root / "output.txt").write_text("fixture", encoding="utf-8")
            for invalid in ('{"record_count":true,"saved":true}', '{"record_count":1,"saved":1}',
                            '{"record_count":1,"saved":true,"extra":4}', '{"record_count":1,"saved":true,"saved":false}'):
                with self.subTest(invalid=invalid):
                    (root / "final-state.json").write_text(invalid, encoding="utf-8")
                    self.assertFalse(run("agent", [case], [row], root=root)["eligible"]["task-ar"])

    def test_openability_checks_frozen_output_format(self):
        row = self.rows[0]
        cases = [
            ("text", b"", False),
            ("text", b"\xff", False),
            ("text", b" ", False),
            ("text", b"x\x00y", False),
            ("json", b"{", False),
            ("json", b'{"test":false}', True),
            ("csv", b'header\n"unclosed', False),
            ("csv", b'header\n"entry"\n', True),
        ]
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            (root / "final-state.json").write_bytes((self.root / "final-state.json").read_bytes())
            for output_format, content, openable in cases:
                with self.subTest(output_format=output_format, content=content):
                    case = {**self.cases[0], "output_format": output_format}
                    (root / "output.txt").write_bytes(content)
                    result = run("agent", [case], [row], root=root)
                    self.assertEqual(result["eligible"]["task-ar"], openable)
                    # Readable malformed and empty files are still pinned as evidence.
                    self.assertEqual(len(result["evidence"]), 2)

    def test_unverifiable_output_format_is_rejected(self):
        case = {**self.cases[0], "output_format": "binary"}
        with self.assertRaisesRegex(GateError, "output_format"):
            run("agent", [case], self.rows[:1], root=self.root)

    def test_symbolic_evidence_link_fails(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            (root / "final-state.json").write_bytes((self.root / "final-state.json").read_bytes())
            (root / "other.txt").write_text("fixture", encoding="utf-8")
            try:
                (root / "output.txt").symlink_to(root / "other.txt")
            except (NotImplementedError, OSError):
                self.skipTest("Symbolic links are unavailable.")
            self.assertFalse(run("agent", self.cases[:1], self.rows[:1], root=root)["eligible"]["task-ar"])

    def test_refusal_requires_the_frozen_outcome_and_no_output_claim(self):
        row = {**self.rows[1], "output_file": "output.txt"}
        self.assertFalse(run("agent", [self.cases[1]], [row], root=self.root)["eligible"]["task-en-refusal"])
        mismatch = {**self.rows[0], "status": "refused"}
        self.assertFalse(run("agent", self.cases[:1], [mismatch], root=self.root)["eligible"]["task-ar"])

    def test_completion_requirements_must_be_frozen(self):
        for changes in ({"expected_final_state": {}}, {"output_format": "unknown"}, {"request": ""}):
            with self.subTest(changes=changes), self.assertRaises(GateError):
                run("agent", [{**self.cases[0], **changes}], self.rows[:1], root=self.root)


class ClassifierAdapterTests(unittest.TestCase):
    def setUp(self):
        self.cases = fixture("classifier", "cases.jsonl")
        self.rows = fixture("classifier", "predictions.jsonl")

    def test_observations_use_ground_truth_and_top_label_confidence(self):
        result = run("classifier", self.cases, self.rows, rule=ROUTER)
        self.assertTrue(all(result["eligible"].values()))
        self.assertEqual(result["observations"]["head-ar-1"], {"confidence": 0.9, "never_web_violation": False})
        self.assertEqual(result["items"], {})

    def test_router_protection_cannot_be_waived_and_can_add_frozen_labels(self):
        row = {**self.rows[0], "label": "web_search"}
        for case in ({**self.cases[0], "never_web": False}, {**self.cases[0], "label": "local", "never_web": True}):
            with self.subTest(case=case):
                result = run("classifier", [case], [row], rule=ROUTER)
                self.assertTrue(result["observations"]["head-ar-1"]["never_web_violation"])
                self.assertFalse(result["eligible"]["head-ar-1"])
        result = run("classifier", self.cases[:1], [row])
        self.assertFalse(result["observations"]["head-ar-1"]["never_web_violation"])

    def test_rule_baseline_can_omit_confidence(self):
        baseline = fixture("classifier", "baseline.jsonl")
        result = run("classifier", self.cases, baseline, rule=ROUTER, baseline=True)
        self.assertFalse(any(result["eligible"].values()))
        self.assertIsNone(result["observations"]["head-ar-1"]["confidence"])
        with self.assertRaises(GateError):
            run("classifier", self.cases, baseline, rule=ROUTER)

    def test_classifier_confidence_and_safety_annotations_require_valid_types(self):
        for confidence in (-0.01, 1.01, float("nan"), True, "0.9", None):
            with self.subTest(confidence=confidence), self.assertRaises(GateError):
                run("classifier", self.cases[:1], [{**self.rows[0], "confidence": confidence}], rule=ROUTER)
        with self.assertRaises(GateError):
            run("classifier", [{**self.cases[0], "never_web": True}], self.rows[:1])


if __name__ == "__main__":
    unittest.main()
