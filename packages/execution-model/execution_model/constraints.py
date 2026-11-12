"""Trusted in-process constraints. No schema engine or executable grammar plugins."""

from __future__ import annotations

import json
import math
from abc import ABC, abstractmethod
from collections.abc import Iterable, Mapping, Sequence
from typing import Any

from .errors import ConstraintError, InvalidRequestError, UnsupportedRequestError
from .tokenizer import ByteBPETokenizer


class DecodingConstraint(ABC):
    """Implementations are trusted application code, never supplied by model text.

    allowed_token_ids returns None to allow the entire vocabulary. The prefix
    contains candidate-content tokens only, excluding the prompt and a terminal
    stop token. Methods must be pure.
    """

    token_budget: int | None = None

    def validate(self, vocab_size: int, stop_token_ids: frozenset[int] = frozenset(),
                 blocked_token_ids: frozenset[int] = frozenset()) -> None:
        """Optional request-time validation; dynamic filters are also step-checked."""

    @abstractmethod
    def allowed_token_ids(self, prefix: tuple[int, ...], vocab_size: int) -> Iterable[int] | None:
        raise NotImplementedError

    def is_complete(self, prefix: tuple[int, ...]) -> bool:
        return False

    def accepts(self, prefix: tuple[int, ...]) -> bool:
        return True


class AllowedTokens(DecodingConstraint):
    def __init__(self, token_ids: Sequence[int], *, token_budget: int | None = None):
        if not isinstance(token_ids, (list, tuple)) or not 1 <= len(token_ids) <= 65536:
            raise InvalidRequestError("Allowed tokens must be a bounded nonempty sequence.")
        if any(type(token) is not int or token < 0 for token in token_ids):
            raise InvalidRequestError("Allowed token ids must be nonnegative integers.")
        self.ids = frozenset(token_ids)
        self.token_budget = _budget(token_budget)

    def validate(self, vocab_size: int, stop_token_ids: frozenset[int] = frozenset(),
                 blocked_token_ids: frozenset[int] = frozenset()) -> None:
        if any(token >= vocab_size for token in self.ids):
            raise InvalidRequestError("Allowed token id exceeds vocabulary size.")

    def allowed_token_ids(self, prefix: tuple[int, ...], vocab_size: int) -> Iterable[int]:
        if any(token >= vocab_size for token in self.ids):
            raise InvalidRequestError("Allowed token id exceeds vocabulary size.")
        return self.ids

    def accepts(self, prefix: tuple[int, ...]) -> bool:
        return all(token in self.ids for token in prefix)


class TokenSequences(DecodingConstraint):
    """A finite token trie. Candidates must be nonempty and prefix-free.

    This is useful for exact labels, fixed records, and finite JSON choices. It
    does not constrain arbitrary JSON documents or prove an answer is correct.
    """

    def __init__(self, sequences: Sequence[Sequence[int]], *, token_budget: int | None = None):
        if not isinstance(sequences, (tuple, list)) or not 1 <= len(sequences) <= 256:
            raise InvalidRequestError("Provide between 1 and 256 token sequences.")
        self._trie: dict = {}
        self._ids: set[int] = set()
        total = 0
        for sequence in sequences:
            if not isinstance(sequence, (tuple, list)) or not 1 <= len(sequence) <= 8192:
                raise InvalidRequestError("Token sequences must have 1..8192 tokens.")
            total += len(sequence)
            if total > 65536 or any(type(token) is not int or token < 0 for token in sequence):
                raise InvalidRequestError("Invalid or oversized token sequence constraint.")
            self._ids.update(sequence)
            node = self._trie
            for token in sequence:
                if None in node:
                    raise InvalidRequestError("Token sequences must be prefix-free.")
                node = node.setdefault(token, {})
            if node:
                raise InvalidRequestError("Duplicate or prefix-overlapping token sequences.")
            node[None] = True
        self.token_budget = _budget(token_budget)

    def validate(self, vocab_size: int, stop_token_ids: frozenset[int] = frozenset(),
                 blocked_token_ids: frozenset[int] = frozenset()) -> None:
        if any(token >= vocab_size for token in self._ids):
            raise InvalidRequestError("Constraint token id exceeds vocabulary size.")
        if self._ids & (stop_token_ids | blocked_token_ids):
            raise InvalidRequestError("Finite candidate sequences cannot contain stop or blocked tokens.")

    def _node(self, prefix: tuple[int, ...]) -> dict:
        node = self._trie
        for token in prefix:
            if token not in node:
                raise ConstraintError("Generated prefix violates the token sequence constraint.")
            node = node[token]
        return node

    def allowed_token_ids(self, prefix: tuple[int, ...], vocab_size: int) -> Iterable[int]:
        ids = tuple(token for token in self._node(prefix) if token is not None)
        if any(token >= vocab_size for token in ids):
            raise InvalidRequestError("Constraint token id exceeds vocabulary size.")
        return ids

    def is_complete(self, prefix: tuple[int, ...]) -> bool:
        return None in self._node(prefix)

    def accepts(self, prefix: tuple[int, ...]) -> bool:
        return self.is_complete(prefix)


