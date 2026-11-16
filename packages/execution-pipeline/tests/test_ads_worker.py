"""CPU-only worker contract checks using a tiny local random-weight fixture."""
import hashlib
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from execution_pipeline.ads_worker import AdsWorker  # noqa: E402
from execution_model.config import ModelConfig  # noqa: E402
from execution_model.model import ExecutionModel  # noqa: E402
from execution_model.tokenizer import ByteBPETokenizer  # noqa: E402
from execution_pipeline import ask_code  # noqa: E402


@pytest.fixture()
def tiny_run(tmp_path):
    tokenizer = ByteBPETokenizer()
    tokenizer.save(tmp_path / "tokenizer.json")
    config = ModelConfig(vocab_size=tokenizer.vocab_size, hidden_size=16, intermediate_size=32,
                         num_layers=1, num_heads=2, max_context_length=64, seed=9)
    checkpoint_dir = tmp_path / "fixture"
    checkpoint_dir.mkdir()
    torch.save({"config": config.to_dict(), "model_state": ExecutionModel(config).state_dict(), "step": 7},
               checkpoint_dir / "best.pt")
    settings = {"config_identity": config.identity, "tokenizer_identity": tokenizer.identity,
                "languages": ["ar", "en"], "prompt_hint": None}
    (checkpoint_dir / "settings.json").write_text(json.dumps(settings), encoding="utf-8")
    return tmp_path, config, tokenizer


def _update_settings(run, **changes):
    path = run / "fixture" / "settings.json"
    settings = json.loads(path.read_text(encoding="utf-8"))
    settings.update(changes)
    path.write_text(json.dumps(settings), encoding="utf-8")


def test_exact_checkpoint_and_settings_produce_bound_handshake(tiny_run, monkeypatch):
    run, config, tokenizer = tiny_run
    digest = hashlib.sha256((run / "fixture" / "best.pt").read_bytes()).hexdigest()
    original_load = torch.load
    calls = []

    def checked_load(*args, **kwargs):
        calls.append(kwargs)
        return original_load(*args, **kwargs)

    monkeypatch.setattr(torch, "load", checked_load)
    worker = AdsWorker(run, "cpu", "fixture", digest)
    handshake = worker.handshake()
    assert handshake["checkpoint_sha256"] == digest
    assert handshake["config_identity"] == config.identity
    assert handshake["tokenizer_identity"] == tokenizer.identity
    assert handshake["parameters"] == config.parameter_count()
    assert handshake["finetune_step"] == 7
    assert handshake["languages"] == ["ar", "en"]
    assert handshake["device"] == "cpu"
    assert calls and all(call["weights_only"] is True for call in calls)


def test_checkpoint_hash_mismatch_rejected_before_deserialization(tiny_run, monkeypatch):
    run, _, _ = tiny_run

    def forbidden_load(*args, **kwargs):
        pytest.fail("Mismatched checkpoint must not be deserialized")

    monkeypatch.setattr(torch, "load", forbidden_load)
    with pytest.raises(ValueError, match="selected evaluated version"):
        AdsWorker(run, "cpu", "fixture", "0" * 64)


@pytest.mark.parametrize("field", ["config_identity", "tokenizer_identity"])
def test_settings_identity_mismatch_rejected(tiny_run, field):
    run, _, _ = tiny_run
    _update_settings(run, **{field: "wrong-identity"})
    with pytest.raises(ValueError, match="identities do not match"):
        AdsWorker(run, "cpu", "fixture")


def test_vocabulary_dimension_mismatch_rejected_even_with_matching_settings(tiny_run):
    run, config, _ = tiny_run
    different = ModelConfig.from_dict({**config.to_dict(), "vocab_size": config.vocab_size + 1})
    torch.save({"config": different.to_dict(), "model_state": ExecutionModel(different).state_dict()},
               run / "fixture" / "best.pt")
    _update_settings(run, config_identity=different.identity)
    with pytest.raises(ValueError, match="vocabulary does not match"):
        AdsWorker(run, "cpu", "fixture")


