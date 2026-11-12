"""Immutable, deterministic family-group splits; no row-random splitting."""
from __future__ import annotations

from dataclasses import dataclass
import math
from pathlib import Path
from typing import Iterable, Mapping, Any

from .common import atomic_json, digest, read_json
from .deduplication import canonical_sample_hash, family_keys
from .errors import TrainingError
from .schemas import TrainingExample

SPLIT_SCHEMA_VERSION = "execution-split-v1"
SPLITS = ("train", "validation", "test")


def _validate_parameters(dataset_version: str, seed: int, ratios: tuple[float, float, float]) -> None:
    if type(dataset_version) is not str or not dataset_version.strip() or type(seed) is not int:
        raise TrainingError("INVALID_SPLIT_CONFIG", "Dataset version and integer seed are required.")
    if len(ratios) != 3 or any(type(value) not in (float, int) or not math.isfinite(value) or value <= 0 for value in ratios):
        raise TrainingError("INVALID_SPLIT_CONFIG", "Train/validation/test ratios must all be positive finite numbers.")
    if not math.isclose(sum(ratios), 1.0, rel_tol=0, abs_tol=1e-9):
        raise TrainingError("INVALID_SPLIT_CONFIG", "Split ratios must sum to one.")


def _valid_family(key: str) -> bool:
    return type(key) is str and any(key.startswith(prefix) and len(key) > len(prefix) for prefix in ("project:", "template:"))


class _Groups:
    def __init__(self):
        self.parents: dict[str, str] = {}

    def find(self, key: str) -> str:
        self.parents.setdefault(key, key)
        root = key
        while self.parents[root] != root:
            root = self.parents[root]
        while self.parents[key] != key:
            parent = self.parents[key]
            self.parents[key] = root
            key = parent
        return root

    def join(self, left: str, right: str) -> None:
        a, b = self.find(left), self.find(right)
        if a != b:
            first, second = sorted((a, b))
            self.parents[second] = first

    def components(self) -> dict[str, tuple[str, ...]]:
        grouped: dict[str, list[str]] = {}
        for key in sorted(self.parents):
            grouped.setdefault(self.find(key), []).append(key)
        return {digest(["family-group-v1", members]): tuple(members) for members in grouped.values()}


def _assign(group_id: str, dataset_version: str, seed: int, ratios: tuple[float, float, float]) -> str:
    value = int(digest(["split-assignment-v1", dataset_version, seed, group_id]), 16) / (1 << 256)
    return "train" if value < ratios[0] else "validation" if value < ratios[0] + ratios[1] else "test"


@dataclass(frozen=True)
class FamilyReservation:
    dataset_version: str
    seed: int
    ratios: tuple[float, float, float]
    groups: dict[str, tuple[str, ...]]
    assignments: dict[str, str]

    @property
    def identity(self) -> str:
        return digest(self.to_dict())

    def to_dict(self) -> dict:
        return {
            "schema_version": "execution-family-reservation-v1",
            "dataset_version": self.dataset_version, "seed": self.seed,
            "ratios": list(self.ratios),
            "groups": {key: list(value) for key, value in sorted(self.groups.items())},
            "assignments": dict(sorted(self.assignments.items())),
        }

    def write(self, path: str | Path) -> None:
        atomic_json(Path(path), self.to_dict(), immutable=True)

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "FamilyReservation":
        keys = {"schema_version", "dataset_version", "seed", "ratios", "groups", "assignments"}
        if not isinstance(raw, Mapping) or set(raw) != keys or raw["schema_version"] != "execution-family-reservation-v1":
            raise TrainingError("INVALID_SPLIT_MANIFEST", "Family reservation schema is invalid.")
        if not isinstance(raw["ratios"], (list, tuple)) or not isinstance(raw["groups"], Mapping) or not isinstance(raw["assignments"], Mapping):
            raise TrainingError("INVALID_SPLIT_MANIFEST", "Family reservation field types are invalid.")
        ratios = tuple(raw["ratios"])
        _validate_parameters(raw["dataset_version"], raw["seed"], ratios)
        groups: dict[str, tuple[str, ...]] = {}
        seen: set[str] = set()
        for group_id, values in raw["groups"].items():
            if not isinstance(values, (list, tuple)) or not values or any(not _valid_family(value) for value in values):
                raise TrainingError("INVALID_SPLIT_MANIFEST", "Reserved family names are invalid.")
            members = tuple(sorted(values))
            if len(set(members)) != len(members) or seen.intersection(members) or group_id != digest(["family-group-v1", list(members)]):
                raise TrainingError("INVALID_SPLIT_MANIFEST", "Reserved group identity is invalid or overlaps another group.")
            groups[group_id] = members
            seen.update(members)
        assignments = dict(raw["assignments"])
        if set(assignments) != seen or any(value not in SPLITS for value in assignments.values()):
            raise TrainingError("INVALID_SPLIT_MANIFEST", "Every reserved family must have one valid split.")
        if any(len({assignments[key] for key in members}) != 1 for members in groups.values()):
            raise TrainingError("SPLIT_LEAKAGE", "A reserved group spans multiple splits.")
        return cls(raw["dataset_version"], raw["seed"], ratios, groups, assignments)


