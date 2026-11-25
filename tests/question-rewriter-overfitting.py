"""Check feature sources for capability v2 case text without printing case text."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import runpy
import subprocess


BASELINE = "c2a0ff765071657cf200b5ee7d12fabaad738c0b"
REPO = Path(__file__).resolve().parents[1]
BENCHMARK_PATHS = ("scripts/agent-capability-bench/", "tests/fixtures/agent-capability-bench/")


def git(repo: Path, *args: str) -> bytes:
    return subprocess.check_output(("git", "-C", str(repo), *args))


def source_paths(repo: Path) -> set[Path]:
    # Identical files can only have inherited occurrences. Track additions,
    # including untracked files, and treat copies and renames as new paths.
    changed = git(repo, "diff", "--no-renames", "--name-only", "-z", BASELINE, "--")
    untracked = git(repo, "ls-files", "--others", "--exclude-standard", "-z")
    return {
        Path(path) for path in (changed + untracked).decode("utf-8").split("\0")
        if path and not path.startswith(BENCHMARK_PATHS)
        and (repo / path).is_file() and not (repo / path).is_symlink()
    }


def literal_spellings(text: str) -> set[bytes]:
    variants = {text, text.replace("\n", "\r\n")}
    for ensure_ascii in (False, True):
        escaped = json.dumps(text, ensure_ascii=ensure_ascii)[1:-1]
        variants.add(escaped)
        single_or_template = escaped.replace(r'\"', '"')
        variants.add(single_or_template.replace("'", r"\'"))
        variants.add(single_or_template.replace("`", r"\`"))
    # A one-word utterance is a case literal when used on its own. A matching
    # word inside an identifier, sentence, or vocabulary regex is ordinary text.
    if text.isalnum():
        variants = {
            opening + variant + closing for opening, closing
            in (('"', '"'), ("'", "'"), ("`", "`"), ("\n", "\n"), ("\r\n", "\r\n"))
            for variant in variants
        }
    return {variant.encode("utf-8") for variant in variants if variant}


def check_sources(repo: Path, rendered: set[bytes]) -> list[tuple[Path, int]]:
    paths = source_paths(repo)
    inherited = {
        Path(path) for path in git(repo, "ls-tree", "-r", "--name-only", "-z", BASELINE).decode("utf-8").split("\0")
        if path
    }
    violations = []
    for path in sorted(paths):
        current = (repo / path).read_bytes()
        hits = [(pattern, current.count(pattern)) for pattern in rendered if pattern in current]
        if not hits:
            continue
        previous = git(repo, "show", f"{BASELINE}:{path.as_posix()}") if path in inherited else b""
        added = sum(count > previous.count(pattern) for pattern, count in hits)
        if added:
            violations.append((path, added))
    return violations


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--benchmark-checkout", type=Path, default=REPO)
    parser.add_argument("--development-only", action="store_true", help="Keep the sealed payload closed.")
    args = parser.parse_args()
    bench = args.benchmark_checkout.resolve()
    exclusion = runpy.run_path(str(bench / "scripts/agent-capability-bench/v2/exclusion.py"))
    partitions = ("dev",) if args.development_only else ("dev", "sealed")
    release = exclusion["read_benchmark"](bench, partitions=partitions)
    rendered = {
        spelling for cases in release.values() for case in cases
        for text in exclusion["benchmark_texts"](case) for spelling in literal_spellings(text)
    }
    violations = check_sources(REPO, rendered)
    for path, count in violations:
        print(f"{path}: {count} newly introduced capability v2 literal spelling(s)")
    if violations:
        raise SystemExit(1)
    print(f"No new capability v2 case text across {', '.join(partitions)}.")


if __name__ == "__main__":
    main()
