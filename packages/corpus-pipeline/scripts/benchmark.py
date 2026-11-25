"""Run the corpus CLI on deterministic, algorithmically assembled text on Linux."""

from __future__ import annotations

import argparse
from collections.abc import Iterable
from datetime import UTC, datetime
from hashlib import file_digest
from itertools import chain, islice, product
import json
from pathlib import Path
import platform
import random
import subprocess
import sys
from time import perf_counter


PACKAGE = Path(__file__).resolve().parents[1]
MIB = 1 << 20
SEED = 34821
EVALUATION_TEXT = (
    "When silver bells announce the winter market, seven dancers step onto the wooden "
    "platform and raise their bright lanterns before the opening song."
)
PHRASES = {
    "en": (
        ("the gardener", "the courier", "the clerk", "the tailor", "the cook", "the apprentice",
         "the painter", "the librarian", "the builder", "the visitor", "the engineer", "the guide"),
        ("placed", "checked", "collected", "arranged", "inspected", "wrapped",
         "cleaned", "counted", "sorted", "photographed", "examined", "found"),
        ("a small lantern", "a stack of letters", "several folding chairs", "a striped blanket",
         "an empty basket", "a few wooden boxes", "a bundle of rope", "the blue notebooks",
         "some ceramic bottles", "the brass hooks", "a set of tools", "a pile of books"),
        ("after the rain", "before evening", "beside the door", "under the shelter",
         "near the windows", "during the morning", "in the hallway", "by the courtyard",
         "along the wall", "inside the workshop", "on the upper floor", "before the break"),
    ),
    "ar": (
        ("البستاني", "المعلم", "المصور", "المتدرب", "الخباز", "المهندس",
         "الرسام", "الجار", "النجار", "الزائر", "المشرف", "عامل المكتبة"),
        ("وضع", "فحص", "جمع", "رتب", "راقب", "حمل", "نظف",
         "عد", "فرز", "صور", "راجع", "وجد"),
        ("مصباحا صغيرا", "مجموعة رسائل", "بعض الكراسي", "رداء مخططا",
         "سلة فارغة", "صناديق خشبية", "حزمة حبال", "الدفاتر الزرقاء",
         "أواني خزف", "مفاتيح نحاسية", "أدوات يدوية", "كومة كتب"),
        ("بعد المطر", "قبل المساء", "بجوار الباب", "تحت المظلة",
         "قرب النوافذ", "عند الصباح", "في الممر", "بجانب الفناء",
         "على طول الجدار", "داخل الورشة", "في الطابق العلوي", "قبل الاستراحة"),
    ),
}


def sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return file_digest(stream, "sha256").hexdigest()


