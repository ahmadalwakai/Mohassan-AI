import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts/agent-capability-bench/v2"))

from training_rows import aya_lineage, clinc_lineage, head_source_ids, record, scratch_lineage, write_rows


class TrainingLineageTests(unittest.TestCase):
    def test_clinc_indexes_follow_preparer_order_and_keep_native_oos_partition(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "clinc.json"
            duplicate = ["example", "oos"]
            path.write_text(json.dumps({
                "oos_train": [duplicate], "train": [duplicate, duplicate],
                "oos_val": [], "val": [], "oos_test": [], "test": [duplicate],
            }), encoding="utf-8")
            index = clinc_lineage(path)
            self.assertEqual(list(index["train", "example", "oos"]), [
                ("train", "clinc150:train:0"), ("train", "clinc150:train:1"), ("oos_train", "clinc150:oos_train:0"),
            ])
            self.assertEqual(list(index["test", "example", "oos"]), [("test", "clinc150:test:0")])

    def test_aya_ordinals_survive_identical_source_lines(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "aya.jsonl"
            path.write_text("{}\n{\"prompt\":\"different\"}\n{}\n", encoding="utf-8")
            self.assertEqual(list(aya_lineage(path)["{}\n"]), [0, 2])

    def test_scratch_source_id_uses_the_native_split_and_locale(self):
        local = {"row": {"partition": "dev", "id": "11"}, "locale": "ar-SA"}
        self.assertEqual(scratch_lineage("massive-ar-SA", local, {}, {}), ("dev", "massive:ar-SA:11"))
        row = record(47, "massive-ar-SA", "calibration", "dev", "massive:ar-SA:11", ["text", "text"])
        self.assertEqual((row["role"], row["upstream_split"], row["texts"]), ("selection", "dev", ["text"]))

    def test_head_ids_use_benchmark_namespaces_and_validate_quac_alias(self):
        inputs = (
            ("massive", "massive:ar:42", "question", "massive:ar-SA:42", ()),
            ("tydiqa", "tydiqa:ar:arabic--42-0", "question", "tydiqa:-42-0:ar", ()),
            ("quac", "quac:C_a123_1_q#2", "question", "quac:C_a123_1_q#2", ("canard:C_a123_1:3",)),
            ("quac", "quac:C_a123_1_q#2", "other", "quac:C_a123_1_q#2", ()),
        )
        for source, raw, text, canonical, aliases in inputs:
            with self.subTest(source=source, text=text):
                row = SimpleNamespace(source=source, id=raw, text=text)
                self.assertEqual(head_source_ids(row, {("C_a123_1", 3): "question"}), (canonical, aliases))

    def test_output_is_private_atomic_and_cannot_replace_an_existing_file(self):
        row = record(47, "canard", "train", "train", "canard:sample:1", ["example"])

        def failed_replay():
            yield row
            raise ValueError("invalid row provenance")

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "rows.jsonl"
            with self.assertRaisesRegex(ValueError, "invalid row provenance"):
                write_rows(path, failed_replay())
            self.assertEqual(list(path.parent.iterdir()), [])
            self.assertEqual(write_rows(path, [row]), {("canard", "train"): 1})
            if os.name == "posix":
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError):
                write_rows(path, [])
            self.assertEqual(list(path.parent.iterdir()), [path])
            self.assertEqual(json.loads(path.read_text(encoding="utf-8")), row)


if __name__ == "__main__":
    unittest.main()
