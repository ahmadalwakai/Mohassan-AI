import json
from pathlib import Path
import random
import sys

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import training_token_sample as sample
from execution_model.tokenizer import ByteBPETokenizer
from execution_pipeline.chat import conversation_prompt, sha256_file
from execution_pipeline.pretrain import PRETOKENIZER, TextEncoder


@pytest.fixture
def corpus_fixture(tmp_path):
    tokenizer_run = tmp_path / "run"
    tokenizer_run.mkdir()
    pair = list(b"ab")
    tokenizer = ByteBPETokenizer([tuple(pair)])
    tokenizer.save(tokenizer_run / "tokenizer.json")
    (tokenizer_run / "tokenizer-report.json").write_text(json.dumps({"pretokenizer": PRETOKENIZER}), encoding="utf-8")
    encoder = TextEncoder(tokenizer_run)
    eos = encoder.tokenizer.eos_token_id
    merged, = encoder.encode("ab")
    corpus = tmp_path / "corpus"
    corpus.mkdir()
    manifest = {
        "tokenizer_identity": tokenizer.identity,
        "tokenizer_sha256": sha256_file(tokenizer_run / "tokenizer.json"),
        "files": {},
    }
    rows = {}
    for language, question, response in (("ar", "سلام", "أهلاً"), ("en", "Hello", "Hi")):
        messages = [
            {"role": "user", "content": question + '\n"[]"'},
            {"role": "assistant", "content": response},
            {"role": "user", "content": question},
        ]
        chat_text = conversation_prompt(messages) + (f"ab {response} " * 100).rstrip()
        chat_ids = encoder.encode(chat_text) + [eos]
        differing_position = chat_ids.index(merged)
        alternate_ids = chat_ids[:differing_position] + pair + chat_ids[differing_position + 1:]
        prose_text = (question + "\n") * 150
        docs = [encoder.encode("first document") + [eos], chat_ids, alternate_ids, encoder.encode(prose_text) + [eos]]
        docs.extend(encoder.encode(f"fixture document {index}") + [eos] for index in range(7))
        flat_ids = [token for doc in docs for token in doc] + encoder.encode("unterminated tail")
        bin_path = corpus / f"{language}.train.bin"
        np.asarray(flat_ids, dtype="<u2").tofile(bin_path)
        manifest["files"][bin_path.name] = {"tokens": len(flat_ids), "sha256": sha256_file(bin_path)}
        rows[language] = (flat_ids, chat_text, differing_position, prose_text)
    manifest_file = corpus / "manifest.json"
    manifest_file.write_text(json.dumps(manifest), encoding="utf-8")
    settings_file = tokenizer_run / "selected" / "settings.json"
    settings_file.parent.mkdir()
    settings_file.write_text(json.dumps({
        "tokenizer_identity": tokenizer.identity,
        "tokenizer_sha256": manifest["tokenizer_sha256"],
        "tokenizer_report_sha256": sha256_file(tokenizer_run / "tokenizer-report.json"),
        "corpus_manifest_sha256": sha256_file(manifest_file),
        "corpus_files": {name: record["sha256"] for name, record in manifest["files"].items()},
    }), encoding="utf-8")
    return corpus, tokenizer_run, settings_file, rows


def expected_draws(ids, eos, rng):
    docs = {}
    while len(docs) < 10:
        draw = rng.randrange(len(ids))
        try:
            start = ids.index(eos, draw) + 1
            end = ids.index(eos, start) + 1
        except ValueError:
            continue
        docs.setdefault(start, (draw, start, end - start))
    return list(docs.values())


def test_sample_uses_pinned_loader_document_boundaries_and_fixed_seed(corpus_fixture, tmp_path):
    corpus, tokenizer_run, settings_file, fixtures = corpus_fixture
    output = tmp_path / "sample"
    before = {path: sha256_file(path) for path in tmp_path.rglob("*") if path.is_file()}
    sample.main([
        "--corpus", str(corpus), "--tokenizer-run", str(tokenizer_run),
        "--training-settings", str(settings_file), "--output", str(output),
    ])
    after = {path: sha256_file(path) for path in tmp_path.rglob("*") if path.is_file() and path.parent != output}
    assert before == after
    report = json.loads((output / "training-token-sample.json").read_text(encoding="utf-8"))
    markdown = (output / "training-token-sample.md").read_text(encoding="utf-8")
    assert report["seed"] == 20261125
    assert report["eos_token_id"] == 258
    assert report["training_settings_sha256"] == sha256_file(settings_file)
    assert report["tokenizer_sha256"] == sha256_file(tokenizer_run / "tokenizer.json")
    assert report["tokenizer_report_sha256"] == sha256_file(tokenizer_run / "tokenizer-report.json")
    rng = random.Random(20261125)
    for language, (ids, chat_text, differing_position, prose_text) in fixtures.items():
        assert report["train_bins_sha256"][f"{language}.train.bin"] == sha256_file(corpus / f"{language}.train.bin")
        documents = [doc for doc in report["documents"] if doc["language"] == language]
        assert [(doc["draw_offset"], doc["offset"], doc["length_tokens"]) for doc in documents] == expected_draws(ids, 258, rng)
        assert all(doc["ends_with_eos"] for doc in documents)
        conversations = [doc for doc in sorted(documents, key=lambda doc: doc["offset"]) if doc["kind"] == "conversation"]
        canonical, alternate = conversations
        assert canonical["text"] == alternate["text"] == chat_text
        assert len(chat_text) > 600
        assert chat_text.splitlines()[-1] in markdown
        assert canonical["framing_round_trip"] is True
        assert canonical["first_differing_position"] is None
        assert alternate["framing_round_trip"] is False
        assert alternate["first_differing_position"] == differing_position
        prose, = [doc for doc in documents if doc["kind"] == "prose" and doc["over_512_tokens"]]
        assert len(prose_text) > 600
        assert prose["text"] == prose_text[:600]


