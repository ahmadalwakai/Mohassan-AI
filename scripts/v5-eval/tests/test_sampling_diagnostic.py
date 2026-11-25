"""Sampling checks with small pinned protocols and exact decoder inputs."""

import json
from pathlib import Path
import sys

import pytest
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import sampling_diagnostic as diagnostic
from execution_pipeline import REPOSITORY_ROOT, ads_worker, chat_probes, gate3_probes
from execution_pipeline.pretrain import PRETOKENIZER
from execution_model import cached_generation, generation
from execution_model.config import ModelConfig
from execution_model.model import ExecutionModel
from execution_model.tokenizer import ByteBPETokenizer


def prepare_fixture(tmp_path, monkeypatch, probes, *, device="cpu", context=512):
    is_chat = probes is chat_probes
    rows = []
    for language, text in (("ar", "نص عربي"), ("en", "English text")):
        for number in range(1, 21):
            prompt = f'{text} "A B"\n{number}'
            row = {"language": language, "criterion": "Continue on topic", "development_only": True,
                   "independent_test": False}
            if is_chat:
                row.update(id=f"chat-{language}-{number:02d}", probe_type="chat_reply", category="fixture",
                           messages=[{"role": "user", "content": "Previous turn"},
                                     {"role": "assistant", "content": text},
                                     {"role": "user", "content": prompt}])
            else:
                row.update(id=f"gate3-{language}-{number:02d}", probe_type="raw_prose_continuation", prompt=prompt)
            rows.append(row)
    source = tmp_path / "prompts.jsonl"
    source.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")
    monkeypatch.setattr(probes, "PROBES", source)
    monkeypatch.setattr(probes, "PROBES_SHA256", gate3_probes.sha256(source))

    run = tmp_path / "run"
    selected = run / "selected"
    selected.mkdir(parents=True)
    # This merge spans the fixture's word boundary and detects use of raw BPE instead of TextEncoder.
    tokenizer = ByteBPETokenizer(merges=[(ord("A"), ord(" "))])
    tokenizer.save(run / "tokenizer.json")
    (run / "tokenizer-report.json").write_text(json.dumps({"pretokenizer": PRETOKENIZER}), encoding="utf-8")
    config = ModelConfig(vocab_size=tokenizer.vocab_size, hidden_size=8, intermediate_size=8,
                         num_layers=1, num_heads=1, max_context_length=context)
    (selected / "settings.json").write_text(json.dumps({"tokenizer_identity": tokenizer.identity,
                                                         "config_identity": config.identity}), encoding="utf-8")
    checkpoint = selected / "best.pt"
    torch.save({"config": config.to_dict(), "model_state": ExecutionModel(config).state_dict()}, checkpoint)
    return probes.prepare(run, selected.name, gate3_probes.sha256(checkpoint), tmp_path / "pinned-predictions",
                          **({} if is_chat else {"device": device}))


