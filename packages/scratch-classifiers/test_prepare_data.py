"""Focused checks of corpus mapping, splits, and source integrity."""

import csv
import hashlib
import io
import json
import tarfile
import tempfile
import unittest
import zipfile
from collections import Counter
from pathlib import Path

from data_guard import DEFAULT_MANIFEST, REGISTRY_SHA256, ContaminationGuard, Exclusions, read_receipt, receipt_path
from exclusion import text_sha256
from prepare_data import (
    DATA_DIR, SEED, Example, canard_rows, clinc_rows, deduplicate, dialect_rows, massive_rows, pin_source,
    red_teaming_rows, source_mapping,
)


def guard(ids=(), texts=()):
    return ContaminationGuard(Exclusions(frozenset(ids), frozenset(map(text_sha256, texts))))


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
            rows = list(massive_rows(path, mapping, SEED, guard()))
        self.assertEqual(Counter(row.split for row in rows), {"dev": 2, "calibration": 2})
        self.assertEqual([row.split for row in rows[:2]], [row.split for row in rows[2:]])

    def test_canard_uses_later_questions_and_human_context_restoration(self):
        rows = [
            {"History": ["Alan Turing", "Early life"], "Question": "Where was he born?",
             "Rewrite": "Where was Alan Turing born?", "QuAC_dialog_id": "section", "Question_no": 1},
            {"History": ["Alan Turing", "Early life", "Where was he born?", "London"],
             "Question": "What was his first school?", "Rewrite": "What was Alan Turing's first school?",
             "QuAC_dialog_id": "section", "Question_no": 2},
            {"History": ["Alan Turing", "Early life", "Where was he born?", "London"],
             "Question": "Where is London?", "Rewrite": "where is London", "QuAC_dialog_id": "section", "Question_no": 3},
            {"History": ["Alan Turing", "Early life", "Where was he born?", "London"],
             "Question": "Where was he taught?", "Rewrite": "Which school did he attend?", "QuAC_dialog_id": "section", "Question_no": 4},
        ]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "canard.zip"
            with zipfile.ZipFile(path, "w") as archive:
                for split in ("train", "dev", "test"):
                    archive.writestr(f"CANARD_Release/{split}.json", json.dumps(rows if split == "dev" else []))
            selected = list(canard_rows(path, SEED, guard()))
        self.assertEqual([row.labels["followUp"] for row in selected], ["follow_up", "new"])
        self.assertEqual([row.previous for row in selected], ["Where was he born?"] * 2)
        self.assertEqual(len({row.split for row in selected}), 1)

    def test_clinc_native_ids_remove_duplicates_before_deduplication(self):
        mapping = json.loads((DATA_DIR / "label-map.json").read_text(encoding="utf-8"))
        exclusions = guard(ids=("clinc150:test:1", "clinc150:oos_test:0"), texts=("exact match",))
        fixture = {
            "train": [["eligible duplicate", "greeting"], ["  EXACT MATCH  ", "greeting"]],
            "val": [], "oos_train": [], "oos_val": [],
            "test": [["unmapped cue", "unmapped"], ["eligible duplicate", "greeting"], ["test survivor", "greeting"]],
            "oos_test": [["scope survivor to block", "oos"]],
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "clinc.json"
            path.write_text(json.dumps(fixture), encoding="utf-8")
            rows = list(deduplicate(list(clinc_rows(path, mapping, SEED, exclusions))))
        self.assertEqual([(row.text, row.split) for row in rows], [("eligible duplicate", "train"), ("test survivor", "test")])
        self.assertEqual(exclusions.rejected, {("clinc150", "train"): 1, ("clinc150", "test"): 1, ("clinc150", "oos_test"): 1})

    def test_massive_native_ids_block_both_locales_before_development_splitting(self):
        mapping = json.loads((DATA_DIR / "label-map.json").read_text(encoding="utf-8"))
        exclusions = guard(ids=("massive:42",), texts=("exact locale-only match",))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "massive.tar.gz"
            with tarfile.open(path, "w:gz") as archive:
                for locale in ("ar-SA", "en-US"):
                    data = [
                        {"partition": "dev", "intent": "general_greet", "id": str(index),
                         "utt": "exact locale-only match" if (locale, index) == ("ar-SA", 41) else f"{locale} distinct utterance {index}"}
                        for index in (40, 41, 42, 43)
                    ]
                    content = "\n".join(map(json.dumps, data)).encode("utf-8")
                    member = tarfile.TarInfo(f"1.0/data/{locale}.jsonl")
                    member.size = len(content)
                    archive.addfile(member, io.BytesIO(content))
            rows = list(massive_rows(path, mapping, SEED, exclusions))
        folds = {row.text: row.split for row in rows}
        for index in (40, 43):
            self.assertEqual(folds[f"ar-SA distinct utterance {index}"], folds[f"en-US distinct utterance {index}"])
        self.assertIn("en-US distinct utterance 41", folds)
        self.assertEqual(len(folds), 5)
        self.assertEqual(exclusions.rejected, {("massive-ar-SA", "dev"): 2, ("massive-en-US", "dev"): 1})

    def test_canard_gate_checks_current_previous_and_native_dialogue_question_id(self):
        exclusions = guard(ids=("canard:example:7",), texts=("blocked current", "blocked previous"))
        questions = [
            (5, "blocked current", "ordinary earlier question"),
            (6, "would be new", "  BLOCKED PREVIOUS  "),
            (7, "changed text under blocked id", "ordinary earlier question"),
            (8, "ordinary new question", "ordinary earlier question"),
        ]
        fixture = [{"History": ["title", "section", previous, "answer"], "Question": text,
                    "Rewrite": text, "QuAC_dialog_id": "example", "Question_no": number}
                   for number, text, previous in questions]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "canard.zip"
            with zipfile.ZipFile(path, "w") as archive:
                for split in ("train", "dev", "test"):
                    archive.writestr(f"CANARD_Release/{split}.json", json.dumps(fixture if split == "test" else []))
            selected = list(canard_rows(path, SEED, exclusions))
        self.assertEqual([(row.text, row.previous) for row in selected], [("ordinary new question", "ordinary earlier question")])
        self.assertEqual(exclusions.rejected, {("canard", "test"): 3})

    def test_dialect_and_aya_model_inputs_are_also_filtered(self):
        exclusions = guard(texts=("dialect test match", "aya prompt match"))
        mapping = {
            "arbanking77": [{"source": ["payment"], "labels": {"route": "unsupported"}}],
            "ayaGlobalHarm": ["test-annotation"],
        }
        with tempfile.TemporaryDirectory() as directory:
            dialect = Path(directory) / "dialect.csv"
            with dialect.open("w", encoding="utf-8", newline="") as stream:
                writer = csv.writer(stream)
                writer.writerow(["Intent_en", "QID", "QuestionID_PAL1", "Question_PAL1", "QuestionID_PAL2", "Question_PAL2"])
                writer.writerow(["payment", "1", "Tr1", "lower-priority variant", "Te1", "dialect test match"])
                writer.writerow(["payment", "2", "Tr2", "separate eligible group", "NULL", "NULL"])
            aya = Path(directory) / "aya.jsonl"
            aya.write_text("\n".join(json.dumps({"prompt": text, "harm_category": '["test-annotation"]', "global_or_local": "global"})
                                     for text in ("Aya prompt match", "separate Aya input")), encoding="utf-8")
            dialect_examples = list(dialect_rows(dialect, mapping, SEED, exclusions))
            aya_examples = list(red_teaming_rows(aya, mapping, SEED, "eng", exclusions))
        self.assertEqual([row.text for row in dialect_examples], ["separate eligible group"])
        self.assertEqual([row.text for row in aya_examples], ["separate Aya input"])
        self.assertEqual(exclusions.rejected, {("arbanking77-pal", "test"): 1, ("aya-eng", "unsplit"): 1})

    def test_verified_registry_requires_pinned_manifest_and_both_unmodified_partitions(self):
        expected = ContaminationGuard.load()
        self.assertEqual(len(expected.exclusions.source_ids), 3600)
        self.assertEqual(len(expected.exclusions.text_hashes), 4484)
        with tempfile.TemporaryDirectory() as directory:
            manifest = Path(directory) / "manifest.json"
            manifest.write_bytes(DEFAULT_MANIFEST.read_bytes() + b"\n")
            with self.assertRaisesRegex(ValueError, "manifest SHA-256 mismatch"):
                ContaminationGuard.load(manifest)
            manifest.write_bytes(DEFAULT_MANIFEST.read_bytes())
            with self.assertRaises(FileNotFoundError):
                ContaminationGuard.load(manifest)
            manifest.with_name("sealed.jsonl").write_bytes(b"{}")
            with self.assertRaisesRegex(ValueError, "sealed exclusion checksum mismatch"):
                ContaminationGuard.load(manifest)
            manifest.with_name("sealed.jsonl").write_bytes(DEFAULT_MANIFEST.with_name("sealed.jsonl").read_bytes())
            manifest.with_name("dev.jsonl").write_bytes(b"{}")
            with self.assertRaisesRegex(ValueError, "dev exclusion checksum mismatch"):
                ContaminationGuard.load(manifest)

    def test_prepared_data_receipt_requires_correct_digest_seed_and_registry(self):
        digest = hashlib.sha256(b"prepared bytes").hexdigest()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "data.jsonl"
            with self.assertRaises(FileNotFoundError):
                read_receipt(path, digest, SEED)
            receipt = guard().receipt(digest, SEED)
            self.assertEqual(receipt["manifestSha256"], REGISTRY_SHA256)
            receipt_path(path).write_text(json.dumps(receipt), encoding="utf-8")
            self.assertEqual(read_receipt(path, digest, SEED), receipt)
            for actual_digest, seed in (("0" * 64, SEED), (digest, SEED + 1)):
                with self.assertRaisesRegex(ValueError, "receipt does not match"):
                    read_receipt(path, actual_digest, seed)


if __name__ == "__main__":
    unittest.main()
