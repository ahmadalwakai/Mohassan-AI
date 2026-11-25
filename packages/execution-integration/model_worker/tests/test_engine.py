"""Test pinned random checkpoints using the same architectures as the training code."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sys

import pytest
import torch
from torch import nn

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from model_worker import checkpoints
from model_worker.engine import EngineError, load_engine

from execution_model.checkpoint import CHECKPOINT_FORMAT, CHECKPOINT_VERSION
from execution_model.config import ModelConfig
from execution_model.generation import GenerationConfig, generate
from execution_model.metadata import ARCHITECTURE_ID
from execution_model.model import ExecutionModel
from execution_model.sidecar import save_sidecar
from execution_model.tokenizer import ByteBPETokenizer
from execution_pipeline import goal_tagger


def file_digest(path: Path) -> str:
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def write_json(path: Path, value: dict) -> str:
    path.write_text(json.dumps(value, sort_keys=True), encoding="utf-8")
    return file_digest(path)


def tiny_model(vocab_size: int = 256) -> ExecutionModel:
    return ExecutionModel(ModelConfig(
        vocab_size=vocab_size, hidden_size=16, intermediate_size=24, num_layers=2,
        num_heads=2, max_context_length=32, seed=790,
    )).eval()


@pytest.fixture
def training_fixture(tmp_path):
    model = tiny_model()
    checkpoint = tmp_path / "best.pt"
    # Training's best.pt also contains optimizer and RNG state.
    torch.save({"config": model.config.to_dict(), "model_state": model.state_dict(),
                "optimizer_state": {"state": {}, "param_groups": []},
                "generator_state": torch.random.get_rng_state()}, checkpoint)
    return model, {"checkpoint": {"path": checkpoint.name, "sha256": file_digest(checkpoint)}}


def load(config, tmp_path):
    return load_engine(config, base_dir=tmp_path, max_output_tokens=16)


def add_projection(tmp_path, kind, width, outputs, trunk_digest):
    directory = tmp_path / kind
    manifest = save_sidecar(directory, nn.Linear(width, outputs), {"kind": kind, "trunk_sha256": trunk_digest})
    return {"kind": kind, "sidecar": {"path": directory.name, "sha256": manifest["weights_sha256"],
                                      "manifestSha256": file_digest(directory / "sidecar.json")}}


def test_classification_and_pointer_operations_share_trunk_and_batch(training_fixture, tmp_path):
    trunk, config = training_fixture
    digest = config["checkpoint"]["sha256"]
    config["heads"] = {
        "lm": {"kind": "generate"},
        "route": add_projection(tmp_path, "classify", trunk.config.hidden_size, 3, digest),
        "span": add_projection(tmp_path, "pointer", trunk.config.hidden_size, 1, digest),
    }
    engine = load(config, tmp_path)
    assert engine.heads["lm"].trunk is engine.heads["route"].trunk is engine.heads["span"].trunk
    for operation, head in (("classify", "route"), ("score", "span"), ("select", "span")):
        values = []
        for row in range(8):
            request = {"inputIds": [5 + row, 11 + row, 4 + row]}
            if operation != "classify":
                request["candidatePositions"] = [2, 0] if row % 2 == 0 else [1]
            values.append(engine.prepare(operation, head, request))
        batched = engine.run_batch(operation, head, values)
        singles = [engine.run_batch(operation, head, [value])[0] for value in values]
        for value, batch, single in zip(values, batched, singles):
            metric = "logits" if operation == "classify" else "scores"
            assert batch[metric] == pytest.approx(single[metric], abs=2e-6, rel=2e-6)
            if operation == "classify":
                assert batch["classIndex"] == single["classIndex"]
            if operation == "select":
                assert batch["selectedIndex"] == single["selectedIndex"]
                assert batch["selectedPosition"] == value.candidates[batch["selectedIndex"]]


def run_generation(batch, size):
    active = list(range(size))
    tokens, logits, reasons = ([[] for _ in active], [[] for _ in active], [None for _ in active])
    while active:
        steps = batch.step(active)
        for row, step in steps.items():
            tokens[row].append(step.token_id)
            logits[row].append(step.logits)
            reasons[row] = step.stop_reason
        active = [row for row in active if reasons[row] is None]
    return tokens, logits, reasons


def test_cached_generation_matches_real_no_cache_and_survives_finished_rows(training_fixture, tmp_path):
    reference_model, config = training_fixture
    prompts = [list(range(1 + row, 5 + row)) for row in range(8)]
    eos = generate(reference_model, prompts[0], GenerationConfig(max_new_tokens=1)).token_ids[0]
    config["eosTokenId"] = eos
    engine = load(config, tmp_path)
    values = [engine.prepare("generate", "lm", {"inputIds": ids, "maxNewTokens": 5 + row})
              for row, ids in enumerate(prompts)]
    cached = engine.new_generation("lm", values)
    assert cached.batch.cache_enabled
    tokens, logits, reasons = run_generation(cached, 8)
    no_cache = engine.heads["lm"].new_generation(values, use_cache=False)
    no_cache_tokens, no_cache_logits, no_cache_reasons = run_generation(no_cache, 8)
    assert tokens == no_cache_tokens
    assert reasons == no_cache_reasons
    assert reasons[0] == "eos"
    assert len(tokens[0]) == 1 and len(tokens[-1]) > 1
    for row, value in enumerate(values):
        reference = generate(reference_model, value.input_ids, value.config, eos_token_id=eos)
        single = run_generation(engine.new_generation("lm", [value]), 1)
        assert tokens[row] == list(reference.token_ids) == single[0][0]
        assert reasons[row] == reference.stop_reason == single[2][0]
        for step, one, uncached in zip(logits[row], single[1][0], no_cache_logits[row]):
            torch.testing.assert_close(step, one, atol=2e-6, rtol=2e-6)
            torch.testing.assert_close(step, uncached, atol=2e-6, rtol=2e-6)


def test_sampling_and_short_cache_policy(training_fixture, tmp_path):
    reference_model, config = training_fixture
    engine = load(config, tmp_path)
    payload = {"inputIds": [1, 2, 3], "maxNewTokens": 3, "temperature": 0.7, "topK": 8,
               "topP": 0.65, "seed": 327}
    value = engine.prepare("generate", "lm", payload)
    longer = engine.prepare("generate", "lm", {**payload, "maxNewTokens": 8})
    batch = engine.new_generation("lm", [value, value])
    assert not batch.batch.cache_enabled
    assert engine.batch_key("generate", "lm", value) != engine.batch_key("generate", "lm", longer)
    tokens, _, reasons = run_generation(batch, 2)
    reference = generate(reference_model, value.input_ids, value.config)
    assert tokens == [list(reference.token_ids)] * 2
    assert reasons == ["length", "length"]
    for request in ({**payload, "maxNewTokens": 17}, {**payload, "inputIds": [256]},
                    {**payload, "temperature": 0}, {**payload, "topP": 0}, {**payload, "topK": True}):
        with pytest.raises(EngineError, match="invalid_request"):
            engine.prepare("generate", "lm", request)


def test_pin_mismatch_refuses_before_deserialization(training_fixture, tmp_path, monkeypatch):
    _, config = training_fixture
    config["checkpoint"]["sha256"] = "0" * 64

    def forbidden(*_args, **_kwargs):
        pytest.fail("Checkpoint deserialization attempted before successful pin verification.")

    monkeypatch.setattr(torch, "load", forbidden)
    with pytest.raises(EngineError, match="checkpoint_pin_mismatch"):
        load(config, tmp_path)


def test_projection_sidecar_pins_weights_manifest_and_trunk(training_fixture, tmp_path):
    model, config = training_fixture
    digest = config["checkpoint"]["sha256"]
    descriptor = add_projection(tmp_path, "pointer", model.config.hidden_size, 1, digest)
    config["heads"] = {"span": descriptor}
    sidecar = descriptor["sidecar"]
    original_weights_pin = sidecar["sha256"]
    sidecar["sha256"] = "0" * 64
    with pytest.raises(EngineError, match="invalid_checkpoint"):
        load(config, tmp_path)
    sidecar["sha256"] = original_weights_pin

    manifest_path = tmp_path / sidecar["path"] / "sidecar.json"
    manifest = json.loads(manifest_path.read_text())
    changed_manifest = write_json(manifest_path, {**manifest, "trunk_sha256": "0" * 64})
    with pytest.raises(EngineError, match="checkpoint_pin_mismatch"):
        load(config, tmp_path)
    sidecar["manifestSha256"] = changed_manifest
    with pytest.raises(EngineError, match="invalid_checkpoint"):
        load(config, tmp_path)


def test_deserializes_exact_pinned_bytes_even_if_path_is_replaced(training_fixture, tmp_path, monkeypatch):
    original, config = training_fixture
    checkpoint = tmp_path / config["checkpoint"]["path"]
    original_load = torch.load

    def replace_file(handle, *args, **kwargs):
        checkpoint.write_bytes(b"different bytes")
        return original_load(handle, *args, **kwargs)

    monkeypatch.setattr(torch, "load", replace_file)
    engine = load(config, tmp_path)
    torch.testing.assert_close(engine.heads["lm"].trunk.token_embedding.weight, original.token_embedding.weight)


def test_phase_two_export_pins_manifest_weights_and_tokenizer(tmp_path):
    tokenizer = ByteBPETokenizer()
    model = tiny_model(tokenizer.vocab_size)
    directory = tmp_path / "inference"
    directory.mkdir()
    torch.save(model.state_dict(), directory / "weights.pt")
    weights_digest = file_digest(directory / "weights.pt")
    write_json(directory / "config.json", model.config.to_dict())
    write_json(directory / "tokenizer.json", tokenizer.to_dict())
    manifest_digest = write_json(directory / "manifest.json", {
        "format": CHECKPOINT_FORMAT, "version": CHECKPOINT_VERSION, "architecture": ARCHITECTURE_ID,
        "config_identity": model.config.identity, "tokenizer_identity": tokenizer.identity,
        "weights_sha256": weights_digest, "training_status": "random_initialized",
        "initialization_seed": model.config.seed,
    })
    spec = {"path": directory.name, "format": "inference", "sha256": weights_digest,
            "manifestSha256": manifest_digest, "tokenizerId": tokenizer.identity}
    engine = load({"checkpoint": spec}, tmp_path)
    assert engine.heads["lm"].eos == tokenizer.eos_token_id
    for field in ("sha256", "manifestSha256", "tokenizerId"):
        with pytest.raises(EngineError, match="checkpoint_pin_mismatch|invalid_checkpoint"):
            load({"checkpoint": {**spec, field: "0" * 64}}, tmp_path)


def test_goal_tagger_uses_trained_checkpoint_shape_and_existing_decoder(tmp_path):
    words, chars = ["<pad>", "<unk>", "advertise"], ["<pad>", "<unk>", "a"]
    settings = {"width": 16, "word_width": 8, "char_width": 4, "words": len(words), "chars": len(chars),
                "heads": 2, "feed_forward": 24, "layers": 1, "dropout": 0.0, "field_presence": True}
    reference = goal_tagger.build_model(settings).eval()
    path = tmp_path / "best.pt"
    torch.save({"settings": settings, "vocabulary": {"words": words, "chars": chars, "lexicon": None},
                "model_state": reference.state_dict()}, path)
    engine = load({"checkpoint": {"path": path.name, "format": "goal-tagger", "sha256": file_digest(path)}}, tmp_path)
    assert engine.heads["intent"].trunk is engine.heads["goal-tagger"].trunk
    texts = ["advertise example.com", "advertise locally"]
    vocabulary = goal_tagger.Vocabulary(words, chars)
    expected = goal_tagger.answer_all(reference, vocabulary, texts, "cpu")
    values = [engine.prepare("select", "goal-tagger", {"text": text}) for text in texts]
    selected = engine.run_batch("select", "goal-tagger", values)
    assert [row["selection"] for row in selected] == expected
    scores = engine.run_batch("score", "goal-tagger", values)
    assert [row["scores"] for row in scores] == [row["scores"] for row in selected]
    classified = engine.run_batch("classify", "intent", values)
    assert [row["logits"] for row in classified] == [row["scores"]["intent"] for row in selected]
    for head in goal_tagger.PRESENCE_FIELDS:
        assert engine.heads[head].operations == ("classify",)


def test_gpu_lock_respected_and_cuda_opt_in_reserves_before_probing(training_fixture, tmp_path, monkeypatch):
    _, config = training_fixture
    monkeypatch.setattr(checkpoints, "REPOSITORY_ROOT", tmp_path)
    lock = tmp_path / ".data" / "gpu.lock"
    lock.parent.mkdir()
    training = {"owner": "training", "purpose": "test lock", "pid": 234, "started": "2026-11-25T00:00:00Z"}
    write_json(lock, training)

    def forbidden():
        pytest.fail("CUDA was probed while training held the lock.")

    monkeypatch.setattr(torch.cuda, "is_available", forbidden)
    assert load(config, tmp_path).device.type == "cpu"
    with pytest.raises(EngineError, match="gpu_locked"):
        load({**config, "device": "cuda"}, tmp_path)
    assert json.loads(lock.read_text()) == training

    lock.unlink()

    def probe():
        metadata = json.loads(lock.read_text())
        assert metadata.keys() == {"owner", "purpose", "pid", "started"}
        assert metadata["owner"] == "Mohassan model worker"
        return False

    monkeypatch.setattr(torch.cuda, "is_available", probe)
    with pytest.raises(EngineError, match="gpu_unavailable"):
        load({**config, "device": "cuda"}, tmp_path)
    assert not lock.exists()

    lease = checkpoints.GpuLease(lock)
    write_json(lock, training)  # Changed in place: identical inode, different owner.
    lease.close()
    assert json.loads(lock.read_text()) == training
