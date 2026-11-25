"""Read the native monitor negative and reminder proxy sets after v2 exclusions."""

import hashlib
import json
import tarfile
from collections.abc import Collection, Iterator
from dataclasses import dataclass
from pathlib import Path

from data_guard import ContaminationGuard
from prepare_data import DATA_DIR


SOURCE_NAMES = ("clinc150.json", "massive.tar.gz")
MASSIVE_LOCALES = {"ar-SA": "ar", "en-US": "en"}


@dataclass(frozen=True)
class Row:
    dataset: str
    language: str
    partition: str
    text: str
    intent: str
    family: str
    source_id: str


def pins() -> dict:
    metadata = json.loads((DATA_DIR / "sources.json").read_bytes())
    return {name: metadata[name] for name in SOURCE_NAMES}


def verified_sources(cache: Path) -> dict[str, Path]:
    """Verify cached sources only. Downloads belong to setup."""
    paths = {}
    for name, metadata in pins().items():
        path = cache / name
        with path.open("rb") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() != metadata["sha256"]:
                raise ValueError(f"SHA-256 mismatch for cached source {path}")
        paths[name] = path
    return paths


def _clinc_rows(path: Path, guard: ContaminationGuard, splits: Collection[str]) -> Iterator[Row]:
    data = json.loads(path.read_bytes())
    for partition, examples in data.items():
        if partition.removeprefix("oos_") not in splits:
            continue
        for index, (text, intent) in enumerate(examples):
            source_id = f"clinc150:{partition}:{index}"
            if not guard.blocks("clinc150", partition, text, source_id):
                # The pinned CLINC file contains intent names and no separate scenario column.
                family = intent.removesuffix("_update") if intent in {"calendar_update", "reminder_update"} else intent
                yield Row("clinc150", "en", partition, text, intent, family, source_id)


def _massive_rows(path: Path, guard: ContaminationGuard, splits: Collection[str]) -> Iterator[Row]:
    members = {f"1.0/data/{locale}.jsonl": locale for locale in MASSIVE_LOCALES}
    with tarfile.open(path, "r:gz") as archive:
        for member in archive:
            locale = members.get(member.name)
            if locale is None:
                continue
            dataset = f"massive-{locale}"
            with archive.extractfile(member) as stream:
                for line in stream:
                    item = json.loads(line)
                    partition, text = item["partition"], item["utt"]
                    source_id = f"massive:{locale}:{item['id']}"
                    if partition in splits and not guard.blocks(dataset, partition, text, source_id):
                        yield Row(dataset, MASSIVE_LOCALES[locale], partition, text, item["intent"], item["scenario"], source_id)


def rows(cache: Path, guard: ContaminationGuard, splits: Collection[str]) -> Iterator[Row]:
    """Preserve native splits, intent annotations and source IDs for audit and training."""
    paths = verified_sources(cache)
    yield from _clinc_rows(paths["clinc150.json"], guard, splits)
    yield from _massive_rows(paths["massive.tar.gz"], guard, splits)


def decision(row: Row) -> str | None:
    """Weak labels for public training rows, separate from real feedback labels."""
    if row.dataset == "clinc150":
        # reminder_update includes both timed and condition-triggered reminders in the source.
        if row.intent == "reminder_update":
            return None
        if row.intent in {"reminder", "alarm", "timer"}:
            return "reminder"
    elif row.intent == "alarm_set":
        return "reminder"
    return "none"
