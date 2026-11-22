"""Unit checks for the isolated context-router development experiment.

No production data, old trainer, owner messages or assessment fixtures are read.
The only miniature model trainings below use synthetic in-memory rows.
"""
from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from unittest.mock import patch
from dataclasses import replace
from pathlib import Path
import sys

SPEC = importlib.util.spec_from_file_location("isolated_context_training", Path(__file__).with_name("train_context.py"))
TRAINER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = TRAINER
SPEC.loader.exec_module(TRAINER)
t = TRAINER


def row(identity="a", text="What is the weather in Bath?", route="web_search", partition="train", group=None, context=None):
    return t.Row(identity, group or f"g:{identity}", text, route, partition, "agent_authored_unreviewed", "en-US", context or t.Context())


class DataIntegrityTests(unittest.TestCase):
    def test_authored_families_are_fixed_and_cover_all_model_classes(self):
        rows = t.authored_rows()
        self.assertGreater(len(rows), 1000)
        self.assertEqual({item.route for item in rows if item.route != "reply"}, set(t.ROUTES))
        groups = {}
        for item in rows:
            item.validate()
            groups.setdefault(item.group_id, set()).add(item.partition)
        self.assertTrue(all(len(partitions) == 1 for partitions in groups.values()))
        self.assertEqual(len({item.id for item in rows}), len(rows))
        self.assertEqual(t.authored_rows(), rows)

    def test_authored_data_write_is_immutable_and_reproducible(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "authored.jsonl"
            first = t.write_authored_data(path)
            self.assertEqual(first, t.write_authored_data(path))
            self.assertEqual(len(t.read_authored(path)), first["rows"])
            path.write_text("{}\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "different_content"):
                t.write_authored_data(path)

    def test_translations_share_massive_identity_and_official_partition(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            for locale, text in (("ar-SA", "كم درجة الحرارة في حمص؟"), ("en-US", "What is the temperature in Bath?")):
                values = [{"id": "42", "locale": locale, "utt": text, "intent": "weather_query", "partition": "test"},
                          {"id": "43", "locale": locale, "utt": text + " tomorrow", "intent": "weather_query", "partition": "dev"}]
                (base / f"{locale}.jsonl").write_text("\n".join(json.dumps(value) for value in values), encoding="utf-8")
            loaded, excluded = t.load_massive(base)
            self.assertEqual(excluded, {})
            for identity in ("42", "43"):
                pair = [item for item in loaded if item.group_id == f"massive:{identity}"]
                self.assertEqual(len(pair), 2)
                self.assertEqual(len({item.partition for item in pair}), 1)
            self.assertEqual(loaded[0].partition, "test")

    def test_public_loader_opens_only_explicit_locale_files(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            for locale in ("ar-SA", "en-US"):
                (base / f"{locale}.jsonl").write_text(json.dumps({"id": "1", "locale": locale, "utt": "A public fixture", "intent": "weather_query", "partition": "train"}), encoding="utf-8")
            (base / "do-not-read.jsonl").write_bytes(b"not json")
            self.assertEqual(len(t.load_massive(base)[0]), 2)

    def test_unmapped_public_intents_are_counted_not_guessed(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            for locale in ("ar-SA", "en-US"):
                (base / f"{locale}.jsonl").write_text(json.dumps({"id": "1", "locale": locale, "utt": "Fixture", "intent": "not_a_known_intent", "partition": "train"}), encoding="utf-8")
            loaded, excluded = t.load_massive(base)
            self.assertEqual(loaded, [])
            self.assertEqual(excluded, {"unmapped_public_intent": 2})

    def test_malformed_provenance_context_and_text_are_rejected(self):
        for invalid in (replace(row(), origin="owner_messages"), replace(row(), text="x" * 513),
                        replace(row(), context=t.Context(source="prior_conversation", scope="public")),
                        replace(row(), context=t.Context(pending_field="budget"))):
            with self.assertRaises(ValueError):
                invalid.validate()

    def test_explicit_group_partition_conflict_is_an_error(self):
        with self.assertRaisesRegex(ValueError, "group_crosses"):
            t.prepare_splits([row("a", group="same"), row("b", text="Different text", partition="test", group="same")])

    def test_canonical_duplicates_exclude_whole_families_across_partitions(self):
        rows = [row("a", text="أهلاً ــ وسهلاً!", group="train_family"), row("b", text="Another member", group="train_family"),
                row("c", text="اهلا وسهلا", partition="test", group="test_family"), row("d", text="Independent fixture", partition="dev")]
        splits, report = t.prepare_splits(rows)
        self.assertEqual(report["excludedCollisionGroups"], 2)
        self.assertEqual([item.id for items in splits.values() for item in items], ["d"])
        t.assert_no_leakage(splits)

    def test_same_current_text_can_have_different_context_labels_in_one_group(self):
        rows = [row("a", text="Where is it?", context=t.prior("memory"), route="memory", group="contrast"),
                row("b", text="Where is it?", context=t.prior("web_search"), route="web_search", group="contrast")]
        splits, report = t.prepare_splits(rows)
        self.assertEqual(len(splits["train"]), 2)
        self.assertEqual(report["contradictoryFeatureSignatures"], 0)

    def test_identical_features_with_conflicting_labels_are_excluded(self):
        rows = [row("a", text="Ambiguous fixture", route="memory"), row("b", text="Ambiguous fixture", route="web_search")]
        splits, report = t.prepare_splits(rows)
        self.assertEqual(sum(map(len, splits.values())), 0)
        self.assertEqual(report["contradictoryFeatureSignatures"], 1)

    def test_split_assignment_and_caps_do_not_depend_on_input_order(self):
        rows = t.authored_rows()
        forward, report_a = t.prepare_splits(rows, 20)
        reverse, report_b = t.prepare_splits(list(reversed(rows)), 20)
        self.assertEqual(forward, reverse)
        self.assertEqual(report_a, report_b)

    def test_output_runs_and_files_cannot_be_overwritten_or_escape(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            run = t.create_run_directory("candidate", base)
            with self.assertRaises(FileExistsError):
                t.create_run_directory("candidate", base)
            for name in ("../router", "../candidate", "x/y", "/tmp/escape"):
                with self.assertRaises(ValueError):
                    t.create_run_directory(name, base)
            t.write_exclusive(run / "manifest.json", b"{}")
            with self.assertRaises(FileExistsError):
                t.write_exclusive(run / "manifest.json", b"changed")


class FeatureAndHostTests(unittest.TestCase):
    def test_feature_hashing_is_deterministic_and_bounded(self):
        ids = t.ngram_ids("أهلًا ــ ٢٥ × ٤", 1024)
        self.assertEqual(ids, t.ngram_ids("اهلا 25 × 4", 1024))
        self.assertTrue(all(0 <= value < 1024 for value in ids))
        self.assertEqual(len(t.context_features(t.prior("memory"))), len(t.CONTEXT_FEATURES))
        self.assertEqual(sum(t.context_features(t.prior("memory"))), 5)
        self.assertFalse(any(t.context_features(t.prior("memory"), False)))

    def test_target_partition_and_group_identity_are_not_features(self):
        a = row()
        b = replace(a, route="ads", partition="test", id="other", group_id="different")
        self.assertEqual(t.ngram_ids(a.text, 128), t.ngram_ids(b.text, 128))
        self.assertEqual(t.context_features(a.context), t.context_features(b.context))

    def test_host_gate_handles_answers_without_learning_a_reply_class(self):
        self.assertNotIn("reply", t.ROUTES)
        for text, field in (("Yes", "choice"), ("الخيار الثاني", "choice"), ("GBP 18", "budget"), ("حمص", "place")):
            self.assertTrue(t.host_pending_reply(text, t.prior("ads", True, field)))
            self.assertFalse(t.host_pending_reply(text, t.prior("ads")))
        for text in ("Calculate 8 * 9.", "احسب ٨ × ٩", "Open https://fixture.example", "What is the weather today?"):
            self.assertFalse(t.host_pending_reply(text, t.prior("ads", True, "text")))

    def test_config_rejects_excessive_cpu_memory_or_model_bounds(self):
        for config in (t.TrainConfig(threads=5), t.TrainConfig(memory_limit_mb=3000), t.TrainConfig(epochs=100),
                       t.TrainConfig(buckets=1000), t.TrainConfig(max_seconds_per_model=9999)):
            with self.assertRaises(ValueError):
                config.validate()
        t.TrainConfig().validate()

    def test_process_memory_measurement_is_available_and_finite(self):
        memory = t.resident_mb()
        self.assertGreater(memory, 0)
        self.assertLess(memory, 2048)


class ModelTests(unittest.TestCase):
    @staticmethod
    def fixture_splits():
        return {partition: [row(f"{partition}-{index}", text=f"{'Calculate' if index % 2 else 'Weather'} fixture {partition} {index}",
                               route="compute" if index % 2 else "web_search", partition=partition,
                               context=t.prior("memory") if index % 2 else t.Context()) for index in range(12)] for partition in t.PARTITIONS}

    def test_small_cpu_training_is_deterministic_and_ignores_test_labels(self):
        import torch
        config = t.TrainConfig(buckets=128, dim=8, hidden=8, epochs=2, batch_size=4, threads=1, max_seconds_per_model=30)
        splits = self.fixture_splits()
        one, _ = t.train_model(splits, config, True)
        altered = {**splits, "test": [replace(item, route="ads") for item in splits["test"]]}
        two, _ = t.train_model(altered, config, True)
        for name, tensor in one.state_dict().items():
            self.assertTrue(torch.equal(tensor, two.state_dict()[name]))

    def test_binary_export_round_trip_has_independent_numpy_parity(self):
        import torch
        config = t.TrainConfig(buckets=128, dim=8, hidden=8, epochs=1, batch_size=4, threads=1)
        torch.manual_seed(19)
        model = t.build_model(config)
        rows = [row("a", text="كم ١٢ ضرب ٣؟", context=t.prior("ads")), row("b", text="Where is the garden?", context=t.prior("web_search"))]
        exported = t.export_model(model, config, True, rows)
        header = json.loads(exported["model.json"])
        expected = t.model_logits(model, rows, config, True).tolist()
        for item, logits in zip(rows, expected):
            actual = t.exported_logits(header, exported["weights.bin"], item)
            self.assertLess(max(abs(left - right) for left, right in zip(actual, logits)), 1e-5)
        with self.assertRaisesRegex(ValueError, "identity"):
            t.exported_logits(header, exported["weights.bin"] + b"changed", rows[0])

    def test_calibration_uses_separate_logits_and_can_abstain_completely(self):
        import torch
        config = t.TrainConfig(min_calibration_accepted=5)
        logits = torch.zeros((8, len(t.ROUTES)))
        calibration = t.fit_calibration(logits, [t.ROUTE_ID["ads"]] * 8, config)
        self.assertGreater(calibration["threshold"], 1)
        self.assertEqual(calibration["accepted"], 0)
        self.assertEqual(calibration["partition"], "calibration")
        self.assertGreater(t.wilson_upper(0, 8), 0.1)

    def test_memory_target_stops_training_without_allocating_to_the_limit(self):
        config = t.TrainConfig(buckets=128, dim=8, hidden=8, epochs=1, batch_size=4, threads=1)
        with patch.object(t, "resident_mb", return_value=2049):
            with self.assertRaisesRegex(RuntimeError, "memory_target_exceeded"):
                t.train_model(self.fixture_splits(), config, True)

    def test_training_clock_budget_stops_before_an_unbounded_first_epoch(self):
        config = t.TrainConfig(buckets=128, dim=8, hidden=8, epochs=1, batch_size=4, threads=1, max_seconds_per_model=1)
        with patch.object(t.time, "monotonic", side_effect=[0.0, 2.0]):
            with self.assertRaisesRegex(RuntimeError, "budget_expired_before_checkpoint"):
                t.train_model(self.fixture_splits(), config, True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
