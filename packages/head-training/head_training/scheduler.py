"""Wait for the owner's v5 run and serialize head training on the PC."""

from __future__ import annotations

import json
import math
import os
import re
import sys
import time
from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import AbstractContextManager, ExitStack, contextmanager, nullcontext
from datetime import UTC, datetime
from pathlib import Path, PureWindowsPath
from typing import Protocol, cast

SHARED_GPU_LOCK = Path(".data/gpu.lock")
V4_GPU_LOCK = Path("artifacts/chat-training/v4/gpu.lock")
V5_FOUNDATION_STATUS = Path("artifacts/execution-model-runs/text-b5-2026-11-23/85m/status.json")
_FINISHED = frozenset({"completed", "early_stopped"})
_ACTIVE = frozenset({"running", "starting"})
_REPORT_NAMES = frozenset(
    {
        "scheduler-report.json",
        "gpu-start.json",
        "gpu-summary.json",
        "gpu-memory.jsonl",
        "training-speed.jsonl",
    }
)


class SchedulerBlocked(RuntimeError):
    """The required v5 and GPU state does not yet allow head training."""


class TrainingGuard(Protocol):
    def check(self) -> None: ...

    def start_training(self, name: str) -> None: ...

    def record_training_update(self, tokens: int, elapsed_seconds: float) -> None: ...


class _GpuMonitor(TrainingGuard, Protocol):
    def start_monitor(self) -> None: ...


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _lock_blocker(path: Path) -> str | None:
    try:
        path.lstat()
    except FileNotFoundError:
        return None
    except OSError:
        return f"Cannot inspect GPU lock: {path}"
    return f"GPU lock exists: {path}"


def _v5_state(root: Path, additional: Sequence[Path]) -> tuple[dict[str, str], list[str]]:
    # V5-3 writes the same status schema into a sibling of 85m. An explicitly
    # configured status can monitor a further installation location.
    required = {root / V5_FOUNDATION_STATUS, *(root / path for path in additional)}
    run_statuses = (root / "artifacts/execution-model-runs").glob("text-b5-*/*/status.json")
    campaign = root / "artifacts/chat-training/v5"
    paths = required.union(run_statuses, campaign.glob("status.json"), campaign.glob("*/status.json"))
    statuses: dict[str, str] = {}
    blockers: list[str] = []
    for path in sorted(paths):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            status = payload.get("status") if isinstance(payload, dict) else None
            if not isinstance(status, str) or not status:
                raise ValueError("Missing status field")
        except (OSError, UnicodeError, ValueError):
            blockers.append(f"Missing or unreadable v5 status: {path}")
            continue
        statuses[str(path)] = status
        if status in _ACTIVE or (path in required and status not in _FINISHED):
            blockers.append(f"v5 is {status}: {path}")
    return statuses, blockers


@contextmanager
def _shared_gpu_lock(path: Path) -> Iterator[None]:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = (
        json.dumps(
            {
                "owner": "Mohassan head-training kit",
                "purpose": "Train configured heads on the finished v5 trunk",
                "pid": os.getpid(),
                "started": _now(),
            }
        )
        + "\n"
    )
    try:
        stream = path.open("x", encoding="utf-8", newline="\n")
    except FileExistsError:
        raise SchedulerBlocked(f"GPU lock exists: {path}") from None
    identity = os.fstat(stream.fileno())
    written = False
    try:
        with stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        written = True
        yield
    finally:
        try:
            if os.path.samestat(identity, path.lstat()) and (
                not written or path.read_text(encoding="utf-8") == payload
            ):
                path.unlink()
        except (FileNotFoundError, UnicodeError):
            pass


@contextmanager
def _cuda_guard(root: Path, report_dir: Path) -> Iterator[TrainingGuard]:
    if sys.platform != "win32":
        raise RuntimeError("CUDA scheduling requires the pinned Windows GPU monitor. Use CPU on this system.")

    os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")

    import torch
    from execution_pipeline.chat_diagnostics import GpuJob
    from execution_pipeline.stage5_finetune import _awake

    awake = cast(Callable[[int], int], _awake)
    gpu_job = cast(Callable[[Path, Path, str, int], AbstractContextManager[_GpuMonitor]], GpuJob)
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA scheduling requires an available CUDA device.")
    if not awake(0x80000001):
        raise RuntimeError("Windows could not reserve system wakefulness.")
    try:
        (root / V4_GPU_LOCK).parent.mkdir(parents=True, exist_ok=True)
        with gpu_job(root, report_dir, "head-training-kit", 72 * 3600) as guard:
            torch.empty(1, device="cuda")
            guard.start_monitor()
            yield guard
            guard.check()
    finally:
        awake(0x80000000)


