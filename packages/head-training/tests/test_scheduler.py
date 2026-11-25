from __future__ import annotations

import json
import os
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path

import pytest

from head_training import scheduler
from head_training.scheduler import (
    SHARED_GPU_LOCK,
    V5_FOUNDATION_STATUS,
    SchedulerBlocked,
    TrainingGuard,
    schedule,
)


def _set_status(path: Path, status: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"status": status}), encoding="utf-8")


def _forbidden(name: str, path: Path, guard: TrainingGuard | None) -> dict[str, object]:
    pytest.fail(f"Scheduled unexpected job {name}")


def test_default_dry_run_never_creates_an_output_or_lock(tmp_path: Path) -> None:
    _set_status(tmp_path / V5_FOUNDATION_STATUS, "early_stopped")
    report_dir = tmp_path / "output"

    result = schedule(tmp_path, report_dir, ["router"], _forbidden, cuda=True, wait=True)

    assert result["status"] == "ready"
    assert result["dry_run"] is True
    assert result["planned_jobs"] == ["router"]
    assert not report_dir.exists()
    assert not (tmp_path / SHARED_GPU_LOCK).parent.exists()


def test_refuses_an_existing_gpu_lock_even_if_its_contents_are_unreadable_as_json(tmp_path: Path) -> None:
    _set_status(tmp_path / V5_FOUNDATION_STATUS, "completed")
    lock = tmp_path / SHARED_GPU_LOCK
    lock.parent.mkdir()
    lock.write_bytes(b"partial write or stale lock")
    report_dir = tmp_path / "output"

    assert schedule(tmp_path, report_dir, ["router"], _forbidden)["status"] == "blocked"
    with pytest.raises(SchedulerBlocked, match="GPU lock exists"):
        schedule(tmp_path, report_dir, ["router"], _forbidden, execute=True)

    assert lock.read_bytes() == b"partial write or stale lock"
    assert not report_dir.exists()


@pytest.mark.parametrize("status", ["starting", "running", "paused_time_limit", "failed", "interrupted"])
def test_refuses_v5_until_a_successful_terminal_status(tmp_path: Path, status: str) -> None:
    _set_status(tmp_path / V5_FOUNDATION_STATUS, status)

    with pytest.raises(SchedulerBlocked, match=f"v5 is {status}"):
        schedule(tmp_path, tmp_path / "output", ["router"], _forbidden, execute=True)

    assert not (tmp_path / SHARED_GPU_LOCK).exists()
    assert not (tmp_path / "output").exists()


def test_missing_or_malformed_canonical_status_blocks_execution(tmp_path: Path) -> None:
    status = tmp_path / V5_FOUNDATION_STATUS
    status.parent.mkdir(parents=True)
    for payload in (None, "{", "null", '{"status": 200}'):
        if payload is not None:
            status.write_text(payload, encoding="utf-8")
        with pytest.raises(SchedulerBlocked, match="Missing or unreadable v5 status"):
            schedule(tmp_path, tmp_path / "output", ["router"], _forbidden, execute=True)
        assert not (tmp_path / SHARED_GPU_LOCK).exists()


def test_refuses_when_v5_3_sibling_or_additional_status_is_running(tmp_path: Path) -> None:
    foundation = tmp_path / V5_FOUNDATION_STATUS
    _set_status(foundation, "completed")
    dialogue = foundation.parent.with_name("chat-v5") / "status.json"
    _set_status(dialogue, "running")
    with pytest.raises(SchedulerBlocked, match="chat-v5"):
        schedule(tmp_path, tmp_path / "output", ["router"], _forbidden, execute=True)

    _set_status(dialogue, "completed")
    auxiliary = Path("alternate-v5/status.json")
    _set_status(tmp_path / auxiliary, "running")
    with pytest.raises(SchedulerBlocked, match="alternate-v5"):
        schedule(
            tmp_path, tmp_path / "output", ["router"], _forbidden, execute=True, v5_status_paths=[auxiliary]
        )


