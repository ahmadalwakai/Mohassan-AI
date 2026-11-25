"""Exercise the published v2 exclusion bundle without reading benchmark cases."""

from __future__ import annotations

import json
import re
import shutil
from dataclasses import replace
from hashlib import sha256
from pathlib import Path
from typing import Any

import pytest
from pyarrow import Table, parquet  # type: ignore[import-untyped]
from test_datasets import encoded, fixture_sources, make_qa, tarred, zipped

from head_training import datasets, owner_data, v2_exclusion
from head_training.config import OwnerSource, Pin


def _published_ids(partition: str, prefix: str) -> list[str]:
    path = v2_exclusion.MANIFEST_PATH.with_name(f"{partition}.jsonl")
    entries = (json.loads(line) for line in path.read_bytes().splitlines())
    return [entry["source_id"] for entry in entries if entry["source_id"].startswith(prefix)]


def _assert_public_counts(dataset: datasets.Dataset, total: int, dropped: int) -> None:
    receipt = dataset.card.exclusion
    assert receipt is not None
    assert receipt.manifest_sha256 == v2_exclusion.MANIFEST_SHA256
    assert receipt.input_rows == total
    assert receipt.dropped_rows == dropped
    assert len(dataset.examples) == total - dropped


@pytest.mark.parametrize("partition", ["sealed", "dev"])
def test_clinc_blocks_published_out_of_scope_ids_at_native_indices(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, partition: str,
) -> None:
    prefix = "clinc150:oos_test:"
    withheld = _published_ids(partition, prefix)
    index = min(int(item.removeprefix(prefix)) for item in withheld)
    examples = [[f"Head training exclusion fixture CLINC {i}.", "oos"] for i in range(index + 1)]
    registry = v2_exclusion.load_registry()
    assert registry.matches((), source_id=f"{prefix}{index}")
    assert not registry.matches(examples[index][0])
    cache = fixture_sources(monkeypatch, tmp_path, "clinc150", {
        "clinc.json": encoded({"oos_test": examples, "train": [["Control from a separate split.", "label"]]}),
        "clinc-domains.json": encoded({}),
    })
    dataset = datasets.load_dataset("clinc150", "out_of_scope", cache)
    observed = {row.id for row in dataset.examples}
    expected = {f"{prefix}{i}" for i in range(len(examples))} - registry.source_ids
    assert observed == expected | {"clinc150:train:0"}
    assert f"{prefix}{index}" not in observed
    _assert_public_counts(dataset, len(examples) + 1, len(examples) - len(expected))