def test_cut_includes_the_next_document_eos_and_skips_partial_tail():
    eos = ByteBPETokenizer().eos_token_id
    tokens = np.asarray([ord("a"), eos, ord("b"), ord("c"), eos, ord("d")], dtype="<u2")
    assert sample.document_cut(tokens, 0) == (2, 5)
    assert sample.document_cut(tokens, 1) == (2, 5)
    assert sample.document_cut(tokens, 2) is None
    assert sample.document_cut(tokens, 5) is None
    with pytest.raises(ValueError, match="fewer than ten complete"):
        list(sample.document_draws(tokens, random.Random(20261125)))


def test_conversation_markers_come_from_the_formatter(tmp_path, monkeypatch):
    ByteBPETokenizer().save(tmp_path / "tokenizer.json")
    encoder = TextEncoder(tmp_path)

    def alternate_prompt(messages):
        rendered = conversation_prompt(messages)
        return "Test header\n" + "\n".join(rendered.splitlines()[1:2]) + "\nTest speaker\n"

    monkeypatch.setattr(sample, "conversation_prompt", alternate_prompt)
    text = alternate_prompt([{"role": "user", "content": "Question"}]) + "Reply"
    ids = encoder.encode(text) + [encoder.tokenizer.eos_token_id]
    document = sample.describe_document("en", 0, 0, ids, encoder, *sample.frame_boundaries())
    assert document["kind"] == "conversation"
    assert document["framing_round_trip"] is True


def test_malformed_framing_is_reported(tmp_path):
    ByteBPETokenizer().save(tmp_path / "tokenizer.json")
    encoder = TextEncoder(tmp_path)
    prefix, suffix = sample.frame_boundaries()
    prompt = conversation_prompt([{"role": "user", "content": "Question"}])
    cut = prompt.removesuffix(suffix)
    changed_suffix = cut + "\nUnexpected speaker\nReply"
    ids = encoder.encode(changed_suffix) + [encoder.tokenizer.eos_token_id]
    document = sample.describe_document("en", 0, 0, ids, encoder, prefix, suffix)
    assert document["framing_round_trip"] is False
    assert document["first_differing_position"] == len(encoder.encode(cut + "\n"))

    invalid_json = prefix + "["
    ids = encoder.encode(invalid_json) + [encoder.tokenizer.eos_token_id]
    document = sample.describe_document("en", 0, 0, ids, encoder, prefix, suffix)
    assert document["framing_round_trip"] is False
    assert document["first_differing_position"] is None
    assert document["framing_error"]


@pytest.mark.parametrize(("filename", "error"), [
    ("ar.train.bin", "hash mismatch"),
    ("manifest.json", "settings pin for corpus_manifest_sha256"),
    ("tokenizer.json", "settings pin for tokenizer_sha256"),
    ("tokenizer-report.json", "settings pin for tokenizer_report_sha256"),
])
def test_sample_refuses_changed_pinned_bytes(corpus_fixture, tmp_path, filename, error):
    corpus, tokenizer_run, settings_file, _ = corpus_fixture
    path = (corpus if filename == "manifest.json" or filename.endswith(".bin") else tokenizer_run) / filename
    with path.open("ab") as stream:
        stream.write(b" ")
    output = tmp_path / "sample"
    with pytest.raises(ValueError, match=error):
        sample.write_sample(corpus, tokenizer_run, settings_file, output)
    assert not output.exists()


def test_sample_refuses_bin_pin_from_different_training_settings(corpus_fixture, tmp_path):
    corpus, tokenizer_run, settings_file, _ = corpus_fixture
    settings = json.loads(settings_file.read_text(encoding="utf-8"))
    settings["corpus_files"]["ar.train.bin"] = settings["corpus_files"]["en.train.bin"]
    settings_file.write_text(json.dumps(settings), encoding="utf-8")
    output = tmp_path / "sample"
    with pytest.raises(ValueError, match=r"settings pin for ar\.train\.bin"):
        sample.write_sample(corpus, tokenizer_run, settings_file, output)
    assert not output.exists()


def test_sample_refuses_existing_output(corpus_fixture, tmp_path):
    corpus, tokenizer_run, settings_file, _ = corpus_fixture
    output = tmp_path / "sample"
    output.mkdir()
    with pytest.raises(FileExistsError, match="already exists"):
        sample.write_sample(corpus, tokenizer_run, settings_file, output)
    assert not list(output.iterdir())


def test_failed_write_cleans_up_partial_sample(corpus_fixture, tmp_path, monkeypatch):
    corpus, tokenizer_run, settings_file, _ = corpus_fixture
    output = tmp_path / "sample"
    open_path = Path.open

    def fail_markdown_write(path, mode="r", *args, **kwargs):
        if path == output / "training-token-sample.md" and mode == "x":
            raise OSError("test write failure")
        return open_path(path, mode, *args, **kwargs)

    monkeypatch.setattr(Path, "open", fail_markdown_write)
    with pytest.raises(OSError, match="test write failure"):
        sample.write_sample(corpus, tokenizer_run, settings_file, output)
    assert not output.exists()
