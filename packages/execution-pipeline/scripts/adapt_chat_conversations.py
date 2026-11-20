"""Prepare, check, resume and export all-token Stage 4 conversational adaptation."""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from execution_pipeline.conversation_adaptation import check, execute, export, prepare

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("action", choices=("prepare", "check", "run", "export"))
for name in ("foundation-run", "checkpoint", "corpus", "dataset-dir", "gate3", "eligibility", "campaign", "run", "protocol"):
    parser.add_argument(f"--{name}", type=Path)
for name in ("checkpoint-sha256", "gate3-sha256", "eligibility-sha256", "protocol-sha256"):
    parser.add_argument(f"--{name}")
parser.add_argument("--qa", nargs=2, action="append", metavar=("PATH", "SHA256"), default=[])
parser.add_argument("--resume", action="store_true")
parser.add_argument("--smoke", action="store_true")
args = parser.parse_args()
if args.action == "prepare":
    required = ("foundation_run", "checkpoint", "checkpoint_sha256", "corpus", "dataset_dir", "gate3",
                "gate3_sha256", "eligibility", "eligibility_sha256", "campaign", "run")
    if any(getattr(args, name) is None for name in required) or not args.qa:
        parser.error("prepare requires all source paths, SHA-256 values and --qa PATH SHA256")
    result = prepare(**{name: getattr(args, name) for name in required},
                     qa_pins=[{"path": str(Path(path).resolve()), "sha256": digest} for path, digest in args.qa])
else:
    if not args.protocol or not args.protocol_sha256:
        parser.error("check/run/export require --protocol and --protocol-sha256")
    if args.action == "check":
        config = check(args.protocol, args.protocol_sha256)
        result = {"passed": True, "target_positions": config["target_positions"], "gpu_started": False}
    elif args.action == "export":
        result = export(check(args.protocol, args.protocol_sha256), args.protocol_sha256)
    else:
        result = execute(args.protocol, args.protocol_sha256, resume=args.resume, smoke=args.smoke)
print(json.dumps(result, ensure_ascii=False, indent=2))
