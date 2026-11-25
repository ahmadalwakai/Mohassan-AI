"""Exercise the actual CPU linear kernels on a small, randomly initialized trunk."""

from dataclasses import replace
import json
from pathlib import Path
import sys

import pytest
import torch
from torch import nn

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from model_worker.decoding import GenerationBatch
from model_worker.engine import DenseHead, WorkerEngine
from model_worker.quantization import _INT8, _RoutedLinear, apply_quantization

from execution_model.config import ModelConfig
from execution_model.model import ExecutionModel


def _engine() -> WorkerEngine:
    trunk = ExecutionModel(ModelConfig(
        vocab_size=256, hidden_size=16, intermediate_size=32, num_layers=2,
        num_heads=2, max_context_length=24, seed=41,
    )).eval()
    with torch.random.fork_rng(devices=[]):
        torch.manual_seed(3)
        projection = nn.Sequential(nn.Linear(16, 3)).eval()
    with torch.no_grad():
        projection[0].bias.copy_(torch.tensor([-5.0, 5.0, 0.0]))
    heads = {
        "labels": DenseHead(trunk, ("classify",), projection),
        "float-labels": DenseHead(trunk, ("classify",), projection),
        "lm": DenseHead(trunk, ("generate",)),
    }
    return WorkerEngine(heads, torch.device("cpu"), "0" * 64, 8)


def _classification(max_difference: float) -> dict:
    return {
        "thresholds": {"minTop1Agreement": 1.0, "maxAbsoluteLogitDifference": max_difference},
        "probes": [
            {"operation": "classify", "payload": {"inputIds": [4, 8, 17]}},
            {"operation": "classify", "payload": {"inputIds": [3, 2, 41]}},
        ],
    }


def _generation() -> dict:
    return {
        "thresholds": {
            "minTop1Agreement": 1.0, "maxAbsoluteLogitDifference": 0.03, "minGreedyTokenAgreement": 1.0,
        },
        "probes": [{"operation": "generate", "payload": {"inputIds": [4, 8, 17], "maxNewTokens": 6}}],
    }


def test_int8_adoption_is_per_head_and_uses_the_same_trunk() -> None:
    engine = _engine()
    value = engine.prepare("classify", "labels", {"inputIds": [4, 8, 17]})
    fp32 = engine.run_batch("classify", "labels", [value])
    trunk = engine.heads["labels"].trunk
    embedding = trunk.token_embedding

    report = apply_quantization(engine, {
        "labels": _classification(0.05),
        "float-labels": _classification(0.0),
        "lm": _generation(),
    })

    assert set(engine.quantized_heads) == {"labels", "lm"}
    assert engine.heads["labels"].trunk is engine.heads["lm"].trunk is trunk
    assert trunk.token_embedding is embedding
    assert json.loads(json.dumps(report, allow_nan=False)) == report
    assert report["labels"]["adopted"] and report["labels"]["samples"] == 2
    assert report["labels"]["top1Agreement"] == 1.0
    assert 0 < report["labels"]["maxAbsoluteLogitDifference"] <= 0.05
    assert report["labels"]["greedyTokenAgreement"] is None
    assert report["float-labels"]["reason"] == "thresholds_failed"
    assert report["lm"]["greedyTokenAgreement"] == 1.0
    assert engine.run_batch("classify", "float-labels", [value]) == fp32
    assert engine.run_batch("classify", "labels", [value]) != fp32

    next_value = engine.prepare("classify", "labels", {"inputIds": [3, 2, 41]})
    batched = engine.run_batch("classify", "labels", [value, next_value])
    separate = [engine.run_batch("classify", "labels", [request])[0] for request in [value, next_value]]
    for actual, expected in zip(batched, separate):
        assert actual["classIndex"] == expected["classIndex"]
        assert actual["logits"] == pytest.approx(expected["logits"], abs=1e-6)


def test_quantization_discards_unneeded_weights() -> None:
    engine = _engine()
    original = engine.heads["lm"].trunk.blocks[0].attention.qkv_proj
    disabled = apply_quantization(engine, None)
    assert disabled == {}
    assert engine.heads["lm"].trunk.blocks[0].attention.qkv_proj is original

    # With only one head, no request needs its original float projections after adoption.
    engine.heads = {"lm": engine.heads["lm"]}
    report = apply_quantization(engine, {"lm": _generation()})
    assert report["lm"]["adopted"]
    routed = engine.heads["lm"].trunk.blocks[0].attention.qkv_proj
    assert isinstance(routed, _RoutedLinear)
    assert routed.fp32 is None


