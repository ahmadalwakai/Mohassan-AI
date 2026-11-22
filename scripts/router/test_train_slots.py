"""Synthetic in-memory tests for exact public slot alignment and inactive training."""
from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("isolated_slot_training", Path(__file__).with_name("train_slots.py"))
s = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = s
SPEC.loader.exec_module(s)


def row(identity="a", text="Weather in Paris tomorrow", annotation="Weather in [place_name : Paris] [date : tomorrow]", partition="train", locale="en-US", group=None, intent="weather_query"):
    tokens = s.tokenize(text)
    spans = s.align_annotation(text, annotation, intent)
    result = s.SlotRow(identity, group or f"group:{identity}", text, locale, partition, intent, tokens, spans, s.spans_to_bio(text, tokens, spans))
    result.validate()
    return result


class AnnotationTests(unittest.TestCase):
    def test_exact_markup_reconstruction_and_bio_round_trip(self):
        item = row()
        self.assertEqual([span.label for span in item.spans], ["place", "date"])
        self.assertEqual([span.text for span in item.spans], ["Paris", "tomorrow"])
        self.assertEqual([(span.label, span.start_cp, span.end_cp) for span in item.spans],
                         [(span.label, span.start_cp, span.end_cp) for span in s.bio_to_spans(item.text, item.tokens, item.tags)])

    def test_repeated_entities_remain_bound_to_the_annotated_occurrence(self):
        item = row(text="Paris to Paris", annotation="Paris to [place_name : Paris]")
        self.assertEqual(item.spans[0].start_cp, 9)
        both = row(text="Paris to Paris", annotation="[place_name : Paris] to [place_name : Paris]")
        self.assertEqual([span.start_cp for span in both.spans], [0, 9])
        self.assertEqual(both.tags, (s.TAG_ID["B-place"], 0, s.TAG_ID["B-place"]))

    def test_codepoint_and_utf16_offsets_are_explicit_for_astral_unicode(self):
        text = "😀 زُر باريس غدًا"
        item = row(text=text, annotation="😀 زُر [place_name : باريس] [date : غدًا]", locale="ar-SA")
        for span in item.spans:
            projected = span.projection(text)
            self.assertEqual(projected["startUtf16"], projected["startCodepoint"] + 1)
            encoded = text.encode("utf-16-le")
            self.assertEqual(encoded[projected["startUtf16"] * 2:projected["endUtf16"] * 2].decode("utf-16-le"), span.text)
        self.assertEqual(s.bio_to_spans(text, item.tokens, item.tags)[1].text, "غدًا")

    def test_alignment_does_not_repair_case_whitespace_or_normalization(self):
        for text, annotated in (("Go to Paris", "Go to [place_name : paris]"),
                                ("Go  to Paris", "Go to [place_name : Paris]"),
                                ("cafe\u0301", "[place_name : café]")):
            with self.assertRaisesRegex(ValueError, "reconstruction"):
                s.align_annotation(text, annotated)

    def test_nested_unclosed_empty_and_literal_ambiguous_brackets_are_rejected(self):
        for text, annotated in (("Paris", "[place_name : [date : Paris]]"), ("Paris", "[place_name : Paris"),
                                ("Paris", "[place_name : ]Paris"), ("[Paris]", "[Paris]")):
            with self.assertRaises(ValueError):
                s.align_annotation(text, annotated)

    def test_token_internal_gold_boundary_is_rejected_instead_of_expanded(self):
        text = "بباريس"
        spans = s.align_annotation(text, "ب[place_name : باريس]")
        with self.assertRaisesRegex(ValueError, "inside_token"):
            s.spans_to_bio(text, s.tokenize(text), spans)

    def test_unknown_annotations_are_not_invented_as_generic_topics(self):
        text = "Read the garden report"
        self.assertEqual(s.align_annotation(text, "Read the [event_name : garden report]"), ())
        self.assertEqual(s.align_annotation(text, "Read the [news_topic : garden report]", "email_query"), ())
        self.assertEqual(s.align_annotation(text, "Read the [news_topic : garden report]", "news_query")[0].label, "news_topic")
        self.assertNotIn("topic", s.SLOTS)

    def test_overlapping_spans_and_fake_source_values_are_rejected(self):
        item = row(text="New York", annotation="[place_name : New York]")
        with self.assertRaisesRegex(ValueError, "overlapping"):
            s.spans_to_bio(item.text, item.tokens, (item.spans[0], s.Span("place", 4, 8, "York")))
        with self.assertRaisesRegex(ValueError, "source_mismatch"):
            s.Span("place", 0, 3, "Paris").projection("New")

    def test_text_token_row_and_unicode_bounds_are_enforced(self):
        for text in ("", "x" * 513, "\ud800", " ".join("x" for _ in range(81))):
            with self.assertRaises(ValueError):
                s.tokenize(text)
        with self.assertRaisesRegex(ValueError, "alignment_mismatch"):
            replace(row(), tags=(0, 0, 0, 0)).validate()
        with self.assertRaises(ValueError):
            s.utf16_offset("Paris", 6)


