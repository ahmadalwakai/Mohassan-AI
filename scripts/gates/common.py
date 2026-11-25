"""File integrity, strict JSON and write-once records for the gate runner."""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import stat
from datetime import datetime, timezone
from pathlib import Path
from tempfile import NamedTemporaryFile


class GateError(ValueError):
    """Invalid input or a violated gate invariant."""


class GateVoid(GateError):
    """A previously sealed or captured pin no longer matches."""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def timestamp(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def nonempty(value) -> bool:
    return isinstance(value, str) and bool(value.strip())


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def digest(path: Path) -> str:
    require_file(path)
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def require_file(path: Path) -> None:
    if not stat.S_ISREG(path.stat().st_mode):
        raise GateError(f"Expected a regular file: {path}")


def valid_sha(value) -> bool:
    return isinstance(value, str) and re.fullmatch("[0-9a-f]{64}", value) is not None


def reject_constant(value):
    raise GateError(f"Non-finite JSON number: {value}")


def parse_float(value):
    number = float(value)
    if not math.isfinite(number):
        return reject_constant(value)
    return number


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise GateError(f"Duplicate JSON key: {key}")
        result[key] = value
    return result


def parse_json(data, source):
    try:
        if isinstance(data, bytes):
            data = data.decode("utf-8")
        return json.loads(data, object_pairs_hook=unique_object, parse_constant=reject_constant,
                          parse_float=parse_float)
    except (ValueError, RecursionError) as error:
        raise GateError(f"Invalid JSON in {source}: {error}") from error


def read_json(path: Path):
    require_file(path)
    return parse_json(path.read_bytes(), path)


def json_bytes(value) -> bytes:
    return (json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2, sort_keys=True) + "\n").encode("utf-8")


def write_once(path: Path, value) -> None:
    # Publish complete bytes atomically. Hard links fail if the destination already exists.
    with NamedTemporaryFile(mode="wb", dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        try:
            stream.write(json_bytes(value))
            stream.flush()
            os.fsync(stream.fileno())
        except BaseException:
            stream.close()
            temporary.unlink()
            raise
    try:
        os.link(temporary, path)
    finally:
        temporary.unlink()


def fields(value, required: set, context: str, optional: set = frozenset()) -> None:
    if not isinstance(value, dict) or not required <= value.keys() <= required | optional:
        raise GateError(f"Unexpected or missing fields in {context}.")


def file_pin(path: Path) -> dict:
    path = path.resolve()
    return {"path": str(path), "sha256": digest(path)}


def checked_pin(pin: dict, source: str) -> Path:
    path = Path(pin["path"])
    try:
        matches = digest(path) == pin["sha256"]
    except (OSError, GateError) as error:
        raise GateVoid(f"Gate void: cannot verify {source}: {path}") from error
    if not matches:
        raise GateVoid(f"Gate void: {source} SHA-256 changed: {path}")
    return path


def pinned_bytes(pin: dict, source: str) -> bytes:
    path = Path(pin["path"])
    try:
        require_file(path)
        data = path.read_bytes()
    except (OSError, GateError) as error:
        raise GateVoid(f"Gate void: cannot verify {source}: {path}") from error
    if sha256(data) != pin["sha256"]:
        raise GateVoid(f"Gate void: {source} SHA-256 changed: {path}")
    return data


def require_active(marker: Path) -> None:
    if marker.exists():
        raise GateError(f"Gate void: a prior pin verification failed. See {marker}")


def mark_void(marker: Path, reason: str, command: list[str]) -> None:
    try:
        write_once(marker, {"schema_version": 1, "voided_at": now(), "reason": reason, "command": command})
    except FileExistsError:
        pass