def test_quantization_keeps_float_when_backend_is_unavailable(monkeypatch: pytest.MonkeyPatch) -> None:
    engine = _engine()
    original = engine.heads["lm"].trunk.blocks[0].attention.qkv_proj

    def unavailable(_module: nn.Module) -> None:
        raise RuntimeError("Unsupported test CPU kernel.")

    monkeypatch.setattr(torch.ao.nn.quantized.dynamic.Linear, "from_float", unavailable)
    report = apply_quantization(engine, {"lm": _generation()})
    assert report["lm"]["reason"] == "unsupported_backend"
    assert report["labels"]["reason"] == "no_probes"
    assert not engine.quantized_heads
    assert engine.heads["lm"].trunk.blocks[0].attention.qkv_proj is original


def test_quantization_refuses_sampling_probes_and_requires_explicit_thresholds() -> None:
    engine = _engine()
    generation = _generation()
    generation["probes"][0]["payload"]["temperature"] = 0.8
    with pytest.raises(ValueError, match="greedy decoding"):
        apply_quantization(engine, {"lm": generation})
    del generation["thresholds"]["minGreedyTokenAgreement"]
    with pytest.raises(ValueError, match="greedy token agreement threshold"):
        apply_quantization(engine, {"lm": generation})


def test_int8_refuses_a_changed_pointer_selection_even_with_loose_thresholds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = _engine()
    trunk = engine.heads["lm"].trunk
    with torch.random.fork_rng(devices=[]):
        torch.manual_seed(4)
        projection = nn.Sequential(nn.Linear(16, 1)).eval()
    engine.heads = {"pointer": DenseHead(trunk, ("score", "select"), projection)}
    dynamic = torch.ao.nn.quantized.dynamic.Linear
    original_forward = dynamic.forward

    def reverse_pointer_scores(module: nn.Module, inputs: torch.Tensor) -> torch.Tensor:
        outputs = original_forward(module, inputs)
        return -outputs if module.out_features == 1 else outputs

    monkeypatch.setattr(dynamic, "forward", reverse_pointer_scores)
    payload = {"inputIds": [4, 8, 17], "candidatePositions": [0, 1, 2]}
    report = apply_quantization(engine, {
        "pointer": {
            "thresholds": {"minTop1Agreement": 0.0, "maxAbsoluteLogitDifference": 100.0},
            "probes": [{"operation": operation, "payload": payload} for operation in ("score", "select")],
        },
    })

    assert report["pointer"]["reason"] == "selection_changed"
    assert not report["pointer"]["adopted"]
    assert not engine.quantized_heads
    assert isinstance(projection[0], nn.Linear)


def test_int8_refuses_changed_tokens_between_cache_modes(monkeypatch: pytest.MonkeyPatch) -> None:
    engine = _engine()
    original_step = GenerationBatch.step

    def diverging_step(batch: GenerationBatch, active: list[int]) -> dict:
        steps = original_step(batch, active)
        if batch.cache_enabled:
            return steps
        return {
            index: replace(step, token_id=(step.token_id + 1) % batch.trunk.config.vocab_size)
            for index, step in steps.items()
        }

    monkeypatch.setattr(GenerationBatch, "step", diverging_step)
    report = apply_quantization(engine, {"lm": _generation()})
    assert report["lm"]["reason"] == "cache_tokens_changed"
    assert report["lm"]["greedyTokenAgreement"] == 1.0
    assert not engine.quantized_heads


def test_int8_refuses_changed_closed_list_choice(monkeypatch: pytest.MonkeyPatch) -> None:
    engine = _engine()
    engine.heads["options"] = DenseHead(engine.heads["lm"].trunk, ("score-options",))

    def changed_choice(_head: DenseHead, _value) -> torch.Tensor:
        return torch.tensor([-2.0, -1.0] if _INT8.get() else [-1.0, -2.0])

    monkeypatch.setattr(DenseHead, "_option_scores", changed_choice)
    report = apply_quantization(engine, {
        "options": {
            "thresholds": {"minTop1Agreement": 0, "maxAbsoluteLogitDifference": 2},
            "probes": [{"operation": "score-options", "payload": {"inputIds": [4, 8], "options": [[17], [32]]}}],
        },
    })

    assert report["options"]["reason"] == "selection_changed"
    assert not report["options"]["adopted"]
    assert not engine.quantized_heads
