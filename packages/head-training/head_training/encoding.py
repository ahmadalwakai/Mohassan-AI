"""Shared token input for fitting and the resident worker's dense requests."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol


class TextEncoder(Protocol):
    def encode(self, text: str) -> list[int]: ...


@dataclass(frozen=True)
class HeadInput:
    input_ids: tuple[int, ...]
    candidate_positions: tuple[int, ...] = ()
    candidate_indices: tuple[int, ...] = ()

    def worker_payload(self) -> dict[str, list[int]]:
        payload = {"inputIds": list(self.input_ids)}
        if self.candidate_positions:
            payload["candidatePositions"] = list(self.candidate_positions)
        return payload


def _history(
    encoder: TextEncoder, history: Sequence[str], budget: int, eos_token_id: int
) -> list[int]:
    recent: list[list[int]] = []
    for turn in reversed(history):
        if budget < 2:
            break
        tokens = encoder.encode(turn)[: budget - 1]
        if tokens:
            recent.append([*tokens, eos_token_id])
            budget -= len(tokens) + 1
    return [token for turn in reversed(recent) for token in turn]


def encode_input(
    encoder: TextEncoder,
    text: str,
    *,
    eos_token_id: int,
    max_tokens: int,
    history: Sequence[str] = (),
    candidates: Sequence[str] = (),
) -> HeadInput:
    """Preserve the request and spend the remaining context on visible evidence.

    Classification reads the last EOS after the request. A selection candidate is
    scored at its own EOS, in the order supplied by the caller. Truncation only
    uses the inputs and the context budget, so it works the same way at inference.
    """
    if max_tokens < 8:
        raise ValueError("Head inputs need a context budget of at least eight tokens.")
    request = encoder.encode(text)
    if not request:
        raise ValueError("The current request must encode to at least one token.")
    if not candidates:
        question = request[: max_tokens // 2 if history else max_tokens - 1]
        context = _history(encoder, history, max_tokens - len(question) - 1, eos_token_id)
        return HeadInput((*context, *question, eos_token_id))

    # Leave room for at least two candidates on a small context. Reserve up to
    # a quarter of the window for prior turns when selecting a dialogue rewrite.
    question = request[: max(1, max_tokens // 4)]
    rest = max_tokens - len(question) - 1
    context = _history(encoder, history, min(max_tokens // 4, rest - 4), eos_token_id)
    input_ids = [*context, *question, eos_token_id]
    available = max_tokens - len(input_ids)
    visible = []
    for index, candidate in enumerate(candidates):
        tokens = encoder.encode(candidate)
        if tokens:
            visible.append((index, tokens))
        if len(visible) == available // 2:
            break
    if not visible:
        raise ValueError("Selection needs at least one nonempty candidate.")

    # Give every visible candidate at least one content token, redistributing
    # the remainder from short candidates while never looking at the label.
    content_budget = available - len(visible)
    widths = [1] * len(visible)
    content_budget -= len(visible)
    shortest_first = sorted(range(len(visible)), key=lambda index: len(visible[index][1]))
    for remaining, index in zip(range(len(visible), 0, -1), shortest_first, strict=True):
        extra = min(max(1, content_budget // remaining), len(visible[index][1]) - 1, content_budget)
        widths[index] += extra
        content_budget -= extra
        if not content_budget:
            break
    positions: list[int] = []
    for (_, tokens), width in zip(visible, widths, strict=True):
        input_ids.extend(tokens[:width])
        positions.append(len(input_ids))
        input_ids.append(eos_token_id)
    return HeadInput(tuple(input_ids), tuple(positions), tuple(index for index, _ in visible))
