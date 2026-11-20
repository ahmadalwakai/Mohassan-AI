"""Acceptance tests for the nested-architecture plan sidecars (CPU, tiny random trunks).

They prove mechanics only (shapes, exactness, rollback, isolation, pinning),
never quality. Plan: docs/NESTED-ARCHITECTURE-PLAN-2026-11-19.md section 8.
"""
import sys
from pathlib import Path

import pytest
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import execution_pipeline  # noqa: E402,F401

from execution_model.adapters import attach_adapter, detach_adapter, expected_parameters  # noqa: E402
from execution_model.config import ModelConfig  # noqa: E402
from execution_model.early_exit import (EarlyExitHead, assert_trunk_frozen, distillation_loss,  # noqa: E402
                                        freeze_trunk, run_with_exit)
from execution_model.errors import InvalidRequestError, ModelLoadError  # noqa: E402
from execution_model.generation import GenerationConfig, generate  # noqa: E402
from execution_model.model import ExecutionModel  # noqa: E402
from execution_model.sidecar import load_sidecar, save_sidecar  # noqa: E402
from execution_model.speculative import speculative_generate_greedy  # noqa: E402

TINY = ModelConfig(vocab_size=256, hidden_size=32, intermediate_size=64, num_layers=4, num_heads=4,
                   max_context_length=96, seed=7)
TRUNK_38M = ModelConfig(vocab_size=24576, hidden_size=512, intermediate_size=1408, num_layers=8, num_heads=8,
                        max_context_length=512)


def tiny_model(seed: int = 7) -> ExecutionModel:
    model = ExecutionModel(ModelConfig(**{**TINY.to_dict(), "seed": seed}))
    return model.eval()


def test_at_exit_shape_counts():
    assert TRUNK_38M.parameter_count() == 38_281_728
    assert EarlyExitHead.expected_parameters(512, "norm") == 512
    assert EarlyExitHead.expected_parameters(512, "projection") == 262_656
    model = tiny_model()
    for variant in ("norm", "projection"):
        head = EarlyExitHead(model, 2, variant)
        assert sum(p.numel() for p in head.parameters()) == EarlyExitHead.expected_parameters(32, variant)


def test_at_adapter_shape_counts_for_38m_trunk():
    with torch.device("meta"):
        trunk = ExecutionModel(TRUNK_38M)
    assert expected_parameters(trunk, 8) == 565_248


def test_run_with_exit_reproduces_trunk_logits_exactly():
    model = tiny_model()
    head = EarlyExitHead(model, 2)
    ids = torch.randint(0, 256, (2, 20), generator=torch.Generator().manual_seed(1))
    mask = torch.ones_like(ids)
    mask[1, :5] = 0
    with torch.inference_mode():
        for attention in (None, mask):
            for last in (False, True):
                reference = model(ids, attention, last_token_only=last).logits
                traced = run_with_exit(model, head, ids, attention, last_token_only=last)
                assert torch.equal(traced.full_logits, reference)
                assert traced.exit_logits.shape == reference.shape
        cheap = run_with_exit(model, head, ids, full=False)
        assert cheap.full_logits is None


def test_distillation_trains_head_only():
    model = tiny_model()
    freeze_trunk(model)
    assert_trunk_frozen(model)
    head = EarlyExitHead(model, 2, "projection").train()
    ids = torch.randint(0, 256, (2, 16), generator=torch.Generator().manual_seed(2))
    out = run_with_exit(model, head, ids)
    loss = distillation_loss(out.exit_logits, out.full_logits, ids, ignore_index=TINY.ignore_index, temperature=2.0)
    loss.backward()
    assert all(p.grad is None for p in model.parameters())
    assert all(p.grad is not None for p in head.parameters())