def test_massive_blocks_both_translations_of_published_id(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    blocked_id = int(_published_ids("sealed", "massive:")[0].rsplit(":", 1)[-1])
    registry = v2_exclusion.load_registry()
    clean_id = max(int(item.removeprefix("massive:")) for item in registry.source_ids if item.startswith("massive:")) + 1
    members = {
        f"1.1/data/{locale}.jsonl": b"".join(
            encoded({
                "id": key, "locale": locale, "partition": "test", "intent": "alarm_set", "scenario": "alarm",
                "utt": f"Handwritten translation test control only {locale} {key}.",
            }) + b"\n"
            for key in (blocked_id, clean_id)
        )
        for locale in ("ar-SA", "en-US")
    }
    cache = fixture_sources(monkeypatch, tmp_path, "massive", {"massive.tar.gz": tarred(members)})
    dataset = datasets.load_dataset("massive", "intent", cache)
    assert {row.id for row in dataset.examples} == {f"massive:{language}:{clean_id}" for language in ("ar", "en")}
    _assert_public_counts(dataset, 4, 2)


def test_tydi_blocks_published_mirror_id_after_google_id_conversion(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    _, key, language = _published_ids("dev", "tydiqa:")[0].split(":")
    upstream_language = {"ar": "arabic", "en": "english"}[language]
    prefix = f"{upstream_language}-"
    clean = "991230123-1"
    path = tmp_path / "source.parquet"

    def source_file(ids: list[str]) -> bytes:
        parquet.write_table(Table.from_pylist([
            {
                "id": prefix + item, "title": "Synthetic geography", "context": "One line. A seal walks.",
                "question": f"Which of two fixture sentences has the mammal in {item}?",
                "answers": {"answer_start": [12], "text": ["seal"]},
            }
            for item in ids
        ]), path)
        return path.read_bytes()

    cache = fixture_sources(monkeypatch, tmp_path, "tydiqa", {
        "tydiqa-train.parquet": source_file([]),
        "tydiqa-validation.parquet": source_file([key, clean]),
    })
    dataset = datasets.load_dataset("tydiqa", "sentence_selection", cache)
    assert [row.id for row in dataset.examples] == [f"tydiqa:{language}:{prefix}{clean}"]
    _assert_public_counts(dataset, 2, 1)


@pytest.mark.parametrize("verified", [True, False])
def test_quac_alias_requires_pinned_canard_question_match(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, verified: bool,
) -> None:
    _, dialogue, question_no = next(
        source_id.split(":") for source_id in _published_ids("sealed", "canard:")
        if re.fullmatch(r"canard:C_[a-f0-9]+_\d+:[1-9]\d*", source_id)
    )
    qid = f"{dialogue}_q#{int(question_no) - 1}"
    question = "Which handmade figurine belongs to the test exhibit?"
    canard = [{
        "QuAC_dialog_id": dialogue,
        "Question_no": int(question_no),
        "Question": question if verified else f"{question} The archive records different wording.",
        "Rewrite": "Identify the figurine from the invented exhibit.",
        "History": [],
    }]
    fixture_sources(monkeypatch, tmp_path, "canard", {
        "canard.zip": zipped({
            f"CANARD_Release/{split}.json": encoded(canard if split == "test" else [])
            for split in ("train", "dev", "test")
        }),
    })
    quac = {"data": [{"title": "Fixture title", "section_title": "Fixture section", "paragraphs": [{
        "id": dialogue,
        "qas": [{"id": qid, "question": question, "followup": "y", "orig_answer": {"text": "A small duck."}}],
    }]}]}
    cache = fixture_sources(monkeypatch, tmp_path, "quac", {
        "quac-train.json": encoded(quac), "quac-dev.json": encoded({"data": []}),
    })
    registry = v2_exclusion.load_registry()
    assert not registry.matches(question, source_id=f"quac:{qid}")
    dataset = datasets.load_dataset("quac", "turn_type", cache)
    expected = [] if verified else [f"quac:{qid}"]
    assert [row.id for row in dataset.examples] == expected
    assert any(source.filename == "canard.zip" for source in dataset.provenance)
    _assert_public_counts(dataset, 1, int(verified))


@pytest.fixture
def normalized_overlap(monkeypatch: pytest.MonkeyPatch) -> str:
    # Augment the loaded registry with a handwritten digest for field tests.
    registry = v2_exclusion.load_registry()
    digest = sha256(b"head kit overlap phrase.").hexdigest()
    with_fixture = replace(registry, text_hashes=registry.text_hashes | {digest})
    monkeypatch.setattr(datasets, "load_registry", lambda: with_fixture)
    monkeypatch.setattr(owner_data, "load_registry", lambda: with_fixture)
    return "ＨＥＡＤ kit  OVERLAP phrase."


@pytest.mark.parametrize("field", ["text", "history", "candidate"])
def test_public_loader_gates_each_model_visible_field(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, normalized_overlap: str, field: str,
) -> None:
    task = "sentence_selection" if field == "candidate" else "sufficiency"
    question = normalized_overlap if field == "text" else "What is the fixture lesson?"
    context = {
        "text": "This is an answer.",
        "history": normalized_overlap,
        "candidate": f"This is an answer. {normalized_overlap} End of passage.",
    }[field]
    match = make_qa("Synthetic article", "blocked", context, question, [{"answer_start": 8, "text": "an answer"}])
    clean = make_qa("Separate article", "kept", "This is an answer. This is a second sentence.",
                    "What is the unrelated fixture lesson?", [{"answer_start": 8, "text": "an answer"}])
    for article in (*match["data"], *clean["data"]):
        article["paragraphs"][0]["qas"][0]["is_impossible"] = False
    cache = fixture_sources(monkeypatch, tmp_path, "squad2", {
        "squad2-train.json": encoded({"data": match["data"] + clean["data"]}),
        "squad2-dev.json": encoded({"data": []}),
    })
    dataset = datasets.load_dataset("squad2", task, cache)
    assert [row.id for row in dataset.examples] == ["squad2:en:kept"]
    _assert_public_counts(dataset, 2, 1)


def _owner_source(tmp_path: Path, rows: list[dict[str, Any]]) -> OwnerSource:
    rows_path = tmp_path / "examples.jsonl"
    rows_path.write_bytes(b"".join(encoded(row) + b"\n" for row in rows))
    rows_pin = Pin(rows_path, sha256(rows_path.read_bytes()).hexdigest())
    card_path = tmp_path / "source-card.json"
    card_path.write_bytes(encoded({
        "source": "handwritten regression fixture", "license": "CC0-1.0", "consent": "approved for testing",
        "reviewer": "fixture owner", "download_date": "2026-11-25",
        "origin": "human", "decision": "approved", "sha256": rows_pin.sha256,
    }))
    return OwnerSource(rows_pin, Pin(card_path, sha256(card_path.read_bytes()).hexdigest()))


def test_owner_loader_gates_model_inputs_and_pinned_source_metadata(
    tmp_path: Path, normalized_overlap: str,
) -> None:
    primary = _published_ids("sealed", "clinc150:")[0]
    alias = _published_ids("dev", "clinc150:")[0]
    common = {
        "language": "en", "group": "fixture", "split": "train",
        "text": "Which of these invented answers is safe for the regression?",
        "candidates": ["One response.", "Two responses."], "gold": [0],
    }
    source = _owner_source(tmp_path, [
        {**common, "id": "kept"},
        {**common, "id": "text", "text": normalized_overlap},
        {**common, "id": "history", "history": [normalized_overlap]},
        {**common, "id": "candidate", "candidates": [normalized_overlap, "Other response."]},
        {**common, "id": "native", "source_id": primary},
        {**common, "id": "alias", "source_id": "owner-fixture:item", "source_ids": [alias]},
    ])
    rows, provenance = owner_data.read_owner_source(source, "rewrite")
    assert [row.id for row in rows] == ["kept"]
    record = provenance["card"]
    assert isinstance(record, dict)
    assert record["exclusion"] == {
        "manifest_sha256": v2_exclusion.MANIFEST_SHA256, "input_rows": 6, "dropped_rows": 5,
    }


@pytest.mark.parametrize("filename", ["manifest.json", "dev.jsonl", "sealed.jsonl"])
@pytest.mark.parametrize("mutation", ["modified", "missing"])
def test_loaders_fail_closed_on_invalid_exclusion_bundle(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, filename: str, mutation: str,
) -> None:
    registry = tmp_path / "exclusion"
    shutil.copytree(v2_exclusion.MANIFEST_PATH.parent, registry)
    target = registry / filename
    if mutation == "modified":
        # Whitespace leaves the parsed manifest semantically identical, but changes its pin.
        target.write_bytes(target.read_bytes() + b"\n")
    else:
        target.unlink()
    monkeypatch.setattr(v2_exclusion, "MANIFEST_PATH", registry / "manifest.json")
    cache = tmp_path / "unused-cache"
    with pytest.raises((OSError, ValueError), match="(?i)exclusion"):
        datasets.load_dataset("clinc150", "intent", cache)
    assert not cache.exists()
    owner_source = _owner_source(tmp_path, [{
        "id": "control", "group": "fixture", "language": "en", "text": "Owner control", "label": "control",
    }])
    with pytest.raises((OSError, ValueError), match="(?i)exclusion"):
        owner_data.read_owner_source(owner_source, "intent")


def test_published_reader_uses_the_checked_manifest_snapshot(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    registry = tmp_path / "exclusion"
    shutil.copytree(v2_exclusion.MANIFEST_PATH.parent, registry)
    original = registry / "manifest.json"
    monkeypatch.setattr(v2_exclusion, "MANIFEST_PATH", original)
    read = v2_exclusion.Exclusions.load

    def replace_manifest_before_library_reads(path: Path) -> v2_exclusion.Exclusions:
        original.write_bytes(b"{}\n")
        return read(path)

    monkeypatch.setattr(v2_exclusion.Exclusions, "load", staticmethod(replace_manifest_before_library_reads))
    assert v2_exclusion.load_registry().source_ids
    with pytest.raises(ValueError, match="manifest SHA-256 mismatch"):
        v2_exclusion.load_registry()
