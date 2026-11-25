"""Parse an owner PC schedule without loading PyTorch or any dataset."""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, cast

from .datasets import CATALOG

HeadKind = Literal["classification", "pairwise", "selection"]
TASK_KINDS: dict[str, tuple[HeadKind, ...]] = {
    "intent": ("classification",),
    "route": ("classification",),
    "out_of_scope": ("classification",),
    "turn_type": ("classification",),
    "rewrite": ("selection", "pairwise"),
    "sentence_selection": ("selection", "pairwise"),
    "sufficiency": ("classification",),
    "speech_act": ("classification",),
    "slots": ("selection",),
    "retrieval": ("selection", "pairwise"),
    "ads_pointer": ("selection",),
}


@dataclass(frozen=True)
class Pin:
    path: Path
    sha256: str


@dataclass(frozen=True)
class TrunkPins:
    checkpoint: Pin
    tokenizer: Pin
    tokenizer_report: Pin | None


@dataclass(frozen=True)
class PublicSource:
    name: str
    task: str
    label_map: dict[str, str | None] | None = None


@dataclass(frozen=True)
class OwnerSource:
    path: Pin
    card: Pin


@dataclass(frozen=True)
class GateConfig:
    sealed_reference: Path
    baseline: Pin
    rule: dict[str, Any]
    max_ece: float | None


@dataclass(frozen=True)
class CorpusLineage:
    checkout: Path
    manifest: Path
    review: Path


@dataclass(frozen=True)
class Job:
    name: str
    task: str
    kind: HeadKind
    sources: tuple[PublicSource | OwnerSource, ...]
    labels: tuple[str, ...] | None
    training: dict[str, Any]
    max_tokens: int
    lora_rank: int
    lora_budget: int
    min_calibration_accuracy: float
    calibration_bins: int
    gate: GateConfig | None


@dataclass(frozen=True)
class ScheduleConfig:
    trunk: TrunkPins | None
    dataset_cache: Path
    device: Literal["cpu", "cuda"]
    jobs: tuple[Job, ...]
    v5_status_paths: tuple[Path, ...]
    corpus_lineage: CorpusLineage | None


def obj(value: object, description: str) -> dict[str, Any]:
    if not isinstance(value, dict) or any(not isinstance(key, str) for key in value):
        raise ValueError(f"{description} must be a JSON object.")
    return value


def strings(value: object, description: str) -> tuple[str, ...]:
    if not isinstance(value, list):
        raise ValueError(f"{description} must be a JSON array of strings.")
    return tuple(nonempty(item, description) for item in value)