def write_json(path: Path, value: object) -> None:
    with path.open("x", encoding="utf-8", newline="\n") as stream:
        stream.write(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def write_rows(
    path: Path,
    texts: Iterable[str],
    *,
    minimum_bytes: int | None = None,
) -> tuple[int, int]:
    text_bytes = 0
    count = 0
    with path.open("x", encoding="utf-8", newline="\n") as stream:
        for count, text in enumerate(texts, start=1):
            stream.write(json.dumps({"id": str(count), "text": text}, ensure_ascii=False) + "\n")
            text_bytes += len(text.encode("utf-8"))
            if minimum_bytes is not None and text_bytes >= minimum_bytes:
                break
    return text_bytes, count


def documents(language: str, rng: random.Random) -> Iterable[str]:
    sentences = []
    for subject, verb, item, place in product(*PHRASES[language]):
        if language == "en":
            sentences.append(f"{subject.capitalize()} {verb} {item} {place}.")
        else:
            sentences.append(f"{verb} {subject} {item} {place}.")
    while True:
        yield " ".join(rng.sample(sentences, 32))


def write_source(
    directory: Path,
    source_id: str,
    split: str,
    texts: Iterable[str],
    *,
    language: str | None = None,
    minimum_bytes: int | None = None,
) -> tuple[dict[str, str], int, int]:
    data = directory / f"{source_id}.jsonl"
    card = directory / f"{source_id}.card.json"
    text_bytes, count = write_rows(data, texts, minimum_bytes=minimum_bytes)
    write_json(card, {
        "source": "Deterministic scripts/benchmark.py fixture",
        "license": "CC0-1.0",
        "sha256": sha256(data),
        "download_date": "2026-11-25",
        "consent": "No people or personal data; benchmark fixture only.",
        "origin": "synthetic_fixture",
    })
    source = {"id": source_id, "path": data.name, "card": card.name, "split": split, "kind": "text"}
    if language is not None:
        source["language"] = language
    return source, text_bytes, count


def generate_config(directory: Path, minimum_bytes: int) -> tuple[Path, dict]:
    rng = random.Random(SEED)
    sources = []
    text_bytes = {}
    rows = {}
    for language in PHRASES:
        prose = documents(language, rng)
        for split, count in (("train", 12), ("development", 12), ("calibration", 8)):
            source_id = f"{language}-{split}-sample"
            source, text_bytes[source_id], rows[source_id] = write_source(
                directory, source_id, split, islice(prose, count), language=language,
            )
            sources.append(source)

        source_id = f"{language}-train-bulk"
        texts = chain((EVALUATION_TEXT,), prose) if language == "en" else prose
        source, text_bytes[source_id], rows[source_id] = write_source(
            directory, source_id, "train", texts, minimum_bytes=minimum_bytes // 2,
        )
        sources.append(source)

    evaluation = directory / "frozen-evaluation.jsonl"
    write_rows(evaluation, [EVALUATION_TEXT])
    config = directory / "config.json"
    write_json(config, {
        "fixture_mode": True,
        "sources": sources,
        "frozen_evaluations": [{"path": evaluation.name, "sha256": sha256(evaluation)}],
    })
    stats = {"text_bytes_by_source": text_bytes, "rows_by_source": rows,
             "total_text_bytes": sum(text_bytes.values())}
    return config, stats


def cpu_model() -> str:
    for line in Path("/proc/cpuinfo").read_text(encoding="utf-8").splitlines():
        key, _, value = line.partition(":")
        if key.strip() == "model name":
            return value.strip()
    return platform.machine()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work-dir", type=Path, required=True, help="new directory for inputs and raw results")
    parser.add_argument("--text-mib", type=int, default=100, help="minimum total UTF-8 text MiB")
    args = parser.parse_args()
    if sys.platform != "linux":
        parser.error("peak RSS measurement requires Linux")
    if args.text_mib < 1:
        parser.error("--text-mib must be at least 1")
    import resource

    directory = args.work_dir.resolve()
    directory.mkdir()
    config, stats = generate_config(directory, args.text_mib * MIB)
    output = directory / "cleaned"
    stdout_path = directory / "stdout.log"
    stderr_path = directory / "stderr.log"
    command = [sys.executable, "-m", "corpus_pipeline", "run", "--config", str(config), "--output", str(output)]
    with stdout_path.open("xb") as stdout, stderr_path.open("xb") as stderr:
        started_at = datetime.now(UTC)
        started_timer = perf_counter()
        completed = subprocess.run(command, cwd=PACKAGE, stdout=stdout, stderr=stderr, check=False)
        wall_seconds = perf_counter() - started_timer
        finished_at = datetime.now(UTC)
    usage = resource.getrusage(resource.RUSAGE_CHILDREN)
    fingerprints = {name: sha256(directory / name) for name in ("config.json", "stdout.log", "stderr.log")}
    if (output / "manifest.json").is_file():
        fingerprints["cleaned/manifest.json"] = sha256(output / "manifest.json")
    report = {
        "benchmark_command": [sys.executable, *sys.argv],
        "command": command,
        "command_cwd": str(PACKAGE),
        "started_at": started_at.isoformat(),
        "finished_at": finished_at.isoformat(),
        "python": platform.python_version(),
        "cpu_model": cpu_model(),
        "seed": SEED,
        "input": stats,
        "wall_seconds": round(wall_seconds, 3),
        "cpu_seconds": round(usage.ru_utime + usage.ru_stime, 3),
        "peak_rss_bytes": usage.ru_maxrss * 1024,
        "exit_status": completed.returncode,
        "raw_output_directory": str(directory),
        "sha256": fingerprints,
    }
    write_json(directory / "benchmark.json", report)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return completed.returncode


if __name__ == "__main__":
    raise SystemExit(main())