class FixedTokenModel:
    """Predicts one token so protocol stopping and limits can be checked exactly."""
    def __init__(self, vocabulary, token):
        self.vocabulary, self.token, self.widths = vocabulary, token, []

    def __call__(self, ids, **kwargs):
        self.widths.append(ids.shape[1])
        logits = torch.full((len(ids), 1, self.vocabulary), -1000.0)
        logits[:, :, self.token] = 1000.0
        return SimpleNamespace(logits=logits)


def test_eos_marks_all_candidates_finished_without_emitting_special_token(tiny_run):
    run, _, tokenizer = tiny_run
    worker = AdsWorker(run, "cpu", "fixture")
    worker.model = FixedTokenModel(tokenizer.vocab_size, tokenizer.eos_token_id)
    assert worker.sample({"prompt": "hi", "candidates": 2, "max_new_tokens": 16}) == [
        {"text": "", "finished": True}, {"text": "", "finished": True}]
    assert len(worker.model.widths) == 1


def test_generation_caps_to_remaining_context_and_reports_unfinished(tiny_run):
    run, config, tokenizer = tiny_run
    worker = AdsWorker(run, "cpu", "fixture")
    worker.model = FixedTokenModel(tokenizer.vocab_size, tokenizer.encode("x")[0])
    result = worker.sample({"prompt": "hello", "candidates": 1, "max_new_tokens": 384})
    assert result == [{"text": "x" * (config.max_context_length - 5), "finished": False}]
    assert max(worker.model.widths) < config.max_context_length


@pytest.mark.parametrize("prompt", [None, "", "   ", 12, "x" * 32001])
def test_invalid_prompt_rejected_before_model_execution(tiny_run, prompt):
    run, _, _ = tiny_run
    worker = AdsWorker(run, "cpu", "fixture")
    worker.model = lambda *args, **kwargs: pytest.fail("Invalid prompt must not execute model")
    with pytest.raises(ValueError, match="nonempty bounded text prompt"):
        worker.sample({"prompt": prompt})


def test_prompt_without_eight_remaining_tokens_rejected(tiny_run):
    run, _, _ = tiny_run
    worker = AdsWorker(run, "cpu", "fixture")
    with pytest.raises(ValueError, match="too long"):
        worker.sample({"prompt": "x" * 58, "max_new_tokens": 16})


def test_code_cli_preserves_model_candidate_and_user_oracle_without_synthesizing_targets():
    given = {"message": "Write a function that adds its arguments.", "functionName": "addValues",
             "signature": "addValues(a: number, b: number): number", "probes": [{"args": [2, 3], "expected": 5}]}
    model_text = "export function addValues(a: number, b: number): number { return a - b; }"
    calls = []

    class Worker:
        def sample(self, request):
            calls.append(request)
            return [{"text": model_text, "finished": True}]

        def handshake(self):
            return {"checkpoint_sha256": "a" * 64}

    result, job = ask_code.generate(given, Worker())
    assert result["candidates"][0]["text"] == model_text
    assert job["candidates"][0]["content"] == model_text  # Wrong code is not replaced with the oracle.
    assert job["candidates"][0]["probes"] == given["probes"]
    assert job["candidates"][0]["signature"] == given["signature"]
    assert result["status"] == "needs_verification" and result["verified"] is False and result["applied"] is False
    assert calls[0]["candidates"] == calls[0]["top_k"] == 1
    assert '"expected"' not in calls[0]["prompt"]


@pytest.mark.parametrize("candidate", [{"text": "export function unfinished", "finished": False}, {"text": "", "finished": True}])
def test_code_cli_never_offers_incomplete_generation_for_verification(candidate):
    given = {"message": "Add a and b.", "functionName": "sum", "signature": "sum(a: number, b: number): number",
             "probes": [{"args": [2, 3], "expected": 5}]}
    worker = SimpleNamespace(sample=lambda _: [candidate], handshake=lambda: {})
    result, job = ask_code.generate(given, worker)
    assert result["status"] == "incomplete_generation"
    assert job is None


