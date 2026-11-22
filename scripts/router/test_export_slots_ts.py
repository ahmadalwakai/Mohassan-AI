"""Exporter-only checks; no model training or owner/assessment data access."""
from __future__ import annotations

import importlib.util
import json
import struct
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

SPEC = importlib.util.spec_from_file_location("slot_ts_export_checks", Path(__file__).with_name("export_slots_ts.py"))
e = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = e
SPEC.loader.exec_module(e)


class ExportContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.unicode = e.unicode_contract()
        cls.manifest, cls.weights = e.tiny_fixture(cls.unicode)

    def test_unicode_contract_is_fixed_and_covers_python_specific_word_and_space_rules(self):
        self.assertEqual(self.unicode["version"], "14.0.0")
        self.assertEqual(self.unicode["sha256"], "8f4b98daa142959f0aa45b4e362fb05b8d32caed2487dd915ba7475725f3425a")
        for name in ("wordRanges", "digitRanges", "uppercaseRanges", "spaceRanges", "assignedRanges"):
            previous = -1
            for start, end in self.unicode[name]:
                self.assertLess(previous, start)
                self.assertLessEqual(start, end)
                previous = end
        tokens = e.tokenization("😀 Paris\u001cLondon\u0085Friday\ufeffRome Ⅻ ² ½")
        self.assertEqual([item["text"] for item in tokens], ["😀", "Paris", "London", "Friday", "\ufeff", "Rome", "Ⅻ", "²", "½"])
        self.assertEqual(tokens[1]["startUtf16"], tokens[1]["startCodepoint"] + 1)

    def test_numeric_canonicalization_is_portable_and_finite(self):
        self.assertEqual(e.typed_canonical({"number": 1}), e.typed_canonical({"number": 1.0}))
        self.assertNotEqual(e.typed_canonical({"number": 0.0}), e.typed_canonical({"number": -0.0}))
        self.assertIn(struct.pack(">d", 0.1).hex().encode(), e.typed_canonical({"number": 0.1}))
        with self.assertRaises(ValueError):
            e.typed_canonical({"number": float("nan")})

    def test_manifest_binds_weights_unicode_calibration_and_exact_tensor_layout(self):
        body = {key: value for key, value in self.manifest.items() if key != "modelId"}
        self.assertEqual(e.sha(e.typed_canonical(body)), self.manifest["modelId"])
        self.assertEqual(self.manifest["source"]["weightsSha256"], e.sha(self.weights))
        self.assertEqual(set(self.manifest["calibration"]["thresholds"]), {"date", "place"})
        self.assertEqual(len(self.manifest["labels"]), 13)
        self.assertEqual([item["name"] for item in self.manifest["weights"]["tensors"]], list(e.NAMES))
        self.assertLess(len(self.weights), 4 * 1024 * 1024)

    def test_parity_strings_preserve_literal_codepoint_and_utf16_slices(self):
        for text in e.PARITY_TEXTS:
            result = e.prediction(self.manifest, self.weights, text)
            for span in result["raw"]:
                self.assertEqual(text[span["startCodepoint"]:span["endCodepoint"]], span["text"])
                self.assertEqual(text.encode("utf-16-le")[2 * span["startUtf16"]:2 * span["endUtf16"]].decode("utf-16-le"), span["text"])
            self.assertTrue(all(item["label"] in ("date", "place") for item in result["hypotheses"]))

    def test_source_parity_rejects_changed_values_and_accepts_identical_independent_logits(self):
        cases = [{"text": text, "logits": e.infer_logits(self.manifest, self.weights, text)[1].tolist()} for text in e.PARITY_TEXTS[:2]]
        self.assertEqual(e.verify_source_parity(self.manifest, self.weights, cases), 0)
        cases[0]["logits"][0][0] += 0.1
        with self.assertRaisesRegex(ValueError, "parity_mismatch"):
            e.verify_source_parity(self.manifest, self.weights, cases)

    def test_candidate_checksum_paths_do_not_escape_the_explicit_candidate_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            candidate = base / "candidate"
            candidate.mkdir()
            (base / "outside").write_text("must not be read", encoding="utf-8")
            (candidate / "checksums.json").write_text(json.dumps({"../outside": "0" * 64}), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "checksum_path"):
                e.verify_candidate(candidate)

    def test_immutable_bundle_checksums_include_provenance_and_source_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "bundle"
            sums = e.write_bundle(target, self.manifest, self.weights, texts=e.PARITY_TEXTS[:2], provenance={"active": False}, source_code=b"# fixture source")
            self.assertEqual(len(sums), 5)
            for name, expected in sums.items():
                self.assertEqual(e.sha((target / name).read_bytes()), expected)
            with self.assertRaises(FileExistsError):
                e.write_bundle(target, self.manifest, self.weights)

    def test_empty_oversized_unassigned_and_unpaired_input_is_rejected(self):
        for text in ("", "x" * 513, "\u0378", "\ud800", " ".join("x" for _ in range(81))):
            with self.assertRaises(ValueError):
                e.tokenization(text)

    @unittest.skipUnless(e.CANDIDATE.exists(), "optional frozen learned candidate is not installed")
    def test_frozen_candidate_export_is_exact_without_retraining(self):
        header, weights, calibration, source_manifest = e.verify_candidate()
        source = {"candidate": e.CANDIDATE.name, "manifestSha256": e.sha((e.CANDIDATE / "manifest.json").read_bytes()), "weightsSha256": e.sha(weights),
                  "calibrationSha256": e.sha((e.CANDIDATE / "calibration.json").read_bytes()), "assignmentHash": source_manifest["assignmentHash"]}
        exported = e.bundle_manifest(header, weights, calibration, self.unicode, source)
        self.assertEqual(exported["calibration"]["thresholds"]["date"], calibration["thresholds"]["date"])
        self.assertEqual(exported["calibration"]["thresholds"]["place"], calibration["thresholds"]["place"])
        cases = json.loads((e.CANDIDATE / "parity.json").read_text(encoding="utf-8"))
        self.assertLess(e.verify_source_parity(exported, weights, cases), 1e-5)
        self.assertEqual(exported["weights"]["sha256"], header["sha256"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
