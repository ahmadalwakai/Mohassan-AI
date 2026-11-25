"""Owner PC entry point. Scheduling defaults to a read-only dry run."""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Callable, Sequence
from dataclasses import asdict
from pathlib import Path

from . import REPOSITORY_ROOT
from .config import Pin, PublicSource, digest, load_config
from .datasets import CATALOG, load_dataset
from .foundation import foundation_blocker, sha256_file
from .scheduler import SchedulerBlocked, TrainingGuard, schedule


def main(argv: Sequence[str] | None = None, *, root: Path = REPOSITORY_ROOT) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    runner = commands.add_parser("schedule", help="Check v5 readiness or train the configured heads in order.")
    runner.add_argument("--config", required=True, type=Path)
    runner.add_argument("--output", required=True, type=Path, help="Fresh directory for local run outputs.")
    runner.add_argument("--execute", action="store_true", help="Opt in to acquiring the lock and training.")
    runner.add_argument("--no-wait", action="store_true", help="Exit immediately if v5 or the GPU blocks execution.")
    runner.add_argument("--poll-seconds", default=60, type=float)
    commands.add_parser("catalog", help="Print the public dataset cards without downloading files.")
    downloader = commands.add_parser("prefetch", help="Download and verify public sources on demand, without using CUDA.")
    downloader.add_argument("--config", required=True, type=Path)
    handoff = commands.add_parser("register-gate", help="Prepare a packet from an existing fitted head.")
    handoff.add_argument("--config", required=True, type=Path)
    handoff.add_argument("--job", required=True)
    handoff.add_argument("--manifest", required=True, type=Path)
    handoff.add_argument("--manifest-sha256", required=True)
    handoff.add_argument("--output", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        if args.action == "catalog":
            print(json.dumps({name: asdict(card) for name, card in CATALOG.items()}, ensure_ascii=False, indent=2))
            return 0
        config_path = args.config.resolve()
        config_pin = Pin(config_path, sha256_file(config_path))
        settings = load_config(config_path, root)
        if sha256_file(config_path) != config_pin.sha256:
            raise ValueError("The schedule configuration changed during reading.")
        if args.action == "prefetch":
            sources = {(source.name, source.task) for job in settings.jobs for source in job.sources
                       if isinstance(source, PublicSource)}
            for name, task in sorted(sources):
                dataset = load_dataset(name, task, settings.dataset_cache)
                print(json.dumps({"dataset": name, "task": task, "examples": len(dataset.examples),
                                  "fingerprint": dataset.fingerprint}, ensure_ascii=False))
            return 0
        command = [sys.executable, *sys.argv] if argv is None else [sys.executable, sys.argv[0], *argv]

        if args.action == "register-gate":
            from .workflow import register_trained_head

            job = next((job for job in settings.jobs if job.name == args.job), None)
            if job is None:
                raise ValueError(f"Unknown job {args.job!r}.")
            pin = Pin(args.manifest.resolve(), digest(args.manifest_sha256))
            registration = register_trained_head(job, pin, args.output.resolve(), command)
            print(registration)
            return 0

        fit: Callable[[str, Path, TrainingGuard | None], dict[str, object]] | None = None

        def callback(name: str, output: Path, guard: TrainingGuard | None) -> dict[str, object]:
            nonlocal fit
            if fit is None:
                from .workflow import job_callback

                fit = job_callback(settings, root, config_pin, command)
            print(f"Training {name}", file=sys.stderr)
            return fit(name, output, guard)

        result = schedule(
            root, args.output.resolve(), [job.name for job in settings.jobs], callback,
            execute=args.execute, wait=args.execute and not args.no_wait, cuda=settings.device == "cuda",
            poll_seconds=args.poll_seconds, v5_status_paths=settings.v5_status_paths,
            ready=(lambda: foundation_blocker(root)) if settings.trunk is None else None,
            on_wait=lambda blockers: print("\n".join(blockers), file=sys.stderr),
        )
        print(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False))
        return 2 if result["status"] == "blocked" else 0
    except (OSError, ValueError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        return 2 if isinstance(error, SchedulerBlocked) else 1


if __name__ == "__main__":
    raise SystemExit(main())
