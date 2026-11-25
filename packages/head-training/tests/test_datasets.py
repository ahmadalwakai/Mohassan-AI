from __future__ import annotations

import hashlib
import io
import json
import tarfile
import zipfile
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
from pyarrow import Table, parquet  # type: ignore[import-untyped]

from head_training.dataset_catalog import SourceSpec
from head_training.datasets import CATALOG, TASKS, Dataset, load_dataset


def encoded(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False).encode("utf-8")


def zipped(members: dict[str, bytes]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, data in members.items():
            archive.writestr(name, data)
    return buffer.getvalue()


def tarred(members: dict[str, bytes]) -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for name, data in members.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


def fixture_sources(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, name: str, files: dict[str, bytes],
) -> Path:
    source = tmp_path / "source"
    source.mkdir(exist_ok=True)
    card = CATALOG[name]
    specs = []
    for spec in card.files:
        data = files[spec.filename]
        path = source / spec.filename
        path.write_bytes(data)
        specs.append(SourceSpec(spec.filename, path.as_uri(), hashlib.sha256(data).hexdigest()))
    monkeypatch.setitem(CATALOG, name, replace(card, files=tuple(specs)))
    return tmp_path / "cache"


def test_catalog_roles_and_verified_hashes() -> None:
    assert TASKS == {
        "intent", "route", "out_of_scope", "turn_type", "rewrite", "sentence_selection",
        "sufficiency", "speech_act",
    }
    for card in CATALOG.values():
        assert card.license_url.startswith("https://") and card.attribution and card.revision
        assert all(len(spec.sha256) == 64 and spec.url.startswith("https://") for spec in card.files)


def test_clinc_download_pin_lineage_and_deterministic_tasks(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    rows = {
        "train": [["Deposit", "cash_deposit"]],
        "val": [["Call us", "operator"]],
        "test": [["Help", "operator"]],
        "oos_train": [["Paint a tower", "oos"]],
    }
    cache = fixture_sources(monkeypatch, tmp_path, "clinc150", {
        "clinc.json": encoded(rows),
        "clinc-domains.json": encoded({"banking": ["cash_deposit"], "meta": ["operator"]}),
    })
    with pytest.raises(FileNotFoundError):
        load_dataset("clinc150", "intent", cache, allow_download=False)
    data = load_dataset("clinc150", "intent", cache)
    assert data == load_dataset("clinc150", "intent", cache, allow_download=False)
    assert len(data.provenance) == 1 and len(data.fingerprint) == 64
    assert len(data.loader_sha256) == 64 and len(data.catalog_sha256) == 64
    assert {example.label for example in data.examples} == {"cash_deposit", "operator"}
    assert {example.upstream_split for example in data.examples} == {"train", "dev", "test"}
    routes = load_dataset("clinc150", "route", cache)
    assert {example.label for example in routes.examples} == {"banking", "meta"}
    assert routes.fingerprint != data.fingerprint and len(routes.provenance) == 2
    oos = load_dataset("clinc150", "out_of_scope", cache)
    outside = next(row for row in oos.examples if row.label == "out_of_scope")
    assert outside.source_partition == "oos_train" and outside.upstream_split == "train"
    (cache / "clinc150" / "clinc.json").write_text("{}")
    with pytest.raises(ValueError, match="Cached source SHA-256 mismatch"):
        load_dataset("clinc150", "intent", cache)
    bad_source = tmp_path / "source" / "clinc.json"
    bad_source.write_text("{}")
    with pytest.raises(ValueError, match="Source SHA-256 mismatch"):
        load_dataset("clinc150", "intent", tmp_path / "second-cache")
    assert not list((tmp_path / "second-cache" / "clinc150").iterdir())


def test_massive_joins_localizations(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    cache = fixture_sources(monkeypatch, tmp_path, "massive", {
        "massive.tar.gz": tarred({
            f"1.1/data/{locale}.jsonl": encoded({
                "id": 12, "locale": locale, "partition": "dev", "intent": "alarm_set", "scenario": "alarm", "utt": utterance,
            }) + b"\n"
            for locale, utterance in (("en-US", "Set alarm"), ("ar-SA", "اضبط المنبه"))
        }),
    })
    data = load_dataset("massive", "route", cache)
    assert len(data.examples) == 2 and len({row.group for row in data.examples}) == 1
    assert {row.language for row in data.examples} == {"ar", "en"}
    assert all(row.label == "alarm" and row.upstream_split == "dev" for row in data.examples)
    assert all(row.label == "alarm_set" for row in load_dataset("massive", "intent", cache).examples)


def test_canard_and_quac_preserve_dialogue_and_human_annotations(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    history = ["Title", "Section"]
    canard = [
        {"QuAC_dialog_id": "C_x", "Question_no": 1, "Question": "Who ran?", "Rewrite": "Who ran?", "History": history},
        {
            "QuAC_dialog_id": "C_x", "Question_no": 2, "Question": "When?",
            "Rewrite": "When did the runner leave?", "History": [*history, "Who ran?", "The runner."],
        },
    ]
    cache = fixture_sources(monkeypatch, tmp_path, "canard", {
        "canard.zip": zipped({
            f"CANARD_Release/{partition}.json": encoded(canard if partition == "train" else [])
            for partition in ("train", "dev", "test")
        }),
    })
    rewrites = load_dataset("canard", "rewrite", cache)
    assert [row.candidates[row.gold[0]] for row in rewrites.examples] == [row["Rewrite"] for row in canard]
    assert len(rewrites.examples[1].candidates) == 3
    assert [row.label for row in load_dataset("canard", "turn_type", cache).examples] == ["unchanged", "rewritten"]

    qa = {
        "data": [{"title": "Title", "section_title": "Section", "paragraphs": [{"id": "C_x", "qas": [
            {"id": "q1", "question": "Who ran?", "followup": "n", "orig_answer": {"text": "The runner."}},
            {"id": "q2", "question": "When?", "followup": "y", "orig_answer": {"text": "Yesterday."}},
        ]}]}],
    }
    fixture_sources(monkeypatch, tmp_path, "quac", {"quac-train.json": encoded(qa), "quac-dev.json": encoded({"data": []})})
    turns = load_dataset("quac", "turn_type", cache)
    first, second = turns.examples
    assert (first.label, second.label) == ("avoid_follow_up", "follow_up")
    assert second.history == rewrites.examples[1].history == (*history, "Who ran?", "The runner.")
    assert second.group == rewrites.examples[1].group == "quac:C_x"


def make_qa(title: str, row_id: str, context: str, question: str, answers: list[dict[str, Any]]) -> dict[str, Any]:
    return {"data": [{
        "title": title,
        "paragraphs": [{"context": context, "qas": [{"question": question, "id": row_id, "answers": answers}]}],
    }]}


@pytest.mark.parametrize("name", ["xquad", "mlqa", "arcd"])
def test_qa_formats_map_same_page_answers_and_partition_provenance(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, name: str,
) -> None:
    ar = make_qa("Article_Title" if name == "xquad" else "مقال", "parallel", "أول. الهدف؟ آخر.", "ما هو؟", [
        {"answer_start": len("أول. "), "text": "الهدف"},
    ])
    en = make_qa("Article Title", "parallel", "Noise. Goal! More.", "What?", [
        {"answer_start": len("Noise. "), "text": "Goal"},
    ])
    if name == "xquad":
        files = {"xquad-ar.json": encoded(ar), "xquad-en.json": encoded(en)}
    elif name == "mlqa":
        files = {"mlqa.zip": zipped({
            f"MLQA_V1/{partition}/{partition}-context-{language}-question-{language}.json":
                encoded(source if partition == "test" else {"data": []})
            for partition in ("dev", "test")
            for language, source in (("ar", ar), ("en", en))
        })}
    else:
        # The unique answer text lets the loader repair an inconsistent offset without guessing.
        ar["data"][0]["paragraphs"][0]["qas"][0]["answers"][0]["answer_start"] = 0
        files = {"arcd-train.json": encoded(ar), "arcd-test.json": encoded({"data": []})}
    cache = fixture_sources(monkeypatch, tmp_path, name, files)
    data = load_dataset(name, "sentence_selection", cache)
    arabic = next(row for row in data.examples if row.language == "ar")
    assert arabic.candidates == ("أول.", "الهدف؟", "آخر.") and arabic.gold == (1,)
    assert len({row.group for row in data.examples}) == 1
    assert arabic.source_partition == {"xquad": "validation", "mlqa": "test", "arcd": "train"}[name]
    assert arabic.upstream_split == ("train" if name == "arcd" else "unsplit")
    assert arabic.document_title == ("Article_Title" if name == "xquad" else "مقال")


def test_squad_sufficiency_uses_native_no_answer_and_all_gold_sentences(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    context = "Rome won. Neither case. Lima won. Rome won."
    source = make_qa("Article Title", "gold", context, "Where?", [
        {"answer_start": 0, "text": "Rome"}, {"answer_start": context.index("Lima"), "text": "Lima"},
    ])
    qas = source["data"][0]["paragraphs"][0]["qas"]
    qas[0]["is_impossible"] = False
    qas.append({"id": "missing", "question": "What vanished?", "is_impossible": True, "answers": []})
    cache = fixture_sources(monkeypatch, tmp_path, "squad2", {
        "squad2-train.json": encoded(source), "squad2-dev.json": encoded({"data": []}),
    })
    enough, missing = load_dataset("squad2", "sufficiency", cache).examples
    assert (enough.label, missing.label) == ("sufficient", "insufficient")
    assert enough.history == missing.history == (context,)
    data = load_dataset("squad2", "sentence_selection", cache)
    assert [row.id for row in data.examples] == ["squad2:en:gold"]
    row = data.examples[0]
    assert row.candidates == ("Rome won.", "Neither case.", "Lima won.") and row.gold == (0, 2)


def test_tydi_reads_only_supported_languages_from_goldp_parquet(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    path = tmp_path / "temporary.parquet"
    data = [
        {
            "id": f"{language}-1", "title": "Topic", "context": "Earlier. Zed won.", "question": "Who?",
            "answers": {"answer_start": [9], "text": ["Zed"]},
        }
        for language in ("arabic", "english", "russian")
    ]

    def file(source: list[dict[str, Any]]) -> bytes:
        parquet.write_table(Table.from_pylist(source), path)
        return path.read_bytes()

    cache = fixture_sources(monkeypatch, tmp_path, "tydiqa", {
        "tydiqa-train.parquet": file(data),
        "tydiqa-validation.parquet": file([]),
    })
    parsed = load_dataset("tydiqa", "sentence_selection", cache)
    assert {row.language for row in parsed.examples} == {"ar", "en"}
    assert all(row.gold == (1,) for row in parsed.examples)


def test_ami_uses_manual_act_and_word_references(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    nite = 'xmlns:nite="http://nite.sourceforge.net/"'
    cache = fixture_sources(monkeypatch, tmp_path, "ami", {"ami.zip": zipped({
        "ontologies/da-types.xml": f'<da-type {nite} nite:id="ami_da_4" name="inf"/>'.encode(),
        "dialogueActs/ES2016a.A.dialog-act.xml": (
            f'<nite:root {nite}><dact nite:id="d1"><nite:pointer role="da-aspect" href="#id(ami_da_4)"/>'
            '<nite:child href="ES2016a.A.words.xml#id(w1)..id(w3)"/></dact></nite:root>'
        ).encode(),
        "words/ES2016a.A.words.xml": (
            f'<nite:root {nite}><w nite:id="w1">I</w><gap nite:id="w2"/>'
            '<w nite:id="w3">agree</w></nite:root>'
        ).encode(),
    })})
    data: Dataset = load_dataset("ami", "speech_act", cache)
    row, = data.examples
    assert (row.text, row.label, row.group) == ("I agree", "inf", "ami:ES2016")
    assert row.upstream_split == "unsplit"
