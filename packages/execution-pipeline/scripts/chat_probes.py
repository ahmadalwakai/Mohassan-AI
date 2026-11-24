"""Prepare, check, or generate greedy replies to the frozen v5 chat probes on the CPU."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from execution_pipeline.chat_probes import check, predict, prepare  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest="action", required=True)
    preparation = actions.add_parser("prepare", help="Write an immutable protocol; loads no model")
    preparation.add_argument("--run", required=True, type=Path)
    preparation.add_argument("--finetune", required=True)
    preparation.add_argument("--checkpoint-sha256", required=True)
    preparation.add_argument("--output", required=True, type=Path)
    for action in ("check", "predict"):
        command = actions.add_parser(action)
        command.add_argument("--protocol", required=True, type=Path)
        command.add_argument("--protocol-sha256", required=True)
    args = parser.parse_args()
    if args.action == "prepare":
        result = prepare(args.run, args.finetune, args.checkpoint_sha256, args.output)
    elif args.action == "check":
        protocol = check(args.protocol, args.protocol_sha256)
        result = {"status": "verified", "counts": protocol["counts"], "decoding": protocol["decoding"],
                  "checkpoint_sha256": protocol["checkpoint"]["sha256"], "gpu_used": False}
    else:
        result = predict(args.protocol, args.protocol_sha256)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
