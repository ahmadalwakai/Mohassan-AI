"""Exercise the memory monitor with fake counters and a monotonic clock."""

import json
import os
import subprocess
from types import SimpleNamespace

import pytest

from execution_pipeline import chat_diagnostics as diagnostics


@pytest.fixture
def monitor(tmp_path, monkeypatch):
    elapsed = 0
    monkeypatch.setattr(diagnostics, "time", SimpleNamespace(perf_counter=lambda: elapsed))
    guard = diagnostics.GpuJob(tmp_path, tmp_path)
    monkeypatch.setattr(diagnostics, "threading", SimpleNamespace(
        Thread=lambda target, **kwargs: SimpleNamespace(start=target),
    ))

    def run(readings):
        pending = [(0, 100, 80), *readings]
        used = 80

        def wait(seconds):
            nonlocal elapsed
            elapsed += seconds
            return not pending

        def counters(command, **kwargs):
            nonlocal elapsed, used
            if command[0] == "nvidia-smi":
                return f"{used}, 4096, 65, 0"
            duration, shared, used = pending.pop(0)
            elapsed += duration
            if shared is None:
                raise subprocess.TimeoutExpired(command[0], timeout=20)
            prefix = f"gpu process memory(pid_{os.getpid()}_luid_1)\\"
            return json.dumps([
                {"Path": prefix + "shared usage", "CookedValue": shared},
                {"Path": prefix + "dedicated usage", "CookedValue": 100},
            ])

        monkeypatch.setattr(guard.stop, "wait", wait)
        monkeypatch.setattr(subprocess, "check_output", counters)
        guard.start_monitor()
        records = [json.loads(line) for line in (tmp_path / "gpu-memory.jsonl").read_text().splitlines()]
        return guard, records

    return run


@pytest.mark.parametrize("failures", [1, 2])
def test_monitor_records_transient_sample_errors_and_keeps_running(monitor, failures):
    guard, records = monitor([(20, None, 0)] * failures + [(0, 100, 80)])

    guard.check()
    assert len(guard.samples) == 2
    errors = [record["sample_error"] for record in records if "sample_error" in record]
    assert len(errors) == failures
    assert all("timed out" in error for error in errors)
    assert records[-1]["gpu_used_mib"] == 80


def test_monitor_stops_at_third_consecutive_failure(monitor):
    guard, records = monitor([(20, None, 0)] * 3 + [(0, 100, 80)])

    with pytest.raises(RuntimeError, match="3 consecutive samples"):
        guard.check()
    assert len(guard.samples) == 1
    assert sum("sample_error" in record for record in records) == 3


def test_good_sample_resets_failure_count(monitor):
    failures = [(20, None, 0)] * 2
    guard, records = monitor([*failures, (0, 100, 80), *failures, (0, 100, 80)])

    guard.check()
    assert len(guard.samples) == 3
    assert sum("sample_error" in record for record in records) == 4


def test_monitor_stops_after_90_seconds_even_before_third_failure(monitor):
    guard, records = monitor([(45, None, 0), (35, None, 0), (0, 100, 80)])

    with pytest.raises(RuntimeError, match="no successful sample for 90 seconds"):
        guard.check()
    assert len(guard.samples) == 1
    assert sum("sample_error" in record for record in records) == 2


def test_training_checks_sample_deadline_while_monitor_is_waiting(monitor, monkeypatch):
    guard, _ = monitor([])
    elapsed = 89
    monkeypatch.setattr(diagnostics, "time", SimpleNamespace(perf_counter=lambda: elapsed))

    guard.check()
    elapsed = 90
    with pytest.raises(RuntimeError, match="no successful sample for 90 seconds"):
        guard.check()


def test_good_sample_with_excess_memory_stops_immediately(monitor):
    excessive_shared_usage = 100 + 256 * 1024**2 + 1
    guard, records = monitor([(20, None, 0), (0, excessive_shared_usage, 3700), (0, 100, 80)])

    with pytest.raises(RuntimeError, match="GPU memory stop"):
        guard.check()
    assert len(guard.samples) == 2
    assert len(records) == 3
    assert records[-1]["shared_bytes"] == excessive_shared_usage