def nonempty(value: object, description: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{description} must be a nonempty string.")
    return value


def digest(value: object) -> str:
    value = nonempty(value, "sha256")
    if re.fullmatch(r"[0-9a-f]{64}", value) is None:
        raise ValueError("sha256 must be 64 lowercase hexadecimal digits.")
    return value


def integer(value: object, description: str, minimum: int) -> int:
    if type(value) is not int or value < minimum:
        raise ValueError(f"{description} must be an integer of at least {minimum}.")
    return value


def number(value: object, description: str, minimum: float, maximum: float) -> float:
    if (type(value) not in (int, float) or not isinstance(value, (int, float))
            or not math.isfinite(value) or not minimum <= value <= maximum):
        raise ValueError(f"{description} must be between {minimum} and {maximum}.")
    return float(value)


def checked_keys(mapping: dict[str, Any], keys: set[str], description: str) -> None:
    if unexpected := mapping.keys() - keys:
        raise ValueError(f"Unknown {description} fields: {', '.join(sorted(unexpected))}.")


def _path(base: Path, value: object) -> Path:
    return (base / nonempty(value, "path")).resolve()


def _pin(base: Path, value: object) -> Pin:
    record = obj(value, "pin")
    checked_keys(record, {"path", "sha256"}, "pin")
    return Pin(_path(base, record.get("path")), digest(record.get("sha256")))


def _trunk(base: Path, value: object) -> TrunkPins | None:
    if value == "v5-foundation":
        return None
    record = obj(value, "trunk")
    checked_keys(record, {"checkpoint", "tokenizer", "tokenizer_report"}, "trunk")
    tokenizer = _pin(base, record.get("tokenizer"))
    report = _pin(base, record["tokenizer_report"]) if "tokenizer_report" in record else None
    if report is not None and report.path != tokenizer.path.with_name("tokenizer-report.json"):
        raise ValueError("tokenizer_report must pin tokenizer-report.json beside tokenizer.json.")
    return TrunkPins(_pin(base, record.get("checkpoint")), tokenizer, report)


def _source(base: Path, value: object, task: str, kind: HeadKind) -> PublicSource | OwnerSource:
    record = obj(value, "source")
    if "labelled" in record:
        checked_keys(record, {"labelled", "card"}, "owner source")
        return OwnerSource(_pin(base, record["labelled"]), _pin(base, record.get("card")))
    checked_keys(record, {"dataset", "task", "label_map"}, "public source")
    name = nonempty(record.get("dataset"), "dataset")
    source_task = nonempty(record.get("task", task), "source task")
    if name not in CATALOG or source_task not in CATALOG[name].tasks:
        raise ValueError(f"Dataset {name!r} does not supply {source_task!r}.")
    source_map = None
    if "label_map" in record:
        if kind != "classification":
            raise ValueError("Only classification jobs have label maps.")
        source_map = {
            key: None if label is None else nonempty(label, "target label")
            for key, label in obj(record["label_map"], "label_map").items()
        }
        if not source_map:
            raise ValueError("An explicit label map must contain at least one source label.")
    if source_task != task and (source_task != "intent" or task != "route" or source_map is None):
        raise ValueError("A source task can differ only when an explicit intent-to-route map is supplied.")
    return PublicSource(name, source_task, source_map)


def _training(value: object) -> dict[str, Any]:
    fields = obj(value, "training")
    steps = {"epochs", "batch_size", "accumulation", "patience"}
    checked_keys(fields, steps | {"seed", "learning_rate", "mixed_precision"}, "training")
    settings: dict[str, Any] = {key: integer(fields[key], key, 1) for key in steps & fields.keys()}
    if "seed" in fields:
        settings["seed"] = integer(fields["seed"], "seed", 0)
        if settings["seed"] >= 2**32:
            raise ValueError("seed must fit in an unsigned 32-bit integer.")
    if "learning_rate" in fields:
        settings["learning_rate"] = number(fields["learning_rate"], "learning_rate", 1e-12, 1)
    if "mixed_precision" in fields:
        if type(fields["mixed_precision"]) is not bool:
            raise ValueError("mixed_precision must be a boolean.")
        settings["mixed_precision"] = fields["mixed_precision"]
    return settings


def _job(base: Path, value: object) -> Job:
    record = obj(value, "job")
    checked_keys(record, {"name", "task", "kind", "sources", "labels", "training", "max_tokens", "lora_rank",
                          "lora_budget", "min_calibration_accuracy", "calibration_bins", "gate"}, "job")
    name = nonempty(record.get("name"), "job name")
    if re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}", name) is None or name.lower() in {
        "con", "prn", "aux", "nul", *(f"{prefix}{i}" for prefix in ("com", "lpt") for i in range(1, 10))
    }:
        raise ValueError(f"Invalid Windows-compatible job name {name!r}.")
    task = nonempty(record.get("task"), "task")
    if task not in TASK_KINDS:
        raise ValueError(f"Unknown head task {task!r}.")
    raw_kind = record.get("kind", TASK_KINDS[task][0])
    if raw_kind not in TASK_KINDS[task]:
        raise ValueError(f"Invalid architecture for {task!r}.")
    kind = cast(HeadKind, raw_kind)
    sources = record.get("sources")
    if not isinstance(sources, list) or not sources:
        raise ValueError(f"Job {name!r} needs at least one labelled source.")
    labels = strings(record["labels"], "labels") if "labels" in record else None
    if labels is not None and (kind != "classification" or len(set(labels)) != len(labels) or len(labels) < 2):
        raise ValueError("Explicit labels must contain at least two distinct classification labels.")
    gate = None
    if "gate" in record:
        item = obj(record["gate"], "gate")
        checked_keys(item, {"sealed_reference", "baseline", "rule", "max_ece"}, "gate")
        gate = GateConfig(_path(base, item.get("sealed_reference")), _pin(base, item.get("baseline")),
                          obj(item.get("rule", {}), "gate rule"),
                          number(item["max_ece"], "max_ece", 0, 1) if "max_ece" in item else None)
    return Job(
        name, task, kind, tuple(_source(base, source, task, kind) for source in sources), labels,
        _training(record.get("training", {})), integer(record.get("max_tokens", 512), "max_tokens", 8),
        integer(record.get("lora_rank", 0), "lora_rank", 0),
        integer(record.get("lora_budget", 600_000), "lora_budget", 0),
        number(record.get("min_calibration_accuracy", 0.9), "min_calibration_accuracy", 0, 1),
        integer(record.get("calibration_bins", 15), "calibration_bins", 2), gate,
    )


def load_config(path: Path, repository_root: Path) -> ScheduleConfig:
    record = obj(json.loads(path.read_text(encoding="utf-8")), "schedule")
    checked_keys(record, {"trunk", "device", "dataset_cache", "jobs", "v5_status_paths", "corpus_lineage"}, "schedule")
    base = path.resolve().parent
    device = record.get("device", "cuda")
    if device not in ("cpu", "cuda"):
        raise ValueError("device must be cpu or cuda.")
    values = record.get("jobs")
    if not isinstance(values, list) or not 1 <= len(values) <= 32:
        raise ValueError("A schedule needs 1–32 jobs.")
    jobs = tuple(_job(base, value) for value in values)
    if len({job.name.lower() for job in jobs}) != len(jobs):
        raise ValueError("The schedule contains duplicate job names.")
    lineage = None
    if "corpus_lineage" in record:
        item = obj(record["corpus_lineage"], "corpus_lineage")
        checked_keys(item, {"checkout", "manifest", "review"}, "corpus_lineage")
        lineage = CorpusLineage(*(_path(base, item.get(field)) for field in ("checkout", "manifest", "review")))
    return ScheduleConfig(
        _trunk(base, record.get("trunk", "v5-foundation")),
        _path(base, record.get("dataset_cache", str(repository_root / ".data/head-training/datasets"))), device, jobs,
        tuple(_path(base, p) for p in strings(record.get("v5_status_paths", []), "v5_status_paths")), lineage,
    )
