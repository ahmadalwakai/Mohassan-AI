"""Pure JSON interchange; importing this package performs no evaluation or I/O."""
from __future__ import annotations

import dataclasses
import hashlib
import json
from collections.abc import Mapping
from typing import Any


def to_jsonable(value: Any) -> Any:
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return {field.name: to_jsonable(getattr(value, field.name)) for field in dataclasses.fields(value)}
    if isinstance(value, Mapping):
        if any(not isinstance(key, str) for key in value):
            raise ValueError("JSON object keys must be strings")
        return {key: to_jsonable(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [to_jsonable(item) for item in value]
    if value is None or type(value) in (str, int, float, bool):
        return value
    raise TypeError(f"Unsupported JSON value: {type(value).__name__}")


def canonical_json(value: Any) -> str:
    return json.dumps(to_jsonable(value), ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":"))


def digest(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def json_copy(value: Any) -> Any:
    return json.loads(canonical_json(value))
