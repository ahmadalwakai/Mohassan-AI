"""Check for copied v2 prompts in the product checkout.

Run the full check from the frozen scratch merge. During development use
--development-only so the sealed payload stays closed.
"""
import argparse
from hashlib import sha256
import json
import os
from pathlib import Path
import subprocess
import sys


BASELINE = "c2a0ff765071657cf200b5ee7d12fabaad738c0b"
BENCHMARK_FILES = frozenset({
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
})


def source_paths(root):
    paths = subprocess.check_output(
        ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        cwd=root,
    )
    for name in sorted(set(os.fsdecode(paths).split("\0")) - {""}):
        if name not in BENCHMARK_FILES and not name.startswith((
            "scripts/agent-capability-bench/",
            "tests/fixtures/agent-capability-bench/",
            "tests/agent-capability-",
        )):
            yield name


def representations(text):
    yield text.encode("utf-8")
    for ensure_ascii in (False, True):
        yield json.dumps(text, ensure_ascii=ensure_ascii)[1:-1].encode("utf-8")


def audit(root, needles):
    inherited = []
    added = []
    file_count = 0
    for name in source_paths(root):
        path = root / name
        if path.is_symlink():
            content = os.fsencode(os.readlink(path))
        elif path.is_file():
            content = path.read_bytes()
        else:
            continue
        file_count += 1
        matches = [needle for needle in needles if needle in content]
        if not matches:
            continue
        base = subprocess.run(
            ["git", "cat-file", "blob", f"{BASELINE}:{name}"],
            cwd=root, capture_output=True, check=False,
        )
        for needle in matches:
            original = base.stdout.count(needle) if base.returncode == 0 else 0
            current = content.count(needle)
            fingerprint = sha256(needle).hexdigest()
            if original:
                inherited.append((name, fingerprint))
            if current > original:
                added.append((name, fingerprint, current - original))
    return file_count, inherited, added


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, default=Path.cwd())
    parser.add_argument("--benchmark-root", type=Path)
    parser.add_argument("--development-only", action="store_true")
    parser.add_argument("--allow-baseline-matches", action="store_true")
    options = parser.parse_args()
    benchmark_root = (options.benchmark_root or options.source_root).resolve()
    sys.path.insert(0, str(benchmark_root / "scripts/agent-capability-bench/v2"))
    from exclusion import benchmark_texts, read_benchmark

    partitions = ("dev",) if options.development_only else ("dev", "sealed")
    bundles = read_benchmark(benchmark_root, partitions=partitions)
    needles = frozenset(
        needle
        for cases in bundles.values()
        for case in cases
        for text in benchmark_texts(case)
        for needle in representations(text)
    )
    file_count, inherited, added = audit(options.source_root.resolve(), needles)
    print(json.dumps({
        "cases": {partition: len(cases) for partition, cases in bundles.items()},
        "files": file_count,
        "preexisting_matches": len(inherited),
        "new_matches": added,
        "strict_passed": not (added or inherited),
    }, sort_keys=True))
    return int(bool(added or (inherited and not options.allow_baseline_matches)))


if __name__ == "__main__":
    raise SystemExit(main())
