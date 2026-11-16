"""Balanced SFT sampling/selection on tiny CPU models; no real corpus or holdout."""
from collections import Counter
import json
import random
from types import SimpleNamespace

import pytest
import torch

from test_ads_finetune import scratch, train_fixture
from execution_pipeline import ads_finetune as training


def write_rows(data, *, train=None, validation=None):
    rows_by_split = {
        "train": train if train is not None else [
            {"prompt": f"task {i}: ", "target": "answer " + "alpha " * (i + 1),
             "language": "ar" if i < 2 else "en"} for i in range(7)],
        "validation": validation if validation is not None else [
            {"prompt": "task alpha: ", "target": "answer", "language": "ar"},
            {"prompt": "task beta: ", "target": "answer beta gamma", "language": "en"}],
    }
    for split, rows in rows_by_split.items():
        (data / f"{split}.jsonl").write_text("\n".join(json.dumps(row) for row in rows) + "\n", encoding="utf-8")


@pytest.mark.parametrize("batch", [1, 2, 3, 4, 5, 10])
@pytest.mark.parametrize("group_lengths", [False, True])
def test_balanced_sampler_has_homogeneous_equal_updates_and_separate_partial_tails(batch, group_lengths):
    groups = {"ar": [0, 1], "en": [2, 3, 4, 5, 6]}
    a, b = random.Random(37), random.Random(37)
    lengths = [9, 3, 10, 1, 5, 4, 7] if group_lengths else None
    language_of = {index: language for language, pool in groups.items() for index in pool}
    for _ in range(3):
        batches = training._balanced_epoch_batches(groups, a, batch, lengths)
        assert batches == training._balanced_epoch_batches(groups, b, batch, lengths)
        assert all(len({language_of[index] for index in chunk}) == 1 for chunk in batches)
        updates = Counter(language_of[chunk[0]] for chunk in batches)
        assert updates["ar"] == updates["en"] == (5 + batch - 1) // batch
        for language in groups:
            sizes = sorted(len(chunk) for chunk in batches if language_of[chunk[0]] == language)
            assert sizes == sorted([min(batch, 5 - begin) for begin in range(0, 5, batch)])
        order = [index for chunk in batches for index in chunk]
        counts = Counter(order)
        assert set(order) == set(range(7))
        assert sum(counts[i] for i in groups["ar"]) == sum(counts[i] for i in groups["en"]) == 5
        assert abs(counts[0] - counts[1]) == 1
        assert all(counts[i] == 1 for i in groups["en"])


def test_balanced_validation_macro_does_not_weight_long_english_answers_more():
    class KnownLoss(torch.nn.Module):
        def forward(self, ids, *, labels, **kwargs):
            # Arabic token has loss 8; English has loss 2. Prompts and padding are masked.
            active = labels[:, 1:] != training.IGNORE
            losses = torch.where(labels[:, 1:] == 11, 8.0, 2.0)
            return SimpleNamespace(loss=losses[active].mean())
    model = KnownLoss().train()
    rows = [([7, 11], [training.IGNORE, 11]),
            ([7] + [12] * 100, [training.IGNORE] + [12] * 100)]
    metrics = training._balanced_validation_metrics(model, rows, {"ar": [0], "en": [1]}, 0, "cpu", 2)
    assert metrics["macro_language_answer_loss"] == 5.0
    assert metrics["pooled_answer_loss"] == pytest.approx(208 / 101)
    assert metrics["per_language"]["ar"]["answer_tokens"] == 1
    assert metrics["per_language"]["en"]["answer_tokens"] == 100
    assert model.training


def test_balanced_training_counts_real_rows_keeps_pins_and_never_loads_holdout(scratch, monkeypatch):
    run, data = scratch
    write_rows(data)
    (data / "holdout.jsonl").write_text("not valid JSON: never read me", encoding="utf-8")
    source_hash = training._sha256(run / "pretrain/best.pt")
    data_hashes = {name: training._sha256(data / f"{name}.jsonl") for name in ("train", "validation")}
    load_split, loaded = training.load_split, []
    def only_training_splits(name, directory):
        assert name in {"train", "validation"}
        loaded.append(name)
        return load_split(name, directory)
    monkeypatch.setattr(training, "load_split", only_training_splits)
    options = dict(balanced_languages=True, group_by_length=True, epochs=2, batch=4, eval_every=100, patience=100)
    result = train_fixture(scratch, **options)
    train_fixture(scratch, **options, out_name="repeat")
    assert loaded == ["train", "validation"] * 2
    assert result["steps"] == 8
    progress = result["training_progress"]
    assert progress["row_exposures_by_language"] == {"ar": 10, "en": 10}
    assert progress["row_exposures"] == 20
    assert progress["optimizer_updates_by_language"] == {"ar": 4, "en": 4}
    assert progress["unique_train_rows_seen_by_language"] == {"ar": 2, "en": 5}
    assert progress["unique_train_rows_seen"] == 7
    a = torch.load(run / "experiment/last.pt", weights_only=True)
    b = torch.load(run / "repeat/last.pt", weights_only=True)
    assert all(torch.equal(value, b["model_state"][key]) for key, value in a["model_state"].items())
    assert a["training_progress"] == progress
    settings = json.loads((run / "experiment/settings.json").read_text())
    assert a["settings"] == settings
    assert settings["train_examples"] == 7
    assert settings["training_row_exposures_per_epoch"] == 10
    assert settings["optimizer_updates_per_language_per_epoch"] == 2
    assert settings["dataset_sha256"] == data_hashes
    assert settings["validation_selection_metric"] == "macro_language_answer_loss"
    assert training._sha256(run / "pretrain/best.pt") == source_hash
    assert {name: training._sha256(data / f"{name}.jsonl") for name in data_hashes} == data_hashes


