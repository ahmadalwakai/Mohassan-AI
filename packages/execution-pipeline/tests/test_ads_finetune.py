"""Trainer durability, provenance and failure behavior on a tiny CPU fixture, not model quality."""
import json
import pickle
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from execution_pipeline import ads_finetune as training  # noqa: E402
from execution_model.config import ModelConfig  # noqa: E402
from execution_model.model import ExecutionModel  # noqa: E402
from execution_model.tokenizer import ByteBPETokenizer  # noqa: E402


@pytest.fixture()
def scratch(tmp_path):
    previous_threads = torch.get_num_threads()
    torch.set_num_threads(1)
    run, data = tmp_path / "run", tmp_path / "data"
    (run / "pretrain").mkdir(parents=True)
    data.mkdir()
    tokenizer = ByteBPETokenizer.train([b"task input answer alpha beta gamma"], target_vocab_size=8192)
    tokenizer.save(run / "tokenizer.json")
    config = ModelConfig(vocab_size=tokenizer.vocab_size, hidden_size=16, intermediate_size=32,
                         num_layers=1, num_heads=2, max_context_length=128, dropout=0.1)
    settings = {"tokenizer_identity": tokenizer.identity, "config_identity": config.identity}
    (run / "pretrain" / "settings.json").write_text(json.dumps(settings), encoding="utf-8")
    torch.save({"config": config.to_dict(), "model_state": ExecutionModel(config).state_dict(),
                "settings": settings, "step": 0}, run / "pretrain" / "best.pt")
    for split in ("train", "validation"):
        rows = [{"prompt": f"task {word} input: ", "target": f"answer {word}"} for word in ("alpha", "beta", "gamma")]
        (data / f"{split}.jsonl").write_text("\n".join(json.dumps(row) for row in rows) + "\n", encoding="utf-8")
    yield run, data
    torch.set_num_threads(previous_threads)


def train_fixture(scratch, **options):
    run, data = scratch
    args = {"device": "cpu", "data_dir": data, "epochs": 1, "batch": 2, "eval_every": 1,
            "warmup": 0, "out_name": "experiment"}
    return training.finetune(run, **(args | options))


def status(scratch):
    return json.loads((scratch[0] / "experiment" / "status.json").read_text(encoding="utf-8"))


def test_atomic_failed_save_keeps_old_checkpoint_and_removes_own_temporary(tmp_path, monkeypatch):
    destination = tmp_path / "best.pt"
    destination.write_bytes(b"previous checkpoint")

    def fail_save(payload, stream):
        stream.write(b"partial")
        raise OSError("simulated full disk")

    monkeypatch.setattr(torch, "save", fail_save)
    with pytest.raises(OSError, match="full disk"):
        training._atomic_checkpoint(destination, {})
    assert destination.read_bytes() == b"previous checkpoint"
    assert list(tmp_path.iterdir()) == [destination]


@pytest.mark.parametrize("options", [
    {"batch": 0}, {"epochs": 0}, {"warmup": -1}, {"patience": 0}, {"eval_every": 0},
    {"peak_lr": float("nan")}, {"peak_lr": -0.1}, {"limit": 0}, {"seed": -1}, {"out_name": "../outside"},
])
def test_invalid_configuration_is_rejected_before_creating_output(scratch, options):
    with pytest.raises(ValueError):
        train_fixture(scratch, **options)
    assert not (scratch[0] / "experiment").exists()


def test_success_reports_progress_and_binds_checkpoint_to_inputs(scratch, monkeypatch):
    observed = []
    write = training._atomic_json

    def record(path, value):
        if path.name == "status.json":
            observed.append((value["status"], value["steps"]))
        write(path, value)

    monkeypatch.setattr(training, "_atomic_json", record)
    result = train_fixture(scratch)
    assert result["status"] == "completed" and result["steps"] == 2
    assert observed == [("starting", 0), ("running", 0), ("running", 1), ("running", 2), ("completed", 2)]
    out = scratch[0] / "experiment"
    saved = torch.load(out / "last.pt", weights_only=True)
    settings = saved["settings"]
    assert settings["dataset_sha256"]["train"] == training._sha256(scratch[1] / "train.jsonl")
    assert settings["base_checkpoint_sha256"] == training._sha256(scratch[0] / "pretrain" / "best.pt")
    assert settings["tokenizer_sha256"] == training._sha256(scratch[0] / "tokenizer.json")
    assert settings["continuation"] == "weights_only_new_optimizer"
    assert result["last_checkpoint_sha256"] == training._sha256(out / "last.pt")
    assert result["best_checkpoint_sha256"] == training._sha256(out / "best.pt")
    assert status(scratch)["status"] == "completed"


def test_repeated_cpu_runs_reproduce_and_explicit_continuation_preserves_previous(scratch):
    train_fixture(scratch)
    first = scratch[0] / "experiment" / "last.pt"
    prior_hash = training._sha256(first)
    train_fixture(scratch, out_name="repeat")
    a = torch.load(first, weights_only=True)["model_state"]
    b = torch.load(scratch[0] / "repeat" / "last.pt", weights_only=True)["model_state"]
    assert all(torch.equal(a[key], b[key]) for key in a)
    train_fixture(scratch, out_name="continuation", base_checkpoint=Path("experiment/last.pt"))
    settings = json.loads((scratch[0] / "continuation" / "settings.json").read_text())
    assert settings["base_checkpoint_sha256"] == prior_hash
    assert training._sha256(first) == prior_hash
    with pytest.raises(FileExistsError):
        train_fixture(scratch)
    assert training._sha256(first) == prior_hash


