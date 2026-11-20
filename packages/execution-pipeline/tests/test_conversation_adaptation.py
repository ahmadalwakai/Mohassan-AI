"""Real CPU training verifies warm start, balanced all-token updates and restart."""
import json
from pathlib import Path
import shutil
import sys

import numpy as np
import pytest
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from execution_pipeline import conversation_adaptation as adaptation
from execution_pipeline.ads_finetune import _sha256
from execution_model.config import ModelConfig
from execution_model.model import ExecutionModel
from execution_model.tokenizer import ByteBPETokenizer


@pytest.fixture
def tiny_conversation(tmp_path):
    previous = torch.get_num_threads()
    torch.set_num_threads(1)
    run, corpus, data, campaign = (tmp_path / name for name in ("run", "corpus", "data", "campaign"))
    for path in (run, corpus, data, campaign):
        path.mkdir()
    tokenizer = ByteBPETokenizer()
    tokenizer.save(run / "tokenizer.json")
    (run / "tokenizer-report.json").write_text("{}")
    model = ModelConfig(vocab_size=tokenizer.vocab_size, hidden_size=16, intermediate_size=32,
                        num_layers=1, num_heads=2, max_context_length=128, dropout=0.1, seed=17)
    source = tmp_path / "source.pt"
    settings = {"tokenizer_identity": tokenizer.identity, "config_identity": model.identity}
    torch.manual_seed(17)
    torch.save({"config": model.to_dict(), "settings": settings, "model_state": ExecutionModel(model).state_dict()}, source)
    rows = []
    for language, text in (("ar", "لغة عربية قصيرة. "), ("en", "Short human dialogue. ")):
        np.array(tokenizer.encode(text * 20), dtype="<u2").tofile(corpus / f"{language}.train.bin")
        rows.append({"prompt": "Question: ", "target": "Short answer.", "language": language})
    (data / "validation.jsonl").write_text("".join(json.dumps(row) + "\n" for row in rows))
    config = {"run": str(run), "corpus": str(corpus), "dataset_dir": str(data), "campaign": str(campaign),
        "checkpoint": str(source), "checkpoint_sha256": _sha256(source), "code_sha256": {},
        "seed": 5, "sequence": 8, "microbatch": 2, "accumulation": 2, "peak_lr": 0.001,
        "warmup": 1, "target_positions": 112, "milestones": [50, 86, 112],
        "validation_sha256": _sha256(data / "validation.jsonl")}
    yield config
    torch.set_num_threads(previous)


def attempt(config, name):
    path = Path(config["campaign"]) / name
    path.mkdir()
    return path


def ending_state(config, positions=112):
    path = Path(config["run"]) / "adaptation/checkpoints" / f"tokens-{positions:012d}/checkpoint.pt"
    return torch.load(path, weights_only=True)


def test_warm_started_all_token_training_preserves_source_and_balances_languages(tiny_conversation):
    config = tiny_conversation
    original = _sha256(Path(config["checkpoint"]))
    result = adaptation.train_core(config, "tiny-protocol", attempt(config, "first"), device="cpu")
    assert result["status"] == "completed" and result["processed_tokens"] == 112
    assert result["language_tokens"] == {"ar": 56, "en": 56}
    assert _sha256(Path(config["checkpoint"])) == original
    source = torch.load(config["checkpoint"], weights_only=True)
    start = ending_state(config, 0)
    end = ending_state(config)
    assert all(torch.equal(value, start["model_state"][name]) for name, value in source["model_state"].items())
    assert any(not torch.equal(value, end["model_state"][name]) for name, value in source["model_state"].items())
    assert set(result["answer_loss_before"]) == {"ar", "en", "macro"}
    assert result["answer_loss_after"]["macro"] == sum(result["answer_loss_after"][l] for l in ("ar", "en")) / 2
    exported = adaptation.export(config, "tiny-protocol")
    selected = Path(config["run"]) / "selected/best.pt"
    assert _sha256(selected) == exported["candidate_checkpoint_sha256"]
    before_mtime = selected.stat().st_mtime_ns
    assert adaptation.export(config, "tiny-protocol") == exported
    assert selected.stat().st_mtime_ns == before_mtime


