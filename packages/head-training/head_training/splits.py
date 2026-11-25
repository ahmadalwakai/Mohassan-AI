"""Partition public supervision and carry the owner's sealed-set receipt separately."""

from __future__ import annotations

import json
import os
import unicodedata
from collections import defaultdict
from collections.abc import Iterable, Mapping
from dataclasses import asdict, dataclass
from datetime import datetime
from hashlib import sha256
from pathlib import Path
from string import hexdigits

from .datasets import Example


@dataclass(frozen=True)
class SealedReference:
    path: Path
    sha256: str
    reviewer: str
    review_kind: str
    reviewed_at: str
    receipt_sha256: str
    excluded_group_sha256: frozenset[str]


@dataclass(frozen=True)
class HeadSplits:
    train: tuple[Example, ...]
    development: tuple[Example, ...]
    calibration: tuple[Example, ...]
    sealed: SealedReference | None
    fingerprints: Mapping[str, str | None]
    reserved_count: int
    duplicate_count: int


def _encode(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def valid_sha(value: object) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(char in hexdigits[:16] for char in value)
    )


def public_group_sha256(group: str) -> str:
    """Hash a public grouping key for a holdback instruction in the owner's receipt."""
    return sha256(group.encode("utf-8")).hexdigest()


def read_sealed_reference(path: Path) -> SealedReference:
    """Read the owner's JSON receipt without opening, listing, or hashing the sealed cases."""
    raw = path.read_bytes()
    receipt = json.loads(raw)
    required = {"schema_version", "path", "sha256", "reviewer", "review_kind", "reviewed_at"}
    if (
        not isinstance(receipt, dict)
        or not required <= receipt.keys()
        or set(receipt) - required - {"excluded_group_sha256"}
    ):
        raise ValueError("sealed reference must have the owner receipt fields")
    if type(receipt["schema_version"]) is not int or receipt["schema_version"] != 1:
        raise ValueError("sealed reference requires schema_version 1")
    for name in required - {"schema_version"}:
        if not isinstance(receipt[name], str) or not receipt[name].strip():
            raise ValueError(f"sealed reference requires a nonempty {name}")
    if not valid_sha(receipt["sha256"]):
        raise ValueError("sealed reference requires a lowercase SHA-256")
    if receipt["review_kind"] not in {"owner_authored", "owner_reviewed"}:
        raise ValueError("sealed reference requires owner authorship or review")
    if datetime.fromisoformat(receipt["reviewed_at"]).utcoffset() is None:
        raise ValueError("sealed reference reviewed_at requires a time zone")
    exclusions = receipt.get("excluded_group_sha256", [])
    if not isinstance(exclusions, list) or not all(map(valid_sha, exclusions)):
        raise ValueError("sealed reference exclusions must be public group SHA-256 values")
    cases_path = Path(os.path.abspath(path.parent / receipt["path"]))
    if cases_path == path.resolve():
        raise ValueError("sealed cases and their owner receipt require separate files")
    return SealedReference(
        cases_path, receipt["sha256"], receipt["reviewer"], receipt["review_kind"],
        receipt["reviewed_at"], sha256(raw).hexdigest(), frozenset(exclusions),
    )


