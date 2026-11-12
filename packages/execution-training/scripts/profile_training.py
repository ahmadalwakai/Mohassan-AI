"""Opt-in later profiling through a trusted local integration adapter.

This file has not been run during implementation. Invoke from this package's
directory after Phase 2 integration and dependency verification. The adapter must
return keyword arguments accepted by execution_training.training.train.
"""
from __future__ import annotations

import argparse
import importlib
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description="Explicitly profile a bounded local training experiment.")
    parser.add_argument("--execute", action="store_true", help="Required: explicitly authorize running this local experiment.")
    parser.add_argument("--adapter", required=True, help="Trusted installed/local module:function returning train keyword arguments.")
    parser.add_argument("--steps", type=int, default=20, help="Maximum optimizer steps for this session, 1-1000.")
    args = parser.parse_args()
    if not args.execute:
        parser.error("No work performed. --execute is required; this command really trains a random-initialized model.")
    if not 1 <= args.steps <= 1000 or args.adapter.count(":") != 1:
        parser.error("Use 1-1000 steps and a module:function adapter.")
    package_root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(package_root))
    from execution_training.training import train
    from execution_training.errors import TrainingError
    module_name, function_name = args.adapter.split(":")
    # Explicit trusted code loading only; never obtained from dataset metadata.
    adapter = getattr(importlib.import_module(module_name), function_name)
    options = adapter()
    if not isinstance(options, dict) or "config" not in options or not options["config"].profile_enabled:
        raise TrainingError("PROFILING_NOT_ENABLED", "Adapter must return train options with config.profile_enabled=True.")
    if "optimizer_step_limit" in options:
        raise TrainingError("INVALID_CONFIGURATION", "Step limit is controlled by this explicit profiling command.")
    result = train(**options, optimizer_step_limit=args.steps)
    print("Profiling session status:", result["status"])
    print("See training-report.json under the adapter's explicit output_directory.")
    return 1 if result["status"] == "failed" else 0


if __name__ == "__main__":
    raise SystemExit(main())

