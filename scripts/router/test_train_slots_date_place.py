"""Synthetic tests only; no owner, assessment or learned test fixture inputs."""
from __future__ import annotations

import importlib.util
import json
import math
import os
import subprocess
import sys
import tempfile
import unittest
from dataclasses import asdict
from pathlib import Path
from unittest.mock import Mock, patch

SPEC = importlib.util.spec_from_file_location("isolated_date_place_v2", Path(__file__).with_name("train_slots_date_place.py"))
s = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = s
SPEC.loader.exec_module(s)
b = s.base_api()


def row(identity="1", locale="en-US", partition="train", text="Go from Paris to Paris tomorrow at noon", annotation="Go from [place_name : Paris] to [place_name : Paris] [date : tomorrow] at [timeofday : noon]"):
    spans = b.align_annotation(text, annotation, "weather_query")
    tokens = b.tokenize(text)
    value = b.SlotRow(f"massive:{identity}:{locale}", f"massive:{identity}", text, locale, partition, "weather_query", tokens, spans, b.spans_to_bio(text, tokens, spans))
    value.validate()
    return value


def source_fixture(directory):
    items = {"en-US": [], "ar-SA": []}; assignments = []
    for locale in items:
        for identity, original, target in (("1", "train", "train"), ("2", "dev", "dev"), ("3", "dev", "calibration"), ("4", "test", "test")):
            text = f"Go from Paris to Paris tomorrow at noon for branch{identity}"
            annotation = f"Go from [place_name : Paris] to [place_name : Paris] [date : tomorrow] at [timeofday : noon] for branch{identity}"
            value = row(identity, locale, target, text, annotation)
            items[locale].append({"id": identity, "locale": locale, "partition": original, "utt": value.text, "annot_utt": annotation, "intent": "weather_query"})
            assignments.append({"rowHash": b.sha(value.id), "groupHash": b.sha(value.group_id), "textHash": b.sha(value.text),
                                "canonicalHash": b.sha(b.canonical(value.text)), "annotationHash": s.sha(s.js([asdict(span) for span in value.spans])),
                                "partition": target, "locale": locale})
    inputs = []
    for locale, values in items.items():
        path = directory / f"{locale}.jsonl"; payload = b"".join(s.js(item) + b"\n" for item in values); path.write_bytes(payload)
        inputs.append({"path": f"public\\data\\{locale}.jsonl", "sha256": s.sha(payload)})
    return {"assignments": assignments, "inputs": inputs}, items


def candidate_report(identity, supported=2, recall=.4, dev=.6, parameters=100):
    return {"candidate": {"id": identity}, "calibration": {"thresholds": {"date": .8, "place": .9 if supported == 2 else 1.000001}},
            "calibrationSelective": {"perSlot": {"date": {"recall": recall}, "place": {"recall": recall if supported == 2 else 0}}},
            "developmentMacroF1": dev, "training": {"parameters": parameters}, "test": object()}


