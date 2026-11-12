"""Versioned, pinned evaluation manifests; this module never supplies model input."""
from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from typing import Any, Iterable, Mapping
import re

from .common import digest, to_jsonable
from .schemas import EvaluationTask


MANIFEST_SCHEMA_VERSION = "execution-evaluation-manifest-v1"
PROPOSED_TARGETS = {"atomic": 200, "repository_context": 60, "end_to_end": 20}
_HASH = re.compile(r"[a-f0-9]{64}\Z")
_IDENTITY = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,199}\Z")


def _identity(value: Any, name: str) -> str:
    if not isinstance(value, str) or not _IDENTITY.fullmatch(value):
        raise ValueError(f"Invalid {name}.")
    return value


def public_input(task: EvaluationTask | Mapping[str, Any]) -> dict[str, Any]:
    """Semantic public input, excluding IDs, split labels and private oracle data.

    Exact hashing deliberately preserves Unicode, identifiers, values and whitespace.
    The budget is recorded in the evaluation configuration, not the input identity.
    """
    raw = task.public_view() if isinstance(task, EvaluationTask) else dict(task)
    names = ("input_specification", "available_context", "allowed_symbols",
             "required_capabilities", "expected_output_language", "safety_constraints")
    missing = set(names) - raw.keys()
    if missing:
        raise ValueError("Public input is incomplete: " + ", ".join(sorted(missing)))
    return to_jsonable({name: raw[name] for name in names})


def immutable_task_hash(task: EvaluationTask) -> str:
    """A stable ID may survive a dataset release, but never change its task content."""
    raw = to_jsonable(task)
    raw.pop("dataset_version", None)
    return digest(raw)


@dataclass(frozen=True)
class ManifestEntry:
    task_id: str
    task_hash: str
    immutable_task_hash: str
    public_input_hash: str
    task_family: str
    project_family: str
    template_family: str
    tier: str

    @classmethod
    def for_task(cls, task: EvaluationTask) -> "ManifestEntry":
        return cls(task.task_id, digest(task), immutable_task_hash(task), digest(public_input(task)),
                   task.task_family, task.project_family, task.template_family, task.tier)

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "ManifestEntry":
        names = set(cls.__dataclass_fields__)
        if not isinstance(raw, Mapping) or set(raw) != names:
            raise ValueError("Manifest entry fields do not match this schema version.")
        for name in ("task_id", "project_family", "template_family"):
            _identity(raw[name], name)
        for name in ("task_hash", "immutable_task_hash", "public_input_hash"):
            if not isinstance(raw[name], str) or not _HASH.fullmatch(raw[name]):
                raise ValueError(f"Invalid {name}.")
        if raw["task_family"] not in tuple("ABCDEF") or raw["tier"] not in PROPOSED_TARGETS:
            raise ValueError("Invalid task family or tier.")
        return cls(**dict(raw))


@dataclass(frozen=True)
class DatasetManifest:
    schema_version: str
    dataset_id: str
    dataset_version: str
    status: str
    entries: tuple[ManifestEntry, ...]
    targets: dict[str, int]
    provenance_reference: str
    created_at: str

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "DatasetManifest":
        if not isinstance(raw, Mapping) or set(raw) != set(cls.__dataclass_fields__):
            raise ValueError("Manifest fields do not match this schema version.")
        if raw["schema_version"] != MANIFEST_SCHEMA_VERSION:
            raise ValueError("Unsupported manifest schema version.")
        for name in ("dataset_id", "dataset_version"):
            _identity(raw[name], name)
        if raw["status"] not in {"proposed", "partial", "ready"}:
            raise ValueError("Manifest status must be proposed, partial or ready.")
        if not isinstance(raw["targets"], Mapping) or set(raw["targets"]) != set(PROPOSED_TARGETS):
            raise ValueError("All three tier targets are required.")
        if any(type(value) is not int or value < 1 for value in raw["targets"].values()):
            raise ValueError("Tier targets must be positive integers.")
        if not isinstance(raw["entries"], (list, tuple)):
            raise ValueError("Manifest entries must be a list.")
        for name in ("provenance_reference", "created_at"):
            if not isinstance(raw[name], str) or not raw[name].strip():
                raise ValueError(f"Missing {name}.")
        from datetime import datetime
        if datetime.fromisoformat(raw["created_at"].replace("Z", "+00:00")).tzinfo is None:
            raise ValueError("Manifest timestamp requires a timezone.")
        entries = tuple(ManifestEntry.from_dict(entry) for entry in raw["entries"])
        if len({entry.task_id for entry in entries}) != len(entries):
            raise ValueError("Duplicate manifest task identifiers.")
        return cls(**{**dict(raw), "entries": entries, "targets": dict(raw["targets"])})

    @property
    def manifest_hash(self) -> str:
        return digest(self)


