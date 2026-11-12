"""Immutable, hash-checked local checkpoints. Checkpoints are trusted code-adjacent artifacts.

Restricted torch loading reduces pickle execution risk; it does not make hostile files safe
against memory exhaustion or all parser vulnerabilities. An explicit trust decision is mandatory.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import hashlib
import os
from pathlib import Path
import random
import shutil
import tempfile
from typing import Any
import uuid

from .common import atomic_json, digest, read_json
from .errors import TrainingError

CHECKPOINT_SCHEMA_VERSION = "execution-checkpoint-v1"
REQUIRED_PAYLOAD_KEYS = frozenset({
    "compatibility", "model_state", "optimizer_state", "scheduler_state", "scaler_state", "rng_state",
    "training_state", "sampler_state", "training_config", "accumulation_state",
})


@dataclass(frozen=True)
class CheckpointReference:
    path: str
    sha256: str
    schema_version: str = CHECKPOINT_SCHEMA_VERSION

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def capture_rng_state() -> dict[str, Any]:
    import torch
    state: dict[str, Any] = {"python": random.getstate(), "torch_cpu": torch.get_rng_state(),
                             "torch_cuda": torch.cuda.get_rng_state_all() if torch.cuda.is_available() else []}
    try:
        import numpy as np
    except ImportError:
        state["numpy"] = None
    else:
        name, keys, position, has_gauss, cached = np.random.get_state()
        state["numpy"] = {"name": name, "keys": keys.tolist(), "position": position,
                          "has_gauss": has_gauss, "cached_gaussian": cached}
    return state


def restore_rng_state(state: dict[str, Any]) -> None:
    import torch
    if not isinstance(state, dict) or set(state) != {"python", "torch_cpu", "torch_cuda", "numpy"}:
        raise TrainingError("CORRUPT_CHECKPOINT", "Invalid RNG state")
    cuda_states = state["torch_cuda"]
    if len(cuda_states) != (torch.cuda.device_count() if torch.cuda.is_available() else 0):
        raise TrainingError("RESUME_INCOMPATIBLE", "CUDA RNG device count changed")
    try:
        if state["numpy"] is not None:
            import numpy as np
            value = state["numpy"]
            np.random.set_state((value["name"], np.array(value["keys"], dtype=np.uint32), value["position"],
                                 value["has_gauss"], value["cached_gaussian"]))
        random.setstate(state["python"])
        torch.set_rng_state(state["torch_cpu"])
        if cuda_states:
            torch.cuda.set_rng_state_all(cuda_states)
    except (ImportError, ValueError, TypeError, KeyError, RuntimeError) as exc:
        raise TrainingError("RESUME_INCOMPATIBLE", "Cannot restore checkpoint RNG state") from exc


def _validate_payload(payload: dict[str, Any]) -> None:
    if not isinstance(payload, dict) or not REQUIRED_PAYLOAD_KEYS <= set(payload):
        raise TrainingError("CORRUPT_CHECKPOINT", "Checkpoint is missing recovery state")
    for key in REQUIRED_PAYLOAD_KEYS:
        if not isinstance(payload[key], dict):
            raise TrainingError("CORRUPT_CHECKPOINT", f"Checkpoint {key} must be a mapping")
    if payload["accumulation_state"] != {"microsteps": 0, "pending_tokens": 0}:
        raise TrainingError("UNSAFE_CHECKPOINT_BOUNDARY", "Only completed optimizer boundaries can be persisted")
    training = payload["training_state"]
    for name in ("step", "processed_tokens", "unique_dataset_tokens"):
        if type(training.get(name)) is not int or training[name] < 0:
            raise TrainingError("CORRUPT_CHECKPOINT", f"Invalid training counter: {name}")
    required_identity = {"architecture_id", "tokenizer_identity", "dataset_manifest_identity", "training_config_identity", "runtime"}
    identity = payload["compatibility"]
    if not required_identity <= set(identity):
        raise TrainingError("CORRUPT_CHECKPOINT", "Checkpoint compatibility identities are incomplete")
    for name in ("architecture_id", "dataset_manifest_identity", "training_config_identity"):
        if not isinstance(identity[name], str) or not identity[name]:
            raise TrainingError("CORRUPT_CHECKPOINT", f"Invalid compatibility identity: {name}")
    if not isinstance(identity["tokenizer_identity"], dict) or not isinstance(identity["runtime"], dict):
        raise TrainingError("CORRUPT_CHECKPOINT", "Invalid tokenizer/runtime identity")


def _tensor_bytes(value: Any) -> int:
    import torch
    if isinstance(value, torch.Tensor):
        return value.numel() * value.element_size()
    if isinstance(value, dict):
        return sum(_tensor_bytes(v) for v in value.values())
    if isinstance(value, (tuple, list)):
        return sum(_tensor_bytes(v) for v in value)
    return 0


def _hash_stream(stream: Any) -> str:
    result = hashlib.sha256()
    while chunk := stream.read(1024 * 1024):
        result.update(chunk)
    return result.hexdigest()


class CheckpointManager:
    def __init__(self, directory: str | Path, min_free_disk_bytes: int = 2 * 1024**3,
                 max_checkpoint_bytes: int = 8 * 1024**3):
        self.directory = Path(directory).resolve()
        self.min_free_disk_bytes = min_free_disk_bytes
        self.max_checkpoint_bytes = max_checkpoint_bytes
        if type(min_free_disk_bytes) is not int or min_free_disk_bytes < 0 or type(max_checkpoint_bytes) is not int or max_checkpoint_bytes <= 0:
            raise TrainingError("INVALID_CONFIGURATION", "Invalid checkpoint disk limits")

    def save(self, payload: dict[str, Any], *, step: int, processed_tokens: int) -> CheckpointReference:
        import torch
        _validate_payload(payload)
        if payload["training_state"]["step"] != step or payload["training_state"]["processed_tokens"] != processed_tokens:
            raise TrainingError("CORRUPT_CHECKPOINT", "Checkpoint filename counters differ from payload")
        self.directory.mkdir(parents=True, exist_ok=True)
        # Tensor bytes are only a preflight estimate; the serialized file is checked again below.
        estimated = _tensor_bytes(payload) + 16 * 1024**2
        if estimated > self.max_checkpoint_bytes:
            raise TrainingError("CHECKPOINT_TOO_LARGE", "Estimated checkpoint exceeds the configured size limit")
        if shutil.disk_usage(self.directory).free < self.min_free_disk_bytes + estimated:
            raise TrainingError("INSUFFICIENT_DISK_SPACE", "Checkpoint reserve would be violated")
        filename = f"step-{step:09d}-tokens-{processed_tokens:012d}-{uuid.uuid4().hex}.pt"
        final_path = self.directory / filename
        temporary: Path | None = None
        try:
            fd, temporary_name = tempfile.mkstemp(prefix=".checkpoint-", suffix=".tmp", dir=self.directory)
            temporary = Path(temporary_name)
            with os.fdopen(fd, "wb") as stream:
                torch.save({**payload, "checkpoint_schema_version": CHECKPOINT_SCHEMA_VERSION,
                            "saved_at": datetime.now(timezone.utc).isoformat()}, stream)
                stream.flush()
                os.fsync(stream.fileno())
            size = temporary.stat().st_size
            if size > self.max_checkpoint_bytes:
                raise TrainingError("CHECKPOINT_TOO_LARGE", "Serialized checkpoint exceeds its size limit")
            if shutil.disk_usage(self.directory).free < self.min_free_disk_bytes:
                raise TrainingError("INSUFFICIENT_DISK_SPACE", "Serialized checkpoint would violate the free-space reserve")
            with temporary.open("rb") as stream:
                sha256 = _hash_stream(stream)
            # Unique final names preserve every prior valid checkpoint. The receipt is the commit marker.
            if final_path.exists():
                raise TrainingError("CHECKPOINT_COLLISION", "Refusing to replace a checkpoint")
            os.replace(temporary, final_path)
            temporary = None
            receipt = {"schema_version": CHECKPOINT_SCHEMA_VERSION, "filename": filename,
                       "sha256": sha256, "size_bytes": size, "step": step,
                       "processed_tokens": processed_tokens,
                       "compatibility": payload["compatibility"],
                       "compatibility_identity": digest(payload["compatibility"])}
            atomic_json(final_path.with_suffix(".json"), receipt, immutable=True)
            return CheckpointReference(str(final_path), sha256)
        except TrainingError:
            raise
        except OSError as exc:
            code = "INSUFFICIENT_DISK_SPACE" if exc.errno == 28 or getattr(exc, "winerror", None) == 112 else "CHECKPOINT_WRITE_FAILED"
            raise TrainingError(code, "Atomic checkpoint write failed; previous checkpoints remain valid") from exc
        except RuntimeError as exc:
            raise TrainingError("CHECKPOINT_WRITE_FAILED", "Checkpoint serialization failed; previous checkpoints remain valid") from exc
        finally:
            if temporary is not None:
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    # A leftover .tmp is not a committed checkpoint and must never be resumed.
                    pass

    def load(self, path: str | Path, expected_compatibility: dict[str, Any], *,
             trusted: bool = False, expected_sha256: str | None = None) -> dict[str, Any]:
        import torch
        if trusted is not True:
            raise TrainingError("UNTRUSTED_CHECKPOINT", "Loading requires explicit trust in the checkpoint and its source")
        resolved = Path(path).resolve()
        if resolved.parent != self.directory or resolved.suffix != ".pt":
            raise TrainingError("UNTRUSTED_CHECKPOINT", "Checkpoint must be an explicit file inside the configured checkpoint directory")
        try:
            receipt = read_json(resolved.with_suffix(".json"))
            required = {"schema_version", "filename", "sha256", "size_bytes", "step", "processed_tokens", "compatibility", "compatibility_identity"}
            if not isinstance(receipt, dict) or set(receipt) != required or receipt["schema_version"] != CHECKPOINT_SCHEMA_VERSION:
                raise TrainingError("CORRUPT_CHECKPOINT", "Missing or unsupported checkpoint commit receipt")
            if receipt["filename"] != resolved.name or type(receipt["size_bytes"]) is not int or not 0 < receipt["size_bytes"] <= self.max_checkpoint_bytes:
                raise TrainingError("CORRUPT_CHECKPOINT", "Checkpoint receipt contains invalid file metadata")
            if (receipt["compatibility_identity"] != digest(expected_compatibility)
                    or digest(receipt["compatibility"]) != receipt["compatibility_identity"]):
                raise TrainingError("RESUME_INCOMPATIBLE", "Architecture, tokenizer, dataset, training configuration, or runtime changed")
            with resolved.open("rb") as stream:
                if os.fstat(stream.fileno()).st_size != receipt["size_bytes"]:
                    raise TrainingError("CORRUPT_CHECKPOINT", "Checkpoint size does not match its receipt")
                actual_hash = _hash_stream(stream)
                if actual_hash != receipt["sha256"] or (expected_sha256 is not None and actual_hash != expected_sha256):
                    raise TrainingError("CORRUPT_CHECKPOINT", "Checkpoint content hash mismatch")
                stream.seek(0)
                # Never fall back to unrestricted pickle loading.
                payload = torch.load(stream, map_location="cpu", weights_only=True)
            _validate_payload(payload)
            if payload.get("checkpoint_schema_version") != CHECKPOINT_SCHEMA_VERSION:
                raise TrainingError("RESUME_INCOMPATIBLE", "Checkpoint schema version changed")
            if digest(payload["compatibility"]) != digest(expected_compatibility):
                raise TrainingError("RESUME_INCOMPATIBLE", "Checkpoint identities changed")
            if (payload["training_state"]["step"] != receipt["step"]
                    or payload["training_state"]["processed_tokens"] != receipt["processed_tokens"]):
                raise TrainingError("CORRUPT_CHECKPOINT", "Checkpoint counters do not match their receipt")
            payload["loaded_checkpoint_reference"] = CheckpointReference(str(resolved), actual_hash).to_dict()
            return payload
        except TrainingError:
            raise
        except Exception as exc:
            raise TrainingError("CORRUPT_CHECKPOINT", "Checkpoint could not be read safely") from exc