class DataTests(unittest.TestCase):
    def test_target_projection_preserves_repeated_literal_spans_and_removes_only_other_labels(self):
        original = row(); projected = s.project_row(original)
        self.assertEqual([span.label for span in projected.spans], ["place", "place", "date"])
        self.assertEqual([span.start_cp for span in projected.spans], [8, 17, 23])
        self.assertIn("time_of_day", [span.label for span in original.spans])
        self.assertTrue(all(tag < 5 for tag in projected.tags))
        projected.validate(); original.validate()

    def test_fixed_partition_loader_keeps_frozen_row_membership_without_sampling(self):
        with tempfile.TemporaryDirectory() as temporary:
            manifest, _ = source_fixture(Path(temporary))
            result = s.load_partition_rows(manifest, ("train", "dev", "calibration"), Path(temporary))
            self.assertEqual({part: len(rows) for part, rows in result.items()}, {"train": 2, "dev": 2, "calibration": 2})
            self.assertTrue(all(row.partition == part for part, rows in result.items() for row in rows))
            self.assertNotIn("test", result)

    def test_training_load_skips_test_annotation_parsing_but_still_binds_all_source_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary); manifest, items = source_fixture(directory)
            for locale, values in items.items():
                values[-1]["annot_utt"] = "malformed [annotation which must not be parsed"
                path = directory / f"{locale}.jsonl"; payload = b"".join(s.js(value) + b"\n" for value in values); path.write_bytes(payload)
                next(item for item in manifest["inputs"] if locale in item["path"])["sha256"] = s.sha(payload)
            self.assertEqual(len(s.load_partition_rows(manifest, ("train",), directory)["train"]), 2)
            with self.assertRaises(ValueError):
                s.load_partition_rows(manifest, ("test",), directory)

    def test_changed_annotations_groups_bytes_and_missing_rows_fail_closed(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary); manifest, _ = source_fixture(directory)
            for key in ("annotationHash", "groupHash", "textHash"):
                modified = json.loads(json.dumps(manifest)); modified["assignments"][0][key] = "0" * 64
                with self.assertRaises(ValueError):
                    s.load_partition_rows(modified, ("train",), directory)
            path = directory / "en-US.jsonl"; path.write_bytes(path.read_bytes() + b"\n")
            with self.assertRaisesRegex(ValueError, "public_input_changed"):
                s.load_partition_rows(manifest, ("train",), directory)

    def test_official_partition_cannot_be_reassigned_by_supplied_metadata(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary); manifest, _ = source_fixture(directory)
            for item in manifest["assignments"]:
                if item["partition"] == "train":
                    item["partition"] = "dev"
            with self.assertRaisesRegex(ValueError, "official_partition_changed"):
                s.load_partition_rows(manifest, ("dev",), directory)

    def test_weights_use_train_target_tags_only_and_keep_predeclared_caps(self):
        projected = s.project_row(row())
        values = s.class_weights([projected], s.CANDIDATES[0])
        self.assertTrue(all(0 < value <= 3 for value in values)); self.assertEqual(values[0], 1)
        self.assertEqual(s.class_weights([projected], s.CANDIDATES[2]), [1] * 5)
        with self.assertRaisesRegex(ValueError, "weights_train_only"):
            s.class_weights([s.project_row(row(partition="test"))], s.CANDIDATES[0])


class SelectionTests(unittest.TestCase):
    def test_three_fixed_candidates_and_resource_limits_are_not_request_parameters(self):
        self.assertEqual([(candidate.hidden, candidate.weight_cap, candidate.seed, candidate.epochs) for candidate in s.CANDIDATES],
                         [(32, 3, 53, 5), (48, 3, 53, 5), (48, None, 53, 5)])
        self.assertEqual((s.TOTAL_SECONDS, s.CANDIDATE_SECONDS, s.TRAIN_SECONDS, s.MEMORY_MIB), (600, 150, 120, 2048))
        with self.assertRaises(ValueError): s.checked_candidate("another-trial-from-test")

    def test_selection_uses_only_development_and_calibration_with_fixed_tie_breaks(self):
        one_label = candidate_report("target32-cap3", 1, .99, .99)
        two_labels = candidate_report("target48-cap3", 2, .2, .5)
        self.assertIs(s.select_candidate([one_label, two_labels]), two_labels)
        better_recall = candidate_report("target48-uniform", 2, .3, .4, 200)
        self.assertIs(s.select_candidate([two_labels, better_recall]), better_recall)
        tie = candidate_report("target32-cap3", 2, .3, .4, 100)
        self.assertIs(s.select_candidate([tie, better_recall]), tie)
        self.assertIs(s.select_candidate([better_recall, tie]), tie)
        with self.assertRaises(ValueError): s.select_candidate([tie, tie])

    def test_training_api_rejects_test_partition_before_any_optimizer_or_model(self):
        with patch.object(s, "model_for", side_effect=AssertionError("must not allocate")):
            with self.assertRaisesRegex(ValueError, "training_partitions_only"):
                s.train_model({"train": [], "dev": [], "calibration": [], "test": []}, s.CANDIDATES[0])

    def test_target_logits_have_no_out_of_scope_tag_authority_or_invalid_bio_path(self):
        import numpy as np
        logits = np.asarray([[0, 0, 90, 0, 80], [0, 0, 1, 0, 2]], dtype=np.float32)
        widened = s.expanded([logits])[0]
        self.assertTrue((widened[:, 5:] == -10000).all())
        decoded = b.viterbi_decode(widened)
        self.assertTrue(b.legal_bio(decoded)); self.assertNotIn(decoded[0], (2, 4))
        for bad in (np.zeros((2, 4)), np.full((1, 5), np.nan), np.full((1, 5), 1001)):
            with self.assertRaises(ValueError): s.expanded([bad])