@dataclass(frozen=True)
class ManifestVerification:
    manifest_hash: str
    verified: bool
    complete: bool
    identifiers_immutable: bool
    counts: dict[str, int]
    issues: tuple[str, ...] = ()
    missing_measurements: tuple[str, ...] = ()


def verify_manifest(
    manifest: DatasetManifest,
    tasks: Iterable[EvaluationTask],
    *,
    pinned_manifest_hash: str,
    identity_registry: Mapping[str, str] | None,
    identity_registry_reference: str | None,
) -> ManifestVerification:
    """Compare actual tasks to a separately pinned manifest and historical ID registry.

    Supplying an explicit empty registry is valid only for a custodian-approved first
    release. The reference must identify that approval. This checks content, not the
    authenticity of a custodian's assertion; store the registry outside model access.
    """
    # Revalidate direct dataclass construction, including nested mutable mappings.
    DatasetManifest.from_dict(to_jsonable(manifest))
    records = tuple(tasks)
    issues: list[str] = []
    missing: list[str] = []
    if not isinstance(pinned_manifest_hash, str) or not _HASH.fullmatch(pinned_manifest_hash):
        issues.append("PINNED_MANIFEST_HASH_INVALID")
    elif manifest.manifest_hash != pinned_manifest_hash:
        issues.append("MANIFEST_DIGEST_MISMATCH")
    by_id = {task.task_id: task for task in records}
    if len(by_id) != len(records):
        issues.append("DUPLICATE_TASK_ID")
    entries = {entry.task_id: entry for entry in manifest.entries}
    if set(by_id) != set(entries):
        issues.append("TASK_INVENTORY_MISMATCH")
    for task in records:
        if task.dataset_version != manifest.dataset_version:
            issues.append(f"TASK_VERSION_MISMATCH:{task.task_id}")
        if entries.get(task.task_id) != ManifestEntry.for_task(task):
            issues.append(f"TASK_MANIFEST_MISMATCH:{task.task_id}")
    identities_verified = identity_registry is not None and bool(identity_registry_reference)
    if not identities_verified:
        issues.append("IDENTITY_REGISTRY_UNAVAILABLE")
        missing.append("historical_identity_registry")
    else:
        assert identity_registry is not None
        if any(not isinstance(value, str) or not _HASH.fullmatch(value) for value in identity_registry.values()):
            issues.append("IDENTITY_REGISTRY_INVALID")
            identities_verified = False
        for task in records:
            previous = identity_registry.get(task.task_id)
            if previous is not None and previous != immutable_task_hash(task):
                issues.append(f"IMMUTABLE_TASK_ID_CHANGED:{task.task_id}")
                identities_verified = False
    counts = {tier: sum(task.tier == tier for task in records) for tier in PROPOSED_TARGETS}
    ready = bool(records) and all(counts[tier] >= manifest.targets[tier] for tier in PROPOSED_TARGETS)
    if manifest.status == "ready" and not ready:
        issues.append("READY_DATASET_BELOW_TARGETS")
    if not records:
        issues.append("EMPTY_DATASET")
    if manifest.status != "ready":
        missing.append("completed_dataset")
    # Duplicate public input is not additional independent evaluation evidence.
    input_counts = Counter(digest(public_input(task)) for task in records)
    if any(count > 1 for count in input_counts.values()):
        issues.append("DUPLICATE_EVALUATION_INPUT")
    return ManifestVerification(manifest.manifest_hash, not issues, ready and manifest.status == "ready" and not issues,
                                identities_verified, counts, tuple(issues), tuple(missing))


def evaluation_identity(manifest_hash: str, configuration: Mapping[str, Any], *, evaluation_version: str) -> str:
    """Content-derived immutable identity; includes budgets, adapters and seed via config."""
    if not isinstance(manifest_hash, str) or not _HASH.fullmatch(manifest_hash):
        raise ValueError("A verified manifest hash is required.")
    _identity(evaluation_version, "evaluation_version")
    return "eval-" + digest({"version": evaluation_version, "manifest_hash": manifest_hash,
                             "configuration": dict(configuration)})
