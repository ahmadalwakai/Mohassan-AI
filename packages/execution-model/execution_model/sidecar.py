"""Sidecar weight files: small optional modules stored next to a trunk checkpoint.

A sidecar never changes the trunk file. It is pinned to the trunk by SHA-256 and
carries its own SHA-256, so loading the wrong pair fails closed. Removing a
sidecar restores the base model's behaviour exactly.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
from pathlib import Path
from typing import Any, Mapping

import torch
from torch import nn

from .errors import ModelLoadError

SIDECAR_SCHEMA = 1
_MAX_BYTES = 64 * 1024 * 1024


def _digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def save_sidecar(directory: str | os.PathLike[str], module: nn.Module, metadata: Mapping[str, Any]) -> dict[str, Any]:
    """Write `weights.pt` and `sidecar.json`; refuses to overwrite an existing sidecar."""
    target = Path(directory)
    weights_path, manifest_path = target / "weights.pt", target / "sidecar.json"
    if weights_path.exists() or manifest_path.exists():
        raise FileExistsError(f"Sidecar already exists at {target}; refusing to overwrite.")
    for key in ("kind", "trunk_sha256"):
        if not isinstance(metadata.get(key), str) or not metadata[key]:
            raise ValueError(f"Sidecar metadata requires a nonempty '{key}'.")
    state = {name: tensor.detach().to("cpu").contiguous() for name, tensor in module.state_dict().items()}
    buffer = io.BytesIO()
    torch.save(state, buffer)
    data = buffer.getvalue()
    manifest = {
        "schemaVersion": SIDECAR_SCHEMA,
        **dict(metadata),
        "parameters": int(sum(p.numel() for p in module.parameters())),
        "tensors": {name: list(tensor.shape) for name, tensor in state.items()},
        "weights_sha256": _digest(data),
    }
    target.mkdir(parents=True, exist_ok=True)
    weights_path.write_bytes(data)
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return manifest


def load_sidecar(directory: str | os.PathLike[str], module: nn.Module, *, kind: str, trunk_sha256: str) -> dict[str, Any]:
    """Load weights into `module` after verifying kind, trunk pin, SHA, keys and shapes."""
    target = Path(directory)
    try:
        manifest = json.loads((target / "sidecar.json").read_text(encoding="utf-8"))
        data = (target / "weights.pt").read_bytes()
    except (OSError, ValueError) as exc:
        raise ModelLoadError("Sidecar files are missing or unreadable.", details={"path": str(target)}) from exc
    if len(data) > _MAX_BYTES:
        raise ModelLoadError("Sidecar weights exceed the size bound.", details={"bytes": len(data)})
    checks = {
        "schemaVersion": manifest.get("schemaVersion") == SIDECAR_SCHEMA,
        "kind": manifest.get("kind") == kind,
        "trunk_sha256": manifest.get("trunk_sha256") == trunk_sha256,
        "weights_sha256": manifest.get("weights_sha256") == _digest(data),
    }
    failed = [name for name, ok in checks.items() if not ok]
    if failed:
        raise ModelLoadError("Sidecar does not match the requested kind/trunk or its pinned SHA.", details={"failed": failed})
    state = torch.load(io.BytesIO(data), map_location="cpu", weights_only=True)
    expected = module.state_dict()
    if set(state) != set(expected) or any(tuple(state[k].shape) != tuple(expected[k].shape) for k in expected):
        raise ModelLoadError("Sidecar tensors do not match the module layout.")
    if any(not bool(torch.isfinite(t).all()) for t in state.values()):
        raise ModelLoadError("Sidecar contains non-finite values.")
    module.load_state_dict(state, strict=True)
    return manifest
