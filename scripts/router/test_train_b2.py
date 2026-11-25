"""Regression checks for the public router split and route metrics."""
from __future__ import annotations

import json
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

import train
from train import ROUTES, ROUTE_ID, WRITTEN_REPEAT
from train_b2 import score, select


def write_rows(path: Path, rows: list[dict[str, str]]) -> None:
    path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")


class PublicSplitTests(unittest.TestCase):
    def setUp(self) -> None:
        resources = ExitStack()
        self.addCleanup(resources.close)
        directory = Path(resources.enter_context(tempfile.TemporaryDirectory()))
        self.massive = directory / "massive"
        self.massive.mkdir()
        self.written = directory / "written.jsonl"
        resources.enter_context(patch.object(train, "MASSIVE", self.massive))
        resources.enter_context(patch.object(train, "WRITTEN", self.written))
        resources.enter_context(patch.object(train, "SEALED", directory / "never-read.jsonl"))

        write_rows(self.written, [
            {"text": "Frozen dev fixture", "route": "chat"},
            {"text": "FROZEN DEV FIXTURE", "route": "chat"},
            {"text": "Keep my notes", "route": "memory"},
        ])

    def test_frozen_written_split_hashes_raw_text_and_repeats_train_only(self) -> None:
        written_train = [("FROZEN DEV FIXTURE", ROUTE_ID["chat"]), ("Keep my notes", ROUTE_ID["memory"])]
        written_dev = [("Frozen dev fixture", ROUTE_ID["chat"])]
        self.assertEqual(train.load_written(), (written_train, written_dev))

        splits = train.load_public(use_massive=False)
        self.assertEqual(splits, {
            "train": [row for row in written_train for _ in range(WRITTEN_REPEAT)],
            "dev": written_dev,
            "massive_test": [],
        })

    def test_massive_official_dev_joins_train_and_official_test_stays_held_out(self) -> None:
        for locale, texts in (
            ("ar-SA", ("الطقس اليوم", "أضف موعدا", "ما أخبار اليوم؟")),
            ("en-US", ("Today's weather", "Make an appointment", "Today's headlines")),
        ):
            write_rows(self.massive / f"{locale}.jsonl", [
                {"utt": texts[0], "intent": "weather_query", "partition": "train"},
                {"utt": texts[1], "intent": "calendar_set", "partition": "dev"},
                {"utt": texts[2], "intent": "news_query", "partition": "test"},
            ])

        expected_train = [
            ("الطقس اليوم", ROUTE_ID["web_search"]), ("أضف موعدا", ROUTE_ID["reminder"]),
            ("Today's weather", ROUTE_ID["web_search"]), ("Make an appointment", ROUTE_ID["reminder"]),
        ]
        expected_test = [("ما أخبار اليوم؟", ROUTE_ID["news"]), ("Today's headlines", ROUTE_ID["news"])]
        self.assertEqual(train.load_massive(), (expected_train, expected_test))

        written = train.load_public(use_massive=False)
        self.assertEqual(train.load_public(), {
            "train": expected_train + written["train"],
            "dev": written["dev"],
            "massive_test": expected_test,
        })

    def test_massive_is_required_by_default(self) -> None:
        with self.assertRaises(FileNotFoundError):
            train.load_public()


class RouteMetricsTests(unittest.TestCase):
    def test_counts_per_route_and_only_never_web_misses_into_web(self) -> None:
        labels = ["memory", "reminder", "pc", "ads", "chat", "memory", "news"]
        outputs = ["web_search", "web_search", "web_search", "web_search", "web_search", "memory", "news"]
        rows = [(f"fixture {i}", ROUTE_ID[route]) for i, route in enumerate(labels)]
        metrics = score([ROUTE_ID[route] for route in outputs], rows)

        self.assertAlmostEqual(metrics["accuracy"], 2 / 7)
        self.assertEqual(set(metrics["per_route"]), set(ROUTES))
        self.assertEqual(metrics["per_route"]["memory"], {"correct": 1, "total": 2, "accuracy": 0.5})
        self.assertEqual(metrics["per_route"]["chat"], {"correct": 0, "total": 1, "accuracy": 0.0})
        self.assertEqual(metrics["per_route"]["image"], {"correct": 0, "total": 0, "accuracy": None})
        self.assertEqual(metrics["never_web_sent_to_web"], 4)

    def test_empty_test_set_has_no_accuracy(self) -> None:
        metrics = score([], [])
        self.assertIsNone(metrics["accuracy"])
        self.assertEqual(metrics["never_web_sent_to_web"], 0)
        self.assertTrue(all(stats == {"correct": 0, "total": 0, "accuracy": None}
                            for stats in metrics["per_route"].values()))

    def test_prediction_count_must_match_labels(self) -> None:
        with self.assertRaises(ValueError):
            score([], [("Fixture", ROUTE_ID["chat"])])

    def test_selection_uses_dev_accuracy_then_never_web_misses(self) -> None:
        self.assertEqual(select({
            "b0": {"accuracy": 0.6, "never_web_sent_to_web": 0},
            "better": {"accuracy": 0.7, "never_web_sent_to_web": 2},
            "fewer_misses": {"accuracy": 0.7, "never_web_sent_to_web": 1},
            "later_tie": {"accuracy": 0.7, "never_web_sent_to_web": 1},
        }), "fewer_misses")


if __name__ == "__main__":
    unittest.main()
