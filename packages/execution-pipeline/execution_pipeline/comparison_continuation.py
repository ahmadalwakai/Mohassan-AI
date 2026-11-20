"""Extend one frozen corpus comparison arm without modifying its first 100M positions."""
from __future__ import annotations

from collections import Counter
from hashlib import sha256
from pathlib import Path
from struct import pack

from .comparison_sampling import FrozenComparisonSampler, Window

ANCHOR_POSITIONS = 100_000_000
ANCHOR_UPDATES = 12_208
TARGET_POSITIONS = 300_000_000
TARGET_UPDATES = 36_623
MILESTONES = (32_000_000, ANCHOR_POSITIONS, TARGET_POSITIONS)
MODEL_SEED = 1729
MODEL_VIEW = "existing"
ENGLISH_MIX = "simplewiki_enriched"

_TAIL_ENGLISH_POSITIONS = {
    "wikipedia-20231101-en": 49_400_000,
    "simplewiki-20261101": 50_000_000,
    "dialogue": 600_000,
}


def _tail_segment(allocation: dict) -> dict:
    """Keep exact source totals even where the short windows cross an update boundary."""
    width = allocation["sequence_length"]
    full_windows = sum(count // width for count in _TAIL_ENGLISH_POSITIONS.values())
    tail_sources, tail_lengths = [], []
    occupied = 0
    for source in allocation["source_order"]:
        remainder = _TAIL_ENGLISH_POSITIONS[source] % width
        while remainder:
            length = min(remainder, width - occupied)
            if length < 2:
                raise ValueError("A continuation window must contain a next-token target.")
            tail_sources.append(source)
            tail_lengths.append(length)
            remainder -= length
            occupied = (occupied + length) % width
    positions = (TARGET_POSITIONS - ANCHOR_POSITIONS) // 2
    if full_windows * width + sum(tail_lengths) != positions:
        raise ValueError("The continuation source schedule has an incorrect position budget.")
    return {
        "to": TARGET_POSITIONS,
        "full_windows_per_language": full_windows,
        "english_target": {ENGLISH_MIX: _TAIL_ENGLISH_POSITIONS},
        "tail_sources": {ENGLISH_MIX: tail_sources},
        "short_window_lengths_for_both_languages": tail_lengths,
    }


class FoundationContinuationSampler(FrozenComparisonSampler):
    """Replay the verified prefix and extend its source RNG states through exactly 300M."""

    def __init__(self, prep: Path, allocation: dict, *, verifier_sha256: str,
                 expected_receipt: dict | None = None, max_microbatch_rows: int | None = None):
        if (tuple(map(int, allocation["milestones"])) != MILESTONES[:-1]
                or allocation["training_positions_per_start"] != ANCHOR_POSITIONS
                or allocation["milestones"][str(ANCHOR_POSITIONS)]["optimizer_updates"] != ANCHOR_UPDATES
                or allocation["learning_rate_decay_horizon_positions"] != TARGET_POSITIONS):
            raise ValueError("Continuation requires the original 100M allocation and 300M decay horizon.")
        super().__init__(prep, allocation, seed=MODEL_SEED, mix=ENGLISH_MIX, view=MODEL_VIEW,
                         verifier_sha256=verifier_sha256, max_microbatch_rows=max_microbatch_rows)
        verifier, segments, banks, positions_per_update = self._prefix_context
        del self._prefix_context
        self._append_tail(verifier, segments, banks, positions_per_update, _tail_segment(allocation))
        if expected_receipt is not None and self.planned_receipt(TARGET_POSITIONS) != expected_receipt:
            raise ValueError("Continuation windows differ from the pinned 300M receipt.")

    def _build_schedule(self, verifier, expected, segments, banks, seed, mix, view, positions_per_update):
        super()._build_schedule(verifier, expected, segments, banks, seed, mix, view, positions_per_update)
        self._prefix_context = verifier, segments, banks, positions_per_update

    def _append_tail(self, verifier, segments, banks, positions_per_update, tail):
        random_stream = verifier["random_stream"]
        english_rng = {source: random_stream(MODEL_SEED, f"paired-window:{source}") for source in self.sources}
        arabic_rng = random_stream(MODEL_SEED, "arabic-window")
        ledgers = {source: sha256() for source in (*self.sources, "arabic")}
        source_slots = sha256()
        source_codes = {source: number for number, source in enumerate(self.sources)}
        english, dialogue = Counter(), Counter()
        arabic_stream_length = len(self._stream["ar"])
        positions = ANCHOR_POSITIONS
        windows, slots = [], 0

        for segment in [*segments, tail]:
            is_tail = segment is tail
            for source, length in verifier["english_schedule"](segment, MODEL_SEED, ENGLISH_MIX):
                pair = verifier["take_window"](banks[source], english_rng[source], length)
                arabic_start = arabic_rng.randrange(arabic_stream_length - length + 1)
                ledgers[source].update(pack("<QQH", *pair, length))
                ledgers["arabic"].update(pack("<QH", arabic_start, length))
                source_slots.update(pack("<BH", source_codes[source], length))
                english[source] += length
                if source == "dialogue":
                    verifier["add_dialogue_counts"](banks[source], pair[0], length, dialogue)
                if not is_tail:
                    continue
                windows.append(Window(source, arabic_start, pair[0], length))
                slots += 2 * length
                if slots > positions_per_update:
                    raise ValueError("A continuation update exceeded its position budget.")
                if slots == positions_per_update or positions + slots == TARGET_POSITIONS:
                    positions += slots
                    self._updates.append(tuple(windows))
                    self._ends.append(positions)
                    windows, slots = [], 0

            receipt = {
                "english_positions": dict(english),
                "dialogue_positions_by_source": dict(dialogue),
                "ordered_window_sha256_by_source": {source: digest.hexdigest() for source, digest in ledgers.items()},
                "source_slot_schedule_sha256": source_slots.hexdigest(),
            }
            if is_tail:
                self._receipts[TARGET_POSITIONS] = receipt
            elif receipt != self._receipts[segment["to"]]:
                raise ValueError("Continuation did not reproduce the original window receipt.")

        original = self._receipts[ANCHOR_POSITIONS]["english_positions"]
        totals = {source: original[source] + positions for source, positions in _TAIL_ENGLISH_POSITIONS.items()}
        if (windows or positions != TARGET_POSITIONS or len(self._updates) != TARGET_UPDATES
                or dict(english) != totals or sum(dialogue.values()) != english["dialogue"]):
            raise ValueError("Continuation did not reach its declared cumulative window budget.")

    def planned_receipt(self, positions: int) -> dict:
        """Get a preflight receipt without advancing the optimizer update cursor."""
        from copy import deepcopy

        return deepcopy(self._receipts[positions])
