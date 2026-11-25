"""Focused checks of corpus mapping, splits, and source integrity."""

import hashlib
import io
import json
import tarfile
import tempfile
import unittest
import zipfile
from collections import Counter
from pathlib import Path

from prepare_data import DATA_DIR, SEED, Example, canard_rows, deduplicate, massive_rows, pin_source, source_mapping


class PrepareDataTests(unittest.TestCase):
    def test_sources_have_verified_data_license_pins(self):
        sources = json.loads((DATA_DIR / "sources.json").read_text(encoding="utf-8"))
        licenses = {data["license"] for data in sources.values()}
        self.assertEqual(licenses, {"CC-BY-3.0", "CC-BY-4.0", "CC-BY-SA-4.0", "Apache-2.0"})
        for metadata in sources.values():
            self.assertRegex(metadata["sha256"], r"^[0-9a-f]{64}$")
            self.assertTrue(metadata["url"].startswith("https://"))

    def test_cached_bytes_require_a_matching_sha256(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            name = "pinned.json"
            data = b"{}"
            (cache / name).write_bytes(data)
            metadata = {"sha256": hashlib.sha256(data).hexdigest()}
            self.assertEqual(pin_source(cache, name, metadata), cache / name)
            (cache / name).write_bytes(b"different bytes")
            with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
                pin_source(cache, name, metadata)

    def test_label_mapping_rejects_duplicate_source_intents(self):
        mapping = {"example": [
            {"source": ["greeting"], "labels": {"speechAct": "smalltalk"}},
            {"source": ["greeting"], "labels": {"speechAct": "request"}},
        ]}
        with self.assertRaisesRegex(ValueError, "Duplicate label"):
            source_mapping(mapping, "example")

    def test_deduplicates_runtime_folded_rows_and_removes_conflicts(self):
        labels = {"speechAct": "smalltalk", "route": "chat"}
        rows = [Example("first", "train", "أَهْلًا", labels),
                Example("second", "test", "اهلا!", labels),
                Example("second", "test", "اهلا", labels)]
        self.assertEqual(list(deduplicate(rows)), [rows[1]])
        rows.append(Example("first", "train", "اهلا", {"route": "writing"}))
        self.assertEqual(list(deduplicate(rows)), [Example("second", "test", "اهلا!", {"speechAct": "smalltalk"})])

    def test_massive_keeps_parallel_development_groups_together(self):
        mapping = json.loads((DATA_DIR / "label-map.json").read_text(encoding="utf-8"))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "massive.tar.gz"
            with tarfile.open(path, "w:gz") as archive:
                for locale, phrases in (("ar-SA", ("مرحبًا", "صباح الخير")), ("en-US", ("hello", "good morning"))):
                    content = "\n".join(json.dumps({"partition": "dev", "intent": "general_greet",
                                                   "id": str(index), "utt": phrase})
                                        for index, phrase in enumerate(phrases)).encode("utf-8")
                    member = tarfile.TarInfo(f"1.0/data/{locale}.jsonl")
                    member.size = len(content)
                    archive.addfile(member, io.BytesIO(content))
            rows = list(massive_rows(path, mapping, SEED))
        self.assertEqual(Counter(row.split for row in rows), {"dev": 2, "calibration": 2})
        self.assertEqual([row.split for row in rows[:2]], [row.split for row in rows[2:]])

    def test_canard_uses_later_questions_and_human_context_restoration(self):
        rows = [
            {"History": ["Alan Turing", "Early life"], "Question": "Where was he born?",
             "Rewrite": "Where was Alan Turing born?", "QuAC_dialog_id": "section"},
            {"History": ["Alan Turing", "Early life", "Where was he born?", "London"],
             "Question": "What was his first school?", "Rewrite": "What was Alan Turing's first school?",
             "QuAC_dialog_id": "section"},
            {"History": ["Alan Turing", "Early life", "Where was he born?", "London"],
             "Question": "Where is London?", "Rewrite": "where is London", "QuAC_dialog_id": "section"},
            {"History": ["Alan Turing", "Early life", "Where was he born?", "London"],
             "Question": "Where was he taught?", "Rewrite": "Which school did he attend?", "QuAC_dialog_id": "section"},
        ]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "canard.zip"
            with zipfile.ZipFile(path, "w") as archive:
                for split in ("train", "dev", "test"):
                    archive.writestr(f"CANARD_Release/{split}.json", json.dumps(rows if split == "dev" else []))
            selected = list(canard_rows(path, SEED))
        self.assertEqual([row.labels["followUp"] for row in selected], ["follow_up", "new"])
        self.assertEqual([row.previous for row in selected], ["Where was he born?"] * 2)
        self.assertEqual(len({row.split for row in selected}), 1)


if __name__ == "__main__":
    unittest.main()
