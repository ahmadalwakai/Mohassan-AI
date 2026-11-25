#!/usr/bin/env python3
"""Fetch pinned public corpora and map eligible human-labelled rows to the four heads."""

import argparse
import csv
import hashlib
import io
import json
import shutil
import tarfile
import tempfile
import unicodedata
import urllib.request
import zipfile
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path

from training.features import normalize

DATA_DIR = Path(__file__).resolve().with_name("data")
SEED = 20261125
SPLIT_PRIORITY = {name: index for index, name in enumerate(("train", "dev", "calibration", "test"))}
STOP_WORDS = frozenset("a an the this that these those and or so of to by in at for on as it is was were be are do did does had has have he she they them him her his their its you what how which where when who why".split())


@dataclass(frozen=True)
class Example:
    dataset: str
    split: str
    text: str
    labels: dict[str, str]
    previous: str | None = None

    def as_json(self) -> dict:
        result = {"dataset": self.dataset, "split": self.split, "text": self.text, "labels": self.labels}
        if self.previous is not None:
            result["previous"] = self.previous
        return result


def pin_source(cache: Path, name: str, metadata: dict) -> Path:
    target = cache / name
    if target.is_file():
        with target.open("rb") as stream:
            verified = hashlib.file_digest(stream, "sha256").hexdigest() == metadata["sha256"]
        if verified:
            return target
        raise ValueError(f"SHA-256 mismatch for cached source {target}; remove it and retry")

    request = urllib.request.Request(metadata["url"], headers={"User-Agent": "Mohassan-scratch-classifiers/1.0"})
    with tempfile.NamedTemporaryFile(dir=cache, delete=False) as temporary:
        downloaded = Path(temporary.name)
    try:
        with urllib.request.urlopen(request, timeout=90) as response, downloaded.open("wb") as stream:
            shutil.copyfileobj(response, stream)
        with downloaded.open("rb") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() != metadata["sha256"]:
                raise ValueError(f"SHA-256 mismatch for downloaded source {name}")
        downloaded.replace(target)
    finally:
        downloaded.unlink(missing_ok=True)
    return target