@pytest.mark.parametrize("contents", ["", "{bad json}\n", '{"prompt":"task","target":""}\n'])
def test_empty_or_malformed_data_records_failed_status(scratch, contents):
    (scratch[1] / "train.jsonl").write_text(contents, encoding="utf-8")
    with pytest.raises(training.FinetuneError):
        train_fixture(scratch)
    assert status(scratch)["status"] == "failed"
    assert status(scratch)["error"]["code"] == "invalid_data"
    assert not (scratch[0] / "experiment" / "best.pt").exists()


def test_dropping_all_overlong_examples_fails_clearly(scratch):
    (scratch[1] / "train.jsonl").write_text(json.dumps({"prompt": "x " * 200, "target": "answer"}) + "\n")
    with pytest.raises(training.FinetuneError, match="both contain"):
        train_fixture(scratch, drop_long=True)
    assert status(scratch)["error"]["code"] == "invalid_data"


def test_language_and_capability_metadata_only_counts_retained_training_rows(scratch):
    train = [
        {"prompt": "task alpha", "target": "answer", "language": "ar", "capability": "ads.goal.v2"},
        {"prompt": "task beta", "target": "answer", "language": "en", "capability": "code.task.v1"},
        {"prompt": "x " * 200, "target": "answer", "language": "fr", "capability": "dropped.task"},
    ]
    validation = [{"prompt": "task gamma", "target": "answer", "language": "de", "capability": "validation.only"}]
    for split, rows in (("train", train), ("validation", validation)):
        (scratch[1] / f"{split}.jsonl").write_text("\n".join(json.dumps(row) for row in rows) + "\n")
    train_fixture(scratch, drop_long=True)
    settings = status(scratch)["settings"]
    assert settings["languages"] == ["ar", "en"]
    assert settings["capabilities"] == ["ads.goal.v2", "code.task.v1"]
    assert settings["over_context_by_metadata"]["train"] == {"language": {"fr": 1}, "capability": {"dropped.task": 1}}
    assert settings["examples_by_metadata"]["validation"]["language"] == {"de": 1}


@pytest.mark.parametrize("fault", ["loss", "gradient", "interrupt"])
def test_nonfinite_or_interrupted_training_retains_committed_best(scratch, monkeypatch, fault):
    load = training._load_pretrained

    def load_faulty(*args, **kwargs):
        model, tokenizer, config = load(*args, **kwargs)
        forward = model.forward

        def faulty(*args, **kwargs):
            if model.training and fault == "interrupt":
                raise KeyboardInterrupt()
            if model.training and fault == "loss":
                return SimpleNamespace(loss=next(model.parameters()).sum() * float("nan"))
            return forward(*args, **kwargs)

        model.forward = faulty
        if fault == "gradient":
            next(model.parameters()).register_hook(lambda gradient: torch.full_like(gradient, float("nan")))
        return model, tokenizer, config

    monkeypatch.setattr(training, "_load_pretrained", load_faulty)
    expected = KeyboardInterrupt if fault == "interrupt" else training.FinetuneError
    with pytest.raises(expected):
        train_fixture(scratch)
    report = status(scratch)
    assert report["steps"] == 0
    assert report["status"] == ("interrupted" if fault == "interrupt" else "failed")
    assert report["error"]["code"] == {"loss": "nonfinite_loss", "gradient": "nonfinite_gradients", "interrupt": "interrupted"}[fault]
    best = scratch[0] / "experiment" / "best.pt"
    assert report["best_checkpoint_sha256"] == training._sha256(best)
    saved = torch.load(best, weights_only=True)
    assert saved["step"] == 0
    assert all(bool(torch.isfinite(value).all()) for value in saved["model_state"].values())


def test_base_outside_run_is_rejected(scratch):
    with pytest.raises(training.FinetuneError, match="inside this run"):
        train_fixture(scratch, base_checkpoint=Path("../other.pt"))
    assert status(scratch)["error"]["code"] == "checkpoint_incompatible"


def test_checkpoint_tokenizer_mismatch_is_rejected(scratch):
    path = scratch[0] / "pretrain" / "best.pt"
    payload = torch.load(path, weights_only=True)
    payload["settings"]["tokenizer_identity"] = "wrong tokenizer"
    torch.save(payload, path)
    with pytest.raises(training.FinetuneError, match="identity"):
        train_fixture(scratch)
    assert status(scratch)["error"]["code"] == "checkpoint_incompatible"


def test_loader_does_not_fall_back_to_unrestricted_pickle(scratch):
    path = scratch[0] / "pretrain" / "best.pt"
    payload = torch.load(path, weights_only=True)
    payload["unexpected_object"] = SimpleNamespace(value="not allowlisted")
    torch.save(payload, path)
    with pytest.raises(pickle.UnpicklingError):
        training._load_pretrained(scratch[0], "cpu")