def _normalized(text: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", text).casefold().split())


def _input_key(example: Example) -> bytes:
    return sha256(_encode([
        _normalized(example.text),
        [_normalized(turn) for turn in example.history],
        sorted(_normalized(candidate) for candidate in example.candidates),
    ])).digest()


def _order(seed: int, group: list[Example]) -> bytes:
    return sha256(_encode([seed, [[row.source, row.id] for row in group]])).digest()


def split_examples(
    examples: Iterable[Example], *, seed: int = 21, sealed: SealedReference | None = None,
) -> HeadSplits:
    """Keep upstream test, shared groups and exact model inputs out of competing splits."""
    rows = sorted(examples, key=lambda row: (row.source, row.id))
    if len({(row.source, row.id) for row in rows}) != len(rows):
        raise ValueError("example IDs must be unique within each source")
    if any(row.upstream_split not in {"train", "dev", "test", "unsplit"} for row in rows):
        raise ValueError("unsupported upstream split")
    if any(not row.group for row in rows):
        raise ValueError("every example needs a group")

    partitions: dict[str, list[list[Example]]] = {
        "train": [], "development": [], "calibration": [],
    }
    exclusions = sealed.excluded_group_sha256 if sealed else frozenset()
    sources_with_dev = {row.source for row in rows if row.upstream_split == "dev"}
    held_out: dict[tuple[str, str, str, str | None], list[list[Example]]] = defaultdict(list)
    unsplit: dict[tuple[str, str, str, str | None], list[list[Example]]] = defaultdict(list)
    grouped: dict[str, list[Example]] = defaultdict(list)
    for row in rows:
        grouped[row.group].append(row)
    reserved: list[Example] = []
    for group_key, group in grouped.items():
        if public_group_sha256(group_key) in exclusions or any(row.upstream_split == "test" for row in group):
            reserved.extend(group)
            continue
        representative = group[0]
        stratum = (representative.source, representative.language, representative.task, representative.label)
        if any(row.upstream_split == "dev" for row in group):
            held_out[stratum].append(group)
        elif any(row.source in sources_with_dev for row in group):
            partitions["train"].append(group)
        else:
            unsplit[stratum].append(group)

    for stratum, groups in held_out.items():
        offset = sha256(_encode([seed, stratum])).digest()[0]
        for index, group in enumerate(sorted(groups, key=lambda items: _order(seed, items))):
            name = ("development", "calibration")[(index + offset) % 2]
            partitions[name].append(group)
    for stratum, groups in unsplit.items():
        offset = sha256(_encode([seed, stratum])).digest()[0] % 10
        for index, group in enumerate(sorted(groups, key=lambda items: _order(seed, items))):
            bucket = (index + offset) % 10
            name = "development" if bucket == 0 else "calibration" if bucket == 1 else "train"
            partitions[name].append(group)

    # Small strata can leave a phase empty. Move whole groups from a phase with
    # capacity. Official development rows always stay in a holdout phase.
    for name, donors in (
        ("train", ("development", "calibration")),
        ("development", ("calibration", "train")),
        ("calibration", ("development", "train")),
    ):
        if partitions[name]:
            continue
        for donor in donors:
            if len(partitions[donor]) < 2:
                continue
            candidates = [
                group for group in partitions[donor]
                if name != "train" or all(row.upstream_split != "dev" for row in group)
            ]
            if candidates:
                group = min(candidates, key=lambda items: _order(seed, items))
                partitions[donor].remove(group)
                partitions[name].append(group)
                break

    # A stock utterance like "yes" can occur in every dialogue. Keep provenance
    # groups intact for assignment, then drop cross-partition copies of an input
    # instead of joining all of those dialogues into a single group.
    reserved_keys = {_input_key(row) for row in reserved}
    earlier_keys: set[bytes] = set()
    reserved_count, duplicate_count = len(reserved), 0
    result: dict[str, tuple[Example, ...]] = {}
    for name in ("calibration", "development", "train"):
        retained = []
        current_keys: set[bytes] = set()
        for group in partitions[name]:
            for row in group:
                input_key = _input_key(row)
                if input_key in reserved_keys:
                    reserved_count += 1
                elif input_key in earlier_keys:
                    duplicate_count += 1
                else:
                    current_keys.add(input_key)
                    retained.append(row)
        earlier_keys.update(current_keys)
        result[name] = tuple(sorted(retained, key=lambda row: (row.source, row.id)))
    fingerprints: dict[str, str | None] = {}
    for name, examples_in_split in result.items():
        digest = sha256()
        for row in examples_in_split:
            digest.update(_encode(asdict(row)) + b"\n")
        fingerprints[name] = digest.hexdigest()
    fingerprints["sealed"] = sealed.sha256 if sealed else None
    return HeadSplits(
        result["train"], result["development"], result["calibration"], sealed,
        fingerprints, reserved_count, duplicate_count,
    )