def test_real_optimizer_and_dropout_rng_resume_equal_uninterrupted(tiny_conversation):
    full = tiny_conversation
    second_run = Path(full["run"]).parent / "resumed-run"
    shutil.copytree(full["run"], second_run)
    resumed = dict(full, run=str(second_run))
    adaptation.train_core(full, "same-protocol", attempt(full, "full"), device="cpu")
    paused = adaptation.train_core(resumed, "same-protocol", attempt(resumed, "smoke"), device="cpu", max_updates=1)
    assert paused["status"] == "paused_for_smoke" and paused["processed_tokens"] == 32
    result = adaptation.train_core(resumed, "same-protocol", attempt(resumed, "resume"), device="cpu", resume=True)
    assert result["status"] == "completed"
    a, b = ending_state(full), ending_state(resumed)
    assert a["step"] == b["step"] and a["language_tokens"] == b["language_tokens"]
    assert torch.equal(a["generator_state"], b["generator_state"])
    assert torch.equal(a["torch_rng_state"], b["torch_rng_state"])
    assert all(torch.equal(value, b["model_state"][name]) for name, value in a["model_state"].items())
    assert a["answer_loss_after"] == b["answer_loss_after"]


def test_resume_changed_protocol_or_unfinished_export_refused(tiny_conversation):
    config = tiny_conversation
    adaptation.train_core(config, "first-protocol", attempt(config, "pause"), device="cpu", max_updates=1)
    with pytest.raises(ValueError, match="resume settings"):
        adaptation.train_core(config, "changed-protocol", attempt(config, "bad"), device="cpu", resume=True)
    with pytest.raises(ValueError, match="finish"):
        adaptation.export(config, "first-protocol")


def test_training_labels_cover_prompts_as_well_as_answers(tiny_conversation, monkeypatch):
    calls = []
    original = adaptation.ExecutionModel

    class ObserveLabels(original):
        def forward(self, input_ids, *args, **kwargs):
            if self.training:
                calls.append(torch.equal(input_ids, kwargs["labels"]))
            return super().forward(input_ids, *args, **kwargs)

    monkeypatch.setattr(adaptation, "ExecutionModel", ObserveLabels)
    config = tiny_conversation
    adaptation.train_core(config, "label-protocol", attempt(config, "labels"), device="cpu", max_updates=1)
    assert calls and all(calls)


@pytest.mark.parametrize("changed", ["status_protocol", "checkpoint_protocol", "selected_protocol", "validation"])
def test_export_refuses_stale_provenance_or_changed_fixed_validation(tiny_conversation, changed):
    config = tiny_conversation
    adaptation.train_core(config, "bound-protocol", attempt(config, "train"), device="cpu")
    run = Path(config["run"])
    if changed == "validation":
        with (Path(config["dataset_dir"]) / "validation.jsonl").open("a") as stream:
            stream.write("\n")
    elif changed == "status_protocol":
        path = run / "adaptation/status.json"
        value = json.loads(path.read_text())
        value["protocol_sha256"] = "other-protocol"
        path.write_text(json.dumps(value))
    elif changed == "checkpoint_protocol":
        path = run / "adaptation/checkpoints/tokens-000000000112/manifest.json"
        value = json.loads(path.read_text())
        value["settings"]["protocol_sha256"] = "other-protocol"
        path.write_text(json.dumps(value))
    else:
        adaptation.export(config, "bound-protocol")
        path = run / "selected/manifest.json"
        value = json.loads(path.read_text())
        value["protocol_sha256"] = "other-protocol"
        path.write_text(json.dumps(value))
    with pytest.raises(ValueError):
        adaptation.export(config, "bound-protocol")
