"""Validated, content-bound dataset assembly. All sources are explicitly supplied."""
from __future__ import annotations

from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable, Mapping

from .common import atomic_json, digest, read_json
from .deduplication import deduplicate
from .errors import TrainingError
from .privacy import PrivacyPolicy
from .provenance import EvidenceRecord, EvidenceResolver
from .schemas import TrainingExample
from .splitting import FamilyReservation, SplitManifest, create_split_manifest
from .validation import validate_example


@dataclass(frozen=True)
class PreparedDataset:
    examples: tuple[TrainingExample, ...]
    manifest: SplitManifest
    preparation_audit: dict

    @property
    def identity(self) -> str:
        return digest({"split_manifest": self.manifest.identity, "preparation_audit": self.preparation_audit})

    def for_split(self, split: str) -> tuple[TrainingExample, ...]:
        if split not in {"train", "validation", "test"}:
            raise TrainingError("INVALID_SPLIT", "Unknown dataset split.")
        return tuple(example for example in self.examples
                     if self.manifest.assignments[example.sample_id] == split)

    def validate(self, evidence_resolver: EvidenceResolver, privacy_policy: PrivacyPolicy) -> None:
        self.manifest.validate_examples(self.examples)
        required = {"schema_version", "split_manifest_identity", "privacy_policy_identity", "deduplication"}
        if (type(self.preparation_audit) is not dict or set(self.preparation_audit) != required
                or self.preparation_audit["schema_version"] != "execution-preparation-audit-v1"
                or self.preparation_audit["split_manifest_identity"] != self.manifest.identity
                or self.preparation_audit["privacy_policy_identity"] != privacy_policy.identity()):
            raise TrainingError("DATASET_MANIFEST_CHANGED", "Preparation audit or privacy policy differs.")
        for example in self.examples:
            split = self.manifest.assignments[example.sample_id]
            use = {"train": "training", "validation": "validation", "test": "evaluation"}[split]
            # Reparse: frozen dataclasses may still contain mutable nested dictionaries.
            parsed = TrainingExample.from_dict(example.to_dict())
            validate_example(parsed, evidence_resolver, privacy_policy, intended_use=use).require_accepted()

    def write(self, directory: str | Path) -> None:
        """Immutable files include no generated timestamp; replays are byte-identical."""
        directory = Path(directory)
        self.manifest.validate_examples(self.examples)
        for split in ("train", "validation", "test"):
            atomic_json(directory / (split + ".json"),
                        [item.to_dict() for item in self.for_split(split)], immutable=True)
        atomic_json(directory / "preparation-audit.json", self.preparation_audit, immutable=True)
        # Publish the manifest last. Partial writes are not a complete dataset.
        self.manifest.write(directory / "split-manifest.json")


def prepare_dataset(examples: Iterable[TrainingExample], *, dataset_version: str,
                    evidence_resolver: EvidenceResolver, privacy_policy: PrivacyPolicy,
                    seed: int = 1729, ratios: tuple[float, float, float] = (0.8, 0.1, 0.1),
                    reserved_families: FamilyReservation | Mapping[str, str] | None = None,
                    near_threshold: float | None = 0.92,
                    max_near_comparisons: int = 250_000) -> PreparedDataset:
    """Validate before deduplication; exclusions must be handled in audited ingestion.

    Caller-supplied reservations should be frozen BEFORE generating variants. Known
    evaluation-origin and held-out evidence families are additionally reserved here.
    An invalid/quarantined sample aborts preparation rather than disappearing.
    """
    records = tuple(TrainingExample.from_dict(item.to_dict()) for item in examples)
    if not records:
        raise TrainingError("EMPTY_DATASET", "No examples supplied.")
    reservation_object = None
    if isinstance(reserved_families, FamilyReservation):
        reservation_object = FamilyReservation.from_dict(reserved_families.to_dict())
        if (reservation_object.dataset_version != dataset_version or reservation_object.seed != seed
                or reservation_object.ratios != ratios):
            raise TrainingError("HELDOUT_RESERVATION_CONFLICT", "Pre-generation reservation settings differ.")
        reservations = dict(reservation_object.assignments)
    else:
        reservations = dict(reserved_families or {})
    for example in records:
        evidence = evidence_resolver.resolve(example.verification.reference)
        if evidence is None:
            raise TrainingError("MISSING_VERIFICATION_EVIDENCE", "Example has no independently resolved evidence.")
        try:
            evidence = EvidenceRecord.from_dict(asdict(evidence))
        except (TypeError, ValueError) as exc:
            raise TrainingError("CORRUPT_EVIDENCE", "Resolver returned an invalid evidence record.") from exc
        scope = "test" if example.provenance.evaluation_origin else evidence.scope
        intended = {"training": "training", "validation": "validation", "test": "evaluation"}[scope]
        validate_example(example, evidence_resolver, privacy_policy, intended_use=intended).require_accepted()
        if scope in {"validation", "test"}:
            for family in ("project:" + example.project_family, "template:" + example.template_family):
                if reservation_object is not None and family not in reservations:
                    raise TrainingError("HELDOUT_RESERVATION_CONFLICT", "Example family is absent from the frozen reservation.")
                if family in reservations and reservations[family] != scope:
                    raise TrainingError("HELDOUT_RESERVATION_CONFLICT", "Evidence conflicts with a reserved family split.")
                reservations[family] = scope
    # The near-duplicate budget is an explicit caller decision recorded in the audit. The
    # default stays bounded, so an oversized corpus fails loudly instead of stalling.
    deduplicated = deduplicate(records, near_threshold=near_threshold, max_comparisons=max_near_comparisons)
    manifest = create_split_manifest(deduplicated.kept, dataset_version=dataset_version,
                                     seed=seed, ratios=ratios, reserved_families=reservation_object or reservations,
                                     near_duplicate_pairs=deduplicated.near_duplicate_pairs,
                                     family_links=deduplicated.family_links)
    audit = {"schema_version": "execution-preparation-audit-v1",
             "split_manifest_identity": manifest.identity, "privacy_policy_identity": privacy_policy.identity(),
             "deduplication": deduplicated.audit_dict()}
    result = PreparedDataset(tuple(deduplicated.kept), manifest, audit)
    result.validate(evidence_resolver, privacy_policy)
    return result


def load_dataset(directory: str | Path, *, evidence_resolver: EvidenceResolver,
                 privacy_policy: PrivacyPolicy) -> PreparedDataset:
    directory = Path(directory)
    manifest = SplitManifest.from_dict(read_json(directory / "split-manifest.json"))
    examples: list[TrainingExample] = []
    for split in ("train", "validation", "test"):
        raw = read_json(directory / (split + ".json"))
        if type(raw) is not list:
            raise TrainingError("INVALID_DATASET", "Dataset split must contain an explicit array of examples.")
        for item in raw:
            example = TrainingExample.from_dict(item)
            if manifest.assignments.get(example.sample_id) != split:
                raise TrainingError("DATASET_MANIFEST_CHANGED", "Example appears in an incorrect split file.")
            examples.append(example)
    result = PreparedDataset(tuple(examples), manifest, read_json(directory / "preparation-audit.json"))
    result.validate(evidence_resolver, privacy_policy)
    return result