class SplitAndFeatureTests(unittest.TestCase):
    def test_translation_groups_keep_their_fixed_partition(self):
        english = row("en", group="translated")
        arabic = row("ar", text="الطقس في باريس غدًا", annotation="الطقس في [place_name : باريس] [date : غدًا]", locale="ar-SA", group="translated")
        splits, _ = s.split_public([english, arabic])
        self.assertEqual(len(splits["train"]), 2)
        with self.assertRaisesRegex(ValueError, "crosses_partition"):
            s.split_public([english, replace(arabic, partition="test")])

    def test_cross_partition_canonical_duplicates_exclude_whole_families(self):
        a = row("a", group="train-family")
        b = row("b", text="Other independent fixture", annotation="Other independent fixture", group="train-family")
        c = row("c", partition="test", group="test-family")
        splits, report = s.split_public([a, b, c])
        self.assertEqual(sum(map(len, splits.values())), 0)
        self.assertEqual(report["excludedGroups"], 2)

    def test_identical_features_with_conflicting_bio_labels_are_excluded(self):
        a = row("a")
        b = row("b", annotation="Weather in Paris tomorrow")
        splits, report = s.split_public([a, b])
        self.assertEqual(sum(map(len, splits.values())), 0)
        self.assertEqual(report["contradictoryFeatureSignatures"], 1)

    def test_split_order_and_feature_hashing_are_deterministic(self):
        items = [row("a"), row("b", text="Visit Rome Friday", annotation="Visit [place_name : Rome] [date : Friday]")]
        self.assertEqual(s.split_public(items), s.split_public(list(reversed(items))))
        arabic = s.Token("أهلًا", 0, 5)
        plain = s.Token("اهلا", 0, 4)
        self.assertEqual(s.token_features(arabic, 1024), s.token_features(plain, 1024))
        self.assertTrue(all(0 <= value < 1024 for value in s.token_features(arabic, 1024)))

    def test_public_loader_reads_only_explicit_locale_files(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            for locale, text, annotated in (("en-US", "Go to Paris", "Go to [place_name : Paris]"), ("ar-SA", "اذهب إلى باريس", "اذهب إلى [place_name : باريس]")):
                (base / f"{locale}.jsonl").write_text(json.dumps({"id": "4", "locale": locale, "partition": "dev", "intent": "transport_query", "utt": text, "annot_utt": annotated}), encoding="utf-8")
            (base / "do-not-read.jsonl").write_bytes(b"broken")
            rows, audit = s.load_public(base)
            self.assertEqual(len(rows), 2)
            self.assertEqual(len({item.partition for item in rows}), 1)
            self.assertEqual(audit["rejectedRows"], {})

    def test_artifact_paths_and_files_are_immutable_and_bounded(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            target = s.new_run("candidate", base)
            with self.assertRaises(FileExistsError):
                s.new_run("candidate", base)
            with self.assertRaises(ValueError):
                s.new_run("../escape", base)
            s.write_exclusive(target / "manifest.json", b"{}")
            with self.assertRaises(FileExistsError):
                s.write_exclusive(target / "manifest.json", b"changed")


class DecoderAndModelTests(unittest.TestCase):
    def test_bio_legality_and_constrained_decoding_do_not_repair_illegal_i_tags(self):
        import numpy as np
        self.assertFalse(s.legal_bio([s.TAG_ID["I-place"]]))
        self.assertFalse(s.legal_bio([s.TAG_ID["B-date"], s.TAG_ID["I-place"]]))
        logits = np.zeros((3, len(s.TAGS)))
        logits[:, s.TAG_ID["I-place"]] = 10
        decoded = s.viterbi_decode(logits)
        self.assertTrue(s.legal_bio(decoded))
        self.assertEqual(decoded[0], s.TAG_ID["B-place"])
        with self.assertRaisesRegex(ValueError, "illegal_bio"):
            item = row()
            s.bio_to_spans(item.text, item.tokens, [s.TAG_ID["I-place"]] * len(item.tokens))
        with self.assertRaises(ValueError):
            s.viterbi_decode(np.full((2, len(s.TAGS)), np.nan))

    def test_span_metrics_require_exact_label_and_both_boundaries(self):
        import numpy as np
        item = row()
        logits = np.full((len(item.tokens), len(s.TAGS)), -10.0)
        for index, tag in enumerate(item.tags):
            logits[index, tag] = 10
        perfect = s.metrics([item], [logits])
        self.assertEqual(perfect["overall"]["exactSpanF1"], 1)
        rejected = s.metrics([item], [logits], thresholds={slot: 1.000001 for slot in s.SLOTS})
        self.assertEqual(rejected["overall"]["recall"], 0)
        self.assertIsNone(rejected["overall"]["precision"])
        self.assertEqual(rejected["spanAcceptanceCoverage"], 0)
        wrong = logits.copy()
        wrong[2] = -10
        wrong[2, 0] = 10
        self.assertLess(s.metrics([item], [wrong])["overall"]["exactSpanF1"], 1)

    def test_numpy_gru_export_and_offset_projection_match_pytorch(self):
        import numpy as np
        import torch
        torch.manual_seed(7)
        config = s.SlotConfig(buckets=128, dim=8, hidden=4, epochs=1, threads=1)
        model = s.make_model(config)
        items = [row(), row("b", text="😀 زر باريس", annotation="😀 زر [place_name : باريس]", locale="ar-SA")]
        artifacts = s.export(model, config, items)
        header = json.loads(artifacts["model.json"])
        logits = s.sequence_logits(model, items, config)
        for item, expected in zip(items, logits):
            actual = s.exported_logits(header, artifacts["weights.bin"], item)
            self.assertTrue(np.allclose(actual, expected, atol=1e-5, rtol=1e-5))
        with self.assertRaisesRegex(ValueError, "identity"):
            s.exported_logits(header, artifacts["weights.bin"] + b"changed", items[0])

    def test_padding_does_not_change_a_short_sequence_prediction(self):
        import numpy as np
        import torch
        torch.manual_seed(8)
        config = s.SlotConfig(buckets=128, dim=8, hidden=4, threads=1)
        model = s.make_model(config)
        short = row()
        long = row("long", text="Please show the weather forecast in New York on next Friday morning", annotation="Please show the weather forecast in [place_name : New York] on [date : next Friday] [timeofday : morning]")
        one = s.sequence_logits(model, [short], config)[0]
        together = s.sequence_logits(model, [short, long], config)[0]
        self.assertTrue(np.allclose(one, together, atol=1e-5, rtol=1e-5))

    def test_calibration_can_abstain_for_all_rare_or_unreliable_slots(self):
        import numpy as np
        item = row()
        logits = np.zeros((len(item.tokens), len(s.TAGS)))
        logits[:, 0] = 10
        calibrated = s.calibrate([item], [logits], s.SlotConfig())
        self.assertTrue(all(value > 1 for value in calibrated["thresholds"].values()))
        self.assertEqual(calibrated["partition"], "calibration")
        with self.assertRaises(ValueError):
            s.predictions(item, logits, 0)

    def test_model_config_and_runtime_resource_limits_are_enforced(self):
        for config in (s.SlotConfig(threads=5), s.SlotConfig(memory_limit_mb=3000), s.SlotConfig(max_seconds=301), s.SlotConfig(buckets=1000)):
            with self.assertRaises(ValueError):
                config.validate()
        config = s.SlotConfig(buckets=128, dim=8, hidden=4, epochs=1, threads=1, batch_size=4)
        splits = {partition: [replace(row(f"{partition}-{index}"), partition=partition) for index in range(4)] for partition in s.PARTITIONS}
        with patch.object(s, "memory_mb", return_value=2049):
            with self.assertRaisesRegex(RuntimeError, "memory_target"):
                s.train(splits, config)
        with patch.object(s.time, "monotonic", side_effect=[0.0, 301.0]):
            with self.assertRaisesRegex(RuntimeError, "budget_before_checkpoint"):
                s.train(splits, config)

    def test_tiny_training_is_deterministic_and_does_not_use_test_labels(self):
        import torch
        config = s.SlotConfig(buckets=128, dim=8, hidden=4, epochs=1, threads=1, batch_size=4, max_seconds=30)
        splits = {partition: [replace(row(f"{partition}-{index}"), partition=partition) for index in range(4)] for partition in s.PARTITIONS}
        model, _ = s.train(splits, config)
        changed = {**splits, "test": [row("different", text="No annotated entities", annotation="No annotated entities", partition="test")]}
        other, _ = s.train(changed, config)
        for name, tensor in model.state_dict().items():
            self.assertTrue(torch.equal(tensor, other.state_dict()[name]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