def _write_report(report_dir: Path, report: dict[str, object]) -> None:
    encoded = json.dumps(report, ensure_ascii=False, allow_nan=False, indent=2) + "\n"
    temporary = report_dir / ".scheduler-report.tmp"
    stream = temporary.open("x", encoding="utf-8")
    try:
        with stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(report_dir / "scheduler-report.json")
    finally:
        temporary.unlink(missing_ok=True)


def _run_jobs(
    root: Path,
    report_dir: Path,
    jobs: Sequence[str],
    train_job: Callable[[str, Path, TrainingGuard | None], Mapping[str, object]],
    *,
    cuda: bool,
    v5_status_paths: Sequence[Path],
    initial_statuses: dict[str, str],
) -> dict[str, object]:
    report_dir.mkdir(parents=True, exist_ok=False)
    attempts: list[dict[str, object]] = []
    report: dict[str, object] = {
        "status": "running",
        "started": _now(),
        "planned_jobs": list(jobs),
        "jobs": attempts,
        "device": "cuda" if cuda else "cpu",
        "v5_statuses": initial_statuses,
    }
    try:
        guard_context = _cuda_guard(root, report_dir) if cuda else nullcontext()
        with guard_context as guard:
            for name in jobs:
                statuses, blockers = _v5_state(root, v5_status_paths)
                report["v5_statuses"] = statuses
                if blockers:
                    raise SchedulerBlocked("\n".join(blockers))
                output = report_dir / name
                attempt: dict[str, object] = {"name": name, "output": str(output), "started": _now()}
                attempts.append(attempt)
                try:
                    if guard is not None:
                        guard.start_training(name)
                    attempt["result"] = dict(train_job(name, output, guard))
                    if guard is not None:
                        guard.check()
                    attempt["status"] = "completed"
                except BaseException:
                    attempt["status"] = "failed"
                    raise
                finally:
                    attempt["finished"] = _now()
        report["status"] = "completed"
    except BaseException as error:
        report["status"] = "interrupted" if isinstance(error, KeyboardInterrupt) else "failed"
        report["error"] = type(error).__name__
        report["message"] = str(error)[:500]
        raise
    finally:
        report["finished"] = _now()
        _write_report(report_dir, report)
    return report


def schedule(
    repository_root: Path,
    report_dir: Path,
    jobs: Sequence[str],
    train_job: Callable[[str, Path, TrainingGuard | None], Mapping[str, object]],
    *,
    execute: bool = False,
    wait: bool = False,
    cuda: bool = False,
    poll_seconds: float = 60,
    v5_status_paths: Sequence[Path] = (),
    ready: Callable[[], str | None] | None = None,
    on_wait: Callable[[Sequence[str]], None] | None = None,
) -> dict[str, object]:
    """Run named heads in order, under the shared lock and the existing CUDA guard.

    By default, check readiness without creating directories or touching a device.
    The callback receives a fresh output path and returns a JSON-ready report.
    """
    names = {name.casefold() for name in jobs}
    if (
        not jobs
        or len(names) != len(jobs)
        or names & _REPORT_NAMES
        or any(
            not re.fullmatch(r"[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}", name)
            or name.endswith(".")
            or PureWindowsPath(name).is_reserved()
            for name in jobs
        )
    ):
        raise ValueError("Provide distinct head names suitable for output directories.")
    if not math.isfinite(poll_seconds) or poll_seconds <= 0:
        raise ValueError("Poll interval must be positive and finite.")
    root = repository_root.resolve()
    lock = root / SHARED_GPU_LOCK
    prior_blockers: list[str] = []
    while True:
        statuses, blockers = _v5_state(root, v5_status_paths)
        for path in (lock, root / V4_GPU_LOCK) if cuda else (lock,):
            if reason := _lock_blocker(path):
                blockers.append(reason)
        if not blockers and ready is not None and (reason := ready()) is not None:
            blockers.append(reason)

        if not execute:
            return {
                "status": "blocked" if blockers else "ready",
                "dry_run": True,
                "device": "cuda" if cuda else "cpu",
                "planned_jobs": list(jobs),
                "v5_statuses": statuses,
                "blockers": blockers,
            }
        if not blockers:
            with ExitStack() as stack:
                try:
                    stack.enter_context(_shared_gpu_lock(lock))
                except SchedulerBlocked as error:
                    blockers.append(str(error))
                else:
                    statuses, blockers = _v5_state(root, v5_status_paths)
                    if not blockers and ready is not None and (reason := ready()) is not None:
                        blockers.append(reason)
                    if not blockers:
                        return _run_jobs(
                            root,
                            report_dir,
                            jobs,
                            train_job,
                            cuda=cuda,
                            v5_status_paths=v5_status_paths,
                            initial_statuses=statuses,
                        )
        if not wait:
            raise SchedulerBlocked("\n".join(blockers))
        if on_wait is not None and blockers != prior_blockers:
            on_wait(tuple(blockers))
        prior_blockers = blockers
        time.sleep(poll_seconds)
