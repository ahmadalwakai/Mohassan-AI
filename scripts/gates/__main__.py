"""Command line for offline Mohassan evaluations."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .common import GateVoid, mark_void
from .evidence import pack, record_results
from .registration import seal, start
from .reporting import decide_run, override, submit


def parser() -> argparse.ArgumentParser:
    cli = argparse.ArgumentParser(description=__doc__)
    commands = cli.add_subparsers(dest="action", required=True)

    register = commands.add_parser("seal", help="Seal a pre-registration before collecting results.")
    register.add_argument("registration", type=Path)

    begin = commands.add_parser("start", help="Authorize a run and reserve a frozen case-set use.")
    begin.add_argument("registration", type=Path)
    begin.add_argument("run", type=Path)
    begin.add_argument("--who", required=True)
    begin.add_argument("--why", required=True)

    record = commands.add_parser("record", help="Bind offline predictions and producer provenance to a run.")
    record.add_argument("run", type=Path)
    record.add_argument("--role", choices=("candidate", "baseline"), required=True)
    record.add_argument("--provenance", type=Path, required=True)
    record.add_argument("--native-manifest", type=Path)

    packet = commands.add_parser("pack", help="Build the blind judge sheet from the recorded evidence.")
    packet.add_argument("run", type=Path)

    judge = commands.add_parser("submit", help="Capture a judge's complete blind verdict sheet.")
    judge.add_argument("run", type=Path)
    judge.add_argument("verdict", type=Path)

    report = commands.add_parser("decide", help="Apply the sealed rule and write a decision report.")
    report.add_argument("run", type=Path)
    report.add_argument("--previous", type=Path)

    owner = commands.add_parser("override", help="Record an owner's decision alongside a report.")
    owner.add_argument("run", type=Path)
    owner.add_argument("report", type=Path)
    owner.add_argument("--decision", choices=("pass", "stop", "inconclusive"), required=True)
    owner.add_argument("--owner", required=True)
    owner.add_argument("--rule", required=True)
    owner.add_argument("--words-file", type=Path, required=True)
    owner.add_argument("--output", type=Path, required=True)
    return cli


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    args = parser().parse_args(argv)
    command = [sys.executable, "-m", "scripts.gates", *argv]
    try:
        if args.action == "seal":
            output = seal(args.registration, command)
        elif args.action == "start":
            output = start(args.registration, args.run, args.who, args.why, command)
        elif args.action == "record":
            output = record_results(args.run, args.role, args.provenance, args.native_manifest, command)
        elif args.action == "pack":
            output = pack(args.run, command)
        elif args.action == "submit":
            output = submit(args.run, args.verdict, command)
        elif args.action == "decide":
            output = decide_run(args.run, args.previous, command)
        else:
            output = override(args.run, args.report, args.decision, args.owner, args.rule,
                              args.words_file, args.output, command)
    except GateVoid as error:
        if args.action not in ("seal", "start"):
            try:
                mark_void(args.run.resolve() / "void.json", str(error), command)
            except OSError as marker_error:
                print(f"Gate error: unable to persist invalidation: {marker_error}", file=sys.stderr)
        print(f"Gate error: {error}", file=sys.stderr)
        return 2
    except (OSError, ValueError) as error:
        print(f"Gate error: {error}", file=sys.stderr)
        return 2
    except (KeyError, TypeError):
        print("Gate error: malformed run record.", file=sys.stderr)
        return 2
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
