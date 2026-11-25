"""Validate local configuration, source cards, and pinned JSONL inputs."""

from collections.abc import Iterator
from dataclasses import dataclass
from datetime import date
from hashlib import sha256
import json
import os
from pathlib import Path
import re

from .normalization import normalize_text
from .quality import DEFAULT_END_MARKER, QualityConfig

SPLITS = ("calibration", "development", "train")
LANGUAGES = ("ar", "en")
LICENSES_PATH = Path(__file__).with_name("licenses.json")
SHA256_PATTERN = re.compile(r"[0-9a-f]{64}")


def json_bytes(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, allow_nan=False) + "\n").encode("utf-8")


def load_object(data: bytes, context: str) -> dict:
    try:
        value = json.loads(data.decode("utf-8"))
    except (ValueError, UnicodeError) as exc:
        raise ValueError(f"{context}: invalid UTF-8 JSON") from exc
    if not isinstance(value, dict):
        raise ValueError(f"{context}: expected a JSON object")
    return value


def require_string(value: object, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name}: expected a nonempty string")
    return value


def require_pin(value: object, name: str) -> str:
    if not isinstance(value, str) or not SHA256_PATTERN.fullmatch(value):
        raise ValueError(f"{name}: expected a lowercase SHA-256 hex digest")
    return value


def require_keys(value: dict, allowed: set[str], name: str) -> None:
    unknown = value.keys() - allowed
    if unknown:
        raise ValueError(f"{name}: unknown fields {', '.join(sorted(unknown))}")


def file_sha256(path: Path) -> str:
    with path.open("rb") as stream:
        digest = sha256()
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def evidence_path(path: Path, base: Path) -> str:
    try:
        return Path(os.path.relpath(path, base)).as_posix()
    except ValueError:  # Windows paths can be on different drives.
        return path.as_posix()


@dataclass(frozen=True)
class Source:
    id: str
    path: Path
    card_path: Path
    card: dict
    card_sha256: str
    split: str
    kind: str
    language: str | None

    def evidence(self, base: Path) -> dict:
        return {
            "id": self.id,
            "path": evidence_path(self.path, base),
            "card_path": evidence_path(self.card_path, base),
            "card_sha256": self.card_sha256,
            "sha256": self.card["sha256"],
            "card": self.card,
            "split": self.split,
            "kind": self.kind,
            "language": self.language,
        }


@dataclass(frozen=True)
class Config:
    path: Path
    sha256: str
    license_allow_list_sha256: str
    sources: tuple[Source, ...]
    frozen_evaluations: tuple[tuple[Path, str], ...]
    prior_manifests: tuple[Path, ...]
    quality: QualityConfig
    near_duplicate_threshold: float
    contamination_span_tokens: int
    assistant_end_marker: str
    fixture_mode: bool


def _input_path(parent: Path, value: object, name: str) -> Path:
    return (parent / require_string(value, name)).resolve()


def _source(entry: object, parent: Path, licenses: list[str], fixture_mode: bool) -> Source:
    if not isinstance(entry, dict):
        raise ValueError("sources: each entry must be an object")
    identifier = require_string(entry.get("id"), "source.id")
    require_keys(entry, {"id", "path", "card", "split", "kind", "language"}, identifier)
    path = _input_path(parent, entry.get("path"), f"{identifier}.path")
    card_path = _input_path(parent, entry.get("card"), f"{identifier}.card (source card required)")
    if not card_path.is_file():
        raise ValueError(f"{identifier}: source card is missing or is not a regular file: {card_path}")
    if not path.is_file():
        raise ValueError(f"{identifier}: source is missing or is not a regular file: {path}")
    card_bytes = card_path.read_bytes()
    card = load_object(card_bytes, str(card_path))
    for key in ("source", "license", "download_date", "consent", "origin"):
        require_string(card.get(key), f"{identifier}.card.{key}")
    require_pin(card.get("sha256"), f"{identifier}.card.sha256")
    if card["license"] not in licenses:
        raise ValueError(f"{identifier}: license {card['license']!r} is outside the allow-list")
    if card["origin"] not in ({"human", "synthetic_fixture"} if fixture_mode else {"human"}):
        raise ValueError(f"{identifier}: source origin is incompatible with the data policy")
    if not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", card["download_date"]):
        raise ValueError(f"{identifier}: use YYYY-MM-DD for download_date")
    date.fromisoformat(card["download_date"])

    split = entry.get("split")
    kind = entry.get("kind")
    language = entry.get("language")
    if split not in SPLITS or kind not in ("text", "dialogue"):
        raise ValueError(f"{identifier}: invalid split or kind")
    if language is not None and (language not in LANGUAGES or kind != "text"):
        raise ValueError(f"{identifier}: language labels require text and must be ar or en")
    return Source(identifier, path, card_path, card, sha256(card_bytes).hexdigest(), split, kind, language)


