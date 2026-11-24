"""Prepare, check, run or smoke-test V5-3 answer-only chat fine-tuning (plan v5, section 8.4); no gate bypasses."""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from execution_pipeline.v5_finetune import check, prepare, run, smoke  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest="action", required=True)
    prep = actions.add_parser("prepare")
    for name in ("run", "base-checkpoint", "campaign", "dataset-dir", "gate3", "eligibility"):
        prep.add_argument(f"--{name}", type=Path, required=True)
    for name in ("base-sha256", "out-name", "gate3-sha256", "eligibility-sha256"):
        prep.add_argument(f"--{name}", required=True)
    prep.add_argument("--qa", nargs=2, action="append", required=True, metavar=("PATH", "SHA256"))
    for action in ("check", "run"):
        command = actions.add_parser(action)
        command.add_argument("--protocol", type=Path, required=True)
        command.add_argument("--protocol-sha256", required=True)
    test = actions.add_parser("smoke", help="Two CPU updates on a few rows; unlocks nothing")
    for name in ("run", "base-checkpoint", "dataset-dir"):
        test.add_argument(f"--{name}", type=Path, required=True)
    args = vars(parser.parse_args())
    action = args.pop("action")
    if action == "prepare":
        args["qa"] = [(Path(path), digest) for path, digest in args["qa"]]
        result = prepare(**args)
    elif action == "check":
        protocol = check(args["protocol"], args["protocol_sha256"])
        result = {"status": "verified", "parameters": protocol["parameters"], "gpu_started": False}
    elif action == "smoke":
        result = smoke(**args)
    else:
        result = run(args["protocol"], args["protocol_sha256"])
    print(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