@pytest.mark.parametrize("seed", [3, 11, 19])
@pytest.mark.parametrize("draft", [1, 3, 6])
def test_at_spec_greedy_matches_generate(seed, draft):
    model = tiny_model(seed)
    head = EarlyExitHead(model, 2).eval()
    prompt = torch.randint(0, 256, (12,), generator=torch.Generator().manual_seed(seed)).tolist()
    reference = generate(model, prompt, GenerationConfig(max_new_tokens=40))
    result = speculative_generate_greedy(model, head, prompt, max_new_tokens=40, draft_tokens=draft)
    assert result.token_ids == reference.token_ids
    assert result.stop_reason == reference.stop_reason == "length"
    assert 0 <= result.accepted <= result.drafted


def test_at_spec_stops_on_eos_like_generate():
    model = tiny_model(5)
    head = EarlyExitHead(model, 2).eval()
    prompt = [1, 2, 3, 4]
    free = generate(model, prompt, GenerationConfig(max_new_tokens=20)).token_ids
    eos = free[3]
    reference = generate(model, prompt, GenerationConfig(max_new_tokens=20), eos_token_id=eos)
    result = speculative_generate_greedy(model, head, prompt, max_new_tokens=20, draft_tokens=4, eos_token_id=eos)
    assert result.token_ids == reference.token_ids
    assert result.stop_reason == reference.stop_reason == "eos"


def test_fresh_adapter_is_noop_and_detach_restores_exactly():
    model = tiny_model()
    ids = torch.randint(0, 256, (1, 24), generator=torch.Generator().manual_seed(4))
    keys = list(model.state_dict())
    with torch.inference_mode():
        base = model(ids).logits.clone()
    handle = attach_adapter(model, "coding", rank=4)
    assert handle.parameter_count() == expected_parameters(model, 4)
    with torch.inference_mode():
        assert torch.equal(model(ids).logits, base)
        for parameter in handle.parameters():
            parameter.normal_(0, 0.5)
        assert not torch.equal(model(ids).logits, base)
    detach_adapter(model)
    assert list(model.state_dict()) == keys
    with torch.inference_mode():
        assert torch.equal(model(ids).logits, base)


def test_at_isolation_one_adapter_at_a_time():
    model = tiny_model()
    attach_adapter(model, "coding")
    with pytest.raises(InvalidRequestError):
        attach_adapter(model, "ads")
    detach_adapter(model)
    attach_adapter(model, "ads")
    detach_adapter(model)
    with pytest.raises(InvalidRequestError):
        detach_adapter(model)


def test_sidecar_roundtrip_pins_trunk_and_refuses_overwrite(tmp_path):
    model = tiny_model()
    head = EarlyExitHead(model, 2, "projection")
    with torch.no_grad():
        head.projection.weight.normal_()
    manifest = save_sidecar(tmp_path / "exit", head, {"kind": "early_exit", "trunk_sha256": "a" * 64, "exit_layer": 2})
    assert manifest["parameters"] == EarlyExitHead.expected_parameters(32, "projection")
    with pytest.raises(FileExistsError):
        save_sidecar(tmp_path / "exit", head, {"kind": "early_exit", "trunk_sha256": "a" * 64})
    fresh = EarlyExitHead(model, 2, "projection")
    load_sidecar(tmp_path / "exit", fresh, kind="early_exit", trunk_sha256="a" * 64)
    assert torch.equal(fresh.projection.weight, head.projection.weight)
    with pytest.raises(ModelLoadError):
        load_sidecar(tmp_path / "exit", fresh, kind="early_exit", trunk_sha256="b" * 64)
    with pytest.raises(ModelLoadError):
        load_sidecar(tmp_path / "exit", fresh, kind="adapter", trunk_sha256="a" * 64)


def test_adapter_sidecar_roundtrip(tmp_path):
    model = tiny_model()
    handle = attach_adapter(model, "ads", rank=4)
    with torch.no_grad():
        for parameter in handle.parameters():
            parameter.normal_()
    save_sidecar(tmp_path / "ads", handle.state_module(), {"kind": "adapter", "trunk_sha256": "c" * 64, "name": "ads"})
    detach_adapter(model)
    other = attach_adapter(model, "ads", rank=4, seed=99)
    load_sidecar(tmp_path / "ads", other.state_module(), kind="adapter", trunk_sha256="c" * 64)
    for a, b in zip(handle.parameters(), other.parameters()):
        assert torch.equal(a, b)
