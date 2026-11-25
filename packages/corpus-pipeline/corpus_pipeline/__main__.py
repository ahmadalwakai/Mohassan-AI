"""Command-line entry point for corpus-pipeline."""

import argparse
from pathlib import Path
import sys

from .inputs import load_config
from .pipeline import run_pipeline
from .review import verify_review


def main(argv: list[str] | None = None) -> int:
    arguments = sys.argv[1:] if argv is None else argv
    parser = argparse.ArgumentParser(prog="python -m corpus_pipeline")
    commands = parser.add_subparsers(dest="command", required=True)
    run = commands.add_parser("run", help="clean a corpus and write audit artifacts")
    run.add_argument("--config", required=True, type=Path)
    run.add_argument("--output", required=True, type=Path)
    run.add_argument("--dry-run", action="store_true", help="print the manifest without writing any outputs")
    verify = commands.add_parser("verify", help="check an approved production corpus before training")
    verify.add_argument("--manifest", required=True, type=Path)
    verify.add_argument("--review", required=True, type=Path)
    args = parser.parse_args(arguments)
    try:
        if args.command == "verify":
            print(verify_review(args.manifest, args.review))
        else:
            data = run_pipeline(
                load_config(args.config), args.output, dry_run=args.dry_run,
                command=[sys.executable, "-m", "corpus_pipeline", *arguments],
            )
            if args.dry_run:
                sys.stdout.buffer.write(data)
            else:
                print(args.output.resolve() / "manifest.json")
    except (OSError, ValueError) as exc:
        print(f"corpus-pipeline: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
