"""Run the exclusion filter against the three pinned training preparation paths."""

import hashlib
import importlib
import io
import json
import subprocess
import sys
import tarfile
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "scripts/agent-capability-bench/v2"))
from exclusion import DEFAULT_MANIFEST, Exclusions, read_benchmark, text_sha256


SNAPSHOTS = (
    ("4eaa5f0cdc6769f02dff4b378cc8e41dd3bd939e", "packages/head-training/head_training"),
    ("76b1a9325a5ef4edda84816cc6523aa06026121e", "packages/scratch-classifiers"),
    ("f1ea533a3a33302b621b9e416c543941ccabbc53", "scripts/refusal-classifier/train.py"),
)
CONTROL = hashlib.sha256(Path(__file__).name.encode()).hexdigest()


class TrainingExclusionIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        snapshot = Path(cls.enterClassContext(tempfile.TemporaryDirectory()))
        for commit, path in SNAPSHOTS:
            archive = subprocess.check_output(["git", "archive", commit, path], cwd=REPO_ROOT)
            with tarfile.open(fileobj=io.BytesIO(archive)) as bundle:
                bundle.extractall(snapshot, filter="data")

        paths = [
            snapshot / "scripts/refusal-classifier",
            snapshot / "packages/scratch-classifiers",
            snapshot / "packages/head-training",
        ]
        with patch.object(sys, "path", [*(str(path) for path in paths), *sys.path]):
            cls.heads = importlib.import_module("head_training.datasets")
            cls.scratch = importlib.import_module("prepare_data")
            cls.refusal = importlib.import_module("train")

        cls.exclusions = Exclusions.load()
        development = next(
            case for case in read_benchmark(REPO_ROOT, partitions=("dev",))["dev"]
            if case["provenance"]["source"].startswith("clinc150:test:")
            and case["area"] == "small-talk"
        )
        # Supply the dev text in the training partition with a compatible fixture label.
        # The case and whitespace changes exercise the shared normalization.
        cls.development_text = development["turns"][0]["text"]
        cls.training_text = f"  {cls.development_text.upper()}\t"
        with DEFAULT_MANIFEST.with_name("sealed.jsonl").open(encoding="utf-8") as stream:
            source_ids = (json.loads(line)["source_id"] for line in stream)
            cls.sealed_index = min(
                int(source_id.rsplit(":", 1)[1]) for source_id in source_ids
                if source_id.startswith("clinc150:test:")
            )

    def setUp(self):
        self.directory = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.sealed_id = f"clinc150:test:{self.sealed_index}"
        self.sealed_text = f"{CONTROL}:{self.sealed_index}"
        self.clinc = {
            "train": [[self.training_text, "greeting"], [CONTROL, "greeting"]],
            "val": [], "oos_train": [], "oos_val": [], "oos_test": [],
            "test": [[f"{CONTROL}:{index}", "unmapped"] for index in range(self.sealed_index)]
            + [[self.sealed_text, "greeting"]],
        }
        self.assertEqual(text_sha256(self.development_text), text_sha256(self.training_text))
        self.assertTrue(self.exclusions.matches((self.training_text,)))
        self.assertFalse(self.exclusions.matches((CONTROL,)))
        self.assertFalse(self.exclusions.matches((self.sealed_text,)))
        self.assertTrue(self.exclusions.matches((), source_id=self.sealed_id))

    def write_clinc(self, path, *, exclude=False):
        path.parent.mkdir(parents=True, exist_ok=True)
        clinc = self.clinc
        if exclude:
            # Gate the raw items with the original partition indices before the
            # archived preparation functions discard the upstream IDs.
            clinc = {
                split: [
                    (text, intent) for index, (text, intent) in enumerate(rows)
                    if not self.exclusions.matches(text, source_id=f"clinc150:{split}:{index}")
                ]
                for split, rows in self.clinc.items()
            }
        path.write_text(json.dumps(clinc), encoding="utf-8")
        return path

    def test_head_kit_loader_drops_by_source_id_or_text(self):
        card = self.heads.CATALOG["clinc150"]
        source, *others = card.files
        path = self.write_clinc(self.directory / "clinc150" / source.filename)
        source = replace(source, sha256=hashlib.sha256(path.read_bytes()).hexdigest())
        card = replace(card, files=(source, *others))
        with patch.dict(self.heads.CATALOG, {"clinc150": card}):
            dataset = self.heads.load_dataset("clinc150", "intent", self.directory, allow_download=False)

        before = {row.id: row for row in dataset.examples}
        self.assertEqual(before[self.sealed_id].text, self.sealed_text)
        self.assertEqual(before["clinc150:train:0"].text, self.training_text)
        after = {
            row.id: row for row in dataset.examples
            if not self.exclusions.matches((row.text, *row.history, *row.candidates), source_id=row.id)
        }
        self.assertNotIn(self.sealed_id, after)
        self.assertNotIn("clinc150:train:0", after)
        self.assertEqual(after["clinc150:train:1"].text, CONTROL)

    def test_scratch_preparation_drops_source_id_or_text(self):
        before_path = self.write_clinc(self.directory / "original.json")
        after_path = self.write_clinc(self.directory / "filtered.json", exclude=True)
        mapping = json.loads((self.scratch.DATA_DIR / "label-map.json").read_text(encoding="utf-8"))
        before_rows = list(self.scratch.clinc_rows(before_path, mapping, self.scratch.SEED))
        after_rows = list(self.scratch.clinc_rows(after_path, mapping, self.scratch.SEED))
        before = list(self.scratch.deduplicate(before_rows))
        after = list(self.scratch.deduplicate(after_rows))
        self.assertEqual([row.text for row in before], [self.training_text, CONTROL, self.sealed_text])
        self.assertEqual([row.text for row in after], [CONTROL])

    def test_refusal_preparation_drops_source_id_or_text(self):
        self.write_clinc(self.directory / "clinc150.json")
        for locale in ("eng", "arb"):
            (self.directory / f"aya-{locale}.jsonl").touch()
        with tarfile.open(self.directory / "massive.tar.gz", mode="w:gz") as archive:
            archive.addfile(tarfile.TarInfo("1.0/data/ar-SA.jsonl"), io.BytesIO())
        with patch.object(self.refusal, "pinned_source", side_effect=lambda cache, name: cache / name):
            before = list(self.refusal.deduplicate(self.refusal.public_rows(self.directory)))
            self.write_clinc(self.directory / "clinc150.json", exclude=True)
            after = list(self.refusal.deduplicate(self.refusal.public_rows(self.directory)))
        self.assertEqual([row.text for row in before], [self.training_text, CONTROL, self.sealed_text])
        self.assertEqual([row.text for row in after], [CONTROL])


if __name__ == "__main__":
    unittest.main()
