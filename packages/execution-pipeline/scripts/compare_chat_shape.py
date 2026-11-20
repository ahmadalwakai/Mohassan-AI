"""Prepare, check, run and report the paired 85M Stage 2 comparison."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from execution_pipeline.shape_comparison import assessment, check, execute, prepare


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("prepare", "check", "run", "report"))
    parser.add_argument("--config-sha256")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--max-minutes", type=float,
                        help="Save an optimizer checkpoint and exit after this interval; resume the same run afterwards.")
    args = parser.parse_args()
    if args.action == "prepare":
        result = prepare()
    else:
        if not args.config_sha256:
            parser.error("check/run/report require --config-sha256")
        if args.action == "check":
            config, _, _, _, _ = check(args.config_sha256)
            result = {"passed": True, "config_sha256": args.config_sha256,
                      "parameters": config["parameters"], "identical_38m_sampling_receipt": True, "gpu_started": False}
        elif args.action == "report":
            result = assessment(args.config_sha256)
        else:
            result = execute(args.config_sha256, resume=args.resume, max_minutes=args.max_minutes)
    print(json.dumps(result, indent=2, ensure_ascii=False))