def bucket(seed: int, dataset: str, group: str) -> int:
    digest = hashlib.sha256(f"{seed}:{dataset}:{group}".encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big") % 100


def official_split(name: str, seed: int, dataset: str, group: str) -> str:
    if name == "dev":
        return "dev" if bucket(seed, dataset, group) < 50 else "calibration"
    return name


def text_tokens(text: str) -> tuple[str, ...]:
    folded = unicodedata.normalize("NFKC", text).casefold()
    return tuple("".join(char if char.isalnum() else " " for char in folded).split())


def source_mapping(raw_mapping: dict, name: str) -> dict[str, dict[str, str]]:
    result = {}
    for entry in raw_mapping[name]:
        for source in entry["source"]:
            if source in result:
                raise ValueError(f"Duplicate label mapping for {name}/{source}")
            result[source] = entry["labels"]
    return result


def clinc_rows(path: Path, mapping: dict, seed: int):
    data = json.loads(path.read_text(encoding="utf-8"))
    labels_by_intent = source_mapping(mapping, "clinc150")
    for name in ("train", "val", "test"):
        for text, intent in data[name] + data[f"oos_{name}"]:
            if intent in labels_by_intent:
                key = " ".join(text_tokens(text))
                split = official_split("dev" if name == "val" else name, seed, "clinc150", key)
                yield Example("clinc150", split, text, labels_by_intent[intent])


def massive_rows(path: Path, mapping: dict, seed: int):
    labels_by_intent = source_mapping(mapping, "massive")
    excluded = set(mapping["massiveExcludedIds"])
    with tarfile.open(path, "r:gz") as archive:
        # Stream the archive once because the release includes 49 unused locales.
        for member in archive:
            locale = Path(member.name).stem
            if member.name not in ("1.0/data/ar-SA.jsonl", "1.0/data/en-US.jsonl"):
                continue
            with archive.extractfile(member) as lines:
                rows = [json.loads(line) for line in lines]
            dev_groups = defaultdict(set)
            for row in rows:
                if row["partition"] == "dev" and row["id"] not in excluded:
                    dev_groups[row["intent"]].add(row["id"])
            # Stratify by upstream intent so even the two greeting groups represent both folds.
            calibration_ids = set()
            for groups in dev_groups.values():
                ordered = sorted(groups, key=lambda group: (bucket(seed, "massive", group), group))
                calibration_ids.update(ordered[1::2])
            for row in rows:
                intent = row["intent"]
                if intent in labels_by_intent and row["id"] not in excluded:
                    split = "calibration" if row["id"] in calibration_ids else row["partition"]
                    yield Example(f"massive-{locale}", split, row["utt"], labels_by_intent[intent])


def canard_rows(path: Path, seed: int):
    with zipfile.ZipFile(path) as archive:
        for name in ("train", "dev", "test"):
            with archive.open(f"CANARD_Release/{name}.json") as stream:
                for row in json.load(stream):
                    history = row["History"]
                    if len(history) < 4:
                        continue
                    # CANARD prepends document and section titles, then alternates question and answer.
                    # Use the last available question as the input, and the rewrite only to derive the label.
                    previous = history[-2]
                    original = text_tokens(row["Question"])
                    rewrite = text_tokens(row["Rewrite"])
                    if original == rewrite:
                        label = "new"
                    else:
                        added = set(rewrite) - set(original) - STOP_WORDS
                        history_words = set(text_tokens(" ".join(history)))
                        if not added & history_words:
                            continue
                        label = "follow_up"
                    split = official_split(name, seed, "canard", row["QuAC_dialog_id"])
                    yield Example("canard", split, row["Question"], {"followUp": label}, previous)


def dialect_rows(path: Path, mapping: dict, seed: int):
    labels_by_intent = source_mapping(mapping, "arbanking77")
    partitions = {"Tr": "train", "D": "dev", "Te": "test"}
    with path.open(encoding="utf-8-sig", newline="") as stream:
        for row in csv.DictReader(stream):
            intent = row["Intent_en"]
            if intent not in labels_by_intent or None in row:
                continue
            variants = []
            for column in ("PAL1", "PAL2"):
                identifier = row[f"QuestionID_{column}"]
                text = row[f"Question_{column}"]
                if identifier and identifier != "NULL" and text and text != "NULL":
                    prefix = identifier.rstrip("0123456789")
                    if prefix in partitions and prefix != identifier:
                        variants.append((partitions[prefix], text))
            if variants:
                strongest = max((name for name, _ in variants), key=SPLIT_PRIORITY.__getitem__)
                split = official_split(strongest, seed, "arbanking77", row["QID"])
                for name, text in variants:
                    if name == strongest:
                        yield Example("arbanking77-pal", split, text, labels_by_intent[intent])


def red_teaming_rows(path: Path, mapping: dict, seed: int, locale: str):
    harms = set(mapping["ayaGlobalHarm"])
    with path.open(encoding="utf-8") as stream:
        for line in stream:
            row = json.loads(line)
            categories = set(json.loads(row["harm_category"]))
            if row["global_or_local"] != "global" or "Self-Harm" in categories or not categories & harms:
                continue
            text = row["prompt"]
            index = bucket(seed, "aya-redteaming", " ".join(text_tokens(text)))
            split = "train" if index < 70 else "dev" if index < 80 else "calibration" if index < 90 else "test"
            yield Example(f"aya-{locale}", split, text, {"refusal": "refuse"})


def example_key(example: Example) -> tuple[tuple[str, ...], tuple[str, ...]]:
    return text_tokens(normalize(example.text)), text_tokens(normalize(example.previous or ""))


def deduplicate(rows: list[Example]):
    """Prevent identical text/context from leaking across splits and omit conflicting labels."""
    strongest_split = {}
    observed_labels = {}
    for row in rows:
        key = example_key(row)
        strongest_split[key] = max(strongest_split.get(key, -1), SPLIT_PRIORITY[row.split])
        for head, label in row.labels.items():
            observed_labels.setdefault((key, head), set()).add(label)

    seen = set()
    for row in rows:
        key = example_key(row)
        if not key[0] or SPLIT_PRIORITY[row.split] != strongest_split[key]:
            continue
        labels = {}
        for head, label in row.labels.items():
            occurrence = row.dataset, key, head
            if occurrence not in seen and len(observed_labels[key, head]) == 1:
                labels[head] = label
                seen.add(occurrence)
        if labels:
            yield Example(row.dataset, row.split, row.text, labels, row.previous)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path, help="Output JSONL path")
    parser.add_argument("--cache", type=Path, help="Download cache (default: sources beside the output)")
    parser.add_argument("--seed", type=int, default=SEED)
    args = parser.parse_args()
    cache = args.cache or args.output.parent / "sources"
    cache.mkdir(parents=True, exist_ok=True)
    with (DATA_DIR / "sources.json").open(encoding="utf-8") as stream:
        sources = {name: pin_source(cache, name, metadata) for name, metadata in json.load(stream).items()}
    with (DATA_DIR / "label-map.json").open(encoding="utf-8") as stream:
        mapping = json.load(stream)

    rows = list(clinc_rows(sources["clinc150.json"], mapping, args.seed))
    rows.extend(massive_rows(sources["massive.tar.gz"], mapping, args.seed))
    rows.extend(canard_rows(sources["canard.zip"], args.seed))
    rows.extend(dialect_rows(sources["arbanking77.csv"], mapping, args.seed))
    rows.extend(red_teaming_rows(sources["aya-arb.jsonl"], mapping, args.seed, "arb"))
    rows.extend(red_teaming_rows(sources["aya-eng.jsonl"], mapping, args.seed, "eng"))

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=args.output.parent, encoding="utf-8", mode="w", newline="\n", delete=False) as stream:
        temporary = Path(stream.name)
        try:
            counts = Counter()
            for row in deduplicate(rows):
                stream.write(json.dumps(row.as_json(), ensure_ascii=False, sort_keys=True) + "\n")
                counts[row.dataset, row.split] += 1
        except BaseException:
            stream.close()
            temporary.unlink(missing_ok=True)
            raise
    temporary.replace(args.output)
    for dataset in sorted({dataset for dataset, _ in counts}):
        counts_text = " ".join(f"{split}={counts[dataset, split]}" for split in SPLIT_PRIORITY)
        print(f"{dataset} {counts_text}")


if __name__ == "__main__":
    main()
