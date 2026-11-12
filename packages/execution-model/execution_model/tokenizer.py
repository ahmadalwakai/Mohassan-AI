"""Project-local, lossless byte BPE with no vocabulary or dependency downloads.

Training learns merge operations only. Byte ids 0..255 always exist; special ids
follow them, then learned merge ids. Input text is never normalized, split on
whitespace, or interpreted as a special token. Files are read only by explicit
``train_files``/``load`` calls; ``save`` is the sole persistence operation.
"""

from __future__ import annotations

from array import array
from collections.abc import Iterable, Mapping
from contextlib import contextmanager
import hashlib
import heapq
import json
import os
from pathlib import Path, PureWindowsPath
import re
import stat
import tempfile
from types import MappingProxyType
from typing import Any, BinaryIO, Iterator

from .errors import TokenizerError


VOCABULARY_TARGETS = (8192, 16384, 24576)
DEFAULT_SPECIAL_TOKENS = MappingProxyType({
    "pad": "<|pad|>",
    "bos": "<|bos|>",
    "eos": "<|eos|>",
    "task": "<|task|>",
    "input": "<|input|>",
    "output": "<|output|>",
    "end_task": "<|end_task|>",
})
_FORMAT = "mohassan-byte-bpe"
_VERSION = 1
_MAX_SPECIALS = 64
_MAX_TOKEN_BYTES = 256
_MAX_ENCODING_BYTES = 1_048_576
_MAX_DECODING_TOKENS = 1_048_576
_MAX_DECODING_BYTES = 8_388_608
_MAX_SERIALIZED_BYTES = 4_194_304
_MAX_CORPUS_BYTES = 67_108_864
_MAX_CORPUS_RECORDS = 100_000


def _integer(value: Any, name: str, minimum: int, maximum: int) -> int:
    if type(value) is not int or not minimum <= value <= maximum:
        raise TokenizerError(f"{name} must be an integer in [{minimum}, {maximum}].")
    return value


def _canonical_json(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"),
                      allow_nan=False).encode("ascii")


def _local_path(path: str | os.PathLike[str], *, allow_missing: bool = False) -> Path:
    """Validate ordinary local files without following filesystem indirection.

    The checks reject Windows mapped drives/reparse points and POSIX symlinks.
    They are not a filesystem sandbox against concurrent malicious replacement;
    the host must control the corpus/artifact directories while an operation runs.
    """
    try:
        raw = os.fspath(path)
    except TypeError as exc:
        raise TokenizerError("An explicit local filesystem path is required.") from exc
    if (not isinstance(raw, str) or not raw or "\x00" in raw
            or raw.startswith(("\\\\", "//")) or "://" in raw):
        raise TokenizerError("Remote, UNC, device, NUL-containing, and empty paths are unsupported.")
    windows_path = PureWindowsPath(raw)
    if windows_path.drive and (not re.fullmatch(r"[A-Za-z]:", windows_path.drive)
                               or not windows_path.root or os.name != "nt"):
        raise TokenizerError("Only absolute local Windows drive paths are supported on Windows.")
    for part in windows_path.parts:
        if part == windows_path.anchor:
            continue
        # Avoid Win32 name normalization, reserved devices (including extensions),
        # alternate data streams, and ambiguous parent traversal before any I/O.
        stem = part.split(".", 1)[0].rstrip(" ")
        if (part == ".." or part.endswith((".", " ")) or ":" in part
                or re.fullmatch(r"CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³]", stem, re.IGNORECASE)):
            raise TokenizerError("Device names, alternate streams, parent traversal, and ambiguous path components are unsupported.")
    try:
        destination = Path(raw).absolute()
        if os.name == "nt":
            import ctypes
            from ctypes import wintypes
            get_drive_type = ctypes.windll.kernel32.GetDriveTypeW
            get_drive_type.argtypes = [wintypes.LPCWSTR]
            get_drive_type.restype = wintypes.UINT
            # DRIVE_REMOVABLE/FIXED/CDROM/RAMDISK are local. Reject unknown,
            # unavailable roots and DRIVE_REMOTE without reading their contents.
            if get_drive_type(destination.anchor) not in (2, 3, 5, 6):
                raise TokenizerError("The path must use an available local filesystem drive.")
        for component in (*reversed(destination.parents), destination):
            try:
                info = component.lstat()
            except FileNotFoundError:
                if allow_missing and component == destination:
                    return destination
                raise TokenizerError("The local file and all parent directories must exist.") from None
            if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
                raise TokenizerError("Tokenizer paths may not contain symlinks, junctions, or reparse points.")
            if component == destination:
                if not stat.S_ISREG(info.st_mode):
                    raise TokenizerError("Tokenizer and corpus paths must name regular files.")
            elif not stat.S_ISDIR(info.st_mode):
                raise TokenizerError("Every parent component must be an existing local directory.")
        return destination
    except (OSError, ValueError) as exc:
        raise TokenizerError("Could not validate the explicitly requested local filesystem path.") from exc


