import hashlib
import json
import random
from pathlib import Path

import pytest
import torch

from head_training.model import HeadModel, load_trunk
from head_training.training import EncodedExample, TrainingConfig, predict, train

# isort: split
from execution_model.config import ModelConfig
from execution_model.model import ExecutionModel
from execution_model.tokenizer import ByteBPETokenizer
from execution_pipeline.pretrain import PRETOKENIZER


def tiny_trunk(vocab_size: int = 256) -> ExecutionModel:
    return ExecutionModel(ModelConfig(
        vocab_size=vocab_size, hidden_size=16, intermediate_size=24, num_layers=1,
        num_heads=2, max_context_length=16, dropout=0.2, seed=17,
    ))


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_loads_pinned_v5_training_layout_and_pretokenizer(tmp_path):
    tokenizer = ByteBPETokenizer([(ord("a"), ord("!"))])
    tokenizer_path = tmp_path / "tokenizer.json"
    tokenizer.save(tokenizer_path)
    report = tmp_path / "tokenizer-report.json"
    tokenizer_pin = sha256(tokenizer_path)
    report.write_text(json.dumps({
        "pretokenizer": PRETOKENIZER, "identity": tokenizer.identity, "sha256": tokenizer_pin,
    }), encoding="utf-8")
    report_pin = sha256(report)
    trunk = tiny_trunk(tokenizer.vocab_size)
    optimizer = torch.optim.AdamW(trunk.parameters())
    optimizer.zero_grad()
    trunk(torch.tensor([[9, 8]])).logits.sum().backward()
    optimizer.step()
    checkpoint = tmp_path / "best.pt"
    torch.save({
        "config": trunk.config.to_dict(), "model_state": trunk.state_dict(),
        "optimizer_state": optimizer.state_dict(), "processed_tokens": 1_000_000_000,
        "language_rng_state": random.Random(0).getstate(), "torch_rng_state": torch.get_rng_state(),
        "settings": {
            "sequence": trunk.config.max_context_length, "config_identity": trunk.config.identity,
            "external_pretrained_weights": False, "tokenizer_identity": tokenizer.identity,
            "tokenizer_sha256": tokenizer_pin, "tokenizer_report_sha256": report_pin,
        },
    }, checkpoint)

    checkpoint_pin = sha256(checkpoint)
    loaded, encoder = load_trunk(
        checkpoint, checkpoint_pin, tokenizer_path, tokenizer_pin, tokenizer_report_sha256=report_pin,
    )
    assert not loaded.training
    assert not any(parameter.requires_grad for parameter in loaded.parameters())
    for name, value in trunk.state_dict().items():
        torch.testing.assert_close(loaded.state_dict()[name], value, rtol=0, atol=0)
    assert encoder.tokenizer.identity == tokenizer.identity
    assert tokenizer.encode("a!") != encoder.encode("a!")
    assert encoder.encode("a!") == [ord("a"), ord("!")]
    with pytest.raises(ValueError, match="also requires a SHA-256 pin"):
        load_trunk(checkpoint, checkpoint_pin, tokenizer_path, tokenizer_pin)
    with pytest.raises(ValueError, match="mismatch for tokenizer-report"):
        load_trunk(checkpoint, checkpoint_pin, tokenizer_path, tokenizer_pin, tokenizer_report_sha256="0" * 64)
    with pytest.raises(ValueError, match="mismatch for tokenizer.json"):
        load_trunk(checkpoint, checkpoint_pin, tokenizer_path, "0" * 64, tokenizer_report_sha256=report_pin)
    with pytest.raises(ValueError, match="checkpoint SHA-256 mismatch"):
        load_trunk(checkpoint, "0" * 64, tokenizer_path, tokenizer_pin, tokenizer_report_sha256=report_pin)
    other = tmp_path / "another-run"
    other.mkdir()
    other_path = other / "tokenizer.json"
    ByteBPETokenizer([(ord("b"), ord("!"))]).save(other_path)
    with pytest.raises(ValueError, match="settings disagree"):
        load_trunk(checkpoint, checkpoint_pin, other_path, sha256(other_path))


