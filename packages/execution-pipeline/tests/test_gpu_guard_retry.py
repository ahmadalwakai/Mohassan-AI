"""Exercise GPU monitor retries without hardware or real waits."""
from collections import deque
from functools import partial
import json
import os
import subprocess
from types import SimpleNamespace

import pytest

from execution_pipeline import chat_diagnostics as diagnostics


@pytest.fixture
def run_monitor(tmp_path, monkeypatch):
    def run(samples):
        pending = deque(["good", *samples])
        elapsed = 0
        sample = None

        def perf_counter():
            return elapsed

        def wait(seconds):
            nonlocal elapsed
            if not pending:
                return True
            elapsed += seconds
            return False

        def counters(command, **kwargs):
            nonlocal elapsed, sample
            if command[0] == "nvidia-smi":
                if sample == "nvidia-timeout":
                    timeout = kwargs["timeout"]
                    assert timeout == 60
                    elapsed += timeout
                    raise subprocess.TimeoutExpired(command[0], timeout)
                used_mib = 3700 if sample == "memory-stop" else 84
                return f"{used_mib}, 4096, 65, 0"

            sample = pending.popleft()
            if sample == "counter-timeout":
                timeout = kwargs["timeout"]
                elapsed += timeout
                raise subprocess.TimeoutExpired(command[0], timeout)
            shared_bytes = 256 * 1024**2 + 1 if sample == "memory-stop" else 0
            process = f"gpu process memory(pid_{os.getpid()}_luid_1)"
            return json.dumps([
                {"Path": process + "\\shared usage", "CookedValue": shared_bytes},
                {"Path": process + "\\dedicated usage", "CookedValue": 0},
            ])

        monkeypatch.setattr(diagnostics, "time", SimpleNamespace(perf_counter=perf_counter))
        monkeypatch.setattr(diagnostics.subprocess, "CREATE_NO_WINDOW", 0, raising=False)
        monkeypatch.setattr(diagnostics.subprocess, "check_output", counters)
        guard = diagnostics.GpuJob(tmp_path, tmp_path)
        monkeypatch.setattr(guard.stop, "wait", wait)
        monkeypatch.setattr(diagnostics, "threading", SimpleNamespace(
            Thread=lambda *, target, args, daemon: SimpleNamespace(start=partial(target, *args)),
        ))
        guard.start_monitor()
        records = [json.loads(line) for line in (tmp_path / "gpu-memory.jsonl").read_text().splitlines()]
        return guard, [record["sample_error"] for record in records if "sample_error" in record]

    return run


@pytest.mark.parametrize("failures", [1, 2])
def test_transient_sample_errors_are_logged_and_monitoring_continues(run_monitor, failures):
    guard, errors = run_monitor(["counter-timeout"] * failures + ["good"])

    guard.check()
    assert len(errors) == failures
    assert all("timed out" in error for error in errors)
    assert len(guard.samples) == 2


def test_three_consecutive_sample_errors_stop_monitoring(run_monitor):
    guard, errors = run_monitor(["counter-timeout"] * 3 + ["good"])

    with pytest.raises(RuntimeError, match="3 consecutive"):
        guard.check()
    assert len(errors) == 3
    assert len(guard.samples) == 1


def test_a_good_sample_resets_the_failure_budget(run_monitor):
    guard, errors = run_monitor((["counter-timeout"] * 2 + ["good"]) * 2)

    guard.check()
    assert len(errors) == 4
    assert len(guard.samples) == 3


def test_90_seconds_without_a_good_sample_stops_before_the_third_failure(run_monitor):
    guard, errors = run_monitor(["counter-timeout", "nvidia-timeout", "good"])

    with pytest.raises(RuntimeError, match="90 seconds"):
        guard.check()
    assert len(errors) == 2
    assert "nvidia-smi" in errors[-1]
    assert len(guard.samples) == 1


def test_a_real_memory_stop_is_immediate_after_a_sample_error(run_monitor):
    guard, errors = run_monitor(["counter-timeout", "memory-stop", "good"])

    with pytest.raises(RuntimeError, match="GPU memory stop"):
        guard.check()
    assert len(errors) == 1
    assert [sample["gpu_used_mib"] for sample in guard.samples] == [84, 3700]
