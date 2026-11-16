"""Real tiny CPU training verifies foundation provenance and exact safe resume."""
import json
import sys
from pathlib import Path

import numpy as np
import pytest
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from execution_pipeline.language_adaptation import adapt
from execution_pipeline.ads_finetune import _sha256
from execution_model.config import ModelConfig
from execution_model.model import ExecutionModel
from execution_model.tokenizer import ByteBPETokenizer


@pytest.fixture
def small_foundation(tmp_path):
    previous = torch.get_num_threads()
    torch.set_num_threads(1)
    run, corpus = tmp_path / "run", tmp_path / "corpus"
    (run / "pretrain").mkdir(parents=True)
    corpus.mkdir()
    tokenizer = ByteBPETokenizer()
    tokenizer.save(run / "tokenizer.json")
    (run / "tokenizer-report.json").write_text("{}")
    config = ModelConfig(vocab_size=tokenizer.vocab_size, hidden_size=16, intermediate_size=32,
                         num_layers=1, num_heads=2, max_context_length=32, seed=17)
    metadata = {"tokenizer_identity": tokenizer.identity, "config_identity": config.identity}
    (run / "pretrain/settings.json").write_text(json.dumps(metadata))
    torch.save({"config": config.to_dict(), "settings": metadata, "model_state": ExecutionModel(config).state_dict()},
               run / "pretrain/best.pt")
    manifest = {"tokenizer_identity": tokenizer.identity, "files": {}}
    for language, text in (("ar", "العربية لغة جميلة. "), ("en", "English replay text. ")):
        for split in ("train", "validation"):
            path = corpus / f"{language}.{split}.bin"
            tokens = np.array(tokenizer.encode(text * 30), dtype=np.uint16)
            tokens.tofile(path)
            manifest["files"][path.name] = {"tokens": len(tokens), "sha256": _sha256(path), "documents": 1}
    (corpus / "manifest.json").write_text(json.dumps(manifest))
    yield run, corpus
    torch.set_num_threads(previous)


def train_options(corpus):
    return dict(corpus=corpus, base_checkpoint=Path("pretrain/best.pt"), total_tokens=128,
                sequence=8, microbatch=2, accumulation=2, peak_lr=1e-3,
                warmup=1, eval_every=2, seed=8, device="cpu")


def test_real_training_preserves_base_and_writes_pinned_restartable_candidate(small_foundation):
    run, corpus = small_foundation
    original = _sha256(run / "pretrain/best.pt")
    result = adapt(run, out_name="continued", **train_options(corpus))
    assert result["status"] == "completed" and result["processed_tokens"] == 128
    assert sum(result["language_tokens"].values()) == result["processed_tokens"]
    assert result["language_tokens"]["ar"] > 0 and result["language_tokens"]["en"] > 0
    assert _sha256(run / "pretrain/best.pt") == original
    assert result["best_checkpoint_sha256"] == _sha256(run / "continued/best.pt")
    assert result["ready_for_chat"] is False
    last = torch.load(run / "continued/last.pt", weights_only=True)
    assert last["step"] == 4 and last["optimizer_state"]["state"]


def test_interrupted_then_resumed_optimizer_and_sampling_equal_uninterrupted_run(small_foundation):
    run, corpus = small_foundation
    options = train_options(corpus)
    adapt(run, out_name="full", **options)
    paused = adapt(run, out_name="resumed", max_minutes=1e-12, **options)
    assert paused["status"] == "paused_time_limit" and paused["step"] == 1
    result = adapt(run, out_name="resumed", resume=True, **options)
    assert result["status"] == "completed"
    full = torch.load(run / "full/last.pt", weights_only=True)
    resumed = torch.load(run / "resumed/last.pt", weights_only=True)
    assert full["language_tokens"] == resumed["language_tokens"]
    assert torch.equal(full["generator_state"], resumed["generator_state"])
    assert full["language_rng_state"] == resumed["language_rng_state"]
    assert all(torch.equal(tensor, resumed["model_state"][name]) for name, tensor in full["model_state"].items())


def test_changed_corpus_and_changed_resume_options_fail_closed(small_foundation):
    run, corpus = small_foundation
    options = train_options(corpus)
    adapt(run, out_name="resumed", max_minutes=1e-12, **options)
    with pytest.raises(ValueError, match="Resume settings"):
        adapt(run, out_name="resumed", resume=True, **{**options, "peak_lr": 2e-3})
    with (corpus / "ar.train.bin").open("ab") as stream:
        stream.write(b"\0\0")
    with pytest.raises(ValueError, match="size or hash"):
        adapt(run, out_name="corrupt", **options)
    assert not (run / "corrupt").exists()


def test_no_implicit_overwrite_or_unverified_tokenizer_mix(small_foundation):
    run, corpus = small_foundation
    adapt(run, out_name="once", **train_options(corpus))
    with pytest.raises(FileExistsError):
        adapt(run, out_name="once", **train_options(corpus))
    file = corpus / "manifest.json"
    manifest = json.loads(file.read_text())
    manifest["tokenizer_identity"] = "wrong"
    file.write_text(json.dumps(manifest))
    with pytest.raises(ValueError, match="different tokenizer"):
        adapt(run, out_name="wrong-tokenizer", **train_options(corpus))
