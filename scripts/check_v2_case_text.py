"""Check a v2 scratch merge for new benchmark text in repository source."""

from __future__ import annotations

from collections import Counter
from hashlib import sha256
import json
import os
from pathlib import Path
import stat
import subprocess
import sys


BASELINE = "c2a0ff765071657cf200b5ee7d12fabaad738c0b"
BENCHMARK_DIRECTORIES = ("scripts/agent-capability-bench/", "tests/fixtures/agent-capability-bench/")
BENCHMARK_FILES = {
    "docs/AGENT-ROOT-AUDIT-2026-11-25.md",
    "docs/AGENT-ROOT-AUDIT-2026-11-25.results.json",
    "docs/CAPABILITY-BENCH-V2-2026-11-25.md",
    "docs/CAPABILITY-BENCH-V2-DATA.md",
    "docs/CAPABILITY-BENCH-V2-DEV.md",
    "docs/V2-CONTAMINATION-AUDIT-2026-11-25.md",
    "tests/test_v2_contamination.py",
    "tests/test_v2_contamination_score.py",
    "tests/test_v2_exclusion.py",
    "tests/test_v2_training_exclusion_integration.py",
    "tests/test_v2_training_rows.py",
}


def git(repo: Path, *args: str) -> bytes:
    return subprocess.run(
        ["git", *args], cwd=repo, capture_output=True, check=True,
    ).stdout


def paths(output: bytes) -> set[str]:
    return {os.fsdecode(name) for name in output.split(b"\0") if name}


def source_text(data: bytes) -> str:
    if b"\0" in data:
        return ""
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return ""


def literal_forms(text: str) -> set[str]:
    forms = {text}
    for ascii_only in (False, True):
        escaped = json.dumps(text, ensure_ascii=ascii_only)[1:-1]
        forms.add(escaped)
        unquoted = escaped.replace('\\"', '"')
        forms.add(unquoted.replace("'", "\\'"))
        forms.add(unquoted.replace("`", "\\`").replace("${", "\\${"))
    return forms


def containing_lines(source: str, needle: str) -> Counter[str]:
    """Count exact occurrences by the full lines containing each match."""
    counts: Counter[str] = Counter()
    start = source.find(needle)
    while start != -1:
        first = source.rfind("\n", 0, start) + 1
        last = source.find("\n", start + len(needle))
        counts[source[first:] if last == -1 else source[first:last]] += 1
        start = source.find(needle, start + 1)
    return counts


def find_new_case_text(
    repo: Path, case_texts: dict[str, set[str]], baseline: str = BASELINE,
) -> list[tuple[str, str, str]]:
    base_paths = paths(git(repo, "ls-tree", "-r", "--name-only", "-z", baseline))
    changed = paths(git(repo, "diff", "--no-renames", "--name-only", "--diff-filter=ACMRTUXB", "-z", baseline, "--"))
    untracked = paths(git(repo, "ls-files", "--others", "--exclude-standard", "-z"))
    patterns = [
        (partition, sha256(text.encode("utf-8")).hexdigest(), literal_forms(text))
        for partition, texts in case_texts.items() for text in texts if text.strip()
    ]
    hits = []
    for filename in sorted(changed | untracked):
        if (filename in BENCHMARK_FILES or filename.startswith(BENCHMARK_DIRECTORIES)
                or filename.startswith("tests/agent-capability-")):
            continue
        file = repo / filename
        if not stat.S_ISREG(file.lstat().st_mode):
            continue
        current = source_text(file.read_bytes())
        if not current:
            continue
        previous = source_text(git(repo, "show", f"{baseline}:{filename}")) if filename in base_paths else ""
        for partition, digest, forms in patterns:
            for form in forms:
                if form in current and containing_lines(current, form) - containing_lines(previous, form):
                    hits.append((filename, partition, digest))
                    break
    return sorted(hits)


def main() -> int:
    repo = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(repo / "scripts/agent-capability-bench/v2"))
    try:
        from exclusion import benchmark_texts, read_benchmark

        partitions = read_benchmark(repo)
    except (ImportError, OSError, ValueError, KeyError):
        print("The source check requires both verified v2 bundles in a scratch merge.", file=sys.stderr)
        return 1
    case_texts = {split: {text for case in cases for text in benchmark_texts(case)} for split, cases in partitions.items()}
    hits = find_new_case_text(repo, case_texts)
    for filename, partition, digest in hits:
        print(f"New v2 case text in {filename} ({partition}, SHA-256 {digest})", file=sys.stderr)
    if hits:
        return 1
    print("No new development or sealed v2 case text outside the benchmark.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
