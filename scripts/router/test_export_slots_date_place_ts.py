"""Five-tag exporter/parity boundaries only; no training, final test cache or owner data."""
from __future__ import annotations

import copy
import importlib.util
import itertools
import json
import struct
import tempfile
import unittest
from pathlib import Path

import numpy as np

SPEC = importlib.util.spec_from_file_location("date_place_export_checks", Path(__file__).with_name("export_slots_date_place_ts.py"))
e = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(e)


class FiveTagExportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.header, cls.weights, cls.calibration, cls.cached = e.verified_source()
        cls.manifest = e.bundle_manifest(cls.header, cls.weights, cls.calibration)
        cls.model = e.torch_model(cls.header, cls.weights)

    def test_frozen_selected_identity_and_geometry_are_independently_pinned(self):
        self.assertEqual(e.sha(self.weights), "3b1e0c3a6ec1e4a9f5057aad3358271e592850084e9e23e05fe1828717267e64")
        self.assertEqual(len(self.weights), 3239828)
        self.assertEqual(self.manifest["labels"], ["O", "B-place", "I-place", "B-date", "I-date"])
        self.assertEqual(self.manifest["weights"]["tensors"][-2]["shape"], [5, 96])
        self.assertEqual(self.manifest["source"]["selectionSha256"], "01adfe04552a4d8543fe042b7fd2c0a6ecf94b7ae35f6f1444058244983423b8")
        self.assertEqual(self.manifest["calibration"]["temperature"], 1.0)
        self.assertEqual(self.manifest["calibration"]["thresholds"], {"date": 0.8228255028191475, "place": 0.9688093835656453})
        self.assertFalse(self.manifest["active"])
        self.assertEqual(self.manifest["calibration"]["abstainedLabels"], [])

    def test_content_address_includes_separate_five_tag_contract(self):
        body = {key: value for key, value in self.manifest.items() if key != "modelId"}
        self.assertEqual(e.sha(e.shared().typed_canonical(body)), "4443f07d0322db1326de784b5aae4b04023cd4b3125877a8de854bf7d96e9314")
        changed = copy.deepcopy(body); changed["calibration"]["thresholds"]["date"] += 0.001
        self.assertNotEqual(e.sha(e.shared().typed_canonical(changed)), self.manifest["modelId"])

    def test_rejects_thirteen_tag_geometry_wrong_layout_and_truncated_or_extra_weights(self):
        for mutation in ("tags", "classifier", "order", "offset", "dimensions"):
            header = copy.deepcopy(self.header)
            if mutation == "tags": header["tags"] = e.shared().TAGS
            if mutation == "classifier": header["layout"][-2]["shape"][0] = 13
            if mutation == "order": header["layout"].reverse()
            if mutation == "offset": header["layout"][1]["offsetBytes"] += 4
            if mutation == "dimensions": header["config"]["buckets"] = 32767
            with self.subTest(mutation=mutation), self.assertRaises(ValueError): e.validate_layout(header, self.weights)
        for payload in (self.weights[:-4], self.weights + b"\0\0\0\0", b"x" * (4 * 1024 * 1024 + 4)):
            header = copy.deepcopy(self.header); header["sha256"] = e.sha(payload)
            with self.assertRaises(ValueError): e.validate_layout(header, payload)

    def test_nonfinite_and_out_of_range_float_values_fail_even_with_coherent_hash(self):
        for value in (float("nan"), float("inf"), -float("inf"), 64.01, -65):
            payload = bytearray(self.weights); struct.pack_into("<f", payload, 0, value)
            header = copy.deepcopy(self.header); header["sha256"] = e.sha(payload)
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "float_bounds"):
                e.validate_layout(header, bytes(payload))

    def test_cached_public_dev_reference_is_actual_pytorch_and_has_no_parameter_mutation(self):
        for entry in self.cached:
            actual, error = e.prediction(self.model, self.manifest, self.weights, entry["text"])
            self.assertLess(error, 1e-5)
            np.testing.assert_allclose(actual["logits"], entry["logits"], rtol=1e-5, atol=1e-5)
            self.assertTrue(all(len(row) == 5 for row in actual["logits"]))
        restored = b"".join(self.model.state_dict()[item["name"]].cpu().numpy().astype("<f4", copy=False).tobytes() for item in self.header["layout"])
        self.assertEqual(e.sha(restored), e.sha(self.weights))

    def test_unicode_boundary_cases_keep_literal_half_open_offsets_and_only_date_place_hypotheses(self):
        for text in e.shared().PARITY_TEXTS:
            actual, error = e.prediction(self.model, self.manifest, self.weights, text)
            self.assertLess(error, 1e-5)
            for item in actual["raw"]:
                self.assertEqual(text[item["startCodepoint"]:item["endCodepoint"]], item["text"])
                self.assertEqual(text.encode("utf-16-le")[2 * item["startUtf16"]:2 * item["endUtf16"]].decode("utf-16-le"), item["text"])
                self.assertIn(item["label"], ("date", "place"))
            self.assertTrue(all(item["kind"] == "hypothesis" for item in actual["hypotheses"]))

    def test_legal_bio_decoding_matches_exhaustive_small_path_oracle(self):
        import torch
        rng = np.random.default_rng(307)
        for count in range(1, 5):
            for _ in range(4):
                logits = rng.normal(size=(count, 5))
                legal = [path for path in itertools.product(range(5), repeat=count)
                         if path[0] not in (2, 4) and all(tag not in (2, 4) or path[index - 1] in (tag - 1, tag)
                            for index, tag in enumerate(path) if index)]
                best = max(legal, key=lambda path: sum(logits[index, tag] for index, tag in enumerate(path)))
                self.assertEqual(e.decode(torch.tensor(logits, dtype=torch.float64)), list(best))
        self.assertEqual(e.decode(torch.zeros((4, 5), dtype=torch.float32)), [0, 0, 0, 0])

    def test_modified_selected_source_is_rejected_without_touching_the_original(self):
        with tempfile.TemporaryDirectory(prefix="mohassan-date-place-export-") as directory:
            target = Path(directory).resolve()
            self.assertEqual(target.parent, Path(tempfile.gettempdir()).resolve())
            # The first trusted pin rejects the modified clone before any weight read.
            (target / "selection.json").write_text(json.dumps({"candidateId": "target48-cap3"}), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "selected_source_changed"): e.verified_source(target)
        self.assertEqual(e.sha((e.SOURCE / "selection.json").read_bytes()), e.PINS["selection.json"])

    def test_predeclared_bundle_is_inactive_and_all_exported_bytes_are_content_addressed(self):
        target = e.OUTPUT / "typescript-export-v1-20261121-a"
        checksums = e.read_json(target / "checksums.json")
        self.assertEqual(set(checksums), {"manifest.json", "weights.bin", "parity.json", "provenance.json", "source-export_slots_date_place_ts.py"})
        for name, expected in checksums.items(): self.assertEqual(e.sha((target / name).read_bytes()), expected)
        provenance = e.read_json(target / "provenance.json")
        self.assertFalse(provenance["active"]); self.assertFalse(provenance["thresholdsRefit"]); self.assertFalse(provenance["testCacheRead"])
        self.assertTrue(provenance["derivedWithoutRetraining"])
        self.assertEqual(len(e.read_json(target / "parity.json")["cases"]), 25)


if __name__ == "__main__":
    unittest.main(verbosity=2)
