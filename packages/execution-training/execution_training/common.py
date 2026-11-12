"""Local, deterministic serialization and durable metadata writes."""
from __future__ import annotations

import hashlib
import json
import os
import tempfile
from pathlib import Path
from typing import Any

from .errors import TrainingError


def canonical_json(value: Any) -> str:
    # No Unicode, whitespace, case, identifier or numeric-string normalization.
    return json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True,
                      separators=(",", ":"))


def digest(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def implementation_identity() -> str:
    """Bind checkpoints to this package's actual Python source, not just a label."""
    package_directory = Path(__file__).resolve().parent
    try:
        sources = {path.name: hashlib.sha256(path.read_bytes()).hexdigest()
                   for path in sorted(package_directory.glob("*.py"))}
    except OSError as exc:
        raise TrainingError("SOURCE_IDENTITY_UNAVAILABLE", "Cannot fingerprint training implementation source.") from exc
    if not sources:
        raise TrainingError("SOURCE_IDENTITY_UNAVAILABLE", "Training source inventory is empty.")
    return digest(sources)


def _unique_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise TrainingError("DUPLICATE_JSON_KEY", "Duplicate JSON keys are not permitted.")
        result[key] = value
    return result


def parse_json(text: str) -> Any:
    def invalid_constant(value: str) -> None:
        raise TrainingError("INVALID_JSON", "Nonfinite JSON numbers are not permitted.")
    try:
        return json.loads(text, object_pairs_hook=_unique_pairs, parse_constant=invalid_constant)
    except (ValueError, TypeError, RecursionError) as exc:
        raise TrainingError("INVALID_JSON", "Metadata is not valid strict JSON.") from exc


def read_json(path: str | Path) -> Any:
    try:
        return parse_json(Path(path).read_text(encoding="utf-8"))
    except OSError as exc:
        raise TrainingError("METADATA_READ_FAILED", "Cannot read local metadata.") from exc


def atomic_json(path: str | Path, value: Any, immutable: bool = False) -> None:
    """fsync a same-directory temporary file and publish under a short local lock.

    Immutable writes may repeat byte-identical content, but may not change it.
    A crashed lock is intentionally not broken automatically. Network filesystems
    and hostile concurrent writers are outside this single-host contract.
    """
    path = Path(path)
    data = (canonical_json(value) + "\n").encode("utf-8")
    path.parent.mkdir(parents=True, exist_ok=True)
    lock = path.with_name(path.name + ".lock")
    tmp: str | None = None
    try:
        try:
            descriptor = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError as exc:
            raise TrainingError("METADATA_LOCKED", "Metadata is locked; inspect interrupted writer before retry.") from exc
        try:
            os.close(descriptor)
            if immutable and path.exists():
                if path.read_bytes() != data:
                    raise TrainingError("IMMUTABLE_MANIFEST", "Existing immutable metadata differs.")
                return
            descriptor, tmp = tempfile.mkstemp(prefix="." + path.name + ".", suffix=".tmp", dir=path.parent)
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(tmp, path)
            tmp = None
            if os.name != "nt":
                descriptor = os.open(path.parent, os.O_RDONLY)
                try:
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
        finally:
            if tmp is not None:
                Path(tmp).unlink(missing_ok=True)
            lock.unlink(missing_ok=True)
    except OSError as exc:
        code = "INSUFFICIENT_DISK_SPACE" if exc.errno == 28 or getattr(exc, "winerror", None) == 112 else "METADATA_WRITE_FAILED"
        raise TrainingError(code, "Local metadata write failed; previous file was preserved where publication had not completed.") from exc