@contextmanager
def _open_local_reader(source: Path) -> Iterator[BinaryIO]:
    """Read a validated regular file; reject replacement detected during open."""
    before = source.lstat()
    if (not stat.S_ISREG(before.st_mode) or stat.S_ISLNK(before.st_mode)
            or getattr(before, "st_file_attributes", 0) & 0x400):
        raise TokenizerError("Tokenizer and corpus paths must remain regular local files.")
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    # On POSIX, a file replaced with a FIFO must not block before fstat rejects it.
    flags |= getattr(os, "O_NONBLOCK", 0)
    descriptor = os.open(source, flags)
    try:
        with os.fdopen(descriptor, "rb") as stream:
            descriptor = None
            after = os.fstat(stream.fileno())
            if (not stat.S_ISREG(after.st_mode)
                    or getattr(after, "st_file_attributes", 0) & 0x400
                    or (before.st_dev, before.st_ino, before.st_size) != (after.st_dev, after.st_ino, after.st_size)):
                raise TokenizerError("Local file changed or is not regular while opening it.")
            yield stream
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise TokenizerError("Tokenizer JSON contains a duplicate object key.")
        result[key] = value
    return result


class ByteBPETokenizer:
    """An immutable vocabulary and merge-rank table trained from local bytes.

    ``decode(encode(text)) == text`` for valid Unicode scalar text, including
    Arabic, whitespace, escape characters, and literal special-token spellings.
    ``decode_bytes(encode_bytes(data)) == data`` for arbitrary bytes. Explicit
    special ids decode to their spelling unless ``skip_special_tokens=True``.
    Skipping is therefore an explicit lossy operation, never the default.
    """

    def __init__(
        self,
        merges: Iterable[tuple[int, int]] = (),
        *,
        special_tokens: Mapping[str, str] | None = None,
        target_vocab_size: int = 16384,
    ) -> None:
        if type(target_vocab_size) is not int or target_vocab_size not in VOCABULARY_TARGETS:
            raise TokenizerError(f"target_vocab_size must be one of {VOCABULARY_TARGETS}.")
        supplied = DEFAULT_SPECIAL_TOKENS if special_tokens is None else special_tokens
        if not isinstance(supplied, Mapping) or not 3 <= len(supplied) <= _MAX_SPECIALS:
            raise TokenizerError("special_tokens must map 3..64 names to spellings.")
        specials = dict(supplied)
        if not {"pad", "bos", "eos"}.issubset(specials):
            raise TokenizerError("Special token names pad, bos, and eos are required.")
        spellings: set[str] = set()
        for name, spelling in specials.items():
            if not isinstance(name, str) or not re.fullmatch(r"[a-z][a-z0-9_]{0,31}", name):
                raise TokenizerError("Special token names must use lowercase ASCII identifiers.")
            if not isinstance(spelling, str):
                raise TokenizerError("Special token spellings must be strings.")
            try:
                spelling_bytes = spelling.encode("utf-8", errors="strict")
            except UnicodeEncodeError as exc:
                raise TokenizerError("Special token spellings must be valid Unicode scalar text.") from exc
            if not 1 <= len(spelling_bytes) <= 128 or spelling in spellings:
                raise TokenizerError("Special token spellings must be unique and 1..128 UTF-8 bytes.")
            spellings.add(spelling)

        tokens = [bytes([byte]) for byte in range(256)]
        special_ids = {name: 256 + index for index, name in enumerate(specials)}
        tokens.extend(value.encode("utf-8") for value in specials.values())
        first_merge = len(tokens)
        validated_merges: list[tuple[int, int]] = []
        ranks: dict[tuple[int, int], int] = {}
        for item in merges:
            if len(validated_merges) >= target_vocab_size - first_merge:
                raise TokenizerError("Merge count exceeds the vocabulary target.")
            if not isinstance(item, (list, tuple)) or len(item) != 2:
                raise TokenizerError("Each merge must contain exactly two token ids.")
            left = _integer(item[0], "merge left id", 0, len(tokens) - 1)
            right = _integer(item[1], "merge right id", 0, len(tokens) - 1)
            if 256 <= left < first_merge or 256 <= right < first_merge:
                raise TokenizerError("Special tokens cannot participate in byte BPE merges.")
            pair = (left, right)
            if pair in ranks:
                raise TokenizerError("Duplicate merge pairs are unsupported.")
            token = tokens[left] + tokens[right]
            if len(token) > _MAX_TOKEN_BYTES:
                raise TokenizerError("A learned token exceeds the 256-byte limit.")
            ranks[pair] = len(validated_merges)
            validated_merges.append(pair)
            tokens.append(token)

        self._target_vocab_size = target_vocab_size
        self._special_tokens = MappingProxyType(specials)
        self._special_token_ids = MappingProxyType(special_ids)
        self._special_ids = frozenset(special_ids.values())
        self._tokens = tuple(tokens)
        self._merges = tuple(validated_merges)
        self._ranks = MappingProxyType(ranks)
        self._first_merge = first_merge
        self._identity = hashlib.sha256(_canonical_json(self._payload())).hexdigest()

    @property
    def vocab_size(self) -> int:
        return len(self._tokens)

    @property
    def target_vocab_size(self) -> int:
        """Requested training ceiling; the actual ``vocab_size`` may be smaller."""
        return self._target_vocab_size

    @property
    def identity(self) -> str:
        return self._identity

    @property
    def special_token_ids(self) -> Mapping[str, int]:
        return self._special_token_ids

    @property
    def bos_token_id(self) -> int:
        return self._special_token_ids["bos"]

    @property
    def eos_token_id(self) -> int:
        return self._special_token_ids["eos"]

    @property
    def pad_token_id(self) -> int:
        return self._special_token_ids["pad"]

    def token_bytes(self, token_id: int) -> bytes:
        """Return literal bytes, or the explicit spelling of a special token."""
        return self._tokens[_integer(token_id, "token id", 0, self.vocab_size - 1)]

    def encode(self, text: str, *, add_bos: bool = False, add_eos: bool = False) -> list[int]:
        if not isinstance(text, str):
            raise TokenizerError("encode requires text; use encode_bytes for arbitrary bytes.")
        if type(add_bos) is not bool or type(add_eos) is not bool:
            raise TokenizerError("add_bos and add_eos must be booleans.")
        if len(text) > _MAX_ENCODING_BYTES:
            raise TokenizerError("Input exceeds the tokenizer encoding byte budget.")
        try:
            data = text.encode("utf-8", errors="strict")
        except UnicodeEncodeError as exc:
            raise TokenizerError("Input contains lone surrogates; provide original bytes via encode_bytes.") from exc
        ids = self.encode_bytes(data)
        return ([self.bos_token_id] if add_bos else []) + ids + ([self.eos_token_id] if add_eos else [])

    def encode_bytes(self, data: bytes) -> list[int]:
        if not isinstance(data, bytes):
            raise TokenizerError("encode_bytes requires bytes.")
        if len(data) > _MAX_ENCODING_BYTES:
            raise TokenizerError("Input exceeds the 1 MiB tokenizer encoding budget.")
        if not data:
            return []
        # Linked positions let the heap apply globally lowest-rank merges without
        # repeatedly copying the complete input sequence. Position breaks ties.
        symbols = array("i", iter(data))
        previous = array("i", range(-1, len(data) - 1))
        following = array("i", range(1, len(data) + 1))
        following[-1] = -1
        heap: list[tuple[int, int, int, int]] = []

        def offer(index: int) -> None:
            if index < 0 or symbols[index] < 0:
                return
            next_index = following[index]
            if next_index < 0:
                return
            pair = (symbols[index], symbols[next_index])
            rank = self._ranks.get(pair)
            if rank is not None:
                heapq.heappush(heap, (rank, index, pair[0], pair[1]))

        for index in range(len(data) - 1):
            offer(index)
        while heap:
            rank, index, left, right = heapq.heappop(heap)
            next_index = following[index]
            if symbols[index] != left or next_index < 0 or symbols[next_index] != right:
                continue
            after = following[next_index]
            symbols[index] = self._first_merge + rank
            symbols[next_index] = -1
            following[index] = after
            following[next_index] = -1
            if after >= 0:
                previous[after] = index
            offer(previous[index])
            offer(index)
        return [symbol for symbol in symbols if symbol >= 0]

    def decode_bytes(self, ids: Iterable[int], *, skip_special_tokens: bool = False) -> bytes:
        if type(skip_special_tokens) is not bool:
            raise TokenizerError("skip_special_tokens must be a boolean.")
        result = bytearray()
        for count, token_id in enumerate(ids, start=1):
            if count > _MAX_DECODING_TOKENS:
                raise TokenizerError("Token sequence exceeds the decoding token budget.")
            token = self.token_bytes(token_id)
            if skip_special_tokens and token_id in self._special_ids:
                continue
            if len(result) + len(token) > _MAX_DECODING_BYTES:
                raise TokenizerError("Decoded output exceeds the 8 MiB byte budget.")
            result.extend(token)
        return bytes(result)

    def decode(self, ids: Iterable[int], *, skip_special_tokens: bool = False,
               errors: str = "strict") -> str:
        if errors not in ("strict", "surrogateescape"):
            raise TokenizerError("Only strict or lossless surrogateescape decoding is supported.")
        data = self.decode_bytes(ids, skip_special_tokens=skip_special_tokens)
        try:
            return data.decode("utf-8", errors=errors)
        except UnicodeDecodeError as exc:
            raise TokenizerError("Token bytes are not complete valid UTF-8; use decode_bytes to preserve them.") from exc

    def _payload(self) -> dict[str, Any]:
        return {
            "format": _FORMAT,
            "version": _VERSION,
            "target_vocab_size": self.target_vocab_size,
            "special_tokens": [[name, value] for name, value in self._special_tokens.items()],
            "merges": [list(pair) for pair in self._merges],
        }

    def to_dict(self) -> dict[str, Any]:
        """Return a detached JSON-compatible document including its identity."""
        return {**self._payload(), "identity": self.identity}

    def save(self, path: str | os.PathLike[str]) -> None:
        """Atomically replace one explicitly named local JSON vocabulary file."""
        destination = _local_path(path, allow_missing=True)
        serialized = _canonical_json(self.to_dict()) + b"\n"
        temporary: str | None = None
        try:
            with tempfile.NamedTemporaryFile(mode="wb", prefix=destination.name + ".",
                                             suffix=".tmp", dir=destination.parent, delete=False) as stream:
                temporary = stream.name
                stream.write(serialized)
                stream.flush()
                os.fsync(stream.fileno())
            # Recheck the destination and parents immediately before replacement.
            _local_path(destination, allow_missing=True)
            os.replace(temporary, destination)
            temporary = None
        except OSError as exc:
            raise TokenizerError("Could not save the explicitly requested local tokenizer file.") from exc
        finally:
            if temporary is not None:
                try:
                    os.unlink(temporary)
                except OSError:
                    pass

    @classmethod
    def load(cls, path: str | os.PathLike[str]) -> ByteBPETokenizer:
        """Read bounded JSON only; never deserialize executable Python objects."""
        source = _local_path(path)
        try:
            with _open_local_reader(source) as stream:
                raw = stream.read(_MAX_SERIALIZED_BYTES + 1)
            if len(raw) > _MAX_SERIALIZED_BYTES:
                raise TokenizerError("Tokenizer file exceeds the 4 MiB limit.")
            document = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_object)
        except (OSError, ValueError, RecursionError) as exc:
            raise TokenizerError("Could not read a valid local tokenizer JSON file.") from exc
        return cls.from_dict(document)

    @classmethod
    def from_dict(cls, document: Any) -> ByteBPETokenizer:
        """Validate an already-parsed JSON document and its exact identity.

        Callers parsing untrusted JSON must separately bound the serialized bytes
        and reject duplicate object keys, as ``load`` does.
        """
        keys = {"format", "version", "target_vocab_size", "special_tokens", "merges", "identity"}
        if not isinstance(document, dict) or set(document) != keys:
            raise TokenizerError("Tokenizer JSON has missing or unsupported fields.")
        if document["format"] != _FORMAT or type(document["version"]) is not int or document["version"] != _VERSION:
            raise TokenizerError("Unsupported tokenizer format or version.")
        identity = document["identity"]
        if not isinstance(identity, str) or not re.fullmatch(r"[0-9a-f]{64}", identity):
            raise TokenizerError("Tokenizer identity must be a lowercase SHA-256 hex digest.")
        entries = document["special_tokens"]
        if not isinstance(entries, list) or not 3 <= len(entries) <= _MAX_SPECIALS:
            raise TokenizerError("Tokenizer special_tokens must contain 3..64 ordered entries.")
        specials: dict[str, str] = {}
        for entry in entries:
            if (not isinstance(entry, list) or len(entry) != 2
                    or not isinstance(entry[0], str) or not isinstance(entry[1], str)
                    or entry[0] in specials):
                raise TokenizerError("Malformed or duplicate special-token entry.")
            specials[entry[0]] = entry[1]
        merges = document["merges"]
        if not isinstance(merges, list) or len(merges) > max(VOCABULARY_TARGETS):
            raise TokenizerError("Malformed or excessive tokenizer merge table.")
        tokenizer = cls(merges, special_tokens=specials, target_vocab_size=document["target_vocab_size"])
        if tokenizer.identity != identity:
            raise TokenizerError("Tokenizer identity does not match its canonical contents.")
        return tokenizer

    @classmethod
    def train(
        cls,
        records: Iterable[str | bytes],
        *,
        target_vocab_size: int = 16384,
        special_tokens: Mapping[str, str] | None = None,
        min_pair_frequency: int = 2,
        max_corpus_bytes: int = 2_097_152,
        max_record_bytes: int = 262_144,
        max_records: int = 100_000,
        max_token_bytes: int = _MAX_TOKEN_BYTES,
        isolate_digits: bool = False,
    ) -> ByteBPETokenizer:
        """Learn BPE merges from explicit records; never train neural weights.

        Pair counts are incrementally updated at affected linked-list positions.
        Ties use ascending (left id, right id); overlapping occurrences merge
        left-to-right. Record boundaries are never crossed. Training raises when
        a budget is exceeded, rather than silently taking a prefix of the corpus.

        ``max_token_bytes`` and ``isolate_digits`` constrain only which merges are
        LEARNED. Encoding depends solely on the saved merge table, so these options
        change no file format. ``isolate_digits`` never merges an ASCII digit with a
        non-digit byte, so numbers and identifier suffixes compose from small pieces
        instead of becoming one-off tokens that unseen values cannot reuse.
        """
        base = cls(special_tokens=special_tokens, target_vocab_size=target_vocab_size)
        if isinstance(records, (str, bytes)):
            raise TokenizerError("Training requires an iterable of records, not one str or bytes value.")
        _integer(min_pair_frequency, "min_pair_frequency", 1, _MAX_CORPUS_BYTES)
        _integer(max_corpus_bytes, "max_corpus_bytes", 1, _MAX_CORPUS_BYTES)
        _integer(max_record_bytes, "max_record_bytes", 1, _MAX_ENCODING_BYTES)
        _integer(max_records, "max_records", 1, _MAX_CORPUS_RECORDS)
        limit = _integer(max_token_bytes, "max_token_bytes", 2, _MAX_TOKEN_BYTES)
        if type(isolate_digits) is not bool:
            raise TokenizerError("isolate_digits must be a boolean.")
        symbols = array("i")
        previous = array("i")
        following = array("i")
        total_bytes = 0
        for record_count, record in enumerate(records, start=1):
            if record_count > max_records:
                raise TokenizerError("Training corpus exceeds max_records.")
            if isinstance(record, str):
                if len(record) > max_record_bytes:
                    raise TokenizerError("A training record exceeds max_record_bytes.")
                try:
                    record = record.encode("utf-8", errors="strict")
                except UnicodeEncodeError as exc:
                    raise TokenizerError("Training text contains lone surrogates; use original bytes.") from exc
            if not isinstance(record, bytes):
                raise TokenizerError("Training records must be str or bytes.")
            if len(record) > max_record_bytes:
                raise TokenizerError("A training record exceeds max_record_bytes.")
            total_bytes += len(record)
            if total_bytes > max_corpus_bytes:
                raise TokenizerError("Training corpus exceeds max_corpus_bytes.")
            if not record:
                continue
            start = len(symbols)
            end = start + len(record)
            symbols.extend(iter(record))
            previous.extend(range(start - 1, end - 1))
            previous[start] = -1
            following.extend(range(start + 1, end + 1))
            following[-1] = -1
        if total_bytes == 0:
            raise TokenizerError("Tokenizer training requires a nonempty corpus.")

        occurrences: dict[tuple[int, int], set[int]] = {}
        for index, next_index in enumerate(following):
            if next_index >= 0:
                occurrences.setdefault((symbols[index], symbols[next_index]), set()).add(index)
        heap = [(-len(positions), left, right) for (left, right), positions in occurrences.items()]
        heapq.heapify(heap)
        lengths = [len(token) for token in base._tokens]
        # Per-token digit classes: 0 = no ASCII digits, 1 = only digits, 2 = mixed/special.
        def digit_class(token: bytes) -> int:
            digits = sum(48 <= byte <= 57 for byte in token)
            return 0 if digits == 0 else 1 if digits == len(token) else 2
        classes = [digit_class(token) for token in base._tokens]

        def mergeable(left_id: int, right_id: int) -> bool:
            if lengths[left_id] + lengths[right_id] > limit:
                return False
            return not isolate_digits or classes[left_id] == classes[right_id] != 2

        heap = [item for item in heap if mergeable(item[1], item[2])]
        heapq.heapify(heap)
        merges: list[tuple[int, int]] = []

        while heap and base.vocab_size + len(merges) < target_vocab_size:
            negative_frequency, left, right = heapq.heappop(heap)
            pair = (left, right)
            positions = occurrences.get(pair)
            if not positions or -negative_frequency != len(positions):
                continue
            if len(positions) < min_pair_frequency:
                break
            if not mergeable(left, right):
                continue
            new_id = base.vocab_size + len(merges)
            merges.append(pair)
            lengths.append(lengths[left] + lengths[right])
            classes.append(classes[left])
            dirty: set[tuple[int, int]] = set()

            def remove(index: int) -> None:
                if index < 0 or symbols[index] < 0 or following[index] < 0:
                    return
                old_pair = (symbols[index], symbols[following[index]])
                old_positions = occurrences.get(old_pair)
                if old_positions is not None:
                    old_positions.discard(index)
                    dirty.add(old_pair)

            def add(index: int) -> None:
                if index < 0 or symbols[index] < 0 or following[index] < 0:
                    return
                new_pair = (symbols[index], symbols[following[index]])
                occurrences.setdefault(new_pair, set()).add(index)
                dirty.add(new_pair)

            # Copy before updates: overlapping pairs must not mutate iteration.
            for index in sorted(positions):
                next_index = following[index]
                if symbols[index] != left or next_index < 0 or symbols[next_index] != right:
                    continue
                before = previous[index]
                after = following[next_index]
                remove(before)
                remove(index)
                remove(next_index)
                symbols[index] = new_id
                symbols[next_index] = -1
                following[index] = after
                following[next_index] = -1
                if after >= 0:
                    previous[after] = index
                add(before)
                add(index)
            for changed in dirty:
                remaining = occurrences.get(changed)
                if remaining:
                    if mergeable(changed[0], changed[1]):
                        heapq.heappush(heap, (-len(remaining), changed[0], changed[1]))
                else:
                    occurrences.pop(changed, None)
            # Stale priority entries are safe but should not grow without bound.
            if len(heap) > 4 * max(len(occurrences), 1) + 1024:
                heap = [(-len(items), pair[0], pair[1]) for pair, items in occurrences.items()
                        if mergeable(pair[0], pair[1])]
                heapq.heapify(heap)
        return cls(merges, special_tokens=base._special_tokens, target_vocab_size=target_vocab_size)

    @classmethod
    def train_files(
        cls,
        paths: Iterable[str | os.PathLike[str]],
        *,
        chunk_bytes: int = 65_536,
        **training_options: Any,
    ) -> ByteBPETokenizer:
        """Train from named local files, read as raw bytes with no newline changes.

        A file/chunk boundary is a training record boundary. Corpus limits still
        apply to all files combined. Every byte is consumed or an error is raised.
        """
        _integer(chunk_bytes, "chunk_bytes", 1, _MAX_ENCODING_BYTES)
        if isinstance(paths, (str, bytes, os.PathLike)):
            raise TokenizerError("train_files requires an iterable of explicit local paths.")

        def records() -> Iterable[bytes]:
            file_count = 0
            for path in paths:
                file_count += 1
                if file_count > _MAX_CORPUS_RECORDS:
                    raise TokenizerError("Tokenizer training exceeds the local file-count limit.")
                source = _local_path(path)
                try:
                    with _open_local_reader(source) as stream:
                        while True:
                            chunk = stream.read(chunk_bytes)
                            if not chunk:
                                break
                            yield chunk
                except OSError as exc:
                    raise TokenizerError("Could not read an explicitly requested local training file.") from exc

        return cls.train(records(), **training_options)
