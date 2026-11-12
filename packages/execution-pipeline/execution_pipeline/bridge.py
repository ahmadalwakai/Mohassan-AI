"""Phase 2 <-> Phase 3 adapters: tokenizer protocol, model factory, inference export.

Phase 3 declares ``Phase2Tokenizer`` and ``ModelFactory`` protocols but ships no
implementation, and Phase 2 can only *read* inference checkpoints that nothing
wrote. Everything here is the missing concrete side of those seams.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any, Sequence

from . import PACKAGES_ROOT  # noqa: F401  (extends sys.path)

from execution_model.checkpoint import CHECKPOINT_FORMAT, CHECKPOINT_VERSION
from execution_model.config import ARCHITECTURE_VERSION, ModelConfig, model_preset
from execution_model.metadata import ARCHITECTURE_ID
from execution_model.model import ExecutionModel
from execution_model.tokenizer import ByteBPETokenizer
from execution_training.errors import TrainingError
from execution_training.model_factory import ModelBundle, ModelRequest

# Phase 3 names sizes by parameter estimate, Phase 2 by letter. One mapping, here.
PRESET_LETTERS = {"17m": "A", "34m": "B", "70m": "C", "126m": "D"}
FACTORY_IDENTITY = "execution-pipeline.bridge.execution_model_factory.v1"
TOKENIZER_VOCABULARY_VERSION = "mohassan-byte-bpe-v1"


class Phase2TokenizerBridge:
    """Expose ``ByteBPETokenizer`` through Phase 3's ``Phase2Tokenizer`` protocol.

    Adds no special tokens and performs no normalization: both directions are the
    tokenizer's own lossless byte-level operations.
    """

    def __init__(self, tokenizer: ByteBPETokenizer):
        if not isinstance(tokenizer, ByteBPETokenizer):
            raise TrainingError("INVALID_TOKENIZER", "A project ByteBPETokenizer is required.")
        self.tokenizer = tokenizer
        self.identity = tokenizer.identity
        self.vocabulary_version = TOKENIZER_VOCABULARY_VERSION
        self.vocabulary_size = tokenizer.vocab_size
        ids = tokenizer.special_token_ids
        self.special_tokens = {"pad": ids["pad"], "eos": ids["eos"], "bos": ids["bos"]}

    def encode(self, text: str) -> Sequence[int]:
        return self.tokenizer.encode(text)

    def decode(self, token_ids: Sequence[int]) -> str:
        return self.tokenizer.decode(list(token_ids))


def resolve_model_config(request: ModelRequest) -> ModelConfig:
    if request.architecture_id != ARCHITECTURE_VERSION:
        raise TrainingError("MODEL_CONFIGURATION_MISMATCH", "Unknown Phase 2 architecture identity.")
    if request.preset not in PRESET_LETTERS:
        raise TrainingError("MODEL_CONFIGURATION_MISMATCH", "Unknown Phase 2 size preset.")
    return model_preset(PRESET_LETTERS[request.preset], vocab_size=request.vocabulary_size,
                        max_context_length=request.context_length, seed=request.seed)


def execution_model_factory(request: ModelRequest) -> ModelBundle:
    """Build a freshly, randomly initialized ``ExecutionModel``. Never loads weights."""
    if request.initialization != "random" or request.allow_pretrained:
        raise TrainingError("PRETRAINED_WEIGHTS_FORBIDDEN", "Only random initialization is implemented.")
    config = resolve_model_config(request)
    model = ExecutionModel(config)
    if model.weight_origin != "random_initialized" or model.parameter_count() != config.parameter_count():
        raise TrainingError("MODEL_FACTORY_INVALID", "Model does not match its declared random architecture.")
    return ModelBundle(model=model, architecture_id=ARCHITECTURE_VERSION, configuration_identity=config.identity,
                       vocabulary_size=config.vocab_size, context_length=config.max_context_length,
                       initialization="random", initialization_seed=config.seed,
                       factory_identity=FACTORY_IDENTITY, activation_checkpointing_hook=None)


def _write_bytes(path: Path, data: bytes) -> None:
    temporary = path.with_name(path.name + ".tmp")
    with open(temporary, "wb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def _sha256_file(path: Path) -> str:
    result = hashlib.sha256()
    with open(path, "rb") as stream:
        while chunk := stream.read(1024 * 1024):
            result.update(chunk)
    return result.hexdigest()


def export_inference_checkpoint(training_checkpoint: str | Path, *, config: ModelConfig,
                                tokenizer: ByteBPETokenizer, output_directory: str | Path,
                                training_status: str = "unverified") -> dict[str, Any]:
    """Convert one Phase 3 training checkpoint into Phase 2's inference layout.

    Only model weights are copied; optimizer, scheduler and RNG state stay in the
    training checkpoint. ``training_status`` is the author's declaration and is
    ``unverified`` until an independent evaluation exists.
    """
    import torch
    if training_status not in ("unverified", "trained"):
        raise TrainingError("INVALID_CONFIGURATION", "Exported weights are trained or unverified, never random.")
    source = Path(training_checkpoint)
    payload = torch.load(source, map_location="cpu", weights_only=True)
    state = payload.get("model_state") if isinstance(payload, dict) else None
    compatibility = payload.get("compatibility") if isinstance(payload, dict) else None
    if not isinstance(state, dict) or not isinstance(compatibility, dict):
        raise TrainingError("CORRUPT_CHECKPOINT", "Training checkpoint has no model state.")
    if (compatibility.get("model_configuration_identity") != config.identity
            or compatibility.get("tokenizer_identity", {}).get("identity") != tokenizer.identity
            or compatibility.get("initialization", {}).get("kind") != "random"
            or config.vocab_size != tokenizer.vocab_size):
        raise TrainingError("RESUME_INCOMPATIBLE", "Checkpoint was not produced by this configuration and tokenizer.")
    reference = ExecutionModel(config)
    reference.load_state_dict(state, strict=True)
    # Fresh, contiguous float32 storages: the loader rejects views and shared buffers.
    clean = {name: tensor.detach().to(dtype=torch.float32).contiguous().clone()
             for name, tensor in reference.state_dict().items()}
    directory = Path(output_directory)
    directory.mkdir(parents=True, exist_ok=False)
    weights_path = directory / "weights.pt"
    with open(weights_path, "wb") as stream:
        torch.save(clean, stream)
        stream.flush()
        os.fsync(stream.fileno())
    canonical = lambda value: json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("ascii")  # noqa: E731
    _write_bytes(directory / "config.json", canonical(config.to_dict()) + b"\n")
    _write_bytes(directory / "tokenizer.json", canonical(tokenizer.to_dict()) + b"\n")
    manifest = {"format": CHECKPOINT_FORMAT, "version": CHECKPOINT_VERSION, "architecture": ARCHITECTURE_ID,
                "config_identity": config.identity, "tokenizer_identity": tokenizer.identity,
                "weights_sha256": _sha256_file(weights_path), "training_status": training_status,
                "initialization_seed": config.seed}
    _write_bytes(directory / "manifest.json", canonical(manifest) + b"\n")
    return {"directory": str(directory), "manifest": manifest,
            "checkpoint_identity": hashlib.sha256(canonical(manifest)).hexdigest(),
            "source_training_checkpoint": str(source), "source_training_checkpoint_sha256": _sha256_file(source),
            "weights_bytes": weights_path.stat().st_size,
            "training_state": dict(payload.get("training_state", {}))}
