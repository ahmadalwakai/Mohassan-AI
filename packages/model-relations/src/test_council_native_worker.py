"""Exercise council adapters with fake inference and the real typed task renderer."""

import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import pytest


spec = importlib.util.spec_from_file_location("council_native_worker", Path(__file__).with_name("council-native-worker.py"))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)

from execution_model import generation, tokenizer  # noqa: E402
from execution_pipeline.tasks import render  # noqa: E402
from model_worker import checkpoints  # noqa: E402


def test_execution_reuses_typed_task_renderer_and_handles_invalid_fields(monkeypatch):
    capability = "json.transform.v1:integers-to-strings"
    fields = {"values": [-3, 0, 5]}
    encoded = (5, 2)
    terminal_token = 1
    identity = "test identity"
    candidate = json.dumps({"values": [str(value) for value in fields["values"]]}).encode()

    class Tokenizer:
        special_token_ids = {"bos": 0, "eos": terminal_token}

        def encode(self, prompt, *, add_bos):
            assert prompt == render(capability, fields)
            assert add_bos
            return encoded

        def decode_bytes(self, tokens):
            assert tuple(tokens) == encoded
            return candidate

    def generate(model, ids, config, **options):
        assert tuple(ids) == encoded
        assert config.max_new_tokens == model.config.max_context_length - len(encoded)
        assert options["eos_token_id"] == terminal_token
        assert options["blocked_token_ids"] == (0,)
        return SimpleNamespace(token_ids=(*encoded, terminal_token), terminal_token_id=terminal_token)

    stub = Tokenizer()
    stub.identity = identity
    model = SimpleNamespace(config=SimpleNamespace(max_context_length=len(encoded) + 1), to=lambda _: None)
    monkeypatch.setattr(tokenizer.ByteBPETokenizer, "load", lambda _: stub)
    monkeypatch.setattr(generation, "generate", generate)
    monkeypatch.setattr(checkpoints, "load_dense_inference", lambda *_: (model, terminal_token))
    monkeypatch.setattr(worker, "document", lambda _: {"tokenizer_identity": identity})
    artifacts = {"manifest": {"path": "manifest.json", "sha256": "fake"}, "weights": {"sha256": "fake"}}
    run = worker.load_execution(artifacts, "cpu")
    assert run({"capability": capability, "fields": fields}) == {"text": candidate.decode()}
    with pytest.raises(checkpoints.EngineError, match="invalid-input"):
        run({"capability": capability, "fields": {"values": [None]}})
    with pytest.raises(checkpoints.EngineError, match="invalid-input"):
        run({"capability": "unknown", "fields": fields})
