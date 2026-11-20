"""Prepare/check/run guarded Stage 5 answer-only training; no gate bypasses."""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from execution_pipeline.stage5_finetune import check, prepare, run


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest="action", required=True)
    prep = actions.add_parser("prepare")
    for name in ("run", "base-checkpoint", "campaign", "dataset-dir", "gate3", "gate4", "eligibility"):
        prep.add_argument(f"--{name}", type=Path, required=True)
    for name in ("base-sha256", "out-name", "gate3-sha256", "gate4-sha256", "eligibility-sha256"):
        prep.add_argument(f"--{name}", required=True)
    prep.add_argument("--qa", nargs=2, action="append", required=True, metavar=("PATH", "SHA256"))
    for action in ("check", "run"):
        command = actions.add_parser(action)
        command.add_argument("--protocol", type=Path, required=True)
        command.add_argument("--protocol-sha256", required=True)
    args = vars(parser.parse_args())
    action = args.pop("action")
    if action == "prepare":
        args["qa"] = [(Path(path), digest) for path, digest in args["qa"]]
        result = prepare(**args)
    elif action == "check":
        protocol = check(args["protocol"], args["protocol_sha256"])
        result = {"status": "verified", "parameters": protocol["parameters"], "gpu_started": False}
    else:
        result = run(args["protocol"], args["protocol_sha256"])
    print(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
