"""CPU checks for answer-token weighting, fixed update counts and diagnostic gates."""
import json
import random

import pytest
import torch

from test_ads_finetune import scratch, train_fixture
from test_ads_finetune_balanced import write_rows
from execution_pipeline import ads_finetune as training


def test_full_balanced_batches_never_have_underfilled_accumulation():
    batches = training._balanced_epoch_batches({"ar": [0, 1, 2], "en": [3, 4, 5, 6, 7]},
                                               random.Random(5), 4, full_batches=True)
    assert len(batches) == 4
    assert all(len(chunk) == 4 for chunk in batches)
    assert sum(all(index < 3 for index in chunk) for chunk in batches) == 2


def test_accumulation_matches_full_answer_token_gradient_with_unequal_answers(scratch, monkeypatch):
    run, _ = scratch
    write_rows(scratch[1], train=[{"prompt": f"task {i}: ", "target": "answer " + "alpha " * (i + 1),
                                   "language": "ar" if i < 4 else "en"} for i in range(8)])
    load = training._load_pretrained

    def no_dropout(*args, **kwargs):
        model, tokenizer, config = load(*args, **kwargs)
        for module in model.modules():
            if isinstance(module, torch.nn.Dropout):
                module.p = 0
            if isinstance(getattr(module, "dropout", None), float):
                module.dropout = 0
        return model, tokenizer, config

    monkeypatch.setattr(training, "_load_pretrained", no_dropout)
    options = dict(balanced_languages=True, batch=1, accumulation=4, max_steps=1, epochs=2)
    result = train_fixture(scratch, **options)
    train_fixture(scratch, balanced_languages=True, batch=4, accumulation=1, max_steps=1,
                  epochs=2, out_name="full")
    a = torch.load(run / "experiment/last.pt", weights_only=True)
    b = torch.load(run / "full/last.pt", weights_only=True)
    assert result["steps"] == 1
    assert result["training_progress"]["row_exposures"] == 4
    for key in a["model_state"]:
        torch.testing.assert_close(a["model_state"][key], b["model_state"][key], rtol=1e-4, atol=2e-6)


def test_validation_repeat_and_source_denominators(scratch):
    write_rows(scratch[1])
    measured_updates = []
    result = train_fixture(scratch, balanced_languages=True, batch=1, accumulation=2,
                           max_steps=2, epochs=2, source_metrics=True, verify_step_zero=True, preserve_evaluations=True,
                           training_update=lambda tokens, seconds: measured_updates.append((tokens, seconds)))
    assert result["steps"] == 2
    assert len(measured_updates) == 2
    assert all(tokens > 0 and seconds > 0 for tokens, seconds in measured_updates)
    proof = json.loads((scratch[0] / "experiment/step-zero-equivalence.json").read_text())
    assert proof["exact_match"] and proof["model_training_mode_restored"]
    cells = result["last_validation_metrics"]["per_source_language"]
    assert sum(cell["examples"] for cell in cells.values()) == 2
    assert set(cells) == {"unspecified:ar", "unspecified:en"}
    for step in (0, 1, 2):
        folder = scratch[0] / "experiment/checkpoints" / f"step-{step:06d}"
        receipt = json.loads((folder / "manifest.json").read_text())
        assert receipt["step"] == step
        assert receipt["checkpoint_sha256"] == training._sha256(folder / "checkpoint.pt")


def test_gate_requires_full_interval_and_resets_after_equal_or_higher_loss():
    from execution_pipeline.chat_diagnostics import gate_interval
    def point(step, loss):
        return {"step": step, "validation_metrics": {"macro_language_answer_loss": loss}}
    curve = [point(0, 4)] + [point(step, 3) for step in range(100, 1101, 100)]
    assert gate_interval(curve)["passed"]
    assert not gate_interval(curve[:-1])["passed"]
    curve[5] = point(500, 4)
    assert not gate_interval(curve)["passed"]
    with pytest.raises(ValueError, match="complete evaluations"):
        gate_interval(curve[:2] + curve[3:])