def _budget(value: int | None) -> int | None:
    if value is not None and (type(value) is not int or not 1 <= value <= 8192):
        raise InvalidRequestError("Constraint token budget must be in 1..8192.")
    return value


def _validate_json(value: Any, depth: int = 0, budget: list[int] | None = None) -> None:
    # Bound traversal BEFORE serializing. Budget tracks visited nodes and a
    # conservative serialized-byte estimate, including escaping/containers.
    if budget is None:
        budget = [0, 0]
    budget[0] += 1
    if depth > 32:
        raise InvalidRequestError("JSON choice nesting exceeds 32 levels.")
    if budget[0] > 16384 or budget[1] > 65536:
        raise InvalidRequestError("JSON choice exceeds its traversal or byte budget.")
    if type(value) is str:
        if len(value) > 65536:
            raise InvalidRequestError("JSON choice string exceeds the byte budget.")
        try:
            budget[1] += len(json.dumps(value, ensure_ascii=False).encode("utf-8")) + 1
        except UnicodeError as exc:
            raise InvalidRequestError("JSON choice strings must be valid Unicode.") from exc
    elif value is None or type(value) is bool:
        budget[1] += 6
    elif type(value) is int:
        if value.bit_length() > 4096:
            raise InvalidRequestError("JSON choice integer exceeds the numeric budget.")
        budget[1] += len(str(value)) + 1
    elif type(value) is float:
        if not math.isfinite(value):
            raise InvalidRequestError("JSON choice numbers must be finite.")
        budget[1] += 32
    elif type(value) in (list, dict):
        if len(value) > 16384:
            raise InvalidRequestError("JSON choice container exceeds the item budget.")
        budget[1] += 3
        for key in value:
            if type(value) is dict:
                if type(key) is not str:
                    raise InvalidRequestError("JSON object keys must be strings.")
                _validate_json(key, depth + 1, budget)
                _validate_json(value[key], depth + 1, budget)
            else:
                _validate_json(key, depth + 1, budget)
    else:
        raise InvalidRequestError("JSON choices must contain only JSON data types.")
    if budget[1] > 65536:
        raise InvalidRequestError("JSON choice exceeds the byte budget.")


def constraint_from_spec(spec: Mapping[str, Any] | None, tokenizer: ByteBPETokenizer) -> DecodingConstraint | None:
    """Strict data-only entry point. Unknown kinds/fields are never ignored."""
    if spec is None:
        return None
    if not isinstance(spec, Mapping):
        raise InvalidRequestError("Constraint specification must be a mapping.")
    kind = spec.get("kind")
    fields = {
        "allowed_tokens": {"kind", "token_ids", "token_budget"},
        "token_sequences": {"kind", "sequences", "token_budget"},
        "json_choices": {"kind", "choices", "token_budget"},
    }
    if not isinstance(kind, str) or kind not in fields:
        raise UnsupportedRequestError("Constraint kind is unsupported; JSON Schema is not implemented.")
    if set(spec) - fields[kind]:
        raise UnsupportedRequestError("Constraint contains unsupported fields.")
    budget = _budget(spec.get("token_budget"))
    if kind == "allowed_tokens":
        result = AllowedTokens(spec.get("token_ids"), token_budget=budget)
        result.validate(tokenizer.vocab_size)
        return result
    if kind == "token_sequences":
        result = TokenSequences(spec.get("sequences"), token_budget=budget)
        result.validate(tokenizer.vocab_size)
        return result
    choices = spec.get("choices")
    if not isinstance(choices, (tuple, list)) or not 1 <= len(choices) <= 256:
        raise InvalidRequestError("JSON choices must contain 1..256 values.")
    sequences = []
    total_bytes = 0
    for choice in choices:
        _validate_json(choice)
        try:
            text = json.dumps(choice, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
            size = len(text.encode("utf-8"))
        except (ValueError, TypeError, UnicodeError, RecursionError) as exc:
            raise InvalidRequestError("JSON choice cannot be serialized losslessly.") from exc
        total_bytes += size
        if size > 65536 or total_bytes > 262144:
            raise InvalidRequestError("JSON choices exceed the byte budget.")
        sequences.append(tokenizer.encode(text))
    return TokenSequences(sequences, token_budget=budget)