def load_config(path: Path) -> Config:
    path = path.resolve()
    data = path.read_bytes()
    values = load_object(data, str(path))
    require_keys(values, {
        "sources", "frozen_evaluations", "prior_manifests", "quality", "near_duplicate_threshold",
        "contamination_span_tokens", "assistant_end_marker", "fixture_mode",
    }, "config")
    fixture_mode = values.get("fixture_mode", False)
    if not isinstance(fixture_mode, bool):
        raise ValueError("fixture_mode must be a boolean")
    licenses_data = LICENSES_PATH.read_bytes()
    licenses = json.loads(licenses_data)
    source_values = values.get("sources")
    if not isinstance(source_values, list) or not source_values:
        raise ValueError("sources must be a nonempty array")
    sources = tuple(_source(entry, path.parent, licenses, fixture_mode) for entry in source_values)
    if len({source.id for source in sources}) != len(sources):
        raise ValueError("source IDs must be unique")
    if len({source.path for source in sources}) != len(sources):
        raise ValueError("source paths must be unique")
    fingerprint_splits: dict[str, str] = {}
    for source in sources:
        previous_split = fingerprint_splits.setdefault(source.card["sha256"], source.split)
        if previous_split != source.split:
            raise ValueError("identical source fingerprints cannot occur in different splits")
    for split in ("train", "development"):
        if not set(LANGUAGES).issubset(source.language for source in sources if source.split == split):
            raise ValueError(f"{split} requires labeled Arabic and English text sources")
    if not fixture_mode and not any(source.split == "calibration" for source in sources):
        raise ValueError("production configuration requires a calibration source")

    eval_values = values.get("frozen_evaluations")
    if not isinstance(eval_values, list) or not eval_values:
        raise ValueError("frozen_evaluations must be a nonempty array of pinned files")
    frozen = []
    for entry in eval_values:
        if not isinstance(entry, dict):
            raise ValueError("frozen_evaluations: each entry must be an object")
        require_keys(entry, {"path", "sha256"}, "frozen_evaluations")
        eval_path = _input_path(path.parent, entry.get("path"), "frozen evaluation path")
        pin = require_pin(entry.get("sha256"), "frozen evaluation sha256")
        if pin in fingerprint_splits or any(eval_path == source.path for source in sources):
            raise ValueError("a frozen evaluation cannot also be a corpus source")
        frozen.append((eval_path, pin))
    if len({entry[0] for entry in frozen}) != len(frozen):
        raise ValueError("frozen evaluation paths must be unique")

    prior = values.get("prior_manifests", [])
    if not isinstance(prior, list):
        raise ValueError("prior_manifests must be an array of paths")
    prior_paths = tuple(_input_path(path.parent, item, "prior manifest") for item in prior)
    if len(set(prior_paths)) != len(prior_paths):
        raise ValueError("prior manifest paths must be unique")

    span = values.get("contamination_span_tokens", 13)
    if type(span) is not int or span < 1:
        raise ValueError("contamination_span_tokens must be a positive integer")
    threshold = values.get("near_duplicate_threshold", 0.8)
    if type(threshold) not in (float, int) or not 0 < threshold <= 1:
        raise ValueError("near_duplicate_threshold must be in (0, 1]")
    marker = require_string(values.get("assistant_end_marker", DEFAULT_END_MARKER), "assistant_end_marker")
    if normalize_text(marker) != marker or any(character.isspace() for character in marker):
        raise ValueError("assistant_end_marker must be normalized and contain no whitespace")
    quality_values = values.get("quality", {})
    if not isinstance(quality_values, dict):
        raise ValueError("quality must be an object")
    try:
        quality = QualityConfig(**quality_values)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"quality: {exc}") from exc
    return Config(
        path, sha256(data).hexdigest(), sha256(licenses_data).hexdigest(), sources, tuple(frozen),
        prior_paths, quality, threshold, span, marker, fixture_mode,
    )


def source_rows(source: Source) -> Iterator[tuple[str, dict]]:
    digest = sha256()
    seen: set[str] = set()
    with source.path.open("rb") as stream:
        for number, line in enumerate(stream, 1):
            digest.update(line)
            if not line.strip():
                continue
            context = f"{source.path}:{number}"
            row = load_object(line, context)
            identifier = require_string(row.get("id"), f"{context}.id")
            if identifier in seen:
                raise ValueError(f"{context}: duplicate row ID {identifier!r}")
            seen.add(identifier)
            if source.kind == "text" and not isinstance(row.get("text"), str):
                raise ValueError(f"{context}: expected a text string")
            yield identifier, row
    if digest.hexdigest() != source.card["sha256"]:
        raise ValueError(f"{source.id}: source SHA-256 does not match its card")