def reserve_families(
    families: Iterable[tuple[str, str]], *, dataset_version: str, seed: int = 17,
    ratios: tuple[float, float, float] = (0.8, 0.1, 0.1),
    explicit_assignments: Mapping[str, str] | None = None,
) -> FamilyReservation:
    """Reserve (project_family, template_family) pairs BEFORE generating variants.

    Explicit assignments use namespaced family keys. Conflicting reservations
    fail rather than moving a held-out family into training. Ratios are expected
    proportions across independent groups, not guaranteed per-row proportions.
    """
    _validate_parameters(dataset_version, seed, ratios)
    graph = _Groups()
    for project, template in families:
        if type(project) is not str or not project or type(template) is not str or not template:
            raise TrainingError("INVALID_FAMILY", "Nonempty project and template families are required.")
        graph.join("project:" + project, "template:" + template)
    groups = graph.components()
    if not groups:
        raise TrainingError("EMPTY_DATASET", "At least one family must be reserved.")
    overrides = dict(explicit_assignments or {})
    if set(overrides) - set(graph.parents) or any(value not in SPLITS for value in overrides.values()):
        raise TrainingError("INVALID_SPLIT_CONFIG", "Explicit reservations must reference declared families and valid splits.")
    assignments: dict[str, str] = {}
    for group_id, members in groups.items():
        requested = {overrides[key] for key in members if key in overrides}
        if len(requested) > 1:
            raise TrainingError("SPLIT_LEAKAGE", "Connected families have conflicting reserved splits.")
        split = next(iter(requested)) if requested else _assign(group_id, dataset_version, seed, ratios)
        assignments.update({key: split for key in members})
    return FamilyReservation(dataset_version, seed, ratios, groups, assignments)