def test_waits_for_status_lock_and_publication_then_runs_jobs_in_order(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    foundation = tmp_path / V5_FOUNDATION_STATUS
    _set_status(foundation, "running")
    lock = tmp_path / SHARED_GPU_LOCK
    lock.parent.mkdir()
    lock.write_text("other", encoding="utf-8")
    published = tmp_path / "published"
    report_dir = tmp_path / "output"
    notices: list[tuple[str, ...]] = []
    calls: list[str] = []

    def on_wait(blockers: Sequence[str]) -> None:
        notices.append(tuple(blockers))

    def advance(seconds: float) -> None:
        assert seconds == 5
        assert not report_dir.exists()
        if len(notices) == 1:
            _set_status(foundation, "completed")
        elif len(notices) == 2:
            lock.unlink()
        elif len(notices) == 3:
            published.touch()
        else:
            pytest.fail("Scheduler continued polling after prerequisites finished")

    def train_job(name: str, output: Path, guard: TrainingGuard | None) -> dict[str, object]:
        assert guard is None
        receipt = json.loads(lock.read_text(encoding="utf-8"))
        assert set(receipt) == {"owner", "purpose", "pid", "started"}
        assert receipt["pid"] == os.getpid()
        assert datetime.fromisoformat(receipt["started"]).utcoffset() == timedelta(0)
        assert output == report_dir / name
        assert not output.exists()
        output.mkdir()
        calls.append(name)
        return {"updates": 2}

    monkeypatch.setattr("head_training.scheduler.time.sleep", advance)
    report = schedule(
        tmp_path,
        report_dir,
        ["router", "ranker"],
        train_job,
        execute=True,
        wait=True,
        poll_seconds=5,
        ready=lambda: None if published.exists() else "Waiting for the selected checkpoint",
        on_wait=on_wait,
    )

    assert any("v5 is running" in reason for reason in notices[0])
    assert "GPU lock exists" in notices[1][0]
    assert notices[2] == ("Waiting for the selected checkpoint",)
    assert calls == ["router", "ranker"]
    assert report["status"] == "completed"
    assert json.loads((report_dir / "scheduler-report.json").read_text(encoding="utf-8")) == report
    assert not lock.exists()


def test_rechecks_v5_after_claiming_lock(tmp_path: Path) -> None:
    foundation = tmp_path / V5_FOUNDATION_STATUS
    _set_status(foundation, "completed")

    def change_status_before_acquisition() -> None:
        _set_status(foundation, "running")

    with pytest.raises(SchedulerBlocked, match="v5 is running"):
        schedule(
            tmp_path,
            tmp_path / "output",
            ["router"],
            _forbidden,
            execute=True,
            ready=change_status_before_acquisition,
        )
    assert not (tmp_path / SHARED_GPU_LOCK).exists()
    assert not (tmp_path / "output").exists()


def test_rechecks_publication_after_claiming_lock(tmp_path: Path) -> None:
    _set_status(tmp_path / V5_FOUNDATION_STATUS, "completed")
    lock = tmp_path / SHARED_GPU_LOCK

    def publication_became_unavailable() -> str | None:
        return "Checkpoint disappeared before start" if lock.exists() else None

    with pytest.raises(SchedulerBlocked, match="Checkpoint disappeared"):
        schedule(
            tmp_path,
            tmp_path / "output",
            ["router"],
            _forbidden,
            execute=True,
            ready=publication_became_unavailable,
        )
    assert not lock.exists()
    assert not (tmp_path / "output").exists()


def test_exclusive_claim_loses_race_without_removing_the_winner(tmp_path: Path) -> None:
    _set_status(tmp_path / V5_FOUNDATION_STATUS, "completed")
    lock = tmp_path / SHARED_GPU_LOCK
    lock.parent.mkdir()

    def claim_before_scheduler() -> None:
        with lock.open("x", encoding="utf-8") as stream:
            stream.write("winner")

    with pytest.raises(SchedulerBlocked, match="GPU lock exists"):
        schedule(
            tmp_path, tmp_path / "output", ["router"], _forbidden, execute=True, ready=claim_before_scheduler
        )
    assert lock.read_text(encoding="utf-8") == "winner"
    assert not (tmp_path / "output").exists()


@pytest.mark.parametrize(
    ("error", "expected"), [(RuntimeError("bad run"), "failed"), (KeyboardInterrupt(), "interrupted")]
)
def test_failure_reports_partial_run_releases_lock_and_stops_queue(
    tmp_path: Path, error: BaseException, expected: str
) -> None:
    _set_status(tmp_path / V5_FOUNDATION_STATUS, "completed")
    report_dir = tmp_path / "output"

    def interrupted(name: str, path: Path, guard: TrainingGuard | None) -> dict[str, object]:
        assert name == "router"
        raise error

    with pytest.raises(type(error)):
        schedule(tmp_path, report_dir, ["router", "ranker"], interrupted, execute=True)

    assert not (tmp_path / SHARED_GPU_LOCK).exists()
    report = json.loads((report_dir / "scheduler-report.json").read_text(encoding="utf-8"))
    assert report["status"] == expected
    assert report["error"] == type(error).__name__
    assert [(item["name"], item["status"]) for item in report["jobs"]] == [("router", "failed")]


def test_does_not_remove_a_replaced_or_reused_lock_path(tmp_path: Path) -> None:
    _set_status(tmp_path / V5_FOUNDATION_STATUS, "completed")
    lock = tmp_path / SHARED_GPU_LOCK

    def replace_lock(name: str, path: Path, guard: TrainingGuard | None) -> dict[str, object]:
        replacement = lock.with_name("replacement")
        replacement.write_bytes(lock.read_bytes())
        replacement.replace(lock)
        return {}

    schedule(tmp_path, tmp_path / "output", ["router"], replace_lock, execute=True)

    assert lock.is_file()


def test_cuda_uses_the_guard_under_the_shared_lock_and_resets_speed_per_head(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_status(tmp_path / V5_FOUNDATION_STATUS, "completed")
    lock = tmp_path / SHARED_GPU_LOCK
    events: list[str] = []

    class FakeGuard:
        def start_training(self, name: str) -> None:
            events.append(f"guard:{name}")

        def record_training_update(self, tokens: int, elapsed_seconds: float) -> None:
            events.append(f"update:{tokens}")

        def check(self) -> None:
            assert lock.is_file()

    @contextmanager
    def opened(root: Path, output: Path) -> Iterator[TrainingGuard]:
        assert lock.is_file()
        events.append("open")
        yield FakeGuard()
        events.append("close")

    def train_job(name: str, output: Path, guard: TrainingGuard | None) -> dict[str, object]:
        assert guard is not None
        events.append(name)
        guard.record_training_update(2, 0.1)
        return {}

    monkeypatch.setattr(scheduler, "_cuda_guard", opened)
    schedule(tmp_path, tmp_path / "output", ["router", "ranker"], train_job, execute=True, cuda=True)

    assert events == [
        "open",
        "guard:router",
        "router",
        "update:2",
        "guard:ranker",
        "ranker",
        "update:2",
        "close",
    ]
    assert not lock.exists()


def test_refuses_to_overwrite_existing_scheduler_output(tmp_path: Path) -> None:
    _set_status(tmp_path / V5_FOUNDATION_STATUS, "completed")
    output = tmp_path / "output"
    output.mkdir()
    report = output / "scheduler-report.json"
    report.write_text("previous run", encoding="utf-8")

    with pytest.raises(FileExistsError):
        schedule(tmp_path, output, ["router"], _forbidden, execute=True)

    assert report.read_text(encoding="utf-8") == "previous run"
    assert not (tmp_path / SHARED_GPU_LOCK).exists()


def test_windows_cuda_guard_prepares_legacy_lock_and_determinism(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import torch
    from execution_pipeline import chat_diagnostics, stage5_finetune

    events: list[str] = []

    class FakeGpuJob:
        def check(self) -> None:
            events.append("checked")

        def start_monitor(self) -> None:
            events.append("monitor")

    @contextmanager
    def legacy_guard(root: Path, output: Path, stage: str, maximum: int) -> Iterator[FakeGpuJob]:
        assert (root / scheduler.V4_GPU_LOCK).parent.is_dir()
        assert stage == "head-training-kit" and maximum > 0
        events.append("acquired")
        yield FakeGpuJob()
        events.append("released")

    def fake_empty(size: int, *, device: str) -> None:
        assert size == 1 and device == "cuda"
        assert os.environ["CUBLAS_WORKSPACE_CONFIG"] == ":4096:8"
        events.append("allocated")

    monkeypatch.delenv("CUBLAS_WORKSPACE_CONFIG", raising=False)
    monkeypatch.setattr(chat_diagnostics, "GpuJob", legacy_guard)
    monkeypatch.setattr(stage5_finetune, "_awake", lambda flag: events.append(f"awake:{flag}") or 1)
    monkeypatch.setattr(torch.cuda, "is_available", lambda: True)
    monkeypatch.setattr(torch, "empty", fake_empty)
    with monkeypatch.context() as platform:
        platform.setattr(scheduler.sys, "platform", "win32")
        with scheduler._cuda_guard(tmp_path, tmp_path / "run"):
            events.append("training")
    assert events == ["awake:2147483649", "acquired", "allocated", "monitor", "training", "checked", "released",
                      "awake:2147483648"]
