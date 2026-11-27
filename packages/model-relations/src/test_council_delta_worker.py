"""Use tiny local test fixtures to exercise the three v4 delta formats."""
from __future__ import annotations

import hashlib
import json

import pytest
import torch

from council_delta_worker import apply_delta, load_engine
from execution_model.adapters import attach_adapter, detach_adapter
from execution_model.config import ModelConfig
from execution_model.errors import ExecutionModelError
from execution_model.model import ExecutionModel
from execution_model.tokenizer import ByteBPETokenizer
from model_worker.checkpoints import EngineError
from model_worker.worker import _read_config


@pytest.fixture
def trunk():
    return ExecutionModel(ModelConfig(vocab_size=ByteBPETokenizer().vocab_size, hidden_size=16,
                                      intermediate_size=24, num_layers=3, num_heads=2,
                                      max_context_length=32)).eval()


def test_residual_head_applies_its_learned_bias_after_final_norm(trunk):
    hidden = trunk.config.hidden_size
    # The trained bottleneck comes from the T1 architecture at the pinned baseline.
    # https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/scripts/heads/t1_head_forms.py#L60 (retrieved 2026-11-27)
    bottleneck = 256
    bias = torch.arange(hidden, dtype=torch.float)
    state = {"down.weight": torch.zeros(bottleneck, hidden), "down.bias": torch.zeros(bottleneck),
             "up.weight": torch.zeros(hidden, bottleneck), "up.bias": bias}
    inputs = torch.ones(1, hidden)
    expected = trunk.final_norm(inputs) + bias
    apply_delta(trunk, "head", state)
    torch.testing.assert_close(trunk.final_norm(inputs), expected)


def test_lora_copies_tensors_into_the_live_projections(trunk):
    reference = attach_adapter(trunk, "test")
    state = {name: torch.ones_like(value) for name, value in reference.state_module().state_dict().items()}
    detach_adapter(trunk)
    original = trunk.blocks[0].attention.qkv_proj
    inputs = torch.ones(1, original.in_features)
    expected = original(inputs) + reference.alpha * original.in_features
    apply_delta(trunk, "lora", state)
    torch.testing.assert_close(trunk.blocks[0].attention.qkv_proj(inputs), expected)


def test_last_two_delta_preserves_the_first_block_and_checks_tensor_names(trunk):
    original = {name: parameter.detach().clone() for name, parameter in trunk.named_parameters()}
    state = {name: torch.zeros_like(value) for name, value in original.items()
             if name.startswith(("blocks.1.", "blocks.2.", "final_norm."))}
    with pytest.raises(ExecutionModelError):
        apply_delta(trunk, "last2", {**state, "unexpected": torch.tensor(1.0)})
    apply_delta(trunk, "last2", state)
    for name, parameter in trunk.named_parameters():
        torch.testing.assert_close(parameter, state.get(name, original[name]))


def test_delta_engine_uses_raw_prompt_and_verifies_the_snapshot(trunk, tmp_path):
    tokenizer = ByteBPETokenizer()
    tokenizer_path = tmp_path / "tokenizer.json"
    tokenizer.save(tokenizer_path)
    trunk_path = tmp_path / "trunk.pt"
    torch.save({"config": trunk.config.to_dict(), "model_state": trunk.state_dict()}, trunk_path)
    delta_path = tmp_path / "delta.pt"
    torch.save({name: parameter.detach().clone() for name, parameter in trunk.named_parameters()
                if name.startswith(("blocks.1.", "blocks.2.", "final_norm."))}, delta_path)

    def descriptor(path):
        return {"path": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}

    delta = {"arm": "last2", **descriptor(delta_path)}
    config = {"checkpoint": descriptor(trunk_path), "tokenizer": descriptor(tokenizer_path), "delta": delta}
    arguments = {"base_dir": tmp_path, "max_output_tokens": 8, "tokenizer_id": f"sha256:{tokenizer.identity}"}
    engine = load_engine(config, **arguments)
    try:
        request = engine.prepare("generate", "lm", {"prompt": "Answer:", "maxNewTokens": 2})
        assert list(request.input_ids) == tokenizer.encode("Answer:")
        generation = engine.new_generation("lm", [request])
        assert generation.step([0])[0].token_id is not None
    finally:
        engine.close()
    delta_path.write_bytes(delta_path.read_bytes() + b"modified")
    with pytest.raises(EngineError, match="checkpoint_pin_mismatch"):
        load_engine(config, **arguments)


def test_only_the_delta_entrypoint_accepts_a_delta_field(tmp_path):
    digest = hashlib.sha256(b"fictional checkpoint").hexdigest()
    config = {
        "identity": {"modelId": "reading-v4-head", "tokenizerId": "fixture", "checkpointId": f"sha256:{digest}"},
        "model": {"checkpoint": {"sha256": digest}, "delta": {"arm": "head"}},
    }
    path = tmp_path / "worker.json"
    path.write_text(json.dumps(config), encoding="utf-8")
    with pytest.raises(ValueError, match="invalid model configuration"):
        _read_config(path)
    assert _read_config(path, frozenset({"delta"}))[1] == config["model"]