def test_macro_worsening_does_not_replace_best_when_pooled_loss_improves(scratch, monkeypatch):
    run, data = scratch
    write_rows(data)
    validations = iter((
        {"selection_metric": "macro_language_answer_loss", "macro_language_answer_loss": 4.0,
         "pooled_answer_loss": 5.0, "per_language": {"ar": {"answer_loss": 2.0}, "en": {"answer_loss": 6.0}}},
        {"selection_metric": "macro_language_answer_loss", "macro_language_answer_loss": 5.0,
         "pooled_answer_loss": 1.5, "per_language": {"ar": {"answer_loss": 9.0}, "en": {"answer_loss": 1.0}}},
    ))
    monkeypatch.setattr(training, "_balanced_validation_metrics", lambda *args: next(validations))
    result = train_fixture(scratch, balanced_languages=True, batch=10, eval_every=2)
    assert result["best_step"] == 0 and result["best_validation_loss"] == 4.0
    assert result["best_validation_metrics"]["per_language"]["ar"]["answer_loss"] == 2.0
    assert result["last_validation_metrics"]["per_language"]["ar"]["answer_loss"] == 9.0
    best = torch.load(run / "experiment/best.pt", weights_only=True)
    assert best["step"] == 0 and best["validation_metrics"] == result["best_validation_metrics"]


@pytest.mark.parametrize("bad", [{}, {"language": "fr"}, {"language": []},
                                  {"language": "ar", "split": "holdout"},
                                  {"language": "ar", "input": {"language": "en"}}])
def test_balanced_mode_rejects_missing_foreign_or_wrong_split_metadata(scratch, bad):
    run, data = scratch
    write_rows(data, train=[{"prompt": "task", "target": "answer", **bad},
                           {"prompt": "task", "target": "answer", "language": "en"}])
    with pytest.raises(training.FinetuneError, match="metadata"):
        train_fixture(scratch, balanced_languages=True)
    assert not (run / "experiment/best.pt").exists()


@pytest.mark.parametrize("which", ["drop", "limit", "validation"])
def test_balance_requires_both_languages_after_filtering(scratch, which):
    run, data = scratch
    train = [{"prompt": "x " * 200 if which == "drop" else "task", "target": "answer", "language": "ar"},
             {"prompt": "task", "target": "answer", "language": "en"}]
    validation = [{"prompt": "task", "target": "answer", "language": "en"}] if which == "validation" else None
    write_rows(data, train=train, validation=validation)
    with pytest.raises(training.FinetuneError, match="both ar and en"):
        train_fixture(scratch, balanced_languages=True, drop_long=True, limit=1 if which == "limit" else None)
    assert not (run / "experiment/best.pt").exists()


def test_failed_update_does_not_claim_row_exposures(scratch, monkeypatch):
    write_rows(scratch[1])
    def interrupted_step(*args, **kwargs):
        raise RuntimeError("simulated optimizer failure")
    monkeypatch.setattr(torch.optim.AdamW, "step", interrupted_step)
    with pytest.raises(RuntimeError, match="optimizer failure"):
        train_fixture(scratch, balanced_languages=True)
    status = json.loads((scratch[0] / "experiment/status.json").read_text())
    assert status["training_progress"]["row_exposures"] == 0
    assert status["training_progress"]["unique_train_rows_seen"] == 0
    assert status["training_progress"]["optimizer_updates"] == 0


def test_default_and_explicit_false_are_bit_exact_without_language_metadata(scratch):
    run, _ = scratch
    implicit = train_fixture(scratch)
    explicit = train_fixture(scratch, balanced_languages=False, out_name="explicit")
    assert implicit["steps"] == explicit["steps"] == 2
    assert "training_progress" not in implicit
    a = torch.load(run / "experiment/last.pt", weights_only=True)
    b = torch.load(run / "explicit/last.pt", weights_only=True)
    assert a["settings"]["validation_selection_metric"] == "pooled_answer_loss"
    assert a["validation_loss"] == b["validation_loss"]
    assert all(torch.equal(value, b["model_state"][key]) for key, value in a["model_state"].items())