def test_cpu_training_reduces_loss_and_is_repeatable(tmp_path):
    training = [
        EncodedExample((50, 7), class_index=0),
        EncodedExample((51, 8), class_index=1),
        EncodedExample((50, 52, 7), class_index=0),
        EncodedExample((51, 53, 8), class_index=1),
        EncodedExample((54, 7), class_index=0),
    ]
    development = [EncodedExample((i, 7 + label), class_index=label)
                   for i in (56, 57) for label in (0, 1)]
    config = TrainingConfig(seed=5, epochs=15, batch_size=2, accumulation=2, learning_rate=0.03)
    first = HeadModel(tiny_trunk(), kind="classification", num_classes=2, seed=3)
    base = {name: value.clone() for name, value in first.trunk.state_dict().items()}
    updates: list[tuple[int, float]] = []
    result = train(
        first, training, development, config=config, checkpoint_dir=tmp_path / "first",
        training_update=lambda tokens, seconds: updates.append((tokens, seconds)),
    )
    second = HeadModel(tiny_trunk(), kind="classification", num_classes=2, seed=3)
    repeat = train(second, training, development, config=config, checkpoint_dir=tmp_path / "repeat")

    best = result.history[result.best_epoch - 1].development_loss
    assert best < result.initial_development_loss * 0.1
    assert result.history == repeat.history
    assert result.checkpoint_sha256 == repeat.checkpoint_sha256 == sha256(result.checkpoint_path)
    assert result.checkpoint_path.stem == result.checkpoint_sha256
    record = json.loads((result.checkpoint_path.parent / "manifest.json").read_text(encoding="utf-8"))
    assert record["development_rows"] == len(development)
    assert record["checkpoint_sha256"] == result.checkpoint_sha256
    assert len(updates) == 2 * len(result.history)
    assert sum(tokens for tokens, _ in updates) == len(result.history) * sum(len(row.input_ids) for row in training)
    assert all(seconds > 0 for _, seconds in updates)
    saved = torch.load(result.checkpoint_path, weights_only=True)
    assert set(saved) == {"projection.weight", "projection.bias"}
    for name, value in first.projection.state_dict().items():
        torch.testing.assert_close(value, saved[f"projection.{name}"], rtol=0, atol=0)
    for name, value in first.trunk.state_dict().items():
        torch.testing.assert_close(value, base[name], rtol=0, atol=0)
    assert all(int(scores.argmax()) in accepted for scores, accepted in predict(first, development))
    with pytest.raises(FileExistsError):
        train(first, training, development, config=config, checkpoint_dir=tmp_path / "first")


def test_accumulation_weights_partial_microbatches_by_example(tmp_path):
    rows = [EncodedExample((8, 3 + i % 2), class_index=i % 2) for i in range(3)]
    accumulated = HeadModel(tiny_trunk(), kind="classification", num_classes=2)
    combined = HeadModel(tiny_trunk(), kind="classification", num_classes=2)
    for model, directory, batch, accumulation in (
        (accumulated, "accumulated", 2, 2),
        (combined, "combined", 3, 1),
    ):
        train(model, rows, rows, checkpoint_dir=tmp_path / directory,
              config=TrainingConfig(epochs=1, batch_size=batch, accumulation=accumulation))
    torch.testing.assert_close(accumulated.projection.weight, combined.projection.weight)
    torch.testing.assert_close(accumulated.projection.bias, combined.projection.bias)


