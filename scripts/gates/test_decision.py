from __future__ import annotations

import unittest

from .common import GateError
from .decision import cohen_kappa, decide, mcnemar_exact, validate_rule, wilson


class StatisticsTests(unittest.TestCase):
    def test_wilson_reference_intervals(self):
        self.assertIsNone(wilson(0, 0))
        for passed, total, reference in (
            (5, 10, (0.236593090512564, 0.763406909487436)),
            (0, 10, (0.0, 0.277532799862889)),
            (10, 10, (0.722467200137111, 1.0)),
            (15, 20, (0.531299122381256, 0.888138298592334)),
        ):
            with self.subTest(passed=passed, total=total):
                for actual, expected in zip(wilson(passed, total), reference):
                    self.assertAlmostEqual(actual, expected, places=14)

    def test_exact_mcnemar_reference_probabilities(self):
        self.assertEqual(mcnemar_exact(0, 0), 1.0)
        self.assertEqual(mcnemar_exact(10, 9), 1.0)
        self.assertEqual(mcnemar_exact(10, 2), 0.03857421875)
        self.assertEqual(mcnemar_exact(2, 10), 0.03857421875)
        self.assertEqual(mcnemar_exact(6, 0), 0.03125)

    def test_binary_kappa(self):
        both_pass, first_only, second_only, both_fail = 20, 5, 10, 15
        first = [True] * (both_pass + first_only) + [False] * (second_only + both_fail)
        second = [True] * both_pass + [False] * first_only + [True] * second_only + [False] * both_fail
        self.assertEqual(cohen_kappa(first, second), 0.4)
        self.assertEqual(cohen_kappa([False, True], [True, False]), -1.0)
        self.assertEqual(cohen_kappa([False, True], [False, True]), 1.0)
        self.assertIsNone(cohen_kappa([True, True], [True, True]))
        with self.assertRaises(GateError):
            cohen_kappa([True], [])