def records(path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def fixed_result(token_ids, config, eos_token_id):
    generated = (ord("A"), 255, eos_token_id)
    return generation.GenerationResult(token_ids=generated, input_tokens=len(token_ids), output_tokens=len(generated),
                                       stop_reason="eos", terminal_token_id=eos_token_id, constraint_satisfied=None,
                                       seed=config.seed, deterministic_algorithms=False)


@pytest.mark.parametrize("probes", [chat_probes, gate3_probes], ids=["chat", "prose"])
@pytest.mark.parametrize("reference", [False, True], ids=["cached", "reference"])
def test_matches_pinned_predict_for_every_encoded_input_and_record(tmp_path, monkeypatch, probes, reference):
    preparation = prepare_fixture(tmp_path, monkeypatch, probes)
    protocol = Path(preparation["protocol"])
    sha = preparation["protocol_sha256"]
    events = []
    calls = []
    original_check = probes.check
    original_loader = ads_worker.AdsWorker

    def check(*args, **kwargs):
        events.append("check")
        return original_check(*args, **kwargs)

    def load(*args):
        events.append(("load", args))
        return original_loader(*args)

    def capture(backend):
        def generate(model, token_ids, config, *, eos_token_id):
            assert all(parameter.dtype == torch.float32 and parameter.device.type == "cpu"
                       for parameter in model.parameters())
            calls.append((backend, tuple(token_ids), config, eos_token_id))
            return fixed_result(token_ids, config, eos_token_id)

        return generate

    monkeypatch.setattr(probes, "check", check)
    monkeypatch.setattr(ads_worker, "AdsWorker", load)
    monkeypatch.setattr(generation, "generate", capture("generate"))
    monkeypatch.setattr(cached_generation, "generate_cached", capture("generate_cached"))
    monkeypatch.setattr(torch.cuda, "is_available", lambda: pytest.fail("Unexpected CUDA inspection"))

    pinned_manifest = probes.predict(protocol, sha)
    pinned_calls = calls.copy()
    pinned_events = events.copy()
    calls.clear()
    events.clear()
    output = tmp_path / "samples"
    manifest = diagnostic.run_diagnostic(protocol, sha, output, reference=reference)
    assert events == pinned_events
    assert events[0] == events[-1] == "check"
    assert events[1][1][1] == "cpu"

    pinned_rows = records(protocol.parent / "predictions.jsonl")
    sampled_rows = records(output / "predictions.jsonl")
    assert len(pinned_rows) == len(pinned_calls) == 40
    assert len(sampled_rows) == len(calls) == 3 * len(pinned_rows)
    # Config and seeds come from the owner's pre-registration in the 2026-11-25 task.
    settings = {"max_new_tokens": 192, "do_sample": True, "temperature": 0.7, "top_p": 0.9, "top_k": 0}
    backend = "generate" if reference else "generate_cached"
    for index, (pinned_row, (_, encoded, _, eos)) in enumerate(zip(pinned_rows, pinned_calls)):
        for offset, seed in enumerate((1, 2, 3)):
            sample_index = 3 * index + offset
            assert calls[sample_index] == (backend, encoded, generation.GenerationConfig(**settings, seed=seed), eos)
            assert eos == 258
            sampled = sampled_rows[sample_index]
            assert sampled["seed"] == seed
            assert sampled["decoding"] == {**settings, "device": "cpu", "dtype": "float32", "stop_at_eos": True,
                                           "eos_token_id": eos, "backend": backend}
            assert type(sampled["ms"]) is int and sampled["ms"] >= 0
            assert {key: value for key, value in sampled.items() if key not in {"ms", "seed", "decoding"}} == {
                key: value for key, value in pinned_row.items() if key != "ms"
            }

    assert manifest == json.loads((output / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["protocol_sha256"] == sha
    assert manifest["checkpoint_sha256"] == pinned_manifest["checkpoint_sha256"]
    assert manifest["predictions"]["sha256"] == gate3_probes.sha256(output / "predictions.jsonl")
    assert manifest["counts_toward_gate"] is False
    assert manifest["generated"] == {
        "total": len(sampled_rows),
        **{language: sum(row["language"] == language for row in sampled_rows) for language in ("ar", "en")},
    }
    for name in (*probes.CODE_PATHS, "scripts/v5-eval/sampling_diagnostic.py",
                 "packages/execution-model/execution_model/cached_generation.py"):
        assert manifest["code"][name]["sha256"] == gate3_probes.sha256(REPOSITORY_ROOT / name)


def test_prose_protocol_device_does_not_select_diagnostic_device(tmp_path, monkeypatch):
    preparation = prepare_fixture(tmp_path, monkeypatch, gate3_probes, device="cuda")

    def generate(model, token_ids, config, *, eos_token_id):
        assert next(model.parameters()).device.type == "cpu"
        return fixed_result(token_ids, config, eos_token_id)

    monkeypatch.setattr(cached_generation, "generate_cached", generate)
    manifest = diagnostic.run_diagnostic(Path(preparation["protocol"]), preparation["protocol_sha256"],
                                         tmp_path / "samples")
    assert manifest["decoding"]["device"] == "cpu"


@pytest.mark.parametrize("flag", ["--do-sample", "--temperature", "--top-p", "--top-k", "--max-new-tokens",
                                  "--seed", "--seeds", "--device", "--dtype", "--eos-token-id", "--ref"])
def test_cli_refuses_decoding_overrides(flag, capsys):
    with pytest.raises(SystemExit) as error:
        diagnostic.main(["--protocol", "protocol.json", "--protocol-sha256", "sha256", "--output", "new", flag])
    assert error.value.code == 2
    assert "unrecognized arguments" in capsys.readouterr().err


@pytest.mark.parametrize("filename", ["protocol.json", "predictions.jsonl", "assessment.json", None])
def test_refuses_existing_output_directory_without_writing(tmp_path, monkeypatch, filename):
    preparation = prepare_fixture(tmp_path, monkeypatch, gate3_probes)
    monkeypatch.setattr(ads_worker, "AdsWorker", lambda *args: pytest.fail("Checkpoint must remain unloaded"))
    output = tmp_path / "existing"
    output.mkdir()
    if filename is not None:
        (output / filename).write_text("original", encoding="utf-8")
    before = {file.name: file.read_bytes() for file in output.iterdir()}
    with pytest.raises(FileExistsError):
        diagnostic.run_diagnostic(Path(preparation["protocol"]), preparation["protocol_sha256"], output)
    assert {file.name: file.read_bytes() for file in output.iterdir()} == before


def test_refuses_protocol_directory(tmp_path, monkeypatch):
    preparation = prepare_fixture(tmp_path, monkeypatch, chat_probes)
    protocol = Path(preparation["protocol"])
    with pytest.raises(FileExistsError, match="protocol's output directory"):
        diagnostic.run_diagnostic(protocol, preparation["protocol_sha256"], protocol.parent)
    assert list(protocol.parent.iterdir()) == [protocol]


def test_checks_protocol_digest_and_pinned_assets_before_writing(tmp_path, monkeypatch):
    preparation = prepare_fixture(tmp_path, monkeypatch, chat_probes)
    protocol = Path(preparation["protocol"])
    output = tmp_path / "samples"
    monkeypatch.setattr(ads_worker, "AdsWorker", lambda *args: pytest.fail("Checkpoint must remain unloaded"))
    with pytest.raises(ValueError, match="protocol SHA-256 does not match"):
        diagnostic.run_diagnostic(protocol, "0" * 64, output)
    (tmp_path / "run" / "tokenizer.json").write_text("changed", encoding="utf-8")
    with pytest.raises(ValueError, match="Pinned evidence changed"):
        diagnostic.run_diagnostic(protocol, preparation["protocol_sha256"], output)
    assert not output.exists()


def test_context_overflow_refuses_a_shorter_budget_and_records_failure(tmp_path, monkeypatch):
    preparation = prepare_fixture(tmp_path, monkeypatch, gate3_probes, context=192)
    protocol = Path(preparation["protocol"])
    sha = preparation["protocol_sha256"]
    output = tmp_path / "samples"
    monkeypatch.setattr(cached_generation, "generate_cached", lambda *args, **kwargs: pytest.fail("Unexpected decoding"))
    with pytest.raises(ValueError, match="fixed output budget exceed model context"):
        diagnostic.run_diagnostic(protocol, sha, output)
    failure = json.loads((output / "failure.json").read_text(encoding="utf-8"))
    assert failure["protocol_sha256"] == sha
    assert failure["error"].startswith("ValueError: gate3-ar-01")
    assert not (output / "manifest.json").exists()
    with pytest.raises(FileExistsError):
        diagnostic.run_diagnostic(protocol, sha, output)
