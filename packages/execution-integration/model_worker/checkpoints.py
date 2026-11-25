"""Load the repository's local tensor formats from verified byte snapshots."""
from __future__ import annotations

from contextlib import ExitStack
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import re
from typing import Any, BinaryIO

import torch
from torch import nn

from execution_model.checkpoint import (
    CHECKPOINT_FORMAT, CHECKPOINT_VERSION, _MANIFEST_FIELDS, _check_torch_loader,
    _local_directory, _open_file, _read_json, _validate_archive, _validate_state,
)
from execution_model.config import ModelConfig
from execution_model.metadata import ARCHITECTURE_ID
from execution_model.model import ExecutionModel
from execution_model.sidecar import SIDECAR_SCHEMA
from execution_model.tokenizer import ByteBPETokenizer

from execution_pipeline import REPOSITORY_ROOT
from execution_pipeline import goal_tagger

CHECKPOINT_BYTES = 2_147_483_648
SIDECAR_BYTES = 67_108_864
METADATA_BYTES = 65_536


class EngineError(ValueError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def fields(value: Any, required: set[str], optional: set[str], code: str) -> dict:
    if type(value) is not dict or not required <= value.keys() or value.keys() - required - optional:
        raise EngineError(code)
    return value


def pin(value: Any) -> str:
    if type(value) is not str or re.fullmatch(r"[0-9a-f]{64}", value) is None:
        raise EngineError("invalid_config")
    return value


def local_path(base_dir: Path, value: Any) -> Path:
    if (type(value) is not str or not value or "\x00" in value or ":" in value[2:]
            or value.startswith(("\\\\", "//")) or "://" in value or ".." in Path(value).parts
            or (":" in value and not Path(value).is_absolute())):
        raise EngineError("invalid_config")
    return base_dir / value


def snapshot(path: Path, expected_sha256: str, limit: int) -> BinaryIO:
    # Deserialize the exact bytes that were hashed. A file renamed or rewritten
    # between hashing and torch.load cannot change the in-memory snapshot.
    digest = hashlib.sha256()
    output = io.BytesIO()
    with ExitStack() as stack:
        source = _open_file(stack, _local_directory(path.parent), path.name, limit)
        size = 0
        while chunk := source.read(1_048_576):
            size += len(chunk)
            if size > limit:
                raise EngineError("invalid_checkpoint")
            digest.update(chunk)
            output.write(chunk)
    if digest.hexdigest() != expected_sha256:
        raise EngineError("checkpoint_pin_mismatch")
    output.seek(0)
    return output


def load_tensors(handle: BinaryIO, limit: int) -> dict:
    _check_torch_loader()
    _validate_archive(handle, limit)
    payload = torch.load(handle, map_location="cpu", weights_only=True)
    if not isinstance(payload, dict):
        raise EngineError("invalid_checkpoint")
    return payload


def materialize(model: nn.Module, state: Any, limit: int) -> nn.Module:
    if not isinstance(state, dict) or any(type(tensor) is not torch.Tensor for tensor in state.values()):
        raise EngineError("invalid_checkpoint")
    _validate_state(state, model.state_dict(), check_finite=True, limit=limit)
    model.load_state_dict(state, strict=True, assign=True)
    return model.float().eval().requires_grad_(False)


def load_dense_training(path: Path, digest: str) -> ExecutionModel:
    with snapshot(path, digest, CHECKPOINT_BYTES) as handle:
        payload = load_tensors(handle, CHECKPOINT_BYTES)
    config = ModelConfig.from_dict(payload["config"])
    state = payload["model_state"]
    del payload  # Release the optimizer and RNG state before model placement.
    with torch.device("meta"):
        model = ExecutionModel(config)
    materialize(model, state, CHECKPOINT_BYTES)
    return model


def load_dense_inference(path: Path, digest: str, spec: dict) -> tuple[ExecutionModel, int]:
    path = _local_directory(path)
    expected_tokenizer = pin(spec.get("tokenizerId"))
    with snapshot(path / "manifest.json", pin(spec.get("manifestSha256")), METADATA_BYTES) as handle:
        manifest = _read_json(handle, METADATA_BYTES)
    if (manifest.keys() != _MANIFEST_FIELDS or manifest["format"] != CHECKPOINT_FORMAT
            or type(manifest["version"]) is not int or manifest["version"] != CHECKPOINT_VERSION
            or manifest["architecture"] != ARCHITECTURE_ID
            or manifest["training_status"] not in ("random_initialized", "unverified", "trained")
            or manifest["tokenizer_identity"] != expected_tokenizer):
        raise EngineError("invalid_checkpoint")
    if manifest["weights_sha256"] != digest:
        raise EngineError("checkpoint_pin_mismatch")
    with ExitStack() as stack:
        config = ModelConfig.from_dict(_read_json(_open_file(stack, path, "config.json", METADATA_BYTES), METADATA_BYTES))
        tokenizer_limit = 4_194_304
        tokenizer = ByteBPETokenizer.from_dict(
            _read_json(_open_file(stack, path, "tokenizer.json", tokenizer_limit), tokenizer_limit)
        )
    seed = manifest["initialization_seed"]
    if (config.identity != manifest["config_identity"] or tokenizer.identity != expected_tokenizer
            or tokenizer.vocab_size != config.vocab_size
            or (seed is not None and (type(seed) is not int or seed != config.seed))):
        raise EngineError("invalid_checkpoint")
    with snapshot(path / "weights.pt", digest, CHECKPOINT_BYTES) as handle:
        state = load_tensors(handle, CHECKPOINT_BYTES)
    with torch.device("meta"):
        model = ExecutionModel(config)
    materialize(model, state, CHECKPOINT_BYTES)
    return model, tokenizer.eos_token_id


def load_projection(base_dir: Path, descriptor: dict, trunk: ExecutionModel, trunk_pin: str) -> nn.Sequential:
    spec = fields(descriptor["sidecar"], {"path", "sha256", "manifestSha256"}, set(), "invalid_config")
    path = _local_directory(local_path(base_dir, spec["path"]))
    digest = pin(spec["sha256"])
    with snapshot(path / "sidecar.json", pin(spec["manifestSha256"]), METADATA_BYTES) as handle:
        manifest = _read_json(handle, METADATA_BYTES)
    if (type(manifest.get("schemaVersion")) is not int or manifest["schemaVersion"] != SIDECAR_SCHEMA
            or manifest.get("kind") != descriptor["kind"] or manifest.get("trunk_sha256") != trunk_pin
            or manifest.get("weights_sha256") != digest):
        raise EngineError("invalid_checkpoint")
    with snapshot(path / "weights.pt", digest, SIDECAR_BYTES) as handle:
        state = load_tensors(handle, SIDECAR_BYTES)
    weight = state.get("weight")
    width = trunk.config.hidden_size
    if (type(weight) is not torch.Tensor or weight.ndim != 2 or weight.shape[1] != width
            or not 1 <= weight.shape[0] <= 256 or (descriptor["kind"] == "pointer" and weight.shape[0] != 1)):
        raise EngineError("invalid_checkpoint")
    expected_tensors = {name: list(value.shape) for name, value in state.items() if type(value) is torch.Tensor}
    if manifest.get("tensors") != expected_tensors or manifest.get("parameters") != sum(
        value.numel() for value in state.values() if type(value) is torch.Tensor
    ):
        raise EngineError("invalid_checkpoint")
    with torch.device("meta"):
        projection = nn.Linear(width, weight.shape[0], bias="bias" in state)
    materialize(projection, state, SIDECAR_BYTES)
    return nn.Sequential(projection).eval()


def load_goal_tagger(path: Path, digest: str) -> tuple[nn.Module, goal_tagger.Vocabulary]:
    with snapshot(path, digest, CHECKPOINT_BYTES) as handle:
        payload = load_tensors(handle, CHECKPOINT_BYTES)
    settings, vocab = payload["settings"], payload["vocabulary"]
    for field in ("words", "chars"):
        terms = vocab[field]
        if (type(terms) is not list or len(terms) != settings[field] or terms[:2] != ["<pad>", "<unk>"]
                or any(type(term) is not str for term in terms) or len(set(terms)) != len(terms)):
            raise EngineError("invalid_checkpoint")
    vocabulary = goal_tagger.Vocabulary(vocab["words"], vocab["chars"])
    if settings.get("lexicon"):
        terms = vocab["lexicon"]
        if (type(terms) is not list or len(terms) != settings["lexicon"]["words"]
                or terms[:2] != ["<pad>", "<unk>"] or any(type(term) is not str for term in terms)
                or len(set(terms)) != len(terms)):
            raise EngineError("invalid_checkpoint")
        vocabulary.set_lexicon(terms)
    with torch.device("meta"):
        model = goal_tagger.build_model(settings)
    materialize(model, payload["model_state"], CHECKPOINT_BYTES)
    return model, vocabulary


class GpuLease:
    """Atomically reserve the same GPU lock the training entry points use."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.record = json.dumps({"owner": "Mohassan model worker", "purpose": "local inference",
                                  "pid": os.getpid(), "started": datetime.now(timezone.utc).isoformat()})
        # All cooperative holders leave an existing lock alone, including stale
        # and malformed files. Do not consult or expose the current holder data.
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError as error:
            raise EngineError("gpu_locked") from error
        except OSError as error:
            raise EngineError("gpu_lock_unavailable") from error
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                self.stat = os.fstat(handle.fileno())
                handle.write(self.record)
        except OSError as error:
            # A partially written lock is intentionally left for inspection.
            raise EngineError("gpu_lock_unavailable") from error

    def close(self) -> None:
        try:
            current = self.path.lstat()
            if not os.path.samestat(current, self.stat):
                return
            with self.path.open("r", encoding="utf-8") as handle:
                if not os.path.samestat(os.fstat(handle.fileno()), self.stat) or handle.read(1024) != self.record:
                    return
            self.path.unlink(missing_ok=True)
        except FileNotFoundError:
            return


def acquire_device(name: Any) -> tuple[torch.device, GpuLease | None]:
    if name == "cpu":
        return torch.device("cpu"), None
    if name != "cuda":
        raise EngineError("invalid_config")
    lease = GpuLease(REPOSITORY_ROOT / ".data" / "gpu.lock")
    try:
        if not torch.cuda.is_available():
            raise EngineError("gpu_unavailable")
        return torch.device("cuda:0"), lease
    except BaseException:
        lease.close()
        raise