@pytest.mark.parametrize("invalid", [
    {"message": "Write code"},
    {"message": "Add", "functionName": "sum", "signature": "other(): number", "probes": [{"args": [], "expected": 1}]},
    {"message": "Add", "functionName": "sum", "signature": "sum(): number", "probes": []},
    {"message": "Add", "functionName": "sum", "signature": "sum(): number", "probes": [{"args": []}]},
    {"message": "Add", "functionName": "sum", "signature": "sum(): number", "probes": [{"args": [], "expected": 0}], "target": "invented answer"},
])
def test_code_cli_requires_an_explicit_matching_contract_and_independent_probes(invalid):
    with pytest.raises(ValueError):
        ask_code.prepare_input(invalid)


def _embed_metadata(run, **changes):
    checkpoint = run / "fixture" / "best.pt"
    payload = torch.load(checkpoint, map_location="cpu", weights_only=True)
    settings = json.loads((run / "fixture" / "settings.json").read_text(encoding="utf-8"))
    payload["settings"] = {**settings, **changes}
    torch.save(payload, checkpoint)


@pytest.mark.parametrize("field", ["config_identity", "tokenizer_identity"])
def test_embedded_checkpoint_identity_cannot_be_overridden_by_adjacent_settings(tiny_run, field):
    run, _, _ = tiny_run
    _embed_metadata(run, **{field: "different-embedded-identity"})
    with pytest.raises(ValueError, match="Embedded checkpoint identities"):
        AdsWorker(run, "cpu", "fixture")


def test_adjacent_language_claim_cannot_expand_embedded_checkpoint_support(tiny_run):
    run, _, _ = tiny_run
    _embed_metadata(run, languages=["en"])
    with pytest.raises(ValueError, match="language metadata"):
        AdsWorker(run, "cpu", "fixture")


@pytest.mark.parametrize("pin_location", ["adjacent", "embedded", "both"])
def test_tokenizer_report_tamper_rejected_even_when_vocabulary_identity_is_unchanged(tiny_run, pin_location):
    run, _, _ = tiny_run
    report = run / "tokenizer-report.json"
    report.write_text(json.dumps({"pretokenizer": "none"}), encoding="utf-8")
    expected = hashlib.sha256(report.read_bytes()).hexdigest()
    if pin_location in {"adjacent", "both"}:
        _update_settings(run, tokenizer_report_sha256=expected)
    if pin_location in {"embedded", "both"}:
        _embed_metadata(run, tokenizer_report_sha256=expected)
    # Both encodings use the same BPE vocabulary, but split text differently.
    report.write_text(json.dumps({"pretokenizer": "words-v1"}), encoding="utf-8")
    with pytest.raises(ValueError, match="pre-tokenization settings"):
        AdsWorker(run, "cpu", "fixture")


def test_matching_embedded_and_adjacent_tokenizer_report_is_accepted(tiny_run):
    run, _, _ = tiny_run
    report = run / "tokenizer-report.json"
    report.write_text(json.dumps({"pretokenizer": "words-v1"}), encoding="utf-8")
    expected = hashlib.sha256(report.read_bytes()).hexdigest()
    _update_settings(run, tokenizer_report_sha256=expected)
    _embed_metadata(run)
    assert AdsWorker(run, "cpu", "fixture").handshake()["languages"] == ["ar", "en"]


def test_checkpoint_sha_is_bound_to_the_same_stream_torch_deserializes(tiny_run, monkeypatch):
    run, _, _ = tiny_run
    checkpoint = run / "fixture" / "best.pt"
    expected = hashlib.sha256(checkpoint.read_bytes()).hexdigest()
    original_load = torch.load
    loaded = []

    def inspect_stream(source, *args, **kwargs):
        # Passing a path here would reopen a possibly replaced checkpoint after hashing it.
        assert hasattr(source, "read") and hasattr(source, "seek")
        assert source.tell() == 0
        digest = hashlib.sha256(source.read()).hexdigest()
        source.seek(0)
        payload = original_load(source, *args, **kwargs)
        loaded.append((digest, payload["step"]))
        return payload

    monkeypatch.setattr(torch, "load", inspect_stream)
    handshake = AdsWorker(run, "cpu", "fixture", expected).handshake()
    assert loaded == [(handshake["checkpoint_sha256"], handshake["finetune_step"])]
    assert handshake["checkpoint_sha256"] == expected