def test_early_stopping_restores_best_development_weights(tmp_path):
    rows = [EncodedExample((3 + i % 2,), class_index=i % 2) for i in range(4)]
    contrary = [EncodedExample((3 + i % 2,), class_index=1 - i % 2) for i in range(4)]
    model = HeadModel(tiny_trunk(), kind="classification", num_classes=2)
    result = train(model, rows, contrary, checkpoint_dir=tmp_path / "early",
                   config=TrainingConfig(epochs=10, learning_rate=0.1, patience=2))
    assert result.stopped_early
    assert result.best_epoch == 1
    assert len(result.history) == 3
    targets = torch.tensor([row.class_index for row in contrary])
    scores = torch.stack([scores for scores, _ in predict(model, contrary)])
    restored_loss = torch.nn.functional.cross_entropy(scores, targets)
    assert restored_loss.item() == pytest.approx(result.history[0].development_loss)


def test_progress_check_can_interrupt_without_publishing_a_checkpoint(tmp_path):
    rows = [EncodedExample((3,), class_index=0), EncodedExample((4,), class_index=1)]
    model = HeadModel(tiny_trunk(), kind="classification", num_classes=2)
    checks = 0

    def stop_during_training():
        nonlocal checks
        checks += 1
        if checks == 2:
            raise RuntimeError("job stop")

    checkpoint = tmp_path / "interrupted"
    with pytest.raises(RuntimeError, match="job stop"):
        train(model, rows, rows, checkpoint_dir=checkpoint,
              config=TrainingConfig(epochs=1, batch_size=2), progress_check=stop_during_training)
    assert not checkpoint.exists()


@pytest.mark.parametrize("kind", ["pairwise", "selection"])
def test_pointer_heads_learn_and_preserve_candidate_order(kind, tmp_path):
    rows = [
        EncodedExample((21, 7, 8), candidate_positions=(1, 2), gold=(0,)),
        EncodedExample((22, 8, 7), candidate_positions=(1, 2), gold=(1,)),
        EncodedExample((23, 8, 7, 9), candidate_positions=(3, 2, 1), gold=(1,)),
    ]
    if kind == "selection":
        rows[-1] = EncodedExample((23, 8, 7, 7), candidate_positions=(3, 2, 1), gold=(0, 1))
    model = HeadModel(tiny_trunk(), kind=kind)
    result = train(model, rows, rows, checkpoint_dir=tmp_path / kind,
                   config=TrainingConfig(epochs=16, batch_size=3, learning_rate=0.04))
    best = result.history[result.best_epoch - 1].development_loss
    assert best < result.initial_development_loss * 0.1
    for row, (scores, accepted) in zip(rows, predict(model, rows, batch_size=3), strict=True):
        assert scores.numel() == len(row.candidate_positions)
        assert int(scores.argmax()) in accepted
        assert scores.requires_grad is False


def test_lora_budget_freezes_base_and_exports_merged_weights(tmp_path):
    trunk = tiny_trunk()
    base = {name: value.clone() for name, value in trunk.state_dict().items()}
    with pytest.raises(ValueError, match="exceeds the parameter budget"):
        HeadModel(trunk, kind="classification", num_classes=2, lora_rank=1, lora_budget=1)
    model = HeadModel(trunk, kind="classification", num_classes=2, lora_rank=1)
    rows = [EncodedExample((3 + i % 2,), class_index=i % 2) for i in range(4)]
    result = train(model, rows, rows, checkpoint_dir=tmp_path / "lora",
                   config=TrainingConfig(epochs=3, learning_rate=0.04))
    assert result.history[-1].training_loss < result.history[0].training_loss
    assert model.adapter is not None
    for name, original in model.adapter.originals.items():
        torch.testing.assert_close(original.weight, base[f"{name}.weight"], rtol=0, atol=0)
        assert not original.weight.requires_grad
    merged = model.merged_trunk_state()
    assert merged is not None and merged.keys() == base.keys()
    assert any(not torch.equal(merged[name], base[name]) for name in base)
    direct = tiny_trunk()
    direct.load_state_dict(merged)
    unwrapped = HeadModel(direct, kind="classification", num_classes=2)
    unwrapped.projection.load_state_dict(model.projection.state_dict())
    ids = torch.tensor([[4, 3], [9, 8]])
    torch.testing.assert_close(model(ids), unwrapped(ids), rtol=1e-5, atol=1e-5)