class ExportAndReportingTests(unittest.TestCase):
    def test_new_five_tag_format_has_independent_numpy_parity_and_deterministic_seed(self):
        import numpy as np
        import torch
        config = b.SlotConfig(buckets=128, dim=8, hidden=4)
        torch.manual_seed(53); model = s.model_for(config)
        torch.manual_seed(53); duplicate = s.model_for(config)
        self.assertTrue(all(torch.equal(value, duplicate.state_dict()[name]) for name, value in model.state_dict().items()))
        projected = s.project_row(row())
        header, payload = s.export_model(model, config)
        self.assertNotEqual(header["format"], b.MODEL_FORMAT); self.assertEqual(header["tags"], list(s.TAGS))
        reference = b.sequence_logits(model, [projected], config)[0]
        actual = s.numpy_logits(header, payload, projected)
        self.assertTrue(np.allclose(reference, actual, rtol=1e-5, atol=1e-5))
        self.assertEqual(reference.shape[1], 5)
        with self.assertRaises(ValueError): b.exported_logits(header, payload, projected)
        changed = dict(header); changed["layout"] = header["layout"] + [header["layout"][0]]
        with self.assertRaises(ValueError): s.tensors(changed, payload)
        corrupted = bytearray(payload); corrupted[:4] = np.asarray([float("nan")], dtype="<f4").tobytes()
        changed = {**header, "sha256": s.sha(corrupted)}
        with self.assertRaises(ValueError): s.tensors(changed, corrupted)

    def test_paired_bootstrap_groups_translations_and_handles_empty_precision_honestly(self):
        rows = [s.project_row(row(str(group), locale, "test")) for group in (1, 2) for locale in ("ar-SA", "en-US")]
        entries = [{"rowHash": b.sha(value.id), "gold": [list(b.span_key(span)) for span in value.spans], "predictions": []} for value in rows]
        report = s.paired_comparison(rows, entries, entries, bootstrap_samples=50)
        self.assertEqual(report["translationGroups"], 2)
        self.assertEqual(report["deltasCandidateMinusBaseline"]["recall"]["ci95"], [0, 0])
        self.assertIsNone(report["deltasCandidateMinusBaseline"]["precision"]["observed"])
        self.assertIsNone(report["deltasCandidateMinusBaseline"]["precision"]["ci95"])

    def test_baseline_comparison_filters_non_target_gold_and_predictions(self):
        projected = s.project_row(row(partition="test"))
        gold = [list(b.span_key(span)) for span in projected.spans] + [["time", 20, 22]]
        predictions = [{**span.projection(projected.text), "accepted": True, "confidence": .99} for span in projected.spans]
        predictions.append({"label": "time", "startCodepoint": 20, "endCodepoint": 22, "accepted": True})
        entry = {"rowHash": b.sha(projected.id), "gold": gold, "predictions": predictions}
        report = s.baseline_target_metrics({entry["rowHash"]: entry}, [projected])
        self.assertEqual(report["overall"]["tp"], 3); self.assertEqual(report["overall"]["recall"], 1)
        self.assertEqual(report["rawPredictedSpans"], 3)

    def test_artifacts_are_exclusive_checksummed_and_cannot_traverse(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary); s.write(directory / "data.json", {"active": False}); s.checksums(directory)
            s.verified_files(directory)
            with self.assertRaises(FileExistsError): s.write(directory / "data.json", {"active": True})
            (directory / "checksums.json").write_text(json.dumps({"../other": "0" * 64}), encoding="utf-8")
            with self.assertRaises(ValueError): s.verified_files(directory)

    def test_hard_orchestrator_deadline_terminates_its_active_worker_and_process(self):
        child = Mock()
        with patch.object(s, "_active_child", child), patch.object(s.os, "_exit", side_effect=RuntimeError("exit")), patch.object(s.sys, "stderr"):
            with self.assertRaisesRegex(RuntimeError, "exit"): s.hard_total_deadline()
        child.kill.assert_called_once()

    def test_rss_monitor_reports_finite_usage_when_the_platform_supports_it(self):
        measured = s.process_rss_mib(os.getpid())
        if measured is not None:
            self.assertTrue(math.isfinite(measured)); self.assertGreater(measured, 0)

    def test_actual_interpreter_pid_rss_and_kill_target_the_worker_instead_of_a_venv_launcher(self):
        child = subprocess.Popen([s.actual_interpreter(), "-I", "-c",
                                  "import os,time;data=bytearray(64*1024*1024);print(os.getpid(),flush=True);time.sleep(10)"], stdout=subprocess.PIPE)
        try:
            actual_pid = int(child.stdout.readline())
            self.assertEqual(actual_pid, child.pid)
            measured = s.process_rss_mib(child.pid)
            if measured is not None:
                self.assertGreater(measured, 50)
            child.kill(); child.wait(timeout=2)
            self.assertIsNotNone(child.returncode)
        finally:
            if child.poll() is None: child.kill(); child.wait(timeout=2)
            child.stdout.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
