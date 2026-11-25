import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest


PACKAGE = Path(__file__).resolve().parents[1]
ARABIC = (
    "يُراجع الطبيبُ نتائج التحاليل مع المريض في العيادة، ثم يشرح له أسباب الأعراض "
    "ويسأله عن النوم والحركة والطعام قبل تحديد الخطوة التالية."
)
ENGLISH = (
    "Several volunteers carry wooden benches into the reading room early each Saturday. "
    "The librarian sorts incoming books by topic so visitors can find a quiet place to study."
)
ARABIC_DEV = (
    "زرع الجيران أشجار الليمون قرب الحديقة، وتركوا ممرا واسعا بجانب السور. "
    "بعد هطول المطر توجه الأطفال إلى الملعب وانتظروا أصدقاءهم عند الباب."
)
ENGLISH_DEV = (
    "A small community theatre opens its doors before sunset to welcome local musicians. "
    "Guests listen to a string quartet and discuss the programme during the interval."
)
CALIBRATION = (
    "Beyond the harbour, an engineer inspected the lighthouse stairs while technicians "
    "replaced a cracked window and checked the wiring behind the lantern."
)
FROZEN = (
    "During the autumn festival the village baker brings warm bread and fresh cheese "
    "for visiting hikers across the valley."
)


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False) + "\n", encoding="utf-8")


def write_rows(path, rows):
    path.write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows),
        encoding="utf-8",
    )


