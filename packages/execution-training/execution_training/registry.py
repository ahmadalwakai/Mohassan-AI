"""Immutable local version records, with independent evaluation receipts and no promotion API."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime
import hashlib
from pathlib import Path
import re
from typing import Any, Callable

from .checkpoints import CheckpointReference
from .common import atomic_json, digest, read_json
from .errors import TrainingError

REGISTRY_SCHEMA_VERSION = "execution-model-version-v1"
_VERSION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_HASH = re.compile(r"^[a-f0-9]{64}$")


@dataclass(frozen=True)
class ModelVersionManifest:
    model_version: str
    architecture_identity: str
    tokenizer_version: dict[str, Any]
    dataset_version: str
    dataset_manifest_identity: str
    training_configuration: dict[str, Any]
    checkpoint: CheckpointReference
    training_provenance: dict[str, Any]
    rollback_reference: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {**asdict(self), "schema_version": REGISTRY_SCHEMA_VERSION,
                "evaluation_status": "not_evaluated", "promotion_status": "unpromoted"}


@dataclass(frozen=True)
class EvaluationAttestation:
    """Produced by a trusted Phase 4 resolver after inspecting independent evaluation artifacts."""
    reference: str
    evaluator_identity: str
    model_version: str
    checkpoint_sha256: str
    dataset_manifest_identity: str
    suite_identity: str
    completed_at: str
    independent: bool
    passed: bool
    evaluation_split: str = "test"


class ModelVersionRegistry:
    def __init__(self, directory: str | Path):
        self.directory = Path(directory).resolve()

    def _version_path(self, version: str) -> Path:
        if not isinstance(version, str) or not _VERSION.fullmatch(version):
            raise TrainingError("INVALID_MODEL_VERSION", "Invalid local model version identifier")
        return self.directory / f"{version}.json"

    def register(self, manifest: ModelVersionManifest) -> Path:
        path = self._version_path(manifest.model_version)
        if not manifest.architecture_identity or not manifest.tokenizer_version or not manifest.dataset_version:
            raise TrainingError("INVALID_MODEL_VERSION", "Model, tokenizer, and dataset identities are required")
        if not _HASH.fullmatch(manifest.dataset_manifest_identity) or not _HASH.fullmatch(manifest.checkpoint.sha256):
            raise TrainingError("INVALID_MODEL_VERSION", "Dataset and checkpoint hashes are required")
        provenance = manifest.training_provenance
        if provenance.get("initialization") != "random" or any(not provenance.get(key) for key in ("run_id", "source_revision", "report_reference")):
            raise TrainingError("INVALID_MODEL_VERSION", "Random initialization and training provenance must be recorded")
        checkpoint_path = Path(manifest.checkpoint.path).resolve()
        try:
            receipt = read_json(checkpoint_path.with_suffix(".json"))
            identity = receipt["compatibility"]
            config_for_resume = dict(manifest.training_configuration)
            config_for_resume.pop("resume_checkpoint", None)
            if (receipt["sha256"] != manifest.checkpoint.sha256
                    or receipt["compatibility_identity"] != digest(identity)
                    or identity.get("initialization", {}).get("kind") != "random"
                    or identity["architecture_id"] != manifest.architecture_identity
                    or identity["dataset_manifest_identity"] != manifest.dataset_manifest_identity
                    or identity["tokenizer_identity"] != manifest.tokenizer_version
                    or identity["training_config_identity"] != digest(config_for_resume)):
                raise TrainingError("INVALID_MODEL_VERSION", "Version identities do not match the checkpoint receipt")
            h = hashlib.sha256()
            with checkpoint_path.open("rb") as stream:
                while chunk := stream.read(1024 * 1024):
                    h.update(chunk)
            if h.hexdigest() != manifest.checkpoint.sha256:
                raise TrainingError("CORRUPT_CHECKPOINT", "Registry checkpoint reference does not match its artifact")
        except (OSError, KeyError, TypeError) as exc:
            raise TrainingError("CORRUPT_CHECKPOINT", "Registry checkpoint artifact is unavailable") from exc
        if manifest.rollback_reference is not None:
            if manifest.rollback_reference == manifest.model_version or not self._version_path(manifest.rollback_reference).is_file():
                raise TrainingError("INVALID_MODEL_VERSION", "Rollback reference must name a different existing local version")
        atomic_json(path, manifest.to_dict(), immutable=True)
        return path

    def record_evaluation(self, version: str, evidence_reference: str,
                          resolver: Callable[[str], EvaluationAttestation]) -> Path:
        """Calling this does not train on held-out results or change promotion state."""
        manifest = read_json(self._version_path(version))
        evidence = resolver(evidence_reference)
        if not isinstance(evidence, EvaluationAttestation):
            raise TrainingError("INVALID_EVALUATION", "Phase 4 resolver did not return a typed attestation")
        if (evidence.reference != evidence_reference or evidence.model_version != version
                or evidence.checkpoint_sha256 != manifest["checkpoint"]["sha256"]
                or evidence.dataset_manifest_identity != manifest["dataset_manifest_identity"]
                or evidence.independent is not True or type(evidence.passed) is not bool
                or evidence.evaluation_split != "test"
                or not evidence.evaluator_identity or not evidence.suite_identity):
            raise TrainingError("INVALID_EVALUATION", "Independent evaluation is not bound to this checkpoint and held-out suite")
        try:
            timestamp = datetime.fromisoformat(evidence.completed_at.replace("Z", "+00:00"))
            if timestamp.tzinfo is None:
                raise ValueError("timezone required")
        except (ValueError, AttributeError) as exc:
            raise TrainingError("INVALID_EVALUATION", "Evaluation completion time requires an explicit timezone") from exc
        receipt = {"schema_version": REGISTRY_SCHEMA_VERSION, "model_version": version,
                   "manifest_identity": digest(manifest), "attestation": asdict(evidence),
                   "evaluation_status": "passed" if evidence.passed else "failed",
                   "promotion_status": "unpromoted"}
        # One final independent decision per version; subsequent evaluation revisions require a new version.
        path = self.directory / f"{version}.evaluation.json"
        atomic_json(path, receipt, immutable=True)
        return path

    def inspect(self, version: str) -> dict[str, Any]:
        manifest = read_json(self._version_path(version))
        evaluation_path = self.directory / f"{version}.evaluation.json"
        if not evaluation_path.is_file():
            return {**manifest, "eligible_for_promotion_review": False}
        receipt = read_json(evaluation_path)
        evidence = receipt.get("attestation", {})
        expected_status = "passed" if evidence.get("passed") is True else "failed"
        if (receipt.get("schema_version") != REGISTRY_SCHEMA_VERSION
                or receipt.get("model_version") != version
                or receipt.get("manifest_identity") != digest(manifest)
                or receipt.get("promotion_status") != "unpromoted"
                or receipt.get("evaluation_status") != expected_status
                or evidence.get("independent") is not True
                or type(evidence.get("passed")) is not bool
                or evidence.get("model_version") != version
                or evidence.get("checkpoint_sha256") != manifest["checkpoint"]["sha256"]
                or evidence.get("dataset_manifest_identity") != manifest["dataset_manifest_identity"]
                or evidence.get("evaluation_split") != "test"
                or not evidence.get("evaluator_identity") or not evidence.get("suite_identity")
                or not evidence.get("reference") or not evidence.get("completed_at")):
            raise TrainingError("INVALID_MODEL_VERSION", "Evaluation no longer matches the immutable version manifest")
        return {**manifest, "evaluation_status": receipt["evaluation_status"],
                "evaluation_receipt": str(evaluation_path), "promotion_status": "unpromoted",
                "eligible_for_promotion_review": receipt["evaluation_status"] == "passed"}
