import io
import json
import tarfile
import tempfile
import unittest
from collections import Counter
from pathlib import Path
from unittest.mock import Mock, call, patch

import train


class PublicIngestionTests(unittest.TestCase):
    def setUp(self):
        self.cache = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.enterContext(patch.object(train, "pinned_source", side_effect=lambda cache, name: cache / name))
        self.write_clinc()
        self.write_aya("eng")
        self.write_aya("arb")
        self.write_massive()
        self.dropped = Counter()

    def write_clinc(self, **rows):
        data = {
            partition: rows.get(partition, [])
            for partition in ("train", "oos_train", "val", "oos_val", "test", "oos_test")
        }
        (self.cache / "clinc150.json").write_text(json.dumps(data), encoding="utf-8")

    def write_aya(self, locale, *rows):
        data = "".join(json.dumps(row) + "\n" for row in rows)
        (self.cache / f"aya-{locale}.jsonl").write_text(data, encoding="utf-8")

    def write_massive(self, *rows):
        data = "".join(json.dumps(row) + "\n" for row in rows).encode()
        item = tarfile.TarInfo("1.0/data/ar-SA.jsonl")
        item.size = len(data)
        with tarfile.open(self.cache / "massive.tar.gz", "w:gz") as archive:
            archive.addfile(item, io.BytesIO(data))

    def test_clinc_excludes_using_original_partition_and_index_before_selection(self):
        duplicate = "Shared training example"
        retained_oos = "Retained out-of-scope prompt"
        retained_validation = "Keep this validation example"
        excluded_validation = "Exclude this validation example"
        self.write_clinc(
            train=[(duplicate, "greeting")],
            oos_train=[("Unmapped example", "unmapped"), ("Exclude this OOS item", "oos"), (retained_oos, "oos")],
            val=[(excluded_validation, "greeting"), (retained_validation, "greeting")],
            test=[(duplicate, "greeting")],
        )
        exclusions = Mock()
        exclusions.matches.side_effect = lambda text, *, source_id: (
            source_id in {"clinc150:oos_train:1", "clinc150:test:0"}
            or text == excluded_validation
        )
        with patch.object(train, "source_split", wraps=train.source_split) as split:
            rows = list(train.deduplicate(train.public_rows(self.cache, exclusions, self.dropped)))

        self.assertEqual(exclusions.matches.call_args_list, [
            call(duplicate, source_id="clinc150:train:0"),
            call("Exclude this OOS item", source_id="clinc150:oos_train:1"),
            call(retained_oos, source_id="clinc150:oos_train:2"),
            call(excluded_validation, source_id="clinc150:val:0"),
            call(retained_validation, source_id="clinc150:val:1"),
            call(duplicate, source_id="clinc150:test:0"),
        ])
        self.assertEqual(split.call_args_list, [
            call("clinc150", "train", train.normalize(duplicate)),
            call("clinc150", "train", train.normalize(retained_oos)),
            call("clinc150", "val", train.normalize(retained_validation)),
        ])
        self.assertEqual([(row.text, row.label) for row in rows], [
            (duplicate, "allow"),
            (retained_oos, "out_of_scope"),
            (retained_validation, "allow"),
        ])
        self.assertEqual(rows[0].split, "train")
        self.assertEqual([(row.native_partition, row.native_id) for row in rows], [
            ("train", "clinc150:train:0"),
            ("oos_train", "clinc150:oos_train:2"),
            ("val", "clinc150:val:1"),
        ])
        self.assertEqual(self.dropped, Counter({
            ("clinc150", "oos_train"): 1,
            ("clinc150", "val"): 1,
            ("clinc150", "test"): 1,
        }))

    def test_aya_and_massive_gate_raw_text_and_native_ids_before_split_assignment(self):
        annotation = {"global_or_local": "global", "harm_category": json.dumps(["Hate Speech"])}
        aya_retained = "Kept English example"
        aya_excluded = "  Arabic source example! "
        massive_retained = "MASSIVE allowed example"
        self.write_aya(
            "eng",
            {**annotation, "prompt": "Local example", "global_or_local": "local"},
            {**annotation, "prompt": "Exclude by Aya item ID"},
            {**annotation, "prompt": aya_retained},
        )
        self.write_aya("arb", {**annotation, "prompt": aya_excluded})
        self.write_massive(
            {"id": "80", "partition": "train", "intent": "general_greet", "utt": "Exclude by MASSIVE item ID"},
            {"id": "81", "partition": "dev", "intent": "general_greet", "utt": massive_retained},
        )
        exclusions = Mock()
        exclusions.matches.side_effect = lambda text, *, source_id: (
            text == aya_excluded or source_id in {"aya-redteaming:eng:1", "massive:ar-SA:80"}
        )
        with (
            patch.object(train, "bucket", wraps=train.bucket) as bucket,
            patch.object(train, "source_split", wraps=train.source_split) as split,
        ):
            rows = list(train.public_rows(self.cache, exclusions, self.dropped))

        self.assertEqual(exclusions.matches.call_args_list, [
            call("Exclude by Aya item ID", source_id="aya-redteaming:eng:1"),
            call(aya_retained, source_id="aya-redteaming:eng:2"),
            call(aya_excluded, source_id="aya-redteaming:arb:0"),
            call("Exclude by MASSIVE item ID", source_id="massive:ar-SA:80"),
            call(massive_retained, source_id="massive:ar-SA:81"),
        ])
        self.assertEqual(bucket.call_args_list, [
            call("aya-redteaming", train.normalize(aya_retained)),
            call("massive", "81"),
        ])
        split.assert_called_once_with("massive", "dev", "81")
        self.assertEqual([(row.dataset, row.text, row.label) for row in rows], [
            ("aya-eng", aya_retained, "unsafe"),
            ("massive-ar", massive_retained, "allow"),
        ])
        self.assertEqual(self.dropped, Counter({
            ("aya-eng", "eng"): 1,
            ("aya-arb", "arb"): 1,
            ("massive-ar", "train"): 1,
        }))

    def test_missing_exclusion_release_stops_training(self):
        with self.assertRaises(FileNotFoundError):
            train.load_exclusions(self.cache)


if __name__ == "__main__":
    unittest.main()