def read_rows(path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def row(document_id, text):
    return {"id": document_id, "text": text}


class CorpusCase:
    def __init__(self, directory):
        self.directory = directory
        self.config_path = directory / "config.json"
        self.evaluation = directory / "frozen.jsonl"
        write_rows(self.evaluation, [row("fixture-eval", FROZEN)])
        self.config = {
            "sources": [],
            "frozen_evaluations": [{"path": self.evaluation.name, "sha256": sha256(self.evaluation)}],
        }
        self.add_source("train-ar", "train", [row("arabic", ARABIC)], language="ar")
        self.add_source("train-en", "train", [row("english", ENGLISH)], language="en")
        self.add_source("dev-ar", "development", [row("arabic-dev", ARABIC_DEV)], language="ar")
        self.add_source("dev-en", "development", [row("english-dev", ENGLISH_DEV)], language="en")
        self.add_source("cal-en", "calibration", [row("calibration", CALIBRATION)])

    def add_source(self, source_id, split, rows, *, language=None, kind="text", **card_updates):
        data = self.directory / f"{source_id}.jsonl"
        card = self.directory / f"{source_id}.card.json"
        write_rows(data, rows)
        write_json(card, {
            "source": f"Local hand-authored fixture {source_id}",
            "license": "CC0-1.0",
            "sha256": sha256(data),
            "download_date": "2026-11-25",
            "consent": "Fixture author released this text under CC0-1.0.",
            "origin": "human",
            **card_updates,
        })
        source = {"id": source_id, "path": data.name, "card": card.name, "split": split, "kind": kind}
        if language is not None:
            source["language"] = language
        self.config["sources"].append(source)
        return source

    def run(self, output_name, *, dry_run=False, seed="1"):
        write_json(self.config_path, self.config)
        output = self.directory / output_name
        argv = ["run", "--config", str(self.config_path), "--output", str(output)]
        if dry_run:
            argv.append("--dry-run")
        return output, cli(*argv, seed=seed)


def cli(*argv, seed="1"):
    return subprocess.run(
        [sys.executable, "-m", "corpus_pipeline", *argv],
        cwd=PACKAGE,
        env={**os.environ, "PYTHONHASHSEED": seed, "PYTHONIOENCODING": "utf-8"},
        encoding="utf-8",
        capture_output=True,
        check=False,
    )


@pytest.fixture
def corpus(tmp_path):
    return CorpusCase(tmp_path)


def test_outputs_are_reproducible_and_dry_run_writes_nothing(corpus):
    frozen_before = corpus.evaluation.read_bytes()
    first, run_one = corpus.run("first", seed="53")
    second, run_two = corpus.run("second", seed="94")
    dry, dry_run = corpus.run("dry", dry_run=True, seed="12")
    for run in (run_one, run_two, dry_run):
        assert run.returncode == 0, run.stderr
    assert not dry.exists()
    assert corpus.evaluation.read_bytes() == frozen_before

    first_manifest = (first / "manifest.json").read_bytes()
    assert first_manifest == (second / "manifest.json").read_bytes()
    assert json.loads(dry_run.stdout) == json.loads(first_manifest)
    manifest = json.loads(first_manifest)
    assert {shard["split"] for shard in manifest["shards"]} == {"train", "development", "calibration"}
    for shard in manifest["shards"]:
        assert sha256(first / shard["path"]) == shard["sha256"]
    confusion = json.loads((first / "language-confusion.json").read_text(encoding="utf-8"))
    assert confusion["total"] == 2
    assert confusion["matrix"] == {"ar": {"ar": 1, "en": 0}, "en": {"ar": 0, "en": 1}}
    audit = json.loads((first / "run.json").read_text(encoding="utf-8"))
    assert audit["manifest_sha256"] == sha256(first / "manifest.json")
    assert audit["started_at"] <= audit["finished_at"]
    assert all(Path(path).is_file() for path in audit["raw_outputs"])
    assert "--config" in audit["argv"]
    summary = (first / "report.ar.md").read_text(encoding="utf-8")
    assert "تقرير" in summary and audit["manifest_sha256"] in summary

    _, attempted_overwrite = corpus.run("first")
    assert attempted_overwrite.returncode != 0
    assert (first / "manifest.json").read_bytes() == first_manifest


def test_relocating_the_same_input_tree_preserves_the_manifest(tmp_path):
    original_root = tmp_path / "original"
    original_root.mkdir()
    corpus = CorpusCase(original_root)
    write_json(corpus.config_path, corpus.config)
    relocated_root = tmp_path / "relocated"
    shutil.copytree(original_root, relocated_root)
    first, initial = corpus.run("output")
    assert initial.returncode == 0, initial.stderr
    second = relocated_root / "output"
    relocated = cli("run", "--config", str(relocated_root / "config.json"), "--output", str(second))
    assert relocated.returncode == 0, relocated.stderr
    assert (second / "manifest.json").read_bytes() == (first / "manifest.json").read_bytes()


@pytest.mark.parametrize("bad_input", ["missing-card", "license", "source-pin", "evaluation-pin", "ai-origin"])
def test_unverified_inputs_never_publish_a_manifest(corpus, bad_input):
    source = corpus.config["sources"][0]
    card = corpus.directory / source["card"]
    if bad_input == "missing-card":
        card.unlink()
    elif bad_input == "evaluation-pin":
        corpus.config["frozen_evaluations"][0]["sha256"] = "0" * 64
    else:
        replacements = {
            "license": {"license": "CC-BY-NC-4.0"},
            "source-pin": {"sha256": "0" * 64},
            "ai-origin": {"origin": "public_ai"},
        }
        metadata = json.loads(card.read_text(encoding="utf-8"))
        write_json(card, {**metadata, **replacements[bad_input]})

    output, result = corpus.run("refused")
    assert result.returncode != 0
    assert result.stderr.strip()
    assert not (output / "manifest.json").exists()


def test_cleaning_splits_mixed_text_and_rejects_bad_documents(corpus):
    english = (
        "The observatory keeps a log of passing clouds and measures the brightness of nearby stars "
        "after closing its visitor center for the evening."
    )
    arabic = (
        "نظّـم\u200b المكتب لقاءً للأسر المهتمة بتعلم الرسم، وفتح أبوابه صباح الجمعة "
        "لاستقبال المشاركين في ورشة الخط والزخرفة."
    )
    corpus.add_source("mixed", "train", [
        row("mixed", f"{english}\n\n{arabic}"),
        row("contaminated", f"Two pages describe the following story. {FROZEN}"),
        row("repeating", "\n".join(["The machine repeats the exact same message each time."] * 12)),
        row("loop", "repeat now " * 20),
    ])
    corpus.add_source("dialogue", "train", [
        {"id": "broken", "turns": [
            {"role": "user", "content": "Can you describe the wildlife in a shallow pond?"},
            {"role": "assistant", "content": "Frogs, insects and several kinds of freshwater fish live there."},
        ]},
        {"id": "valid", "turns": [
            {"role": "user", "content": "Tell me how families can prepare for a visit to the museum."},
            {"role": "assistant", "content": "Read the visitor guide and leave time to explore the exhibits.<|eos|>"},
        ]},
    ], kind="dialogue")
    output, result = corpus.run("cleaned")
    assert result.returncode == 0, result.stderr

    training = read_rows(output / "train.jsonl")
    mixed = {part["language"]: part["text"] for part in training if part["source"] == "mixed"}
    assert mixed == {"en": english, "ar": arabic.replace("ـ", "").replace("\u200b", "")}
    dialogues = [part for part in training if part["source"] == "dialogue"]
    assert len(dialogues) == 1
    assert dialogues[0]["turns"][-1]["content"].endswith("<|eos|>")
    removals = {item["document_id"]: item["reasons"] for item in read_rows(output / "removals.jsonl")}
    assert set(removals) == {"contaminated", "repeating", "loop", "broken"}
    assert "contamination" in removals["contaminated"]
    assert "repeated_lines" in removals["repeating"]
    assert "top_ngram_repetition" in removals["loop"]
    assert "dialogue_missing_end_marker" in removals["broken"]
    hits = read_rows(output / "contamination.jsonl")
    assert len(hits) == 1
    assert hits[0]["evaluation_id"] == "fixture-eval"
    assert hits[0]["tokens"] >= 13
    assert FROZEN not in (output / "contamination.jsonl").read_text(encoding="utf-8")
    counts = json.loads((output / "manifest.json").read_text(encoding="utf-8"))["counts"]
    assert counts["contamination_hits"] == counts["reasons"]["contamination"] == 1
    assert counts["languages"]["ar"]["kept"] == 3


def test_exact_dedup_keeps_development_and_uses_prior_manifest(corpus):
    corpus.add_source("train-copy", "train", [
        row("should-stay-in-development", ENGLISH_DEV),
        row("arabic-copy", ARABIC.replace("يُ", "يـ").replace("ُ", "")),
    ])
    previous_output, initial = corpus.run("original")
    assert initial.returncode == 0, initial.stderr
    assert len(read_rows(previous_output / "train.jsonl")) == 2
    assert any(item["text"] == ENGLISH_DEV for item in read_rows(previous_output / "development.jsonl"))
    assert [item["reasons"] for item in read_rows(previous_output / "removals.jsonl")] == [
        ["exact_duplicate"], ["exact_duplicate"],
    ]

    corpus.config["prior_manifests"] = ["original/manifest.json"]
    later_output, later = corpus.run("later")
    assert later.returncode == 0, later.stderr
    assert not read_rows(later_output / "train.jsonl")
    assert read_rows(later_output / "removals.jsonl")

    with (previous_output / "train.jsonl").open("a", encoding="utf-8") as changed_shard:
        changed_shard.write("\n")
    failed_output, failed = corpus.run("tampered-prior")
    assert failed.returncode != 0
    assert not (failed_output / "manifest.json").exists()


def test_near_duplicate_is_reported_within_a_source(corpus):
    text = (
        "The coastal repair crew unlocks the workshop before breakfast and checks the weather "
        "forecast for wind. One carpenter sorts nails and screws into labeled drawers while a "
        "colleague records available planks, sharpens the small hand saw, and prepares fresh "
        "brushes for painting the pier railing before the afternoon tide rises."
    )
    corpus.add_source("coastal", "train", [
        row("original", text),
        row("near-twin", text.replace("pier railing", "deck railing")),
    ])
    output, result = corpus.run("near")
    assert result.returncode == 0, result.stderr
    assert [item["document_id"] for item in read_rows(output / "train.jsonl") if item["source"] == "coastal"] == [
        "original",
    ]
    assert any(
        item["document_id"] == "near-twin" and "near_duplicate" in item["reasons"]
        for item in read_rows(output / "removals.jsonl")
    )


def test_contamination_span_can_be_configured(corpus):
    span = " ".join(FROZEN.split()[:12])
    corpus.add_source("span", "train", [
        row("twelve-shared-tokens", f"An archivist transcribed this excerpt. {span} in handwoven baskets."),
    ])
    default_output, default = corpus.run("default-span")
    assert default.returncode == 0, default.stderr
    assert not read_rows(default_output / "contamination.jsonl")
    assert any(item["source"] == "span" for item in read_rows(default_output / "train.jsonl"))

    corpus.config["contamination_span_tokens"] = 12
    shorter_output, shorter = corpus.run("shorter-span")
    assert shorter.returncode == 0, shorter.stderr
    assert [item["tokens"] for item in read_rows(shorter_output / "contamination.jsonl")] == [12]
    assert all(item["source"] != "span" for item in read_rows(shorter_output / "train.jsonl"))


def test_frozen_evaluation_cannot_be_registered_as_a_source(corpus):
    copy = corpus.add_source("eval-copy", "train", [row("fixture-eval", FROZEN)])
    assert (corpus.directory / copy["path"]).read_bytes() == corpus.evaluation.read_bytes()
    output, result = corpus.run("refused-frozen")
    assert result.returncode != 0
    assert not (output / "manifest.json").exists()


def test_review_verification_rejects_tampered_shard_and_fixture_mode(corpus):
    clean_output, cleaned = corpus.run("reviewed")
    assert cleaned.returncode == 0, cleaned.stderr
    manifest_path = clean_output / "manifest.json"
    review_path = corpus.directory / "review.json"
    review = {
        "manifest_sha256": sha256(manifest_path),
        "reviewer": "Fixture Reviewer",
        "reviewed_at": "2026-11-25T12:00:00+00:00",
        "decision": "approved",
    }
    write_json(review_path, review)
    argv = ["verify", "--manifest", str(manifest_path), "--review", str(review_path)]
    verified = cli(*argv)
    assert verified.returncode == 0, verified.stderr

    write_json(review_path, {**review, "decision": "pending"})
    assert cli(*argv).returncode != 0
    write_json(review_path, review)
    audit = clean_output / "contamination.jsonl"
    original_audit = audit.read_bytes()
    audit.write_bytes(original_audit + b"\n")
    assert cli(*argv).returncode != 0
    audit.write_bytes(original_audit)
    with (clean_output / "train.jsonl").open("a", encoding="utf-8") as changed_shard:
        changed_shard.write("\n")
    assert cli(*argv).returncode != 0

    corpus.config["fixture_mode"] = True
    fixture_output, fixture_run = corpus.run("fixture")
    assert fixture_run.returncode == 0, fixture_run.stderr
    fixture_manifest = fixture_output / "manifest.json"
    write_json(review_path, {**review, "manifest_sha256": sha256(fixture_manifest)})
    assert cli("verify", "--manifest", str(fixture_manifest), "--review", str(review_path)).returncode != 0


@pytest.mark.parametrize("alteration", ["forged-count", "no-policy-evidence"])
def test_review_verification_checks_manifest_evidence(corpus, alteration):
    output, result = corpus.run("claimed-counts")
    assert result.returncode == 0, result.stderr
    manifest_path = output / "manifest.json"
    manifest = json.loads(manifest_path.read_bytes())
    if alteration == "forged-count":
        train = next(shard for shard in manifest["shards"] if shard["split"] == "train")
        file = output / train["path"]
        file.write_bytes(b"")
        train.update({"sha256": sha256(file), "bytes": 0})
        expected_error = "fingerprint mismatch"
    else:
        del manifest["filter_versions"]
        expected_error = "missing policy evidence"
    write_json(manifest_path, manifest)
    review_path = corpus.directory / "review.json"
    write_json(review_path, {
        "manifest_sha256": sha256(manifest_path),
        "reviewer": "Fixture Reviewer",
        "reviewed_at": "2026-11-25T12:00:00Z",
        "decision": "approved",
    })
    verified = cli("verify", "--manifest", str(manifest_path), "--review", str(review_path))
    assert verified.returncode != 0
    assert expected_error in verified.stderr