@dataclass(frozen=True)
class SplitManifest:
    dataset_version: str
    seed: int
    ratios: tuple[float, float, float]
    assignments: dict[str, str]
    sample_hashes: dict[str, str]
    sample_groups: dict[str, str]
    groups: dict[str, tuple[str, ...]]
    group_assignments: dict[str, str]
    reserved_families: dict[str, str]
    family_links: tuple[tuple[str, str], ...]
    near_duplicate_pairs: tuple[tuple[str, str], ...]

    @property
    def identity(self) -> str:
        return digest(self._payload())

    @property
    def held_out_group_ids(self) -> tuple[str, ...]:
        return tuple(sorted(key for key, value in self.group_assignments.items() if value != "train"))

    def ids_for(self, split: str) -> tuple[str, ...]:
        if split not in SPLITS:
            raise TrainingError("INVALID_SPLIT", "Split must be train, validation or test.")
        return tuple(sorted(key for key, value in self.assignments.items() if value == split))

    def _payload(self) -> dict:
        return {
            "schema_version": SPLIT_SCHEMA_VERSION,
            "dataset_version": self.dataset_version, "seed": self.seed,
            "ratios": list(self.ratios),
            "assignments": dict(sorted(self.assignments.items())),
            "sample_hashes": dict(sorted(self.sample_hashes.items())),
            "sample_groups": dict(sorted(self.sample_groups.items())),
            "groups": {key: list(value) for key, value in sorted(self.groups.items())},
            "group_assignments": dict(sorted(self.group_assignments.items())),
            "reserved_families": dict(sorted(self.reserved_families.items())),
            "family_links": [list(pair) for pair in self.family_links],
            "near_duplicate_pairs": [list(pair) for pair in self.near_duplicate_pairs],
            "held_out_group_ids": list(self.held_out_group_ids),
        }

    def to_dict(self) -> dict:
        return {**self._payload(), "manifest_id": self.identity}

    def write(self, path: str | Path) -> None:
        """Never replace an existing dataset-version manifest with different data."""
        atomic_json(Path(path), self.to_dict(), immutable=True)

    @classmethod
    def load(cls, path: str | Path) -> "SplitManifest":
        return cls.from_dict(read_json(Path(path)))

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "SplitManifest":
        keys = {
            "schema_version", "dataset_version", "seed", "ratios", "assignments",
            "sample_hashes", "sample_groups", "groups", "group_assignments",
            "reserved_families", "family_links", "near_duplicate_pairs",
            "held_out_group_ids", "manifest_id",
        }
        if not isinstance(raw, Mapping) or set(raw) != keys or raw["schema_version"] != SPLIT_SCHEMA_VERSION:
            raise TrainingError("INVALID_SPLIT_MANIFEST", "Split manifest schema is invalid.")
        if type(raw["manifest_id"]) is not str or raw["manifest_id"] != digest({key: value for key, value in raw.items() if key != "manifest_id"}):
            raise TrainingError("INVALID_SPLIT_MANIFEST", "Split manifest digest does not match its contents.")
        mapping_keys = ("assignments", "sample_hashes", "sample_groups", "groups", "group_assignments", "reserved_families")
        if any(not isinstance(raw[key], Mapping) for key in mapping_keys) or not isinstance(raw["ratios"], (list, tuple)):
            raise TrainingError("INVALID_SPLIT_MANIFEST", "Split manifest field types are invalid.")
        _validate_parameters(raw["dataset_version"], raw["seed"], tuple(raw["ratios"]))
        groups: dict[str, tuple[str, ...]] = {}
        seen: set[str] = set()
        for group_id, members in raw["groups"].items():
            if not isinstance(members, (list, tuple)) or not members or any(not _valid_family(value) for value in members):
                raise TrainingError("INVALID_SPLIT_MANIFEST", "Group families are invalid.")
            if list(members) != sorted(set(members)) or seen.intersection(members) or group_id != digest(["family-group-v1", list(members)]):
                raise TrainingError("INVALID_SPLIT_MANIFEST", "Group families overlap or their identity changed.")
            seen.update(members)
            groups[group_id] = tuple(members)
        assignments = dict(raw["assignments"])
        if not assignments or set(assignments) != set(raw["sample_hashes"]) or set(assignments) != set(raw["sample_groups"]):
            raise TrainingError("INVALID_SPLIT_MANIFEST", "Sample membership fields must match and be nonempty.")
        if any(type(key) is not str or not key or value not in SPLITS for key, value in assignments.items()):
            raise TrainingError("INVALID_SPLIT_MANIFEST", "Sample split assignments are invalid.")
        if any(type(value) is not str or len(value) != 64 or any(ch not in "0123456789abcdef" for ch in value) for value in raw["sample_hashes"].values()):
            raise TrainingError("INVALID_SPLIT_MANIFEST", "Sample hashes must be lowercase SHA-256 digests.")
        group_assignments = dict(raw["group_assignments"])
        if set(group_assignments) != set(groups) or any(value not in SPLITS for value in group_assignments.values()):
            raise TrainingError("INVALID_SPLIT_MANIFEST", "Group split assignments are invalid.")
        for sample_id, group_id in raw["sample_groups"].items():
            if type(group_id) is not str or group_id not in groups or assignments[sample_id] != group_assignments[group_id]:
                raise TrainingError("SPLIT_LEAKAGE", "Sample and family-group splits disagree.")
        reservations = dict(raw["reserved_families"])
        if set(reservations) - seen or any(value not in SPLITS for value in reservations.values()):
            raise TrainingError("INVALID_SPLIT_MANIFEST", "Reserved family assignments are invalid.")
        for group_id, members in groups.items():
            if any(key in reservations and reservations[key] != group_assignments[group_id] for key in members):
                raise TrainingError("SPLIT_LEAKAGE", "A frozen family reservation changed its split.")
        def pairs(key: str, allowed: set[str]) -> tuple[tuple[str, str], ...]:
            value = raw[key]
            if not isinstance(value, (list, tuple)):
                raise TrainingError("INVALID_SPLIT_MANIFEST", "Grouping links must be arrays.")
            result: list[tuple[str, str]] = []
            for pair in value:
                if not isinstance(pair, (list, tuple)) or len(pair) != 2 or any(type(item) is not str or item not in allowed for item in pair):
                    raise TrainingError("INVALID_SPLIT_MANIFEST", "A grouping link references an unknown member.")
                result.append(tuple(pair))
            return tuple(result)
        manifest = cls(raw["dataset_version"], raw["seed"], tuple(raw["ratios"]), assignments,
                       dict(raw["sample_hashes"]), dict(raw["sample_groups"]), groups,
                       group_assignments, reservations, pairs("family_links", seen),
                       pairs("near_duplicate_pairs", set(assignments)))
        if raw["held_out_group_ids"] != list(manifest.held_out_group_ids) or manifest.identity != raw["manifest_id"]:
            raise TrainingError("INVALID_SPLIT_MANIFEST", "Held-out identities or canonical ordering changed.")
        return manifest

    def validate_examples(self, examples: Iterable[TrainingExample]) -> None:
        """Rebuild all grouping decisions and bind every full record to its hash."""
        records = tuple(examples)
        rebuilt = create_split_manifest(records, dataset_version=self.dataset_version,
            seed=self.seed, ratios=self.ratios, reserved_families=self.reserved_families or None,
            family_links=self.family_links, near_duplicate_pairs=self.near_duplicate_pairs)
        if rebuilt.identity != self.identity:
            raise TrainingError("DATASET_MANIFEST_CHANGED", "Dataset contents, provenance, grouping or assignments differ from the frozen manifest.")


