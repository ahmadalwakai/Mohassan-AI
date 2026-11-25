"""Write SHA-pinned sidecars and configurations for the permanent model worker."""

from __future__ import annotations

import json
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from hashlib import file_digest, sha256
from pathlib import Path
from typing import TYPE_CHECKING, Any

import torch
from execution_model.sidecar import save_sidecar

if TYPE_CHECKING:
    from .model import HeadModel


_PIN = re.compile(r"[0-9a-f]{64}")
# Keep the tighter dense-head identifier from the PR #19/#29 engine config.
_HEAD_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")


def _digest(path: Path) -> str:
    with path.open("rb") as stream:
        return file_digest(stream, "sha256").hexdigest()


def _verified_pin(path: Path, expected: str) -> str:
    if not _PIN.fullmatch(expected) or _digest(path) != expected:
        raise ValueError(f"SHA-256 pin mismatch for {path.name}.")
    return expected


@dataclass(frozen=True)
class HeadExport:
    directory: Path
    kind: str
    weights_sha256: str
    manifest_sha256: str
    checkpoint: Path
    checkpoint_sha256: str

    @property
    def descriptor(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "sidecar": {
                "path": str(self.directory),
                "sha256": self.weights_sha256,
                "manifestSha256": self.manifest_sha256,
            },
        }


def export_head(
    directory: Path,
    model: HeadModel,
    trunk_checkpoint: Path,
    trunk_sha256: str,
    *,
    labels: Sequence[str] | None = None,
) -> HeadExport:
    """Save raw projection logits in the worker format, bound to the exact trunk bytes."""
    checkpoint = trunk_checkpoint.resolve(strict=True)
    _verified_pin(checkpoint, trunk_sha256)
    projection = model.projection
    if model.kind not in ("classification", "pairwise", "selection"):
        raise ValueError(f"Unsupported head type {model.kind}.")
    kind = "classify" if model.kind == "classification" else "pointer"
    if not isinstance(projection, torch.nn.Linear) or projection.in_features != model.trunk.config.hidden_size:
        raise ValueError("The permanent worker requires a linear projection from trunk hidden states.")
    if (kind == "pointer" and projection.out_features != 1) or not 1 <= projection.out_features <= 256:
        raise ValueError("Projection width exceeds the permanent worker head layout.")
    if any(not bool(parameter.detach().isfinite().all()) for parameter in projection.parameters()):
        raise ValueError("The projection contains nonfinite weights.")

    metadata: dict[str, Any] = {"kind": kind, "head_type": model.kind}
    if labels is not None:
        if kind != "classify" or len(labels) != projection.out_features or len(set(labels)) != len(labels):
            raise ValueError("Class labels must be unique and match the classification projection width.")
        metadata["labels"] = list(labels)

    directory = directory.resolve()
    directory.mkdir(parents=True, exist_ok=False)
    adapted = model.merged_trunk_state()
    if adapted is not None:
        # The worker reads ordinary tensor checkpoints. Keep the source intact and bind this
        # head to a separate trunk with the trained low-rank update applied exactly once.
        metadata["source_trunk_sha256"] = trunk_sha256
        checkpoint = directory / "adapted-trunk.pt"
        with checkpoint.open("xb") as stream:
            torch.save({"config": model.trunk.config.to_dict(), "model_state": adapted}, stream)
        trunk_sha256 = _digest(checkpoint)
    metadata["trunk_sha256"] = trunk_sha256
    manifest = save_sidecar(directory, projection, metadata)
    return HeadExport(directory, kind, manifest["weights_sha256"], _digest(directory / "sidecar.json"),
                      checkpoint, trunk_sha256)


def _configured_path(path: Path, config_directory: Path) -> str:
    resolved = path.resolve(strict=True)
    if resolved.is_relative_to(config_directory):
        return str(resolved.relative_to(config_directory))
    return str(resolved)


def write_worker_config(
    path: Path,
    *,
    heads: Mapping[str, HeadExport],
    checkpoint: Path,
    checkpoint_sha256: str,
    tokenizer_identity: str,
    eos_token_id: int,
    tokenizer_path: Path | None = None,
    tokenizer_sha256: str | None = None,
    tokenizer_report_path: Path | None = None,
    tokenizer_report_sha256: str | None = None,
) -> str:
    """Write a CPU worker configuration and return the digest of the JSON bytes it loads."""
    if not 1 <= len(heads) <= 32 or any(not _HEAD_NAME.fullmatch(name) for name in heads):
        raise ValueError("Use 1–32 valid permanent worker head identifiers.")
    if not _PIN.fullmatch(tokenizer_identity) or type(eos_token_id) is not int or eos_token_id < 0:
        raise ValueError("Provide the approved tokenizer's canonical identity and EOS ID.")
    if not _PIN.fullmatch(checkpoint_sha256) or any(head.checkpoint_sha256 != checkpoint_sha256 for head in heads.values()):
        raise ValueError("All exported heads in a worker configuration must share the exact trunk pin.")

    base_dir = path.parent.resolve()
    descriptions = {}
    for name, head in heads.items():
        descriptor = head.descriptor
        descriptor["sidecar"]["path"] = _configured_path(head.directory, base_dir)
        descriptions[name] = descriptor
    model: dict[str, Any] = {
        "checkpoint": {"path": _configured_path(checkpoint, base_dir), "sha256": checkpoint_sha256,
                       "format": "training"},
        "device": "cpu",
        "eosTokenId": eos_token_id,
        "heads": descriptions,
    }
    # PR #29 adds the optional text codec. Token ID requests on either worker version
    # use the model's approved local tokenizer in the caller.
    if tokenizer_path is not None:
        if tokenizer_sha256 is None or (tokenizer_report_path is None) != (tokenizer_report_sha256 is None):
            raise ValueError("Worker tokenizer files require their raw byte pins.")
        model["tokenizer"] = {
            "path": _configured_path(tokenizer_path, base_dir),
            "sha256": _verified_pin(tokenizer_path, tokenizer_sha256),
        }
        if tokenizer_report_path is not None and tokenizer_report_sha256 is not None:
            model["tokenizer"].update({
                "reportPath": _configured_path(tokenizer_report_path, base_dir),
                "reportSha256": _verified_pin(tokenizer_report_path, tokenizer_report_sha256),
            })
    elif any(value is not None for value in (tokenizer_sha256, tokenizer_report_path, tokenizer_report_sha256)):
        raise ValueError("Worker tokenizer pins require a tokenizer file.")

    data = json.dumps({
        "identity": {
            "modelId": "mohassan-chat-v5-heads",
            "tokenizerId": f"sha256:{tokenizer_identity}",
            "checkpointId": f"sha256:{checkpoint_sha256}",
        },
        "model": model,
    }, indent=2, sort_keys=True, allow_nan=False).encode("utf-8") + b"\n"
    with path.open("xb") as stream:
        stream.write(data)
    return sha256(data).hexdigest()
