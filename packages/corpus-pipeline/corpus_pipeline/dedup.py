"""Exact and approximate duplicate detection over normalized match keys."""

from array import array
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
import hashlib
from pathlib import Path, PurePosixPath
from struct import Struct

from .inputs import SPLITS, load_object, require_pin
from .normalization import TOKEN_PATTERN, match_key

DEDUP_VERSION = "1"
SHINGLE_TOKENS = 5
MINHASH_BANDS = 16
MINHASH_ROWS = 4
# The fixed BLAKE2b personalization seeds four 64-bit hash streams.
_MINHASH_PERSON = b"mohassan-dedup1"
_HASH_STREAMS = Struct(">4Q")
_BUCKET_SHIFT = 60
_FILL_SHIFT = 64
_EMPTY = 1 << _FILL_SHIFT


@dataclass(frozen=True, slots=True)
class Duplicate:
    reason: str
    reference: Mapping[str, str]
    similarity: float


@dataclass(slots=True)
class _Entry:
    reference: dict[str, str]
    shingles: array


def dialogue_text(turns: Iterable[Mapping[str, str]], assistant_end_marker: str) -> str:
    """Render only the natural-language content of each turn for matching."""
    return "\n".join(
        turn["content"].removesuffix(assistant_end_marker)
        if turn["role"] == "assistant" else turn["content"]
        for turn in turns
    )


def _densify(buckets: list[int]) -> list[int]:
    # Rotate to the next occupied bucket. Encode the offset so a value used
    # to fill a gap cannot compare equal to the original occupied bucket.
    full = next(index for index, value in enumerate(buckets) if value != _EMPTY)
    nearest = full
    dense = [0] * MINHASH_BANDS
    for step in range(MINHASH_BANDS):
        bucket = (full - step) % MINHASH_BANDS
        if buckets[bucket] != _EMPTY:
            nearest = bucket
        offset = (nearest - bucket) % MINHASH_BANDS
        dense[bucket] = buckets[nearest] + (offset << _FILL_SHIFT)
    return dense


def _minhash(key: str) -> tuple[set[int], list[tuple[int, ...]]]:
    words = TOKEN_PATTERN.findall(key)
    if len(words) < SHINGLE_TOKENS:
        return set(), []

    buckets = [[_EMPTY] * MINHASH_BANDS for _ in range(MINHASH_ROWS)]
    shingles = set()
    for index in range(len(words) - SHINGLE_TOKENS + 1):
        shingle = " ".join(words[index:index + SHINGLE_TOKENS])
        digest = hashlib.blake2b(shingle.encode(), digest_size=_HASH_STREAMS.size,
                                 person=_MINHASH_PERSON).digest()
        values = _HASH_STREAMS.unpack(digest)
        if values[0] in shingles:
            continue
        shingles.add(values[0])
        for row, value in zip(buckets, values):
            bucket = value >> _BUCKET_SHIFT
            if value < row[bucket]:
                row[bucket] = value
    return shingles, list(zip(*(_densify(row) for row in buckets)))


def _prior_key(record: object, split: str, marker: str) -> tuple[str, dict[str, str]]:
    if not isinstance(record, dict) or record.get("split") != split:
        raise ValueError("Invalid prior record or split")
    if any(not isinstance(record.get(field), str) or not record[field] for field in ("id", "source")):
        raise ValueError("Prior records require an id and a source")
    if "turns" in record:
        turns = record["turns"]
        if "text" in record or not isinstance(turns, list) or not turns or any(
            not isinstance(turn, dict)
            or turn.get("role") not in ("user", "assistant")
            or not isinstance(turn.get("content"), str)
            for turn in turns
        ):
            raise ValueError("Invalid prior dialogue turns")
        text = dialogue_text(turns, marker)
    else:
        text = record.get("text")
        if not isinstance(text, str):
            raise ValueError("Prior records require text or turns")
    return match_key(text), {"id": record["id"], "source": record["source"], "split": split}


def _shard_path(root: Path, shard: object) -> Path:
    if not isinstance(shard, dict):
        raise ValueError("Invalid prior shard metadata")
    name = shard.get("path")
    if not isinstance(name, str) or not name:
        raise ValueError("Prior shard requires a path")
    require_pin(shard.get("sha256"), "Prior shard SHA-256")
    relative = PurePosixPath(name)
    if relative.is_absolute() or ".." in relative.parts or "\\" in name or ":" in name:
        raise ValueError("Prior shard path must remain within the manifest directory")
    if shard.get("split") not in SPLITS:
        raise ValueError("Invalid prior shard split")
    if any(type(shard.get(field)) is not int or shard[field] < 0 for field in ("records", "bytes")):
        raise ValueError("Prior shards require nonnegative record and byte counts")
    path = (root / relative).resolve()
    if not path.is_relative_to(root) or not path.is_file():
        raise ValueError("Prior shard must be a regular file within the manifest directory")
    return path


