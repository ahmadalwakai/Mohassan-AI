"""Raw-text pre-training path: tokenizer -> encode -> train -> export on a tiny local corpus.

Mechanics only (files, resume, held-out split, loadable export); no claim about quality.
"""
import json
import sys
from pathlib import Path

import pytest
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from execution_pipeline import pretrain  # noqa: E402

from execution_model.checkpoint import load_checkpoint  # noqa: E402
from execution_model.resources import ResourceConfig  # noqa: E402


@pytest.fixture()
def corpus(tmp_path, monkeypatch):
    wiki = tmp_path / "wiki"
    ads = tmp_path / "ads"
    wiki.mkdir()
    ads.mkdir()
    articles = [f"Article {index}\nWater is made of hydrogen and oxygen. Paris is the capital of France. Number {index}."
                for index in range(400)]
    (wiki / "shard-000.txt").write_text("\n\n".join(articles) + "\n", encoding="utf-8")
    for split in ("train", "validation"):
        rows = [json.dumps({"prompt": 'Ads task:\n{"capability":"ads.headlines.v1"}\nOutput:\n', "target": '{"headlines":["Mobile Tyres Leeds"]}'})] * 30
        (ads / f"{split}.jsonl").write_text("\n".join(rows) + "\n", encoding="utf-8")
    monkeypatch.setattr(pretrain, "WIKI_DIR", wiki)
    monkeypatch.setattr(pretrain, "ADS_DIR", ads)
    return tmp_path / "run"


def test_validation_articles_never_enter_training():
    titles = [f"Title {index}" for index in range(5000)]
    held = [title for title in titles if pretrain._is_validation(title)]
    assert 5 < len(held) < 60
    assert held == [title for title in titles if pretrain._is_validation(title)]


def test_learning_rate_warms_up_then_decays_to_a_floor():
    rates = [pretrain._learning_rate(step, 1000, 1e-3, 100) for step in range(1000)]
    assert rates[0] < rates[99] == pytest.approx(1e-3)
    assert rates[-1] == pytest.approx(1e-4, rel=0.01)
    assert all(later <= earlier + 1e-12 for earlier, later in zip(rates[100:], rates[101:]))


def test_tiny_pretraining_run_resumes_and_exports(corpus):
    report = pretrain.train_tokenizer(corpus, vocab=8192, wiki_bytes=40_000, ads_bytes=2_000)
    assert report["vocab_size"] > 256
    encoded = pretrain.encode_corpus(corpus, workers=2)
    assert encoded["files"]["validation"]["documents"] >= 1
    assert encoded["files"]["train"]["documents"] + encoded["files"]["validation"]["documents"] == 400 + 30
    device = "cuda" if torch.cuda.is_available() else "cpu"
    first = pretrain.train_text(corpus, preset="A", total_tokens=64 * 4 * 2 * 6, sequence=64, microbatch=4,
                                accumulation=2, warmup_steps=2, eval_every=25, context=128, device=device,
                                max_minutes=0.0)
    assert first["status"] == "paused_time_limit" and first["step"] == 1
    second = pretrain.train_text(corpus, preset="A", total_tokens=64 * 4 * 2 * 6, sequence=64, microbatch=4,
                                 accumulation=2, warmup_steps=2, eval_every=25, context=128, device=device)
    assert second["status"] == "completed" and second["step"] == 6
    (corpus / "pretrain" / "best.pt").write_bytes((corpus / "pretrain" / "last.pt").read_bytes())
    exported = pretrain.export_text_checkpoint(corpus, source="best.pt")
    config = pretrain.model_config(corpus, "A", 128, 0)
    loaded = load_checkpoint(exported["directory"], expected_config=config,
                             expected_tokenizer_identity=exported["manifest"]["tokenizer_identity"],
                             resources=ResourceConfig(device="cpu", max_context_length=128))
    assert loaded.metadata.training_status == "unverified"


def test_word_pretokenizer_is_lossless_and_never_spans_words():
    text = 'Ads task:\n{"city":"Arbroath","keywords":["[mobile tyres arbroath]"]}  Café 2024_x  end\n\n'
    pieces = pretrain.pretokenize(text)
    assert "".join(pieces) == text
    assert " Café" in pieces and "Arbroath" in pieces and " arbroath" in pieces
    assert all(piece.strip() in {"2", "0", "4"} for piece in pieces if any(ch.isdigit() for ch in piece))


def test_word_tokenizer_round_trips_and_keeps_names_whole(corpus):
    report = pretrain.train_word_tokenizer(corpus, vocab=8192)
    assert report["pretokenizer"] == "words-v1"
    encoder = pretrain.TextEncoder(corpus)
    text = 'Water is made of hydrogen. {"headlines":["Mobile Tyres Leeds"]}'
    ids = encoder.encode(text)
    assert encoder.tokenizer.decode(ids) == text
    pieces = [encoder.tokenizer.token_bytes(token).decode("utf-8", "replace") for token in ids]
    assert not any(" " in piece.strip() for piece in pieces)
    encoded = pretrain.encode_corpus(corpus, workers=2)
    assert encoded["files"]["train"]["tokens"] > 0


def test_name_hint_repeats_names_before_output_only_when_asked():
    from execution_pipeline import ads_finetune
    record = {"prompt": 'Ads task:\n{"capability":"ads.keywords.v1"}\nOutput:\n',
              "input": {"city": "Wigan", "business": "Kerbside Tyres", "service": "Mobile Tyre Fitting"}}
    assert ads_finetune.prompt_text(record) == record["prompt"]
    hinted = ads_finetune.prompt_text(record, ads_finetune.NAME_HINT)
    assert hinted.endswith("\nNames: Wigan wigan | Kerbside Tyres | Mobile Tyre Fitting mobile tyre fitting\nOutput:\n")
    assert ads_finetune.prompt_text({"prompt": record["prompt"], "input": {}}, ads_finetune.NAME_HINT) == record["prompt"]
