"""Exact shared-token-span checks against frozen, pinned evaluation JSONL."""

from collections.abc import Iterable
from dataclasses import dataclass
import hashlib
from pathlib import Path

from .inputs import load_object, require_pin
from .normalization import TOKEN_PATTERN, match_tokens

CONTAMINATION_VERSION = "1"


@dataclass(frozen=True, slots=True)
class _EvaluationRow:
    path: str
    sha256: str
    identifier: str
    tokens: tuple[str, ...]


class EvaluationIndex:
    """Identify each maximal common span of at least the configured width."""

    def __init__(self, sources: Iterable[tuple[Path, str]], span_tokens: int = 13) -> None:
        if type(span_tokens) is not int or span_tokens < 1:
            raise ValueError("Contamination span must be a positive token count")
        self.width = span_tokens
        self.evidence: list[dict] = []
        self._windows: dict[tuple[str, ...], list[tuple[_EvaluationRow, int]]] = {}
        for path, pin in sources:
            self._add_file(path, pin)

    def _add_file(self, path: Path, pin: str) -> None:
        require_pin(pin, f"Evaluation SHA-256 pin for {path}")
        if not path.is_file():
            raise ValueError(f"Evaluation set must be a regular file: {path}")
        hasher = hashlib.sha256()
        identifiers = set()
        # Hash the same bytes used to build the index. A mismatched pin fails
        # construction before callers can inspect any evaluation overlap.
        with path.open("rb") as stream:
            for number, line in enumerate(stream, 1):
                hasher.update(line)
                record = load_object(line, f"Evaluation record at {path}, line {number}")
                if (
                    not isinstance(record.get("id"), str)
                    or not record["id"]
                    or not isinstance(record.get("text"), str)
                ):
                    raise ValueError(f"Evaluation requires an id and text at {path}, line {number}")
                if record["id"] in identifiers:
                    raise ValueError(f"Duplicate evaluation id at {path}, line {number}")
                identifiers.add(record["id"])
                tokens = tuple(match_tokens(record["text"]))
                row = _EvaluationRow(path.as_posix(), pin, record["id"], tokens)
                for start in range(len(tokens) - self.width + 1):
                    window = tokens[start:start + self.width]
                    self._windows.setdefault(window, []).append((row, start))
        if hasher.hexdigest() != pin:
            raise ValueError(f"Evaluation SHA-256 pin mismatch: {path}")
        if not identifiers:
            raise ValueError(f"Evaluation set is empty: {path}")
        self.evidence.append({"path": path.as_posix(), "sha256": pin, "records": len(identifiers)})

    def find(self, key: str) -> list[dict]:
        """Return token locations and pinned file identity without exposing text."""
        if not self._windows:
            return []
        tokens = tuple(TOKEN_PATTERN.findall(key))
        hits = []
        for training_start in range(len(tokens) - self.width + 1):
            window = tokens[training_start:training_start + self.width]
            for row, evaluation_start in self._windows.get(window, ()):
                if training_start and evaluation_start and tokens[training_start - 1] == row.tokens[evaluation_start - 1]:
                    continue
                length = self.width
                limit = min(len(tokens) - training_start, len(row.tokens) - evaluation_start)
                while length < limit and tokens[training_start + length] == row.tokens[evaluation_start + length]:
                    length += 1
                hits.append({
                    "evaluation_path": row.path,
                    "evaluation_sha256": row.sha256,
                    "evaluation_id": row.identifier,
                    "training_token_start": training_start,
                    "evaluation_token_start": evaluation_start,
                    "tokens": length,
                })
        return hits
