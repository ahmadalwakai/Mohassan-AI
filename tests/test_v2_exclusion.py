"""Tests for v2 exclusion normalization, mapping and training-time enforcement."""

from hashlib import sha256
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts/agent-capability-bench/v2"))
from exclusion import (
    BUNDLE,
    NORMALIZATION,
    Exclusions,
    benchmark_texts,
    normalize_text,
    read_benchmark,
    source_id_key,
    text_sha256,
)


class ExclusionTest(unittest.TestCase):
    def test_unicode_folding(self):
        source = "\u00a0Ａ Ｓtraße\tإِلَـى ﻣَﺪِﻳﻨَﺔ ١٢۳۴؟\n"
        expected = "a strasse الي مدينه 1234؟"
        self.assertEqual(normalize_text(source), expected)
        self.assertEqual(text_sha256(source), sha256(expected.encode("utf-8")).hexdigest())
        self.assertNotEqual(text_sha256(expected), text_sha256(expected[:-1]))

    def test_canonical_ids_fold_parallel_translations_with_dataset_namespace(self):
        self.assertEqual(source_id_key("massive:pt-PT:123"), "massive:123")
        self.assertEqual(source_id_key("massive:ar-SA:123"), "massive:123")
        self.assertEqual(source_id_key("mintaka:entity-id:ar"), "mintaka:entity-id")
        self.assertEqual(source_id_key("mintaka:entity-id:en"), "mintaka:entity-id")
        self.assertEqual(source_id_key("clinc150:test:123"), "clinc150:test:123")
        self.assertEqual(source_id_key("clinc150:train:123"), "clinc150:train:123")

    def test_benchmark_texts_include_native_wrapped_and_field_inputs(self):
        canard_prompt = "Instruction\nQuestion: A previous query\nFinal question: How long did it take?"
        canard = {
            "provenance": {"source": "canard:dialogue:2"},
            "turns": [{"text": canard_prompt, "expect": {"requiredContent": [{
                "anyOf": ["How long did the expedition take"],
            }]}}],
        }
        self.assertEqual(benchmark_texts(canard), (
            canard_prompt, "How long did it take?", "How long did the expedition take",
        ))
        mbpp_prompt = "Write a function.\n\nYour code should pass these tests:\nassert run(2) == 2"
        mbpp = {"provenance": {"source": "mbpp:1"}, "turns": [{"text": mbpp_prompt}]}
        self.assertEqual(benchmark_texts(mbpp), (mbpp_prompt, "Write a function."))
        fields = {"provenance": {"source": "clinc150:test:4"}, "turns": [
            {"text": "Initial question"}, {"text": "", "fields": {"name": "Field answer"}},
        ]}
        self.assertEqual(benchmark_texts(fields), ("Initial question", "Field answer"))

    def test_training_loads_both_partitions_and_blocks_on_one_matching_input(self):
        with TemporaryDirectory() as directory:
            manifest = self.write_fixture(Path(directory))
            exclusions = Exclusions.load(manifest)
            self.assertTrue(exclusions.matches(("unrelated", "ＳＥＡＬＥＤ\tvalue")))
            self.assertTrue(exclusions.matches("DEV value"))
            self.assertTrue(exclusions.matches((), source_id="massive:en-US:123"))
            self.assertTrue(exclusions.matches("unrelated", source_id="clinc150:test:9"))
            self.assertTrue(exclusions.matches("unrelated", source_id="xquad:9", source_ids=("clinc150:test:9",)))
            self.assertFalse(exclusions.matches("unrelated", source_id="clinc150:train:9"))
            self.assertFalse(exclusions.matches(("unrelated", "dev value.")))

    def test_missing_or_modified_partition_fails_closed(self):
        with TemporaryDirectory() as directory:
            manifest = self.write_fixture(Path(directory))
            sealed = manifest.with_name("sealed.jsonl")
            sealed.write_bytes(sealed.read_bytes() + b"\n")
            with self.assertRaisesRegex(ValueError, "checksum mismatch"):
                Exclusions.load(manifest)
            sealed.unlink()
            with self.assertRaises(FileNotFoundError):
                Exclusions.load(manifest)

    def test_benchmark_payload_checks_checksum_before_parsing(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            dev = root / BUNDLE / "dev"
            dev.mkdir(parents=True)
            (dev / "manifest.json").write_text(json.dumps({
                "development": {"sha256": "0" * 64},
            }), encoding="utf-8")
            (dev / "payload.json").write_bytes(b"invalid JSON")
            with self.assertRaisesRegex(ValueError, "payload checksum mismatch"):
                read_benchmark(root, partitions=("dev",))

    @staticmethod
    def write_fixture(directory: Path) -> Path:
        partitions = {}
        for partition, source in (("sealed", "massive:ar-SA:123"), ("dev", "clinc150:test:9")):
            item = {"source_id": source, "text_sha256": [text_sha256(f"{partition} value")]}
            data = (json.dumps(item) + "\n").encode("utf-8")
            (directory / f"{partition}.jsonl").write_bytes(data)
            partitions[partition] = {"case_count": 1, "entries_sha256": sha256(data).hexdigest()}
        path = directory / "manifest.json"
        path.write_text(json.dumps({
            "schema_version": 1, "normalization": NORMALIZATION, "partitions": partitions,
        }), encoding="utf-8")
        return path


if __name__ == "__main__":
    unittest.main()