class RuleTests(unittest.TestCase):
    def setUp(self):
        self.cases = [
            {"id": key, "language": language, "category": category}
            for key, language, category in (
                ("a", "ar", "greeting"), ("b", "ar", "copy"),
                ("c", "en", "greeting"), ("d", "en", "copy"),
            )
        ]
        self.passed = {"a": True, "b": False, "c": True, "d": False}
        self.no_test = {"name": "none"}

    def test_scope_wilson_and_zero_category_rules(self):
        rule = {
            "test": self.no_test,
            "minimum_counts": {"overall": 4, "languages": {"ar": 2, "en": 2}, "categories": {"copy": 2}},
            "minimum_passes": {"overall": 2, "languages": {"ar": 1}},
            "minimum_pass_rate": {"categories": {"greeting": 0.99}},
            "minimum_wilson_lower": {"languages": {"en": 0.09}},
            "no_zero_pass_categories": True,
        }
        validate_rule(rule, "generation", False)
        report = decide(rule, self.cases, self.passed, None, None)
        self.assertEqual(report["decision"], "stop")
        self.assertEqual([reason["rule"] for reason in report["reasons"]], ["no_zero_pass_categories"])
        self.assertEqual(report["reasons"][0]["categories"], ["copy"])
        self.assertEqual(report["counts"]["languages"]["ar"]["passed"], 1)
        self.assertEqual(report["counts"]["categories"]["copy"]["wilson_95"][0], 0)

        rule["no_zero_pass_categories"] = False
        self.assertEqual(decide(rule, self.cases, self.passed, None, None)["decision"], "pass")
        rule["minimum_wilson_lower"]["languages"]["en"] = 0.1
        self.assertEqual(decide(rule, self.cases, self.passed, None, None)["decision"], "stop")

    def test_minimum_totals_and_missing_groups_yield_inconclusive(self):
        rule = {
            "test": self.no_test, "minimum_counts": {"overall": 5},
            "minimum_passes": {"languages": {"ar": 2, "fr": 1}},
        }
        report = decide(rule, self.cases, self.passed, None, None)
        self.assertEqual(report["decision"], "inconclusive")
        self.assertEqual([reason["rule"] for reason in report["reasons"]],
                         ["minimum_counts.overall", "minimum_passes.languages.fr"])

    def test_exact_test_requires_strict_significance_and_improvement(self):
        cases = [{"id": str(index), "language": "ar", "category": "greeting"} for index in range(6)]
        all_right = {case["id"]: True for case in cases}
        all_wrong = dict.fromkeys(all_right, False)
        rule = {"test": {"name": "mcnemar_exact", "alpha": 0.03125}}
        validate_rule(rule, "generation", True)
        expected = {"pairs": 6, "candidate_only": 6, "baseline_only": 0, "p_value": 0.03125}
        report = decide(rule, cases, all_right, all_wrong, None)
        self.assertEqual(report["mcnemar"], expected)
        self.assertEqual(report["decision"], "stop")
        rule["test"]["alpha"] = 0.05
        self.assertEqual(decide(rule, cases, all_right, all_wrong, None)["decision"], "pass")
        self.assertEqual(decide(rule, cases, all_wrong, all_right, None)["decision"], "stop")

    def test_classifier_calibration_and_router_hard_stop(self):
        rule = {
            "test": self.no_test, "minimum_counts": {"overall": 5},
            "classifier": {"ece_bins": 10, "max_ece": 0.09, "max_wrong_confidence": 0.8, "router": True},
        }
        passed = {"a": False, "b": True, "c": False, "d": True}
        observations = {
            key: {"confidence": confidence, "never_web_violation": violation}
            for key, confidence, violation in (
                ("a", 0.0, True), ("b", 0.3, False), ("c", 0.3, False), ("d", 1.0, False),
            )
        }
        validate_rule(rule, "classifier", False)
        report = decide(rule, self.cases, passed, None, observations)
        self.assertEqual(report["metrics"]["accuracy"], 0.5)
        self.assertAlmostEqual(report["metrics"]["expected_calibration_error"], 0.1)
        self.assertEqual(report["metrics"]["never_web_violations"], 1)
        self.assertEqual([bucket["index"] for bucket in report["metrics"]["calibration_bins"]], [0, 3, 9])
        self.assertEqual(report["decision"], "stop")
        self.assertEqual([reason["rule"] for reason in report["reasons"]], ["classifier.router", "minimum_counts.overall"])

        observations["a"]["never_web_violation"] = False
        rule["minimum_counts"]["overall"] = 4
        report = decide(rule, self.cases, passed, None, observations)
        self.assertEqual(report["decision"], "stop")
        self.assertEqual([reason["rule"] for reason in report["reasons"]], ["classifier.max_ece"])
        rule["classifier"]["max_ece"] = 0.11
        self.assertEqual(decide(rule, self.cases, passed, None, observations)["decision"], "pass")

        observations["a"]["confidence"] = 0.8
        rule["classifier"].pop("max_ece")
        report = decide(rule, self.cases, passed, None, observations)
        self.assertEqual(report["decision"], "stop")
        self.assertEqual(report["reasons"][0]["rule"], "classifier.max_wrong_confidence")
        self.assertEqual(report["reasons"][0]["case_ids"], ["a"])

    def test_rejects_malformed_rule_and_partial_coverage(self):
        for rule in (
            {"test": self.no_test, "min_count": 1},
            {"test": self.no_test, "minimum_counts": {"overall": 2}},
            {"test": self.no_test, "minimum_passes": {"overall": True}},
            {"test": self.no_test, "minimum_pass_rate": {"overall": 1.1}},
            {"test": self.no_test, "minimum_passes": {"languages": {}}},
            {"test": self.no_test, "minimum_passes": {"overall": 1}, "classifier": {"ece_bins": 10}},
            {"test": {"name": "mcnemar_exact", "alpha": 0.05}},
        ):
            with self.subTest(rule=rule), self.assertRaises(GateError):
                validate_rule(rule, "generation", False)
        with self.assertRaises(GateError):
            validate_rule({"test": self.no_test, "classifier": {"ece_bins": 0, "router": True}}, "classifier", False)
        with self.assertRaises(GateError):
            decide({"test": self.no_test}, self.cases, self.passed, {"a": False}, None)
        with self.assertRaises(GateError):
            decide({"test": self.no_test}, self.cases, {"a": False}, None, None)