def create_split_manifest(
    examples: Iterable[TrainingExample], *, dataset_version: str, seed: int = 17,
    ratios: tuple[float, float, float] = (0.8, 0.1, 0.1),
    reserved_families: Mapping[str, str] | FamilyReservation | None = None,
    near_duplicate_pairs: Iterable[tuple[str, str]] = (),
    family_links: Iterable[tuple[str, str]] = (),
) -> SplitManifest:
    """Join project, template, exact duplicate and near-duplicate relationships.

    Every connected component receives one split. A newly discovered link across
    frozen split boundaries is a hard error. A version manifest cannot grow after
    publication; create a new dataset version with explicit retained reservations.
    A plain reservation mapping is a partial set of frozen constraints. Passing a
    FamilyReservation additionally requires an exhaustive pre-generation family
    inventory, including duplicate bridges.
    """
    _validate_parameters(dataset_version, seed, ratios)
    records = sorted(examples, key=lambda item: item.sample_id)
    by_id = {example.sample_id: example for example in records}
    if not records or len(by_id) != len(records):
        raise TrainingError("INVALID_DATASET", "Split input must be nonempty with unique sample identifiers.")
    links = set(tuple(sorted(pair)) for pair in family_links)
    if any(len(pair) != 2 or any(not _valid_family(key) for key in pair) for pair in links):
        raise TrainingError("INVALID_FAMILY", "Family links require two namespaced family keys.")
    reservation = reserved_families
    exhaustive_reservation = isinstance(reservation, FamilyReservation)
    if isinstance(reservation, FamilyReservation):
        reservation = FamilyReservation.from_dict(reservation.to_dict())
        if (reservation.dataset_version, reservation.seed, reservation.ratios) != (dataset_version, seed, ratios):
            raise TrainingError("INVALID_SPLIT_CONFIG", "Pre-generation reservation version, seed or ratios changed.")
        for members in reservation.groups.values():
            links.update(tuple(sorted((members[0], member))) for member in members[1:])
        reservations = dict(reservation.assignments)
    else:
        reservations = dict(reservation or {})
    if any(not _valid_family(key) or value not in SPLITS for key, value in reservations.items()):
        raise TrainingError("INVALID_SPLIT_CONFIG", "Frozen reservations must map namespaced families to valid splits.")
    graph = _Groups()
    for key in reservations:
        graph.find(key)
    by_content: dict[str, str] = {}
    for example in records:
        project, template = family_keys(example)
        if exhaustive_reservation and (project not in reservations or template not in reservations):
            raise TrainingError("UNRESERVED_FAMILY", "An example uses a family absent from the pre-generation reservation.")
        graph.join(project, template)
        content_hash = canonical_sample_hash(example)
        if content_hash in by_content:
            graph.join(project, family_keys(by_id[by_content[content_hash]])[0])
        by_content[content_hash] = example.sample_id
    for left, right in links:
        if exhaustive_reservation and (left not in reservations or right not in reservations):
            raise TrainingError("UNRESERVED_FAMILY", "A duplicate bridge references a family absent from the exhaustive reservation.")
        graph.join(left, right)
    near_pairs = tuple(sorted(set(tuple(sorted(pair)) for pair in near_duplicate_pairs)))
    for pair in near_pairs:
        if len(pair) != 2 or any(key not in by_id for key in pair):
            raise TrainingError("INVALID_NEAR_DUPLICATE_LINK", "Near-duplicate links must reference existing samples.")
        graph.join(family_keys(by_id[pair[0]])[0], family_keys(by_id[pair[1]])[0])
    groups = graph.components()
    family_to_group = {key: group_id for group_id, members in groups.items() for key in members}
    group_assignments: dict[str, str] = {}
    for group_id, members in groups.items():
        requested = {reservations[key] for key in members if key in reservations}
        if len(requested) > 1:
            raise TrainingError("SPLIT_LEAKAGE", "A family or duplicate link crosses immutable split reservations.")
        group_assignments[group_id] = next(iter(requested)) if requested else _assign(group_id, dataset_version, seed, ratios)
    sample_groups = {sample.sample_id: family_to_group[family_keys(sample)[0]] for sample in records}
    assignments = {sample_id: group_assignments[group_id] for sample_id, group_id in sample_groups.items()}
    return SplitManifest(dataset_version, seed, ratios, assignments,
        {sample.sample_id: digest(sample.to_dict()) for sample in records}, sample_groups,
        groups, group_assignments, reservations, tuple(sorted(links)), near_pairs)


def assert_manifest_matches(examples: Iterable[TrainingExample], manifest: SplitManifest) -> None:
    manifest.validate_examples(examples)