class Deduplicator:
    """Index accepted records and records from verified earlier manifests."""

    def __init__(self, near_threshold: float = 0.8) -> None:
        if not 0 < near_threshold <= 1:
            raise ValueError("Near-duplicate threshold must be in (0, 1]")
        self.threshold = near_threshold
        self._exact: dict[bytes, int] = {}
        self._entries: list[_Entry] = []
        self._bands: list[dict[tuple[int, ...], list[int]]] = [{} for _ in range(MINHASH_BANDS)]

    def _add(self, digest: bytes, reference: Mapping[str, str], shingles: set[int],
             bands: list[tuple[int, ...]]) -> None:
        index = len(self._entries)
        self._exact[digest] = index
        self._entries.append(_Entry(dict(reference), array("Q", shingles)))
        for band, signature in zip(self._bands, bands):
            hits = band.get(signature)
            if hits is None:
                band[signature] = [index]
            else:
                hits.append(index)

    def check_and_add(self, key: str, reference: Mapping[str, str]) -> Duplicate | None:
        """Return the strongest duplicate hit or add a new accepted key."""
        digest = hashlib.sha256(key.encode()).digest()
        exact = self._exact.get(digest)
        if exact is not None:
            return Duplicate("exact_duplicate", self._entries[exact].reference, 1.0)

        shingles, bands = _minhash(key)
        candidates = set()
        for band, signature in zip(self._bands, bands):
            candidates.update(band.get(signature, ()))
        best = None
        for index in sorted(candidates):
            entry = self._entries[index]
            if min(len(shingles), len(entry.shingles)) < self.threshold * max(len(shingles), len(entry.shingles)):
                continue
            shared = sum(shingle in shingles for shingle in entry.shingles)
            similarity = shared / (len(shingles) + len(entry.shingles) - shared)
            if similarity >= self.threshold and (best is None or similarity > best.similarity):
                best = Duplicate("near_duplicate", entry.reference, similarity)
        if best is None:
            self._add(digest, reference, shingles, bands)
        return best

    def add_manifest(self, path: Path) -> dict:
        """Read an earlier corpus-pipeline manifest and verify each shard against it."""
        if not path.is_file():
            raise ValueError(f"Prior manifest must be a regular file: {path}")
        raw = path.read_bytes()
        manifest = load_object(raw, f"Prior manifest {path}")
        if (
            type(manifest.get("schema_version")) is not int
            or manifest["schema_version"] != 1
            or not isinstance(manifest.get("shards"), list)
        ):
            raise ValueError(f"Unsupported prior corpus manifest: {path}")
        parameters = manifest.get("parameters")
        marker = parameters.get("assistant_end_marker") if isinstance(parameters, dict) else None
        if not isinstance(marker, str) or not marker:
            raise ValueError(f"Missing assistant end marker in prior manifest: {path}")

        root = path.resolve().parent
        shard_paths = set()
        for shard in manifest["shards"]:
            shard_path = _shard_path(root, shard)
            if shard_path in shard_paths:
                raise ValueError(f"Prior manifest lists a shard twice: {path}")
            shard_paths.add(shard_path)
            record_count = byte_count = 0
            hasher = hashlib.sha256()
            with shard_path.open("rb") as stream:
                for number, line in enumerate(stream, 1):
                    hasher.update(line)
                    byte_count += len(line)
                    try:
                        record = load_object(line, "Prior record")
                        key, reference = _prior_key(record, shard["split"], marker)
                    except (ValueError, UnicodeError):
                        raise ValueError(f"Invalid prior record at {shard_path}, line {number}") from None
                    record_count += 1
                    digest = hashlib.sha256(key.encode()).digest()
                    if digest not in self._exact:
                        shingles, bands = _minhash(key)
                        self._add(digest, {**reference, "manifest": path.as_posix()}, shingles, bands)
            if (hasher.hexdigest(), record_count, byte_count) != (shard["sha256"], shard["records"], shard["bytes"]):
                raise ValueError(f"Prior shard fingerprint or counts do not match: {shard_path}")
        return {"path": path.as_posix(), "sha256": hashlib.sha256(raw).hexdigest(), "shards": manifest["shards"]}