@pytest.mark.parametrize(("used_mib", "extra_bytes", "stops"), [
    (1762, 4 * 1024**2, False),
    (3699, 256 * 1024**2 + 1, False),
    (4096, 0, False),
    (3700, 256 * 1024**2, False),
    (3700, 256 * 1024**2 + 1, True),
    (3959, 1500 * 1024**2, True),
])
def test_gpu_guard_requires_near_full_dedicated_memory_and_shared_growth(
        tmp_path, monkeypatch, used_mib, extra_bytes, stops):
    import os
    from execution_pipeline import chat_diagnostics as diagnostics
    baseline = 77594624
    shared = baseline
    whole_gpu_used = 84

    def counters(command, **kwargs):
        if command[0] == "nvidia-smi":
            return f"{whole_gpu_used}, 4096, 65, 0"
        return json.dumps([
            {"Path": f"gpu process memory(pid_{os.getpid()}_luid_1)\\shared usage", "CookedValue": shared},
            {"Path": f"gpu process memory(pid_{os.getpid()}_luid_1)\\dedicated usage", "CookedValue": 78331904},
        ])
    monkeypatch.setattr(diagnostics.subprocess, "check_output", counters)
    guard = diagnostics.GpuJob(tmp_path, tmp_path)
    guard._sample(establish_baseline=True)
    assert guard.shared_baseline_bytes == baseline
    assert guard.samples[-1]["shared_delta_bytes"] == 0
    shared += extra_bytes
    whole_gpu_used = used_mib
    guard._sample()
    record = json.loads((tmp_path / "gpu-memory.jsonl").read_text().splitlines()[-1])
    assert record["shared_delta_bytes"] == extra_bytes
    assert record["gpu_used_mib"] == used_mib
    if stops:
        with pytest.raises(RuntimeError, match="GPU memory stop"):
            guard.check()
    else:
        guard.check()
    with pytest.raises(RuntimeError, match="cannot be recalibrated"):
        guard._sample(establish_baseline=True)


def test_gpu_guard_requires_two_full_minutes_strictly_below_speed_threshold(tmp_path):
    from execution_pipeline import chat_diagnostics as diagnostics

    guard = diagnostics.GpuJob(tmp_path, tmp_path)
    guard.start_training("first")
    guard.record_training_update(5500, 55)
    assert guard.speed_baseline is None
    guard.record_training_update(700, 10)
    assert guard.speed_baseline == 97.5
    assert guard.consecutive_slow_seconds == 0
    guard.start_training("second")
    guard.record_training_update(6000, 60)
    guard.record_training_update(8400, 120)  # 70% exactly
    guard.record_training_update(6900, 100)
    guard.record_training_update(350, 5)  # Recovery resets the duration.
    guard.record_training_update(8211, 119)
    guard.check()
    with pytest.raises(RuntimeError, match="GPU speed stop: .* for 120 training seconds"):
        guard.record_training_update(69, 1)
    record = json.loads((tmp_path / "training-speed.jsonl").read_text().splitlines()[-1])
    assert record["first_minute_tokens_per_second"] == 100
    assert record["tokens_per_second"] == 69
    assert record["consecutive_slow_seconds"] == 120


def test_gpu_guard_rejects_foreign_process_counter(tmp_path, monkeypatch):
    from execution_pipeline import chat_diagnostics as diagnostics
    monkeypatch.setattr(diagnostics.subprocess, "check_output", lambda *a, **kw: json.dumps([
        {"Path": "gpu process memory(pid_0_luid_1)\\shared usage", "CookedValue": 0}]))
    guard = diagnostics.GpuJob(tmp_path, tmp_path)
    with pytest.raises(RuntimeError, match="only this training process"):
        guard._sample(establish_baseline=True)
